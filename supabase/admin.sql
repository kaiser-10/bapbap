create policy "Admin can read all orders"
on public.orders
for select
to authenticated
using ((select auth.jwt()->>'email') = 'luciano.silva@mail.udp.cl');

create policy "Admin can update all orders"
on public.orders
for update
to authenticated
using ((select auth.jwt()->>'email') = 'luciano.silva@mail.udp.cl')
with check ((select auth.jwt()->>'email') = 'luciano.silva@mail.udp.cl');
