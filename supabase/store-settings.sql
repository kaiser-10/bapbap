-- Ejecuta este archivo una vez en Supabase: SQL Editor > New query > Run.
-- Permite cerrar la tienda desde el panel cuando se acaba el stock.

-- Una sola fila: el check sobre la llave primaria impide crear más.
create table if not exists public.store_settings (
  id boolean primary key default true check (id),
  -- Fecha (hora de Santiago) en que se marcó agotado. Solo cuenta si es hoy,
  -- así la tienda se reactiva sola al día siguiente y nadie tiene que acordarse.
  sold_out_on date,
  updated_at timestamptz not null default now()
);

insert into public.store_settings (id) values (true) on conflict (id) do nothing;

alter table public.store_settings enable row level security;

-- La tienda pública necesita leerlo para mostrar "agotado". Solo expone una fecha.
create policy "Public can read store settings"
on public.store_settings
for select
to anon, authenticated
using (true);

-- Solo el administrador puede cambiar la disponibilidad.
create policy "Admin can update store settings"
on public.store_settings
for update
to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com')
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');
