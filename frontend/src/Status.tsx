import React, { useEffect, useState } from "react";

import { CountUp, delay, SiteFooter, SiteNav, useReveal } from "./Landing.js";
import { trackClick, trackView } from "./track.js";
import "./landing.css";
import "./status.css";

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

/** Stroops to USDC, as a number for display. */
function usdc(raw: string | undefined): number {
  if (!raw) return 0;
  return Number(BigInt(raw)) / 10_000_000;
}

/** What an event type means, for someone who does not read contracts. */
const EVENTS: Record<string, string> = {
  transfer: "USDC moved",
  "poi/verified": "Proof of intent published",
  "frozen/manual": "Halted by the owner",
  "frozen/velocity": "Halted at a limit",
  "frozen/restored": "Resumed by the owner",
  "signer/revoked": "Agent key revoked",
  "signer/set": "Agent key set",
  "merchant/added": "Merchant approved",
  "merchant/removed": "Merchant removed",
  "limits/reduced": "Limits lowered",
  "funds/recovered": "Funds recovered",
};

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} days ago`;
}

type Tone = "good" | "bad" | "wait";

function State({ label, value, tone, at }: { label: string; value: string; tone: Tone; at: number }) {
  return (
    <div className={`st-state ld-reveal ${tone}`} style={delay(at)}>
      <span className="st-label">{label}</span>
      <span className="st-value">
        <span className="st-lamp" />
        {value}
      </span>
    </div>
  );
}

/** A ring that fills to how much of a limit the window has used. */
function Gauge({ used, limit, unit, label, decimals = 0, at }: { used: number; limit: number; unit: string; label: string; decimals?: number; at: number }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  const circumference = 2 * Math.PI * 52;
  return (
    <div className="st-gauge ld-reveal" style={{ ...delay(at), ["--st-share" as string]: share, ["--st-length" as string]: circumference }}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className="st-ring-back" cx="60" cy="60" r="52" />
        <circle className="st-ring" cx="60" cy="60" r="52" strokeDasharray={circumference} />
      </svg>
      <div className="st-gauge-text">
        <CountUp to={used} unit="" decimals={decimals} />
        <span className="st-of">
          of {limit.toFixed(decimals)} {unit}
        </span>
      </div>
      <span className="st-gauge-label">{label}</span>
    </div>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  useReveal([status !== null]);

  const limits = status?.limits;
  const live = !!status && !status.frozen && status.agentActive && status.merchantApproved;
  const overall: { text: string; tone: Tone } = !status
    ? { text: "Reading the ledger", tone: "wait" }
    : live
      ? { text: "Accepting payments", tone: "good" }
      : status.frozen
        ? { text: "Payments halted", tone: "bad" }
        : !status.merchantApproved
          ? { text: "Waiting for a merchant", tone: "wait" }
          : { text: "Agent key revoked", tone: "bad" };

  const copy = () => {
    if (!status?.contractId) return;
    navigator.clipboard?.writeText(status.contractId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="ld">
      <SiteNav page="/status" />

      <main>
        <header className="st-hero">
          <div className="ld-glow" aria-hidden="true" />
          <p className="ld-kicker">Live from the ledger</p>
          <h1 className="st-title">Pilot status</h1>
          <span className={`st-overall ${overall.tone}`}>
            <span className="st-lamp" />
            {overall.text}
          </span>
          <p className="st-sub">
            Read from Stellar {status?.network === "mainnet" ? "mainnet" : "testnet"} every thirty seconds.
          </p>
          {error && <p className="st-error">Could not read the status: {error}</p>}
        </header>

        {status && (
          <>
            <section className="ld-section st-section" aria-labelledby="account-title">
              <h2 className="st-heading ld-reveal" id="account-title">
                The account
              </h2>
              <div className="st-account ld-reveal" style={delay(0.08)}>
                <span className="st-id">{status.contractId ?? "Not deployed yet"}</span>
                <div className="st-account-actions">
                  {status.contractId && (
                    <button type="button" className="st-chip" onClick={copy}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                  )}
                  {status.contractUrl && (
                    <a
                      className="st-chip amber"
                      href={status.contractUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => trackClick("/status", "contract")}
                    >
                      Explorer ›
                    </a>
                  )}
                </div>
              </div>
              <div className="st-states">
                <State label="Payments" value={live ? "Accepting" : status.frozen ? "Halted" : "Not ready"} tone={live ? "good" : status.frozen ? "bad" : "wait"} at={0.1} />
                <State label="Agent key" value={status.agentActive ? "Active" : "Revoked"} tone={status.agentActive ? "good" : "bad"} at={0.18} />
                <State label="Merchant" value={status.merchantApproved ? "Approved" : "None yet"} tone={status.merchantApproved ? "good" : "wait"} at={0.26} />
                <State
                  label="Lifetime"
                  value={status.lifetime?.daysLeft != null ? `${status.lifetime.daysLeft} days` : "Unknown"}
                  tone={status.lifetime?.daysLeft != null && status.lifetime.daysLeft < 30 ? "wait" : "good"}
                  at={0.34}
                />
              </div>
            </section>

            <section className="ld-section st-section" aria-labelledby="limits-title">
              <h2 className="st-heading ld-reveal" id="limits-title">
                Limits, last 24 hours
              </h2>
              <div className="st-gauges">
                <Gauge used={status.window.txCount} limit={limits?.maxTxCount ?? 0} unit="payments" label="Payments made" at={0.08} />
                <Gauge
                  used={usdc(status.window.totalAmount)}
                  limit={usdc(limits?.maxTotalAmount)}
                  unit="USDC"
                  label="USDC spent"
                  decimals={2}
                  at={0.16}
                />
                <div className="st-gauge st-cap ld-reveal" style={delay(0.24)}>
                  <div className="st-cap-value">
                    <CountUp to={usdc(limits?.maxPaymentAmount)} unit="USDC" decimals={2} />
                  </div>
                  <span className="st-gauge-label">Most a single payment can move</span>
                </div>
              </div>
            </section>

            <section className="ld-section st-section" aria-labelledby="recent-title">
              <h2 className="st-heading ld-reveal" id="recent-title">
                Recent activity
              </h2>
              {status.recent.length === 0 ? (
                <p className="st-empty ld-reveal">Nothing recorded yet.</p>
              ) : (
                <ol className="st-timeline">
                  {status.recent.map((event, n) => (
                    <li key={`${event.tx_hash}-${event.event_type}-${event.ledger}`} className="ld-reveal" style={delay(0.06 * n)}>
                      <span className="st-dot" />
                      <div className="st-event">
                        <strong>{EVENTS[event.event_type] ?? event.event_type}</strong>
                        <span>
                          {ago(event.ledger_closed_at)} · ledger {event.ledger.toLocaleString("en-US")}
                        </span>
                      </div>
                      <a href={event.url} target="_blank" rel="noreferrer" onClick={() => trackClick("/status", "transaction")}>
                        {event.tx_hash.slice(0, 10)}…
                      </a>
                    </li>
                  ))}
                </ol>
              )}
              <p className="st-note ld-reveal">
                {status.collector?.last_run_at
                  ? `Events last collected ${ago(status.collector.last_run_at)}.`
                  : "Events have not been collected yet."}
                {status.collector?.last_error && <span className="st-error"> {status.collector.last_error}</span>}
              </p>
            </section>
          </>
        )}
      </main>

      <SiteFooter page="/status" />
    </div>
  );
}
