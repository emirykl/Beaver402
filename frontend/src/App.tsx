import React, { useState, useCallback, useEffect } from "react";
import {
  fetchPolicyState,
  type MerchantInfo,
  allowMerchant,
  fetchMerchantInfo,
  freezePayments,
  restorePayments,
  revokeAgentSigner,
  fetchTransactions,
  type PolicyState,
  type Transaction,
} from "./stellar-ops.js";
import { registerPasskey, authenticatePasskey } from "./passkey-auth.js";

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
    merchantApproved: false,
    velocityMaxTxCount: 0,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"idle" | "registering" | "authenticating">(
    "idle"
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [merchantInfo, setMerchantInfo] = useState<MerchantInfo | null>(null);

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
    setAuthMode("authenticating");
    addLog("Awaiting passkey");

    try {
      if (await authenticatePasskey(userId)) {
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        setAuthenticated(true);
        addLog("Owner verified", "success");
        refresh();
        setAuthMode("idle");
        return;
      }
    } catch {
      // No passkey on this device yet, so enrol one.
    }

    setAuthMode("registering");
    addLog("Enrolling a passkey on this device");
    try {
      if (await registerPasskey(userId)) {
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        setAuthenticated(true);
        addLog("Passkey enrolled", "success");
        refresh();
      } else {
        addLog("Enrolment refused", "error");
      }
    } catch {
      addLog("This browser refused the passkey", "error");
    }
    setAuthMode("idle");
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
          <p style={gateNote}>Touch ID authorizes every action</p>
        </section>
      </div>
    );
  }

  const needsMerchant = !policyState.merchantApproved;
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
            <div style={topSub}>{policyState.contractId}</div>
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
                {policyState.agentSigner && (
                  <Button
                    label="REVOKE AGENT KEY"
                    danger
                    busy={loading === "Revoke"}
                    disabled={loading !== null}
                    onClick={() => handleAction("Revoke", revokeAgentSigner)}
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

/** The surface of a piece of equipment that is watching something. */
function Scan() {
  return (
    <>
      <div className="scan-lines" />
      <div className="scan-sweep" />
      <div className="scan-vignette" />
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
        <span style={txWhy}>{shorten(tx.error ?? "", 64)}</span>
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

function shorten(value: string, n: number): string {
  return value.length <= n ? value : `${value.slice(0, n - 1)}…`;
}

function toneColor(type: LogEntry["type"]): string {
  if (type === "success") return green;
  if (type === "error") return red;
  return dim;
}

/* ---- Styles ---- */

const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const amber = "#e0a94a";
const green = "#93c06a";
const red = "#d4674f";
const text = "#ece0cf";
const dim = "#9c8a75";
const edge = "#3b2f24";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#15100b",
  color: text,
  fontFamily: mono,
  fontSize: 16,
  lineHeight: 1.7,
  padding: 32,
};

const shell: React.CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 26,
};

const panel: React.CSSProperties = {
  background: "#1d1610",
  border: `1px solid ${edge}`,
  padding: 32,
  display: "flex",
  flexDirection: "column",
  gap: 22,
};

const heading: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 4,
  color: dim,
};

const body: React.CSSProperties = {
  fontSize: 15,
  color: dim,
  lineHeight: 1.8,
};

/* Gate */

const gateLayout: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const gateBox: React.CSSProperties = {
  width: "min(540px, 100%)",
  alignItems: "center",
  textAlign: "center",
  padding: "56px 48px",
  gap: 26,
};

const gateLogo: React.CSSProperties = { width: 104, height: 104 };

const gateTitle: React.CSSProperties = {
  fontSize: 34,
  fontWeight: 700,
  letterSpacing: 9,
  color: text,
};

const gateText: React.CSSProperties = {
  fontSize: 17,
  color: dim,
  lineHeight: 1.8,
};

const gateNote: React.CSSProperties = { fontSize: 14, color: dim };

/* Top bar */

const topBar: React.CSSProperties = {
  flexDirection: "row",
  alignItems: "center",
  gap: 22,
  padding: "24px 32px",
};

const topLogo: React.CSSProperties = { width: 52, height: 52 };

const topTitle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: 6,
  color: text,
};

const topSub: React.CSSProperties = {
  fontSize: 13,
  color: dim,
  marginTop: 6,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const indicator: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  border: `1px solid ${edge}`,
  padding: "12px 18px",
  flexShrink: 0,
};

const lamp: React.CSSProperties = { width: 10, height: 10, borderRadius: 5 };

const indicatorText: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 3,
};

/* Layout */

const columns: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))",
  gap: 26,
  alignItems: "start",
};

const column: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 26,
  minWidth: 0,
};

/* Readouts */

const lineRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 16,
};

const lineLabel: React.CSSProperties = { fontSize: 16, color: dim };

const lineValue: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  letterSpacing: 1,
};

const meterTrack: React.CSSProperties = {
  display: "flex",
  gap: 4,
  marginTop: 14,
};

const meterSegment: React.CSSProperties = { flex: 1, height: 12 };

/* Command */

const button: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: 3,
  width: "100%",
  padding: "22px 20px",
  border: "1px solid",
  transition: "background 120ms linear, border-color 120ms linear",
};

/* Record */

const scroller: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  maxHeight: 420,
  overflowY: "auto",
};

const txRow: React.CSSProperties = {
  background: "rgba(255,255,255,0.02)",
  borderLeft: "3px solid",
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const txHead: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 16,
};

const txState: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 2,
};

const txAmount: React.CSSProperties = { fontSize: 16, color: text };

const txLink: React.CSSProperties = {
  fontSize: 14,
  color: "#8fb4d8",
  textDecoration: "none",
  wordBreak: "break-all",
};

const txWhy: React.CSSProperties = {
  fontSize: 14,
  color: "#c98b80",
  lineHeight: 1.7,
};

const logList: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const logRow: React.CSSProperties = { display: "flex", gap: 16 };

const logTime: React.CSSProperties = { fontSize: 14, color: "#6b5a48", flexShrink: 0 };

const logMsg: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  wordBreak: "break-word",
};
