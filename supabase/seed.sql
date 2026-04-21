-- =============================================================================
-- Seed data — LOCAL DEV ONLY
-- Directly inserts into auth.users (works with `supabase db reset`).
-- On hosted Supabase, create users in the dashboard, then run just the
-- profile/assignment/report/biomarker sections below using the real UUIDs.
--
-- All seed accounts use password: password123
-- =============================================================================

-- ---- Users ------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000',
   '11111111-1111-1111-1111-111111111111',
   'authenticated', 'authenticated', 'admin@demo.test',
   crypt('password123', gen_salt('bf')),
   now(), now(), now(),
   '{"provider":"email","providers":["email"]}',
   '{"full_name":"Admin User"}',
   false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '22222222-2222-2222-2222-222222222222',
   'authenticated', 'authenticated', 'clinician@demo.test',
   crypt('password123', gen_salt('bf')),
   now(), now(), now(),
   '{"provider":"email","providers":["email"]}',
   '{"full_name":"Dr. Clinician"}',
   false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '33333333-3333-3333-3333-333333333333',
   'authenticated', 'authenticated', 'patient1@demo.test',
   crypt('password123', gen_salt('bf')),
   now(), now(), now(),
   '{"provider":"email","providers":["email"]}',
   '{"full_name":"Patient One"}',
   false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '44444444-4444-4444-4444-444444444444',
   'authenticated', 'authenticated', 'patient2@demo.test',
   crypt('password123', gen_salt('bf')),
   now(), now(), now(),
   '{"provider":"email","providers":["email"]}',
   '{"full_name":"Patient Two"}',
   false, '', '', '', '');

-- handle_new_user trigger auto-created profile rows with default role = 'patient'.
-- Upgrade the admin and clinician:
update public.profiles set role = 'admin'
  where id = '11111111-1111-1111-1111-111111111111';
update public.profiles set role = 'clinician'
  where id = '22222222-2222-2222-2222-222222222222';

-- Clinician assigned ONLY to patient 1.
-- Patient 2 is the negative control — the clinician must NOT be able to see
-- their data. This is the core RLS demo.
insert into public.assignments (clinician_id, patient_id) values
  ('22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333');

-- Patient 1: published report + biomarkers
insert into public.reports
  (id, patient_id, storage_path, status, uploaded_by, reviewed_by, reviewed_at)
values
  ('aaaa0000-0000-0000-0000-000000000001',
   '33333333-3333-3333-3333-333333333333',
   '33333333-3333-3333-3333-333333333333/aaaa0000-0000-0000-0000-000000000001.pdf',
   'published',
   '22222222-2222-2222-2222-222222222222',
   '22222222-2222-2222-2222-222222222222',
   now());

insert into public.biomarkers
  (patient_id, report_id, marker, value, unit, ref_low, ref_high, flagged, taken_at)
values
  ('33333333-3333-3333-3333-333333333333',
   'aaaa0000-0000-0000-0000-000000000001',
   'Glucose', 92, 'mg/dL', 70, 99, 'normal', current_date - 30),
  ('33333333-3333-3333-3333-333333333333',
   'aaaa0000-0000-0000-0000-000000000001',
   'LDL Cholesterol', 145, 'mg/dL', 0, 100, 'high', current_date - 30),
  ('33333333-3333-3333-3333-333333333333',
   'aaaa0000-0000-0000-0000-000000000001',
   'HDL Cholesterol', 58, 'mg/dL', 40, null, 'normal', current_date - 30),
  ('33333333-3333-3333-3333-333333333333',
   'aaaa0000-0000-0000-0000-000000000001',
   'Vitamin D', 22, 'ng/mL', 30, 100, 'low', current_date - 30);

-- Patient 2: pending-review report (clinician NOT assigned — isolation test)
insert into public.reports
  (id, patient_id, storage_path, status, uploaded_by)
values
  ('bbbb0000-0000-0000-0000-000000000001',
   '44444444-4444-4444-4444-444444444444',
   '44444444-4444-4444-4444-444444444444/bbbb0000-0000-0000-0000-000000000001.pdf',
   'pending_review',
   '44444444-4444-4444-4444-444444444444');
