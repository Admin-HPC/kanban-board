-- ROLLBACK of supabase-migration-task-assignees.sql  --  FOR REVIEW ONLY.
--
-- !!! WARNING: THIS PERMANENTLY DELETES MULTI-ASSIGNEE DATA !!!
-- Dropping public.task_assignees deletes every assignment except each task's
-- first assignee (which also lives in tasks.assignee_id). This cannot be undone
-- except from a backup.
--
-- Do NOT run this without:
--   1. Explicit approval from the board owner for a destructive production change.
--   2. A backup. Run this first (it only reads task_assignees and creates a copy):
--
--        create table public.task_assignees_backup as
--        select * from public.task_assignees;
--
--      and also export task_assignees as CSV (Table Editor -> task_assignees -> Export).
--   3. Rolling back the frontend first is NOT required: the current app falls back
--      to single-assignee mode when task_assignees is missing. The previous app
--      version ignores task_assignees entirely.
--
-- Non-destructive alternative: redeploy the previous frontend and leave the
-- database as it is. The triggers keep task_assignees in step with old-tab edits.
--
-- The script refuses to run (and changes nothing) unless the confirmation line
-- below is uncommented AND task_assignees_backup holds every current row.

begin;

-- set local kanban.confirm_rollback = 'DELETE MULTI-ASSIGNEE DATA';

set local lock_timeout = '5s';

do $$
begin
  if coalesce(current_setting('kanban.confirm_rollback', true), '') <> 'DELETE MULTI-ASSIGNEE DATA' then
    raise exception 'Refusing: uncomment the kanban.confirm_rollback line to confirm this destructive rollback';
  end if;
  if to_regclass('public.task_assignees') is null then
    raise exception 'Refusing: public.task_assignees does not exist (nothing to roll back)';
  end if;
  if to_regclass('public.task_assignees_backup') is null then
    raise exception 'Refusing: create public.task_assignees_backup first (see step 2 above)';
  end if;
end $$;

-- Stop all reads/writes of both tables until commit so nothing changes after the check.
lock table public.tasks, public.task_assignees in access exclusive mode;

do $$
begin
  if exists (
    select 1 from public.task_assignees a
    where not exists (
      select 1 from public.task_assignees_backup b
      where b.task_id = a.task_id and b.member_id = a.member_id
    )
  ) then
    raise exception 'Refusing: task_assignees_backup is missing current rows; recreate the backup';
  end if;
end $$;

drop trigger if exists tasks_assignee_legacy_insert on public.tasks;
drop trigger if exists tasks_assignee_legacy_update on public.tasks;
drop function if exists public.sync_task_assignee_from_legacy();

-- Keep one assignee on tasks whose legacy column is empty but that still have
-- assignees (e.g. their first assignee's member was deleted), so they don't
-- become Unassigned in the single-assignee app.
update public.tasks t
set assignee_id = (
  select a.member_id from public.task_assignees a
  where a.task_id = t.id
  order by a.created_at, a.member_id
  limit 1
)
where t.assignee_id is null
  and exists (select 1 from public.task_assignees a where a.task_id = t.id);

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_assignees'
  ) then
    alter publication supabase_realtime drop table public.task_assignees;
  end if;
end $$;

drop table public.task_assignees;

commit;

-- Keep public.task_assignees_backup until the rollback is confirmed good; drop it
-- separately later (also a destructive step needing approval).
