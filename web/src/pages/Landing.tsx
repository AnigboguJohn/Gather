/**
 * Landing page ("/"), laid out like the Monvo reference with Kepripun's join box:
 * hero (headline, buttons, "paste your meeting link", counting facts, floating capsule video tiles with REC badges
 * and reaction bubbles) · scrolling "works with" strip · "Never miss a detail" tabs (captions, summaries, Ask,
 * data saver) · integrations · "Meet without a hitch" (Kepripun's tile network) · try-it-today · footer with a large wordmark · a round "back to top" button once you scroll down.
 *
 * Animations: tiles float, REC dots blink, facts count up, the strip scrolls, sections fade up as they come into
 * view, tabs fade in; the tile network flies in from above, below, left and right when it comes into view. All of it stops for people who ask their device for reduced motion (index.css).
 * Photos are from Unsplash (free licence), loaded small and lazily for slow networks. Only real product facts:
 * no made-up user counts, customer logos or quotes.
 */
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Logo } from "../components/Layout";
import { Icon } from "../components/Icon";
import { useAuth } from "../lib/auth";

/** An Unsplash photo, cropped to the size it's shown at (keeps downloads small on mobile data). */
export const photo = (id: string, w: number, h: number) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=${h}&q=60`;
export const P = {
  amara: "1611432579699-484f7990b127", kwame: "1522529599102-193c0d76b5b6", tunde: "1531384441138-2736e62e0919",
  zainab: "1531123897727-8f129e1688ce", femi: "1507003211169-0a1dd7228f2d", ngozi: "1573497019940-1c28c88b4f3e",
  team: "1543269865-cbf427effbad", office: "1600880292203-757bb62b4baf",
};

/**
 * A meeting link or ID → its join path (keeps ?i= invites and the #k= key of encrypted meetings).
 * Meeting IDs look like xsk-yweq-evb (3-4-3 letters); typed without dashes is fine too.
 */
export function joinPath(v: string): string | null {
  const s = v.trim();
  const link = s.match(/\/j\/([a-z]{3}-[a-z]{4}-[a-z]{3})(\?[^#\s]*)?(#\S*)?/i);
  if (link) return `/j/${link[1].toLowerCase()}${link[2] ?? ""}${link[3] ?? ""}`;
  const id = s.toLowerCase().match(/^([a-z]{3})-?([a-z]{4})-?([a-z]{3})$/);
  return id ? `/j/${id[1]}-${id[2]}-${id[3]}` : null;
}

/** Fade sections up as they scroll into view: every `.reveal` inside `root` gets `.in` once it's on screen. */
function useReveal(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const els = root.current?.querySelectorAll(".reveal") ?? [];
    if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.15 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [root]);
}

/** A number that counts up from 0 when it first comes into view (e.g. "50" for ~50 MB an hour). */
function CountUp({ to, prefix = "", suffix = "" }: { to: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) { setN(to); return; }
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (t: number) => { const p = Math.min(1, (t - start) / 1200); setN(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [to]);
  return <span ref={ref}>{prefix}{n}{suffix}</span>;
}

/** The "Never miss a detail" tabs: what each Gather feature does, with a picture. */
const FEATURES = [
  {
    id: "captions", tab: "Live captions", title: "Captions in your own language", img: P.team,
    text: "Everyone reads the call as it happens, translated into the language they pick.",
    points: ["English, Yoruba, Hausa, Igbo, Pidgin, Swahili and French", "Each person chooses their own language", "Translations can be read aloud"],
    chip: "Hausa → English: “The delivery arrives on Monday.”",
  },
  {
    id: "summaries", tab: "Summaries", title: "Every decision, sent to everyone", img: P.zainab,
    text: "When the call ends, each person gets the decisions and action items in their own language.",
    points: ["Sent by email and WhatsApp", "Who does what, and by when", "The full transcript stays with the meeting"],
    chip: "Action: Tolu sends the price list by Friday",
  },
  {
    id: "ask", tab: "Ask", title: "Ask your past meetings", img: P.office,
    text: "Type a question in your own words. Gather answers from what was said, and shows you where.",
    points: ["Searches every meeting you hosted", "Shows the meeting and the moment", "Works in any of the 7 languages"],
    chip: "“Who is sending the price list?” → Tolu, on Friday",
  },
  {
    id: "data", tab: "Data saver", title: "Built for weak, expensive data", img: P.femi,
    text: "Gather keeps the call going on slow networks and shows how much data you've used.",
    points: ["About 50 MB an hour with data saver", "Audio only: about 20 MB an hour", "A live data meter in every call"],
    chip: "0.7 MB used · data saver on",
  },
];

/** Public home page. Signed-in hosts skip it and go straight to their meetings. */
export default function Landing() {
  const { me } = useAuth();
  const nav = useNavigate();
  const page = useRef<HTMLDivElement>(null);
  const [link, setLink] = useState("");
  const [linkErr, setLinkErr] = useState(false);
  const [tab, setTab] = useState(FEATURES[0].id);
  useReveal(page);
  if (me) return <Navigate to="/home" replace />;
  const join = (e: React.FormEvent) => { e.preventDefault(); const p = joinPath(link); if (p) nav(p); else setLinkErr(true); };
  const f = FEATURES.find((x) => x.id === tab)!;

  return (
    <div ref={page} className="min-h-full overflow-x-hidden bg-white text-stone-900">
      {/* ------------------------------------------------------------ Hero, on a soft tinted panel */}
      <section className="relative overflow-hidden rounded-b-[2.5rem] bg-gradient-to-br from-brand-50 via-emerald-50 to-sky-50">
        {/* A big soft shape drifting behind the tiles */}
        <div aria-hidden="true" className="blob pointer-events-none absolute -right-40 top-10 h-[40rem] w-[40rem] rounded-full bg-brand-100/70" />
        <header className="relative mx-auto flex max-w-6xl items-center gap-6 px-5 py-5">
          <Logo />
          <nav className="hidden flex-1 justify-center gap-8 text-sm font-medium text-stone-700 md:flex">
            <a href="#features" className="hover:text-brand-800">Features</a>
            <a href="#integrations" className="hover:text-brand-800">Integrations</a>
            <a href="#how" className="hover:text-brand-800">How it works</a>
          </nav>
          <div className="ml-auto flex items-center gap-3 md:ml-0">
            <Link to="/signin" className="text-sm font-semibold text-stone-800 hover:text-brand-800">Sign in</Link>
            <Link to="/signup" className="rounded-full bg-brand-900 px-5 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-brand-800">Start for free</Link>
          </div>
        </header>

        {/* Text left, photos right from tablet width up (768 px), like the feature section below; stacked on phones */}
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-8 md:grid-cols-[1.05fr_0.95fr] md:gap-8 md:pt-10 lg:gap-12 lg:pt-14">
          <div>
            <h1 className="hero-in text-4xl font-semibold leading-[1.08] tracking-tight text-brand-900 md:text-[2.6rem] lg:text-[3.5rem]">
              Video meetings that work on any network, in your language
            </h1>
            <p className="hero-in mt-5 max-w-lg text-stone-600 [animation-delay:120ms]">
              Start a call in one tap and share the link on WhatsApp. Guests join from their phone with no account, read live captions in their own language, and get the summary when it ends.
            </p>
            <div className="hero-in mt-7 flex flex-wrap gap-3 [animation-delay:220ms]">
              <Link to="/signup" className="rounded-full bg-brand-900 px-7 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-900/20 transition hover:-translate-y-0.5 hover:bg-brand-800">Start for free</Link>
              <a href="#features" className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-stone-800 shadow-sm transition hover:-translate-y-0.5">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-900 text-white"><Icon name="play" size={10} /></span>See how it works
              </a>
            </div>

            {/* Kepripun's join box: paste a link, start the meeting */}
            <form id="join" onSubmit={join} className="hero-in mt-8 max-w-lg scroll-mt-24 [animation-delay:320ms]">
              <div className={`flex items-center gap-2 rounded-full border bg-white p-1.5 pl-5 shadow-sm transition ${linkErr ? "border-red-400" : "border-transparent focus-within:border-brand-400 focus-within:shadow-md"}`}>
                <input value={link} onChange={(e) => { setLink(e.target.value); setLinkErr(false); }} placeholder="Insert your meeting link" aria-label="Meeting link or ID"
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-stone-400" />
                <button className="flex shrink-0 items-center gap-2 rounded-full bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800"><Icon name="cam" size={16} />Join meeting</button>
              </div>
              {linkErr && <p className="mt-1.5 pl-5 text-xs text-red-600">That doesn't look like a Gather link. It looks like …/j/xsk-yweq-evb</p>}
            </form>

            {/* Real facts, counting up */}
            <dl className="hero-in mt-10 flex flex-wrap gap-x-12 gap-y-5 [animation-delay:420ms]">
              <div><dt className="text-4xl font-semibold tracking-tight text-brand-900"><CountUp to={7} /></dt><dd className="mt-1 text-sm text-stone-600">Caption languages</dd></div>
              <div><dt className="text-4xl font-semibold tracking-tight text-brand-900"><CountUp to={2} suffix=" h" /></dt><dd className="mt-1 text-sm text-stone-600">Free meetings</dd></div>
              <div><dt className="text-4xl font-semibold tracking-tight text-brand-900"><CountUp to={50} prefix="~" suffix=" MB" /></dt><dd className="mt-1 text-sm text-stone-600">An hour on data saver</dd></div>
            </dl>
          </div>

          {/* Capsule video tiles (Monvo) floating, with REC badges and reaction bubbles (Kepripun) */}
          <div className="relative mx-auto h-[30rem] w-full max-w-md sm:h-[34rem]" aria-hidden="true">
            {[
              { id: P.amara, pos: "left-0 top-0", delay: "0s" },
              { id: P.kwame, pos: "right-0 top-16", delay: "1.2s" },
              { id: P.tunde, pos: "left-0 top-[15.5rem] sm:top-[17.5rem]", delay: "0.6s" },
              { id: P.zainab, pos: "right-0 top-[19.5rem] sm:top-[22rem]", delay: "1.8s" },
            ].map((t) => (
              <div key={t.id} className={`float absolute ${t.pos} w-[46%] overflow-hidden rounded-[3rem] border-4 border-white bg-brand-100 shadow-xl`} style={{ animationDelay: t.delay }}>
                <img src={photo(t.id, 360, 420)} alt="" className="h-52 w-full object-cover sm:h-60" />
                <span className="absolute left-4 top-4 flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur"><span className="rec h-2 w-2 rounded-full bg-red-500" />REC</span>
              </div>
            ))}
            <span className="pop absolute -left-4 top-[12.5rem] rounded-full bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg sm:-left-10" style={{ animationDelay: "0.8s" }}>Ẹ káàárọ̀ 👋</span>
            <span className="pop absolute right-0 top-4 rounded-full bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg lg:-right-8" style={{ animationDelay: "1.4s" }}>👏 Great idea</span>
            <span className="pop absolute bottom-6 left-1/2 w-max max-w-[95%] -translate-x-1/2 rounded-2xl bg-white px-4 py-2.5 text-xs text-stone-700 shadow-xl" style={{ animationDelay: "2s" }}>
              <Icon name="captions" size={14} className="mr-1.5 inline text-brand-700" /><b>Amara</b> · Yoruba → English: “We start on Monday.”
            </span>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Works with (scrolling strip) */}
      <section className="py-10">
        <p className="mb-5 text-center text-xs text-stone-500">Works with what your people already use</p>
        <div className="marquee-mask overflow-hidden">
          <div className="marquee flex w-max gap-14 pr-14">
            {[0, 1].map((copy) => (
              <div key={copy} className="flex shrink-0 items-center gap-14" aria-hidden={copy === 1}>
                {[["whatsapp", "WhatsApp"], ["mail", "Gmail"], ["calendar", "Google Calendar"], ["card", "Paystack"], ["card", "Flutterwave"], ["phone", "Android & iPhone"], ["globe", "Any browser"]].map(([i, n]) => (
                  <span key={n} className="flex items-center gap-2 whitespace-nowrap text-lg font-semibold text-stone-500"><Icon name={i} size={22} />{n}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Never miss a detail (tabs) */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-6 px-5 py-16">
        <div className="reveal grid gap-4 md:grid-cols-2 md:items-end">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight md:text-4xl">Never miss a detail,<br />in any language</h2>
          <p className="text-sm text-stone-600 md:max-w-sm md:justify-self-end">Gather listens, translates and writes it all down, so people who joined late, on a weak network or in another language still get every decision.</p>
        </div>

        {/* Folder-style tabs */}
        <div role="tablist" className="reveal no-scrollbar mt-10 flex gap-2 overflow-x-auto px-1 md:px-14">
          {FEATURES.map((x) => (
            <button key={x.id} role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}
              className={`shrink-0 rounded-t-2xl px-6 py-3 text-sm font-medium transition md:flex-1 ${tab === x.id ? "bg-sky-50 text-stone-900" : "bg-brand-50 text-stone-500 hover:text-stone-800"}`}>
              {x.tab}
            </button>
          ))}
        </div>
        <div className="reveal rounded-[2rem] bg-sky-50 p-6 md:p-12">
          <div key={f.id} className="tab-in grid items-center gap-10 md:grid-cols-2">
            <div>
              <h3 className="text-2xl font-semibold tracking-tight md:text-3xl">{f.title}</h3>
              <p className="mt-3 max-w-sm text-sm text-stone-600">{f.text}</p>
              <ul className="mt-5 space-y-2.5">
                {f.points.map((pt) => <li key={pt} className="flex items-center gap-2.5 text-sm text-stone-700"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white"><Icon name="check" size={12} /></span>{pt}</li>)}
              </ul>
              <Link to="/signup" className="group mt-7 inline-flex items-center gap-2 rounded-full bg-brand-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-800">
                Try it free<Icon name="arrow" size={15} className="transition group-hover:translate-x-1" />
              </Link>
            </div>
            <div className="relative overflow-hidden rounded-[2rem] shadow-xl" aria-hidden="true">
              <img src={photo(f.img, 720, 520)} alt="" loading="lazy" className="h-72 w-full object-cover md:h-80" />
              <span className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur"><Icon name="play" size={20} /></span>
              <p className="absolute left-4 top-4 max-w-[85%] rounded-xl bg-white/90 px-3 py-1.5 text-xs font-medium text-stone-800 backdrop-blur">{f.chip}</p>
              <div className="absolute inset-x-5 bottom-4 flex items-center gap-3 text-[11px] font-semibold text-white">
                <span>1:23</span><span className="h-1 flex-1 overflow-hidden rounded-full bg-white/40"><span className="progress block h-full rounded-full bg-white" /></span><span>4:41</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Integrations */}
      <section id="integrations" className="scroll-mt-6 rounded-t-[2.5rem] bg-gradient-to-b from-emerald-50 to-white py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="reveal text-center">
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Fits the tools you<br />already use</h2>
            <p className="mx-auto mt-3 max-w-md text-sm text-stone-600">Invites, summaries, calendars and payments go through the apps your people use every day.</p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {[
              ["whatsapp", "bg-[#25D366]/15 text-[#128C4A]", "WhatsApp", "Share the meeting link in one tap. Reminders and summaries arrive where people already are."],
              ["calendar", "bg-sky-100 text-sky-700", "Google Calendar", "Your Gather meetings show up in your own calendar, and every invite comes with a calendar file."],
              ["card", "bg-amber-100 text-amber-700", "Paystack & Flutterwave", "Pay in Naira by card, bank transfer or USSD. Nothing renews automatically."],
            ].map(([i, c, t, d], n) => (
              <div key={t} className="reveal rounded-[1.75rem] bg-white p-7 shadow-sm ring-1 ring-stone-100 transition duration-300 hover:-translate-y-1.5 hover:shadow-xl" style={{ transitionDelay: `${n * 90}ms` }}>
                <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${c}`}><Icon name={i} size={24} /></span>
                <h3 className="mt-6 text-lg font-semibold">{t}</h3>
                <p className="mt-2 text-sm text-stone-600">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Meet without a hitch (Kepripun tile network) */}
      <section id="how" className="relative scroll-mt-6 overflow-hidden py-20">
        <Waves className="text-stone-200/80" />
        {/* Text left, tiles right from tablet width up (768 px), like the hero; stacked on phones */}
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 md:grid-cols-[0.85fr_1.15fr] md:gap-8 lg:gap-12">
          <div>
            <h2 className="text-[2.6rem] font-medium leading-[1.25] text-stone-800 sm:text-6xl md:text-5xl lg:text-6xl">
              <span className="reveal reveal-left flex items-center gap-4">Meet
                {/* Little pill pictures, like the reference */}
                <span aria-hidden="true" className="wiggle inline-flex h-11 w-24 items-center justify-center rounded-full bg-sky-300 text-3xl shadow-inner sm:h-14 sm:w-28">🚀</span></span>
              <span className="reveal reveal-left block [transition-delay:120ms]">Without a</span>
              <span className="reveal reveal-left flex items-center gap-4 [transition-delay:240ms]">Hitch
                <span aria-hidden="true" className="wiggle inline-flex h-11 w-24 items-center justify-center rounded-full bg-brand-600 text-3xl shadow-inner [animation-delay:-1.5s] sm:h-14 sm:w-28">⛈️</span></span>
            </h2>
            <p className="reveal reveal-left mt-6 max-w-md text-lg text-stone-500 [transition-delay:360ms]">
              Weak network or a different language, it doesn't matter. Start a meeting, share the link on WhatsApp, and everyone gets the summary when it ends.
            </p>
            <div className="reveal mt-8 flex flex-wrap gap-3 [transition-delay:480ms]">
              <Link to="/signup" className="flex items-center gap-2 rounded-full bg-brand-700 px-6 py-3 text-sm font-medium text-white shadow-lg shadow-brand-900/20 transition hover:-translate-y-0.5 hover:bg-brand-800"><Icon name="cam" size={16} />Start meeting</Link>
              <a href="#join" className="rounded-full border-2 border-brand-700 px-6 py-2.5 text-sm font-medium text-brand-800 transition hover:bg-brand-50">I have a link</a>
            </div>
          </div>
          <MeetingNetwork />
        </div>
      </section>

      {/* ------------------------------------------------------------ Try it today */}
      <section className="px-5 pb-20">
        <div className="reveal relative mx-auto max-w-6xl overflow-hidden rounded-[2.5rem] bg-brand-900 px-6 py-16 text-center text-white md:py-20">
          <div aria-hidden="true" className="blob pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-700/60" />
          <div aria-hidden="true" className="blob pointer-events-none absolute -bottom-40 -right-24 h-[26rem] w-[26rem] rounded-full bg-emerald-500/25 [animation-delay:-6s]" />
          <div className="relative">
            <h2 className="text-4xl font-semibold tracking-tight md:text-5xl">Try Gather today.</h2>
            <p className="mx-auto mt-3 max-w-lg text-sm text-white/75">Create a free account, tap New meeting and share the link. Free meetings last up to 2 hours.</p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link to="/signup" className="rounded-full bg-white px-7 py-3 text-sm font-semibold text-brand-900 transition hover:-translate-y-0.5">Start for free</Link>
              <a href="#join" className="inline-flex items-center gap-2 rounded-full border border-white/40 px-6 py-3 text-sm font-semibold transition hover:bg-white/10"><Icon name="link" size={15} />I have a meeting link</a>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Footer with a large wordmark */}
      <footer className="rounded-t-[2.5rem] bg-brand-50">
        <div className="mx-auto max-w-6xl px-5 pt-12">
          <div className="grid gap-8 md:grid-cols-[1.2fr_1fr]">
            <div className="max-w-sm">
              <Logo />
              <p className="mt-3 text-sm text-stone-600">Video meetings for weak, expensive mobile data and many languages, starting with Africa.</p>
            </div>
            <div className="grid grid-cols-3 gap-6 text-sm">
              <div className="space-y-2"><p className="font-semibold">Product</p><a href="#features" className="block text-stone-600 hover:text-stone-900">Features</a><a href="#integrations" className="block text-stone-600 hover:text-stone-900">Integrations</a><a href="#how" className="block text-stone-600 hover:text-stone-900">How it works</a></div>
              <div className="space-y-2"><p className="font-semibold">Account</p><Link to="/signup" className="block text-stone-600 hover:text-stone-900">Create account</Link><Link to="/signin" className="block text-stone-600 hover:text-stone-900">Sign in</Link></div>
              <div className="space-y-2"><p className="font-semibold">Guests</p><a href="#join" className="block text-stone-600 hover:text-stone-900">Join a meeting</a></div>
            </div>
          </div>
          <div className="mt-8 flex flex-col-reverse items-start justify-between gap-2 md:flex-row md:items-end">
            <p aria-hidden="true" className="select-none text-[22vw] font-semibold leading-[0.8] tracking-tighter text-brand-100 md:text-[10rem]">Gather</p>
            <p className="pb-6 text-xs text-stone-500">© {new Date().getFullYear()} Gather · Photos from Unsplash</p>
          </div>
        </div>
      </footer>

      <BackToTop />
    </div>
  );
}

/** Round "back to top" button: shows after scrolling down a screen, glides back to the top. */
function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(window.scrollY > 500);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Back to top" title="Back to top"
      className={`fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-brand-700 text-white shadow-xl shadow-brand-900/30 transition duration-300 hover:-translate-y-1 hover:bg-brand-800 ${show ? "opacity-100" : "pointer-events-none translate-y-4 opacity-0"}`}>
      <Icon name="arrow" size={20} className="-rotate-90" />
    </button>
  );
}

/** Faint wavy lines across a background (the Kepripun backdrop). */
function Waves({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} viewBox="0 0 1200 800" preserveAspectRatio="none" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M-50 620C150 520 220 760 420 700s200-260 420-240 260 200 460 120" />
      <path d="M-50 180C120 260 260 60 460 140s180 260 380 200 220-220 420-160" />
      <path d="M700 -40c-40 160 120 220 60 380s-220 200-160 400" />
    </svg>
  );
}

/**
 * Kepripun's tile network: 7 people (2 · 3 · 2) joined by lines, with icon nodes and reaction bubbles.
 * When it scrolls into view each tile flies in from its own side (above, below, left, right; the middle one zooms),
 * then keeps floating up-down or side to side; the nodes and bubbles pop in and the lines draw themselves.
 */
function MeetingNetwork() {
  const tiles = [
    { id: P.kwame, bg: "bg-violet-200", pos: "left-[17%] top-0", from: "reveal-down", float: "float", d: 150 },
    { id: P.femi, bg: "bg-orange-200", pos: "left-[52.5%] top-0", from: "reveal-right", float: "float-x", d: 300 },
    { id: P.zainab, bg: "bg-sky-200", pos: "left-0 top-[33.5%]", from: "reveal-left", float: "float-x", d: 450 },
    { id: P.amara, bg: "bg-orange-200", pos: "left-[35.5%] top-[33.5%]", from: "reveal-zoom", float: "float", d: 0 },
    { id: P.ngozi, bg: "bg-violet-200", pos: "left-[71%] top-[33.5%]", from: "reveal-right", float: "float-x", d: 600 },
    { id: P.tunde, bg: "bg-violet-200", pos: "left-[17%] top-[67%]", from: "reveal-left", float: "float", d: 750 },
    { id: P.team, bg: "bg-sky-200", pos: "left-[52.5%] top-[67%]", from: "reveal", float: "float-x", d: 900 },
  ];
  const nodes = [
    { icon: "cloud", pos: "left-[49.2%] top-[7%]", d: 1000 },
    { icon: "lock", pos: "left-[33%] top-[47.5%]", d: 1100 },
    { icon: "smile", pos: "left-[65.4%] top-[47.5%]", d: 1200 },
    { icon: "leave", pos: "left-[49.2%] top-[84%]", d: 1300 },
    { icon: "micOff", pos: "left-[7.5%] top-[24%]", d: 1400 },
    { icon: "camOff", pos: "left-[94%] top-[76%]", d: 1500 },
  ];
  return (
    <div className="reveal reveal-fade relative mx-auto aspect-[520/430] w-full max-w-[34rem]" aria-hidden="true">
      {/* Lines: the solid ones draw themselves once in view, the dashed ones keep flowing */}
      <svg className="absolute inset-0 h-full w-full text-stone-800" viewBox="0 0 520 430" preserveAspectRatio="none" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path className="draw" pathLength={1} d="M256 30 V130" />
        <rect className="draw [animation-delay:.9s]" pathLength={1} x="172" y="130" width="168" height="150" rx="30" />
        <path className="draw [animation-delay:1.2s]" pathLength={1} d="M256 280 V362" />
        <path className="dash" strokeDasharray="6 7" strokeWidth="2" d="M90 40 Q40 55 40 103 M40 128 Q38 140 30 145" />
        <path className="dash" strokeDasharray="6 7" strokeWidth="2" d="M470 278 Q492 292 491 315 M491 345 Q488 375 430 382" />
      </svg>
      {tiles.map((t) => (
        <div key={t.id} className={`reveal ${t.from} absolute ${t.pos} h-[28%] w-[29%]`} style={{ transitionDelay: `${t.d}ms` }}>
          <div className={`${t.float} h-full w-full overflow-hidden rounded-[1.6rem] ${t.bg} shadow-lg`} style={{ animationDelay: `-${t.d}ms` }}>
            <img src={photo(t.id, 300, 240)} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
          </div>
        </div>
      ))}
      {nodes.map((n) => (
        <span key={n.icon} className={`reveal reveal-zoom absolute ${n.pos} flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl bg-stone-800 text-white shadow-lg sm:h-10 sm:w-10`} style={{ transitionDelay: `${n.d}ms` }}>
          <Icon name={n.icon} size={17} />
        </span>
      ))}
      <span className="reveal reveal-zoom absolute -right-1 top-[5%] rotate-12 rounded-full bg-stone-900 px-4 py-1.5 text-sm font-semibold text-white shadow-lg sm:-right-4" style={{ transitionDelay: "1700ms" }}><span className="float block">LOL 😂</span></span>
      <span className="reveal reveal-zoom absolute left-[2%] top-[73%] -rotate-12 rounded-full bg-stone-900 px-4 py-1.5 text-sm font-semibold text-white shadow-lg" style={{ transitionDelay: "1900ms" }}><span className="float-x block">Wow 😲</span></span>
    </div>
  );
}
