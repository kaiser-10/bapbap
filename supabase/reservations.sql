-- Ejecuta este archivo una vez en Supabase: SQL Editor > New query > Run.
-- Agrega el bloque de entrega que el cliente reservó al hacer el pedido.

alter table public.orders add column if not exists reserved_date date;
alter table public.orders add column if not exists reserved_label text;
