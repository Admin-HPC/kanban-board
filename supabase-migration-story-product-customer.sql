-- Story Product and Customer fields, with products and customers master tables.
-- Run once in the Supabase SQL Editor (Supabase dashboard -> SQL Editor -> New query -> paste -> Run).
--
-- Additive: existing stories, tasks and members are not changed, and existing story product
-- values stay as they are. Every new story column is nullable, so existing stories read as null.
-- The customers table starts empty; add customers in the app or the table editor.
-- The products table is seeded with the four starting products; more can be added in the app.

begin;

-- 1. Products master table (names are unique, case-insensitively, so one product is not entered twice).
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create unique index if not exists products_name_lower_key on public.products (lower(name));

insert into public.products (name) values
  ('Medicare'), ('ACA'), ('Medicare - B2C'), ('ACA - B2C')
on conflict (name) do nothing;

-- 2. Story product: a nullable reference to the products table by name.
--    Existing stories.product values are kept. The fixed-value check from the earlier draft is dropped,
--    because products can now be added. Deleting a product that a story still uses is blocked.
alter table public.stories add column if not exists product text null;

alter table public.stories drop constraint if exists stories_product_check;
alter table public.stories drop constraint if exists stories_product_fkey;
alter table public.stories
  add constraint stories_product_fkey foreign key (product) references public.products(name);

-- 3. Customers master table (names are unique, case-insensitively, so one customer is not entered twice).
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create unique index if not exists customers_name_lower_key on public.customers (lower(name));

-- 4. Customer on a story: a nullable reference to the customers table.
alter table public.stories
  add column if not exists customer_id uuid null references public.customers(id) on delete set null;

-- 5. Row level security, same open policies the other tables use (no login in this app).
alter table public.products enable row level security;
alter table public.customers enable row level security;

drop policy if exists "public read products" on public.products;
drop policy if exists "public insert products" on public.products;
drop policy if exists "public update products" on public.products;
drop policy if exists "public delete products" on public.products;
create policy "public read products" on public.products for select using (true);
create policy "public insert products" on public.products for insert with check (true);
create policy "public update products" on public.products for update using (true);
create policy "public delete products" on public.products for delete using (true);

drop policy if exists "public read customers" on public.customers;
drop policy if exists "public insert customers" on public.customers;
drop policy if exists "public update customers" on public.customers;
drop policy if exists "public delete customers" on public.customers;
create policy "public read customers" on public.customers for select using (true);
create policy "public insert customers" on public.customers for insert with check (true);
create policy "public update customers" on public.customers for update using (true);
create policy "public delete customers" on public.customers for delete using (true);

-- Explicit grants to the Supabase API roles (same access the other app tables have).
grant select, insert, update, delete on public.products to anon, authenticated;
grant select, insert, update, delete on public.customers to anon, authenticated;

-- 6. Realtime, so open boards pick up changes (each table added only if not already added).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'products'
  ) then
    alter publication supabase_realtime add table public.products;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'customers'
  ) then
    alter publication supabase_realtime add table public.customers;
  end if;
end $$;

commit;

-- Tell the API layer to reload its schema cache, so the new tables are visible without waiting.
notify pgrst, 'reload schema';

-- Rollback (only if you need to undo this; it drops the product and customer values on stories):
--   alter publication supabase_realtime drop table public.customers;
--   alter publication supabase_realtime drop table public.products;
--   alter table public.stories drop column if exists customer_id;
--   alter table public.stories drop constraint if exists stories_product_fkey;
--   alter table public.stories drop column if exists product;
--   drop table if exists public.customers;
--   drop table if exists public.products;
