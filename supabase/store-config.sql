-- Ejecuta este archivo completo en Supabase: SQL Editor > New query > Run.
-- Pasa a la base el horario de atención, los cierres (feriados, vacaciones) y
-- las comunas con su despacho, para cambiarlos desde el panel sin tocar código.
-- Se puede volver a correr sin romper nada.

-- 1. Horario: una fila por día que se atiende. Un día sin fila está cerrado.
create table if not exists public.opening_hours (
  weekday text primary key check (weekday in ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')),
  open_hour smallint not null check (open_hour between 0 and 23),
  close_hour smallint not null check (close_hour between 1 and 24),
  updated_at timestamptz not null default now(),
  constraint opening_hours_order check (close_hour > open_hour)
);

insert into public.opening_hours (weekday, open_hour, close_hour) values
  ('Fri', 17, 20), ('Sat', 12, 20), ('Sun', 12, 17)
on conflict (weekday) do nothing;

-- 2. Cierres puntuales. Ambos extremos incluidos, fechas en hora de Santiago.
-- notice_url es opcional: la imagen que avisa el cierre en la tienda, visible
-- desde que se crea hasta el último día.
create table if not exists public.closures (
  id uuid primary key default gen_random_uuid(),
  date_from date not null,
  date_to date not null,
  reason text not null default '' check (char_length(reason) <= 80),
  notice_url text,
  created_at timestamptz not null default now(),
  constraint closures_order check (date_to >= date_from)
);

insert into public.closures (date_from, date_to, reason, notice_url)
select '2026-09-18', '2026-09-20', 'Fiestas Patrias', '/photos/aviso-fiestas-patrias.jpg'
where not exists (select 1 from public.closures where date_from = '2026-09-18' and date_to = '2026-09-20');

-- 3. Comunas con despacho. Los pedidos guardan el nombre y el total cobrado,
-- así que cambiar una tarifa o sacar una comuna no altera el historial.
create table if not exists public.comunas (
  name text primary key check (char_length(name) between 2 and 60),
  fee integer not null check (fee between 0 and 100000),
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.comunas (name, fee, sort_order) values
  ('Puente Alto', 2990, 10), ('San Bernardo', 2990, 20), ('El Bosque', 2990, 30), ('La Pintana', 2990, 40),
  ('La Florida', 4490, 50), ('La Granja', 4490, 60), ('San Ramón', 4490, 70), ('La Cisterna', 4490, 80)
on conflict (name) do nothing;

-- La lista fija de comunas en los pedidos impediría agregar una nueva desde
-- el panel. Quién despacha dónde lo valida create-payment contra la tabla.
alter table public.orders drop constraint if exists comuna_valid;

-- Permisos: la tienda lee todo (no hay nada privado), solo el admin escribe.
alter table public.opening_hours enable row level security;
alter table public.closures enable row level security;
alter table public.comunas enable row level security;

drop policy if exists "Public can read opening hours" on public.opening_hours;
create policy "Public can read opening hours" on public.opening_hours
for select to anon, authenticated using (true);
drop policy if exists "Admin can manage opening hours" on public.opening_hours;
create policy "Admin can manage opening hours" on public.opening_hours
for all to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com')
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

drop policy if exists "Public can read closures" on public.closures;
create policy "Public can read closures" on public.closures
for select to anon, authenticated using (true);
drop policy if exists "Admin can manage closures" on public.closures;
create policy "Admin can manage closures" on public.closures
for all to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com')
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

drop policy if exists "Public can read comunas" on public.comunas;
create policy "Public can read comunas" on public.comunas
for select to anon, authenticated using (true);
drop policy if exists "Admin can manage comunas" on public.comunas;
create policy "Admin can manage comunas" on public.comunas
for all to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com')
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

-- 4. Cupos para cualquier día. Antes solo existían viernes, sábado y domingo:
-- abrir otro día desde el panel dejaría esas ventanas sin tope. El panel crea
-- las filas que falten al guardar el horario, por eso necesita insertar.
-- La restricción vieja se creó sin nombre, así que se busca por su contenido.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.slot_limits'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%weekday%'
  loop
    execute format('alter table public.slot_limits drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.slot_limits add constraint slot_limits_weekday_valid
  check (weekday in ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'));

drop policy if exists "Admin can insert slot limits" on public.slot_limits;
create policy "Admin can insert slot limits" on public.slot_limits
for insert to authenticated
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

-- place_order buscaba el tope solo para viernes, sábado y domingo. Igual a la
-- de preorders.sql salvo el cálculo del día. to_char sin el prefijo TM devuelve
-- el día en inglés ("Mon") sin importar el idioma de la base.
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

  v_weekday := to_char(p_reserved_date, 'Dy');

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

revoke all on function public.place_order(
  text, text, text, text, date, smallint, smallint, text, text, jsonb, integer
) from public;
grant execute on function public.place_order(
  text, text, text, text, date, smallint, smallint, text, text, jsonb, integer
) to service_role;
