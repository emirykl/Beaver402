import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";

import { collect } from "./collector.js";
import { readPolicyState, publicConfig } from "../policy/policy-routes.js";
import { network, rpcServer, explorerTx } from "../config/network.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { failPublicly } from "../lib/public-error.js";
import { collectorFailure, publicCollectorError } from "./collector.js";

/**
 * The operational side: collecting events, exporting them, and the public
 * status the /status page shows.
 *
 * Everything readable here is public ledger data. Starting a collection is
 * not secret either, but it costs RPC calls, so it takes the cron secret.
 */

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Vercel cron sends `Authorization: Bearer $CRON_SECRET`. */
function requireCronSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (network().name === "mainnet") {
      res.status(503).json({ error: "CRON_SECRET is not configured" });
      return;
    }
    next();
    return;
  }
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ") || !sameSecret(header.slice(7), secret)) {
    res.status(401).json({ error: "the cron secret is required" });
    return;
  }
  next();
}

/** How many ledgers the account and its code still have before archival. */
async function instanceLifetime(contractId: string) {
  const server = rpcServer();
  const key = StellarSdk.xdr.LedgerKey.contractData(
    new StellarSdk.xdr.LedgerKeyContractData({
      contract: StellarSdk.Address.fromString(contractId).toScAddress(),
      key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: StellarSdk.xdr.ContractDataDurability.persistent(),
    })
  );
  const [entries, latest] = await Promise.all([server.getLedgerEntries(key), server.getLatestLedger()]);
  const liveUntil = entries.entries[0]?.liveUntilLedgerSeq;
  if (!liveUntil) return { liveUntilLedger: null, ledgersLeft: null, daysLeft: null, latestLedger: latest.sequence };
  const ledgersLeft = liveUntil - latest.sequence;
  return {
    liveUntilLedger: liveUntil,
    ledgersLeft,
    daysLeft: Math.floor((ledgersLeft * 5) / 86_400),
    latestLedger: latest.sequence,
  };
}

const CSV_COLUMNS = ["ledger", "ledger_closed_at", "event_type", "tx_hash", "contract_id", "topics", "data"] as const;

function toCsv(rows: Record<string, unknown>[]): string {
  const escape = (value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((c) => escape(row[c])).join(","))].join("\n");
}

export function createOpsRouter() {
  const router = express.Router();

  const runCollection = async (_req: Request, res: Response) => {
    try {
      res.json(await collect());
    } catch (err) {
      failPublicly(res, 500, collectorFailure(err), err);
    }
  };
  router.get("/api/ops/collect", requireCronSecret, runCollection);
  router.post("/api/ops/collect", requireCronSecret, runCollection);

  router.get("/api/ops/events", async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.json({ events: [] });
      return;
    }
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const { data, error } = await getSupabase()
      .from("chain_events")
      .select("*")
      .eq("network", network().name)
      .order("ledger", { ascending: true })
      .limit(limit);
    if (error) {
      failPublicly(res, 500, "could not read the events", error);
      return;
    }
    if (req.query.format === "csv") {
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="beaver402-${network().name}-events.csv"`);
      res.send(toCsv(data ?? []));
      return;
    }
    res.json({ events: data ?? [] });
  });

  router.get("/api/status", async (_req: Request, res: Response) => {
    try {
      const config = publicConfig();
      const state = await readPolicyState();
      const lifetime = config.contractId ? await instanceLifetime(config.contractId) : null;

      let collector = null;
      let recent: unknown[] = [];
      if (isSupabaseConfigured()) {
        // Only what the page needs. New rows hold a fixed summary, but an
        // older or hand-edited row may not, so the error is checked again.
        const [stateRow, events] = await Promise.all([
          getSupabase()
            .from("collector_state")
            .select("last_run_at, last_ledger, last_error")
            .eq("network", network().name)
            .maybeSingle(),
          getSupabase()
            .from("chain_events")
            .select("ledger, ledger_closed_at, event_type, tx_hash")
            .eq("network", network().name)
            .order("ledger", { ascending: false })
            .limit(20),
        ]);
        collector = stateRow.data ? { ...stateRow.data, last_error: publicCollectorError(stateRow.data.last_error) } : null;
        recent = (events.data ?? []).map((row) => ({ ...row, url: explorerTx(row.tx_hash) }));
      }

      res.json({
        network: config.network,
        contractId: config.contractId,
        contractUrl: config.contractUrl,
        asset: config.asset,
        frozen: state.frozen,
        agentActive: state.agentSigner !== null,
        merchantApproved: state.merchantApproved,
        limits: state.limits,
        window: {
          txCount: state.velocityTxCount,
          totalAmount: state.velocityTotalAmount,
          windowStart: state.velocityWindowStart,
        },
        lifetime,
        collector,
        recent,
      });
    } catch (err) {
      failPublicly(res, 500, "could not read the status", err);
    }
  });

  return router;
}
