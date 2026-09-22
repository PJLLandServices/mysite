import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { NAV } from "./nav";
import { cx } from "../ui/primitives";

/* The application shell. One responsive frame every workspace renders
   into: a persistent rail on desktop, a drawer on phones, and a single
   title bar that always says where you are. The old product had each
   page carry its own copy of the sidebar markup; there is exactly one
   here. */

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="px-3 py-4 space-y-6" aria-label="Main">
      {NAV.map((section) => (
        <div key={section.label}>
          <p className="px-3 mb-1.5 font-display text-[11px] font-semibold uppercase tracking-[0.1em] text-white/45">
            {section.label}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to + item.label}>
                {item.legacy ? (
                  <a
                    href={item.to}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-3 py-2.5 text-sm text-white/70 hover:bg-white/10 hover:text-white"
                  >
                    {item.label}
                    {/* Marks a destination still served by the old CRM, so it
                        is obvious what has and hasn't been rebuilt yet. */}
                    <span className="font-display text-[10px] uppercase tracking-[0.08em] text-white/35">classic</span>
                  </a>
                ) : (
                  <NavLink
                    to={item.to}
                    end={item.to === "/app"}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        "block rounded-[var(--radius-control)] px-3 py-2.5 text-sm transition-colors",
                        isActive ? "bg-white/15 text-white font-semibold" : "text-white/70 hover:bg-white/10 hover:text-white"
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Any route change closes the phone drawer — nothing is more annoying
  // than tapping through and landing behind an open menu.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      {/* Desktop rail */}
      <aside className="hidden lg:flex lg:flex-col bg-brand-950 sticky top-0 h-dvh overflow-y-auto">
        <Link to="/app" className="flex items-center gap-2.5 px-5 py-5 border-b border-white/10">
          <img src="/crm/pjl-logo.svg" alt="" className="h-7 w-auto" />
          <span className="font-display text-[15px] font-semibold uppercase tracking-[0.1em] text-white">PJL</span>
        </Link>
        <NavList />
        <div className="mt-auto px-5 py-4 border-t border-white/10">
          <a href="/admin" className="text-[13px] text-white/50 hover:text-white/80">
            ← Classic CRM
          </a>
        </div>
      </aside>

      {/* Phone / tablet drawer */}
      {drawerOpen ? (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-brand-950/60" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <aside className="relative w-[272px] max-w-[82vw] bg-brand-950 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <span className="font-display text-[15px] font-semibold uppercase tracking-[0.1em] text-white">PJL</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="min-h-11 min-w-11 -mr-2 text-2xl leading-none text-white/70 hover:text-white"
              >
                ×
              </button>
            </div>
            <NavList onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="min-w-0 flex flex-col">
        {/* Mobile title bar */}
        <header className="lg:hidden sticky top-0 z-40 flex items-center gap-3 bg-brand-950 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            aria-expanded={drawerOpen}
            className="min-h-11 min-w-11 flex flex-col items-center justify-center gap-1.5"
          >
            <span className="block h-0.5 w-5 bg-white" />
            <span className="block h-0.5 w-5 bg-white" />
            <span className="block h-0.5 w-5 bg-white" />
          </button>
          <span className="font-display text-[15px] font-semibold uppercase tracking-[0.1em] text-white">PJL</span>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

/* Every workspace screen opens with this: where you are, what it is,
   and the action that matters — in one band, at a fixed height, so the
   page below it starts in the same place every time. */
export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
  backTo,
  backLabel
}: {
  eyebrow?: string;
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="bg-surface border-b border-line">
      <div className="mx-auto max-w-[1180px] px-4 py-4 lg:px-8 lg:py-5">
        {backTo ? (
          <Link to={backTo} className="inline-block mb-2 text-[13px] font-medium text-brand-700 hover:text-brand-800">
            ← {backLabel || "Back"}
          </Link>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {eyebrow ? (
              <p className="font-display text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">{eyebrow}</p>
            ) : null}
            <h1 className="font-display text-[26px] lg:text-[30px] font-bold leading-tight text-ink truncate">{title}</h1>
            {meta ? <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-muted">{meta}</div> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function PageBody({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[1180px] px-4 py-5 lg:px-8 lg:py-7">{children}</div>;
}
