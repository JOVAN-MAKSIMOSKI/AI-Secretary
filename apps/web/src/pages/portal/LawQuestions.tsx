import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";
import { queryLawDocuments } from "../../connection/supabase-client";
import { useLawChat, type ChatMessage } from "../../hooks/useAgent";
import { useSTT } from "../../hooks/useSTT";

export default function LawQuestions() {
  const tenantId = useSessionStore((state) => state.tenantId);
  const userEmail = useAppContextStore((state) => state.userEmail);
  const sttMode = useAppContextStore((state) => state.sttMode);
  const tenantIdentifier = tenantId;
  const { messages, addMessage, clearMessages } = useLawChat();
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const {
    startRecording,
    stopRecording,
    isRecording,
    isTranscribing,
    transcript,
    error: sttError,
  } = useSTT();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

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

  const handleStop = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
  };

  const handleSendText = async (content: string) => {
    if (!content.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    addMessage(userMessage);
    setInput("");
    setIsLoading(true);
    setError(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const answer = await queryLawDocuments(content, 5, abortController.signal);
      const assistantMessage: ChatMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "assistant",
        content: answer,
        createdAt: new Date().toISOString(),
      };
      addMessage(assistantMessage);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message ?? "Something went wrong. Please try again.");
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

              {sttError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {sttError}
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="border-t border-[var(--brand-border)] px-4 py-4">
          <form onSubmit={handleSend}>
            <div className="flex items-center gap-3 rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] px-4 py-3 shadow-sm shadow-black/[0.04] focus-within:border-[var(--brand-teal)] focus-within:ring-1 focus-within:ring-[var(--brand-teal)] transition">
              {/* Left button: mic (idle) or disabled + (recording/transcribing) */}
              {isRecording || isTranscribing ? (
                <button
                  type="button"
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

              {/* Center: waveform when recording, dots when transcribing, textarea otherwise */}
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
                  placeholder="Ask a waste-management law question"
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
                  aria-label="Stop generation"
                  className="shrink-0 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--brand-border)] bg-[var(--brand-card)] text-[var(--brand-ink)] transition hover:border-red-400 hover:text-red-500"
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
              Answers are retrieved from local waste-management law documents via RAG.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
