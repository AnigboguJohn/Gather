/** Workspace team management. */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Initials, PageTitle } from "../components/Layout";
import { Spinner, confirmToast, copy, toast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";

/** "ada.okafor@acme.ng" → "Ada Okafor", used when the admin leaves the name empty. */
const nameFromEmail = (email: string) =>
  email.split("@")[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || email;
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/**
 * Team page ("/team"): one card with the invite row (email, role, Send invite) and the member list
 * (avatar, name, email, "You" / "Invite pending", role pill). Admins add people (they finish sign-up with that
 * email), change roles, or remove them (their meetings move to the admin).
 */
export default function Team() {
  const { me, refresh } = useAuth();
  const [list, setList] = useState<any[] | null>(null);
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const isAdmin = me?.user.role !== "member";
  const load = () => api<any[]>("/team").then(setList);
  useEffect(() => { load(); }, []);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    const n = name.trim() || nameFromEmail(email.trim());
    try { await api("/team", { body: { name: n, email, role } }); toast(`Invite sent. ${n} finishes sign-up with ${email}.`); setName(""); setEmail(""); load(); refresh(); }
    catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(false); }
  };
  /** Role pill: make someone an admin or a member. */
  const changeRole = async (u: any, value: string) => {
    try { await api(`/team/${u.id}`, { method: "PATCH", body: { role: value } }); toast(`${u.name} is now ${ROLE_LABEL[value].toLowerCase()}`); } catch (err) { toast((err as ApiError).message, "error"); }
    load();
  };
  /** Remove someone (confirmed); their meetings move to the admin. */
  const remove = async (u: any) => {
    if (!(await confirmToast(`Remove ${u.name} from the team? Their meetings move to you.`, { confirm: "Remove", danger: true }))) return;
    try { await api(`/team/${u.id}`, { method: "DELETE" }); toast(`${u.name} removed`); } catch (err) { toast((err as ApiError).message, "error"); }
    load();
  };

  return (
    <div>
      <PageTitle title="Team" />
      <div className="mx-auto max-w-2xl rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-8">
        {/* Header: icon, title and what the team is for */}
        <div className="flex items-start gap-4 border-b border-dashed border-stone-200 pb-6">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 ring-8 ring-brand-50/50"><Icon name="team" size={26} /></span>
          <div>
            <h2 className="text-xl font-bold text-stone-900">{me?.org.kind === "company" ? `${me.org.name} team` : "Invite your team"}</h2>
            <p className="mt-0.5 text-sm text-stone-500">{me?.org.kind === "company" ? "Shared meeting history, one plan, and admins who can manage meetings for everyone." : "Add colleagues to turn your account into a company workspace with shared history."}</p>
          </div>
        </div>

        {/* Invite row (admins): name, email with role inside, Send invite */}
        {isAdmin && (
          <form onSubmit={invite} className="mt-6">
            <p className="mb-2 text-sm font-semibold text-stone-800">Invite by email</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name"
                className="rounded-xl border border-stone-300 px-3.5 py-2.5 text-[15px] outline-none focus:border-brand-500 sm:w-40" />
              <div className="flex min-w-0 flex-1 items-center rounded-xl border border-stone-300 bg-white pl-3 focus-within:border-brand-500">
                <Icon name="mail" size={18} className="shrink-0 text-stone-400" />
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter email address" aria-label="Work email"
                  className="min-w-0 flex-1 bg-transparent px-2.5 py-2.5 text-[15px] outline-none" />
                <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role for the new person"
                  className="mr-1.5 rounded-lg bg-stone-100 px-2 py-1.5 text-sm font-medium text-stone-700 outline-none">
                  <option value="member">Member</option><option value="admin">Admin</option>
                </select>
              </div>
              <button disabled={busy} className="flex items-center justify-center gap-2 rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-stone-800 disabled:opacity-60">
                {busy && <Spinner size={16} />}Send invite
              </button>
            </div>
            <p className="mt-2 text-xs text-stone-500">Members see their own meetings. Admins see every workspace meeting, manage the team and pay for the plan.</p>
          </form>
        )}

        {/* Member list; the owner can't be changed or removed */}
        <p className="mb-2 mt-7 text-sm font-semibold text-stone-800">Members{list ? ` (${list.length})` : ""}</p>
        {!list ? <div className="py-8 text-center text-brand-700"><Spinner /></div> : (
          <ul className="space-y-1">
            {list.map((u) => {
              const mine = u.id === me?.user.id;
              const editable = isAdmin && !mine && u.role !== "owner";
              return (
                <li key={u.id} className="flex items-center gap-3 rounded-xl py-2.5">
                  <span className="overflow-hidden rounded-full"><Initials name={u.name} size={44} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 font-semibold text-stone-900">
                      <span className="truncate">{u.name}</span>
                      {mine && <span className="rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-600">You</span>}
                      {u.pending && !mine && <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Invite pending</span>}
                    </p>
                    <p className="truncate text-sm text-stone-500">{u.email}</p>
                  </div>
                  {editable ? (
                    <span className="relative shrink-0">
                      <select value={u.role} onChange={(e) => changeRole(u, e.target.value)} aria-label={`Role for ${u.name}`}
                        className="w-auto appearance-none rounded-full border border-stone-200 bg-white py-1.5 pl-3.5 pr-8 text-sm font-medium text-stone-700 outline-none hover:bg-stone-50 focus:border-brand-500">
                        <option value="member">Member</option><option value="admin">Admin</option>
                      </select>
                      <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-500">▾</span>
                    </span>
                  ) : <span className="shrink-0 rounded-full border border-stone-200 px-3.5 py-1.5 text-sm font-medium text-stone-600">{ROLE_LABEL[u.role] ?? u.role}</span>}
                  {editable && <button onClick={() => remove(u)} aria-label={`Remove ${u.name}`} title="Remove from team" className="shrink-0 rounded-full p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600"><Icon name="trash" size={16} /></button>}
                </li>
              );
            })}
          </ul>
        )}

        {/* Footer: who can see what, and the sign-up link new members use */}
        {isAdmin && (
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-stone-100 pt-5">
            <span className="flex flex-1 items-center gap-2 text-sm text-stone-600"><Icon name="lock" size={16} />Only people you invite can join this workspace</span>
            <button onClick={() => copy(`${window.location.origin}/signup`, "Sign-up link copied")} className="flex items-center gap-2 rounded-xl border border-stone-900 px-3.5 py-2 text-sm font-semibold text-stone-900 hover:bg-stone-50">
              <Icon name="link" size={16} />Copy sign-up link
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
