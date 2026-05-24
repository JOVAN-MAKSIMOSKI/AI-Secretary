import { create } from "zustand";
import type { Session, User } from "@supabase/supabase-js";

type SessionState = {
	session: Session | null;
	user: User | null;
	role: string | null;
	tenantId: string | null;
	businessId: string | null;
	setSession: (session: Session | null) => void;
	clearSession: () => void;
	setBusinessId: (businessId: string | null) => void;
};

export const useSessionStore = create<SessionState>((set) => ({
	session: null,
	user: null,
	role: null,
	tenantId: null,
	businessId: null,
	setSession: (session) => {
		set({
			session,
			user: session?.user ?? null,
			role: (session?.user?.app_metadata?.role as string | undefined) ?? null,
			tenantId: session?.user?.id ?? null,
			businessId: null,
		});
	},
	clearSession: () => {
		set({ session: null, user: null, role: null, tenantId: null, businessId: null });
	},
	setBusinessId: (businessId) => {
		set({ businessId });
	},
}));
