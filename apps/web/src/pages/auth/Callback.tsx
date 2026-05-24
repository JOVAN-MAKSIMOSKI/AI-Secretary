import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../connection/supabase-client";

export default function Callback() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("Completing sign-in...");

  useEffect(() => {
    let isMounted = true;

    const completeAuth = async () => {
      try {
        const code = new URLSearchParams(window.location.search).get("code");

        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            throw error;
          }
        }

        if (isMounted) {
          navigate("/portal/dashboard", { replace: true });
        }
      } catch (err) {
        const error = err as { message?: string; code?: string; status?: number };
        const details = [error.code ? `code ${error.code}` : null, typeof error.status === "number" ? `status ${error.status}` : null]
          .filter(Boolean)
          .join(", ");
        if (isMounted) {
          setMessage(details ? `${error.message ?? "Authentication callback failed."} (${details})` : error.message ?? "Authentication callback failed.");
        }
      }
    };

    void completeAuth();

    return () => {
      isMounted = false;
    };
  }, [navigate]);

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 text-slate-700">
      <div className="max-w-md rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.3em] text-slate-500">Auth</p>
        <h1 className="mt-3 text-xl font-semibold text-slate-950">{message}</h1>
      </div>
    </main>
  );
}
