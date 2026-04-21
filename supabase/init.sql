-- =============================================================================
-- Patient Portal MVP — Initial Schema, RLS, Audit, Storage
-- Portfolio / learning project. NOT actual HIPAA-compliant infrastructure.
-- Do not use with real patient data.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Helper: role lookup (SECURITY DEFINER so it bypasses RLS on profiles and
-- can't be confused by recursive policy evaluation). Hardened search_path.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'patient'
             check (role in ('patient','clinician','admin')),
  full_name  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assignments (
  clinician_id uuid not null references public.profiles(id) on delete cascade,
  patient_id   uuid not null references public.profiles(id) on delete cascade,
  assigned_at  timestamptz not null default now(),
  primary key (clinician_id, patient_id)
);

create table public.reports (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  status       text not null default 'pending_review'
               check (status in ('pending_review','published','rejected')),
  uploaded_by  uuid references public.profiles(id),
  reviewed_by  uuid references public.profiles(id),
  uploaded_at  timestamptz not null default now(),
  reviewed_at  timestamptz
);

create table public.biomarkers (
  id         uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  report_id  uuid references public.reports(id) on delete set null,
  marker     text not null,
  value      numeric not null,
  unit       text,
  ref_low    numeric,
  ref_high   numeric,
  flagged    text check (flagged in ('low','normal','high')),
  taken_at   date not null,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id            bigserial primary key,
  actor_id      uuid references public.profiles(id),
  action        text not null,
  target_table  text not null,
  target_id     text,
  ip            inet,
  metadata      jsonb,
  created_at    timestamptz not null default now()
);

create index on public.assignments (patient_id);
create index on public.assignments (clinician_id);
create index on public.reports     (patient_id);
create index on public.reports     (status);
create index on public.biomarkers  (patient_id, taken_at desc);
create index on public.biomarkers  (report_id);
create index on public.audit_log   (actor_id, created_at desc);
create index on public.audit_log   (target_table, target_id);

-- ---------------------------------------------------------------------------
-- Auth integration: auto-create profile on signup (default role = patient)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Prevent non-admins from escalating their own role
-- ---------------------------------------------------------------------------
create or replace function public.prevent_role_self_escalation()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role
     and coalesce(public.current_user_role(), '') <> 'admin' then
    raise exception 'Only admins can change roles';
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_self_escalation();

-- ---------------------------------------------------------------------------
-- Enable RLS on everything
-- ---------------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.assignments enable row level security;
alter table public.reports     enable row level security;
alter table public.biomarkers  enable row level security;
alter table public.audit_log   enable row level security;

-- ---------------------------------------------------------------------------
-- Policies: profiles
-- ---------------------------------------------------------------------------
create policy "profiles: self read"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles: clinician reads assigned"
  on public.profiles for select
  using (
    public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id = profiles.id
    )
  );

create policy "profiles: admin reads all"
  on public.profiles for select
  using (public.current_user_role() = 'admin');

create policy "profiles: self update"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles: admin update"
  on public.profiles for update
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Policies: assignments
-- ---------------------------------------------------------------------------
create policy "assignments: patient reads own"
  on public.assignments for select
  using (patient_id = auth.uid());

create policy "assignments: clinician reads own"
  on public.assignments for select
  using (clinician_id = auth.uid());

create policy "assignments: admin reads all"
  on public.assignments for select
  using (public.current_user_role() = 'admin');

create policy "assignments: admin writes"
  on public.assignments for all
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Policies: reports
-- ---------------------------------------------------------------------------
create policy "reports: patient reads own published"
  on public.reports for select
  using (patient_id = auth.uid() and status = 'published');

create policy "reports: clinician reads assigned"
  on public.reports for select
  using (
    public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id = reports.patient_id
    )
  );

create policy "reports: admin reads all"
  on public.reports for select
  using (public.current_user_role() = 'admin');

create policy "reports: patient uploads own"
  on public.reports for insert
  with check (
    patient_id = auth.uid()
    and uploaded_by = auth.uid()
    and status = 'pending_review'
  );

create policy "reports: clinician uploads for assigned"
  on public.reports for insert
  with check (
    public.current_user_role() = 'clinician'
    and uploaded_by = auth.uid()
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id = reports.patient_id
    )
  );

create policy "reports: clinician reviews assigned"
  on public.reports for update
  using (
    public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id = reports.patient_id
    )
  )
  with check (
    public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id = reports.patient_id
    )
  );

create policy "reports: admin writes"
  on public.reports for all
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Policies: biomarkers
-- Note: patients only see biomarkers whose parent report is 'published'.
-- ---------------------------------------------------------------------------
create policy "biomarkers: patient reads published"
  on public.biomarkers for select
  using (
    patient_id = auth.uid()
    and exists (
      select 1 from public.reports r
      where r.id = biomarkers.report_id
        and r.status = 'published'
    )
  );

create policy "biomarkers: clinician reads assigned"
  on public.biomarkers for select
  using (
    public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id = biomarkers.patient_id
    )
  );

create policy "biomarkers: admin reads all"
  on public.biomarkers for select
  using (public.current_user_role() = 'admin');

create policy "biomarkers: clinician writes assigned"
  on public.biomarkers for all
  using (
    public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id = biomarkers.patient_id
    )
  )
  with check (
    public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id = biomarkers.patient_id
    )
  );

create policy "biomarkers: admin writes"
  on public.biomarkers for all
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Policies: audit_log  (APPEND-ONLY — no UPDATE or DELETE policy anywhere)
-- ---------------------------------------------------------------------------
create policy "audit: admin reads all"
  on public.audit_log for select
  using (public.current_user_role() = 'admin');

create policy "audit: authenticated insert"
  on public.audit_log for insert
  with check (auth.uid() is not null);

-- Intentionally NO update/delete policies. Absence = deny by default.

-- ---------------------------------------------------------------------------
-- Audit triggers on write-side PHI operations
-- (Reads are logged in the app layer so we can capture IP / user agent.)
-- ---------------------------------------------------------------------------
create or replace function public.log_phi_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_id text;
  v_patient_id uuid;
begin
  if tg_op = 'DELETE' then
    v_target_id := old.id::text;
  else
    v_target_id := new.id::text;
  end if;

  begin
    if tg_op = 'DELETE' then
      v_patient_id := (to_jsonb(old) ->> 'patient_id')::uuid;
    else
      v_patient_id := (to_jsonb(new) ->> 'patient_id')::uuid;
    end if;
  exception when others then
    v_patient_id := null;
  end;

  insert into public.audit_log (
    actor_id, action, target_table, target_id, ip, metadata
  ) values (
    auth.uid(),
    tg_op,
    tg_table_name,
    v_target_id,
    nullif(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', '')::inet,
    jsonb_build_object('patient_id', v_patient_id)
  );

  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

create trigger audit_profiles
  after insert or update or delete on public.profiles
  for each row execute function public.log_phi_write();

create trigger audit_assignments
  after insert or update or delete on public.assignments
  for each row execute function public.log_phi_write();

create trigger audit_reports
  after insert or update or delete on public.reports
  for each row execute function public.log_phi_write();

create trigger audit_biomarkers
  after insert or update or delete on public.biomarkers
  for each row execute function public.log_phi_write();

-- ---------------------------------------------------------------------------
-- Storage: private 'reports' bucket + object-level RLS
-- Path convention:  {patient_id}/{report_id}.pdf
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

create policy "storage: patient reads own reports"
  on storage.objects for select
  using (
    bucket_id = 'reports'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "storage: clinician reads assigned reports"
  on storage.objects for select
  using (
    bucket_id = 'reports'
    and public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id::text = (storage.foldername(name))[1]
    )
  );

create policy "storage: admin reads all reports"
  on storage.objects for select
  using (
    bucket_id = 'reports'
    and public.current_user_role() = 'admin'
  );

create policy "storage: patient uploads own"
  on storage.objects for insert
  with check (
    bucket_id = 'reports'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "storage: clinician uploads for assigned"
  on storage.objects for insert
  with check (
    bucket_id = 'reports'
    and public.current_user_role() = 'clinician'
    and exists (
      select 1 from public.assignments a
      where a.clinician_id = auth.uid()
        and a.patient_id::text = (storage.foldername(name))[1]
    )
  );
