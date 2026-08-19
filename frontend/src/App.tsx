import React, { useState, useCallback, useEffect } from "react";
import {
  fetchPolicyState,
  type MerchantInfo,
  allowMerchant,
  fetchMerchantInfo,
  freezePayments,
  restorePayments,
  revokeAgentSigner,
  restoreAgentSigner,
  fetchTransactions,
  type PolicyState,
  type Transaction,
} from "./stellar-ops.js";
import {
  registerPasskey,
  authenticatePasskey,
  hasPasskey,
} from "./passkey-auth.js";

import {
  amber,
  green,
  red,
  text,
  dim,
  edge,
  page,
  shell,
  panel,
  heading,
  body,
  gateLayout,
  gateBox,
  gateLogo,
  gateTitle,
  gateText,
  gateNote,
  gateError,
  topBar,
  topLogo,
  topTitle,
  topSub,
  topSubLabel,
  topSubLink,
  indicator,
  lamp,
  indicatorText,
  columns,
  column,
  lineRow,
  lineLabel,
  lineValue,
  meterTrack,
  meterSegment,
  button,
  scroller,
  txRow,
  txHead,
  txState,
  txAmount,
  txLink,
  txWhy,
  logList,
  logRow,
  logTime,
  logMsg,
} from "./console-styles.js";

interface LogEntry {
  id: number;
  time: string;
  message: string;
  type: "info" | "success" | "error";
}

let logId = 0;

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [policyState, setPolicyState] = useState<PolicyState>({
    frozen: false,
    agentSigner: null,
    velocityTxCount: 0,
    velocityTotalAmount: "0",
    contractId: "not connected",
    merchantApproved: undefined,
    velocityMaxTxCount: 0,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"idle" | "registering" | "authenticating">(
    "idle"
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [merchantInfo, setMerchantInfo] = useState<MerchantInfo | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const addLog = useCallback(
    (message: string, type: LogEntry["type"] = "info") => {
      const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
      setLogs((prev) => [{ id: ++logId, time, message, type }, ...prev].slice(0, 8));
    },
    []
  );

  const refresh = useCallback(async () => {
    setPolicyState(await fetchPolicyState());
    setTransactions(await fetchTransactions());
    setMerchantInfo(await fetchMerchantInfo());
  }, []);

  const handleAuth = useCallback(async () => {
    const userId = "beaver402-owner";
    setAuthError(null);

    const signIn = async () => {
      setAuthMode("authenticating");
      addLog("Awaiting passkey");
      return authenticatePasskey(userId);
    };

    const enrol = async () => {
      setAuthMode("registering");
      addLog("Enrolling a passkey on this device");
      return registerPasskey(userId);
    };

    // Enrolling over an account that already has a passkey only ever fails,
    // so which one to run is decided before either is attempted rather than
    // by falling through from a failure.
    const enrolled = await hasPasskey(userId);
    const result = enrolled ? await signIn() : await enrol();

    if (!result.ok) {
      setAuthMode("idle");
      setAuthError(result.error ?? "it did not work");
      addLog(`Sign in failed: ${result.error ?? "unknown"}`, "error");
      return;
    }

    // The session came back with the ceremony, so there is nothing left to
    // announce here.
    setAuthenticated(true);
    addLog(enrolled ? "Owner verified" : "Passkey enrolled", "success");
    setAuthMode("idle");
    refresh();
  }, [addLog, refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAction = useCallback(
    async (
      action: string,
      fn: () => Promise<{ success: boolean; txHash?: string; error?: string }>
    ) => {
      setLoading(action);
      addLog(`${action} — awaiting passkey`);
      try {
        const result = await fn();
        if (result.success) {
          addLog(`${action} — confirmed`, "success");
          await refresh();
        } else {
          addLog(`${action} — ${result.error ?? "refused"}`, "error");
        }
      } catch {
        addLog(`${action} — failed`, "error");
      }
      setLoading(null);
    },
    [addLog, refresh]
  );

  // ── Authentication gate ─────────────────────────────────────────
  if (!authenticated) {
    return (
      <div style={{ ...page, ...gateLayout }}>
        <Scan />
        <section style={{ ...panel, ...gateBox }}>
          <img src="/beaver402-logo.png" alt="" style={gateLogo} />
          <h1 style={gateTitle}>BEAVER402</h1>
          <p style={gateText}>
            Your agent can only pay for what you approved.
          </p>
          <Button
            label={
              authMode === "authenticating"
                ? "VERIFYING"
                : authMode === "registering"
                  ? "ENROLLING"
                  : "SIGN IN WITH PASSKEY"
            }
            busy={authMode !== "idle"}
            onClick={handleAuth}
          />
          {authError ? (
            <p style={gateError}>{authError}</p>
          ) : (
            <p style={gateNote}>Touch ID authorizes every action</p>
          )}
        </section>
      </div>
    );
  }

  const needsMerchant = policyState.merchantApproved === false;
  const live = !policyState.frozen && policyState.agentSigner !== null;

  // ── Console ─────────────────────────────────────────────────────
  return (
    <div style={page}>
      <Scan />
      <div style={shell}>
        <header style={{ ...panel, ...topBar }}>
          <img src="/beaver402-logo.png" alt="" style={topLogo} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={topTitle}>BEAVER402</div>
            <div style={topSub}>
              <span style={topSubLabel}>SMART ACCOUNT</span>
              <a
                style={topSubLink}
                href={`https://stellar.expert/explorer/testnet/contract/${policyState.contractId}`}
                target="_blank"
                rel="noreferrer"
                title={policyState.contractId}
              >
                {policyState.contractId}
              </a>
            </div>
          </div>
          <div style={indicator}>
            <span
              style={{
                ...lamp,
                background: live ? green : red,
                boxShadow: `0 0 12px ${live ? green : red}`,
              }}
            />
            <span style={{ ...indicatorText, color: live ? green : red }}>
              {policyState.frozen ? "HALTED" : "ARMED"}
            </span>
          </div>
        </header>

        <div style={columns}>
          <div style={column}>
            {needsMerchant && (
              <section style={{ ...panel, borderColor: `${amber}55` }}>
                <h2 style={{ ...heading, color: amber }}>ACTION REQUIRED</h2>
                <p style={body}>
                  No merchant is approved, so every payment is refused.
                </p>
                <Button
                  label="APPROVE MERCHANT"
                  busy={loading === "approve"}
                  disabled={loading !== null || !merchantInfo}
                  onClick={() =>
                    merchantInfo &&
                    handleAction("Approve merchant", () =>
                      allowMerchant(merchantInfo.merchantPubkey)
                    )
                  }
                />
              </section>
            )}

            <section style={panel}>
              <h2 style={heading}>STATUS</h2>
              <Line
                label="Payments"
                value={policyState.frozen ? "HALTED" : "ACTIVE"}
                tone={policyState.frozen ? red : green}
              />
              <Line
                label="Agent"
                value={policyState.agentSigner ? "AUTHORIZED" : "REVOKED"}
                tone={policyState.agentSigner ? green : red}
              />
              <Meter
                used={policyState.velocityTxCount}
                total={policyState.velocityMaxTxCount}
              />
              <p style={body}>
                {policyState.frozen
                  ? "Every payment is refused until you resume."
                  : policyState.agentSigner
                    ? "The agent may pay approved merchants, within the daily limit."
                    : "The agent holds no key, so nothing can be paid."}
              </p>
            </section>

            {!needsMerchant && (
              <section style={panel}>
                <h2 style={heading}>COMMAND</h2>
                {policyState.frozen ? (
                  <Button
                    label="RESUME PAYMENTS"
                    busy={loading === "Resume"}
                    disabled={loading !== null}
                    onClick={() => handleAction("Resume", restorePayments)}
                  />
                ) : (
                  <Button
                    label="HALT ALL PAYMENTS"
                    danger
                    busy={loading === "Halt"}
                    disabled={loading !== null}
                    onClick={() => handleAction("Halt", freezePayments)}
                  />
                )}
                {policyState.agentSigner ? (
                  <Button
                    label="REVOKE AGENT KEY"
                    danger
                    busy={loading === "Revoke"}
                    disabled={loading !== null}
                    onClick={() => handleAction("Revoke", revokeAgentSigner)}
                  />
                ) : (
                  <Button
                    label="REINSTATE AGENT KEY"
                    busy={loading === "Reinstate"}
                    disabled={loading !== null}
                    onClick={() => handleAction("Reinstate", restoreAgentSigner)}
                  />
                )}
              </section>
            )}
          </div>

          <div style={column}>
            <section style={panel}>
              <h2 style={heading}>SETTLEMENTS</h2>
              {transactions.length === 0 ? (
                <p style={body}>Nothing settled yet.</p>
              ) : (
                <div style={scroller}>
                  {transactions.map((tx) => (
                    <TxRow key={tx.id} tx={tx} />
                  ))}
                </div>
              )}
            </section>

            {logs.length > 0 && (
              <section style={panel}>
                <h2 style={heading}>LOG</h2>
                <div style={logList}>
                  {logs.map((entry) => (
                    <div key={entry.id} style={logRow}>
                      <span style={logTime}>{entry.time}</span>
                      <span style={{ ...logMsg, color: toneColor(entry.type) }}>
                        {entry.message}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Pieces ---- */

/** A signal behind the console that is not quite clean. */
function Scan() {
  return (
    <>
      <div className="glitch-static" />
      <div className="glitch-tears" />
      <div className="glitch-split" />
      <div className="glitch-vignette" />
    </>
  );
}

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div style={lineRow}>
      <span style={lineLabel}>{label}</span>
      <span style={{ ...lineValue, color: tone ?? text }}>{value}</span>
    </div>
  );
}

function Button({
  label,
  onClick,
  disabled,
  danger,
  busy,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  busy?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const off = disabled || busy;
  const colour = danger ? red : amber;

  return (
    <button
      style={{
        ...button,
        borderColor: off ? edge : hover ? colour : `${colour}66`,
        color: off ? dim : colour,
        background: hover && !off ? `${colour}12` : "transparent",
        cursor: off ? "default" : "pointer",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={off ? undefined : onClick}
      disabled={off}
    >
      {busy ? `${label}…` : label}
    </button>
  );
}

/** The daily budget as segments, so what remains is visible at a glance. */
function Meter({ used, total }: { used: number; total: number }) {
  const segments = total > 0 ? total : 10;
  const filled = Math.min(used, segments);
  const full = filled >= segments;

  return (
    <div>
      <Line
        label="Daily budget"
        value={`${used}${total > 0 ? ` of ${total}` : ""}`}
        tone={full ? red : amber}
      />
      <div style={meterTrack}>
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            style={{
              ...meterSegment,
              background: i < filled ? (full ? red : amber) : "#2a2119",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function TxRow({ tx }: { tx: Transaction }) {
  const ok = tx.status === "success";
  return (
    <div style={{ ...txRow, borderLeftColor: ok ? green : red }}>
      <div style={txHead}>
        <span style={{ ...txState, color: ok ? green : red }}>
          {ok ? "SETTLED" : "REFUSED"}
        </span>
        <span style={txAmount}>{formatAmount(tx.amount)} USDC</span>
      </div>
      {tx.tx_hash ? (
        <a
          style={txLink}
          href={`https://stellar.expert/explorer/testnet/tx/${tx.tx_hash}`}
          target="_blank"
          rel="noreferrer"
        >
          {tx.tx_hash.slice(0, 24)}
        </a>
      ) : (
        <span style={txWhy}>{tx.error}</span>
      )}
    </div>
  );
}

/* ---- Helpers ---- */

/** Stroops carry seven decimals, which is not a number anyone reads. */
function formatAmount(raw: string | null): string {
  if (!raw) return "0.00";
  try {
    return (Number(BigInt(raw)) / 10_000_000).toFixed(2);
  } catch {
    return raw;
  }
}

function toneColor(type: LogEntry["type"]): string {
  if (type === "success") return green;
  if (type === "error") return red;
  return dim;
}
