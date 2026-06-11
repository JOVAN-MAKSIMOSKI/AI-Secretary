import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { supabase } from "../connection/supabase-client";
import { Brain, CalendarDays, CircleHelp, FileText, LayoutDashboard, Settings, Sparkles, Users } from "lucide-react";

const navItems = [
  { label: "Dashboard", to: "/portal/dashboard", icon: LayoutDashboard },
  { label: "Clients", to: "/portal/clients", icon: Users },
  { label: "Documents", to: "/portal/documents", icon: FileText },
  { label: "Calendar", to: "/portal/calendar", icon: CalendarDays },
  { label: "Law Questions", to: "/portal/law-questions", icon: Brain },
  { label: "Settings", to: "/portal/settings", icon: Settings },
];

export default function PortalLayout() {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate("/login");
  };

  return (
    <div className="h-screen bg-[var(--brand-surface)] text-[var(--brand-ink)]">
      <header className="sticky top-0 z-20 border-b border-[var(--brand-border)] bg-[var(--brand-card)] px-4 py-3 md:hidden">
        <div className="mx-auto flex w-full items-center justify-between">
          <p className="text-lg font-medium tracking-[-0.01em] text-[var(--brand-ink)]">AI Secretary</p>
          <button
            type="button"
            onClick={() => setMobileOpen((value) => !value)}
            className="rounded-md border border-[var(--brand-border)] bg-[var(--brand-card)] px-3 py-2 text-xs font-medium uppercase tracking-[0.14em] text-[var(--brand-text-muted)]"
          >
            {mobileOpen ? "Close" : "Menu"}
          </button>
        </div>
      </header>

      <div className="grid h-[calc(100vh-57px)] w-full md:h-screen md:grid-cols-[250px_1fr]">
        <aside
          className={[
            "flex h-full flex-col overflow-y-auto border-r border-[var(--brand-border)] bg-[var(--brand-slate)] p-5",
            mobileOpen ? "block" : "hidden md:block",
          ].join(" ")}
        >
          <div className="mb-5 flex items-center gap-2.5">
            <div className="h-5 w-5 rounded-[5px] bg-[var(--brand-teal)]" />
            <p className="text-[15px] font-medium tracking-[-0.01em] text-white">Secretary</p>
          </div>

          <p className="px-2 text-[10px] font-medium uppercase tracking-[0.14em] text-[#4a5568]">Workspace</p>

          <nav className="mt-3 space-y-1">
            {navItems.map((item) => (
              <NavLink
                key={`${item.to}-${item.label}`}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  [
                    "flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium transition",
                    isActive
                      ? "rounded-md bg-[#2a3342] text-white"
                      : "rounded-md text-[#8b95a6] hover:bg-[#263041] hover:text-white",
                  ].join(" ")
                }
              >
                <item.icon size={16} />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <p className="mt-6 px-2 text-[10px] font-medium uppercase tracking-[0.14em] text-[#4a5568]">Assistant</p>

          <div className="mt-auto space-y-1 border-t border-[#2c3747] pt-4">
            <NavLink
              to="/portal/settings"
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                [
                  "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-[13px] transition",
                  isActive
                    ? "bg-[#2a3342] text-white"
                    : "text-[#8b95a6] hover:bg-[#263041] hover:text-white",
                ].join(" ")
              }
            >
              <Settings size={16} />
              Settings
            </NavLink>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-[13px] text-[#8b95a6] transition hover:bg-[#263041] hover:text-white"
            >
              <CircleHelp size={16} />
              Help &amp; support
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-[13px] text-[#8b95a6] transition hover:bg-[#263041] hover:text-white"
            >
              <Sparkles size={16} />
              Sign out
            </button>
          </div>
        </aside>

        <main className="min-w-0 h-full overflow-y-auto p-2.5 md:p-3">
          <div className="h-full rounded-lg border border-[var(--brand-border)] bg-[var(--brand-card)]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
