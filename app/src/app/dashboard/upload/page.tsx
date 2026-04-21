"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function UploadPage() {
  const router = useRouter();
  const supabase = createClient();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);

    try {
      // Validate file
      if (file.type !== "application/pdf") {
        throw new Error("Only PDF files are accepted");
      }
      if (file.size > 10 * 1024 * 1024) {
        throw new Error("File must be under 10 MB");
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Check role — clinicians need to pick which patient (skipping for v1,
      // keeping it simple: uploader uploads for themselves)
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      const patientId = user.id; // v1: upload-for-self. Clinician-for-patient flow is a next iteration.

      // Generate the report ID client-side so we know the storage path up front
      const reportId = crypto.randomUUID();
      const storagePath = `${patientId}/${reportId}.pdf`;

      // 1. Upload PDF to storage first
      const { error: uploadError } = await supabase.storage
        .from("reports")
        .upload(storagePath, file, {
          contentType: "application/pdf",
          upsert: false,
        });

      if (uploadError) throw uploadError;

      // 2. Create report row with the final storage path already set
      const { data: report, error: reportError } = await supabase
        .from("reports")
        .insert({
          id: reportId,
          patient_id: patientId,
          storage_path: storagePath,
          status: "pending_review",
          parse_status: "queued",
          uploaded_by: user.id,
        })
        .select()
        .single();

      if (reportError) {
        // Clean up the orphan file
        await supabase.storage.from("reports").remove([storagePath]);
        throw reportError;
      }

      // 3. Fire-and-forget the parse job
      fetch("/api/parse-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: report.id }),
      }).catch(() => {
        // Parse can be retried later; don't block the user
      });

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setUploading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-xl mx-auto bg-white p-8 rounded-lg shadow">
        <h1 className="text-2xl font-semibold mb-6">Upload lab results</h1>

        <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
          <strong>Portfolio project — synthetic data only.</strong> Do not upload real medical records.
        </div>

        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="block text-sm mb-1">PDF file</label>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
              required
            />
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!file || uploading}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload & parse"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}