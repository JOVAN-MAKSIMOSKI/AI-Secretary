import { create } from "zustand";

type AppContextState = {
  userId: string | null;
  userEmail: string | null;
  businessId: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  setContext: (payload: {
    userId: string | null;
    userEmail: string | null;
    businessId: string | null;
    isAuthenticated: boolean;
  }) => void;
  clearContext: () => void;
  setLoading: (loading: boolean) => void;
};

export const useAppContextStore = create<AppContextState>((set) => ({
  userId: null,
  userEmail: null,
  businessId: null,
  isAuthenticated: false,
  loading: true,
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
}));
