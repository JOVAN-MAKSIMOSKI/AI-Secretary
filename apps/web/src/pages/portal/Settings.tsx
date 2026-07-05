import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  disconnectGmailConnection,
  getGmailConnectionStatus,
  getGmailConnectUrl,
  type GmailConnectionStatusResponse,
} from "../../connection/supabase-client";
import { useAppContextStore, type SttMode } from "../../store/app-context";
import WasteProfileSection from "../../components/portal/WasteProfileSection";

type Banner = {
  tone: "success" | "error";
  message: string;
};

const bannerToneClasses: Record<Banner["tone"], string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  error: "border-rose-200 bg-rose-50 text-rose-700",
};

const STT_OPTIONS: { value: SttMode; label: string; description: string }[] = [
  {
    value: "review",
    label: "Review before sending",
    description: "Transcribed text appears in the input field. You can edit it before pressing send.",
  },
  {
    value: "auto-send",
    label: "Send immediately",
    description: "Transcribed text is sent directly to the assistant without showing in the input field.",
  },
];

export default function Settings() {
  const navigate = useNavigate();
  const location = useLocation();
  const sttMode = useAppContextStore((state) => state.sttMode);
  const setSttMode = useAppContextStore((state) => state.setSttMode);
  const [status, setStatus] = useState<GmailConnectionStatusResponse | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  const loadStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    try {
      const data = await getGmailConnectionStatus();
      setStatus(data);
    } catch (error) {
      setStatus(null);
      setBanner({
        tone: "error",
        message: error instanceof Error ? error.message : "Failed to load Gmail status.",
      });
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const oauthResult = params.get("gmail_oauth");
    const oauthMessage = params.get("message");

    if (oauthResult === "success") {
      setBanner({ tone: "success", message: "Gmail connected successfully." });
    } else if (oauthResult === "error") {
      setBanner({ tone: "error", message: oauthMessage || "Gmail OAuth failed." });
    }

    if (oauthResult) {
      params.delete("gmail_oauth");
      params.delete("message");
      const query = params.toString();
      const nextUrl = `${location.pathname}${query ? `?${query}` : ""}`;
      navigate(nextUrl, { replace: true });
    }

    void loadStatus();
  }, [loadStatus, location.pathname, location.search, navigate]);

  const statusLabel = useMemo(() => {
    if (!status) {
      return "Unavailable";
    }
    return status.connected ? "Connected" : "Not connected";
  }, [status]);

  const handleConnect = async () => {
    setBanner(null);
    setIsConnecting(true);
    try {
      const { url } = await getGmailConnectUrl(`${location.pathname}${location.search || ""}`);
      window.location.assign(url);
    } catch (error) {
      setBanner({
        tone: "error",
        message: error instanceof Error ? error.message : "Failed to start Gmail OAuth.",
      });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setBanner(null);
    setIsDisconnecting(true);
    try {
      const result = await disconnectGmailConnection();
      setBanner({
        tone: "success",
        message: result.disconnected
          ? "Gmail account disconnected."
          : "No active Gmail connection to disconnect.",
      });
      await loadStatus();
    } catch (error) {
      setBanner({
        tone: "error",
        message: error instanceof Error ? error.message : "Failed to disconnect Gmail.",
      });
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-4xl p-6 md:p-8">
      <div className="rounded-xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-text-muted)]">Settings</p>
        <h1 className="mt-3 text-2xl font-semibold text-[var(--brand-ink)]">Gmail Integration</h1>
        <p className="mt-2 text-sm text-[var(--brand-text-muted)]">
          Connect your Gmail account so the assistant can send documents from your own mailbox.
        </p>

        {banner ? (
          <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${bannerToneClasses[banner.tone]}`}>
            {banner.message}
          </div>
        ) : null}

        <div className="mt-6 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-text-muted)]">Connection status</p>
              <p className="mt-1 text-base font-medium text-[var(--brand-ink)]">
                {isLoadingStatus ? "Checking status..." : statusLabel}
              </p>
              {!isLoadingStatus && status?.connected && status.googleEmail ? (
                <p className="mt-1 text-sm text-[var(--brand-text-muted)]">Connected as {status.googleEmail}</p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleConnect}
                disabled={isConnecting}
                className="rounded-md bg-[var(--brand-teal)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status?.connected ? "Reconnect Gmail" : "Connect Gmail"}
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={isDisconnecting || !status?.connected}
                className="rounded-md border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-medium text-[var(--brand-ink)] transition hover:bg-[var(--brand-surface)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Disconnect
              </button>
            </div>
          </div>

          {!isLoadingStatus && status?.scopes?.length ? (
            <div className="mt-4 border-t border-[var(--brand-border)] pt-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-text-muted)]">Granted scopes</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {status.scopes.map((scope) => (
                  <span
                    key={scope}
                    className="rounded-full border border-[var(--brand-border)] bg-white px-2.5 py-1 text-xs text-[var(--brand-text-muted)]"
                  >
                    {scope}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* STT mode */}
      <div className="mt-6 rounded-xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-text-muted)]">Settings</p>
        <h2 className="mt-3 text-2xl font-semibold text-[var(--brand-ink)]">Voice Input Mode</h2>
        <p className="mt-2 text-sm text-[var(--brand-text-muted)]">
          Choose how transcribed speech is handled after you stop recording.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          {STT_OPTIONS.map((option) => {
            const isSelected = sttMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setSttMode(option.value)}
                className={[
                  "flex items-start gap-4 rounded-lg border p-4 text-left transition",
                  isSelected
                    ? "border-[var(--brand-teal)] bg-[var(--brand-teal-soft)]"
                    : "border-[var(--brand-border)] bg-[var(--brand-surface)] hover:border-[var(--brand-teal)]",
                ].join(" ")}
              >
                <div className={[
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition",
                  isSelected ? "border-[var(--brand-teal)]" : "border-[var(--brand-border)]",
                ].join(" ")}>
                  {isSelected && (
                    <div className="h-2 w-2 rounded-full bg-[var(--brand-teal)]" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--brand-ink)]">{option.label}</p>
                  <p className="mt-0.5 text-xs text-[var(--brand-text-muted)]">{option.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Waste-law advisor profile (feeds tenant context into RAG answers) */}
      <WasteProfileSection />
    </section>
  );
}
