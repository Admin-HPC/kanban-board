-- Fix for the function rename error ("violates check constraint stories_department_check").
-- Use this only if supabase-migration-functions.sql has already run (the functions table exists).
-- Run once in the Supabase SQL Editor. DO NOT RUN until approved.
-- Inspect first (read-only):
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.stories'::regclass and contype = 'c';

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

-- Stories still reference functions by name, and the foreign key checks those names against the functions table.
-- (The foreign key from the migration stays in place.)

commit;

notify pgrst, 'reload schema';
