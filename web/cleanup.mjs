// Deletes what a QA run created on PRODUCTION. Runs in an always() step after
// each job of .github/workflows/qa.yml (web, android, ios), so a
// failed run still cleans up. Dependency-free: the macOS job runs it without
// `npm ci` (`node web/cleanup.mjs` from the repo root).
//
// For each QA account (QA_EMAIL_A, QA_EMAIL_B) only, through the app's own API:
// every circle whose name starts with "QA " is deleted (soft delete) when the
// account owns it, or left when it is only a member; then the account's Expo
// push token is cleared. Nothing else is touched, and never a circle without
// the "QA " prefix. Without the QA secrets it does nothing.
//
// Shared inviter: the app shards (qa.yml, android and ios) share account A as
// an API-only inviter while other shards run. With QA_A_PREFIX set (for
// example "QA <run id> android-1"), A deletes only its circles with that
// prefix, plus "QA " circles older than STALE_HOURS left by a run that died.
// B, the shard's own account, is cleaned in full.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { QA_EMAIL_A, QA_EMAIL_B, api, assertSafeAccounts, hasSecrets, maskEmail, scrub, sessionFor } from "./auth.mjs";

const PREFIX = "QA ";
const STALE_HOURS = 6;
const A_PREFIX = process.env.QA_A_PREFIX || "";

/** Whether cleanup may touch this circle of this account. */
function mine(email, c) {
  if (typeof c.name !== "string" || !c.name.startsWith(PREFIX)) return false;
  if (!A_PREFIX || email !== QA_EMAIL_A) return true;
  if (c.name.startsWith(A_PREFIX)) return true;
  const born = Date.parse(c.created_at ?? "");
  return Number.isFinite(born) && Date.now() - born > STALE_HOURS * 3600e3;
}

export async function cleanupAccount(email) {
  const session = await sessionFor(email);
  const me = await api(session, "GET", "/auth/me");
  if (me.status === 401 || me.status === 404) {
    console.log(`cleanup ${maskEmail(email)}: no user row yet, nothing to clean`);
    return { deleted: 0, left: 0, errors: 0 };
  }
  if (me.status !== 200) throw new Error(`GET /auth/me: HTTP ${me.status}`);
  const myId = me.json.user?.id ?? session.user?.id;
  let deleted = 0, left = 0, errors = 0;
  for (const c of me.json.circles ?? []) {
    if (!mine(email, c)) continue;
    const owner = c.owner_id === myId;
    const r = owner
      ? await api(session, "DELETE", `/circles/${c.id}`)
      : await api(session, "POST", `/circles/${c.id}/leave`);
    if (r.status < 300) owner ? deleted++ : left++;
    else {
      console.log(`cleanup ${maskEmail(email)}: ${owner ? "delete" : "leave"} returned HTTP ${r.status}`);
      if (r.status >= 500) errors++;
    }
  }
  const push = await api(session, "PATCH", "/auth/me/push-token", { token: null });
  console.log(`cleanup ${maskEmail(email)}: deleted ${deleted}, left ${left}, push token cleared HTTP ${push.status}`);
  return { deleted, left, errors };
}

export async function cleanupAll() {
  if (!hasSecrets()) {
    console.log("cleanup: QA secrets missing, nothing to do");
    return 0;
  }
  assertSafeAccounts();
  let errors = 0;
  // B first: it leaves A's circles, then A deletes its own.
  for (const email of [QA_EMAIL_B, QA_EMAIL_A]) {
    try {
      errors += (await cleanupAccount(email)).errors;
    } catch (e) {
      console.log(`cleanup ${maskEmail(email)} failed: ${scrub(e?.message ?? e)}`);
      errors++;
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cleanupAll().then((errors) => process.exit(errors ? 1 : 0));
}
