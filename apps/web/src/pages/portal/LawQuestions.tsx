import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";
import { queryLawDocuments } from "../../connection/supabase-client";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

const LAW_CHAT_STORAGE_PREFIX = "law-questions-chat-v1";

function getLawChatStorageKey(tenantId: string | null) {
  return `${LAW_CHAT_STORAGE_PREFIX}:${tenantId ?? "anonymous"}`;
}

export default function LawQuestions() {
  const tenantId = useSessionStore((state) => state.tenantId);
  const userEmail = useAppContextStore((state) => state.userEmail);
  const tenantIdentifier = tenantId;
  const chatStorageKey = useMemo(() => getLawChatStorageKey(tenantIdentifier), [tenantIdentifier]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || isLoading) {
      return;
    }

    const userMessage: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsLoading(true);
    setError(null);

    try {
      const answer = await queryLawDocuments(content);
      const assistantMessage: ChatMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "assistant",
        content: answer,
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => [...current, assistantMessage]);
    } catch (err) {
      setError((err as Error).message ?? "Something went wrong. Please try again.");
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
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--brand-surface)] p-3 md:p-4">
      <div className="flex h-full min-h-0 w-full flex-col rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)]">
        <div className="border-b border-[var(--brand-border)] px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-medium text-[var(--brand-ink)]">Law Questions</h2>
              <p className="mt-1 text-xs text-[var(--brand-text-muted)]">Ask waste-management law questions answered by local legal documents.</p>
            </div>
            <div className="flex items-center gap-3">
              <p className="text-[11px] text-[var(--brand-text-muted)]">{userEmail ?? "Unknown"} · {tenantIdentifier ?? "Loading..."}</p>
              <button
                type="button"
                onClick={clearChat}
                className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-3 py-1.5 text-xs font-medium text-[var(--brand-text-muted)] transition hover:border-[var(--brand-teal)] hover:text-[var(--brand-teal)]"
              >
                Clear chat
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 && !isLoading ? (
            <div className="grid h-full place-items-center">
              <div className="max-w-md text-center">
                <h3 className="text-xl font-medium tracking-[-0.01em] text-[var(--brand-ink)]">Ask a law question</h3>
                <p className="mt-2 text-sm text-[var(--brand-text-muted)]">Answers are retrieved from local waste-management law documents via Qdrant + Ollama.</p>
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

              <div ref={bottomRef} />
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
              placeholder="Ask a waste-management law question"
              className="w-full resize-none bg-transparent px-3 py-2 text-sm text-[var(--brand-ink)] outline-none disabled:opacity-50"
            />

            <div className="flex items-center justify-end border-t border-[var(--brand-border)] pt-2">
              <button
                type="submit"
                disabled={isLoading}
                className="inline-flex h-9 items-center justify-center rounded-full bg-[var(--brand-teal)] px-4 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? "Thinking…" : "Send"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
