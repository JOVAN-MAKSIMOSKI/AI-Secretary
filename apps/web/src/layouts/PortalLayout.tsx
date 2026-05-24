import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { supabase } from "../connection/supabase-client";
import { CalendarDays, CircleHelp, FileText, LayoutDashboard, Settings, Sparkles, Users } from "lucide-react";

const navItems = [
  { label: "Dashboard", to: "/portal/dashboard", icon: LayoutDashboard },
  { label: "Clients", to: "/portal/clients", icon: Users },
  { label: "Documents", to: "/portal/documents", icon: FileText },
  { label: "Calendar", to: "/portal/calendar", icon: CalendarDays },
];

export default function PortalLayout() {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate("/login");
  };

  return (
    <div className="h-screen bg-[#f3f4f8] text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <div className="mx-auto flex w-full items-center justify-between">
          <p className="text-xl font-semibold text-slate-900">AI Secretary</p>
          <button
            type="button"
            onClick={() => setMobileOpen((value) => !value)}
            className="border border-slate-300 bg-white px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] text-slate-700"
          >
            {mobileOpen ? "Close" : "Menu"}
          </button>
        </div>
      </header>

      <div className="grid h-[calc(100vh-57px)] w-full md:h-screen md:grid-cols-[340px_1fr]">
        <aside
          className={[
            "flex h-full flex-col overflow-y-auto border-r border-slate-200 bg-[#f8f8fb] p-6",
            mobileOpen ? "block" : "hidden md:block",
          ].join(" ")}
        >
          <p className="text-[13px] font-medium text-slate-400">Menu</p>

          <nav className="mt-3 space-y-1">
            {navItems.map((item) => (
              <NavLink
                key={`${item.to}-${item.label}`}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                className={() =>
                  [
                    "flex items-center gap-3.5 px-3.5 py-3 text-[16px] font-medium text-slate-600 transition",
                    "bg-transparent hover:bg-[#ddd7ec] hover:text-slate-900",
                  ].join(" ")
                }
              >
                <item.icon size={19} />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto space-y-1 border-t border-slate-200 pt-5">
            <button type="button" className="flex w-full items-center gap-3.5 px-3.5 py-3 text-[15px] text-slate-600 hover:bg-slate-100">
              <Settings size={18} />
              Settings
            </button>
            <button type="button" className="flex w-full items-center gap-3.5 px-3.5 py-3 text-[15px] text-slate-600 hover:bg-slate-100">
              <CircleHelp size={18} />
              Help &amp; support
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="flex w-full items-center gap-3.5 px-3.5 py-3 text-[15px] text-slate-600 hover:bg-slate-100"
            >
              <Sparkles size={18} />
              Sign out
            </button>
          </div>
        </aside>

        <main className="min-w-0 h-full overflow-y-auto p-2.5 md:p-3">
          <div className="h-full border border-slate-200 bg-white">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
