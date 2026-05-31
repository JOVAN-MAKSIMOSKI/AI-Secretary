import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  createInvoiceDocument,
  getClientsByTenant,
  uploadDocumentTemplate,
} from "../../connection/supabase-client";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";

const TEMPLATE_TYPES = ["invoice", "offer"] as const;
const TEMPLATE_EXTENSIONS = ["xlsx", "docx"] as const;
const FILE_ACCEPT_BY_EXTENSION: Record<(typeof TEMPLATE_EXTENSIONS)[number], string> = {
  xlsx: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const INVOICE_TYPES = ["goods", "transport"] as const;
const INVOICE_NUMBER_PATTERN = /^\d+\/\d+$/;

type ClientOption = {
  id: string;
  name: string;
  tax_number: string | null;
};

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function parseOptionalNonNegativeInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return NaN;
  }

  return parsed;
}

function fileMatchesExtension(file: File, extension: (typeof TEMPLATE_EXTENSIONS)[number]) {
  return file.name.toLowerCase().endsWith(`.${extension}`);
}

export default function Documents() {
  const tenantId = useSessionStore((state) => state.tenantId);
  const userEmail = useAppContextStore((state) => state.userEmail);
  const [name, setName] = useState("Invoice template");
  const [docType, setDocType] = useState<(typeof TEMPLATE_TYPES)[number]>("invoice");
  const [extension, setExtension] = useState<(typeof TEMPLATE_EXTENSIONS)[number]>("xlsx");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [loadingClients, setLoadingClients] = useState(false);
  const [invoiceClientId, setInvoiceClientId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceType, setInvoiceType] = useState<(typeof INVOICE_TYPES)[number]>("goods");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [valueDate, setValueDate] = useState("");
  const [consignmentNoteNumber, setConsignmentNoteNumber] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [invoiceClientName, setInvoiceClientName] = useState("");
  const [invoiceClientTaxNumber, setInvoiceClientTaxNumber] = useState("");
  const [description, setDescription] = useState("");
  const [units, setUnits] = useState("");
  const [pricePerUnit, setPricePerUnit] = useState("");
  const [taxPercentage, setTaxPercentage] = useState("");
  const [priceBeforeTax, setPriceBeforeTax] = useState("");
  const [priceAfterTax, setPriceAfterTax] = useState("");
  const [priceAfterTaxText, setPriceAfterTaxText] = useState("");
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceError, setInvoiceError] = useState("");
  const [invoiceSuccess, setInvoiceSuccess] = useState("");

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === invoiceClientId) ?? null,
    [clients, invoiceClientId]
  );

  useEffect(() => {
    if (!tenantId) {
      setClients([]);
      return;
    }

    let isMounted = true;
    const loadClients = async () => {
      setLoadingClients(true);
      try {
        const data = await getClientsByTenant({ forceRefresh: true });
        if (isMounted) {
          setClients(
            data.map((client) => ({
              id: client.id,
              name: client.name,
              tax_number: client.tax_number,
            }))
          );
        }
      } catch {
        if (isMounted) {
          setClients([]);
        }
      } finally {
        if (isMounted) {
          setLoadingClients(false);
        }
      }
    };

    void loadClients();

    return () => {
      isMounted = false;
    };
  }, [tenantId]);

  useEffect(() => {
    if (!selectedClient) {
      setInvoiceClientName("");
      setInvoiceClientTaxNumber("");
      return;
    }

    setInvoiceClientName(selectedClient.name);
    setInvoiceClientTaxNumber(selectedClient.tax_number ?? "");
  }, [selectedClient]);

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

  const handleInvoiceSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInvoiceError("");
    setInvoiceSuccess("");

    if (!tenantId) {
      setInvoiceError("Tenant id is still loading. Please wait a moment and try again.");
      return;
    }

    if (!selectedClient) {
      setInvoiceError("Please select a client first.");
      return;
    }

    if (!invoiceClientTaxNumber.trim()) {
      setInvoiceError("Selected client is missing a tax number. Update the client profile first.");
      return;
    }

    if (!INVOICE_NUMBER_PATTERN.test(invoiceNumber.trim())) {
      setInvoiceError("Invoice number must be in digits/digits format, for example 12/2026.");
      return;
    }

    const parsedConsignment = parseOptionalNonNegativeInteger(consignmentNoteNumber);
    const parsedOrder = parseOptionalNonNegativeInteger(orderNumber);
    if (Number.isNaN(parsedConsignment) || Number.isNaN(parsedOrder)) {
      setInvoiceError("Consignment note and order numbers must be non-negative integers.");
      return;
    }

    if (parsedConsignment === null && parsedOrder === null) {
      setInvoiceError("Enter either consignment note number, order number, or both.");
      return;
    }

    const parsedUnits = Number(units);
    const parsedPricePerUnit = Number(pricePerUnit);
    const parsedTaxPercentage = Number(taxPercentage);
    const parsedPriceBeforeTax = Number(priceBeforeTax);
    const parsedPriceAfterTax = Number(priceAfterTax);

    if (!Number.isFinite(parsedUnits) || parsedUnits < 0 || !Number.isInteger(parsedUnits)) {
      setInvoiceError("Number of units must be a non-negative integer.");
      return;
    }

    if (!Number.isFinite(parsedPricePerUnit) || parsedPricePerUnit < 0) {
      setInvoiceError("Price per unit must be a non-negative number.");
      return;
    }

    if (!Number.isFinite(parsedTaxPercentage) || parsedTaxPercentage < 0 || parsedTaxPercentage > 100) {
      setInvoiceError("Tax percentage must be between 0 and 100.");
      return;
    }

    if (!Number.isFinite(parsedPriceBeforeTax) || parsedPriceBeforeTax < 0) {
      setInvoiceError("Price before tax must be a non-negative number.");
      return;
    }

    if (!Number.isFinite(parsedPriceAfterTax) || parsedPriceAfterTax < 0) {
      setInvoiceError("Price after tax must be a non-negative number.");
      return;
    }

    if (!priceAfterTaxText.trim()) {
      setInvoiceError("Price after tax text is required.");
      return;
    }

    setInvoiceLoading(true);
    try {
      const result = await createInvoiceDocument({
        client_id: selectedClient.id,
        invoice_number: invoiceNumber.trim(),
        invoice_type: invoiceType,
        invoice_date: invoiceDate,
        value_date: valueDate,
        consignment_note_number: parsedConsignment,
        order_number: parsedOrder,
        client_name: invoiceClientName.trim(),
        client_tax_number: invoiceClientTaxNumber.trim(),
        description: description.trim(),
        units: parsedUnits,
        price_per_unit: parsedPricePerUnit,
        tax_percentage: parsedTaxPercentage,
        price_before_tax: parsedPriceBeforeTax,
        price_after_tax: parsedPriceAfterTax,
        price_after_tax_text: priceAfterTaxText.trim(),
      });

      triggerBrowserDownload(result.blob, result.filename);
      setInvoiceSuccess(`Invoice validated and downloaded as ${result.filename}.`);
    } catch (submitError) {
      setInvoiceError((submitError as Error).message);
    } finally {
      setInvoiceLoading(false);
    }
  };

  return (
    <section className="min-h-full bg-[var(--brand-surface)] px-4 py-6 text-[var(--brand-ink)] md:px-6">
      <div className="mx-auto grid w-full max-w-4xl gap-6">
        <header className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-6 shadow-sm shadow-slate-200/40">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--brand-text-muted)]">Documents</p>
          <h1 className="mt-2 text-[28px] font-medium tracking-[-0.02em] text-[var(--brand-ink)]">Upload a stored template</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--brand-text-muted)]">
            This form posts directly to the existing FastAPI template route. The file is stored in Supabase Storage,
            and the Python service handles the insert and upload flow already.
          </p>
          <div className="mt-4 text-[11px] uppercase tracking-[0.16em] text-[var(--brand-text-muted)]">
            Session tenant: <span className="font-mono text-[var(--brand-ink)]">{tenantId ?? "Loading..."}</span>
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-[var(--brand-text-muted)]">
            User: <span className="font-mono text-[var(--brand-ink)]">{userEmail ?? "Unknown"}</span>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
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
                  onChange={(event) => setDocType(event.target.value as (typeof TEMPLATE_TYPES)[number])}
                  className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                >
                  {TEMPLATE_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {option}
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
                    <option key={option} value={option}>
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
            <h2 className="mt-2 text-xl font-medium">FastAPI template upload</h2>
            <div className="mt-5 space-y-3 text-sm leading-6 text-[var(--brand-text-muted)]">
              <p>Fields sent as multipart form data:</p>
              <ul className="space-y-2 text-[var(--brand-text-muted)]">
                <li><span className="font-mono text-[var(--brand-ink)]">name</span> for the template display label.</li>
                <li><span className="font-mono text-[var(--brand-ink)]">doc_type</span> set to invoice or offer.</li>
                <li><span className="font-mono text-[var(--brand-ink)]">extension</span> set to xlsx or docx.</li>
                <li><span className="font-mono text-[var(--brand-ink)]">file</span> as the selected template bytes.</li>
              </ul>
              <p>Tenant context is derived from the authenticated bearer token.</p>
            </div>
          </aside>
        </div>

        <form
          onSubmit={handleInvoiceSubmit}
          className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-6 shadow-sm shadow-slate-200/50"
        >
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--brand-text-muted)]">Invoice generation</p>
          <h2 className="mt-2 text-2xl font-medium tracking-[-0.01em] text-[var(--brand-ink)]">Validate invoice fields before download</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--brand-text-muted)]">
            This form enforces invoice requirements in the UI and sends the same payload to the FastAPI validator.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Client</span>
              <select
                value={invoiceClientId}
                onChange={(event) => setInvoiceClientId(event.target.value)}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              >
                <option value="">{loadingClients ? "Loading clients..." : "Select client"}</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Invoice number</span>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                placeholder="12/2026"
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Type</span>
              <select
                value={invoiceType}
                onChange={(event) => setInvoiceType(event.target.value as (typeof INVOICE_TYPES)[number])}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
              >
                {INVOICE_TYPES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Description</span>
              <input
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Invoice date</span>
              <input
                type="date"
                value={invoiceDate}
                onChange={(event) => setInvoiceDate(event.target.value)}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Date of valute</span>
              <input
                type="date"
                value={valueDate}
                onChange={(event) => setValueDate(event.target.value)}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Consignment note number optional</span>
              <input
                type="number"
                value={consignmentNoteNumber}
                onChange={(event) => setConsignmentNoteNumber(event.target.value)}
                min={0}
                step={1}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Order number optional</span>
              <input
                type="number"
                value={orderNumber}
                onChange={(event) => setOrderNumber(event.target.value)}
                min={0}
                step={1}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Client name</span>
              <input
                type="text"
                value={invoiceClientName}
                onChange={(event) => setInvoiceClientName(event.target.value)}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none"
                readOnly
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Client tax number</span>
              <input
                type="text"
                value={invoiceClientTaxNumber}
                onChange={(event) => setInvoiceClientTaxNumber(event.target.value)}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none"
                readOnly
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Units</span>
              <input
                type="number"
                value={units}
                onChange={(event) => setUnits(event.target.value)}
                min={0}
                step={1}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Price per unit</span>
              <input
                type="number"
                value={pricePerUnit}
                onChange={(event) => setPricePerUnit(event.target.value)}
                min={0}
                step="0.01"
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Tax percentage</span>
              <input
                type="number"
                value={taxPercentage}
                onChange={(event) => setTaxPercentage(event.target.value)}
                min={0}
                max={100}
                step="0.01"
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Price before tax</span>
              <input
                type="number"
                value={priceBeforeTax}
                onChange={(event) => setPriceBeforeTax(event.target.value)}
                min={0}
                step="0.01"
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Price after tax</span>
              <input
                type="number"
                value={priceAfterTax}
                onChange={(event) => setPriceAfterTax(event.target.value)}
                min={0}
                step="0.01"
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>

            <label className="grid gap-2 md:col-span-2">
              <span className="text-sm font-medium text-[var(--brand-ink)]">Price after tax (text)</span>
              <input
                type="text"
                value={priceAfterTaxText}
                onChange={(event) => setPriceAfterTaxText(event.target.value)}
                placeholder="One thousand two hundred euros and fifty cents"
                maxLength={255}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={invoiceLoading || !tenantId || loadingClients}
              className="inline-flex h-11 items-center justify-center rounded-full bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {invoiceLoading ? "Validating..." : "Validate and download invoice template"}
            </button>
            <p className="text-xs text-[var(--brand-text-muted)]">
              Requires invoice number with slash and either consignment or order number.
            </p>
          </div>

          {invoiceError ? (
            <div className="mt-5 rounded-lg border border-[#f7cccc] bg-[var(--brand-danger-bg)] px-4 py-3 text-sm text-[var(--brand-danger-text)]">
              {invoiceError}
            </div>
          ) : null}

          {invoiceSuccess ? (
            <div className="mt-5 rounded-lg border border-[#cdeade] bg-[var(--brand-teal-soft)] px-4 py-3 text-sm text-[#1a6b5a]">
              {invoiceSuccess}
            </div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
