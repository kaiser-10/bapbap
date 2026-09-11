-- Ejecuta este archivo completo en Supabase: SQL Editor > New query > Run.
-- Preórdenes con ventana horaria + pedidos al momento, con tope de cupos por ventana.

-- 1. La ventana concreta que le tocó al pedido, y si fue preorden o al momento.
-- Los pedidos viejos quedan con estas columnas en null: el panel los sigue
-- mostrando por reserved_label, que no cambia.
alter table public.orders add column if not exists reserved_start smallint;
alter table public.orders add column if not exists reserved_end smallint;
alter table public.orders add column if not exists order_mode text;
alter table public.orders drop constraint if exists order_mode_valid;
alter table public.orders add constraint order_mode_valid
  check (order_mode is null or order_mode in ('ahora', 'preorden'));

-- Contar los pedidos de una ventana es la consulta más caliente del checkout.
create index if not exists orders_slot_idx on public.orders (reserved_date, reserved_start);

-- 2. Las comunas nuevas nunca se agregaron a la restricción: se sumaron cuatro
-- al checkout (commit 549e2ad) sin tocar la base. Se corrige acá.
alter table public.orders drop constraint if exists comuna_valid;
alter table public.orders add constraint comuna_valid check (
  comuna is null or comuna in (
    'Puente Alto', 'San Bernardo', 'El Bosque', 'La Pintana',
    'La Florida', 'La Granja', 'San Ramón', 'La Cisterna'
  )
);

-- 3. Cuántos pedidos acepta cada ventana. Vive en la base y no en el código
-- porque tiene que poder cambiar desde el panel sin volver a desplegar nada.
create table if not exists public.slot_limits (
  weekday text not null check (weekday in ('Fri', 'Sat', 'Sun')),
  start_hour smallint not null check (start_hour between 0 and 23),
  end_hour smallint not null check (end_hour between 1 and 24),
  capacity smallint not null default 6 check (capacity >= 0),
  updated_at timestamptz not null default now(),
  primary key (weekday, start_hour)
);

-- Ventanas de 2 horas dentro del horario de atención. La última de cada día se
-- recorta al cierre: viernes 19-20 y domingo 16-17 duran una hora.
insert into public.slot_limits (weekday, start_hour, end_hour) values
  ('Fri', 17, 19), ('Fri', 19, 20),
  ('Sat', 12, 14), ('Sat', 14, 16), ('Sat', 16, 18), ('Sat', 18, 20),
  ('Sun', 12, 14), ('Sun', 14, 16), ('Sun', 16, 17)
on conflict (weekday, start_hour) do nothing;

alter table public.slot_limits enable row level security;

-- La tienda pública necesita leer los topes para marcar ventanas agotadas.
-- Solo expone números de cupos, ningún dato de cliente.
drop policy if exists "Public can read slot limits" on public.slot_limits;
create policy "Public can read slot limits"
on public.slot_limits
for select
to anon, authenticated
using (true);

drop policy if exists "Admin can update slot limits" on public.slot_limits;
create policy "Admin can update slot limits"
on public.slot_limits
for update
to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com')
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

-- 4. Cuántos cupos van tomados por ventana. Es security definer porque el
-- público no puede leer la tabla de pedidos: esto devuelve solo un conteo.
-- Un pedido pendiente retiene el cupo 30 minutos; pasado eso se asume
-- abandonado y el cupo vuelve a la venta.
create or replace function public.slot_load()
returns table (slot_date date, start_hour smallint, taken integer)
language sql
security definer
set search_path = public
as $$
  select o.reserved_date, o.reserved_start, count(*)::integer
  from public.orders o
  where o.reserved_date >= (now() at time zone 'America/Santiago')::date
    and o.reserved_start is not null
    and o.status <> 'cancelado'
    and (
      o.payment_status = 'pagado'
      or (o.payment_status = 'pendiente' and o.created_at > now() - interval '30 minutes')
    )
  group by o.reserved_date, o.reserved_start;
$$;

revoke all on function public.slot_load() from public;
grant execute on function public.slot_load() to anon, authenticated, service_role;

-- 5. Crea el pedido solo si queda cupo, en una sola transacción.
-- Contar y después insertar por separado deja pasar dos clientes al último
-- cupo a la vez, que es justo lo que el tope debe evitar: el advisory lock
-- serializa los pedidos de una misma ventana y libera al terminar.
create or replace function public.place_order(
  p_customer_name text,
  p_customer_phone text,
  p_address text,
  p_comuna text,
  p_reserved_date date,
  p_reserved_start smallint,
  p_reserved_end smallint,
  p_reserved_label text,
  p_order_mode text,
  p_items jsonb,
  p_total integer
)
returns table (order_id uuid, order_num bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_weekday text;
  v_capacity smallint;
  v_taken integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_reserved_date::text || ':' || p_reserved_start::text));

  v_weekday := case extract(dow from p_reserved_date)::int
    when 5 then 'Fri'
    when 6 then 'Sat'
    when 0 then 'Sun'
    else null
  end;

  select capacity into v_capacity
    from public.slot_limits
   where weekday = v_weekday and start_hour = p_reserved_start;

  -- Sin fila de tope configurada, la ventana no limita: preferimos vender a
  -- rechazar por un dato que falta.
  if v_capacity is not null then
    select count(*) into v_taken
      from public.orders o
     where o.reserved_date = p_reserved_date
       and o.reserved_start = p_reserved_start
       and o.status <> 'cancelado'
       and (
         o.payment_status = 'pagado'
         or (o.payment_status = 'pendiente' and o.created_at > now() - interval '30 minutes')
       );
    if v_taken >= v_capacity then
      raise exception 'SLOT_FULL';
    end if;
  end if;

  insert into public.orders (
    customer_name, customer_phone, delivery_method, delivery_address, comuna,
    reserved_date, reserved_start, reserved_end, reserved_label, order_mode,
    items, total, payment_provider, payment_status
  ) values (
    p_customer_name, p_customer_phone, 'Delivery', p_address, p_comuna,
    p_reserved_date, p_reserved_start, p_reserved_end, p_reserved_label, p_order_mode,
    p_items, p_total, 'mercado_pago', 'pendiente'
  )
  returning orders.id, orders.order_number into order_id, order_num;

  return next;
end;
$$;

-- Solo la Edge Function la usa: valida precios y productos antes de llamarla.
revoke all on function public.place_order(
  text, text, text, text, date, smallint, smallint, text, text, jsonb, integer
) from public;
grant execute on function public.place_order(
  text, text, text, text, date, smallint, smallint, text, text, jsonb, integer
) to service_role;
