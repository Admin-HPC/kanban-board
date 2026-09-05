-- Run this whole file once in your Supabase project's SQL Editor
-- (Supabase dashboard -> SQL Editor -> New query -> paste -> Run)

create extension if not exists pgcrypto;

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text not null default '#6366f1',
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo','in_progress','done')),
  assignee_id uuid references members(id) on delete set null,
  created_by text not null default '',
  position double precision not null default 0,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_status_idx on tasks (status);

-- Row level security, with fully open policies since there is no login --
-- anyone with your Supabase anon key (embedded in the deployed app) can
-- read/write. That matches "share a link, no login" for your team, but
-- means the link + key should only go to people you trust.
alter table members enable row level security;
alter table tasks enable row level security;

drop policy if exists "public read members" on members;
drop policy if exists "public write members" on members;
create policy "public read members" on members for select using (true);
create policy "public write members" on members for insert with check (true);
create policy "public update members" on members for update using (true);

drop policy if exists "public read tasks" on tasks;
drop policy if exists "public insert tasks" on tasks;
drop policy if exists "public update tasks" on tasks;
drop policy if exists "public delete tasks" on tasks;
create policy "public read tasks" on tasks for select using (true);
create policy "public insert tasks" on tasks for insert with check (true);
create policy "public update tasks" on tasks for update using (true);
create policy "public delete tasks" on tasks for delete using (true);

-- Enable realtime so every open tab sees changes live
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table members;
