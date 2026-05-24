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
    <div className="flex h-full min-h-0 flex-col bg-[#f7f7f8]">
      <section className="min-h-[180px] border-b border-slate-200 px-5 py-4 md:min-h-[220px]">
        <div className="mx-auto h-full max-w-6xl">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Metrics</h2>
              <p className="mt-1 text-xs text-slate-600">Reserved top section for dashboard KPI widgets.</p>
            </div>
            <p className="text-[11px] text-slate-500">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>
          </div>
          <div className="grid h-[calc(100%-2.25rem)] grid-cols-1 gap-3 md:grid-cols-3">
            <div className="grid place-items-center rounded-xl border border-dashed border-slate-300 bg-white/70 p-4 text-xs text-slate-500">Metric card area</div>
            <div className="grid place-items-center rounded-xl border border-dashed border-slate-300 bg-white/70 p-4 text-xs text-slate-500">Metric card area</div>
            <div className="grid place-items-center rounded-xl border border-dashed border-slate-300 bg-white/70 p-4 text-xs text-slate-500">Metric card area</div>
          </div>
        </div>
      </section>

      <section className="min-h-0 flex-1 border-t border-slate-200 px-3 pb-3 pt-3 md:px-4 md:pb-4">
        <div className="flex h-full min-h-0 w-full flex-col rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Assistant Chat</h2>
                <p className="mt-1 text-xs text-slate-600">Local-only chat scaffold for future LangChain and LangGraph wiring.</p>
              </div>
              <button
                type="button"
                onClick={clearChat}
                className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-900 hover:text-slate-900"
              >
                Clear chat
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="grid h-full place-items-center">
                <div className="max-w-md text-center">
                  <h3 className="text-xl font-semibold text-slate-900">How can I help you today?</h3>
                  <p className="mt-2 text-sm text-slate-500">This chat is currently local-only and stored in your browser.</p>
                </div>
              </div>
            ) : (
              <div className="space-y-6 py-2">
                {messages.map((message) => (
                  <div key={message.id} className="w-full">
                    <div
                      className={
                        message.role === "user"
                          ? "ml-auto w-fit max-w-[80%] rounded-3xl bg-[#e9eaec] px-4 py-3 text-sm leading-6 text-slate-900"
                          : "mr-auto max-w-[90%] px-1 py-1 text-sm leading-7 text-slate-900"
                      }
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    </div>
                    <p className="mt-2 text-[10px] text-slate-500">
                      {message.role === "user" ? "You" : "Assistant"} · {new Date(message.createdAt).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={handleSend} className="border-t border-slate-200 p-3">
            <div className="rounded-[1.75rem] border border-slate-300 bg-white p-2 shadow-sm">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="Message dashboard assistant"
                className="w-full resize-none bg-transparent px-3 py-2 text-sm text-slate-900 outline-none"
              />

              <div className="flex items-center justify-end border-t border-slate-200 pt-2">
              
                <button
                  type="submit"
                  className="inline-flex h-9 items-center justify-center rounded-full bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800"
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
