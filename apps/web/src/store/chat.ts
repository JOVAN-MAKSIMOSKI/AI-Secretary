import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  // blob: URLs are session-scoped and become invalid after a page reload
  downloadUrl?: string;
  downloadLabel?: string;
};

type ChatSlice = {
  messages: Record<string, ChatMessage[]>;
  addMessage: (tenantId: string, message: ChatMessage) => void;
  clearMessages: (tenantId: string) => void;
};

const createChatStore = (storageName: string) =>
  create<ChatSlice>()(
    persist(
      (set) => ({
        messages: {},
        addMessage: (tenantId, message) =>
          set((state) => ({
            messages: {
              ...state.messages,
              [tenantId]: [...(state.messages[tenantId] ?? []), message],
            },
          })),
        clearMessages: (tenantId) =>
          set((state) => ({
            messages: { ...state.messages, [tenantId]: [] },
          })),
      }),
      {
        name: storageName,
        storage: createJSONStorage(() => sessionStorage),
      }
    )
  );

export const useDashboardChatStore = createChatStore("dashboard-chat-v1");
export const useLawChatStore = createChatStore("law-questions-chat-v1");
