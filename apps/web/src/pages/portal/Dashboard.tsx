import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  confirmCallIdentificationFormsDownloaded,
  confirmCallInvoicesDownloaded,
  confirmCallTransportFormsDownloaded,
  createIdentificationFormDocument,
  createTransportFormDocument,
  createInvoiceDocument,
  downloadCallIdentificationFormsZip,
  downloadCallInvoicesZip,
  downloadCallTransportFormsZip,
  extractDashboardMessage,
  getCachedTasks,
  getGmailInboxStats,
  getPendingCallIdentificationForms,
  getPendingCallInvoices,
  getPendingCallTransportForms,
  listCalendarEvents,
  listTasks,
  type CalendarEventResponse,
  type DashboardResolveAndRunResponse,
  type ExtractedInvoiceFromMessage,
  type IdentificationFormDocumentRequest,
  type TransportFormDocumentRequest,
  type InvoiceDocumentRequest,
  type PendingIdentificationForm,
  type PendingInvoice,
  type PendingTransportForm,
} from "../../connection/supabase-client";
import { useAppContextStore } from "../../store/app-context";
import { useDashboardChat } from "../../hooks/useAgent";
import { useSTT } from "../../hooks/useSTT";

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
  const clientName = normalizeOptionalText(extracted.firm_name);
  const clientTaxNumber = normalizeOptionalText(extracted.firm_tax_number);
  const description = normalizeOptionalText(extracted.description) ?? "Invoice items";
  const units = parseIntegerish(extracted.units);
  const pricePerUnit = parseNumberish(extracted.price_per_unit);
  const taxPercentage = parseNumberish(extracted.tax_percentage);
  const priceBeforeTax = parseNumberish(extracted.price_before_tax);
  const priceAfterTax = parseNumberish(extracted.price_after_tax);
  const orderNumber = parseIntegerish(extracted.order_number) ?? null;
  const consignmentNoteNumber = parseIntegerish(extracted.consignment_note_number) ?? null;

  if (!extracted.firm_id) {
    return { error: "I found invoice values, but I could not resolve a firm_id from firm_name." };
  }
  if (!clientName) {
    return { error: "Missing firm_name in extracted data." };
  }
  if (!clientTaxNumber) {
    return { error: "Missing firm_tax_number in extracted data." };
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
    firm_id: extracted.firm_id,
    invoice_number: `${nextInvoiceCounter}/${invoiceYear}`,
    invoice_type: extracted.invoice_type ?? "goods",
    invoice_date: new Date().toISOString().slice(0, 10),
    value_date: extracted.value_date ? formatDateIso(extracted.value_date) : new Date().toISOString().slice(0, 10),
    consignment_note_number: consignmentNoteNumber,
    order_number: orderNumber,
    firm_name: clientName,
    firm_tax_number: clientTaxNumber,
    description,
    units,
    price_per_unit: pricePerUnit,
    tax_percentage: taxPercentage,
    price_before_tax: priceBeforeTax,
    price_after_tax: priceAfterTax,
  };

  return { payload };
}

// Maps the identification-form extraction output to the render-route payload. The extract
// step already resolves firm_id/contact_id and derives ewc_code/is_hazardous; this only
// checks those required fields survived (a firm or contact that didn't match by name is
// absent) and reshapes what's present. Returns an error listing the missing fields so the
// chat can say why it can't generate yet, rather than posting a payload the server rejects.
function buildIdentificationFormPayload(
  extracted: Record<string, unknown>
): { payload: IdentificationFormDocumentRequest | null; error: string | null } {
  const asString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const firmId = asString(extracted.firm_id);
  const contactId = asString(extracted.contact_id);
  const firmName = asString(extracted.firm_name);
  const wasteLocation = asString(extracted.waste_location);
  const wasteType = asString(extracted.waste_type);
  const ewcCode = asString(extracted.ewc_code);
  const packingMethod = asString(extracted.packing_method);
  const wasteOrigin = asString(extracted.waste_origin);
  const wasteOperationCode = asString(extracted.waste_operation_code);
  const place = asString(extracted.place);
  const date = asString(extracted.date);
  const totalWeightKg = asNumber(extracted.total_weight_kg);
  const isHazardous = typeof extracted.is_hazardous === "boolean" ? extracted.is_hazardous : undefined;

  // Human-readable names for the fields most likely to be missing, so the message is
  // actionable (e.g. an unmatched firm/contact name).
  const missing: string[] = [];
  if (!firmId || !firmName) missing.push("firm (name did not match a saved firm)");
  if (!contactId) missing.push("responsible person (name did not match a contact of that firm)");
  if (!wasteLocation) missing.push("waste location");
  if (!wasteType || !ewcCode || isHazardous === undefined) missing.push("waste description / code");
  if (!packingMethod) missing.push("packing method");
  if (totalWeightKg === undefined) missing.push("total weight");
  if (!wasteOrigin) missing.push("waste origin");
  if (!wasteOperationCode) missing.push("operation code");
  if (!place) missing.push("place");
  if (!date) missing.push("date");

  if (
    missing.length > 0 ||
    !firmId ||
    !contactId ||
    !firmName ||
    !wasteLocation ||
    !wasteType ||
    !ewcCode ||
    isHazardous === undefined ||
    !packingMethod ||
    totalWeightKg === undefined ||
    !wasteOrigin ||
    !wasteOperationCode ||
    !place ||
    !date
  ) {
    return {
      payload: null,
      error: `I could not generate the form yet — missing or unresolved: ${missing.join(", ")}.`,
    };
  }

  return {
    payload: {
      firm_id: firmId,
      contact_id: contactId,
      firm_name: firmName,
      waste_location: wasteLocation,
      is_hazardous: isHazardous,
      waste_type: wasteType,
      ewc_code: ewcCode,
      packing_method: packingMethod,
      total_weight_kg: totalWeightKg,
      waste_origin: wasteOrigin,
      waste_operation_code: wasteOperationCode,
      place,
      date,
    },
    error: null,
  };
}

function buildTransportFormPayload(
  extracted: Record<string, unknown>
): { payload: TransportFormDocumentRequest | null; error: string | null } {
  const asString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const firmId = asString(extracted.firm_id);
  const disposalPlaceId = asString(extracted.disposal_place_id);
  const firmName = asString(extracted.firm_name);
  const disposalPlaceName = asString(extracted.disposal_place_name);
  const wasteType = asString(extracted.waste_type);
  const ewcCode = asString(extracted.ewc_code);
  const collectorDate = asString(extracted.collector_date);
  const endOwnerDate = asString(extracted.end_owner_date);
  const wasteOwnerTotalKg = asNumber(extracted.waste_owner_total_kg);
  const collectorTotalKg = asNumber(extracted.collector_total_kg);
  const endOwnerTotalKg = asNumber(extracted.end_owner_total_kg);
  const isHazardous = typeof extracted.is_hazardous === "boolean" ? extracted.is_hazardous : undefined;
  const note = asString(extracted.note);

  // Human-readable names for the fields most likely to be missing, so the message is
  // actionable (e.g. an unmatched firm or disposal-place name).
  const missing: string[] = [];
  if (!firmId || !firmName) missing.push("waste owner (name did not match a saved firm)");
  if (!disposalPlaceId || !disposalPlaceName)
    missing.push("end owner (name did not match a saved disposal place)");
  if (!wasteType || !ewcCode || isHazardous === undefined) missing.push("waste description / code");
  if (wasteOwnerTotalKg === undefined) missing.push("total quantity of waste");
  if (collectorTotalKg === undefined) missing.push("quantity collected");
  if (!collectorDate) missing.push("date of handover");
  if (endOwnerTotalKg === undefined) missing.push("quantity received at the disposal place");
  if (!endOwnerDate) missing.push("date received at the disposal place");

  if (
    missing.length > 0 ||
    !firmId ||
    !disposalPlaceId ||
    !firmName ||
    !disposalPlaceName ||
    !wasteType ||
    !ewcCode ||
    isHazardous === undefined ||
    wasteOwnerTotalKg === undefined ||
    collectorTotalKg === undefined ||
    !collectorDate ||
    endOwnerTotalKg === undefined ||
    !endOwnerDate
  ) {
    return {
      payload: null,
      error: `I could not generate the transport form yet — missing or unresolved: ${missing.join(", ")}.`,
    };
  }

  return {
    payload: {
      firm_id: firmId,
      disposal_place_id: disposalPlaceId,
      firm_name: firmName,
      disposal_place_name: disposalPlaceName,
      waste_type: wasteType,
      is_hazardous: isHazardous,
      ewc_code: ewcCode,
      waste_owner_total_kg: wasteOwnerTotalKg,
      collector_total_kg: collectorTotalKg,
      collector_date: collectorDate,
      end_owner_total_kg: endOwnerTotalKg,
      end_owner_date: endOwnerDate,
      note: note ?? null,
    },
    error: null,
  };
}

function formatNonInvoiceChainResponse(response: DashboardResolveAndRunResponse): string {
  const extracted = response.result?.extracted ?? {};
  const prettyExtracted = JSON.stringify(extracted, null, 2);

  if (response.resolvedChainId === "calendar_event_extraction") {
    const success = response.result?.success === true;
    const message =
      typeof response.result?.message === "string" && response.result.message.trim().length > 0
        ? response.result.message
        : success
          ? "Meeting booked successfully."
          : "Failed to book meeting.";

    return message;
  }

  if (response.resolvedChainId === "offer_extraction") {
    return [
      "I detected an offer request and routed it to the offer extraction chain.",
      "Extracted fields:",
      prettyExtracted,
    ].join("\n\n");
  }

  if (response.resolvedChainId === "identification_form_extraction") {
    return [
      "I detected a waste identification form request and extracted its fields.",
      "Extracted fields:",
      prettyExtracted,
    ].join("\n\n");
  }

  if (response.resolvedChainId === "transport_form_extraction") {
    return [
      "I detected a waste transport form request and extracted its fields.",
      "Extracted fields:",
      prettyExtracted,
    ].join("\n\n");
  }

  return [
    "I routed your request to a non-invoice chain.",
    "Extracted fields:",
    prettyExtracted,
  ].join("\n\n");
}


const TOMORROW_END_OFFSET_MS = 2 * 24 * 60 * 60 * 1000;

export default function PortalDashboard() {
  const navigate = useNavigate();
  const userEmail = useAppContextStore((state) => state.userEmail);
  const { messages, addMessage, clearMessages } = useDashboardChat();
  const [invoiceDraft, setInvoiceDraft] = useState<ExtractedInvoiceFromMessage | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEventResponse[]>([]);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [gmailNeedsReconnect, setGmailNeedsReconnect] = useState(false);
  const [pendingTaskCount, setPendingTaskCount] = useState<number>(() =>
    getCachedTasks().filter((t) => t.status === "pending").length
  );
  const [tasksLoadFailed, setTasksLoadFailed] = useState(false);
  const [pendingCallInvoices, setPendingCallInvoices] = useState<PendingInvoice[]>([]);
  const [pendingCallCount, setPendingCallCount] = useState(0);
  const [isDownloadingInvoices, setIsDownloadingInvoices] = useState(false);
  const [pendingCallForms, setPendingCallForms] = useState<PendingIdentificationForm[]>([]);
  const [pendingCallFormCount, setPendingCallFormCount] = useState(0);
  const [isDownloadingForms, setIsDownloadingForms] = useState(false);
  const [pendingCallTransportForms, setPendingCallTransportForms] = useState<PendingTransportForm[]>([]);
  const [pendingCallTransportFormCount, setPendingCallTransportFormCount] = useState(0);
  const [isDownloadingTransportForms, setIsDownloadingTransportForms] = useState(false);

  const sttMode = useAppContextStore((state) => state.sttMode);

  const {
    startRecording,
    stopRecording,
    isRecording,
    isTranscribing,
    transcript,
    error: sttError,
  } = useSTT();

  useEffect(() => {
    if (!transcript) return;
    if (sttMode === "auto-send") {
      void handleSendText(transcript);
    } else {
      setInput(transcript);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript]);

  // Pressing record discards any text sitting in the input and starts a fresh
  // recording, so a prior/half-typed message is never carried into the next take.
  const handleStartRecording = () => {
    setInput("");
    startRecording();
  };

  useEffect(() => {
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + TOMORROW_END_OFFSET_MS).toISOString();

    listCalendarEvents({ timeMin, timeMax, maxResults: 2 })
      .then(setUpcomingEvents)
      .catch(() => setUpcomingEvents([]));

    getGmailInboxStats().then((stats) => {
      if (!stats.connected) {
        setGmailNeedsReconnect(true);
        setUnreadCount(null);
      } else {
        setUnreadCount(stats.unreadCount);
      }
    });

    listTasks({ status: "pending" })
      .then((tasks) => setPendingTaskCount(tasks.length))
      .catch(() => setTasksLoadFailed(true));

    getPendingCallInvoices()
      .then(({ count, invoices }) => { setPendingCallCount(count); setPendingCallInvoices(invoices); })
      .catch(() => { /* non-fatal */ });

    getPendingCallIdentificationForms()
      .then(({ count, forms }) => { setPendingCallFormCount(count); setPendingCallForms(forms); })
      .catch(() => { /* non-fatal */ });

    getPendingCallTransportForms()
      .then(({ count, forms }) => { setPendingCallTransportFormCount(count); setPendingCallTransportForms(forms); })
      .catch(() => { /* non-fatal */ });
  }, []);

  useEffect(() => {
    return () => {
      for (const message of messages) {
        if (message.downloadUrl) {
          URL.revokeObjectURL(message.downloadUrl);
        }
      }
    };
  }, [messages]);

  const handleStop = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
    setInvoiceDraft(null);
  };

  const handleSendText = async (content: string) => {
    if (!content.trim() || isLoading) return;

    addMessage({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    });
    setInput("");
    setIsLoading(true);
    setError(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const resolveResponse = await extractDashboardMessage(content, abortController.signal);
      const extracted = (resolveResponse.result?.extracted ?? {}) as ExtractedInvoiceFromMessage;

      // Identification form: auto-generate the document from the resolved fields. The
      // extract step already resolved the parties, so on success we render immediately
      // and hand back a download link — no separate confirm step.
      if (resolveResponse.resolvedChainId === "identification_form_extraction") {
        const rawExtracted = (resolveResponse.result?.extracted ?? {}) as Record<string, unknown>;
        const { payload: idfPayload, error: idfError } = buildIdentificationFormPayload(rawExtracted);

        if (!idfPayload) {
          addMessage({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "assistant",
            content: idfError ?? "I extracted the fields but could not generate the form yet.",
            createdAt: new Date().toISOString(),
          });
          return;
        }

        const result = await createIdentificationFormDocument(idfPayload);
        const downloadUrl = URL.createObjectURL(result.blob);
        addMessage({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: "Identification form is ready. Use the link below to download it.",
          createdAt: new Date().toISOString(),
          downloadUrl,
          downloadLabel: result.filename,
        });
        return;
      }

      // Transport form: same auto-generate shape as the identification form above —
      // the extract step already resolved both parties, so render immediately.
      if (resolveResponse.resolvedChainId === "transport_form_extraction") {
        const rawExtracted = (resolveResponse.result?.extracted ?? {}) as Record<string, unknown>;
        const { payload: tfPayload, error: tfError } = buildTransportFormPayload(rawExtracted);

        if (!tfPayload) {
          addMessage({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "assistant",
            content: tfError ?? "I extracted the fields but could not generate the form yet.",
            createdAt: new Date().toISOString(),
          });
          return;
        }

        const result = await createTransportFormDocument(tfPayload);
        const downloadUrl = URL.createObjectURL(result.blob);
        addMessage({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: "Transport form is ready. Use the link below to download it.",
          createdAt: new Date().toISOString(),
          downloadUrl,
          downloadLabel: result.filename,
        });
        return;
      }

      if (resolveResponse.resolvedChainId !== "invoice_extraction") {
        addMessage({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: formatNonInvoiceChainResponse(resolveResponse),
          createdAt: new Date().toISOString(),
        });
        return;
      }

      const mergedDraft = mergeExtractedInvoiceDraft(invoiceDraft, extracted);
      const enrichedDraft = applySingleNumberFollowUp(mergedDraft, extracted, content);
      setInvoiceDraft(enrichedDraft);

      const { payload, error: payloadError } = buildInvoicePayloadFromExtraction(enrichedDraft);

      if (!payload) {
        addMessage({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: payloadError ?? "I extracted values but could not generate the invoice yet.",
          createdAt: new Date().toISOString(),
        });
      } else {
        const result = await createInvoiceDocument(payload);
        const downloadUrl = URL.createObjectURL(result.blob);
        setInvoiceDraft(null);

        addMessage({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "assistant",
          content: "Invoice is ready. Use the link below to download it.",
          createdAt: new Date().toISOString(),
          downloadUrl,
          downloadLabel: result.filename,
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message ?? "Failed to run extraction chain.");
      }
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await handleSendText(input);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const clearChat = () => {
    clearMessages();
    setInvoiceDraft(null);
  };

  const userInitial = (userEmail ?? "U")[0].toUpperCase();

  const handleDownloadCallInvoices = async () => {
    if (isDownloadingInvoices || pendingCallCount === 0) return;
    setIsDownloadingInvoices(true);
    try {
      const ids = pendingCallInvoices.map((inv) => inv.id);
      const blob = await downloadCallInvoicesZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "invoices.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      await confirmCallInvoicesDownloaded(ids);
      setPendingCallCount(0);
      setPendingCallInvoices([]);
    } catch {
      // non-fatal: user can retry
    } finally {
      setIsDownloadingInvoices(false);
    }
  };

  const handleDownloadCallForms = async () => {
    if (isDownloadingForms || pendingCallFormCount === 0) return;
    setIsDownloadingForms(true);
    try {
      const ids = pendingCallForms.map((form) => form.id);
      const blob = await downloadCallIdentificationFormsZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "identification-forms.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      await confirmCallIdentificationFormsDownloaded(ids);
      setPendingCallFormCount(0);
      setPendingCallForms([]);
    } catch {
      // non-fatal: user can retry
    } finally {
      setIsDownloadingForms(false);
    }
  };

  const handleDownloadCallTransportForms = async () => {
    if (isDownloadingTransportForms || pendingCallTransportFormCount === 0) return;
    setIsDownloadingTransportForms(true);
    try {
      const ids = pendingCallTransportForms.map((form) => form.id);
      const blob = await downloadCallTransportFormsZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "transport-forms.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      await confirmCallTransportFormsDownloaded(ids);
      setPendingCallTransportFormCount(0);
      setPendingCallTransportForms([]);
    } catch {
      // non-fatal: user can retry
    } finally {
      setIsDownloadingTransportForms(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-[var(--brand-surface)] md:h-full md:min-h-0">
      {/* Metric cards strip */}
      <section className="border-b border-[var(--brand-border)] bg-[var(--brand-surface)] px-6 py-5">
        <div className="mx-auto max-w-6xl">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-widest text-[var(--brand-text-muted)]">Overview</p>
            <p className="text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"}</p>
          </div>
          {/* 1/2/3/6 all divide the six cards evenly, so no breakpoint leaves an orphan
              tile on its own row. */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">

            {/* Card 1 — Upcoming calendar events */}
            <div onClick={() => navigate("/portal/calendar")} className="flex cursor-pointer flex-col justify-between rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-5 shadow-sm shadow-black/[0.03] transition hover:border-[var(--brand-teal)] hover:shadow-md hover:shadow-black/[0.06]">
              <div>
                {/* Icon */}
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-teal-soft)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <rect x="3" y="4" width="18" height="18" rx="3" stroke="var(--brand-teal)" strokeWidth="1.8" />
                    <path d="M3 9h18" stroke="var(--brand-teal)" strokeWidth="1.8" />
                    <path d="M8 2v4M16 2v4" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinecap="round" />
                    <circle cx="8" cy="14" r="1" fill="var(--brand-teal)" />
                    <circle cx="12" cy="14" r="1" fill="var(--brand-teal)" />
                    <circle cx="16" cy="14" r="1" fill="var(--brand-teal)" />
                  </svg>
                </div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-[var(--brand-text-muted)]">Upcoming Events</p>
                {upcomingEvents.length === 0 ? (
                  <p className="mt-2 text-sm font-medium text-[var(--brand-ink)]">No events in the next 2 days</p>
                ) : (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {upcomingEvents.map((event) => (
                      <div key={event.eventId}>
                        <p className="truncate text-sm font-semibold text-[var(--brand-ink)]">{event.title}</p>
                        <p className="text-xs text-[var(--brand-text-muted)]">
                          {new Date(event.startTime).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Footer */}
              <div className="mt-5 flex items-center gap-2 border-t border-[var(--brand-border)] pt-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand-teal)] text-[9px] font-bold text-white">
                  {userInitial}
                </div>
                <p className="text-[10px] text-[var(--brand-text-muted)]">Calendar · live</p>
              </div>
            </div>

            {/* Card 2 — Unread email count */}
            <div className="flex flex-col justify-between rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-5 shadow-sm shadow-black/[0.03] transition hover:shadow-md hover:shadow-black/[0.06]">
              <div>
                {/* Icon */}
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-teal-soft)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <rect x="2" y="5" width="20" height="14" rx="3" stroke="var(--brand-teal)" strokeWidth="1.8" />
                    <path d="M2 8l10 7 10-7" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-[var(--brand-text-muted)]">Unread Emails</p>
                {gmailNeedsReconnect ? (
                  <p className="mt-2 text-sm font-medium text-[var(--brand-ink)]">Gmail needs reconnection</p>
                ) : (
                  <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--brand-ink)]">
                    {unreadCount === null ? "—" : unreadCount}
                  </p>
                )}
              </div>
              {/* Footer */}
              <div className="mt-5 flex items-center gap-2 border-t border-[var(--brand-border)] pt-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand-teal)] text-[9px] font-bold text-white">
                  {userInitial}
                </div>
                <p className="text-[10px] text-[var(--brand-text-muted)]">Gmail · live</p>
              </div>
            </div>

            {/* Card 3 — Pending tasks */}
            <div onClick={() => navigate("/portal/calendar")} className="flex cursor-pointer flex-col justify-between rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-5 shadow-sm shadow-black/[0.03] transition hover:border-[var(--brand-teal)] hover:shadow-md hover:shadow-black/[0.06]">
              <div>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-teal-soft)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M9 11l3 3L22 4" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-[var(--brand-text-muted)]">Pending Tasks</p>
                <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--brand-ink)]">
                  {pendingTaskCount}
                </p>
              </div>
              <div className="mt-5 flex items-center gap-2 border-t border-[var(--brand-border)] pt-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand-teal)] text-[9px] font-bold text-white">
                  {userInitial}
                </div>
                <p className="text-[10px] text-[var(--brand-text-muted)]">
                  {tasksLoadFailed ? "Tasks · failed to load" : "Tasks · live"}
                </p>
              </div>
            </div>

            {/* Card 4 — Call invoices ready to download */}
            <div
              onClick={handleDownloadCallInvoices}
              className={`flex flex-col justify-between rounded-2xl border p-5 shadow-sm shadow-black/[0.03] transition ${
                pendingCallCount > 0
                  ? "cursor-pointer border-[var(--brand-teal)] bg-[var(--brand-card)] hover:shadow-md hover:shadow-black/[0.06]"
                  : "border-[var(--brand-border)] bg-[var(--brand-card)] opacity-60"
              }`}
            >
              <div>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-teal-soft)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M12 3v13M7 11l5 5 5-5" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M3 20h18" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-[var(--brand-text-muted)]">Call Invoices</p>
                <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--brand-ink)]">
                  {isDownloadingInvoices ? "…" : pendingCallCount}
                </p>
                {pendingCallCount > 0 && (
                  <p className="mt-1 text-[11px] text-[var(--brand-text-muted)]">Click to download ZIP</p>
                )}
              </div>
              <div className="mt-5 flex items-center gap-2 border-t border-[var(--brand-border)] pt-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand-teal)] text-[9px] font-bold text-white">
                  {userInitial}
                </div>
                <p className="text-[10px] text-[var(--brand-text-muted)]">
                  {isDownloadingInvoices ? "Downloading…" : "Voice-generated · pending"}
                </p>
              </div>
            </div>

            {/* Card 5 — Call identification forms ready to download */}
            <div
              onClick={handleDownloadCallForms}
              className={`flex flex-col justify-between rounded-2xl border p-5 shadow-sm shadow-black/[0.03] transition ${
                pendingCallFormCount > 0
                  ? "cursor-pointer border-[var(--brand-teal)] bg-[var(--brand-card)] hover:shadow-md hover:shadow-black/[0.06]"
                  : "border-[var(--brand-border)] bg-[var(--brand-card)] opacity-60"
              }`}
            >
              <div>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-teal-soft)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M8 3h6l4 4v14H6V3z" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinejoin="round" />
                    <path d="M14 3v4h4M9 13h6M9 17h6" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-[var(--brand-text-muted)]">Call Forms</p>
                <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--brand-ink)]">
                  {isDownloadingForms ? "…" : pendingCallFormCount}
                </p>
                {pendingCallFormCount > 0 && (
                  <p className="mt-1 text-[11px] text-[var(--brand-text-muted)]">Click to download ZIP</p>
                )}
              </div>
              <div className="mt-5 flex items-center gap-2 border-t border-[var(--brand-border)] pt-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand-teal)] text-[9px] font-bold text-white">
                  {userInitial}
                </div>
                <p className="text-[10px] text-[var(--brand-text-muted)]">
                  {isDownloadingForms ? "Downloading…" : "Voice-generated · pending"}
                </p>
              </div>
            </div>

            {/* Card 6 — Call transport forms ready to download */}
            <div
              onClick={handleDownloadCallTransportForms}
              className={`flex flex-col justify-between rounded-2xl border p-5 shadow-sm shadow-black/[0.03] transition ${
                pendingCallTransportFormCount > 0
                  ? "cursor-pointer border-[var(--brand-teal)] bg-[var(--brand-card)] hover:shadow-md hover:shadow-black/[0.06]"
                  : "border-[var(--brand-border)] bg-[var(--brand-card)] opacity-60"
              }`}
            >
              <div>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-teal-soft)]">
                  {/* Truck — the movement-between-parties signal that separates this form
                      from the identification form's document icon above. */}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M3 6h10v9H3z" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinejoin="round" />
                    <path d="M13 9h4l3 3v3h-7z" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinejoin="round" />
                    <circle cx="7" cy="18" r="1.8" stroke="var(--brand-teal)" strokeWidth="1.8" />
                    <circle cx="17" cy="18" r="1.8" stroke="var(--brand-teal)" strokeWidth="1.8" />
                  </svg>
                </div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-[var(--brand-text-muted)]">Transport Forms</p>
                <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--brand-ink)]">
                  {isDownloadingTransportForms ? "…" : pendingCallTransportFormCount}
                </p>
                {pendingCallTransportFormCount > 0 && (
                  <p className="mt-1 text-[11px] text-[var(--brand-text-muted)]">Click to download ZIP</p>
                )}
              </div>
              <div className="mt-5 flex items-center gap-2 border-t border-[var(--brand-border)] pt-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand-teal)] text-[9px] font-bold text-white">
                  {userInitial}
                </div>
                <p className="text-[10px] text-[var(--brand-text-muted)]">
                  {isDownloadingTransportForms ? "Downloading…" : "Voice-generated · pending"}
                </p>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* Chat area */}
      <section className="flex min-h-[600px] flex-1 flex-col overflow-hidden md:min-h-0">
        <div className="flex h-full min-h-0 flex-col">
          {/* Chat header */}
          <div className="flex items-center justify-between border-b border-[var(--brand-border)] bg-[var(--brand-card)] px-5 py-3">
            <div className="flex items-center gap-2">
              {/* Sparkle icon matching Bard's star */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0">
                <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="var(--brand-teal)" />
              </svg>
              <span className="text-sm font-medium text-[var(--brand-ink)]">Assistant</span>
            </div>
            <button
              type="button"
              onClick={clearChat}
              className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-3 py-1 text-xs text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
            >
              New chat
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto bg-[var(--brand-chat-bg)] px-4 py-8">
            <div className="mx-auto max-w-4xl">
              {messages.length === 0 && !isLoading ? (
                <div className="flex h-full min-h-[200px] items-center justify-center">
                  <div className="text-center">
                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" className="mx-auto mb-5">
                      <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="var(--brand-teal)" opacity="0.7" />
                    </svg>
                    <h3 className="text-lg font-medium text-[var(--brand-ink)]">How can I help you today?</h3>
                    <p className="mt-1.5 text-sm text-[var(--brand-text-muted)]">Ask me to create an invoice, offer, or book a meeting.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  {messages.map((message) => (
                    <div key={message.id} className="flex items-start gap-3">
                      {/* Avatar */}
                      {message.role === "user" ? (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--brand-avatar-user)] text-xs font-semibold text-white">
                          {userInitial}
                        </div>
                      ) : (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--brand-card)] border border-[var(--brand-border)]">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                            <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="var(--brand-teal)" />
                          </svg>
                        </div>
                      )}
                      {/* Bubble */}
                      <div className="flex-1">
                        <div className="rounded-2xl bg-[var(--brand-card)] px-4 py-3 text-sm leading-7 text-[var(--brand-ink)] shadow-sm shadow-black/[0.04]">
                          <p className="whitespace-pre-wrap">{message.content}</p>
                          {message.downloadUrl ? (
                            <a
                              href={message.downloadUrl}
                              download={message.downloadLabel ?? "invoice.xlsx"}
                              className="mt-2 inline-block rounded-lg border border-[var(--brand-teal)] px-3 py-1 text-xs font-medium text-[var(--brand-teal)] hover:bg-[var(--brand-teal-soft)]"
                            >
                              Download {message.downloadLabel ?? "invoice.xlsx"}
                            </a>
                          ) : null}
                        </div>
                        <p className="mt-1 pl-1 text-[10px] text-[var(--brand-text-muted)]">
                          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    </div>
                  ))}

                  {isLoading && (
                    <div className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)]">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="var(--brand-teal)" />
                        </svg>
                      </div>
                      <div className="rounded-2xl bg-[var(--brand-card)] px-4 py-3 shadow-sm shadow-black/[0.04]">
                        <div className="flex items-center gap-1.5">
                          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-teal)] [animation-delay:-0.3s]" />
                          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-teal)] [animation-delay:-0.15s]" />
                          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-teal)]" />
                        </div>
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {error}
                    </div>
                  )}
                  {sttError && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {sttError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Input bar */}
          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-chat-bg)] px-4 py-4">
            <div className="mx-auto max-w-3xl">
              <form onSubmit={handleSend}>
                <div className="flex items-center gap-3 rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 py-3 shadow-sm shadow-black/[0.04] focus-within:border-[var(--brand-teal)] focus-within:ring-1 focus-within:ring-[var(--brand-teal)] transition">
                  {/* Left button: mic (idle) or + (recording) */}
                  {isRecording || isTranscribing ? (
                    <button
                      type="button"
                      onClick={handleStartRecording}
                      disabled
                      aria-label="Add"
                      className="shrink-0 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] text-[var(--brand-text-muted)] opacity-40"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStartRecording}
                      disabled={isLoading}
                      aria-label="Start voice input"
                      className="shrink-0 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="2" />
                        <path d="M5 10a7 7 0 0014 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        <line x1="12" y1="17" x2="12" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}

                  {/* Center: waveform when recording, textarea otherwise */}
                  {isRecording ? (
                    <div className="flex flex-1 items-center justify-center gap-[3px] h-8 overflow-hidden">
                      {Array.from({ length: 32 }).map((_, i) => (
                        <span
                          key={i}
                          className="inline-block w-[2px] rounded-full bg-[var(--brand-text-muted)] animate-pulse"
                          style={{
                            height: `${8 + Math.sin(i * 0.8) * 6 + (i % 3) * 4}px`,
                            animationDelay: `${(i * 50) % 600}ms`,
                            animationDuration: `${600 + (i % 4) * 150}ms`,
                          }}
                        />
                      ))}
                    </div>
                  ) : isTranscribing ? (
                    <div className="flex flex-1 items-center justify-center gap-1.5 h-8">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-text-muted)] [animation-delay:-0.3s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-text-muted)] [animation-delay:-0.15s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-text-muted)]" />
                    </div>
                  ) : (
                    <textarea
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={handleInputKeyDown}
                      rows={1}
                      maxLength={4000}
                      disabled={isLoading}
                      placeholder="Enter a prompt here"
                      className="flex-1 resize-none bg-transparent text-sm text-[var(--brand-ink)] placeholder:text-[var(--brand-text-muted)] outline-none disabled:opacity-50 leading-6"
                      style={{ maxHeight: "120px", overflowY: "auto" }}
                    />
                  )}

                  {/* Right: stop-recording, stop-generation, or send */}
                  {isRecording ? (
                    <button
                      type="button"
                      onClick={stopRecording}
                      aria-label="Stop recording"
                      className="shrink-0 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] text-[var(--brand-ink)] transition hover:border-red-400 hover:text-red-500"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                        <rect x="1" y="1" width="10" height="10" rx="2" />
                      </svg>
                    </button>
                  ) : isLoading ? (
                    <button
                      type="button"
                      onClick={handleStop}
                      className="shrink-0 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] text-[var(--brand-ink)] transition hover:border-red-400 hover:text-red-500"
                      aria-label="Stop generation"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                        <rect x="1" y="1" width="10" height="10" rx="2" />
                      </svg>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!input.trim() || isTranscribing}
                      className="shrink-0 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--brand-teal)] text-white transition hover:bg-[#2f8575] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </div>
                <p className="mt-2 text-center text-[10px] text-[var(--brand-text-muted)]">
                  Assistant may display inaccurate information. Always verify important outputs.
                </p>
              </form>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
