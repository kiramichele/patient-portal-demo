import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import ReviewForm from "./review-form";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "clinician" && profile?.role !== "admin") {
    redirect("/dashboard");
  }

  // RLS will silently return null if the clinician isn't assigned
  const { data: report } = await supabase
    .from("reports")
    .select("id, patient_id, status, storage_path, uploaded_at, profiles:patient_id(full_name)")
    .eq("id", reportId)
    .single();

  if (!report) notFound();

  const { data: biomarkers } = await supabase
    .from("biomarkers")
    .select("id, marker, value, unit, ref_low, ref_high, flagged, taken_at")
    .eq("report_id", reportId)
    .order("marker");

  // Signed URL for the PDF (60 min)
  const { data: signedUrl } = await supabase.storage
    .from("reports")
    .createSignedUrl(report.storage_path, 3600);

  const profileRel = report.profiles as { full_name: string } | { full_name: string }[] | null;
  const patientProfile = Array.isArray(profileRel) ? profileRel[0] : profileRel;
  const patientName = patientProfile?.full_name ?? "Unknown patient";

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-4 flex justify-between items-start">
          <div>
            <h1 className="text-xl font-semibold">Review: {patientName}</h1>
            <p className="text-sm text-gray-500">
              Uploaded {new Date(report.uploaded_at).toLocaleString()}
              {" · "}Status: <span className="font-mono">{report.status}</span>
            </p>
          </div>
          <a href="/dashboard" className="text-sm text-gray-600 hover:underline">
            ← Back to dashboard
          </a>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded shadow overflow-hidden" style={{ height: "85vh" }}>
            {signedUrl?.signedUrl ? (
              <iframe
                src={signedUrl.signedUrl}
                className="w-full h-full border-0"
                title="Lab report PDF"
              />
            ) : (
              <div className="p-4 text-sm text-gray-500">PDF unavailable</div>
            )}
          </div>

          <ReviewForm
            reportId={reportId}
            initialBiomarkers={biomarkers ?? []}
            alreadyPublished={report.status === "published"}
          />
        </div>
      </div>
    </div>
  );
}