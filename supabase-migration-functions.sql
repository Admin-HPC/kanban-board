-- Story Function as a master table (functions), like products and customers.
-- Run once in the Supabase SQL Editor (Supabase dashboard -> SQL Editor -> New query -> paste -> Run).
-- DO NOT RUN until approved. Run the pre-check below first.
--
-- Pre-check (must return no rows, or the foreign key below will fail):
--   select "function", count(*) from public.stories
--   where "function" is not null
--     and "function" not in ('Engineering', 'Products', 'Sales', 'Marketing & Lead Generation')
--   group by "function";
--
-- Additive: existing stories, tasks and members are not changed. Existing function values stay as they are.
-- The stored value "Products" is kept; the app displays it as "Product Function".

begin;

-- 0. Remove the old hardcoded check on stories.function (its name in the database is stories_department_check).
--    Only this one constraint is removed, and only if its definition covers the function column.
--    Otherwise the migration stops with an error and changes nothing.
do $$
declare
  c record;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.stories'::regclass
      and contype = 'c'
      and conname = 'stories_department_check'
  loop
    if c.def like '%function%' then
      execute format('alter table public.stories drop constraint %I', c.conname);
    else
      raise exception 'stories_department_check does not reference function (%). Nothing was changed.', c.def;
    end if;
  end loop;
end $$;

-- 1. Functions master table (names are unique, case-insensitively).
create table if not exists public.functions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create unique index if not exists functions_name_lower_key on public.functions (lower(name));

insert into public.functions (name) values
  ('Engineering'), ('Products'), ('Sales'), ('Marketing & Lead Generation')
on conflict (name) do nothing;

-- 2. Story function references the table by name. Deleting a function that a story still uses is blocked.
alter table public.stories drop constraint if exists stories_function_fkey;
alter table public.stories
  add constraint stories_function_fkey foreign key ("function") references public.functions(name);

-- 3. Row level security and grants, same open policies the other master tables use (no login in this app).
alter table public.functions enable row level security;

drop policy if exists "public read functions" on public.functions;
drop policy if exists "public insert functions" on public.functions;
drop policy if exists "public update functions" on public.functions;
drop policy if exists "public delete functions" on public.functions;
create policy "public read functions" on public.functions for select using (true);
create policy "public insert functions" on public.functions for insert with check (true);
create policy "public update functions" on public.functions for update using (true);
create policy "public delete functions" on public.functions for delete using (true);

grant select, insert, update, delete on public.functions to anon, authenticated;

-- 4. Realtime (added only if not already added).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'functions'
  ) then
    alter publication supabase_realtime add table public.functions;
  end if;
end $$;

commit;

-- Reload the API schema cache so the new table is visible straight away.
notify pgrst, 'reload schema';

-- Rollback (only if you need to undo this):
--   alter publication supabase_realtime drop table public.functions;
--   alter table public.stories drop constraint if exists stories_function_fkey;
--   drop table if exists public.functions;
