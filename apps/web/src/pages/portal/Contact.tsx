import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { useVoiceCall, type VoiceStatus } from "../../hooks/useVoiceCall";

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "Ready to connect",
  "fetching-token": "Getting access token…",
  ready: "Device ready",
  connecting: "Connecting…",
  connected: "Connected — speak now",
  disconnected: "Call ended",
  error: "Error",
};

const ACTIVE_STATUSES: VoiceStatus[] = ["connecting", "connected"];

export default function Contact() {
  const { status, error, connect, disconnect } = useVoiceCall();
  const isActive = ACTIVE_STATUSES.includes(status);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--brand-ink)]">
          AI Secretary — Voice Call
        </h1>
        <p className="text-sm text-[var(--brand-text-muted)]">
          Talk directly to your AI secretary over WebRTC — no phone number needed
        </p>
      </div>

      {/* Pulse ring when connected */}
      <div className="relative flex items-center justify-center">
        {status === "connected" && (
          <span className="absolute inline-flex h-28 w-28 animate-ping rounded-full bg-[var(--brand-teal)] opacity-20" />
        )}
        <button
          type="button"
          onClick={isActive ? disconnect : connect}
          disabled={status === "fetching-token" || status === "connecting"}
          className={[
            "relative z-10 flex h-24 w-24 items-center justify-center rounded-full transition-all duration-200",
            isActive
              ? "bg-red-500 hover:bg-red-600 text-white"
              : "bg-[var(--brand-teal)] hover:opacity-90 text-white",
            status === "fetching-token" || status === "connecting"
              ? "opacity-60 cursor-not-allowed"
              : "cursor-pointer",
          ].join(" ")}
          aria-label={isActive ? "End call" : "Start call"}
        >
          {isActive ? <PhoneOff size={32} /> : <Phone size={32} />}
        </button>
      </div>

      {/* Status */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          {status === "connected" ? (
            <Mic size={14} className="text-[var(--brand-teal)]" />
          ) : (
            <MicOff size={14} className="text-[var(--brand-text-muted)]" />
          )}
          <span
            className={[
              "text-sm font-medium",
              status === "connected"
                ? "text-[var(--brand-teal)]"
                : status === "error"
                  ? "text-red-400"
                  : "text-[var(--brand-text-muted)]",
            ].join(" ")}
          >
            {STATUS_LABEL[status]}
          </span>
        </div>

        {error && (
          <p className="mt-1 max-w-xs text-center text-xs text-red-400">{error}</p>
        )}
      </div>

      <p className="max-w-xs text-center text-xs text-[var(--brand-text-muted)] opacity-60">
        Your microphone will be requested when you start a call. Audio is processed
        through ElevenLabs and your AI secretary backend.
      </p>
    </div>
  );
}
