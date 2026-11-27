import * as StellarSdk from "@stellar/stellar-sdk";

import { network, rpcServer, verifyNetwork, type NetworkConfig } from "../config/network.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { forLog } from "../lib/public-error.js";

/**
 * Collect the account's on-chain events into the database.
 *
 * RPC only keeps events for a limited window, days rather than months, so
 * the pilot's record is only complete if it is copied out while it is still
 * there. This reads everything since the last run: the policy account's own
 * events, every USDC transfer out of it and every USDC transfer into it.
 *
 * Only public ledger data is stored. Nothing here involves request content,
 * signatures or keys.
 */

export interface CollectedEvent {
  id: string;
  network: string;
  contract_id: string;
  ledger: number;
  ledger_closed_at: string;
  tx_hash: string;
  event_type: string;
  topics: unknown[];
  data: unknown;
}

export interface CollectorState {
  network: string;
  cursor: string | null;
  last_ledger: number | null;
  last_run_at: string | null;
  last_error: string | null;
}

/** Make an event value something JSON can hold. */
export function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}

function native(value: StellarSdk.xdr.ScVal): unknown {
  try {
    return toJson(StellarSdk.scValToNative(value));
  } catch {
    return value.toXDR("base64");
  }
}

/** A short name for an event: its symbol topics, like `poi/verified`. */
export function eventType(topics: StellarSdk.xdr.ScVal[]): string {
  const names: string[] = [];
  for (const topic of topics.slice(0, 2)) {
    if (topic.switch().name !== "scvSymbol") break;
    names.push(topic.sym().toString());
  }
  return names.join("/") || "unknown";
}

export function toRow(event: StellarSdk.rpc.Api.EventResponse, config: NetworkConfig): CollectedEvent {
  return {
    id: event.id,
    network: config.name,
    contract_id: event.contractId?.contractId() ?? "",
    ledger: event.ledger,
    ledger_closed_at: event.ledgerClosedAt,
    tx_hash: event.txHash,
    event_type: eventType(event.topic),
    topics: event.topic.map(native),
    data: native(event.value),
  };
}

/** The filters for everything that concerns one policy account. */
export function filtersFor(policy: string, usdc: string): StellarSdk.rpc.Api.EventFilter[] {
  const account = StellarSdk.Address.fromString(policy).toScVal().toXDR("base64");
  const transfer = StellarSdk.xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  return [
    { type: "contract", contractIds: [policy] },
    { type: "contract", contractIds: [usdc], topics: [[transfer, account, "*", "*"]] },
    { type: "contract", contractIds: [usdc], topics: [[transfer, "*", account, "*"]] },
  ];
}

/**
 * The ledger a getEvents cursor points at. The cursor is a TOID, which
 * keeps the ledger sequence in its upper 32 bits.
 */
export function cursorLedger(cursor: string): number {
  return Number(BigInt(cursor.split("-")[0]!) >> 32n);
}

/**
 * What a failed collection says about itself in the public status. The full
 * error goes to the server log; it can carry the RPC URL, and with it the
 * provider's key.
 */
export function collectorFailure(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|getaddrinfo|socket|timeout|\b5\d\d\b/i.test(text)) {
    return "the RPC could not be reached";
  }
  if (/processing limit|exceeded/i.test(text)) {
    return "the RPC refused a request as too large";
  }
  if (/startLedger|cursor|range/i.test(text)) {
    return "the RPC no longer holds the requested ledgers";
  }
  if (/permission|relation|violates|duplicate|database|supabase/i.test(text)) {
    return "the database refused the write";
  }
  return "the collection failed";
}

const PUBLIC_COLLECTOR_ERRORS = new Set([
  "the RPC could not be reached",
  "the RPC refused a request as too large",
  "the RPC no longer holds the requested ledgers",
  "the database refused the write",
  "the collection failed",
]);
const GAP_SUMMARY = /^ledgers \d+ to \d+ had left the RPC window before they were read$/;

/**
 * The stored collector error as the public status page may show it.
 *
 * Only summaries this code writes pass through. A row written before the
 * summaries existed, or edited by hand, may hold a raw provider message, so
 * anything else is shown as the generic summary.
 */
export function publicCollectorError(stored: unknown): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  if (typeof stored === "string" && (PUBLIC_COLLECTOR_ERRORS.has(stored) || GAP_SUMMARY.test(stored))) return stored;
  return "the collection failed";
}

export interface CollectResult {
  collected: number;
  lastLedger: number;
  /** Ledgers that had already left the RPC's window, so were not seen. */
  gap: { from: number; to: number } | null;
  /** False when the run stopped at its time budget; the next run goes on. */
  caughtUp?: boolean;
}

async function readState(name: string): Promise<CollectorState | null> {
  const { data, error } = await getSupabase()
    .from("collector_state")
    .select("*")
    .eq("network", name)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as CollectorState | null;
}

async function writeState(state: CollectorState): Promise<void> {
  const { error } = await getSupabase().from("collector_state").upsert(state);
  if (error) throw new Error(error.message);
}

/**
 * How many ledgers one getEvents call may cover. Hosted RPC providers cap
 * the work a single call may do: on mainnet, Validation Cloud answered 5,000
 * ledgers and refused 10,000 with "request exceeded processing limit
 * threshold", and near the deployment even 4,000 took ten seconds and was
refused. Ranges are bounded, and a refused range is split in half.
 */
export const DEFAULT_CHUNK_LEDGERS = 2000;
const PAGE = 200;

type EventsServer = Pick<StellarSdk.rpc.Server, "getEvents">;

/** The provider refused a call as too much work, rather than failing. */
function tooLarge(err: unknown): boolean {
  return /processing limit|exceeded/i.test(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
}

/** A dropped connection or a timeout, worth trying again. */
function transient(err: unknown): boolean {
  const e = err as { isAxiosError?: boolean; response?: unknown; code?: string; message?: string };
  if (e?.isAxiosError && !e.response) return true;
  return /ECONNRESET|ETIMEDOUT|ECONNABORTED|socket hang up|fetch failed|\b50[234]\b/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
}

async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (err) {
      if (i >= attempts || !transient(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * i));
    }
  }
}

/**
 * Every event in one range. A range the provider refuses as too much work
 * is split in half and each half read on its own, down to a few ledgers.
 */
async function readRange(
  server: EventsServer,
  filters: StellarSdk.rpc.Api.EventFilter[],
  start: number,
  end: number
): Promise<StellarSdk.rpc.Api.EventResponse[]> {
  const byId = new Map<string, StellarSdk.rpc.Api.EventResponse>();
  let pageStart = start;
  try {
    for (;;) {
      // The RPC treats endLedger as exclusive.
      const request = { filters, startLedger: pageStart, endLedger: end + 1, limit: PAGE };
      const page = await withRetry(() => server.getEvents(request));
      for (const event of page.events) byId.set(event.id, event);
      if (page.events.length < PAGE) break;
      const lastLedger = page.events[page.events.length - 1]!.ledger;
      if (lastLedger <= pageStart) {
        throw new Error(`more than ${PAGE} events in ledger ${pageStart}`);
      }
      // Read the last ledger again in full; repeats are dropped by id.
      pageStart = lastLedger;
    }
  } catch (err) {
    if (!tooLarge(err) || end - start < 16) throw err;
    const middle = start + Math.floor((end - start) / 2);
    const halves = [...(await readRange(server, filters, start, middle)), ...(await readRange(server, filters, middle + 1, end))];
    for (const event of halves) byId.set(event.id, event);
  }
  return [...byId.values()];
}

/**
 * Read every event matching the filters from `from` to `to`, inclusive, in
 * ranges of at most `chunk` ledgers. Each range is handed to `onRange`
 * once it has been read completely, so the caller can store it and record
 * how far it got before going on. A full page continues from the ledger of
 * its last event; events are keyed by id, so the overlap is harmless.
 */
export async function scanRange(
  server: EventsServer,
  filters: StellarSdk.rpc.Api.EventFilter[],
  from: number,
  to: number,
  chunk: number,
  onRange: (events: StellarSdk.rpc.Api.EventResponse[], through: number) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<number> {
  let scanned = from - 1;
  for (let start = from; start <= to; start += chunk) {
    if (shouldStop()) break;
    const end = Math.min(start + chunk - 1, to);
    const events = await readRange(server, filters, start, end);
    await onRange(events, end);
    scanned = end;
  }
  return scanned;
}

/**
 * Read every new event and store it. Safe to run as often as wanted: events
 * are keyed by their RPC id, so a repeat is a no-op.
 *
 * `last_ledger` in the state is the last ledger read completely. A run goes
 * on from there to the latest ledger in bounded ranges and saves its place
 * after each one, so a run cut short by the host's time limit loses nothing
 * and the next run continues.
 */
export async function collect(
  policy: string = process.env.POLICY_CONTRACT_ID ?? "",
  server: Pick<StellarSdk.rpc.Server, "getEvents" | "getHealth" | "getLatestLedger"> = rpcServer(),
  { chunk = Number(process.env.COLLECTOR_CHUNK_LEDGERS) || DEFAULT_CHUNK_LEDGERS, budgetMs = 45_000 }: { chunk?: number; budgetMs?: number } = {}
): Promise<CollectResult> {
  if (!policy) throw new Error("POLICY_CONTRACT_ID is not set, there is nothing to collect");
  if (!isSupabaseConfigured()) throw new Error("the collector needs the database");

  const config = network();
  await verifyNetwork(config);
  const previous = await readState(config.name);
  const filters = filtersFor(policy, config.usdcContract);
  const began = Date.now();

  let collected = 0;
  let gap: CollectResult["gap"] = null;
  let lastLedger = previous?.last_ledger ?? 0;

  try {
    const [health, latest] = await Promise.all([server.getHealth(), server.getLatestLedger()]);
    const deployed = Number(process.env.POLICY_DEPLOY_LEDGER || 0);
    // Where to go on from: after the last ledger read, or the deployment on
    // a first run.
    let from = previous?.last_ledger ? previous.last_ledger + 1 : Math.max(deployed, 1);
    if (from <= health.oldestLedger) {
      if (previous?.last_ledger || deployed) {
        gap = { from, to: health.oldestLedger };
      }
      from = health.oldestLedger + 1;
    }

    lastLedger = await scanRange(
      server,
      filters,
      from,
      latest.sequence,
      chunk,
      async (events, through) => {
        if (events.length > 0) {
          const rows = events.map((event) => toRow(event, config));
          const { error } = await getSupabase().from("chain_events").upsert(rows, { onConflict: "id" });
          if (error) throw new Error(error.message);
          collected += rows.length;
        }
        await writeState({
          network: config.name,
          cursor: null,
          last_ledger: through,
          last_run_at: new Date().toISOString(),
          last_error: gap ? `ledgers ${gap.from} to ${gap.to} had left the RPC window before they were read` : null,
        });
      },
      () => Date.now() - began > budgetMs
    );
    if (lastLedger < from) lastLedger = previous?.last_ledger ?? 0;

    return { collected, lastLedger, gap, caughtUp: lastLedger >= latest.sequence };
  } catch (err) {
    console.error("event collection failed:", forLog(err));
    const saved = await readState(config.name).catch(() => previous);
    await writeState({
      network: config.name,
      cursor: null,
      last_ledger: saved?.last_ledger ?? previous?.last_ledger ?? null,
      last_run_at: new Date().toISOString(),
      last_error: collectorFailure(err),
    }).catch(() => {});
    throw err;
  }
}
