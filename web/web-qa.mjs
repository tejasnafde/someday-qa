// Web QA against PRODUCTION (https://someday.tn07.dev) as the iOS app sees it:
// Playwright WebKit at iPhone sizes with the iOS shell user agent
// (SomedayNative/1.23.0) and a stand-in for the shell's message bridge.
// Runs only on GitHub Actions (.github/workflows/qa.yml, job "web"); never
// on a laptop. Two QA accounts only (QA_EMAIL_A, QA_EMAIL_B); every circle it
// makes is named "QA <run id> ..." and cleanup.mjs deletes them afterwards.
//
// Sign-in: a session minted with the Supabase Admin API is handed to
// /auth/callback in the URL fragment, exactly as the iOS shell does after its
// native sign-in. The invite flow signs B in the
// real web way instead (email, then the code read with the Admin API).
//
// A step screenshots to results/web/ whether it passes or fails, and a
// failure does not stop the later steps. The run fails on any failed check,
// console error, page error or 5xx response. QA traffic never reaches product
// analytics, and QA accounts never get a push token or a web push subscription:
// those requests are answered locally.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { webkit } from "playwright";
import {
  BASE, QA_EMAIL_A, QA_EMAIL_B, RESULTS, RUN_ID, api, assertSafeAccounts, ensureUser, generateLink,
  hasSecrets, maskEmail, scrub, sessionFor,
} from "./auth.mjs";
import { cleanupAll } from "./cleanup.mjs";

mkdirSync(RESULTS, { recursive: true });

const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const IOS_UA = `${SAFARI} SomedayNative/1.23.0`; // the WKWebView UA plus the shell mark
const WEB_UA = `${SAFARI} Version/18.6 Mobile/15E148 Safari/604.1`; // iPhone Safari, not the app
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 320, height: 480 };
const CARD_TITLE = "Someday is on the App Store now.";
const APP_STORE_HOST = "apps.apple.com";

// Known noise that is not a bug. Each entry needs a reason.
const CONSOLE_ALLOW = [
  // WebKit logs every 4xx resource load as a console error. Expected 4xx (a
  // deleted circle's 404, the signed-out 401) are not failures; 5xx are
  // caught separately from the responses themselves.
  /Failed to load resource: the server responded with a status of 4\d\d/,
  // The Cloudflare Web Analytics beacon (cloudflareinsights.com/cdn-cgi/rum)
  // answers 404 without CORS headers to WebKit. Third party, not the app.
  /cloudflareinsights\.com/,
];
// The same, for errors whose text has no URL: matched on the source URL.
const CONSOLE_ALLOW_URL = [/^https:\/\/cloudflareinsights\.com\//];
// WebKit words a fetch that a navigation cancelled as "... due to access
// control checks". The app calls its API same-origin, so this is never a real
// CORS failure. Logged as a warning, not a failure.
const PAGE_ERROR_WARN = [/due to access control checks/];

const failures = [];
const warnings = [];
let shotNo = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const circleName = (purpose) => `QA ${RUN_ID} ${purpose}`;

function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures.push(name);
  return cond;
}

function warn(message) {
  console.log(`WARN ${message}`);
  warnings.push(message);
}

// --- A small valid PNG for the photo upload -----------------------------------
function png() {
  const w = 48, h = 48;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7a)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Contexts -------------------------------------------------------------------
const browser = await webkit.launch();
const contexts = [];

/**
 * A browser context as one person on one device. `shell` adds a stand-in for
 * the iOS shell's bridge (window.ReactNativeWebView) that records messages and
 * answers the push questions with "denied", like a 1.23.0 shell whose user
 * said no.
 */
async function newContext(label, { ua = IOS_UA, viewport = PHONE, colorScheme = "light", shell = ua === IOS_UA, noShare = false } = {}) {
  const context = await browser.newContext({ userAgent: ua, viewport, colorScheme, isMobile: false, hasTouch: true });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.addInitScript(({ shell, noShare }) => {
    try { sessionStorage.setItem("tour:paused", "1"); } catch { /* private mode */ }
    window.__qaClip = [];
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t) => { window.__qaClip.push(String(t)); }, readText: async () => window.__qaClip.at(-1) ?? "" },
      });
    } catch { /* keep the real one */ }
    if (noShare) { try { Object.defineProperty(navigator, "share", { configurable: true, value: undefined }); } catch { /* none */ } }
    if (shell) {
      window.__qaShell = [];
      window.ReactNativeWebView = {
        postMessage(m) {
          window.__qaShell.push(String(m));
          let type = "";
          try { type = JSON.parse(m).type; } catch { return; }
          if (type === "push-status" || type === "push-permission") {
            setTimeout(() => window.dispatchEvent(new CustomEvent("someday-shell", { detail: { type, status: "denied", canAskAgain: false } })), 50);
          }
        },
      };
    }
  }, { shell, noShare });

  // Never count QA traffic, and never give a QA account a push channel.
  await context.route("**/api/events", (r) => r.fulfill({ status: 202, json: { ok: true } }));
  // Cloudflare Web Analytics: QA pageviews stay out of it (and its beacon
  // answers WebKit with a CORS error).
  await context.route((u) => u.hostname.endsWith("cloudflareinsights.com"), (r) => r.fulfill({ status: 204, body: "" }));
  await context.route("**/api/push/subscribe", (r) => { console.log(`  blocked ${r.request().method()} /push/subscribe`); return r.fulfill({ json: {} }); });
  await context.route("**/api/auth/me/push-token", (r) => { console.log("  blocked PATCH /auth/me/push-token"); return r.fulfill({ json: {} }); });

  const rec = { label, context, netChecks: true, problems: [], slowMs: 0 };
  // Slow network on demand: registered first, so the stubs above still win.
  await context.route((u) => u.pathname.startsWith("/api/") && u.pathname !== "/api/events", async (r) => {
    if (rec.slowMs) await sleep(rec.slowMs);
    await r.fallback();
  });
  context.on("page", (p) => watch(rec, p));
  contexts.push(rec);
  const page = await context.newPage();
  return { ...rec, page, rec };
}

function watch(rec, page) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (CONSOLE_ALLOW.some((re) => re.test(text))) return;
    if (CONSOLE_ALLOW_URL.some((re) => re.test(m.location()?.url ?? ""))) return;
    if (!rec.netChecks) return;
    rec.problems.push(`console error: ${scrub(text).slice(0, 300)}`);
  });
  page.on("pageerror", (e) => {
    const text = scrub(e.message).slice(0, 300);
    if (PAGE_ERROR_WARN.some((re) => re.test(text))) warn(`[${rec.label}] page error (cancelled fetch): ${text}`);
    else rec.problems.push(`page error: ${text}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 500) rec.problems.push(`HTTP ${res.status()} ${res.request().method()} ${scrub(res.url()).slice(0, 200)}`);
  });
  page.on("requestfailed", (req) => {
    if (!rec.netChecks) return;
    const url = req.url();
    if (!url.startsWith(BASE)) return;
    const why = req.failure()?.errorText ?? "";
    if (/cancel/i.test(why)) return; // navigation aborted the request
    rec.problems.push(`request failed: ${req.method()} ${scrub(url).slice(0, 200)} ${why}`);
  });
}

/** Runs one step, screenshots it, records problems seen meanwhile. Never throws. */
async function step(ctx, name, fn) {
  const before = ctx.rec.problems.length;
  let ok = true, detail = "";
  try {
    await fn();
  } catch (e) {
    ok = false;
    detail = scrub(e?.message ?? e).split("\n").filter((l) => l.trim()).slice(0, 6).join(" / ").slice(0, 500);
  }
  const fresh = ctx.rec.problems.slice(before);
  shotNo += 1;
  const file = join(RESULTS, `${String(shotNo).padStart(2, "0")}-${ctx.label}-${slug(name)}.png`);
  await ctx.page.screenshot({ path: file }).catch(() => {});
  if (fresh.length) { ok = false; detail = [detail, ...fresh].filter(Boolean).join(" | ").slice(0, 600); }
  check(`[${ctx.label}] ${name}`, ok, detail);
  return ok;
}

async function signIn(ctx, email, next = "/") {
  const s = await sessionFor(email);
  const frag = `access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=${s.expires_in}&token_type=bearer&type=magiclink`;
  await ctx.page.goto(`${BASE}/auth/callback?next=${encodeURIComponent(next)}#${frag}`);
  await ctx.page.waitForURL((u) => !u.pathname.startsWith("/auth/callback"), { timeout: 45_000 });
  return s;
}

/** Waits until no spinner or skeleton (data-loading) is left. */
async function settled(page, timeout = 30_000) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => !document.querySelector("[data-loading]"), null, { timeout });
}

function items(json) {
  return Array.isArray(json) ? json : json?.items ?? [];
}

async function ideasTitled(session, circleId, title) {
  const r = await api(session, "GET", `/circles/${circleId}/intents?limit=200`);
  return items(r.json).filter((i) => i.title === title).length;
}

async function myCircles(session) {
  const r = await api(session, "GET", "/auth/me");
  return r.json?.circles ?? [];
}

/** Creates a circle through the UI, from the dashboard or the zero-circle screen. Returns its id. */
async function createCircleUi(ctx, name, { double = false } = {}) {
  const { page } = ctx;
  await page.goto(`${BASE}/`);
  const first = page.getByLabel("Circle name");
  const newCircle = page.getByRole("button", { name: "New Circle" });
  await first.or(newCircle).first().waitFor({ timeout: 45_000 });
  if (await first.isVisible()) {
    await first.fill(name);
    const btn = page.getByRole("button", { name: "Create circle" });
    if (double) await btn.dblclick(); else await btn.click();
    await page.getByText(`Invite them to ${name}`).waitFor({ timeout: 30_000 });
    await page.getByRole("link", { name: `Go to ${name}` }).click();
  } else {
    await newCircle.click();
    await page.getByPlaceholder("Movie nights, school friends, the big trip…").fill(name);
    const btn = page.getByRole("button", { name: "Create", exact: true });
    if (double) await btn.dblclick(); else await btn.click();
  }
  await page.waitForURL(/\/circles\/[^/]+\/add/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split("/")[2];
}

async function addIdeaUi(ctx, circleId, text, { double = false } = {}) {
  const { page } = ctx;
  if (!new URL(page.url()).pathname.endsWith(`/circles/${circleId}`)) {
    await page.goto(`${BASE}/circles/${circleId}`);
  }
  const input = page.getByLabel("Add an idea or paste a link");
  await input.waitFor({ timeout: 30_000 });
  await input.fill(text);
  const save = page.getByRole("button", { name: "Save idea" });
  if (double) await save.dblclick(); else await save.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Add an idea or paste a link"]');
    return el && el.value === "";
  }, null, { timeout: 45_000 });
}

async function ideaId(session, circleId, title) {
  const r = await api(session, "GET", `/circles/${circleId}/intents?limit=200`);
  return items(r.json).find((i) => i.title === title)?.id;
}

function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

// --- Signed-out smoke (no secrets needed) ---------------------------------------
async function signedOutSmoke() {
  for (const viewport of [PHONE, SMALL]) {
    const ctx = await newContext(`out-${viewport.width}`, { viewport });
    await step(ctx, "landing loads", async () => {
      await ctx.page.goto(`${BASE}/`);
      await ctx.page.getByText("Someday").first().waitFor({ timeout: 30_000 });
      if (!(await noOverflow(ctx.page))) throw new Error("horizontal overflow");
    });
    await step(ctx, "login shows the email form", async () => {
      await ctx.page.goto(`${BASE}/login`);
      await ctx.page.getByRole("button", { name: "Send magic link" }).waitFor({ timeout: 30_000 });
    });
    await step(ctx, "a dead invite link says so", async () => {
      await ctx.page.goto(`${BASE}/join/qa-not-a-real-token`);
      await ctx.page.getByText("This invite link no longer works. Ask for a new one.").waitFor({ timeout: 30_000 });
    });
  }
}

// --- Signed-in flows --------------------------------------------------------------
async function coreFlows(state) {
  const A = await newContext("a-ios");
  const { page } = A;
  let session;

  await step(A, "sign in through the shell bridge", async () => {
    session = await signIn(A, QA_EMAIL_A);
    await ensureUser(session);
    await page.getByLabel("Circle name").or(page.getByRole("button", { name: "New Circle" })).first().waitFor({ timeout: 45_000 });
    if (await page.getByRole("region", { name: CARD_TITLE }).count()) throw new Error("App Store card shows inside the iOS app");
  });
  if (!session) return;
  state.sessionA = session;

  // Double tap on Create must make ONE circle.
  const mainName = circleName("main");
  await step(A, "create a circle with a double tap on Create", async () => {
    state.main = await createCircleUi(A, mainName, { double: true });
    const n = (await myCircles(session)).filter((c) => c.name === mainName).length;
    if (n !== 1) throw new Error(`${n} circles named "${mainName}"`);
  });
  const main = state.main;
  if (!main) return;

  const ideas = [
    ["plain text idea", "QA plain idea"],
    ["URL with a preview", "https://en.wikipedia.org/wiki/Kyoto"],
    ["Instagram link", "https://www.instagram.com/p/C0000000000/"],
    ["Google Maps link", "https://www.google.com/maps/place/Kyoto,+Japan"],
    ["long text", `QA long ${"plans for a long weekend by the sea ".repeat(20)}`.slice(0, 600)],
    ["emoji idea", "QA picnic 🌸🍙"],
  ];
  for (const [label, text] of ideas) {
    await step(A, `add idea: ${label}`, async () => {
      const before = items((await api(session, "GET", `/circles/${main}/intents?limit=200`)).json).length;
      await addIdeaUi(A, main, text);
      const after = items((await api(session, "GET", `/circles/${main}/intents?limit=200`)).json).length;
      if (after !== before + 1) throw new Error(`expected ${before + 1} ideas, found ${after}`);
    });
  }
  await step(A, "URL idea shows a preview", async () => {
    const r = await api(session, "GET", `/circles/${main}/intents?limit=200`);
    const kyoto = items(r.json).find((i) => (i.url ?? "").includes("wikipedia.org/wiki/Kyoto"));
    if (!kyoto) throw new Error("no idea with the Wikipedia URL");
    if (!/kyoto/i.test(kyoto.title ?? "") && !kyoto.image_url) throw new Error(`no preview: title "${kyoto.title}"`);
  });

  await step(A, "double tap on Save idea saves one idea", async () => {
    await addIdeaUi(A, main, "QA double tap idea", { double: true });
    await sleep(3000);
    const n = await ideasTitled(session, main, "QA double tap idea");
    if (n !== 1) throw new Error(`${n} ideas saved`);
  });

  // React, boost, plan with a date, done with a photo.
  const target = await ideaId(session, main, "QA plain idea");
  await step(A, "react and boost an idea", async () => {
    if (!target) throw new Error("idea not found");
    await page.goto(`${BASE}/intents/${target}`);
    // The creator starts as interested, so toggle off and back on.
    const interested = page.getByRole("button", { name: /^Interested/ });
    const state = async () => (await api(session, "GET", `/intents/${target}`)).json ?? {};
    const start = await state();
    await interested.click();
    await sleep(2500);
    if ((await state()).reacted_by_me === start.reacted_by_me) throw new Error("the first Interested tap did not change the reaction");
    await interested.click();
    await sleep(2500);
    if ((await state()).reacted_by_me !== start.reacted_by_me) throw new Error("the second Interested tap did not restore the reaction");
    await page.getByRole("button", { name: "Boost", exact: true }).click();
    await sleep(2500);
    if ((await state()).boosted_by_me === start.boosted_by_me) throw new Error("boost not saved");
  });

  await step(A, "plan an idea with a date", async () => {
    await page.goto(`${BASE}/intents/${target}`);
    await page.locator("button").filter({ hasText: /^\s*3?\s*planned\s*$/i }).click();
    const d = new Date(Date.now() + 14 * 864e5);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const card = page.getByRole("heading", { name: "This weekend?" });
    const shown = await card.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    if (!shown) {
      // The weekend card only shows on some days (lib/planPrompt.cjs). The
      // other way to give a plan its date: Edit > When.
      warn("the 'This weekend?' card did not show after Planned; dated the plan through Edit > When");
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByPlaceholder("next weekend, after exams, someday…").fill(iso);
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.getByRole("button", { name: "Save changes" }).waitFor({ state: "detached", timeout: 20_000 });
      const r = await api(session, "GET", `/intents/${target}`);
      if (r.json?.task_status !== "planned") throw new Error(`status ${r.json?.task_status}`);
      if (!JSON.stringify(r.json).includes(iso)) throw new Error(`planned date ${iso} not saved`);
      return;
    }
    await page.locator('input[type="date"]').evaluate((el, v) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, iso);
    await page.getByRole("button", { name: /^Plan it for / }).click();
    await sleep(3000);
    const r = await api(session, "GET", `/intents/${target}`);
    if (r.json?.task_status !== "planned") throw new Error(`status ${r.json?.task_status}`);
    if (!JSON.stringify(r.json).includes(iso)) throw new Error(`planned date ${iso} not saved`);
  });

  await step(A, "mark done with a photo", async () => {
    await page.goto(`${BASE}/intents/${target}`);
    await page.locator("button").filter({ hasText: /^\s*4?\s*done\s*$/i }).click();
    await page.getByText("You did it.").waitFor({ timeout: 15_000 });
    await page.locator('input[type="file"][accept^="image/jpeg"]').setInputFiles({ name: "qa-photo.png", mimeType: "image/png", buffer: png() });
    await page.getByRole("button", { name: "Remove photo" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Save the memory" }).click();
    await page.getByText("You did it.").waitFor({ state: "hidden", timeout: 60_000 });
    const r = await api(session, "GET", `/intents/${target}`);
    if (r.json?.task_status !== "done") throw new Error(`status ${r.json?.task_status}`);
    if (!(r.json?.done_photos?.length > 0)) throw new Error("no photo saved");
  });

  await step(A, "Meanwhile tab opens", async () => {
    await page.goto(`${BASE}/circles/${main}`);
    await page.getByRole("tab", { name: /Meanwhile/ }).click();
    await settled(page);
  });

}

/**
 * Slow and offline network, in a context of A's own with a circle of its own,
 * so the idea counts never race the core flows.
 */
async function networkFlows() {
  const A = await newContext("a-net");
  const { page } = A;
  let session, main;
  await step(A, "network: sign in and make a circle", async () => {
    session = await signIn(A, QA_EMAIL_A);
    const r = await api(session, "POST", "/circles", { name: circleName("network") });
    main = r.json?.id;
    if (!main) throw new Error(`POST /circles HTTP ${r.status}`);
  });
  if (!main) return;

  // Slow network: every API call 2 s late. One tap, one idea, a busy state.
  await step(A, "slow network: save shows busy and saves once", async () => {
    await page.goto(`${BASE}/circles/${main}`);
    await settled(page);
    A.rec.slowMs = 2000;
    try {
      const input = page.getByLabel("Add an idea or paste a link");
      await input.fill("QA slow network idea");
      await page.getByRole("button", { name: "Save idea" }).click();
      await page.locator("form[data-tour=add-intent] .animate-spin").waitFor({ timeout: 3000 });
      await page.waitForFunction(() => document.querySelector('input[aria-label="Add an idea or paste a link"]')?.value === "", null, { timeout: 60_000 });
    } finally {
      A.rec.slowMs = 0;
      await page.waitForLoadState("networkidle").catch(() => {});
    }
    const n = await ideasTitled(session, main, "QA slow network idea");
    if (n !== 1) throw new Error(`${n} ideas saved`);
  });

  // Offline mid-save: an error, no stuck spinner, and the app recovers.
  await step(A, "offline mid-save shows an error and recovers", async () => {
    await page.goto(`${BASE}/circles/${main}`);
    await settled(page);
    A.rec.netChecks = false;
    try {
      await page.getByLabel("Add an idea or paste a link").fill("QA offline idea");
      await A.context.setOffline(true);
      await page.getByRole("button", { name: "Save idea" }).click();
      await page.getByRole("alert").first().waitFor({ timeout: 20_000 });
      await sleep(2000);
      if (await page.locator("form[data-tour=add-intent] .animate-spin").count()) throw new Error("spinner still spinning offline");
      await A.context.setOffline(false);
      await page.reload();
      await settled(page, 45_000);
    } finally {
      await A.context.setOffline(false);
      A.rec.netChecks = true;
    }
  });

}

/** A copies an invite link in the UI, then B joins with it. */
async function inviteFlows(state) {
  const A = await newContext("a-invite");
  const { page } = A;
  let session;
  await step(A, "invite: sign in", async () => {
    session = await signIn(A, QA_EMAIL_A);
  });
  if (!session) return;
  state.sessionA = session;

  // Invite: A copies the link for B.
  const inviteName = circleName("invite");
  await step(A, "copy the invite link", async () => {
    const r = await api(session, "POST", "/circles", { name: inviteName });
    state.invite = r.json?.id;
    if (!state.invite) throw new Error(`POST /circles HTTP ${r.status}`);
    await api(session, "POST", `/circles/${state.invite}/intents`, { title: "QA first invite idea" });
    await page.goto(`${BASE}/circles/${state.invite}`);
    await page.getByRole("button", { name: "Invite" }).click();
    await page.getByRole("button", { name: "Copy link" }).click();
    await page.getByRole("button", { name: "Copied" }).waitFor({ timeout: 10_000 });
    const clip = await page.evaluate(() => window.__qaClip.at(-1) ?? "");
    if (!clip.includes("/join/")) throw new Error("no invite link copied");
    state.inviteLink = clip;
    state.inviteName = inviteName;
  });

  await inviteFlow(state);
}

/** A deleted circle opened again, and Settings. */
async function deletedAndSettings() {
  const A = await newContext("a-misc");
  const { page } = A;
  let session;
  await step(A, "misc: sign in", async () => {
    session = await signIn(A, QA_EMAIL_A);
  });
  if (!session) return;

  // A deleted circle opened again from history.
  await step(A, "a deleted circle opened from history", async () => {
    const r = await api(session, "POST", "/circles", { name: circleName("deleted") });
    const id = r.json?.id;
    if (!id) throw new Error(`POST /circles HTTP ${r.status}`);
    await page.goto(`${BASE}/circles/${id}`);
    await settled(page);
    await page.getByRole("button", { name: "Delete circle" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });
    await page.goto(`${BASE}/circles/${id}`);
    await sleep(8000);
    if (await page.locator("[data-loading]").count()) throw new Error("still loading 8 s after opening a deleted circle");
    if (await page.getByRole("button", { name: "Delete circle" }).count()) throw new Error("the deleted circle still renders");
  });

  await step(A, "settings opens", async () => {
    await page.goto(`${BASE}/`);
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Sign out" }).waitFor({ timeout: 30_000 });
    await settled(page);
  });
}

async function inviteFlow(state) {
  if (!state.inviteLink) { check("[b] invite flow has a link from A", false); return; }
  const B = await newContext("b-ios");
  const { page } = B;
  await step(B, "signed out, the invite shows the circle", async () => {
    await page.goto(state.inviteLink);
    await page.getByRole("heading", { name: new RegExp(`Join\\s+${state.inviteName}`) }).waitFor({ timeout: 30_000 });
  });

  let sessionB = null;
  await step(B, "sign in by email from the invite", async () => {
    // A real code email spends the project's shared hourly email quota (real users
    // need it). Only QA_REAL_EMAIL=1 sends one; otherwise B uses the session bridge.
    if (process.env.QA_REAL_EMAIL !== "1") {
      await signIn(B, QA_EMAIL_B, new URL(state.inviteLink).pathname);
      return;
    }
    await page.getByRole("link", { name: "Use email instead" }).click();
    await page.getByPlaceholder("you@example.com").fill(QA_EMAIL_B);
    await page.getByRole("button", { name: "Send magic link" }).click();
    const sent = page.getByText("Check your email");
    const failed = page.locator("form .text-cp");
    await sent.or(failed).first().waitFor({ timeout: 30_000 });
    if (await sent.isVisible()) {
      const { otp } = await generateLink(QA_EMAIL_B);
      await page.getByPlaceholder("Code from the email").fill(otp);
      await page.getByRole("button", { name: "Sign in with code" }).click();
    } else {
      warn(`email send failed (${await failed.innerText()}); B signed in through the bridge instead`);
      await signIn(B, QA_EMAIL_B, new URL(state.inviteLink).pathname);
    }
  });

  await step(B, "the join lands in the circle", async () => {
    await page.waitForURL(new RegExp(`/circles/${state.invite}`), { timeout: 45_000 });
    await page.getByText(state.inviteName).first().waitFor({ timeout: 30_000 });
    sessionB = await sessionFor(QA_EMAIL_B);
    const mine = await myCircles(sessionB);
    const c = mine.find((x) => x.id === state.invite);
    if (!c) throw new Error("B is not a member after the join");
    state.members = c.member_count;
    if (c.member_count !== 2) throw new Error(`member_count ${c.member_count}`);
  });

  await step(B, "the link again while a member opens the circle", async () => {
    await page.goto(state.inviteLink);
    await page.waitForURL(new RegExp(`/circles/${state.invite}`), { timeout: 45_000 });
    if (await page.getByText("This invite link no longer works").count()) throw new Error("dead-link error for a member");
    const c = (await myCircles(sessionB)).find((x) => x.id === state.invite);
    if (c?.member_count !== 2) throw new Error(`member_count ${c?.member_count} after the second open`);
  });

  await step(B, "A sees B in the circle", async () => {
    const c = (await myCircles(state.sessionA)).find((x) => x.id === state.invite);
    if (c?.member_count !== 2) throw new Error(`A sees member_count ${c?.member_count}`);
  });
}

async function darkMode(state) {
  const D = await newContext("a-dark", { colorScheme: "dark" });
  await step(D, "dark mode dashboard is charcoal", async () => {
    await signIn(D, QA_EMAIL_A);
    await settled(D.page);
    const rgb = await D.page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--bg-a").trim() || getComputedStyle(document.body).backgroundColor;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    });
    const [r, g, b] = rgb;
    if (!(r < 60 && g < 60 && b < 60)) throw new Error(`background rgb(${rgb}) is not dark`);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 12) throw new Error(`background rgb(${rgb}) has a colour tint`);
  });
  if (state.main) {
    await step(D, "dark mode circle page", async () => {
      await D.page.goto(`${BASE}/circles/${state.main}`);
      await settled(D.page);
    });
  }
}

async function small(state) {
  const S = await newContext("a-320", { viewport: SMALL });
  await step(S, "320x480 dashboard", async () => {
    await signIn(S, QA_EMAIL_A);
    await settled(S.page);
    if (!(await noOverflow(S.page))) throw new Error("horizontal overflow");
  });
  if (!state.main) return;
  for (const [name, path] of [["circle", `/circles/${state.main}`], ["add page", `/circles/${state.main}/add`], ["settings", "/settings"]]) {
    await step(S, `320x480 ${name}`, async () => {
      await S.page.goto(`${BASE}${path}`);
      await settled(S.page);
      if (!(await noOverflow(S.page))) throw new Error("horizontal overflow");
    });
  }
}

/** The "Someday is on the App Store now." card: never in the iOS app; both buttons on the web. */
async function appStoreCard(state) {
  // Show the card again whatever the account stored, so the check repeats.
  const unseen = (circlesEmpty) => async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    if (json?.user) json.user.ios_card_seen_at = null;
    if (circlesEmpty) json.circles = [];
    await route.fulfill({ response: res, json });
  };

  const I = await newContext("card-ios");
  await I.context.route("**/api/auth/me", unseen(false));
  await step(I, "card hidden in the iOS app", async () => {
    await signIn(I, QA_EMAIL_A);
    await I.page.getByRole("button", { name: "New Circle" }).or(I.page.getByLabel("Circle name")).first().waitFor({ timeout: 45_000 });
    await sleep(1500);
    if (await I.page.getByRole("region", { name: CARD_TITLE }).count()) throw new Error("card renders for the iOS shell user agent");
  });

  const W = await newContext("card-web", { ua: WEB_UA, shell: false });
  await W.context.route("**/api/auth/me", unseen(false));
  await step(W, "card shows on the web and copies the invite link", async () => {
    await signIn(W, QA_EMAIL_A);
    const card = W.page.getByRole("region", { name: CARD_TITLE });
    await card.waitFor({ timeout: 45_000 });
    await card.getByRole("button", { name: "Copy invite link" }).click();
    await W.page.getByText("Invite link copied.").waitFor({ timeout: 15_000 });
    const clip = await W.page.evaluate(() => window.__qaClip.at(-1) ?? "");
    if (!clip.includes("/join/")) throw new Error(`copied "${clip.slice(0, 40)}"`);
  });
  await step(W, "card Close folds it away and is stored", async () => {
    const card = W.page.getByRole("region", { name: CARD_TITLE });
    const seen = W.page.waitForResponse((r) => r.url().includes("/api/auth/ios-card/seen"), { timeout: 15_000 });
    await card.getByRole("button", { name: "Close" }).click();
    const res = await seen;
    if (res.status() >= 300) throw new Error(`ios-card/seen HTTP ${res.status()}`);
    await card.waitFor({ state: "detached", timeout: 10_000 });
  });

  const N = await newContext("card-web-nocircle", { ua: WEB_UA, shell: false, noShare: true });
  await N.context.route("**/api/auth/me", unseen(true));
  await step(N, "no-circle card copies the App Store link", async () => {
    await signIn(N, QA_EMAIL_A);
    // Zero circles shows the first-circle screen; skip it to reach the card.
    const skip = N.page.getByRole("button", { name: "Skip for now" });
    const card = N.page.getByRole("region", { name: CARD_TITLE });
    await skip.or(card).first().waitFor({ timeout: 45_000 });
    if (await skip.isVisible()) await skip.click();
    await card.getByRole("button", { name: "Invite your friends" }).click();
    await N.page.getByText("Link copied.").waitFor({ timeout: 15_000 });
    const clip = await N.page.evaluate(() => window.__qaClip.at(-1) ?? "");
    if (!clip.includes(APP_STORE_HOST)) throw new Error(`copied "${clip.slice(0, 60)}"`);
  });
}

async function signOutLast() {
  const O = await newContext("a-signout");
  await step(O, "sign out tells the shell and returns to sign-in", async () => {
    await signIn(O, QA_EMAIL_A, "/settings");
    await O.page.getByRole("button", { name: "Sign out" }).click();
    await O.page.waitForURL(/\/login/, { timeout: 30_000 });
    const msgs = await O.page.evaluate(() => window.__qaShell ?? []);
    if (!msgs.some((m) => m.includes('"signed-out"'))) throw new Error("the shell never got signed-out");
  });
}

// --- Main ------------------------------------------------------------------------
async function main() {
  if (!hasSecrets()) {
    await signedOutSmoke();
    console.log("SKIPPED signed-in flows: QA secrets missing");
    return;
  }
  assertSafeAccounts();
  console.log(`QA run ${RUN_ID}: A ${maskEmail(QA_EMAIL_A)}, B ${maskEmail(QA_EMAIL_B)}, ${BASE}`);
  // Leftovers from an earlier run that died before its cleanup.
  await cleanupAll();
  const state = {};
  // A fixture circle for the read-only checks (dark mode, 320x480), so they
  // need not wait for the core flows.
  const owner = await sessionFor(QA_EMAIL_A);
  await ensureUser(owner);
  const fixture = await api(owner, "POST", "/circles", { name: circleName("fixture") });
  state.main = fixture.json?.id;
  if (state.main) await api(owner, "POST", `/circles/${state.main}/intents`, { title: "QA fixture idea" });
  else check("fixture circle", false, `POST /circles HTTP ${fixture.status}`);
  // Independent groups, each in its own browser contexts, side by side.
  // Account B is used by inviteFlows only.
  await Promise.all([
    signedOutSmoke(),
    coreFlows({}),
    networkFlows(),
    inviteFlows(state),
    deletedAndSettings(),
    darkMode(state),
    small(state),
    appStoreCard(state),
  ]);
  // Last, alone: a sign-out ends every session of A.
  await signOutLast();
}

try {
  await main();
} catch (e) {
  check("suite ran to the end", false, scrub(e?.message ?? e));
} finally {
  for (const c of contexts) {
    await c.context.tracing.stop({ path: join(RESULTS, `trace-${c.label}.zip`) }).catch(() => {});
    await c.context.close().catch(() => {});
  }
  await browser.close();
}

console.log(`\n${failures.length ? "FAILED" : "PASSED"}: ${failures.length} failed, ${warnings.length} warnings`);
for (const f of failures) console.log(`  FAIL ${f}`);
for (const w of warnings) console.log(`  WARN ${w}`);
process.exit(failures.length ? 1 : 0);
