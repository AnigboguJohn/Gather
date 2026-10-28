/** Formatting helpers shared by pages: languages, dates and times, money, durations, avatars. */
/** Caption/summary languages offered in pickers (same list as the server). */
export const LANGS: { id: string; name: string }[] = [
  { id: "en", name: "English" }, { id: "yo", name: "Yoruba" }, { id: "ha", name: "Hausa" }, { id: "ig", name: "Igbo" },
  { id: "pcm", name: "Nigerian Pidgin" }, { id: "sw", name: "Swahili" }, { id: "fr", name: "French" },
];
/** "yo" → "Yoruba" */
export const langName = (id: string) => LANGS.find((l) => l.id === id)?.name ?? id;

/** "Tue, 3 Nov, 9:00 AM" in the viewer's locale (or a given time zone). */
export const fmtWhen = (iso: string | Date, tz?: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
/** Time only, e.g. "9:05 AM". */
export const fmtTime = (iso: string | Date) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
/** Date only, e.g. "3 Nov 2026". */
export const fmtDate = (iso: string | Date) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
/** Kobo (minor units used by payments) → "₦5,000". */
export const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString()}`;

/** Seconds → "4:05" or "1:02:09" (call timers, attendance). */
export function fmtDuration(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
/** 300 → "5 hours" (plan limits). */
export const hoursLabel = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`);

/** Friendly relative time: "in 12 min", "3 min ago", "in 5 h", or a full date when further away. */
export function relative(iso: string | Date) {
  const d = new Date(iso).getTime() - Date.now();
  const mins = Math.round(d / 60000);
  if (Math.abs(mins) < 1) return "now";
  if (mins > 0 && mins < 60) return `in ${mins} min`;
  if (mins < 0 && mins > -60) return `${-mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (mins > 0 && hrs < 24) return `in ${hrs} h`;
  return fmtWhen(iso);
}

/** "Ada Okafor" → "AO" for avatar circles. */
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
// Avatar colours; each name always gets the same one.
const PALETTE = ["#059669", "#d9711f", "#2563eb", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#b45309"];
/** Stable colour for a name. */
export const colorFor = (s: string) => PALETTE[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

/** Browser time zone, e.g. Africa/Lagos */
export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos";
