# Collector alerts

The event collector copies the account's on-chain events into the database
once a day (Vercel cron, 06:00 UTC). RPC providers keep events for days, not
months, so a collector that stops, or falls behind, loses part of the record
for good. Two conditions email the operator.

| Alert | Raised when | Incident key | Emailed |
|---|---|---|---|
| Collector failed | A run throws: RPC unreachable, database refused the write, wrong network | `collector_failed` | Once. Later failures only count up `repeats`. The next successful run closes it and sends one recovery email |
| Ledger gap | A run finds ledgers that left the RPC window before they were read | `ledger_gap:<from>-<to>` | Once per range |

Incidents live in `ops_alerts` (`scripts/supabase-migration-004.sql`). The
email carries a fixed summary, never the raw provider error, which can hold
the RPC URL and its key; the full error is in the server log.

## Setup

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | A Resend key with **sending access** only |
| `ALERT_EMAIL_TO` | The operator's address. Until a sending domain is verified in Resend, this has to be the address the Resend account was opened with |
| `ALERT_EMAIL_FROM` | Optional. `Beaver402 alerts <onboarding@resend.dev>` unless set |
| `STATUS_PAGE_URL` | Optional. Linked from the email |

Without a Resend key the incident is still recorded and the alert is logged.

## What to do

### Collector failed

1. Open the status page: the collector's last run and summary are there.
2. Read the server log for the full error.
3. If the RPC is down or rate limited, wait, or point `SOROBAN_RPC_URL` at
   another provider. If the database refused the write, check the Supabase
   project and its service key.
4. Run the collector by hand: `POST /api/ops/collect` with
   `Authorization: Bearer $CRON_SECRET`.
5. The successful run sends the recovery email and closes the incident.
   If the outage lasted longer than the RPC's retention, expect a gap alert.

Act within a few days. Until the collector runs again, nothing is lost: the
missing ledgers are still in the RPC window.

### Ledger gap

1. The ledgers in the email were not read. Nothing on chain is lost:
   payments, approvals and proofs are all still on the ledger.
2. Recover the events for that range from a source with longer history
   (Stellar Expert's contract history, Hubble, or an RPC with longer
   retention) and keep the export with the pilot evidence.
3. Note the range, the source and the date in `docs/mainnet/pilot-log.md`.
4. Find out why the collector fell behind, usually a failure that was not
   fixed in time, and fix that.

## Rehearsal

`npm run alerts:rehearse` in `backend/` sends all three emails for real
(a failure seen three times, the recovery, a gap seen twice) without touching
the ledger or the `ops_alerts` table. It expects exactly three emails.

| Date | Network | Result |
|---|---|---|
| 2026-11-27 | testnet (rehearsal) | 3 emails sent: collector failed, collector recovered, gap in the ledger history. The repeated failure and the repeated gap were not emailed again |
