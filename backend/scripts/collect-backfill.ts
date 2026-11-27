/**
 * Run the event collector until it has caught up with the latest ledger.
 *
 * The hosted cron stops each run at a time budget; after a long outage the
 * collector can be brought up to date from here in one go.
 *
 * Run with: npm run collect:backfill (or with .env.mainnet for mainnet)
 */
import { collect } from "../src/ops/collector.js";

const started = Date.now();
let total = 0;
for (;;) {
  const result = await collect(undefined, undefined, { budgetMs: 10 * 60_000 });
  total += result.collected;
  console.log(`read through ledger ${result.lastLedger}, ${result.collected} events this run${result.gap ? `, gap ${result.gap.from}-${result.gap.to}` : ""}`);
  if (result.caughtUp) break;
}
console.log(`caught up: ${total} events in ${Math.round((Date.now() - started) / 1000)} s`);
