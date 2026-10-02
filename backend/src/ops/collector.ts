import * as StellarSdk from "@stellar/stellar-sdk";

import { network, rpcServer, verifyNetwork, type NetworkConfig } from "../config/network.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";

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

export interface CollectResult {
  collected: number;
  lastLedger: number;
  /** Ledgers that had already left the RPC's window, so were not seen. */
  gap: { from: number; to: number } | null;
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
 * Read every new event and store it. Safe to run as often as wanted: events
 * are keyed by their RPC id, so a repeat is a no-op.
 */
export async function collect(
  policy: string = process.env.POLICY_CONTRACT_ID ?? "",
  server: Pick<StellarSdk.rpc.Server, "getEvents" | "getHealth"> = rpcServer()
): Promise<CollectResult> {
  if (!policy) throw new Error("POLICY_CONTRACT_ID is not set, there is nothing to collect");
  if (!isSupabaseConfigured()) throw new Error("the collector needs the database");

  const config = network();
  await verifyNetwork(config);
  const previous = await readState(config.name);
  const filters = filtersFor(policy, config.usdcContract);

  let collected = 0;
  let gap: CollectResult["gap"] = null;
  let lastLedger = previous?.last_ledger ?? 0;
  let cursor = previous?.cursor ?? null;

  try {
    // The first run starts at the deployment, or as far back as the RPC
    // still remembers if that is later.
    let page: StellarSdk.rpc.Api.GetEventsResponse;
    if (cursor) {
      page = await server.getEvents({ filters, cursor, limit: 200 });
    } else {
      const health = await server.getHealth();
      const deployed = Number(process.env.POLICY_DEPLOY_LEDGER || 0);
      const startLedger = Math.max(health.oldestLedger + 1, deployed);
      if (deployed && deployed <= health.oldestLedger) {
        gap = { from: deployed, to: health.oldestLedger };
      }
      page = await server.getEvents({ filters, startLedger, limit: 200 });
    }

    if (previous?.last_ledger && page.oldestLedger > previous.last_ledger + 1) {
      gap = { from: previous.last_ledger + 1, to: page.oldestLedger - 1 };
    }

    // RPC scans a bounded range of ledgers per call and hands back a cursor
    // even when that range held nothing, so an empty page is not the end.
    // The end is a cursor that has caught up with the latest ledger.
    for (;;) {
      if (page.events.length > 0) {
        const rows = page.events.map((event) => toRow(event, config));
        const { error } = await getSupabase().from("chain_events").upsert(rows, { onConflict: "id" });
        if (error) throw new Error(error.message);
        collected += rows.length;
        lastLedger = Math.max(lastLedger, ...rows.map((row) => row.ledger));
      }
      cursor = page.cursor;
      if (page.events.length < 200 && cursorLedger(cursor) >= page.latestLedger) break;
      page = await server.getEvents({ filters, cursor, limit: 200 });
    }

    await writeState({
      network: config.name,
      cursor,
      last_ledger: lastLedger || page.latestLedger,
      last_run_at: new Date().toISOString(),
      last_error: gap ? `ledgers ${gap.from} to ${gap.to} had left the RPC window before they were read` : null,
    });
    return { collected, lastLedger, gap };
  } catch (err) {
    await writeState({
      network: config.name,
      cursor: previous?.cursor ?? null,
      last_ledger: previous?.last_ledger ?? null,
      last_run_at: new Date().toISOString(),
      last_error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    throw err;
  }
}
