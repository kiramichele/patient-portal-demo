import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import SignOutButton from "./sign-out-button";
import ReportsPoller from "./reports-poller";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  const { data: biomarkers } = await supabase
    .from("biomarkers")
    .select("marker, value, unit, ref_low, ref_high, flagged, taken_at, patient_id")
    .order("taken_at", { ascending: false });

  const { data: reports } = await supabase
    .from("reports")
    .select("id, patient_id, status, parse_status, parse_error, uploaded_at");

  const hasPendingParse = reports?.some(
    r => r.parse_status === "queued" || r.parse_status === "parsing"
  ) ?? false;

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className="text-2xl font-semibold">{profile?.full_name ?? user.email}</h1>
            <p className="text-sm text-gray-500">
              Role: <span className="font-mono">{profile?.role ?? "unknown"}</span>
              {" · "}
              <span className="font-mono">{user.email}</span>
            </p>
          </div>
          <div className="flex gap-3 items-center">
            <Link
              href="/dashboard/upload"
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
            >
              Upload PDF
            </Link>
            <SignOutButton />
          </div>
        </div>

        <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
          <strong>Portfolio / learning project.</strong> Data below is visible to you only because Postgres RLS
          policies grant your role access. Rows you can&apos;t see are filtered at the database — not hidden by the UI.
        </div>

        {(profile?.role === "clinician" || profile?.role === "admin") && (
          <PendingReviewSection />
        )}

        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-3">
            Reports ({reports?.length ?? 0} visible)
          </h2>
          {reports && reports.length > 0 ? (
            <div className="bg-white rounded shadow overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-100 text-left">
                  <tr>
                    <th className="px-3 py-2">Patient</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Parse</th>
                    <th className="px-3 py-2">Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map(r => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs text-gray-400">
                        {r.patient_id.slice(0, 8)}…
                      </td>
                      <td className="px-3 py-2">{r.status}</td>
                      <td className="px-3 py-2">
                        <ParseStatusBadge status={r.parse_status} error={r.parse_error} />
                      </td>
                      <td className="px-3 py-2 text-gray-500">
                        {new Date(r.uploaded_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No reports visible to your role.</p>
          )}
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-3">
            Biomarkers ({biomarkers?.length ?? 0} visible)
          </h2>
          {biomarkers && biomarkers.length > 0 ? (
            <div className="bg-white rounded shadow overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-100 text-left">
                  <tr>
                    <th className="px-3 py-2">Marker</th>
                    <th className="px-3 py-2">Value</th>
                    <th className="px-3 py-2">Range</th>
                    <th className="px-3 py-2">Flag</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Patient</th>
                  </tr>
                </thead>
                <tbody>
                  {biomarkers.map((b, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2">{b.marker}</td>
                      <td className="px-3 py-2">{b.value} {b.unit}</td>
                      <td className="px-3 py-2 text-gray-500">
                        {b.ref_low ?? "–"} to {b.ref_high ?? "–"}
                      </td>
                      <td className="px-3 py-2">
                        <span className={
                          b.flagged === "high" ? "text-red-600" :
                          b.flagged === "low"  ? "text-amber-600" :
                          "text-gray-500"
                        }>
                          {b.flagged}
                        </span>
                      </td>
                      <td className="px-3 py-2">{b.taken_at}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-400">
                        {b.patient_id.slice(0, 8)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No biomarkers visible to your role.</p>
          )}
        </section>

        {/* Polls the page to refresh while any report is mid-parse */}
        {hasPendingParse && <ReportsPoller />}
      </div>
    </div>
  );
}

async function PendingReviewSection() {
  const supabase = await createClient();

  const { data: pending } = await supabase
    .from("reports")
    .select("id, patient_id, uploaded_at, parse_status, profiles:patient_id(full_name)")
    .eq("status", "pending_review")
    .eq("parse_status", "done")
    .order("uploaded_at", { ascending: false });

  if (!pending || pending.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3">
        Reports awaiting review ({pending.length})
      </h2>
      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Uploaded</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {pending.map((r) => {
              const profile = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
              return (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2">
                    {profile?.full_name ?? <span className="font-mono text-xs text-gray-400">{r.patient_id.slice(0, 8)}…</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {new Date(r.uploaded_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/dashboard/review/${r.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      Review →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ParseStatusBadge({ status, error }: { status: string; error: string | null }) {
  const styles: Record<string, string> = {
    queued:  "bg-gray-100 text-gray-700",
    parsing: "bg-blue-100 text-blue-700",
    done:    "bg-green-100 text-green-700",
    failed:  "bg-red-100 text-red-700",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono ${styles[status] ?? "bg-gray-100"}`} title={error ?? ""}>
      {status}
    </span>
  );
}