-- Ejecuta este archivo una vez en Supabase: SQL Editor > New query > Run.
-- Agrega la comuna de despacho y restringe los pedidos a las zonas de cobertura.

alter table public.orders add column if not exists comuna text;
alter table public.orders add constraint comuna_valid check (comuna is null or comuna in ('Puente Alto', 'San Bernardo', 'El Bosque', 'La Pintana'));
