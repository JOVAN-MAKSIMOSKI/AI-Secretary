import { useCallback, useEffect, useRef, useState } from "react";
import { Device, type Call } from "@twilio/voice-sdk";

export type VoiceStatus =
  | "idle"
  | "fetching-token"
  | "ready"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const agentApiBaseUrl = import.meta.env.VITE_AGENT_API_BASE_URL ?? "/agent-api";

export function useVoiceCall() {
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // Tear down device on unmount.
  useEffect(() => {
    return () => {
      deviceRef.current?.destroy();
      deviceRef.current = null;
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setStatus("fetching-token");

    try {
      const res = await fetch(`${agentApiBaseUrl}/calls/token`);
      if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
      const { token: twilioToken } = (await res.json()) as { token: string };

      // Destroy any previous device before creating a new one.
      deviceRef.current?.destroy();

      const device = new Device(twilioToken, { logLevel: "warn" });
      deviceRef.current = device;

      device.on("error", (err: Error) => {
        setError(err.message);
        setStatus("error");
      });

      setStatus("connecting");
      const call = await device.connect({ params: { To: "ai_secretary" } });
      callRef.current = call;

      call.on("accept", () => setStatus("connected"));
      call.on("disconnect", () => {
        callRef.current = null;
        setStatus("disconnected");
      });
      call.on("error", (err: Error) => {
        setError(err.message);
        setStatus("error");
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
    }
  }, []);

  const disconnect = useCallback(() => {
    callRef.current?.disconnect();
    deviceRef.current?.destroy();
    deviceRef.current = null;
    callRef.current = null;
    setStatus("idle");
    setError(null);
  }, []);

  return { status, error, connect, disconnect };
}
