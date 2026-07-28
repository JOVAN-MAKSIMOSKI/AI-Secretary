import { FormEvent, useState } from "react";
import { uploadDocumentTemplate } from "../../connection/supabase-client";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";

const TEMPLATE_TYPES = ["invoice", "offer", "transport_form", "identification_form"] as const;
const TEMPLATE_EXTENSIONS = ["xlsx", "docx"] as const;
// Both waste forms are authored in Word and rendered by the run-level docx renderer, so
// the extension is locked to docx when either is selected. Mirrors docx_only_doc_types
// in apps/python/routers/documents.py — a mismatch here only produces a 400 there.
const DOCX_ONLY_TEMPLATE_TYPES: ReadonlySet<(typeof TEMPLATE_TYPES)[number]> = new Set([
  "transport_form",
  "identification_form",
]);
const TEMPLATE_TYPE_LABELS: Record<(typeof TEMPLATE_TYPES)[number], string> = {
  invoice: "invoice",
  offer: "offer",
  transport_form: "transport form",
  identification_form: "identification form",
};
const FILE_ACCEPT_BY_EXTENSION: Record<(typeof TEMPLATE_EXTENSIONS)[number], string> = {
  xlsx: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function fileMatchesExtension(file: File, extension: (typeof TEMPLATE_EXTENSIONS)[number]) {
  return file.name.toLowerCase().endsWith(`.${extension}`);
}

export default function DocumentTemplateSection() {
  const tenantId = useSessionStore((state) => state.tenantId);
  const userEmail = useAppContextStore((state) => state.userEmail);
  const [name, setName] = useState("Invoice template");
  const [docType, setDocType] = useState<(typeof TEMPLATE_TYPES)[number]>("invoice");
  const [extension, setExtension] = useState<(typeof TEMPLATE_EXTENSIONS)[number]>("xlsx");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!tenantId) {
      setError("Tenant id is still loading. Please wait a moment and try again.");
      return;
    }

    if (!file) {
      setError("Please choose a template file to upload.");
      return;
    }

    if (!fileMatchesExtension(file, extension)) {
      setError(`Selected file must match the chosen .${extension} extension.`);
      return;
    }

    setLoading(true);
    try {
      const result = await uploadDocumentTemplate({
        name,
        docType,
        extension,
        file,
      });

      setSuccess(`Uploaded ${result.title} successfully. Storage path: ${result.storage_path}`);
      setFile(null);
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-text-muted)]">Documents</p>
      <h2 className="mt-3 text-2xl font-semibold text-[var(--brand-ink)]">Upload a stored template</h2>
      <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-[var(--brand-text-muted)]">
        User: <span className="font-mono text-[var(--brand-ink)]">{userEmail ?? "Unknown"}</span>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-6 shadow-sm shadow-slate-200/50"
        >
          <div className="grid gap-5 md:grid-cols-2">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Template name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                placeholder="Invoice template"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Template type</span>
              <select
                value={docType}
                onChange={(event) => {
                  const nextDocType = event.target.value as (typeof TEMPLATE_TYPES)[number];
                  setDocType(nextDocType);
                  setError("");

                  // Waste forms are docx-only: force the extension and drop any
                  // now-invalid (e.g. .xlsx) file the user had already chosen.
                  if (DOCX_ONLY_TEMPLATE_TYPES.has(nextDocType) && extension !== "docx") {
                    setExtension("docx");
                    if (file && !fileMatchesExtension(file, "docx")) {
                      setFile(null);
                    }
                  }
                }}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
              >
                {TEMPLATE_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {TEMPLATE_TYPE_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Extension</span>
              <select
                value={extension}
                onChange={(event) => {
                  const nextExtension = event.target.value as (typeof TEMPLATE_EXTENSIONS)[number];
                  setExtension(nextExtension);
                  setError("");

                  if (file && !fileMatchesExtension(file, nextExtension)) {
                    setFile(null);
                    setError(`File selection was cleared. Choose a .${nextExtension} template file.`);
                  }
                }}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
              >
                {TEMPLATE_EXTENSIONS.map((option) => (
                  <option
                    key={option}
                    value={option}
                    disabled={option !== "docx" && DOCX_ONLY_TEMPLATE_TYPES.has(docType)}
                  >
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Template file</span>
              <input
                type="file"
                accept={FILE_ACCEPT_BY_EXTENSION[extension]}
                onChange={(event) => {
                  const selectedFile = event.target.files?.[0] ?? null;
                  setError("");

                  if (!selectedFile) {
                    setFile(null);
                    return;
                  }

                  if (!fileMatchesExtension(selectedFile, extension)) {
                    setFile(null);
                    setError(`Selected file must be a .${extension} template.`);
                    return;
                  }

                  setFile(selectedFile);
                }}
                className="block w-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 py-2 text-sm file:mr-4 file:rounded-md file:border-0 file:bg-[var(--brand-teal)] file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-[#2f8575]"
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={loading || !tenantId}
              className="inline-flex h-11 items-center justify-center rounded-full bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Uploading..." : "Upload template"}
            </button>
            <p className="text-xs text-[var(--brand-text-muted)]">
              Uses the existing FastAPI <span className="font-mono">POST /documents/template</span> route.
            </p>
          </div>

          {error ? (
            <div className="mt-5 rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
              {error}
            </div>
          ) : null}

          {success ? (
            <div className="mt-5 rounded-lg border border-[#cdeade] bg-[var(--brand-teal-soft)] px-4 py-3 text-sm text-[#1a6b5a]">
              {success}
            </div>
          ) : null}
        </form>

        <aside className="rounded-xl border border-[var(--brand-border)] bg-[#f9fbfc] p-6 text-[var(--brand-ink)] shadow-sm shadow-slate-200/40">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--brand-text-muted)]">Route contract</p>
          <h3 className="mt-2 text-xl font-medium">FastAPI template upload</h3>
          <div className="mt-5 space-y-3 text-sm leading-6 text-[var(--brand-text-muted)]">
            <p>Fields sent as multipart form data:</p>
            <ul className="space-y-2 text-[var(--brand-text-muted)]">
              <li><span className="font-mono text-[var(--brand-ink)]">name</span> for the template display label.</li>
              <li><span className="font-mono text-[var(--brand-ink)]">doc_type</span> set to invoice, offer, transport_form, or identification_form.</li>
              <li><span className="font-mono text-[var(--brand-ink)]">extension</span> set to xlsx or docx.</li>
              <li><span className="font-mono text-[var(--brand-ink)]">file</span> as the selected template bytes.</li>
            </ul>
            <p>Tenant context is derived from the authenticated bearer token.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
