-- Task comments: adds a nullable free-text comments column to tasks.
-- Run once in the Supabase SQL Editor (Supabase dashboard -> SQL Editor -> New query -> paste -> Run).
--
-- Additive and safe to re-run: it only adds a column. No existing row or column is
-- changed, and task_description (tasks.description) stays a separate field.

alter table public.tasks add column if not exists comments text;
