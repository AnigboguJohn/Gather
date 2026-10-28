/**
 * Admin panel ("/admin") for the people who run Gather. Its own sign-in (platform admin accounts, not workspace
 * owners); the admin token lives in this tab only (sessionStorage).
 * Tabs: Overview (numbers, sign-ups chart, recent activity) · People (search, suspend, delete) ·
 * Workspaces (give or remove a plan, delete) · Meetings (live now with "End call", recent calls) · Payments ·
 * Reviews (score, every review with who wrote it, hide or show on the public pages).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Layout";
import { Badge, Spinner, confirmToast, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { fmtDate, fmtTime, naira } from "../lib/format";
import { ScoreSummary, Stars, WORDS, type ReviewSummary } from "../components/Reviews";
import { ErrorNote, field, PasswordInput } from "./AuthKit";

const KEY = "gather.admin";
const getAdmin = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const setAdmin = (t: string | null) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } };
type Tab = "overview" | "people" | "workspaces" | "meetings" | "payments" | "reviews";

export default function Admin() {
  const [token, setToken] = useState(getAdmin);
  const [me, setMe] = useState<{ email: string; name: string } | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  /** Admin API call; an expired admin sign-in returns to the sign-in form. */
  const call = async <T,>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> => {
    try { return await api<T>(path, { ...opts, token }); }
    catch (e) { if ((e as ApiError).status === 401) { setAdmin(null); setToken(null); } throw e; }
  };
  useEffect(() => { if (token) call<{ email: string; name: string }>("/admin/me").then(setMe).catch(() => {}); }, [token]);
  if (!token) return <AdminSignIn onDone={(t) => { setAdmin(t); setToken(t); }} />;
  const tabs: [Tab, string, string][] = [["overview", "Overview", "grid"], ["people", "People", "users"], ["workspaces", "Workspaces", "team"], ["meetings", "Meetings", "cam"], ["payments", "Payments", "card"], ["reviews", "Reviews", "star"]];

  return (
    <div className="min-h-full bg-stone-100">
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-5 py-3">
          <Logo /><span className="rounded-md bg-stone-900 px-2 py-0.5 text-xs font-bold text-white">ADMIN</span>
          <nav className="no-scrollbar ml-4 hidden flex-1 gap-1 overflow-x-auto md:flex">
            {tabs.map(([id, l, i]) => <button key={id} onClick={() => setTab(id)} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${tab === id ? "bg-brand-50 text-brand-800" : "text-stone-600 hover:bg-stone-100"}`}><Icon name={i} size={16} />{l}</button>)}
          </nav>
          <span className="ml-auto hidden text-sm text-stone-500 sm:block">{me?.email}</span>
          <button onClick={() => { setAdmin(null); setToken(null); }} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"><Icon name="logout" size={16} />Log out</button>
        </div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
          {tabs.map(([id, l]) => <button key={id} onClick={() => setTab(id)} className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold ${tab === id ? "bg-brand-50 text-brand-800" : "text-stone-600"}`}>{l}</button>)}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-8">
        {tab === "overview" && <Overview call={call} go={setTab} />}
        {tab === "people" && <People call={call} />}
        {tab === "workspaces" && <Workspaces call={call} />}
        {tab === "meetings" && <Meetings call={call} />}
        {tab === "payments" && <Payments call={call} />}
        {tab === "reviews" && <Reviews call={call} />}
      </main>
    </div>
  );
}
type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

function AdminSignIn({ onDone }: { onDone: (token: string) => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex min-h-full items-center justify-center bg-stone-900 p-5">
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { const r = await api<{ token: string }>("/admin/login", { body: { email, password }, token: null }); onDone(r.token); }
        catch (err) { setError((err as ApiError).message); setBusy(false); }
      }} className="w-full max-w-sm space-y-4 rounded-3xl bg-white p-8 shadow-2xl">
        <div className="flex items-center gap-2"><Logo /><span className="rounded-md bg-stone-900 px-2 py-0.5 text-xs font-bold text-white">ADMIN</span></div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin sign-in</h1>
        <label className="block"><span className="mb-1.5 block text-sm font-medium text-stone-700">Admin email</span>
          <input type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={field} /></label>
        <label className="block"><span className="mb-1.5 block text-sm font-medium text-stone-700">Password</span>
          <PasswordInput required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <ErrorNote error={error} />
        <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-stone-900 py-3.5 text-sm font-semibold text-white hover:bg-stone-800 disabled:opacity-60">{busy && <Spinner size={16} />}Sign in</button>
        <Link to="/" className="block text-center text-xs text-stone-500 hover:text-stone-800">← Back to Gather</Link>
      </form>
    </div>
  );
}

/** Fetch once (and again after `reload()`); shows a spinner meanwhile. */
function useData<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { load().then(setData).catch((e) => toast((e as ApiError).message, "error")); }, [n, ...deps]);
  return [data, () => setN((x) => x + 1)] as const;
}
const Card = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <div className={`rounded-2xl border border-stone-200 bg-white p-5 shadow-sm ${className}`}>{children}</div>;
const Loading = () => <div className="py-16 text-center text-brand-700"><Spinner /></div>;
const Search = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) => (
  <div className="flex w-full items-center gap-2 rounded-xl border border-stone-200 bg-white px-3.5 py-2.5 sm:w-80"><Icon name="search" size={16} className="text-stone-400" />
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full bg-transparent text-sm outline-none" /></div>
);
const planBadge = (p: string) => <Badge tone={p === "free" ? "stone" : p === "pro" ? "green" : "blue"}>{p[0].toUpperCase() + p.slice(1)}</Badge>;

/* ------------------------------------------------------------------ Overview */
function Overview({ call, go }: { call: Call; go: (t: Tab) => void }) {
  const [d] = useData(() => call<any>("/admin/overview"));
  if (!d) return <Loading />;
  const max = Math.max(1, ...d.signups.map((s: any) => s.n));
  const stats: [string, string | number, string, Tab][] = [
    ["People", d.users, `${d.pending_invites} invites pending · ${d.suspended} suspended`, "people"],
    ["Workspaces", d.workspaces, `${d.paying} on a paid plan`, "workspaces"],
    ["Live now", d.live, `${d.calls_today} calls in the last 24 h`, "meetings"],
    ["Revenue", naira(d.revenue_minor), d.demo_minor ? `plus ${naira(d.demo_minor)} demo payments` : "real payments only", "payments"],
  ];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([l, v, sub, t]) => (
          <button key={l} onClick={() => go(t)} className="rounded-2xl border border-stone-200 bg-white p-5 text-left shadow-sm transition hover:border-brand-300">
            <p className="text-sm text-stone-500">{l}</p><p className="mt-1 text-3xl font-semibold tracking-tight">{v}</p><p className="mt-1 text-xs text-stone-500">{sub}</p>
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <div className="flex items-baseline justify-between"><h2 className="font-semibold">New people, last 14 days</h2><span className="text-sm text-stone-500">{d.signups.reduce((a: number, s: any) => a + s.n, 0)} total</span></div>
          <div className="mt-5 flex h-40 items-end gap-1.5">
            {d.signups.map((s: any) => (
              <div key={s.day} className="group flex flex-1 flex-col items-center gap-1" title={`${s.day}: ${s.n}`}>
                <span className="text-[10px] text-stone-500 opacity-0 group-hover:opacity-100">{s.n}</span>
                <div className="w-full rounded-t-md bg-brand-500" style={{ height: `${(s.n / max) * 100}%`, minHeight: s.n ? 4 : 2, opacity: s.n ? 1 : 0.25 }} />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-stone-400"><span>{d.signups[0]?.day}</span><span>Today</span></div>
        </Card>
        <Card>
          <h2 className="font-semibold">Total activity</h2>
          <dl className="mt-3 divide-y divide-stone-100 text-sm">
            {[["Meetings created", d.meetings], ["People who joined calls", d.attendees], ["Calls in the last 24 h", d.calls_today]].map(([k, v]) => <div key={k as string} className="flex justify-between py-2.5"><dt className="text-stone-500">{k}</dt><dd className="font-semibold">{v}</dd></div>)}
          </dl>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><h2 className="mb-3 font-semibold">Newest people</h2>
          {!d.recentUsers.length ? <p className="text-sm text-stone-500">Nobody yet.</p> : <ul className="divide-y divide-stone-100 text-sm">{d.recentUsers.map((u: any) => <li key={u.id} className="flex justify-between gap-3 py-2.5"><span className="min-w-0"><b className="block truncate font-semibold">{u.name}</b><span className="block truncate text-stone-500">{u.email} · {u.org}</span></span><span className="shrink-0 text-xs text-stone-400">{fmtDate(u.created_at)}</span></li>)}</ul>}
        </Card>
        <Card><h2 className="mb-3 font-semibold">Latest payments</h2>
          {!d.recentPayments.length ? <p className="text-sm text-stone-500">No payments yet.</p> : <ul className="divide-y divide-stone-100 text-sm">{d.recentPayments.map((p: any) => <li key={p.reference} className="flex items-center justify-between gap-3 py-2.5"><span className="min-w-0"><b className="block truncate font-semibold">{p.org}</b><span className="text-stone-500">{p.plan} · {p.provider}</span></span><span className="flex items-center gap-2"><b>{naira(Number(p.amount_minor))}</b><Badge tone={p.status === "success" ? "green" : p.status === "failed" ? "red" : "stone"}>{p.status}</Badge></span></li>)}</ul>}
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ People */
function People({ call }: { call: Call }) {
  const [q, setQ] = useState("");
  const [rows, reload] = useData(() => call<any[]>(`/admin/users?q=${encodeURIComponent(q)}`), [q]);
  const suspend = async (u: any) => {
    const on = !u.suspended_at;
    if (on && !(await confirmToast(`Suspend ${u.name}? They'll be signed out and can't sign in.`, { confirm: "Suspend", danger: true }))) return;
    try { await call(`/admin/users/${u.id}`, { method: "PATCH", body: { suspended: on } }); toast(on ? `${u.name} suspended` : `${u.name} can sign in again`); reload(); } catch (e) { toast((e as ApiError).message, "error"); }
  };
  const remove = async (u: any) => {
    if (!(await confirmToast(`Delete ${u.name} (${u.email})? This can't be undone.`, { confirm: "Delete", danger: true }))) return;
    try { await call(`/admin/users/${u.id}`, { method: "DELETE" }); toast(`${u.name} deleted`); reload(); } catch (e) { toast((e as ApiError).message, "error"); }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold tracking-tight">People</h1><Search value={q} onChange={setQ} placeholder="Name, email, phone or workspace" /></div>
      {!rows ? <Loading /> : (
        <Card className="overflow-x-auto !p-0">
          <table className="w-full min-w-[54rem] text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500"><tr>{["Person", "Phone", "Workspace", "Role", "Meetings", "Joined", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-stone-100">
              {!rows.length && <tr><td colSpan={8} className="px-4 py-10 text-center text-stone-500">Nobody found.</td></tr>}
              {rows.map((u) => (
                <tr key={u.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3"><b className="block font-semibold">{u.name}</b><span className="text-stone-500">{u.email}</span></td>
                  <td className="px-4 py-3 text-stone-600">{u.phone ?? "—"}</td>
                  <td className="px-4 py-3">{u.org} <span className="ml-1">{planBadge(u.plan)}</span></td>
                  <td className="px-4 py-3 capitalize text-stone-600">{u.role}</td>
                  <td className="px-4 py-3 text-stone-600">{u.meetings}</td>
                  <td className="px-4 py-3 text-stone-500">{fmtDate(u.created_at)}</td>
                  <td className="px-4 py-3">{u.suspended_at ? <Badge tone="red">Suspended</Badge> : u.pending ? <Badge tone="amber">Invite pending</Badge> : <Badge tone="green">Active</Badge>}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <button onClick={() => suspend(u)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100">{u.suspended_at ? "Restore" : "Suspend"}</button>
                    <button onClick={() => remove(u)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Workspaces */
function Workspaces({ call }: { call: Call }) {
  const [q, setQ] = useState("");
  const [rows, reload] = useData(() => call<any[]>(`/admin/orgs?q=${encodeURIComponent(q)}`), [q]);
  const [plan, setPlan] = useState<Record<string, { plan: string; months: number }>>({});
  const apply = async (o: any) => {
    const p = plan[o.id] ?? { plan: "pro", months: 1 };
    try { await call(`/admin/orgs/${o.id}`, { method: "PATCH", body: p }); toast(p.plan === "free" ? `${o.name} is on Free` : `${o.name} now has ${p.plan === "pro" ? "Pro" : "Business"} for ${p.months} more month${p.months > 1 ? "s" : ""}`); reload(); } catch (e) { toast((e as ApiError).message, "error"); }
  };
  const remove = async (o: any) => {
    if (!(await confirmToast(`Delete the ${o.name} workspace, its ${o.members} people and ${o.meetings} meetings? This can't be undone.`, { confirm: "Delete", danger: true }))) return;
    try { await call(`/admin/orgs/${o.id}`, { method: "DELETE" }); toast(`${o.name} deleted`); reload(); } catch (e) { toast((e as ApiError).message, "error"); }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1><Search value={q} onChange={setQ} placeholder="Workspace name" /></div>
      {!rows ? <Loading /> : (
        <Card className="overflow-x-auto !p-0">
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500"><tr>{["Workspace", "Owner", "People", "Meetings", "Plan", "Change plan", ""].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-stone-100">
              {!rows.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-stone-500">No workspaces.</td></tr>}
              {rows.map((o) => {
                const p = plan[o.id] ?? { plan: "pro", months: 1 };
                return (
                  <tr key={o.id} className="hover:bg-stone-50">
                    <td className="px-4 py-3"><b className="block font-semibold">{o.name}</b><span className="text-xs text-stone-500">{o.kind} · {o.country} · since {fmtDate(o.created_at)}</span></td>
                    <td className="px-4 py-3 text-stone-600">{o.owner ?? "—"}</td>
                    <td className="px-4 py-3 text-stone-600">{o.members}</td>
                    <td className="px-4 py-3 text-stone-600">{o.meetings}</td>
                    <td className="px-4 py-3">{planBadge(o.effective)}{o.effective !== "free" && <span className="block text-xs text-stone-500">until {fmtDate(o.paid_until)}</span>}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <select value={p.plan} onChange={(e) => setPlan({ ...plan, [o.id]: { ...p, plan: e.target.value } })} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs"><option value="pro">Pro</option><option value="business">Business</option><option value="free">Free</option></select>
                        {p.plan !== "free" && <select value={p.months} onChange={(e) => setPlan({ ...plan, [o.id]: { ...p, months: Number(e.target.value) } })} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs">{[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m} mo</option>)}</select>}
                        <button onClick={() => apply(o)} className="rounded-lg bg-brand-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-800">Apply</button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right"><button onClick={() => remove(o)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">Delete</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Meetings */
function Meetings({ call }: { call: Call }) {
  const [d, reload] = useData(() => call<any>("/admin/meetings"));
  const end = async (m: any) => {
    if (!(await confirmToast(`End "${m.title}" for everyone in it?`, { confirm: "End call", danger: true }))) return;
    try { await call(`/admin/rooms/${m.slug}/end`, { method: "POST" }); toast("Call ended"); reload(); } catch (e) { toast((e as ApiError).message, "error"); }
  };
  if (!d) return <Loading />;
  const mins = (s: any) => s.ended_at ? Math.max(1, Math.round((+new Date(s.ended_at) - +new Date(s.started_at)) / 60000)) : null;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-semibold tracking-tight">Meetings</h1><button onClick={reload} className="flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm font-semibold hover:bg-stone-50"><Icon name="refresh" size={14} />Refresh</button></div>
      <Card>
        <h2 className="mb-3 flex items-center gap-2 font-semibold"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />Live now ({d.live.length})</h2>
        {!d.live.length ? <p className="text-sm text-stone-500">No calls running.</p> : <ul className="divide-y divide-stone-100 text-sm">{d.live.map((m: any) => (
          <li key={m.slug} className="flex flex-wrap items-center gap-3 py-3"><span className="min-w-0 flex-1"><b className="block font-semibold">{m.title}</b><span className="text-stone-500">{m.org} · host {m.host} · {m.info.people} in the call{m.info.waiting ? ` · ${m.info.waiting} waiting` : ""} · ends {fmtTime(new Date(m.info.endsAt))}</span></span>
            <button onClick={() => end(m)} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700">End call</button></li>
        ))}</ul>}
      </Card>
      <Card className="overflow-x-auto !p-0">
        <h2 className="px-5 pt-5 font-semibold">Recent calls</h2>
        <table className="mt-3 w-full min-w-[44rem] text-sm">
          <thead className="border-y border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500"><tr>{["Meeting", "Workspace", "Started", "Length", "People", "Summary"].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-stone-100">
            {!d.recent.length && <tr><td colSpan={6} className="px-4 py-10 text-center text-stone-500">No calls yet.</td></tr>}
            {d.recent.map((s: any) => <tr key={s.id}><td className="px-4 py-3 font-semibold">{s.title}</td><td className="px-4 py-3 text-stone-600">{s.org}</td><td className="px-4 py-3 text-stone-500">{fmtDate(s.started_at)}, {fmtTime(s.started_at)}</td><td className="px-4 py-3 text-stone-600">{mins(s) ? `${mins(s)} min` : <Badge tone="green">Live</Badge>}{s.end_reason === "time_limit" && <span className="ml-1 text-xs text-amber-700">time limit</span>}</td><td className="px-4 py-3 text-stone-600">{s.attendees}</td><td className="px-4 py-3 text-stone-500">{s.summary_status}</td></tr>)}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Payments */
function Payments({ call }: { call: Call }) {
  const [rows] = useData(() => call<any[]>("/admin/payments"));
  if (!rows) return <Loading />;
  const ok = rows.filter((p) => p.status === "success" && p.provider !== "demo");
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        {[["Real revenue", naira(ok.reduce((a, p) => a + Number(p.amount_minor), 0))], ["Successful payments", ok.length], ["Failed or abandoned", rows.filter((p) => p.status === "failed").length]].map(([l, v]) => <Card key={l as string}><p className="text-sm text-stone-500">{l}</p><p className="mt-1 text-2xl font-semibold">{v}</p></Card>)}
      </div>
      <Card className="overflow-x-auto !p-0">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500"><tr>{["Date", "Workspace", "Paid by", "Plan", "Method", "Amount", "Status"].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-stone-100">
            {!rows.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-stone-500">No payments yet.</td></tr>}
            {rows.map((p) => <tr key={p.reference}><td className="px-4 py-3 text-stone-500">{fmtDate(p.created_at)}</td><td className="px-4 py-3 font-semibold">{p.org}</td><td className="px-4 py-3 text-stone-600">{p.payer ?? "—"}</td><td className="px-4 py-3 capitalize">{p.plan} × {p.months}</td><td className="px-4 py-3 capitalize text-stone-600">{p.provider}</td><td className="px-4 py-3 font-semibold">{naira(Number(p.amount_minor))}</td><td className="px-4 py-3"><Badge tone={p.status === "success" ? "green" : p.status === "failed" ? "red" : "stone"}>{p.status}</Badge></td></tr>)}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Reviews */
function Reviews({ call }: { call: Call }) {
  const [d, reload] = useData(() => call<{ summary: ReviewSummary; asked: number; linksSent: number; reviews: any[] }>("/admin/reviews"));
  const [stars, setStars] = useState(0);
  if (!d) return <Loading />;
  const toggle = async (r: any) => {
    try { await call(`/admin/reviews/${r.id}`, { method: "PATCH", body: { hidden: !r.hidden } }); toast(r.hidden ? "Review shown on the public pages" : "Review hidden from the public pages"); reload(); }
    catch (e) { toast((e as ApiError).message, "error"); }
  };
  const rows = d.reviews.filter((r) => !stars || r.rating === stars);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-semibold tracking-tight">Reviews</h1><button onClick={reload} className="flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm font-semibold hover:bg-stone-50"><Icon name="refresh" size={14} />Refresh</button></div>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card><ScoreSummary s={d.summary} /></Card>
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
          {[["People asked", d.asked], ["Reviews written", d.reviews.length], ["Review links sent", d.linksSent]].map(([l, v]) => <Card key={l as string}><p className="text-sm text-stone-500">{l}</p><p className="mt-1 text-2xl font-semibold">{v}</p></Card>)}
        </div>
      </div>
      <Card className="overflow-x-auto !p-0">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-5">
          {[0, 5, 4, 3, 2, 1].map((n) => <button key={n} onClick={() => setStars(n)} className={`rounded-full px-3 py-1 text-xs font-semibold ${stars === n ? "bg-brand-700 text-white" : "bg-stone-100 text-stone-600"}`}>{n ? `${n}★ ${WORDS[n]}` : "All"}</button>)}
        </div>
        <table className="mt-3 w-full min-w-[60rem] text-sm">
          <thead className="border-y border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500"><tr>{["Date", "Who", "Rating", "Review", "Meeting", "Shown", ""].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-stone-100">
            {!rows.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-stone-500">No reviews yet.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className={r.hidden ? "bg-stone-50 text-stone-400" : ""}>
                <td className="px-4 py-3 text-stone-500">{fmtDate(r.created_at)}</td>
                <td className="px-4 py-3"><b className="block font-semibold">{r.name}{r.anonymous && <span className="ml-1 text-xs font-normal text-stone-500">(anonymous)</span>}</b><span className="text-xs text-stone-500">{r.role} · {r.email ?? (r.phone ? `+${r.phone}` : "—")}</span></td>
                <td className="px-4 py-3"><Stars value={r.rating} size={14} /></td>
                <td className="max-w-sm px-4 py-3 text-stone-600">{r.comment ?? <span className="text-stone-400">No comment</span>}{!!r.tags?.length && <span className="mt-1 block text-xs text-stone-500">{r.tags.join(" · ")}</span>}</td>
                <td className="px-4 py-3 text-stone-500">{r.meeting ?? "—"}<span className="block text-xs">{r.via === "link" ? "from the link" : "after the call"}</span></td>
                <td className="px-4 py-3">{r.hidden ? <Badge tone="red">Hidden</Badge> : <Badge tone="green">Public</Badge>}</td>
                <td className="px-4 py-3 text-right"><button onClick={() => toggle(r)} className="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-semibold hover:bg-stone-50">{r.hidden ? "Show" : "Hide"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
