import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { forLog } from "../lib/public-error.js";

/**
 * Email the operator when the event collector fails or finds a gap in the
 * ledger history, once per incident.
 *
 * The collector is what keeps a complete record of the account: RPC holds
 * events for days, not months. A failed run or a gap is only recoverable
 * while the missing ledgers are still in the RPC window, so it has to reach
 * a person quickly, and it must not turn into an email per cron run that
 * gets filtered away.
 */

export type AlertKind = "collector_failed" | "ledger_gap";

export interface Alert {
  kind: AlertKind;
  /** One incident per key. A gap is keyed by its range, a failure is one incident until a run succeeds. */
  key: string;
  network: string;
  /** A fixed summary. Never a raw provider error, which can carry the RPC key. */
  detail: string;
}

export interface OpenAlert extends Alert {
  openedAt: string;
  repeats: number;
}

/** Where open incidents are remembered between runs. */
export interface AlertStore {
  find(key: string): Promise<OpenAlert | null>;
  open(alert: Alert): Promise<void>;
  seenAgain(key: string): Promise<void>;
  markEmailed(key: string): Promise<void>;
  /** Close every open incident of a kind, and return them. */
  resolve(kind: AlertKind, network: string): Promise<OpenAlert[]>;
}

export interface Mailer {
  send(subject: string, text: string): Promise<void>;
}

export interface AlertDeps {
  store: AlertStore;
  mailer: Mailer | null;
  now?: () => Date;
}

const ACTIONS: Record<AlertKind, string> = {
  collector_failed: [
    "What to do:",
    "1. Open the status page and check the collector's last run.",
    "2. Look at the server log for the full error (it is kept out of this email).",
    "3. If the RPC is down or rate limited, wait for it, or switch SOROBAN_RPC_URL to another provider.",
    "4. Run the collector by hand: POST /api/ops/collect with the cron secret.",
    "5. When a run succeeds you get a recovery email, and this incident closes.",
    "Act within a few days: ledgers that leave the RPC window before they are read become a gap.",
  ].join("\n"),
  ledger_gap: [
    "What to do:",
    "1. The ledgers named above were not read before the RPC dropped them.",
    "2. Nothing on chain is lost: payments, approvals and proofs are still on the ledger.",
    "3. Recover the missing events from an archive (Stellar Expert, Hubble or another RPC with longer history)",
    "   and note the range and the source in docs/mainnet/pilot-log.md.",
    "4. Check why the collector fell behind (a missed cron run, a failure) so it does not happen again.",
  ].join("\n"),
};

function subjectFor(alert: Alert): string {
  return alert.kind === "collector_failed"
    ? `[Beaver402 ${alert.network}] event collector failed`
    : `[Beaver402 ${alert.network}] gap in the ledger history`;
}

function bodyFor(alert: Alert, at: Date): string {
  const status = process.env.STATUS_PAGE_URL ? `\nStatus page: ${process.env.STATUS_PAGE_URL}\n` : "";
  return `${alert.detail}\n\nNetwork: ${alert.network}\nNoticed: ${at.toISOString()}\nIncident: ${alert.key}\n${status}\n${ACTIONS[alert.kind]}\n\nYou will not get this email again for the same incident.\n`;
}

/**
 * Raise an alert. The first time an incident is seen it is emailed; later
 * runs that find it again only count it. Returns what happened.
 */
export async function raise(alert: Alert, deps: AlertDeps): Promise<"emailed" | "suppressed" | "no-mailer"> {
  const now = deps.now?.() ?? new Date();
  const existing = await deps.store.find(alert.key);
  if (existing) {
    await deps.store.seenAgain(alert.key);
    return "suppressed";
  }
  await deps.store.open(alert);
  if (!deps.mailer) {
    console.error(`alert not emailed, no mailer configured: ${alert.key}: ${alert.detail}`);
    return "no-mailer";
  }
  await deps.mailer.send(subjectFor(alert), bodyFor(alert, now));
  await deps.store.markEmailed(alert.key);
  return "emailed";
}

/** A run succeeded: close open failures, and say so once. */
export async function recover(kind: AlertKind, network: string, deps: AlertDeps): Promise<number> {
  const closed = await deps.store.resolve(kind, network);
  if (closed.length > 0 && deps.mailer) {
    const now = deps.now?.() ?? new Date();
    const lines = closed.map((a) => `- ${a.key}, open since ${a.openedAt}, seen again ${a.repeats} times`).join("\n");
    await deps.mailer.send(
      `[Beaver402 ${network}] event collector recovered`,
      `The collector ran successfully at ${now.toISOString()}.\n\nClosed:\n${lines}\n\nCheck the status page for a gap alert covering the time it was down.\n`
    );
  }
  return closed.length;
}

/**
 * Email through Resend's HTTP API. ALERT_EMAIL_TO is the operator. Until a
 * sending domain is verified, Resend's onboarding sender can only write to
 * the address the Resend account was opened with, which suits an operator
 * alert.
 */
export function resendMailer(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Mailer | null {
  const key = env.RESEND_API_KEY;
  const to = env.ALERT_EMAIL_TO;
  if (!key || !to) return null;
  const from = env.ALERT_EMAIL_FROM || "Beaver402 alerts <onboarding@resend.dev>";
  return {
    async send(subject, text) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: to.split(",").map((a) => a.trim()), subject, text }),
      });
      if (!res.ok) throw new Error(`the alert email was refused: ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
  };
}

/** Open incidents in the ops_alerts table (scripts/supabase-migration-004.sql). */
export function supabaseAlertStore(): AlertStore {
  const table = () => getSupabase().from("ops_alerts");
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`ops_alerts ${what}: ${error.message}`);
  };
  const toOpen = (row: Record<string, unknown>): OpenAlert => ({
    key: String(row.key),
    kind: row.kind as AlertKind,
    network: String(row.network),
    detail: String(row.detail),
    openedAt: String(row.opened_at),
    repeats: Number(row.repeats ?? 0),
  });
  return {
    async find(key) {
      const { data, error } = await table().select("*").eq("key", key).is("resolved_at", null).maybeSingle();
      fail("read", error);
      return data ? toOpen(data) : null;
    },
    async open(alert) {
      // A key that was resolved earlier opens again as a new incident.
      const { error } = await table().upsert({
        key: alert.key,
        kind: alert.kind,
        network: alert.network,
        detail: alert.detail,
        opened_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        repeats: 0,
        emailed_at: null,
        resolved_at: null,
      });
      fail("write", error);
    },
    async seenAgain(key) {
      const { data, error } = await table().select("repeats").eq("key", key).maybeSingle();
      fail("read", error);
      const { error: updateError } = await table()
        .update({ repeats: Number(data?.repeats ?? 0) + 1, last_seen_at: new Date().toISOString() })
        .eq("key", key);
      fail("update", updateError);
    },
    async markEmailed(key) {
      const { error } = await table().update({ emailed_at: new Date().toISOString() }).eq("key", key);
      fail("update", error);
    },
    async resolve(kind, network) {
      const { data, error } = await table()
        .update({ resolved_at: new Date().toISOString() })
        .eq("kind", kind)
        .eq("network", network)
        .is("resolved_at", null)
        .select("*");
      fail("update", error);
      return (data ?? []).map(toOpen);
    },
  };
}

/** The live alert setup, or null when there is nowhere to remember incidents. */
export function liveAlertDeps(): AlertDeps | null {
  if (!isSupabaseConfigured()) return null;
  return { store: supabaseAlertStore(), mailer: resendMailer() };
}

/**
 * Raise or clear alerts after a collector run. An alert that cannot be
 * delivered never hides the run's own result; it is logged instead.
 */
export async function alertAfterRun(
  outcome: { ok: true; gap: { from: number; to: number } | null } | { ok: false; summary: string },
  network: string,
  deps: AlertDeps | null = liveAlertDeps()
): Promise<void> {
  if (!deps) return;
  try {
    if (outcome.ok) {
      await recover("collector_failed", network, deps);
      if (outcome.gap) {
        await raise(
          {
            kind: "ledger_gap",
            key: `ledger_gap:${outcome.gap.from}-${outcome.gap.to}`,
            network,
            detail: `Ledgers ${outcome.gap.from} to ${outcome.gap.to} had left the RPC window before the collector read them, so their events are missing from the record.`,
          },
          deps
        );
      }
    } else {
      await raise(
        { kind: "collector_failed", key: "collector_failed", network, detail: `The event collector failed: ${outcome.summary}.` },
        deps
      );
    }
  } catch (err) {
    console.error("could not raise the collector alert:", forLog(err));
  }
}
