# Patient Portal — HIPAA-Equivalent Architecture Demo

> **Portfolio / learning project.** This application uses synthetic data only and is not authorized for real Protected Health Information (PHI). "HIPAA-equivalent" here refers to architectural patterns — actual HIPAA compliance requires signed BAAs with every subprocessor, formal risk assessments, staff training, and ongoing audit. This demo implements the engineering side of that picture; it does not claim legal compliance.

A patient portal MVP built to demonstrate the security architecture behind medical-data platforms: row-level security, least-privilege service roles, append-only audit logging, LLM-powered PDF ingestion with human-in-the-loop review, and per-object private storage.

**[Live demo →](https://patient-portal-demo-five.vercel.app/)

## Demo accounts

| Role | Email | Password | What they see |
|---|---|---|---|
| Patient | `patient1@demo.test` | `password123` | Their own published biomarkers & reports |
| Patient | `patient2@demo.test` | `password123` | Same — different data set |
| Clinician | `clinician@demo.test` | `password123` | Assigned patients only + pending review queue |
| Admin | `admin@demo.test` | `password123` | All data + audit log |

## What it does

1. **Patient uploads a lab-results PDF.** Stored in a private Supabase Storage bucket under a path scoped to their user ID.
2. **A background route sends the PDF to Claude** with a structured tool-use schema that forces JSON-shaped biomarker extraction.
3. **Extracted biomarkers land in a `pending_review` state** — invisible to the patient until a clinician approves.
4. **Clinician reviews in a side-by-side UI**, PDF on one side, editable extracted rows on the other. Can edit, delete, or add rows before publishing.
5. **Once published, the patient sees their biomarkers.** Every step is enforced at the database layer, not the application layer.

## Stack

- **Next.js 15** (App Router, TypeScript)
- **Supabase** — Postgres, Auth, Storage, Row Level Security
- **Anthropic Claude** (Sonnet) with tool-use for structured output
- **Tailwind CSS** for styling
- **Vercel** for hosting

## The security story

### Row Level Security — the whole point

The premise: if a patient's session cookie leaks, if the frontend is compromised, if an attacker crafts a malicious API call — the database itself refuses to return data they're not authorized to see. No `where user_id = ?` checks in application code to forget. No frontend filtering that bypasses with a crafted request. The Postgres query planner filters rows based on JWT claims before data ever leaves the database.

A patient's view of the `biomarkers` table, for example, is controlled by this policy:

```sql
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
```

The clinician policy is subtler — they can only see biomarkers for patients they've been explicitly assigned to:

```sql
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
```

The role check matters. Without it, any user who happened to appear in the `assignments` table in any capacity could read rows — a classic IDOR waiting to happen. The policy requires both the assignment *and* the clinician role on `profiles`.

**Prove it works:** sign in as the clinician — they're assigned to patient 1 only. Query the biomarkers table through the dashboard; you see patient 1's four markers. Patient 2 uploaded a report too, but those rows are physically invisible to this session. Not hidden by the UI. Filtered by Postgres.

### Least privilege: the service role appears exactly once

The Supabase `service_role` key bypasses RLS. It's the equivalent of root access to the database. In this codebase it's imported in exactly one file: `src/app/api/parse-report/route.ts` — the background worker that downloads the PDF, calls Claude, and inserts biomarkers. Everywhere else uses the user-scoped anon key, which respects RLS.

Before switching to the service role in that route, the code first validates access with the *user's* client:

```ts
// Verify the user has access to this report BEFORE switching to service_role.
// RLS enforces the check. No access → no parse.
const { data: accessCheck } = await userClient
  .from("reports")
  .select("id, patient_id, storage_path, parse_status")
  .eq("id", reportId)
  .single();

if (!accessCheck) {
  return NextResponse.json({ error: "Access denied" }, { status: 404 });
}
```

The service role is used only for the subsequent background work that the user identity can't perform (like downloading a PDF the user uploaded but whose storage read RLS requires a review-approval state). The `actor_id` of the triggering user is captured in the audit log before the switch.

### Append-only audit log

Every write to a PHI table (`profiles`, `assignments`, `reports`, `biomarkers`) fires a Postgres trigger that inserts a row into `audit_log` with the actor, action, target, and IP. The `audit_log` table has an INSERT policy but *no* UPDATE or DELETE policies — absence means deny by default. Even an attacker with the service role cannot modify or delete audit entries without explicitly granting themselves new policies at the database level, which is itself audited.

```sql
create policy "audit: authenticated insert"
  on public.audit_log for insert
  with check (auth.uid() is not null);

-- Intentionally NO update/delete policies. Absence = deny by default.
```

### Storage: object-level policies, not just bucket-level

The `reports` bucket is private. Path convention is `{patient_id}/{report_id}.pdf`, and storage-level RLS checks the first path segment against the requesting user's ID (or their assignment list, for clinicians). Patient 2 cannot request patient 1's PDF by guessing the URL; Supabase Storage refuses at the same RLS layer the tables use.

### Escalation guard

A trigger on `profiles` prevents authenticated non-admin users from changing their own role. If `auth.uid()` is null (running in an unauthenticated context like the SQL editor or a seed script), the change is allowed — otherwise the user must have admin role or the update is rejected.

### Other patterns applied

- **Secrets hygiene.** `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` are server-only — no `NEXT_PUBLIC_` prefix, never bundled to the client. Environment variables come from Vercel's encrypted store in production.
- **No PHI in URLs.** Report IDs appear in routes (`/dashboard/review/:id`), but biomarker values, patient names, and medical content never appear in query strings or log lines.
- **Server-side redirects for auth.** Middleware runs `supabase.auth.getUser()` on every protected request — not just checking a cookie, but validating it against Supabase Auth.
- **Human-in-the-loop for LLM output.** Extracted biomarkers never become patient-visible without a clinician's explicit publish action. This is not just a policy choice; it's an RLS-enforced constraint on the patient's read policy.

## What's intentionally not here

Shipping this for real would require a lot more. Calling them out so the gaps are visible and honest:

- **No signed BAAs** with Supabase, Anthropic, or Vercel. Real PHI needs those before it touches these services.
- **Fire-and-forget parse pipeline** instead of a durable queue. Works for a demo; production would use Inngest, Trigger.dev, or `pg_cron` + Edge Functions for retry, backoff, and guaranteed delivery.
- **Read-side audit logging** is in the app layer only (not yet implemented in the demo — writes are logged via DB triggers, reads would need middleware instrumentation since triggers don't fire on SELECT).
- **No MFA enrollment flow** for clinician/admin roles. Supabase supports TOTP natively — wiring it in is a next iteration.
- **No rate limiting** on the parse endpoint. Production needs this to prevent LLM cost blowouts.
- **No secrets rotation, no penetration testing, no SOC 2 controls.** Obviously.

## The LLM pipeline

The PDF → biomarkers extraction uses Claude's tool-use feature. Rather than asking the model to "return JSON" and hoping, we define a tool:

```ts
const EXTRACT_TOOL = {
  name: "record_biomarkers",
  input_schema: {
    type: "object",
    properties: {
      taken_at: { type: "string", description: "YYYY-MM-DD" },
      biomarkers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            marker:   { type: "string" },
            value:    { type: "number" },
            unit:     { type: "string" },
            ref_low:  { type: "number" },
            ref_high: { type: "number" },
            flagged:  { type: "string", enum: ["low", "normal", "high"] },
          },
          required: ["marker", "value", "unit", "flagged"],
        },
      },
    },
    required: ["taken_at", "biomarkers"],
  },
};
```

…and force the model to use it with `tool_choice: { type: "tool", name: "record_biomarkers" }`. The response is guaranteed to include a `tool_use` block with input matching the schema. We parse that directly — no prompt-injection-vulnerable JSON extraction from free text, no regex, no retry-on-invalid-JSON loops.

Failures (malformed PDF, model refusal, network error) set the report's `parse_status` to `'failed'` with the error message stored in `parse_error`. The UI surfaces this as a red badge. The actor who triggered the parse is captured in the audit log before the worker starts, so failed runs are still traceable.

## Local development

```bash
# 1. Clone and install
git clone [repo-url]
cd app
pnpm install

# 2. Create a Supabase project at supabase.com
# 3. In the SQL editor, run init.sql then seed.sql (see /supabase/)
# 4. Create four demo users through Supabase Auth dashboard:
#    admin@demo.test, clinician@demo.test, patient1@demo.test, patient2@demo.test
#    All with password 'password123'
# 5. Update seed.sql's UUIDs to match your real auth.users IDs, then run it

# 6. Copy your API keys into .env.local
cp .env.example .env.local  # fill in values

# 7. Run
pnpm dev
```

## Architecture diagrams

```
┌──────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│                  │      │                  │      │                 │
│   Next.js App    │──────│  Supabase Auth   │──────│  Postgres +     │
│   (Vercel)       │ JWT  │  (SMS/Email OTP) │      │  Row-Level      │
│                  │      │                  │      │  Security       │
└────────┬─────────┘      └──────────────────┘      └─────────────────┘
         │                                                    ▲
         │ (upload PDF)                                       │
         ▼                                                    │
┌──────────────────┐                                          │
│ Supabase Storage │                                          │
│ (private bucket, │                                          │
│ object-level RLS)│                                          │
└────────┬─────────┘                                          │
         │                                                    │
         │ (signed URL)                                       │
         ▼                                                    │
┌──────────────────┐      ┌──────────────────┐                │
│  /api/parse-     │      │                  │                │
│  report          │──────│  Claude Sonnet   │                │
│  (service role,  │      │  (tool-use for   │                │
│  bypasses RLS)   │      │  structured JSON)│                │
└────────┬─────────┘      └──────────────────┘                │
         │                                                    │
         │ (insert biomarkers, pending_review)                │
         └────────────────────────────────────────────────────┘

User sees biomarkers only after:
  Clinician reviews → edits → publishes → status = 'published'
  Then RLS policy permits patient SELECT
```

## License

Portfolio project. Code is shared for educational reference. Do not use with real patient data.