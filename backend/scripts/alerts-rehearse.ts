/**
 * Send both collector alerts for real, without touching the ledger or the
 * account: each condition is simulated, the email goes out through the
 * configured mailer, and the incidents are kept in memory so the real
 * alert table is left as it is.
 *
 * Run with: npm run alerts:rehearse
 * Needs RESEND_API_KEY and ALERT_EMAIL_TO.
 */
import { alertAfterRun, resendMailer } from "../src/ops/alerts.js";
import { memoryAlertStore } from "../src/ops/alert-memory.js";

const mailer = resendMailer();
if (!mailer) {
  console.error("Set RESEND_API_KEY and ALERT_EMAIL_TO first.");
  process.exit(2);
}
const network = `${process.env.BEAVER_NETWORK ?? "testnet"} (rehearsal)`;
const sent: string[] = [];
const deps = { store: memoryAlertStore(), mailer: { send: async (s: string, t: string) => (sent.push(s), mailer.send(s, t)) } };

console.log("1. A failed run, three times over: one email expected.");
for (let i = 0; i < 3; i++) await alertAfterRun({ ok: false, summary: "the RPC could not be reached" }, network, deps);
console.log("2. The next run succeeds: one recovery email expected.");
await alertAfterRun({ ok: true, gap: null }, network, deps);
console.log("3. A gap, seen twice: one email expected.");
for (let i = 0; i < 2; i++) await alertAfterRun({ ok: true, gap: { from: 1000, to: 1200 } }, network, deps);

console.log(`\nSent ${sent.length} emails:`);
sent.forEach((s) => console.log(`  ${s}`));
process.exit(sent.length === 3 ? 0 : 1);
