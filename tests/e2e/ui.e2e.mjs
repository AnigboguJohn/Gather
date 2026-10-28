/**
 * Browser test: a host on a laptop and a guest on a phone in a real call (LiveKit media, fake camera/mic).
 * Run (stack must be up): node tests/e2e/ui.e2e.mjs   (BASE, MAILPIT, CHROME, SHOTS env vars optional)
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8080";
const MAILPIT = process.env.MAILPIT ?? "http://localhost:8025";
const SHOTS = process.env.SHOTS ?? "/tmp/shots";
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const email = `host.${run}@acme.test`;
let n = 0;
const ok = (m) => console.log(`PASS  ${++n}. ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the sign-in code email in the Mailpit test inbox and return the 6 digits from its subject. */
async function code(to) {
  for (let i = 0; i < 40; i++) {
    const r = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json();
    const m = (r.messages ?? []).find((x) => /\d{6}/.test(x.Subject));
    if (m) return m.Subject.match(/\d{6}/)[0];
    await sleep(300);
  }
  throw new Error("no code email");
}

// Chromium with a fake camera/mic (moving test pattern + beep) and auto-accepted screen picker,
// so camera, captions and screen sharing can be tested without real devices or clicks on browser dialogs.
const browser = await chromium.launch({
  executablePath: process.env.CHROME || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen", "--autoplay-policy=no-user-gesture-required"],
});
const hostCtx = await browser.newContext({ viewport: { width: 1360, height: 820 }, permissions: ["camera", "microphone"] });
const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ["camera", "microphone"] });
const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();
// Any JavaScript error on either page fails the test at the end.
const errors = [];
for (const [who, p] of [["host", host], ["guest", guest]]) {
  p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && !/favicon|WebSocket|ERR_|Failed to load resource/.test(m.text()) && errors.push(`${who} console: ${m.text()}`));
}

try {
  // 1. Landing + sign up
  await host.goto(BASE);
  await host.getByText("Meetings that work on").waitFor();
  await host.screenshot({ path: `${SHOTS}/01-landing.png` });
  await host.getByRole("link", { name: /Start free/ }).click();
  await host.getByPlaceholder("you@company.com").fill(email);
  await host.getByRole("button", { name: "Send code" }).click();
  await host.getByPlaceholder("123456").fill(await code(email));
  await host.getByPlaceholder("Ada Okafor").fill("Ada Okafor");
  await host.getByRole("button", { name: /A company/ }).click();
  await host.getByPlaceholder("Acme Ltd").fill("Acme Ltd");
  await host.screenshot({ path: `${SHOTS}/02-signup.png` });
  await host.getByRole("button", { name: "Create account" }).click();
  await host.getByText("Hello, Ada").waitFor();
  await host.getByText("meetings up to 5 hours").waitFor();
  ok("host signs up with an emailed code (no password) and lands on the dashboard");
  await host.screenshot({ path: `${SHOTS}/03-dashboard.png` });

  // 2. Schedule form renders (and schedules)
  await host.getByRole("button", { name: /Schedule/ }).first().click();
  await host.getByPlaceholder("Weekly sales review").fill("Weekly sales review");
  await host.getByPlaceholder("Name").first().fill("Tolu");
  await host.getByPlaceholder("WhatsApp 0803...").first().fill("0803 222 3333");
  await host.getByPlaceholder("Email").first().fill(`tolu.${run}@mail.test`);
  await host.screenshot({ path: `${SHOTS}/04-schedule.png`, fullPage: true });
  await host.getByRole("button", { name: "Schedule and invite" }).click();
  await host.getByText("Invited (1)").waitFor();
  await host.getByText("Send on WhatsApp").waitFor();
  await host.screenshot({ path: `${SHOTS}/05-meeting-detail.png`, fullPage: true });
  ok("schedule a meeting with a WhatsApp + email invitee; one-tap WhatsApp link shown");

  // 3. Meet now
  await host.getByRole("link", { name: "Meetings" }).first().click();
  await host.getByRole("button", { name: /Meet now/ }).click();
  await host.getByText("Your meeting is ready").waitFor();
  await host.screenshot({ path: `${SHOTS}/06-meet-now.png` });
  const link = (await host.locator(".font-mono").first().innerText()).trim();
  const slug = link.split("/j/")[1];
  await host.getByRole("button", { name: "Join now" }).click();
  await host.getByText("Joining as").waitFor();
  await host.getByRole("button", { name: /Join meeting/ }).click();
  await host.getByRole("button", { name: "Mute" }).waitFor({ timeout: 20000 });
  ok("Meet now: room opens, host joins with mic on");

  // 4. Guest joins on a phone without an account
  await guest.goto(`${BASE}/j/${slug}`);
  await guest.getByPlaceholder("Tolu Adeyemi").fill("Tolu Ade");
  await guest.getByPlaceholder("0803 000 0000").fill("0803 222 3333");
  await guest.locator("select").first().selectOption("yo");
  await guest.screenshot({ path: `${SHOTS}/07-guest-join.png`, fullPage: true });
  await guest.getByRole("button", { name: /Join meeting/ }).click();
  await guest.getByRole("button", { name: "Ask to speak" }).waitFor({ timeout: 20000 });
  await host.getByText("Tolu Ade").first().waitFor();
  ok("guest joins from a phone with no account; mic locked ('Ask to speak')");

  // 5. Guest camera on (no permission needed)
  await guest.getByRole("button", { name: "Start video" }).click();
  await guest.getByRole("button", { name: "Stop video" }).waitFor();
  await host.waitForFunction(() => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && v.closest("div")?.textContent?.includes("Tolu")), null, { timeout: 20000 });
  ok("guest turns the camera on freely; host receives the video");

  // 6. Raise hand → host allows → guest mic on
  await guest.getByRole("button", { name: "Ask to speak" }).click();
  await host.getByText("wants to speak").waitFor();
  await host.screenshot({ path: `${SHOTS}/08-host-hand-request.png` });
  await host.getByRole("button", { name: "Allow", exact: true }).click();
  await guest.getByRole("button", { name: "Mute" }).waitFor({ timeout: 15000 });
  ok("raise hand → host taps Allow → guest's mic unlocks and turns on");

  // 7. Captions from the guest's (fake) microphone, translated into the host's English
  await host.locator("p", { hasText: /^Tolu Ade: \[en\]/ }).first().waitFor({ timeout: 30000 });
  await host.screenshot({ path: `${SHOTS}/09-captions.png` });
  ok("live captions: guest speaks Yoruba → host reads English captions");

  // 8. Host presents (screen share)
  await host.getByRole("button", { name: "Present", exact: true }).click();
  await host.getByText("You're presenting").waitFor({ timeout: 15000 });
  await guest.getByText(/is presenting/).first().waitFor({ timeout: 15000 });
  await guest.waitForFunction(() => [...document.querySelectorAll("video.object-contain")].some((v) => v.videoWidth > 0), null, { timeout: 20000 });
  await host.screenshot({ path: `${SHOTS}/10-host-presenting.png` });
  await guest.screenshot({ path: `${SHOTS}/11-guest-sees-presentation.png` });
  await host.getByRole("button", { name: /Pause/ }).click();
  await guest.getByText(/\(paused\)/).first().waitFor({ timeout: 10000 });
  await host.getByRole("button", { name: /Resume/ }).click();
  ok("host presents; guest's phone shows the slides as the main view; pause/resume works");
  await host.getByRole("button", { name: /^Stop$/ }).click();
  await guest.locator("video.object-contain").waitFor({ state: "detached", timeout: 10000 });

  // 9. Reactions + chat
  await guest.getByRole("button", { name: "React" }).click();
  await guest.getByRole("button", { name: "🎉" }).click();
  await host.locator(".reaction-float", { hasText: "🎉" }).first().waitFor({ timeout: 5000 });
  // On a laptop the chat panel is already open when the call starts.
  if (!(await host.getByPlaceholder("Message everyone").isVisible())) await host.getByRole("button", { name: "Chat" }).click();
  await host.getByPlaceholder("Message everyone").fill("Budget is 2 million naira");
  await host.getByRole("button", { name: "Send" }).click();
  await guest.getByRole("button", { name: "Chat" }).click();
  await guest.getByText("Budget is 2 million naira").waitFor();
  await guest.screenshot({ path: `${SHOTS}/12-guest-chat.png` });
  await guest.getByRole("button", { name: "Close panel" }).click();
  ok("reactions float on the sender's tile; chat reaches everyone");

  // 10. Data saver: audio only on the phone
  await guest.getByRole("button", { name: "More" }).click();
  await guest.getByRole("button", { name: "Data saver and language" }).click();
  await guest.getByRole("button", { name: /Audio only/ }).click();
  await guest.getByText(/Used so far/).waitFor();
  await guest.screenshot({ path: `${SHOTS}/13-guest-data-saver.png` });
  await guest.getByRole("button", { name: "Close panel" }).click();
  ok("data meter shows MB used; guest switches to audio-only");

  // 11. Host panel: people + controls
  await host.getByRole("button", { name: "Close panel" }).click();
  await host.getByRole("button", { name: "People" }).click();
  await host.getByText("In the call (2)").waitFor();
  await host.screenshot({ path: `${SHOTS}/14-host-people.png` });
  ok("host sees the people panel with controls");

  // 12. End meeting for everyone
  host.once("dialog", (d) => d.accept());
  await host.getByRole("button", { name: "More" }).click();
  await host.getByRole("button", { name: "End meeting for all" }).click();
  await guest.getByText("The host ended the meeting.").waitFor({ timeout: 10000 });
  await guest.screenshot({ path: `${SHOTS}/15-guest-ended.png` });
  ok("host ends the meeting; the guest is told the summary is coming");

  // 13. Summary + attendance in history
  await host.getByRole("link", { name: "Meeting page" }).click();
  await host.getByText("Summary sent").waitFor({ timeout: 30000 });
  await host.getByText("Summary sent").click();
  await host.getByText(/agreed to launch in Lagos/).first().waitFor();
  await host.screenshot({ path: `${SHOTS}/16-summary.png`, fullPage: true });
  await host.getByRole("button", { name: /Attendance/ }).click();
  await host.getByText("Tolu Ade").waitFor();
  ok("summary with action items and the attendance list appear in history");

  // 14. Billing page + demo upgrade
  await host.getByRole("link", { name: "Plan" }).first().click();
  await host.getByText("You're on Free").waitFor();
  await host.screenshot({ path: `${SHOTS}/17-billing.png`, fullPage: true });
  await host.getByRole("link", { name: "Start with Pro" }).click();
  await host.getByRole("button", { name: /Pay .* with Demo checkout/ }).click();
  await host.getByRole("button", { name: "Pay now" }).click();
  await host.getByRole("heading", { name: "Payment successful" }).waitFor();
  await host.getByRole("link", { name: "Plan and billing" }).click();
  await host.getByText(/You're on Pro until/).waitFor();
  ok("billing: checkout → demo payment → order confirmed → workspace is on Pro");

  if (errors.length) { console.log("Browser errors:\n" + errors.join("\n")); process.exitCode = 1; }
  else console.log(`\nAll ${n} browser checks passed. Screenshots in ${SHOTS}`);
} catch (e) {
  console.log(`FAIL  after step ${n}: ${e.message}`);
  await host.screenshot({ path: `${SHOTS}/fail-host.png` }).catch(() => {});
  await guest.screenshot({ path: `${SHOTS}/fail-guest.png` }).catch(() => {});
  if (errors.length) console.log("Browser errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
