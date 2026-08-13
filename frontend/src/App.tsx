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
      setLogs((prev) => [{ id: ++logId, time, message, type }, ...prev].slice(0, 30));
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
    addLog("awaiting passkey");

    try {
      if (await authenticatePasskey(userId)) {
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        setAuthenticated(true);
        addLog("owner verified", "success");
        refresh();
        setAuthMode("idle");
        return;
      }
    } catch {
      // No passkey on this device yet, so enrol one.
    }

    setAuthMode("registering");
    addLog("no passkey on this device, enrolling");
    try {
      if (await registerPasskey(userId)) {
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        setAuthenticated(true);
        addLog("passkey enrolled, owner verified", "success");
        refresh();
      } else {
        addLog("enrolment refused", "error");
      }
    } catch {
      addLog("this browser refused the passkey", "error");
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
      addLog(`${action} :: awaiting passkey`);
      try {
        const result = await fn();
        if (result.success) {
          addLog(
            `${action} :: confirmed${result.txHash ? ` ${result.txHash.slice(0, 12)}` : ""}`,
            "success"
          );
          await refresh();
        } else {
          addLog(`${action} :: ${result.error ?? "refused"}`, "error");
        }
      } catch {
        addLog(`${action} :: failed`, "error");
      }
      setLoading(null);
    },
    [addLog, refresh]
  );

  // ── Authentication gate ─────────────────────────────────────────
  if (!authenticated) {
    return (
      <div style={{ ...page, ...gateLayout }}>
        <Panel style={gateBox}>
          <img src="/beaver402-logo.png" alt="" style={gateLogo} />
          <div>
            <h1 style={gateTitle}>BEAVER402</h1>
            <div style={gateTag}>PAYMENT AUTHORITY CONSOLE</div>
          </div>

          <div style={gateBrief}>
            <Line label="ROLE" value="ACCOUNT OWNER" />
            <Line label="METHOD" value="WEBAUTHN / SECP256R1" />
            <Line label="NETWORK" value="STELLAR TESTNET" />
          </div>

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
          <div style={gateNote}>
            Your key never leaves this device. Touch ID authorizes every action.
          </div>
        </Panel>
      </div>
    );
  }

  const needsMerchant = !policyState.merchantApproved;
  const live = !policyState.frozen && policyState.agentSigner !== null;

  // ── Console ─────────────────────────────────────────────────────
  return (
    <div style={page}>
      <div style={shell}>
        <Panel style={topBar}>
          <img src="/beaver402-logo.png" alt="" style={topLogo} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={topTitle}>BEAVER402</div>
            <div style={topSub}>{policyState.contractId}</div>
          </div>
          <Indicator on={live} label={policyState.frozen ? "HALTED" : "ARMED"} />
        </Panel>

        <div style={columns}>
          {/* Left: state and command */}
          <div style={column}>
            {needsMerchant && (
              <Panel accent={amber}>
                <Header text="ACTION REQUIRED" tone={amber} />
                <p style={body}>
                  No merchant is approved. Every payment is refused until one is.
                </p>
                <Button
                  label="APPROVE MERCHANT"
                  busy={loading === "approve"}
                  disabled={loading !== null || !merchantInfo}
                  onClick={() =>
                    merchantInfo &&
                    handleAction("approve", () =>
                      allowMerchant(merchantInfo.merchantPubkey)
                    )
                  }
                />
              </Panel>
            )}

            <Panel>
              <Header text="STATUS" />
              <Line
                label="PAYMENTS"
                value={policyState.frozen ? "HALTED" : "ACTIVE"}
                tone={policyState.frozen ? red : green}
              />
              <Line
                label="AGENT"
                value={policyState.agentSigner ? "AUTHORIZED" : "REVOKED"}
                tone={policyState.agentSigner ? green : red}
              />
              <Meter
                used={policyState.velocityTxCount}
                total={policyState.velocityMaxTxCount}
              />
              <p style={body}>
                {policyState.frozen
                  ? "The account refuses every payment until it is resumed."
                  : policyState.agentSigner
                    ? "The agent may pay approved merchants, within the daily limit."
                    : "The agent holds no key, so nothing can be paid."}
              </p>
            </Panel>

            {!needsMerchant && (
              <Panel>
                <Header text="COMMAND" />
                {policyState.frozen ? (
                  <Button
                    label="RESUME PAYMENTS"
                    busy={loading === "resume"}
                    disabled={loading !== null}
                    onClick={() => handleAction("resume", restorePayments)}
                  />
                ) : (
                  <Button
                    label="HALT ALL PAYMENTS"
                    danger
                    busy={loading === "stop"}
                    disabled={loading !== null}
                    onClick={() => handleAction("stop", freezePayments)}
                  />
                )}
                {policyState.agentSigner && (
                  <Button
                    label="REVOKE AGENT KEY"
                    danger
                    busy={loading === "revoke"}
                    disabled={loading !== null}
                    onClick={() => handleAction("revoke", revokeAgentSigner)}
                  />
                )}
                <p style={body}>Each command requires Touch ID.</p>
              </Panel>
            )}
          </div>

          {/* Right: record */}
          <div style={column}>
            <Panel>
              <Header text="SETTLEMENTS" badge={String(transactions.length)} />
              {transactions.length === 0 ? (
                <p style={body}>No settlements recorded.</p>
              ) : (
                <div style={scroller}>
                  {transactions.map((tx) => (
                    <TxRow key={tx.id} tx={tx} />
                  ))}
                </div>
              )}
            </Panel>

            <Panel>
              <Header text="LOG" />
              {logs.length === 0 ? (
                <p style={body}>Standing by.</p>
              ) : (
                <div style={logScroller}>
                  {logs.map((entry) => (
                    <div key={entry.id} style={logRow}>
                      <span style={logTime}>{entry.time}</span>
                      <span style={{ ...logMsg, color: toneColor(entry.type) }}>
                        {entry.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Pieces ---- */

/** A bordered section with tick marks at the corners. */
function Panel({
  children,
  style,
  accent,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  accent?: string;
}) {
  return (
    <section
      style={{
        ...panel,
        ...(accent ? { borderColor: `${accent}55` } : {}),
        ...style,
      }}
    >
      <span style={{ ...tick, top: -1, left: -1, borderWidth: "1px 0 0 1px" }} />
      <span style={{ ...tick, top: -1, right: -1, borderWidth: "1px 1px 0 0" }} />
      <span style={{ ...tick, bottom: -1, left: -1, borderWidth: "0 0 1px 1px" }} />
      <span style={{ ...tick, bottom: -1, right: -1, borderWidth: "0 1px 1px 0" }} />
      {children}
    </section>
  );
}

function Header({
  text,
  badge,
  tone,
}: {
  text: string;
  badge?: string;
  tone?: string;
}) {
  return (
    <div style={headerRow}>
      <span style={{ ...headerText, color: tone ?? dim }}>{text}</span>
      <span style={headerLine} />
      {badge && <span style={headerBadge}>{badge}</span>}
    </div>
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
      <span style={lineDots} />
      <span style={{ ...lineValue, color: tone ?? text }}>{value}</span>
    </div>
  );
}

/** A pulsing lamp, the way a console shows whether it is live. */
function Indicator({ on, label }: { on: boolean; label: string }) {
  return (
    <div style={indicator}>
      <span
        style={{
          ...lamp,
          background: on ? green : red,
          boxShadow: `0 0 10px ${on ? green : red}`,
        }}
      />
      <span style={{ ...indicatorText, color: on ? green : red }}>{label}</span>
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
  const colour = danger ? red : green;

  return (
    <button
      style={{
        ...button,
        borderColor: off ? "#2a332b" : hover ? colour : `${colour}77`,
        color: off ? dim : colour,
        background: hover && !off ? `${colour}14` : "transparent",
        cursor: off ? "default" : "pointer",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={off ? undefined : onClick}
      disabled={off}
    >
      <span style={buttonBracket}>[</span>
      {busy ? `${label} ...` : label}
      <span style={buttonBracket}>]</span>
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
        label="DAILY BUDGET"
        value={`${used}${total > 0 ? ` / ${total}` : ""}`}
        tone={full ? red : amber}
      />
      <div style={meterTrack}>
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            style={{
              ...meterSegment,
              background: i < filled ? (full ? red : amber) : "#1a211b",
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
          {tx.tx_hash.slice(0, 32)}
        </a>
      ) : (
        <span style={txWhy}>{shorten(tx.error ?? "", 72)}</span>
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

const green = "#5dd47f";
const red = "#e0574a";
const amber = "#d9a441";
const text = "#d2dad3";
const dim = "#6f7d72";
const edge = "#242e26";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#080b09",
  backgroundImage:
    "linear-gradient(rgba(93,212,127,0.028) 1px, transparent 1px)," +
    "linear-gradient(90deg, rgba(93,212,127,0.028) 1px, transparent 1px)",
  backgroundSize: "48px 48px",
  color: text,
  fontFamily: mono,
  fontSize: 14,
  lineHeight: 1.75,
  padding: 28,
};

const shell: React.CSSProperties = {
  maxWidth: 1280,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const panel: React.CSSProperties = {
  position: "relative",
  background: "rgba(14,19,15,0.86)",
  border: `1px solid ${edge}`,
  padding: 24,
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

const tick: React.CSSProperties = {
  position: "absolute",
  width: 10,
  height: 10,
  borderStyle: "solid",
  borderColor: green,
  opacity: 0.55,
  pointerEvents: "none",
};

const headerRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const headerText: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 3,
  flexShrink: 0,
};

const headerLine: React.CSSProperties = {
  flex: 1,
  height: 1,
  background: edge,
};

const headerBadge: React.CSSProperties = {
  fontSize: 12,
  color: dim,
  border: `1px solid ${edge}`,
  padding: "1px 8px",
};

const body: React.CSSProperties = {
  fontSize: 13,
  color: dim,
  lineHeight: 1.85,
};

/* Gate */

const gateLayout: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const gateBox: React.CSSProperties = {
  width: "min(520px, 100%)",
  alignItems: "center",
  textAlign: "center",
  padding: "48px 40px",
  gap: 22,
};

const gateLogo: React.CSSProperties = { width: 88, height: 88 };

const gateTitle: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 700,
  letterSpacing: 8,
  color: text,
};

const gateTag: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: 4,
  color: green,
  marginTop: 8,
};

const gateBrief: React.CSSProperties = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  borderTop: `1px solid ${edge}`,
  borderBottom: `1px solid ${edge}`,
  padding: "16px 0",
};

const gateNote: React.CSSProperties = {
  fontSize: 12,
  color: dim,
  lineHeight: 1.8,
};

/* Top bar */

const topBar: React.CSSProperties = {
  flexDirection: "row",
  alignItems: "center",
  gap: 18,
  padding: "18px 24px",
};

const topLogo: React.CSSProperties = { width: 40, height: 40 };

const topTitle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: 5,
  color: text,
};

const topSub: React.CSSProperties = {
  fontSize: 11,
  color: dim,
  marginTop: 4,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const indicator: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  border: `1px solid ${edge}`,
  padding: "8px 14px",
  flexShrink: 0,
};

const lamp: React.CSSProperties = { width: 8, height: 8, borderRadius: 4 };

const indicatorText: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 2,
};

/* Layout */

const columns: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
  gap: 20,
  alignItems: "start",
};

const column: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 20,
  minWidth: 0,
};

/* Readouts */

const lineRow: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
};

const lineLabel: React.CSSProperties = {
  fontSize: 12,
  color: dim,
  letterSpacing: 1,
  flexShrink: 0,
};

const lineDots: React.CSSProperties = {
  flex: 1,
  height: 1,
  background: `repeating-linear-gradient(90deg, ${edge} 0 2px, transparent 2px 6px)`,
};

const lineValue: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: 1,
  flexShrink: 0,
};

const meterTrack: React.CSSProperties = {
  display: "flex",
  gap: 3,
  marginTop: 10,
};

const meterSegment: React.CSSProperties = { flex: 1, height: 8 };

/* Command */

const button: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 3,
  width: "100%",
  padding: "16px 18px",
  border: "1px solid",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  transition: "background 120ms linear, border-color 120ms linear",
};

const buttonBracket: React.CSSProperties = { opacity: 0.45 };

/* Record */

const scroller: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  maxHeight: 400,
  overflowY: "auto",
};

const logScroller: React.CSSProperties = { ...scroller, maxHeight: 230 };

const txRow: React.CSSProperties = {
  background: "rgba(255,255,255,0.015)",
  borderLeft: "2px solid",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const txHead: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
};

const txState: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 2,
};

const txAmount: React.CSSProperties = { fontSize: 13, color: text };

const txLink: React.CSSProperties = {
  fontSize: 12,
  color: "#6fa8dc",
  textDecoration: "none",
  wordBreak: "break-all",
};

const txWhy: React.CSSProperties = {
  fontSize: 12,
  color: "#c98b80",
  lineHeight: 1.7,
};

const logRow: React.CSSProperties = { display: "flex", gap: 12 };

const logTime: React.CSSProperties = { fontSize: 12, color: "#4e5a51", flexShrink: 0 };

const logMsg: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.7,
  wordBreak: "break-word",
};
