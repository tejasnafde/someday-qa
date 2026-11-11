// The QA helper: a small HTTP server on the runner (127.0.0.1 only) that the
// Maestro flows call through flows/helper.js (runScript). It lets one Maestro
// session run a whole shard: the steps that need a secret or a host command
// (a sign-in code, a fresh invite link, a share intent, closing Safari) happen
// here, between two Maestro commands, with no second Maestro start.
//
// Started by run-shard.sh. Dependency-free (Node builtins only). Never run on a
// laptop: it drives the simulator or emulator.
//
// Env: QA_PLATFORM (ios|android), DEVICE (simulator UDID or adb serial),
// QA_SHARD, QA_RUN_ID, QA_HELPER_PORT, QA_HELPER_LOG, and the QA secrets
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, QA_EMAIL_A = the inviter,
// QA_EMAIL_B = the account this shard signs in).
//
// GET /otp                  a fresh sign-in code for B (retries while the
//                           per-address limit holds)
// GET /invite-open?arg=L    makes (once per label) A's circle "QA <run> <shard> L",
//                           opens its invite link on the device, returns the name
// GET /circle?arg=L         makes B's own circle "QA <run> <shard> L" with one idea
// GET /share?arg=TEXT       android: shares TEXT into Someday (ACTION_SEND)
// GET /push-reset           android: notification permission back to "not asked"
// GET /close-safari         ios: closes Safari
// GET /tour-off             marks every coachmark step seen and the App Store card
//                           closed for B, so neither covers or shadows what a flow
//                           taps (call it after sign-in)
// GET /health               ok
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const auth = await import(pathToFileURL(resolve(HERE, "..", "web", "auth.mjs")).href);
const { QA_EMAIL_A, QA_EMAIL_B, RUN_ID, api, createInvite, ensureUser, generateLink, scrub, sessionFor } = auth;

const PLATFORM = process.env.QA_PLATFORM || "";
const DEVICE = process.env.DEVICE || "";
const SHARD = process.env.QA_SHARD || "shard";
const PORT = Number(process.env.QA_HELPER_PORT || 8765);
const LOG = process.env.QA_HELPER_LOG || join(HERE, "helper.log");
const WEB = "https://someday.tn07.dev";
const PKG = "app.someday.capture";

const invites = new Map(); // label -> token, so a second open reuses the link
// Every coachmark step id of the web app, a copy of its tour registry
// (tour-ids.json). A step added to the app later and missing here can cover
// what a flow taps: add its id to tour-ids.json.
const TOUR_IDS = JSON.parse(readFileSync(join(HERE, "tour-ids.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()} ${scrub(line)}\n`);
const nameFor = (label) => `QA ${RUN_ID} ${SHARD} ${label}`;

function run(cmd, args) {
  log(`$ ${cmd} ${args.join(" ").replace(/\/join\/[\w-]+/g, "/join/***")}`);
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
}

function openLink(url) {
  if (PLATFORM === "ios") run("xcrun", ["simctl", "openurl", DEVICE, url]);
  else run("adb", ["-s", DEVICE, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-c", "android.intent.category.BROWSABLE", "-d", url]);
}

/** A sign-in code for B. The app asked for an email a moment ago; retry while Supabase says "wait". */
async function otp() {
  const until = Date.now() + 75_000;
  for (;;) {
    try {
      const { otp: code } = await generateLink(QA_EMAIL_B);
      if (!code) throw new Error("no email_otp");
      return code;
    } catch (e) {
      if (Date.now() > until) throw e;
      log(`otp retry: ${e?.message ?? e}`);
      await sleep(5000);
    }
  }
}

const routes = {
  "/health": async () => "ok",
  "/otp": otp,
  "/invite-open": async (label) => {
    if (!label) throw new Error("label needed");
    let token = invites.get(label);
    if (!token) {
      token = (await createInvite(QA_EMAIL_A, nameFor(label))).token;
      invites.set(label, token);
    }
    openLink(`${WEB}/join/${token}`);
    return nameFor(label);
  },
  "/circle": async (label) => {
    const session = await sessionFor(QA_EMAIL_B);
    await ensureUser(session);
    const r = await api(session, "POST", "/circles", { name: nameFor(label) });
    if (!r.json?.id) throw new Error(`POST /circles HTTP ${r.status}`);
    await api(session, "POST", `/circles/${r.json.id}/intents`, { title: "QA ios photo idea" });
    return nameFor(label);
  },
  "/share": async (text) => {
    if (PLATFORM !== "android") throw new Error("share is android only");
    // adb shell joins the words into one device command line: quote the text.
    run("adb", ["-s", DEVICE, "shell", "am", "start", "-W", "-a", "android.intent.action.SEND", "-t", "text/plain",
      "--es", "android.intent.extra.TEXT", `'${String(text).replace(/'/g, "")}'`, "-n", `${PKG}/.MainActivity`]);
    return "ok";
  },
  "/push-reset": async () => {
    if (PLATFORM !== "android") throw new Error("push-reset is android only");
    run("adb", ["-s", DEVICE, "shell", "pm", "revoke", PKG, "android.permission.POST_NOTIFICATIONS"]);
    run("adb", ["-s", DEVICE, "shell", "pm", "clear-permission-flags", PKG, "android.permission.POST_NOTIFICATIONS", "user-set", "user-fixed"]);
    return "ok";
  },
  "/tour-off": async () => {
    // A new session for B (no email). Run it only after the app's sign-in:
    // generate_link counts toward the per-address code limit.
    const session = await sessionFor(QA_EMAIL_B);
    await ensureUser(session);
    const r = await api(session, "POST", "/tour/seen", { step_ids: TOUR_IDS });
    if (r.status >= 300) throw new Error(`POST /tour/seen HTTP ${r.status}`);
    // The App Store card (Android and web only) names the circle too, so a
    // tap on the circle name could land on the card. The web QA checks it.
    const card = await api(session, "POST", "/auth/ios-card/seen");
    if (card.status >= 300) throw new Error(`POST /auth/ios-card/seen HTTP ${card.status}`);
    return `${TOUR_IDS.length} steps seen, App Store card closed`;
  },
  "/close-safari": async () => {
    if (PLATFORM === "ios") {
      try { run("xcrun", ["simctl", "terminate", DEVICE, "com.apple.mobilesafari"]); } catch { /* not running */ }
    }
    return "ok";
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const fn = routes[url.pathname];
  if (!fn) { res.writeHead(404).end("no such route"); return; }
  try {
    const out = String(await fn(url.searchParams.get("arg") ?? ""));
    log(`${url.pathname} ok`);
    res.writeHead(200, { "Content-Type": "text/plain" }).end(out);
  } catch (e) {
    const msg = scrub(e?.message ?? e);
    log(`${url.pathname} FAILED ${msg}`);
    res.writeHead(500, { "Content-Type": "text/plain" }).end(msg);
  }
}).listen(PORT, "127.0.0.1", () => log(`helper on ${PORT} for ${PLATFORM} ${SHARD}`));
