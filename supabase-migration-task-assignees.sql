-- Multiple assignees per task.
-- Run once in the Supabase SQL Editor (Supabase dashboard -> SQL Editor -> New query -> paste -> Run).
--
-- Additive and safe to re-run: it creates a new table, copies existing assignments
-- into it and adds triggers on tasks that mirror assignee_id changes into it.
-- No existing row in tasks or members is dropped or modified.
-- tasks.assignee_id is kept (the app keeps it set to the first assignee) so
-- older open tabs keep working and the change can be rolled back
-- (see supabase-rollback-task-assignees.sql).
-- Re-running after go-live re-adds each task's current assignee_id if missing.
--
-- Everything runs in one transaction: if any statement fails, nothing is applied.
-- Requires PostgreSQL 14+ (CREATE OR REPLACE TRIGGER).

begin;

-- Give up instead of queueing behind long transactions (a waiting lock would
-- also block the app's own writes to tasks). Just run it again if it times out.
set local lock_timeout = '5s';

-- Block writes to tasks (reads still work) until commit, so no assignee_id change
-- can land between the backfill below and the triggers that take over from it.
lock table public.tasks in share row exclusive mode;

create table if not exists public.task_assignees (
  task_id uuid not null references public.tasks(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, member_id)
);

create index if not exists task_assignees_member_idx on public.task_assignees (member_id);

-- Preserve existing single assignments.
insert into public.task_assignees (task_id, member_id)
select id, assignee_id from public.tasks where assignee_id is not null
on conflict do nothing;

-- Same open (no-login) access model as the other tables, but only the
-- privileges the app uses: read, add, remove. (No update, truncate, etc.)
revoke all on table public.task_assignees from anon, authenticated;
grant select, insert, delete on table public.task_assignees to anon, authenticated;

alter table public.task_assignees enable row level security;

drop policy if exists "public read task_assignees" on public.task_assignees;
drop policy if exists "public insert task_assignees" on public.task_assignees;
drop policy if exists "public delete task_assignees" on public.task_assignees;
create policy "public read task_assignees" on public.task_assignees for select using (true);
create policy "public insert task_assignees" on public.task_assignees for insert with check (true);
create policy "public delete task_assignees" on public.task_assignees for delete using (true);

-- Keep task_assignees in step with tasks.assignee_id for clients that only know
-- the single-assignee column (browser tabs still running the previous app version).
-- The current app keeps assignee_id = its first assignee, so for it these steps
-- are no-ops or exactly what it does itself right after.
--   insert with an assignee           -> add that assignment
--   assignee changed from A to B      -> replace A with B (other assignees kept)
--   assignee set to null (Unassigned) -> remove only A (other assignees kept: the
--                                        old tab never saw them, so it can't mean them)
--   member A deleted (FK set null)    -> same as above; A's row also goes via cascade
-- Saving a task without changing its assignee does nothing.
-- SECURITY INVOKER (the default): runs with the caller's own privileges and RLS.
create or replace function public.sync_task_assignee_from_legacy() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.assignee_id is not null then
    delete from public.task_assignees where task_id = new.id and member_id = old.assignee_id;
  end if;

  if new.assignee_id is not null then
    insert into public.task_assignees (task_id, member_id)
    values (new.id, new.assignee_id)
    on conflict do nothing;
  end if;

  return null;
end $$;

create or replace trigger tasks_assignee_legacy_insert
after insert on public.tasks
for each row when (new.assignee_id is not null)
execute function public.sync_task_assignee_from_legacy();

create or replace trigger tasks_assignee_legacy_update
after update of assignee_id on public.tasks
for each row when (old.assignee_id is distinct from new.assignee_id)
execute function public.sync_task_assignee_from_legacy();

-- Live sync across open tabs
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_assignees'
  ) then
    alter publication supabase_realtime add table public.task_assignees;
  end if;
end $$;

commit;
