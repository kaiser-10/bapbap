-- Ejecuta este archivo completo en Supabase: SQL Editor > New query > Run.
-- Se puede volver a correr sin romper nada.

-- 1. place_order solo debe llamarla create-payment. Supabase le da permiso de
-- ejecutar a anon y authenticated directamente, no a través de PUBLIC, así que
-- el "revoke ... from public" de preorders.sql no lo quitaba: cualquiera con la
-- llave pública podía crear pedidos pendientes saltándose la validación y el
-- límite de intentos, y cada uno retiene un cupo 30 minutos.
revoke execute on function public.place_order(
  text, text, text, text, date, smallint, smallint, text, text, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.place_order(
  text, text, text, text, date, smallint, smallint, text, text, jsonb, integer
) to service_role;

-- 2. Lo mismo con el contador de intentos: nunca tuvo revoke. Además limpia las
-- ventanas viejas, que se acumulaban para siempre (una fila por IP por minuto).
create or replace function public.increment_rate_limit(p_ip text, p_window timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  delete from public.rate_limits where window_start < now() - interval '1 hour';

  insert into public.rate_limits (ip, window_start, count)
  values (p_ip, p_window, 1)
  on conflict (ip, window_start)
  do update set count = rate_limits.count + 1
  returning count into new_count;
  return new_count;
end;
$$;

revoke execute on function public.increment_rate_limit(text, timestamptz) from public, anon, authenticated;
grant execute on function public.increment_rate_limit(text, timestamptz) to service_role;

-- 3. El "agotado" general se reemplazó por el agotado por producto y ya nadie
-- lee ni escribe esta tabla.
drop table if exists public.store_settings;
