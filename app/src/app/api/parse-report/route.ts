import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

// Claude's tool-use schema forces structured JSON output. This is the contract
// between the LLM and our database — the shape MUST match the biomarkers table.
const EXTRACT_TOOL = {
  name: "record_biomarkers",
  description: "Record the biomarkers extracted from a pathology lab report.",
  input_schema: {
    type: "object" as const,
    properties: {
      taken_at: {
        type: "string",
        description: "Date specimen was collected, in YYYY-MM-DD format.",
      },
      biomarkers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            marker:    { type: "string", description: "Name of the biomarker (e.g. 'Glucose')." },
            value:     { type: "number", description: "Numeric result value." },
            unit:      { type: "string", description: "Unit of measurement (e.g. 'mg/dL')." },
            ref_low:   { type: "number", description: "Lower bound of reference range. Omit if not present." },
            ref_high:  { type: "number", description: "Upper bound of reference range. Omit if not present." },
            flagged:   { type: "string", enum: ["low", "normal", "high"] },
          },
          required: ["marker", "value", "unit", "flagged"],
        },
      },
    },
    required: ["taken_at", "biomarkers"],
  },
};

export async function POST(request: NextRequest) {
  // ---- Auth: establish WHO triggered this parse ---------------------------
  // We use the user-scoped client to verify identity. The background parse
  // itself will use service_role, but we log who initiated it.
  const userClient = await createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { reportId } = await request.json();
  if (!reportId || typeof reportId !== "string") {
    return NextResponse.json({ error: "Invalid reportId" }, { status: 400 });
  }

  // Verify the user actually has access to this report BEFORE switching to
  // service_role. RLS enforces this check. No access → no parse.
  const { data: accessCheck, error: accessError } = await userClient
    .from("reports")
    .select("id, patient_id, storage_path, parse_status")
    .eq("id", reportId)
    .single();

  if (accessError || !accessCheck) {
    return NextResponse.json({ error: "Report not found or access denied" }, { status: 404 });
  }

  if (accessCheck.parse_status !== "queued") {
    return NextResponse.json({ error: "Report is not in queued state" }, { status: 409 });
  }

  // ---- Service-role client: bypasses RLS for the background work ---------
  // This is the ONLY place in the app that should use service_role.
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Mark as parsing so the UI can reflect it
  await admin
    .from("reports")
    .update({ parse_status: "parsing" })
    .eq("id", reportId);

  // Log who kicked this off — the actor_id stays with the user even though
  // the actual DB writes below will have null auth.uid()
  await admin.from("audit_log").insert({
    actor_id: user.id,
    action: "PARSE_TRIGGERED",
    target_table: "reports",
    target_id: reportId,
    metadata: { patient_id: accessCheck.patient_id },
  });

  try {
    // ---- Download the PDF from Storage ------------------------------------
    const { data: pdfBlob, error: dlError } = await admin.storage
      .from("reports")
      .download(accessCheck.storage_path);
    if (dlError || !pdfBlob) throw new Error(`Download failed: ${dlError?.message}`);

    const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
    const pdfBase64 = pdfBuffer.toString("base64");

    // ---- Call Claude with tool-use for structured output -----------------
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "record_biomarkers" },
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64,
            },
          },
          {
            type: "text",
            text: "Extract every biomarker result from this pathology report. " +
                  "Use the exact marker names and units from the report. " +
                  "For the `flagged` field, use 'high' if the report flags the value H or above the reference range, " +
                  "'low' if flagged L or below range, otherwise 'normal'. " +
                  "If a reference bound is missing, use null.",
          },
        ],
      }],
    });

    // Extract the tool_use block — the structured data
    const toolUse = response.content.find(b => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Model did not return structured output");
    }

    const parsed = toolUse.input as {
      taken_at: string;
      biomarkers: Array<{
        marker: string; value: number; unit: string;
        ref_low: number | null; ref_high: number | null;
        flagged: "low" | "normal" | "high";
      }>;
    };

    if (!parsed.biomarkers?.length) {
      throw new Error("No biomarkers extracted from PDF");
    }

    // ---- Insert biomarkers --------------------------------------------------
    const rows = parsed.biomarkers.map(b => ({
      patient_id: accessCheck.patient_id,
      report_id:  reportId,
      marker:     b.marker,
      value:      b.value,
      unit:       b.unit,
      ref_low:    b.ref_low,
      ref_high:   b.ref_high,
      flagged:    b.flagged,
      taken_at:   parsed.taken_at,
    }));

    const { error: insertError } = await admin.from("biomarkers").insert(rows);
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

    await admin
      .from("reports")
      .update({ parse_status: "done" })
      .eq("id", reportId);

    return NextResponse.json({ ok: true, count: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse failed";
    await admin
      .from("reports")
      .update({ parse_status: "failed", parse_error: message })
      .eq("id", reportId);

    // Never return the raw error to the client — it could leak internals.
    console.error("Parse failed:", err);
    return NextResponse.json({ error: "Parse failed" }, { status: 500 });
  }
}
