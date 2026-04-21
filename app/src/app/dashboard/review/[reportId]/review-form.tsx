"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Biomarker = {
  id: string;
  marker: string;
  value: number;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  flagged: "low" | "normal" | "high" | null;
  taken_at: string;
};

export default function ReviewForm({
  reportId,
  initialBiomarkers,
  alreadyPublished,
}: {
  reportId: string;
  initialBiomarkers: Biomarker[];
  alreadyPublished: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();
  const [rows, setRows] = useState<Biomarker[]>(initialBiomarkers);
  const [deleted, setDeleted] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(id: string, field: keyof Biomarker, value: unknown) {
    setRows(rows.map(r => r.id === id ? { ...r, [field]: value } : r));
  }

  function removeRow(id: string) {
    setRows(rows.filter(r => r.id !== id));
    setDeleted([...deleted, id]);
  }

  async function handlePublish() {
    setSaving(true);
    setError(null);

    try {
      // Persist edits
      for (const r of rows) {
        const { error } = await supabase
          .from("biomarkers")
          .update({
            marker: r.marker,
            value: r.value,
            unit: r.unit,
            ref_low: r.ref_low,
            ref_high: r.ref_high,
            flagged: r.flagged,
          })
          .eq("id", r.id);
        if (error) throw error;
      }

      // Delete removed
      if (deleted.length > 0) {
        const { error } = await supabase
          .from("biomarkers")
          .delete()
          .in("id", deleted);
        if (error) throw error;
      }

      // Publish
      const { data: { user } } = await supabase.auth.getUser();
      const { error: updateError } = await supabase
        .from("reports")
        .update({
          status: "published",
          reviewed_by: user!.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", reportId);

      if (updateError) throw updateError;

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded shadow p-4 overflow-auto" style={{ maxHeight: "85vh" }}>
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold">Extracted biomarkers ({rows.length})</h2>
        {!alreadyPublished && (
          <button
            onClick={handlePublish}
            disabled={saving}
            className="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? "Publishing…" : "Approve & publish"}
          </button>
        )}
      </div>

      <div className="mb-3 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
        Review each extracted value against the PDF. Edit if needed, remove anything that looks wrong,
        then publish to make these visible to the patient.
      </div>

      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      <table className="w-full text-xs">
        <thead className="bg-gray-100 text-left">
          <tr>
            <th className="px-2 py-1">Marker</th>
            <th className="px-2 py-1">Value</th>
            <th className="px-2 py-1">Unit</th>
            <th className="px-2 py-1">Low</th>
            <th className="px-2 py-1">High</th>
            <th className="px-2 py-1">Flag</th>
            <th className="px-2 py-1"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t">
              <td className="px-1 py-1">
                <input
                  value={r.marker}
                  onChange={(e) => updateRow(r.id, "marker", e.target.value)}
                  className="w-full px-1 py-0.5 border border-transparent hover:border-gray-300 rounded"
                  disabled={alreadyPublished}
                />
              </td>
              <td className="px-1 py-1">
                <input
                  type="number"
                  step="any"
                  value={r.value}
                  onChange={(e) => updateRow(r.id, "value", parseFloat(e.target.value))}
                  className="w-20 px-1 py-0.5 border border-transparent hover:border-gray-300 rounded"
                  disabled={alreadyPublished}
                />
              </td>
              <td className="px-1 py-1">
                <input
                  value={r.unit ?? ""}
                  onChange={(e) => updateRow(r.id, "unit", e.target.value)}
                  className="w-16 px-1 py-0.5 border border-transparent hover:border-gray-300 rounded"
                  disabled={alreadyPublished}
                />
              </td>
              <td className="px-1 py-1">
                <input
                  type="number"
                  step="any"
                  value={r.ref_low ?? ""}
                  onChange={(e) => updateRow(r.id, "ref_low", e.target.value === "" ? null : parseFloat(e.target.value))}
                  className="w-16 px-1 py-0.5 border border-transparent hover:border-gray-300 rounded"
                  disabled={alreadyPublished}
                />
              </td>
              <td className="px-1 py-1">
                <input
                  type="number"
                  step="any"
                  value={r.ref_high ?? ""}
                  onChange={(e) => updateRow(r.id, "ref_high", e.target.value === "" ? null : parseFloat(e.target.value))}
                  className="w-16 px-1 py-0.5 border border-transparent hover:border-gray-300 rounded"
                  disabled={alreadyPublished}
                />
              </td>
              <td className="px-1 py-1">
                <select
                  value={r.flagged ?? "normal"}
                  onChange={(e) => updateRow(r.id, "flagged", e.target.value)}
                  className={
                    "px-1 py-0.5 rounded text-xs " +
                    (r.flagged === "high" ? "text-red-600" :
                     r.flagged === "low"  ? "text-amber-600" : "text-gray-600")
                  }
                  disabled={alreadyPublished}
                >
                  <option value="normal">normal</option>
                  <option value="low">low</option>
                  <option value="high">high</option>
                </select>
              </td>
              <td className="px-1 py-1">
                {!alreadyPublished && (
                  <button
                    onClick={() => removeRow(r.id)}
                    className="text-red-500 hover:text-red-700 text-xs"
                  >
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}