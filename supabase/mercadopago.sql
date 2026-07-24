-- Ejecuta este archivo una vez en Supabase: SQL Editor > New query > Run.
-- Agrega referencias para conciliar pedidos con Mercado Pago.

alter table public.orders
  add column if not exists payment_provider text,
  add column if not exists payment_preference_id text;

-- Los pedidos ahora son creados exclusivamente por la Edge Function,
-- que valida precios y productos antes de generar el cobro.
drop policy if exists "Public can create orders" on public.orders;
