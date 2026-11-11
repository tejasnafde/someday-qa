// QA auth helpers for the production QA suite. Dependency-free on purpose
// (Node builtins and the global fetch only): the macOS iOS job runs
// cleanup.mjs and this CLI WITHOUT `npm ci`.
//
// Why: the web suite (web-qa.mjs) and the iOS job sign in two dedicated QA
// accounts on PRODUCTION (https://someday.tn07.dev). A session is minted the
// way the API's own /auth/webview-session does it: admin generate_link, then
// /auth/v1/verify with the token hash.
//
// Secrets (GitHub Actions): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// QA_EMAIL_A, QA_EMAIL_B. Optional: QA_BASE_URL, QA_RUN_ID, QA_RESULTS_DIR,
// SUPABASE_ANON_KEY (the key for /auth/v1/verify; without it the service
// role key is used there, which mints the same user session).
//
// CLI (prints ONLY the value on stdout, logs go to stderr):
//   node web/auth.mjs otp <A|B>      a fresh email OTP for that account
//   node web/auth.mjs invite <A|B> [label]
//                                                   creates "QA <RUN_ID> <label>" (default
//                                                   label "ios invite") with one idea, prints
//                                                   its invite token. A fresh circle per link
//                                                   flow, so a token never expires mid-run.
//
// Rate limit: every call here runs admin generate_link, which counts toward
// Supabase's one-code-per-address-per-60-s limit. Never call otp or invite for
// an account in the 60 s before the app asks to email that account a code.
//
// Safety: every account helper refuses to run unless both QA emails contain
// "qa" and differ, and only ever acts on those two emails. Emails and tokens
// are never printed in full.
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root. */
export const REPO_ROOT = resolve(HERE, "..");

export const BASE = (process.env.QA_BASE_URL || "https://someday.tn07.dev").replace(/\/+$/, "");
export const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const QA_EMAIL_A = process.env.QA_EMAIL_A || "";
export const QA_EMAIL_B = process.env.QA_EMAIL_B || "";
export const RUN_ID = process.env.QA_RUN_ID || String(Date.now());
const resultsEnv = process.env.QA_RESULTS_DIR || "results/web";
/** Relative paths resolve against the repository root, so the scripts work from any cwd. */
export const RESULTS = isAbsolute(resultsEnv) ? resultsEnv : join(REPO_ROOT, resultsEnv);

/** The key /auth/v1/verify is called with: the public anon key if set, else the service role key. */
export const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;

export function hasSecrets() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && QA_EMAIL_A && QA_EMAIL_B);
}

/** "qa***@t***" style. Never prints a full email. */
export function maskEmail(email) {
  const [local = "", domain = ""] = String(email).split("@");
  return `${local.slice(0, 2)}***@${domain.slice(0, 1)}***`;
}

/** Removes tokens from any string before it is logged. */
export function scrub(text) {
  return String(text)
    .replace(/(access_token|refresh_token|token_hash|token)=[^&\s#"]+/gi, "$1=***")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>")
    .replace(/sb_(secret|publishable)_[\w-]+/g, "sb_$1_***")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, (m) => maskEmail(m));
}

/** Throws unless both QA emails look like QA accounts and are different. */
export function assertSafeAccounts() {
  const a = QA_EMAIL_A.trim().toLowerCase();
  const b = QA_EMAIL_B.trim().toLowerCase();
  if (!a || !b) throw new Error("QA_EMAIL_A and QA_EMAIL_B must both be set");
  if (!a.includes("qa") || !b.includes("qa")) throw new Error("Refusing to run: a QA email does not contain \"qa\"");
  if (a === b) throw new Error("Refusing to run: QA_EMAIL_A and QA_EMAIL_B are the same account");
}

function assertQaEmail(email) {
  assertSafeAccounts();
  const e = String(email).trim().toLowerCase();
  if (e !== QA_EMAIL_A.trim().toLowerCase() && e !== QA_EMAIL_B.trim().toLowerCase()) {
    throw new Error(`Refusing to act on ${maskEmail(email)}: not one of the two QA accounts`);
  }
}

/** Service-role headers. A legacy JWT key also goes in Authorization; an sb_secret_ key goes in apikey only. */
export function adminHeaders() {
  const h = { apikey: SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
  if (SUPABASE_SERVICE_ROLE_KEY.startsWith("eyJ")) h.Authorization = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  return h;
}

/** A fresh magic link for a QA account: { otp, hashed }. Overwrites any code emailed before. */
export async function generateLink(email) {
  assertQaEmail(email);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ type: "magiclink", email }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`generate_link failed for ${maskEmail(email)}: HTTP ${res.status}`);
  const props = json.properties ?? json;
  const otp = props.email_otp ?? json.email_otp;
  const hashed = props.hashed_token ?? json.hashed_token;
  if (!hashed) throw new Error(`generate_link for ${maskEmail(email)} returned no hashed_token`);
  return { otp, hashed };
}

/**
 * generate_link replaces the account's pending token, so two sessions minted
 * for one account at the same time race, and the first verify gets a 403.
 * Within this process, sessions for one account are minted one at a time.
 * Across processes (app shards share the inviter account), a 403 is retried.
 */
const minting = new Map();

/** A new, independent Supabase session for a QA account: { access_token, refresh_token, expires_in, user }. */
export function sessionFor(email) {
  const key = String(email).toLowerCase();
  const next = (minting.get(key) ?? Promise.resolve()).catch(() => {}).then(() => mintSession(email));
  minting.set(key, next);
  return next;
}

async function mintSession(email) {
  for (let attempt = 1; ; attempt++) {
    const { hashed } = await generateLink(email);
    const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "magiclink", token_hash: hashed }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) {
      return {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_in: json.expires_in ?? 3600,
        user: json.user,
      };
    }
    if (res.status !== 403 || attempt >= 5) throw new Error(`verify failed for ${maskEmail(email)}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 2500));
  }
}

/** The production API through the web's same-origin proxy: { status, json }. */
export async function api(session, method, path, body) {
  const token = typeof session === "string" ? session : session.access_token;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * Make sure the account has its public.users row. A new QA account has none
 * until the first POST /auth/verify (the web does it in /auth/callback).
 */
export async function ensureUser(session) {
  const me = await api(session, "GET", "/auth/me");
  if (me.status === 200) return me.json;
  const v = await api(session, "POST", "/auth/verify");
  if (v.status >= 300) throw new Error(`POST /auth/verify failed: HTTP ${v.status}`);
  const again = await api(session, "GET", "/auth/me");
  if (again.status !== 200) throw new Error(`GET /auth/me failed after verify: HTTP ${again.status}`);
  return again.json;
}

/**
 * A new circle owned by a QA account, with one idea ("QA ios photo idea"):
 * { id, token }. Every QA circle name starts with "QA ", so cleanup finds it.
 */
export async function createInvite(email, name) {
  if (!String(name).startsWith("QA ")) throw new Error("A QA circle name must start with \"QA \"");
  const session = await sessionFor(email);
  await ensureUser(session);
  const created = await api(session, "POST", "/circles", { name });
  if (created.status >= 300 || !created.json?.id) throw new Error(`POST /circles failed: HTTP ${created.status}`);
  const id = created.json.id;
  // CreateIntentRequest needs only a non-blank title.
  const idea = await api(session, "POST", `/circles/${id}/intents`, { title: "QA ios photo idea" });
  if (idea.status >= 300) throw new Error(`POST /circles/:id/intents failed: HTTP ${idea.status}`);
  let token = created.json.invite_token;
  if (!token) {
    const me = await api(session, "GET", "/auth/me");
    token = me.json?.circles?.find((c) => c.id === id)?.invite_token;
  }
  if (!token) throw new Error("No invite token for the new circle");
  return { id, token };
}

function emailFor(which) {
  const w = String(which || "").toUpperCase();
  if (w === "A") return QA_EMAIL_A;
  if (w === "B") return QA_EMAIL_B;
  throw new Error("Expected A or B");
}

async function cli(args) {
  const [cmd, which, label] = args;
  if (!hasSecrets()) throw new Error("QA secrets missing (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, QA_EMAIL_A, QA_EMAIL_B)");
  assertSafeAccounts();
  const email = emailFor(which);
  if (cmd === "otp") {
    const { otp } = await generateLink(email);
    if (!otp) throw new Error("generate_link returned no email_otp");
    process.stdout.write(`${otp}\n`);
    return;
  }
  if (cmd === "invite") {
    const { token } = await createInvite(email, `QA ${RUN_ID} ${label || "ios invite"}`);
    process.stdout.write(`${token}\n`);
    return;
  }
  throw new Error("Usage: node auth.mjs otp <A|B> | invite <A|B> [label]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`auth.mjs: ${scrub(e?.message ?? e)}\n`);
    process.exit(1);
  });
}
