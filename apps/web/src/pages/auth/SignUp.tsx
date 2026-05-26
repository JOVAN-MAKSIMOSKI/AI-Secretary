import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { registerBusinessAccount, signInWithPasswordGrant } from "../../connection/supabase-client";
import { useAppContextStore } from "../../store/app-context";
import { useSessionStore } from "../../store/session";

export default function SignUp() {
	const navigate = useNavigate();
	const setStoredSession = useSessionStore((state) => state.setSession);
	const setStoredBusinessId = useSessionStore((state) => state.setBusinessId);
	const setAppContext = useAppContextStore((state) => state.setContext);
	const setAppContextLoading = useAppContextStore((state) => state.setLoading);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [phone, setPhone] = useState("");
	const [address, setAddress] = useState("");
	const [logoUrl, setLogoUrl] = useState("");
	const [loading, setLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const [successMessage, setSuccessMessage] = useState("");

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setErrorMessage("");
		setSuccessMessage("");

		if (password !== confirmPassword) {
			setErrorMessage("Passwords do not match.");
			return;
		}

		setLoading(true);

		try {
			await registerBusinessAccount({
				name,
				email,
				password,
				phone: phone.trim() ? phone : null,
				address: address.trim() ? address : null,
			});

			const session = await signInWithPasswordGrant(email, password);

			if (!session) {
				throw new Error("Account created but sign-in did not return a session.");
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
			setErrorMessage(details ? `${error.message ?? "Account creation failed."} (${details})` : error.message ?? "Account creation failed.");
		} finally {
			setLoading(false);
		}
	};

	return (
		<main className="min-h-screen bg-[radial-gradient(circle_at_top,_#ffffff,_#f7f8fa_45%,_#eaf0f3)] px-4 py-10 text-[var(--brand-ink)]">
			<div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-5xl overflow-hidden rounded-[2rem] border border-[var(--brand-border)] bg-[var(--brand-card)]/90 shadow-[0_24px_80px_-24px_rgba(15,25,35,0.24)] backdrop-blur">
				<section className="hidden w-1/2 flex-col justify-between bg-[var(--brand-slate)] p-10 text-white lg:flex">
					<div>
						<p className="text-sm uppercase tracking-[0.35em] text-[#8ccdc1]">AI Secretary</p>
						<h1 className="mt-6 max-w-md text-5xl font-medium leading-tight tracking-[-0.02em]">
							Create your workspace.
							<br />
							Get started in seconds.
						</h1>
						<p className="mt-6 max-w-md text-base leading-7 text-[#b8c3d1]">
							Add your business details so the assistant can identify your account and keep your
							profile organized.
						</p>
					</div>

					<div className="max-w-sm rounded-2xl border border-white/10 bg-white/5 p-6 text-sm leading-6 text-[#b8c3d1]">
						Required fields: name, email, phone, and address. Logo URL is optional.
					</div>
				</section>

				<section className="flex w-full items-center justify-center p-6 sm:p-10 lg:w-1/2">
					<form onSubmit={handleSubmit} className="w-full max-w-md space-y-6">
						<div>
							<p className="text-sm font-medium uppercase tracking-[0.3em] text-[var(--brand-text-muted)]">Sign up</p>
							<h2 className="mt-3 text-3xl font-medium tracking-[-0.02em] text-[var(--brand-ink)]">Create your account</h2>
							<p className="mt-2 text-sm leading-6 text-[var(--brand-text-muted)]">
								Fill in your details to set up your profile.
							</p>
						</div>

						<div className="space-y-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-6 shadow-sm">
							<label className="block space-y-2">
								<span className="text-sm font-medium text-[var(--brand-ink)]">Password</span>
								<input
									type="password"
									autoComplete="new-password"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									placeholder="Create a password"
									className="h-12 w-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
									required
								/>
							</label>

							<label className="block space-y-2">
								<span className="text-sm font-medium text-[var(--brand-ink)]">Confirm Password</span>
								<input
									type="password"
									autoComplete="new-password"
									value={confirmPassword}
									onChange={(event) => setConfirmPassword(event.target.value)}
									placeholder="Repeat your password"
									className="h-12 w-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
									required
								/>
							</label>

							<label className="block space-y-2">
								<span className="text-sm font-medium text-[var(--brand-ink)]">Name</span>
								<input
									type="text"
									autoComplete="name"
									value={name}
									onChange={(event) => setName(event.target.value)}
									placeholder="Your full name"
									className="h-12 w-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
									required
								/>
							</label>

							<label className="block space-y-2">
								<span className="text-sm font-medium text-[var(--brand-ink)]">Email</span>
								<input
									type="email"
									autoComplete="email"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									placeholder="you@example.com"
									className="h-12 w-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
									required
								/>
							</label>

							<label className="block space-y-2">
								<span className="text-sm font-medium text-[var(--brand-ink)]">Phone</span>
								<input
									type="tel"
									autoComplete="tel"
									value={phone}
									onChange={(event) => setPhone(event.target.value)}
									placeholder="+1 555 123 4567"
									className="h-12 w-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
									required
								/>
							</label>

							<label className="block space-y-2">
								<span className="text-sm font-medium text-[var(--brand-ink)]">Address</span>
								<textarea
									value={address}
									onChange={(event) => setAddress(event.target.value)}
									placeholder="Street, city, state, country"
									rows={4}
									className="w-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
									required
								/>
							</label>

							<label className="block space-y-2">
								<span className="text-sm font-medium text-[var(--brand-ink)]">Logo URL optional</span>
								<input
									type="url"
									autoComplete="url"
									value={logoUrl}
									onChange={(event) => setLogoUrl(event.target.value)}
									placeholder="https://example.com/logo.png"
									className="h-12 w-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 text-sm outline-none transition focus:border-[var(--brand-teal)] focus:bg-white"
								/>
							</label>

							{errorMessage ? (
								<div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
									{errorMessage}
								</div>
							) : null}

							{successMessage ? (
								<div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
									{successMessage}
								</div>
							) : null}

							<button
								type="submit"
								disabled={loading}
								className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-[var(--brand-teal)] px-5 text-sm font-medium text-white transition hover:bg-[#2f8575] disabled:cursor-not-allowed disabled:opacity-70"
							>
								{loading ? "Creating account..." : "Create account"}
							</button>

							<div className="flex items-center justify-between text-sm text-[var(--brand-text-muted)]">
								<span>Already have an account?</span>
								<Link to="/login" className="font-medium text-[var(--brand-ink)] hover:text-[var(--brand-teal)] hover:underline">
									Sign in
								</Link>
							</div>
						</div>
					</form>
				</section>
			</div>
		</main>
	);
}
