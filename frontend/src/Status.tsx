import React, { useEffect, useState } from "react";

import { Nav } from "./Landing.js";
import { trackClick, trackView } from "./track.js";

/** Everything here is read from the ledger, so anyone may see it. */
interface Status {
  network: "testnet" | "mainnet";
  contractId: string | null;
  contractUrl: string | null;
  asset: string;
  frozen: boolean;
  agentActive: boolean;
  merchantApproved: boolean;
  limits: { maxPaymentAmount: string; maxTxCount: number; maxTotalAmount: string; windowSize: number } | null;
  window: { txCount: number; totalAmount: string; windowStart: number };
  lifetime: { daysLeft: number | null; liveUntilLedger: number | null; latestLedger: number } | null;
  collector: { last_run_at: string | null; last_error: string | null; last_ledger: number | null } | null;
  recent: Array<{ ledger: number; ledger_closed_at: string; event_type: string; tx_hash: string; url: string }>;
}

const green = "#93c06a";
const red = "#d4674f";
const amber = "#e0a94a";

function usdc(raw: string | undefined): string {
  if (!raw) return "0";
  const value = BigInt(raw);
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** What an event type means, for someone who does not read contracts. */
const EVENTS: Record<string, string> = {
  transfer: "USDC moved",
  "poi/verified": "proof of intent published",
  "frozen/manual": "halted by the owner",
  "frozen/velocity": "halted at a limit",
  "frozen/restored": "resumed by the owner",
  "signer/revoked": "agent key revoked",
  "signer/set": "agent key set",
  "merchant/added": "merchant approved",
  "merchant/removed": "merchant removed",
  "limits/reduced": "limits lowered",
  "funds/recovered": "funds recovered",
};

function Fact({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div className="fact">
      <span className="value" style={tone ? { color: tone } : undefined}>
        {tone && <span className="lamp" style={{ background: tone, boxShadow: `0 0 10px ${tone}` }} />}
        {value}
      </span>
      <span className="label">{label}</span>
    </div>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trackView("/status");
    const load = () =>
      fetch("/api/status")
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
          setStatus(body);
          setError(null);
        })
        .catch((err) => setError(String(err instanceof Error ? err.message : err)));
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  const limits = status?.limits;
  const live = status && !status.frozen && status.agentActive && status.merchantApproved;

  return (
    <div className="site">
      <Nav current="/status" />
      <main className="site-main">
        <header className="hero">
          <span className="badge">{status?.network === "mainnet" ? "STELLAR MAINNET" : "STELLAR TESTNET"}</span>
          <h1>Pilot status</h1>
          <p className="lead">
            Read live from the ledger every thirty seconds. Nothing here comes from anywhere the public
            cannot check.
          </p>
          {error && <p className="warn">Could not read the status: {error}</p>}
        </header>

        {status && (
          <>
            <section className="block" aria-labelledby="account">
              <h2 id="account">THE ACCOUNT</h2>
              <p>
                {status.contractId ? <span className="mono-id">{status.contractId}</span> : "Not deployed yet."}{" "}
                {status.contractUrl && (
                  <a href={status.contractUrl} target="_blank" rel="noreferrer" onClick={() => trackClick("/status", "contract")}>
                    On the explorer
                  </a>
                )}
              </p>
              <div className="status-grid">
                <Fact value={live ? "ACCEPTING" : status.frozen ? "HALTED" : "NOT READY"} label="payments" tone={live ? green : red} />
                <Fact value={status.agentActive ? "ACTIVE" : "REVOKED"} label="agent key" tone={status.agentActive ? green : red} />
                <Fact value={status.merchantApproved ? "APPROVED" : "NONE"} label="merchant" tone={status.merchantApproved ? green : amber} />
                <Fact
                  value={status.lifetime?.daysLeft != null ? `${status.lifetime.daysLeft} days` : "unknown"}
                  label="until the account would need extending"
                  tone={status.lifetime?.daysLeft != null && status.lifetime.daysLeft < 30 ? amber : undefined}
                />
              </div>
            </section>

            <section className="block" aria-labelledby="limits">
              <h2 id="limits">LIMITS AND USE</h2>
              <div className="status-grid">
                <Fact value={`${status.window.txCount} of ${limits?.maxTxCount ?? "?"}`} label="payments in the last 24 hours" />
                <Fact value={`${usdc(status.window.totalAmount)} of ${usdc(limits?.maxTotalAmount)} USDC`} label="spent in the last 24 hours" />
                <Fact value={`${usdc(limits?.maxPaymentAmount)} USDC`} label="most a single payment can move" />
              </div>
            </section>

            <section className="block" aria-labelledby="recent">
              <h2 id="recent">RECENT ACTIVITY</h2>
              {status.recent.length === 0 ? (
                <p>Nothing recorded yet.</p>
              ) : (
                <ul className="list">
                  {status.recent.map((event) => (
                    <li key={`${event.tx_hash}-${event.event_type}-${event.ledger}`}>
                      <span className="name">{EVENTS[event.event_type] ?? event.event_type}</span>
                      <span className="what">
                        {new Date(event.ledger_closed_at).toISOString().slice(0, 16).replace("T", " ")} UTC · ledger{" "}
                        {event.ledger}
                      </span>
                      <a href={event.url} target="_blank" rel="noreferrer" onClick={() => trackClick("/status", "transaction")}>
                        {event.tx_hash.slice(0, 12)}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <p className="note">
                {status.collector?.last_run_at
                  ? `Events last collected ${new Date(status.collector.last_run_at).toISOString().slice(0, 16).replace("T", " ")} UTC.`
                  : "Events have not been collected yet."}
                {status.collector?.last_error && <span className="warn"> {status.collector.last_error}</span>}
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
