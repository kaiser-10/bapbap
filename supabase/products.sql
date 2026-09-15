-- Ejecuta este archivo una vez en Supabase: SQL Editor > New query > Run.
-- Pasa el menú a la base para poder agregar, editar, ocultar y marcar agotados
-- los productos desde el panel, sin volver a desplegar.

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  -- Único porque create-payment también acepta el nombre: una pestaña abierta
  -- desde antes del cambio manda solo eso. Los pedidos guardan el nombre y el
  -- precio cobrado, así que editar o borrar un producto no altera el historial.
  name text not null unique check (char_length(name) between 2 and 80),
  description text not null default '' check (char_length(description) <= 300),
  price integer not null check (price between 100 and 1000000),
  photo_url text,
  -- Solo el pollo pregunta la salsa.
  has_sauce boolean not null default false,
  -- Agotado: sigue en el menú, pero no se puede agregar ni pagar.
  sold_out boolean not null default false,
  -- Oculto: no aparece en la tienda.
  hidden boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Los nombres tienen que ser exactamente los que ya usa la tienda publicada.
insert into public.products (name, description, price, photo_url, has_sauce, sort_order) values
  ('Media porción', 'Pollo coreano crocante con una pequeña porción de nabo.', 11990, '/photos/pollo-individual.jpg', true, 10),
  ('Porción (2 a 3 personas)', 'El doble de pollo coreano crocante, con una pequeña porción de nabo.', 19990, '/photos/pollo-compartir.jpg', true, 20),
  ('Bibimbap', 'Arroz con carne salteada, vegetales frescos, huevo frito y sésamo.', 8990, '/photos/bibimbap.jpg', false, 30),
  ('Kimbap', 'Rollo de arroz con pastel de pescado, huevo, zanahoria y espinaca, envuelto en alga y cortado en rodajas.', 4990, '/photos/kimbap.jpg', false, 40),
  ('Kimari', 'Rollo de alga relleno de fideo y verduras, frito hasta quedar crocante.', 5990, '/photos/kimari.jpg', false, 50),
  ('Coca-Cola en lata', '350 ml, bien fría.', 1500, '/photos/coca-cola.jpg', false, 60),
  ('Porción de arroz', 'Arroz blanco recién preparado, para acompañar cualquier porción.', 2000, '/photos/arroz.jpg', false, 70)
on conflict (name) do nothing;

alter table public.products enable row level security;

-- La tienda necesita leer el menú. No hay nada privado en él.
create policy "Public can read products"
on public.products
for select
to anon, authenticated
using (true);

create policy "Admin can insert products"
on public.products
for insert
to authenticated
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

create policy "Admin can update products"
on public.products
for update
to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com')
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

create policy "Admin can delete products"
on public.products
for delete
to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

-- Fotos de productos. Público para que la tienda las muestre sin sesión; solo
-- el administrador puede subir, reemplazar o borrar. El panel las achica antes
-- de subirlas, el límite de 5 MB es solo un tope de seguridad.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Admin can upload product photos"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'product-photos' and (select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

create policy "Admin can update product photos"
on storage.objects
for update
to authenticated
using (bucket_id = 'product-photos' and (select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

create policy "Admin can delete product photos"
on storage.objects
for delete
to authenticated
using (bucket_id = 'product-photos' and (select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');
