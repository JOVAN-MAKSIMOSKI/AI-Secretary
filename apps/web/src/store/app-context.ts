import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SttMode = "review" | "auto-send";

type AppContextState = {
  userId: string | null;
  userEmail: string | null;
  businessId: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  sttMode: SttMode;
  setContext: (payload: {
    userId: string | null;
    userEmail: string | null;
    businessId: string | null;
    isAuthenticated: boolean;
  }) => void;
  clearContext: () => void;
  setLoading: (loading: boolean) => void;
  setSttMode: (mode: SttMode) => void;
};

export const useAppContextStore = create<AppContextState>()(
  persist(
    (set) => ({
      userId: null,
      userEmail: null,
      businessId: null,
      isAuthenticated: false,
      loading: true,
      sttMode: "review",
      setContext: ({ userId, userEmail, businessId, isAuthenticated }) => {
        set({ userId, userEmail, businessId, isAuthenticated, loading: false });
      },
      clearContext: () => {
        set({
          userId: null,
          userEmail: null,
          businessId: null,
          isAuthenticated: false,
          loading: false,
        });
      },
      setLoading: (loading) => {
        set({ loading });
      },
      setSttMode: (mode) => {
        set({ sttMode: mode });
      },
    }),
    {
      name: "app-context",
      partialize: (state) => ({ sttMode: state.sttMode }),
    }
  )
);
