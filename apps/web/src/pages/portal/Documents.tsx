import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  createInvoiceDocument,
  getFirmsByTenant,
} from "../../connection/supabase-client";
import { useSessionStore } from "../../store/session";

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

export default function Documents() {
  const tenantId = useSessionStore((state) => state.tenantId);
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
        const data = await getFirmsByTenant({ forceRefresh: true });
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

  const handleInvoiceSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInvoiceError("");
    setInvoiceSuccess("");

    if (!tenantId) {
      setInvoiceError("Tenant id is still loading. Please wait a moment and try again.");
      return;
    }

    if (!selectedClient) {
      setInvoiceError("Please select a firm first.");
      return;
    }

    if (!invoiceClientTaxNumber.trim()) {
      setInvoiceError("Selected firm is missing a tax number. Update the firm profile first.");
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

    setInvoiceLoading(true);
    try {
      const result = await createInvoiceDocument({
        firm_id: selectedClient.id,
        invoice_number: invoiceNumber.trim(),
        invoice_type: invoiceType,
        invoice_date: invoiceDate,
        value_date: valueDate,
        consignment_note_number: parsedConsignment,
        order_number: parsedOrder,
        firm_name: invoiceClientName.trim(),
        firm_tax_number: invoiceClientTaxNumber.trim(),
        description: description.trim(),
        units: parsedUnits,
        price_per_unit: parsedPricePerUnit,
        tax_percentage: parsedTaxPercentage,
        price_before_tax: parsedPriceBeforeTax,
        price_after_tax: parsedPriceAfterTax,
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
              <span className="text-sm font-medium text-[var(--brand-ink)]">Firm</span>
              <select
                value={invoiceClientId}
                onChange={(event) => setInvoiceClientId(event.target.value)}
                className="h-11 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)]"
                required
              >
                <option value="">{loadingClients ? "Loading firms..." : "Select firm"}</option>
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
              <span className="text-sm font-medium text-[var(--brand-ink)]">Firm name</span>
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
              <span className="text-sm font-medium text-[var(--brand-ink)]">Firm tax number</span>
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
