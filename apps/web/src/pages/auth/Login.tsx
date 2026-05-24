import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signInWithPasswordGrant } from "../../connection/supabase-client";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";

export default function Login() {
  const navigate = useNavigate();
  const setStoredSession = useSessionStore((state) => state.setSession);
  const setStoredBusinessId = useSessionStore((state) => state.setBusinessId);
  const setAppContext = useAppContextStore((state) => state.setContext);
  const setAppContextLoading = useAppContextStore((state) => state.setLoading);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrorMessage("");

    try {
      const session = await signInWithPasswordGrant(email, password);

      if (!session) {
        throw new Error("Sign-in succeeded but no session was returned.");
      }

      setStoredSession(session);
      setStoredBusinessId(null);
      setAppContext({
        userId: session.user.id,
        userEmail: session.user.email ?? null,
        businessId: null,
        isAuthenticated: true,
      });
      setAppContextLoading(false);

      navigate("/portal/dashboard");
    } catch (err) {
      const error = err as { message?: string; code?: string; status?: number };
      const details = [error.code ? `code ${error.code}` : null, typeof error.status === "number" ? `status ${error.status}` : null]
        .filter(Boolean)
        .join(", ");
      setErrorMessage(details ? `${error.message ?? "Login failed."} (${details})` : error.message ?? "Login failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#f8f2e8,_#efe7da_45%,_#e1d6c4)] px-4 py-10 text-slate-900">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-5xl overflow-hidden rounded-[2rem] border border-white/60 bg-white/70 shadow-[0_24px_80px_-24px_rgba(15,23,42,0.35)] backdrop-blur">
        <section className="hidden w-1/2 flex-col justify-between bg-slate-950 p-10 text-white lg:flex">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-amber-300/90">AI Secretary</p>
            <h1 className="mt-6 max-w-md text-5xl font-semibold leading-tight">
              Welcome back.
              <br />
              Sign in to continue.
            </h1>
            <p className="mt-6 max-w-md text-base leading-7 text-slate-300">
              Access your workspace, review requests, and keep your assistant connected.
            </p>
          </div>

          <div className="max-w-sm rounded-3xl border border-white/10 bg-white/5 p-6 text-sm leading-6 text-slate-300">
            Simple access for the portal and admin tools with Supabase Auth.
          </div>
        </section>

        <section className="flex w-full items-center justify-center p-6 sm:p-10 lg:w-1/2">
          <form onSubmit={handleSubmit} className="w-full max-w-md space-y-6">
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.3em] text-slate-500">Login</p>
              <h2 className="mt-3 text-3xl font-semibold text-slate-950">Sign in to your account</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Use your email and password to access the workspace.
              </p>
            </div>

            <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-700">Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="h-12 w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 text-sm outline-none transition focus:border-slate-900 focus:bg-white"
                  required
                />
              </label>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-700">Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                  className="h-12 w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 text-sm outline-none transition focus:border-slate-900 focus:bg-white"
                  required
                />
              </label>

              {errorMessage ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {errorMessage}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={loading}
                className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {loading ? "Signing in..." : "Sign in"}
              </button>

              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>Need help accessing your account?</span>
                <Link to="/signup" className="font-medium text-slate-900 hover:underline">
                  Create account
                </Link>
              </div>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
