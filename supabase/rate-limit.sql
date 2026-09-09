-- Ejecuta este archivo una vez en Supabase: SQL Editor > New query > Run.
-- Limita cuántos intentos de pago puede hacer una misma IP por minuto.

create table if not exists public.rate_limits (
  ip text not null,
  window_start timestamptz not null,
  count integer not null default 1,
  primary key (ip, window_start)
);

alter table public.rate_limits enable row level security;
-- Sin policies: solo la Edge Function (con la service role key, que ignora RLS) la toca.

-- Suma un intento para (ip, ventana) y devuelve el total acumulado en esa ventana.
-- El upsert es atómico, así que dos requests simultáneas de la misma IP no se pisan.
create or replace function public.increment_rate_limit(p_ip text, p_window timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  insert into public.rate_limits (ip, window_start, count)
  values (p_ip, p_window, 1)
  on conflict (ip, window_start)
  do update set count = rate_limits.count + 1
  returning count into new_count;
  return new_count;
end;
$$;
