-- Run this once in the Supabase SQL Editor.
-- Adds per-Soulfest qualitative/quantitative assessments for the swipe-review feature.

create table if not exists member_assessments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  event_instance_id uuid not null references event_instances(id) on delete cascade,
  rating smallint check (rating between 1 and 5),
  notes text,
  follow_up_flag_id uuid references follow_up_flags(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (person_id, event_instance_id)
);

alter table member_assessments enable row level security;

create policy "Authenticated users can manage member_assessments"
on member_assessments for all
to authenticated
using (true)
with check (true);

create or replace function set_member_assessments_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_member_assessments_updated_at
before update on member_assessments
for each row execute function set_member_assessments_updated_at();
