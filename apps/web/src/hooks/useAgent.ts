import { useCallback } from "react";
import { useSessionStore } from "../store/session";
import { useDashboardChatStore, useLawChatStore, type ChatMessage } from "../store/chat";

export type { ChatMessage };

// Stable empty array so Zustand selectors don't produce a new reference on every render
// when a tenant has no messages yet, which would cause an infinite update loop.
const EMPTY_MESSAGES: ChatMessage[] = [];

function useTenantKey(): string {
  return useSessionStore((state) => state.tenantId) ?? "anonymous";
}

export function useDashboardChat() {
  const tenantId = useTenantKey();
  const _addMessage = useDashboardChatStore((state) => state.addMessage);
  const _clearMessages = useDashboardChatStore((state) => state.clearMessages);
  const messages = useDashboardChatStore((state) => state.messages[tenantId] ?? EMPTY_MESSAGES);

  const addMessage = useCallback(
    (message: ChatMessage) => _addMessage(tenantId, message),
    [_addMessage, tenantId]
  );

  const clearMessages = useCallback(
    () => _clearMessages(tenantId),
    [_clearMessages, tenantId]
  );

  return { messages, addMessage, clearMessages };
}

export function useLawChat() {
  const tenantId = useTenantKey();
  const _addMessage = useLawChatStore((state) => state.addMessage);
  const _clearMessages = useLawChatStore((state) => state.clearMessages);
  const messages = useLawChatStore((state) => state.messages[tenantId] ?? EMPTY_MESSAGES);

  const addMessage = useCallback(
    (message: ChatMessage) => _addMessage(tenantId, message),
    [_addMessage, tenantId]
  );

  const clearMessages = useCallback(
    () => _clearMessages(tenantId),
    [_clearMessages, tenantId]
  );

  return { messages, addMessage, clearMessages };
}
