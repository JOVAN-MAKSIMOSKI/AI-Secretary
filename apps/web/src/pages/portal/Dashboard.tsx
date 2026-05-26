import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

const CHAT_STORAGE_PREFIX = "dashboard-chat-v1";

function getChatStorageKey(tenantId: string | null) {
  return `${CHAT_STORAGE_PREFIX}:${tenantId ?? "anonymous"}`;
}


export default function PortalDashboard() {
  const tenantId = useSessionStore((state) => state.tenantId);
  const userEmail = useAppContextStore((state) => state.userEmail);
  const tenantIdentifier = tenantId;
  const chatStorageKey = useMemo(() => getChatStorageKey(tenantIdentifier), [tenantIdentifier]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");

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

  const handleSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = input.trim();
    if (!content) {
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
  };

  const clearChat = () => {
    setMessages([]);
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
                <p className="mt-1 text-xs text-[var(--brand-text-muted)]">Local-only chat scaffold for future LangChain and LangGraph wiring.</p>
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
            {messages.length === 0 ? (
              <div className="grid h-full place-items-center">
                <div className="max-w-md text-center">
                  <h3 className="text-xl font-medium tracking-[-0.01em] text-[var(--brand-ink)]">How can I help you today?</h3>
                  <p className="mt-2 text-sm text-[var(--brand-text-muted)]">This chat is currently local-only and stored in your browser.</p>
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
                    </div>
                    <p className="mt-2 text-[10px] text-[var(--brand-text-muted)]">
                      {message.role === "user" ? "You" : "Assistant"} · {new Date(message.createdAt).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={handleSend} className="border-t border-[var(--brand-border)] p-3">
            <div className="rounded-[1.25rem] border border-[var(--brand-border)] bg-[var(--brand-card)] p-2 shadow-sm shadow-slate-100/70">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="Message dashboard assistant"
                className="w-full resize-none bg-transparent px-3 py-2 text-sm text-[var(--brand-ink)] outline-none"
              />

              <div className="flex items-center justify-end border-t border-[var(--brand-border)] pt-2">
              
                <button
                  type="submit"
                  className="inline-flex h-9 items-center justify-center rounded-full bg-[var(--brand-teal)] px-4 text-sm font-medium text-white transition hover:bg-[#2f8575]"
                >
                  Send
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
