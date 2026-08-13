-- Ejecuta este archivo una vez en Supabase: SQL Editor > New query > Run.
-- Agrega un número de pedido corto y secuencial para que el cliente lo use como referencia.

alter table public.orders add column if not exists order_number bigint generated always as identity;
