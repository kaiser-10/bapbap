create policy "Admin can read all orders"
on public.orders
for select
to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');

create policy "Admin can update all orders"
on public.orders
for update
to authenticated
using ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com')
with check ((select auth.jwt()->>'email') = 'lucianorivas1116@gmail.com');
