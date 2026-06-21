import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAppContextStore } from "../store/app-context";

type GuardProps = {
	children: ReactNode;
};

function GuardLoading() {
	return (
		<div className="grid min-h-screen place-items-center bg-slate-100 text-slate-600">
			<p className="text-sm">Loading session...</p>
		</div>
	);
}

export function RequireAuth({ children }: GuardProps) {
	const isAuthenticated = useAppContextStore((state) => state.isAuthenticated);
	const loading = useAppContextStore((state) => state.loading);

	if (loading) {
		return <GuardLoading />;
	}

	if (!isAuthenticated) {
		return <Navigate to="/login" replace />;
	}

	return children;
}

export function PublicOnly({ children }: GuardProps) {
	const isAuthenticated = useAppContextStore((state) => state.isAuthenticated);
	const loading = useAppContextStore((state) => state.loading);

	if (loading) {
		return <GuardLoading />;
	}

	if (isAuthenticated) {
		return <Navigate to="/portal/dashboard" replace />;
	}

	return children;
}

export function RequireAdmin({ children }: GuardProps) {
	const isAuthenticated = useAppContextStore((state) => state.isAuthenticated);
	const loading = useAppContextStore((state) => state.loading);
	const isAdmin = useAppContextStore((state) => (state as { isAdmin?: boolean }).isAdmin ?? false);

	if (loading) {
		return <GuardLoading />;
	}

	if (!isAuthenticated) {
		return <Navigate to="/login" replace />;
	}

	if (!isAdmin) {
		return <Navigate to="/portal/dashboard" replace />;
	}

	return children;
}
