import { useEffect, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { getUserBusiness, supabase } from "../connection/supabase-client";
import { useAppContextStore } from "../store/app-context";
import { useSessionStore } from "../store/session";

export function useSession() {
  const BUSINESS_LOOKUP_TIMEOUT_MS = 7000;
  const [session, setSession] = useState<Session | null>(useSessionStore.getState().session);
  const [businessId, setBusinessId] = useState<string | null>(useSessionStore.getState().businessId);
  const [loading, setLoading] = useState(true);
  const setStoredSession = useSessionStore((state) => state.setSession);
  const clearStoredSession = useSessionStore((state) => state.clearSession);
  const setStoredBusinessId = useSessionStore((state) => state.setBusinessId);
  const setAppContext = useAppContextStore((state) => state.setContext);
  const clearAppContext = useAppContextStore((state) => state.clearContext);
  const setAppContextLoading = useAppContextStore((state) => state.setLoading);

  const loadBusinessId = async (ownerAuthId: string): Promise<string | null> => {
    if (!ownerAuthId) {
      setBusinessId(null);
      setStoredBusinessId(null);
      return null;
    }

    try {
      const lookupPromise = getUserBusiness();

      const timeoutPromise = new Promise<never>((_, reject) => {
        window.setTimeout(() => {
          reject(new Error(`Business lookup timed out after ${BUSINESS_LOOKUP_TIMEOUT_MS / 1000}s.`));
        }, BUSINESS_LOOKUP_TIMEOUT_MS);
      });

      const business = await Promise.race([lookupPromise, timeoutPromise]);

      if (business?.business_id) {
        setBusinessId(business.business_id);
        setStoredBusinessId(business.business_id);
        return business.business_id;
      }
    } catch {
      // Keep auth flow moving even if business lookup fails or times out.
    }

    setBusinessId(null);
    setStoredBusinessId(null);
    return null;
  };

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
          const resolvedBusinessId = await loadBusinessId(data.session.user.id);
          setAppContext({
            userId: data.session.user.id,
            userEmail: data.session.user.email ?? null,
            businessId: resolvedBusinessId,
            isAuthenticated: true,
          });
        } else {
          setBusinessId(null);
          setStoredBusinessId(null);
          clearAppContext();
        }
      } catch {
        if (isMounted) {
          setSession(null);
          setBusinessId(null);
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
          const resolvedBusinessId = await loadBusinessId(nextSession.user.id);
          setAppContext({
            userId: nextSession.user.id,
            userEmail: nextSession.user.email ?? null,
            businessId: resolvedBusinessId,
            isAuthenticated: true,
          });
        } else {
          setBusinessId(null);
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
    businessId,
    loading,
    isAuthenticated: Boolean(session?.user),
  };
}
