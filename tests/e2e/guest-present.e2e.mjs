/**
 * Guests presenting: any guest on a laptop/desktop can share their screen when they ask and the host approves.
 *   1. Guest Kemi taps "Ask to present" → the host sees "Kemi wants to present" → Allow
 *   2. Kemi taps "Present now" → the host and the other guest see Kemi's screen as the main view
 *   3. Guest Bayo asks too → host allows → Bayo presents and Kemi's share stops (one presenter at a time)
 *   4. After a guest stops, they must ask again next time
 * Run (stack must be up): node tests/e2e/guest-present.e2e.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8080";
const MAILPIT = process.env.MAILPIT ?? "http://localhost:8025";
const run = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => console.log(`PASS  ${++n}. ${m}`);

// Small API helper (used only to create the host account and the meeting quickly).
const j = async (path, body, token) => (await fetch(`${BASE}/api${path}`, {
  method: body ? "POST" : "GET",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
})).json();

// Host account + a Meet now room.
const email = `pres.${run}@acme.test`;
await j("/auth/start", { email });
await sleep(600);
const msg = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()).messages[0];
const { token } = await j("/auth/verify", { email, code: msg.Subject.match(/\d{6}/)[0], name: "Ada Host" });
const m = await j("/meetings/instant", {}, token);

const browser = await chromium.launch({
  executablePath: process.env.CHROME || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"],
});
const errors = [];
/** A laptop-sized browser window for one person. */
async function laptop(who) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, permissions: ["camera", "microphone"] });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  return p;
}
/** Guest join screen: name + email, then Join. */
async function joinAsGuest(p, name) {
  await p.goto(`${BASE}/j/${m.slug}`);
  await p.getByPlaceholder("Tolu Adeyemi").fill(name);
  await p.getByPlaceholder("you@mail.com").fill(`${name.toLowerCase()}.${run}@mail.test`);
  await p.getByRole("button", { name: /Join meeting/ }).click();
  await p.getByRole("button", { name: "Ask to present" }).waitFor({ timeout: 20000 });
}
/** True when this page shows someone's screen share as the main view with real frames. */
const seesShare = (p) => p.waitForFunction(() => [...document.querySelectorAll("video.object-contain")].some((v) => v.videoWidth > 0), null, { timeout: 20000 });

try {
  const host = await laptop("host");
  await host.goto(BASE);
  await host.evaluate((t) => localStorage.setItem("gather.token", t), token);
  await host.goto(`${BASE}/j/${m.slug}`);
  await host.getByRole("button", { name: /Join meeting/ }).click();
  await host.getByRole("button", { name: "Mute" }).waitFor({ timeout: 20000 });

  const kemi = await laptop("kemi");
  const bayo = await laptop("bayo");
  await joinAsGuest(kemi, "Kemi");
  await joinAsGuest(bayo, "Bayo");
  // Everyone appears on the host's stage (one tile each).
  await host.locator("span.truncate", { hasText: /^Bayo$/ }).waitFor({ timeout: 15000 });
  await host.locator("span.truncate", { hasText: /^Kemi$/ }).waitFor({ timeout: 15000 });
  ok("two guests join on laptops; each sees 'Ask to present'");

  // 1. Kemi asks; the host approves from the pop-up card.
  await kemi.getByRole("button", { name: "Ask to present" }).click();
  await host.getByText("Kemi wants to present").waitFor({ timeout: 10000 });
  await host.screenshot({ path: "/tmp/shots/20-host-sees-present-request.png" });
  await host.getByRole("button", { name: "Allow", exact: true }).click();
  await kemi.getByRole("button", { name: "Present now" }).waitFor({ timeout: 10000 });
  ok("guest asks to present → host sees the request → Allow → guest gets 'Present now'");

  // 2. Kemi presents; everyone sees it.
  await kemi.getByRole("button", { name: "Present now" }).click();
  await kemi.getByText("You're presenting").waitFor({ timeout: 15000 });
  await seesShare(host);
  await seesShare(bayo);
  await host.getByText("Kemi is presenting").first().waitFor();
  await host.locator("span.truncate", { hasText: /^Bayo$/ }).waitFor({ timeout: 10000 });
  await host.screenshot({ path: "/tmp/shots/21-guest-presenting-host-view.png" });
  ok("the guest presents: host and the other guest see the guest's screen as the main view");

  // 3. Bayo asks while Kemi presents; when approved, Bayo takes over.
  await bayo.getByRole("button", { name: "Ask to present" }).click();
  await host.getByText("Bayo wants to present").waitFor({ timeout: 10000 });
  await host.getByRole("button", { name: "Allow", exact: true }).click();
  await bayo.getByRole("button", { name: "Present now" }).click();
  await bayo.getByText("You're presenting").waitFor({ timeout: 15000 });
  await kemi.getByText("You're presenting").waitFor({ state: "detached", timeout: 15000 });
  await host.getByText("Bayo is presenting").first().waitFor({ timeout: 15000 });
  ok("a second guest takes over after approval; the first guest's share stops (one presenter at a time)");

  // 4. Bayo stops; next time he must ask again.
  await bayo.getByRole("button", { name: /^Stop$/ }).click();
  await bayo.getByRole("button", { name: "Ask to present" }).waitFor({ timeout: 10000 });
  ok("after stopping, a guest must ask again to present");

  if (errors.length) { console.log(errors.join("\n")); process.exitCode = 1; }
  else console.log(`\nAll ${n} guest-presenting checks passed.`);
} catch (e) {
  console.log(`FAIL  after step ${n}: ${e.message.split("\n")[0]}`);
  if (errors.length) console.log(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
