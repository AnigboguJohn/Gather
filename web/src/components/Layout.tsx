/** Layout pieces for signed-in pages: logo, navigation (sidebar / phone tab bar), page titles and initials avatars. */
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { colorFor, initials } from "../lib/format";
import { Icon } from "./Icon";
import { Onboarding } from "./Onboarding";
import { SignOutButton } from "./SignOut";

/** The Gather logo mark + wordmark. `light` = white text for dark backgrounds. */
export function Logo({ light }: { light?: boolean }) {
  return (
    <span className={`flex items-center gap-2 text-lg font-extrabold tracking-tight ${light ? "text-white" : "text-brand-900"}`}>
      <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#064e3b" /><circle cx="22" cy="26" r="7" fill="#34d399" /><circle cx="42" cy="26" r="7" fill="#f6a35c" /><path d="M12 48c2-8 8-12 14-12s10 3 12 8c2-5 6-8 12-8" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" /></svg>
      Gather
    </span>
  );
}

// Main navigation for signed-in hosts (sidebar on desktop, bottom bar on phones).
export const NAV = [
  { to: "/home", label: "Meetings", icon: "home" },
  { to: "/past", label: "History", icon: "history" },
  { to: "/search", label: "Ask", icon: "sparkle" },
  { to: "/team", label: "Team", icon: "team" },
  { to: "/billing", label: "Plan", icon: "card" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

/** App shell for signed-in pages: desktop sidebar, phone header + bottom tab bar, and the page in <Outlet/>. */
export function Layout() {
  const { me } = useAuth();
  return (
    <div className="min-h-full pb-20 md:pb-0 md:pl-60 print:p-0">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 print:!hidden flex-col border-r border-stone-200 bg-white px-4 py-5 md:flex">
        <div className="px-2"><Logo /></div>
        <nav className="mt-8 space-y-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} data-tour={`nav-${n.to.slice(1)}`} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium ${isActive ? "bg-brand-50 text-brand-800" : "text-stone-600 hover:bg-stone-100"}`}>
              <Icon name={n.icon} size={18} />{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto rounded-2xl bg-stone-50 p-3 text-sm">
          <p className="truncate font-semibold">{me?.user.name}</p>
          <p className="truncate text-xs text-stone-500">{me?.org.name} · {me?.plan.name}</p>
          <SignOutButton className="mt-2 flex items-center gap-2 text-xs font-medium text-stone-600 hover:text-red-600"><Icon name="logout" size={14} />Log out</SignOutButton>
        </div>
      </aside>
      {/* Phone header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-stone-200 bg-white/90 px-4 py-3 backdrop-blur md:hidden print:hidden">
        <Logo />
        <span className="text-xs font-medium text-stone-500">{me?.plan.name} plan</span>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-10"><Outlet /></main>
      {/* Welcome guide on a new person's first sign-in (and from Settings → Take the tour) */}
      <Onboarding />
      {/* Phone bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 print:hidden border-t border-stone-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} data-tour={`nav-${n.to.slice(1)}`} className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${isActive ? "text-brand-700" : "text-stone-500"}`}>
            <Icon name={n.icon} size={20} />{n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** A person's initials on a coloured rounded square (faces on the dashboard's meeting cards). */
export function Initials({ name, size = 40 }: { name: string; size?: number }) {
  return <span className="flex shrink-0 items-center justify-center rounded-xl font-bold text-white" style={{ width: size, height: size, background: colorFor(name), fontSize: size * 0.36 }}>{initials(name)}</span>;
}

/** Page heading with an optional subtitle and an action button on the right. */
export function PageTitle({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-stone-900 md:text-3xl">{title}</h1>
        {sub && <p className="mt-1 text-stone-500">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
