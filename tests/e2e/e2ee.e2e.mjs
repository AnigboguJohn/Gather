/**
 * End-to-end encryption check (browser test).
 * Proves: without the #k= key a guest is asked for the secure link; with the same key two browsers
 * decrypt each other's video; and captions are switched off (the server must never hear the audio).
 * Run (stack must be up): node tests/e2e/e2ee.e2e.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BASE ?? "http://localhost:8080";
const MAILPIT = process.env.MAILPIT ?? "http://localhost:8025";
const run = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Tiny JSON API helper.
const j = async (path, body, token) => (await fetch(`${BASE}/api${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();

// Host account (code read from the Mailpit test inbox) and an encrypted Meet now room.
const email = `sec.${run}@acme.test`;
await j("/auth/start", { email });
await sleep(600);
const msg = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()).messages[0];
const { token } = await j("/auth/verify", { email, code: msg.Subject.match(/\d{6}/)[0], name: "Sec Host" });
const m = await j("/meetings/instant", { e2ee: true }, token);
const key = "k3yForTest_" + run; // the secret that would normally be in the shared link

const browser = await chromium.launch({ executablePath: process.env.CHROME || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined), args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const errors = [];
/** A new browser window with camera/mic allowed; collects page errors. */
const page = async (who) => {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1100, height: 700 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  return p;
};
// Host: signed in (token in localStorage), joins with the key and camera on.
const host = await page("host");
await host.goto(BASE);
await host.evaluate((t) => localStorage.setItem("gather.token", t), token);
await host.goto(`${BASE}/j/${m.slug}#k=${key}`);
await host.getByRole("button", { name: /Camera off/ }).click();
await host.getByRole("button", { name: /Join meeting/ }).click();
await host.getByText("Encrypted").first().waitFor({ timeout: 20000 });

// Guest: first without the key (must be asked for it), then with it.
const guest = await page("guest");
await guest.goto(`${BASE}/j/${m.slug}`);
await guest.getByText("end-to-end encrypted").first().waitFor();
console.log("PASS  without the key, guests are asked for the secure link");
await guest.goto(`${BASE}/j/${m.slug}#k=${key}`);
await guest.reload();
await guest.getByPlaceholder("Tolu Adeyemi").fill("Kemi");
await guest.getByPlaceholder("you@mail.com").fill("kemi@x.test");
await guest.getByRole("button", { name: /Camera off/ }).click();
await guest.getByRole("button", { name: /Join meeting/ }).click();
// Decryption works when a remote (non-mirrored) video has real frames.
const decoded = (p) => p.waitForFunction(() => [...document.querySelectorAll("video")].filter((v) => v.videoWidth > 0 && !v.classList.contains("-scale-x-100")).length > 0, null, { timeout: 25000 });
await decoded(host);
await decoded(guest);
console.log("PASS  encrypted video decodes on both sides with the shared key");
const info = await j(`/public/meetings/${m.slug}`);
console.log(info.captions === false ? "PASS  captions are off for encrypted meetings" : "FAIL  captions should be off");
await browser.close();
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
