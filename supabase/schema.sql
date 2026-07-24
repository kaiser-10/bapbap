-- Ejecuta este archivo completo en Supabase: SQL Editor > New query > Run.
-- Las personas pueden CREAR pedidos, pero no pueden leer los pedidos de otros clientes.

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_phone text not null,
  delivery_method text not null check (delivery_method in ('Retiro', 'Delivery')),
  delivery_address text,
  items jsonb not null,
  total integer not null check (total >= 0),
  status text not null default 'nuevo' check (status in ('nuevo', 'confirmado', 'preparando', 'enviado', 'entregado', 'cancelado')),
  payment_status text not null default 'pendiente' check (payment_status in ('pendiente', 'pagado', 'rechazado')),
  created_at timestamptz not null default now(),
  constraint delivery_needs_address check (
    (delivery_method = 'Retiro' and delivery_address is null)
    or (delivery_method = 'Delivery' and delivery_address is not null)
  )
);

alter table public.orders enable row level security;

-- Permite que la tienda cree pedidos nuevos. No crea permisos para verlos ni modificarlos.
create policy "Public can create orders"
on public.orders
for insert
to anon
with check (
  char_length(customer_name) between 2 and 100
  and char_length(customer_phone) between 6 and 30
);
