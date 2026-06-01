import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  createInvoiceDocument,
  extractDashboardMessage,
  type ExtractedInvoiceFromMessage,
  type InvoiceDocumentRequest,
} from "../../connection/supabase-client";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  downloadUrl?: string;
  downloadLabel?: string;
};

const CHAT_STORAGE_PREFIX = "dashboard-chat-v1";

function getChatStorageKey(tenantId: string | null) {
  return `${CHAT_STORAGE_PREFIX}:${tenantId ?? "anonymous"}`;
}

function formatDateIso(dateValue: string): string {
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function hasUsableExtractionValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}

function parseNumberish(rawValue: unknown): number | null {
  if (typeof rawValue === "number") {
    return Number.isFinite(rawValue) ? rawValue : null;
  }

  if (typeof rawValue !== "string") {
    return null;
  }

  return parseLocaleFlexibleNumber(rawValue);
}

function parseIntegerish(rawValue: unknown): number | null {
  const parsed = parseNumberish(rawValue);
  if (parsed === null) {
    return null;
  }

  if (!Number.isInteger(parsed)) {
    return null;
  }

  return parsed;
}

function normalizeOptionalText(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const normalized = rawValue.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  const emptyLike = new Set([
    "n/a",
    "na",
    "none",
    "null",
    "not provided",
    "not available",
    "unknown",
    "undefined",
    "missing",
    "-",
  ]);

  if (emptyLike.has(lowered)) {
    return null;
  }

  return normalized;
}

function mergeExtractedInvoiceDraft(
  previous: ExtractedInvoiceFromMessage | null,
  incoming: ExtractedInvoiceFromMessage
): ExtractedInvoiceFromMessage {
  if (!previous) {
    return { ...incoming };
  }

  const merged: ExtractedInvoiceFromMessage = { ...previous };

  for (const [key, value] of Object.entries(incoming)) {
    if (!hasUsableExtractionValue(value)) {
      continue;
    }

    if (key === "business" && typeof value === "object" && value !== null) {
      merged.business = {
        ...(previous.business ?? {}),
        ...(value as ExtractedInvoiceFromMessage["business"]),
      };
      continue;
    }

    (merged as Record<string, unknown>)[key] = value;
  }

  return merged;
}

function parseLocaleFlexibleNumber(rawNumber: string): number | null {
  const token = rawNumber.trim().replace(/\s+/g, "");
  if (!/^[+-]?\d[\d.,]*$/.test(token)) {
    return null;
  }

  const commaCount = (token.match(/,/g) ?? []).length;
  const dotCount = (token.match(/\./g) ?? []).length;

  let normalized = token;

  if (commaCount > 0 && dotCount > 0) {
    if (token.lastIndexOf(",") > token.lastIndexOf(".")) {
      normalized = token.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = token.replace(/,/g, "");
    }
  } else if (commaCount > 0) {
    const lastCommaIndex = token.lastIndexOf(",");
    const decimalDigits = token.length - lastCommaIndex - 1;
    normalized = commaCount === 1 && decimalDigits <= 2 ? token.replace(",", ".") : token.replace(/,/g, "");
  } else if (dotCount > 0) {
    const lastDotIndex = token.lastIndexOf(".");
    const decimalDigits = token.length - lastDotIndex - 1;
    normalized = dotCount === 1 && decimalDigits <= 2 ? token : token.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function applySingleNumberFollowUp(
  merged: ExtractedInvoiceFromMessage,
  incoming: ExtractedInvoiceFromMessage,
  rawMessage: string
): ExtractedInvoiceFromMessage {
  if (typeof incoming.units === "number" || typeof incoming.price_per_unit === "number") {
    return merged;
  }

  const matches = rawMessage.match(/[+-]?\d[\d.,]*/g);
  if (!matches || matches.length !== 1) {
    return merged;
  }

  const parsedValue = parseLocaleFlexibleNumber(matches[0]);
  if (parsedValue === null) {
    return merged;
  }

  const hasUnits = typeof merged.units === "number";
  const hasPricePerUnit = typeof merged.price_per_unit === "number";

  if (hasUnits && !hasPricePerUnit) {
    return {
      ...merged,
      price_per_unit: parsedValue,
    };
  }

  if (!hasUnits && hasPricePerUnit && Number.isInteger(parsedValue) && parsedValue >= 0) {
    return {
      ...merged,
      units: parsedValue,
    };
  }

  return merged;
}

function buildInvoicePayloadFromExtraction(
  extracted: ExtractedInvoiceFromMessage
): { payload?: InvoiceDocumentRequest; error?: string } {
  const clientName = normalizeOptionalText(extracted.client_name);
  const clientTaxNumber = normalizeOptionalText(extracted.client_tax_number);
  const description = normalizeOptionalText(extracted.description) ?? "Invoice items";
  const units = parseIntegerish(extracted.units);
  const pricePerUnit = parseNumberish(extracted.price_per_unit);
  const taxPercentage = parseNumberish(extracted.tax_percentage);
  const priceBeforeTax = parseNumberish(extracted.price_before_tax);
  const priceAfterTax = parseNumberish(extracted.price_after_tax);
  const orderNumber = parseIntegerish(extracted.order_number) ?? null;
  const consignmentNoteNumber = parseIntegerish(extracted.consignment_note_number) ?? null;

  if (!extracted.client_id) {
    return { error: "I found invoice values, but I could not resolve a client_id from client_name." };
  }
  if (!clientName) {
    return { error: "Missing client_name in extracted data." };
  }
  if (!clientTaxNumber) {
    return { error: "Missing client_tax_number in extracted data." };
  }

  if (units === null || pricePerUnit === null) {
    return { error: "Missing units or price_per_unit, so I cannot generate the invoice." };
  }

  if (taxPercentage === null || priceBeforeTax === null || priceAfterTax === null) {
    return { error: "Missing calculated tax/price fields, so I cannot generate the invoice yet." };
  }

  if (orderNumber === null && consignmentNoteNumber === null) {
    return { error: "Please include an order number or consignment note number in your message." };
  }

  const invoiceYear = extracted.invoice_year ?? new Date().getUTCFullYear();
  const invoiceCounter = extracted.business?.invoice_counter;
  if (typeof invoiceCounter !== "number") {
    return { error: "Missing business.invoice_counter, so invoice_number cannot be generated." };
  }
  const nextInvoiceCounter = String(invoiceCounter + 1).padStart(3, "0");

  const payload: InvoiceDocumentRequest = {
    client_id: extracted.client_id,
    invoice_number: `${nextInvoiceCounter}/${invoiceYear}`,
    invoice_type: extracted.invoice_type ?? "goods",
    invoice_date: new Date().toISOString().slice(0, 10),
    value_date: extracted.value_date ? formatDateIso(extracted.value_date) : new Date().toISOString().slice(0, 10),
    consignment_note_number: consignmentNoteNumber,
    order_number: orderNumber,
    client_name: clientName,
    client_tax_number: clientTaxNumber,
    description,
    units,
    price_per_unit: pricePerUnit,
    tax_percentage: taxPercentage,
    price_before_tax: priceBeforeTax,
    price_after_tax: priceAfterTax,
  };

  return { payload };
}


export default function PortalDashboard() {
  const tenantId = useSessionStore((state) => state.tenantId);
  const userEmail = useAppContextStore((state) => state.userEmail);
  const tenantIdentifier = tenantId;
  const chatStorageKey = useMemo(() => getChatStorageKey(tenantIdentifier), [tenantIdentifier]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [invoiceDraft, setInvoiceDraft] = useState<ExtractedInvoiceFromMessage | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(chatStorageKey);
      if (!raw) {
        setMessages([]);
        return;
      }

      const parsed = JSON.parse(raw) as ChatMessage[];
      if (Array.isArray(parsed)) {
        setMessages(parsed);
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    }
  }, [chatStorageKey]);

  useEffect(() => {
    window.localStorage.setItem(chatStorageKey, JSON.stringify(messages));
  }, [chatStorageKey, messages]);

  useEffect(() => {
    return () => {
      for (const message of messages) {
        if (message.downloadUrl) {
          URL.revokeObjectURL(message.downloadUrl);
        }
      }
    };
  }, [messages]);

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = input;
    if (!content.trim() || isLoading) {
      return;
    }

    const newMessage: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => [...current, newMessage]);
    setInput("");
    setIsLoading(true);
    setError(null);

    try {
      const extracted = await extractDashboardMessage(content);
      const mergedDraft = mergeExtractedInvoiceDraft(invoiceDraft, extracted);
      const enrichedDraft = applySingleNumberFollowUp(mergedDraft, extracted, content);
      setInvoiceDraft(enrichedDraft);

      const { payload, error: payloadError } = buildInvoicePayloadFromExtraction(enrichedDraft);

      if (!payload) {
        const assistantMessage: ChatMessage = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: payloadError ?? "I extracted values but could not generate the invoice yet.",
          createdAt: new Date().toISOString(),
        };
        setMessages((current) => [...current, assistantMessage]);
      } else {
        const result = await createInvoiceDocument(payload);
        const downloadUrl = URL.createObjectURL(result.blob);
        setInvoiceDraft(null);

        const assistantMessage: ChatMessage = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: "Invoice is ready. Use the link below to download it.",
          createdAt: new Date().toISOString(),
          downloadUrl,
          downloadLabel: result.filename,
        };
        setMessages((current) => [...current, assistantMessage]);
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to run extraction chain.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const clearChat = () => {
    setMessages([]);
    setInvoiceDraft(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--brand-surface)]">
      <section className="min-h-[180px] border-b border-[var(--brand-border)] px-5 py-4 md:min-h-[220px]">
        <div className="mx-auto h-full max-w-6xl">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-medium text-[var(--brand-ink)]">Metrics</h2>
              <p className="mt-1 text-xs text-[var(--brand-text-muted)]">Reserved top section for dashboard KPI widgets.</p>
            </div>
            <p className="text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>
          </div>
          <div className="grid h-[calc(100%-2.25rem)] grid-cols-1 gap-3 md:grid-cols-3">
            <div className="grid place-items-center rounded-lg border border-dashed border-[var(--brand-border)] bg-[var(--brand-card)]/90 p-4 text-xs text-[var(--brand-text-muted)]">Metric card area</div>
            <div className="grid place-items-center rounded-lg border border-dashed border-[var(--brand-border)] bg-[var(--brand-card)]/90 p-4 text-xs text-[var(--brand-text-muted)]">Metric card area</div>
            <div className="grid place-items-center rounded-lg border border-dashed border-[var(--brand-border)] bg-[var(--brand-card)]/90 p-4 text-xs text-[var(--brand-text-muted)]">Metric card area</div>
          </div>
        </div>
      </section>

      <section className="min-h-0 flex-1 border-t border-[var(--brand-border)] px-3 pb-3 pt-3 md:px-4 md:pb-4">
        <div className="flex h-full min-h-0 w-full flex-col rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)]">
          <div className="border-b border-[var(--brand-border)] px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-[var(--brand-ink)]">Assistant Chat</h2>
                <p className="mt-1 text-xs text-[var(--brand-text-muted)]">Sends your raw message to the LangChain extraction chain.</p>
              </div>
              <button
                type="button"
                onClick={clearChat}
                className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-3 py-1.5 text-xs font-medium text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
              >
                Clear chat
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 && !isLoading ? (
              <div className="grid h-full place-items-center">
                <div className="max-w-md text-center">
                  <h3 className="text-xl font-medium tracking-[-0.01em] text-[var(--brand-ink)]">How can I help you today?</h3>
                  <p className="mt-2 text-sm text-[var(--brand-text-muted)]">Write invoice details in plain text and the extraction chain will return structured output.</p>
                </div>
              </div>
            ) : (
              <div className="space-y-6 py-2">
                {messages.map((message) => (
                  <div key={message.id} className="w-full">
                    <div
                      className={
                        message.role === "user"
                          ? "ml-auto w-fit max-w-[80%] rounded-2xl bg-[var(--brand-teal-soft)] px-4 py-3 text-sm leading-6 text-[var(--brand-ink)]"
                          : "mr-auto max-w-[90%] rounded-xl bg-[var(--brand-card)] px-3 py-2 text-sm leading-7 text-[var(--brand-ink)]"
                      }
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                      {message.downloadUrl ? (
                        <a
                          href={message.downloadUrl}
                          download={message.downloadLabel ?? "invoice.xlsx"}
                          className="mt-2 inline-block rounded-md border border-[var(--brand-teal)] px-3 py-1 text-xs font-medium text-[var(--brand-teal)] hover:bg-[var(--brand-teal-soft)]"
                        >
                          Download {message.downloadLabel ?? "invoice.xlsx"}
                        </a>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[10px] text-[var(--brand-text-muted)]">
                      {message.role === "user" ? "You" : "Assistant"} · {new Date(message.createdAt).toLocaleTimeString()}
                    </p>
                  </div>
                ))}

                {isLoading && (
                  <div className="w-full">
                    <div className="mr-auto max-w-[90%] rounded-xl bg-[var(--brand-card)] px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-teal)] [animation-delay:-0.3s]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-teal)] [animation-delay:-0.15s]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-teal)]" />
                      </div>
                    </div>
                  </div>
                )}

                {error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                )}
              </div>
            )}
          </div>

          <form onSubmit={handleSend} className="border-t border-[var(--brand-border)] p-3">
            <div className="rounded-[1.25rem] border border-[var(--brand-border)] bg-[var(--brand-card)] p-2 shadow-sm shadow-slate-100/70">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleInputKeyDown}
                rows={3}
                maxLength={4000}
                disabled={isLoading}
                placeholder="Message dashboard assistant"
                className="w-full resize-none bg-transparent px-3 py-2 text-sm text-[var(--brand-ink)] outline-none disabled:opacity-50"
              />

              <div className="flex items-center justify-end border-t border-[var(--brand-border)] pt-2">
              
                <button
                  type="submit"
                  disabled={isLoading}
                  className="inline-flex h-9 items-center justify-center rounded-full bg-[var(--brand-teal)] px-4 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isLoading ? "Extracting..." : "Send"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
