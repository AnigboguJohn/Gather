/**
 * Notices when a newer Gather build has been installed on the server, so tabs that stay open for days pick it up.
 * Gather is a single-page app: moving between pages (Home → New meeting → call) never reloads, so without this an
 * old tab keeps running the old screens. App.tsx reloads on the next page change once a newer build is seen,
 * never in the middle of a call (calls don't change the page).
 */

// The build's main script, e.g. /assets/index-9Ix5fRm9.js (the name changes with every build). In development
// (Vite dev server) there is no such script, so the check is off.
const current = (document.querySelector('script[type="module"][src*="/assets/"]') as HTMLScriptElement | null)?.src;
let stale = false;

/** Fetch index.html (never cached) and compare its main script with the one this tab is running. */
export async function checkForNewBuild() {
  if (!current || stale) return;
  try {
    const html = await (await fetch("/", { cache: "no-store" })).text();
    const latest = html.match(/\/assets\/index-[\w-]+\.js/)?.[0];
    if (latest && !current.endsWith(latest)) stale = true;
  } catch { /* offline: try again later */ }
}

/** True once the server has a newer build than this tab. */
export const isStale = () => stale;

// Check on start, every 5 minutes, and whenever the tab comes back into view.
if (current) {
  checkForNewBuild();
  setInterval(checkForNewBuild, 5 * 60_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForNewBuild(); });
}
