import express, { type Request, type Response } from "express";

import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { createRateLimit } from "../lib/rate-limit.js";

/**
 * Privacy preserving traffic counts for the landing page.
 *
 * Nothing about the visitor is stored: no address, no cookie, no identifier,
 * not even the time beyond the day. Only known pages and known links are
 * counted, so the table cannot be used to store anything else.
 */

export const PAGES = ["/", "/status", "/panel"] as const;

/** The outbound links the pages carry, by the name the page reports. */
export const LINKS = [
  "demo",
  "repository",
  "contract",
  "deployment-record",
  "evidence",
  "encoding",
  "threat-model",
  "x402",
  "limitations",
  "status",
  "panel",
  "transaction",
] as const;

export interface Metric {
  path: string;
  kind: "view" | "click";
  target: string;
}

/** A metric the counter accepts, or null for anything else. */
export function parseMetric(body: unknown): Metric | null {
  if (!body || typeof body !== "object") return null;
  const { path, kind, target } = body as Record<string, unknown>;
  if (typeof path !== "string" || !(PAGES as readonly string[]).includes(path)) return null;
  if (kind === "view") return { path, kind, target: "" };
  if (kind === "click" && typeof target === "string" && (LINKS as readonly string[]).includes(target)) {
    return { path, kind, target };
  }
  return null;
}

export function createMetricsRouter() {
  const router = express.Router();
  router.use("/api/metrics", createRateLimit({ windowMs: 60_000, max: 60, scope: "metrics" }));

  router.post("/api/metrics", async (req: Request, res: Response) => {
    const metric = parseMetric(req.body);
    if (!metric) {
      res.status(400).json({ error: "not a metric this site counts" });
      return;
    }
    if (isSupabaseConfigured()) {
      const { error } = await getSupabase().rpc("count_page_metric", {
        p_path: metric.path,
        p_kind: metric.kind,
        p_target: metric.target,
      });
      if (error) console.error("could not count the page metric:", error.message);
    }
    res.status(204).end();
  });

  /** The traffic report: daily totals, nothing else. */
  router.get("/api/metrics/report", async (req: Request, res: Response) => {
    if (!isSupabaseConfigured()) {
      res.json({ days: [] });
      return;
    }
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await getSupabase()
      .from("page_metrics")
      .select("day, path, kind, target, count")
      .gte("day", since)
      .order("day", { ascending: true });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ since, rows: data ?? [] });
  });

  return router;
}
