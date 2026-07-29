-- Ejecuta este archivo una vez en Supabase: SQL Editor > New query > Run.
-- Habilita actualizaciones en tiempo real sobre la tabla orders para que
-- el panel admin se refresque solo cuando entra o cambia un pedido.

alter publication supabase_realtime add table public.orders;
