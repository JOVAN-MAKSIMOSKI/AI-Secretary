import { useEffect, useState } from "react";

import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { supabase } from "../connection/supabase-client";
import { useAppContextStore } from "../store/app-context";
import { useSessionStore } from "../store/session";

export function useSession() {
  const [session, setSession] = useState<Session | null>(useSessionStore.getState().session);
  const [loading, setLoading] = useState(true);
  const setStoredSession = useSessionStore((state) => state.setSession);
  const clearStoredSession = useSessionStore((state) => state.clearSession);
  const setStoredBusinessId = useSessionStore((state) => state.setBusinessId);
  const setAppContext = useAppContextStore((state) => state.setContext);
  const clearAppContext = useAppContextStore((state) => state.clearContext);
  const setAppContextLoading = useAppContextStore((state) => state.setLoading);

  useEffect(() => {
    let isMounted = true;
    setAppContextLoading(true);
    const loadingFailsafe = window.setTimeout(() => {
      if (isMounted) {
        setLoading(false);
        setAppContextLoading(false);
      }
    }, 5000);

    const bootstrapSession = async () => {
      try {
        const { data } = await supabase.auth.getSession();

        if (!isMounted) {
          return;
        }

        setSession(data.session);
        setStoredSession(data.session);

        if (data.session?.user?.id) {
          setStoredBusinessId(null);
          setAppContext({
            userId: data.session.user.id,
            userEmail: data.session.user.email ?? null,
            businessId: null,
            isAuthenticated: true,
          });
        } else {
          setStoredBusinessId(null);
          clearAppContext();
        }
      } catch {
        if (isMounted) {
          setSession(null);
          setStoredBusinessId(null);
          clearStoredSession();
          clearAppContext();
        }
      } finally {
        window.clearTimeout(loadingFailsafe);
        if (isMounted) {
          setLoading(false);
          setAppContextLoading(false);
        }
      }
    };

    void bootstrapSession();

    const { data: subscription } = supabase.auth.onAuthStateChange(async (
      _event: AuthChangeEvent,
      nextSession: Session | null
    ) => {
      try {
        setSession(nextSession);

        if (nextSession) {
          setStoredSession(nextSession);
          setStoredBusinessId(null);
          setAppContext({
            userId: nextSession.user.id,
            userEmail: nextSession.user.email ?? null,
            businessId: null,
            isAuthenticated: true,
          });
        } else {
          setStoredBusinessId(null);
          clearStoredSession();
          clearAppContext();
        }
      } finally {
        setLoading(false);
        setAppContextLoading(false);
      }
    });

    return () => {
      isMounted = false;
      window.clearTimeout(loadingFailsafe);
      subscription.subscription.unsubscribe();
    };
  }, [
    clearAppContext,
    clearStoredSession,
    setAppContext,
    setAppContextLoading,
    setStoredBusinessId,
    setStoredSession,
  ]);

  return {
    session,
    user: session?.user ?? null,
    loading,
    isAuthenticated: Boolean(session?.user),
  };
}
