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
      const time = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
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
    addLog("Waiting for your passkey");

    try {
      if (await authenticatePasskey(userId)) {
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        setAuthenticated(true);
        addLog("Signed in", "success");
        refresh();
        setAuthMode("idle");
        return;
      }
    } catch {
      // No passkey on this device yet, so make one.
    }

    setAuthMode("registering");
    addLog("No passkey here yet, creating one");
    try {
      if (await registerPasskey(userId)) {
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        setAuthenticated(true);
        addLog("Passkey created, signed in", "success");
        refresh();
      } else {
        addLog("Could not create a passkey", "error");
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
      addLog(`${action}: waiting for your passkey`);
      try {
        const result = await fn();
        if (result.success) {
          addLog(
            `${action}: done${result.txHash ? ` ${result.txHash.slice(0, 10)}` : ""}`,
            "success"
          );
          await refresh();
        } else {
          addLog(`${action}: ${result.error ?? "refused"}`, "error");
        }
      } catch {
        addLog(`${action}: something went wrong`, "error");
      }
      setLoading(null);
    },
    [addLog, refresh]
  );

  // ── Sign in ─────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <div style={{ ...page, ...gateLayout }}>
        <Frame style={gateBox}>
          <img src="/beaver402-logo.png" alt="" style={gateLogo} />
          <h1 style={gateTitle}>BEAVER402</h1>
          <div style={rule} />
          <p style={gateText}>
            YOUR AGENT CAN ONLY PAY
            <br />
            FOR WHAT YOU APPROVED
          </p>
          <Button
            label={
              authMode === "authenticating"
                ? "CHECKING"
                : authMode === "registering"
                  ? "CREATING"
                  : "SIGN IN WITH PASSKEY"
            }
            disabled={authMode !== "idle"}
            onClick={handleAuth}
          />
          <p style={gateHint}>TOUCH ID CONFIRMS YOU OWN THIS ACCOUNT</p>
        </Frame>
      </div>
    );
  }

  const needsMerchant = !policyState.merchantApproved;

  // ── Control panel ───────────────────────────────────────────────
  return (
    <div style={page}>
      <div style={shell}>
        <Frame style={topBar}>
          <img src="/beaver402-logo.png" alt="" style={topLogo} />
          <div style={topText}>
            <div style={topTitle}>BEAVER402</div>
            <div style={topSub}>{shorten(policyState.contractId, 22)}</div>
          </div>
          <div
            style={{
              ...chip,
              color: policyState.frozen ? red : green,
              borderColor: policyState.frozen ? red : green,
            }}
          >
            {policyState.frozen ? "STOPPED" : "RUNNING"}
          </div>
        </Frame>

        <div style={columns}>
          {/* Left: state and controls */}
          <div style={column}>
            {needsMerchant && (
              <Frame>
                <Title>ONE STEP LEFT</Title>
                <p style={body}>
                  No merchant is approved yet, so every payment is refused.
                </p>
                <Button
                  label={loading === "approve" ? "WAITING" : "APPROVE MERCHANT"}
                  disabled={loading !== null || !merchantInfo}
                  onClick={() =>
                    merchantInfo &&
                    handleAction("approve", () =>
                      allowMerchant(merchantInfo.merchantPubkey)
                    )
                  }
                />
              </Frame>
            )}

            <Frame>
              <Title>STATUS</Title>
              <Readout
                label="PAYMENTS"
                value={policyState.frozen ? "STOPPED" : "RUNNING"}
                tone={policyState.frozen ? "red" : "green"}
              />
              <Readout
                label="AGENT"
                value={policyState.agentSigner ? "CAN PAY" : "REVOKED"}
                tone={policyState.agentSigner ? "green" : "red"}
              />
              <Meter
                used={policyState.velocityTxCount}
                total={policyState.velocityMaxTxCount}
              />
              <p style={body}>
                {policyState.frozen
                  ? "Nothing can be paid until you resume."
                  : policyState.agentSigner
                    ? "The agent can pay approved merchants, up to the daily limit."
                    : "The agent has no key left, so nothing can be paid."}
              </p>
            </Frame>

            {!needsMerchant && (
              <Frame>
                <Title>CONTROLS</Title>
                {policyState.frozen ? (
                  <Button
                    label={loading === "resume" ? "WAITING" : "RESUME PAYMENTS"}
                    disabled={loading !== null}
                    onClick={() => handleAction("resume", restorePayments)}
                  />
                ) : (
                  <Button
                    label={loading === "stop" ? "WAITING" : "STOP ALL PAYMENTS"}
                    danger
                    disabled={loading !== null}
                    onClick={() => handleAction("stop", freezePayments)}
                  />
                )}
                {policyState.agentSigner && (
                  <Button
                    label={loading === "revoke" ? "WAITING" : "REVOKE THE AGENT"}
                    danger
                    disabled={loading !== null}
                    onClick={() => handleAction("revoke", revokeAgentSigner)}
                  />
                )}
                <p style={body}>Each one asks for Touch ID.</p>
              </Frame>
            )}
          </div>

          {/* Right: what happened */}
          <div style={column}>
            <Frame>
              <Title>
                PAYMENTS <span style={count}>{transactions.length}</span>
              </Title>
              {transactions.length === 0 ? (
                <p style={body}>Nothing paid yet.</p>
              ) : (
                <div style={scroller}>
                  {transactions.map((tx) => (
                    <TxRow key={tx.id} tx={tx} />
                  ))}
                </div>
              )}
            </Frame>

            <Frame>
              <Title>LOG</Title>
              {logs.length === 0 ? (
                <p style={body}>Nothing yet.</p>
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
            </Frame>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Pieces ---- */

/** A panel with the corner brackets, wood body and raised edge. */
function Frame({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section style={{ ...frame, ...style }}>
      <span style={{ ...corner, top: 6, left: 6, borderWidth: "2px 0 0 2px" }} />
      <span style={{ ...corner, top: 6, right: 6, borderWidth: "2px 2px 0 0" }} />
      <span style={{ ...corner, bottom: 6, left: 6, borderWidth: "0 0 2px 2px" }} />
      <span style={{ ...corner, bottom: 6, right: 6, borderWidth: "0 2px 2px 0" }} />
      {children}
    </section>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div style={titleText}>{children}</div>
      <div style={rule} />
    </div>
  );
}

function Button({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [held, setHeld] = useState(false);

  const face = disabled
    ? "#3a2c1e"
    : danger
      ? hover
        ? "#a8452f"
        : "#8a3626"
      : hover
        ? "#8a6a3c"
        : "#70552f";

  return (
    <button
      style={{
        ...button,
        background: face,
        color: disabled ? "#7a6650" : "#fff3dc",
        cursor: disabled ? "default" : "pointer",
        boxShadow: held && !disabled ? bevelPressed : bevel,
        transform: held && !disabled ? "translateY(2px)" : "none",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setHeld(false);
      }}
      onMouseDown={() => setHeld(true)}
      onMouseUp={() => setHeld(false)}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

function Readout({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "red";
}) {
  return (
    <div style={readout}>
      <span style={readoutLabel}>{label}</span>
      <span style={{ ...readoutValue, color: tone === "green" ? green : red }}>
        {value}
      </span>
    </div>
  );
}

/** The daily budget drawn as blocks, so what is left can be seen at a glance. */
function Meter({ used, total }: { used: number; total: number }) {
  const blocks = total > 0 ? total : 10;
  const filled = Math.min(used, blocks);
  const full = filled >= blocks;

  return (
    <div>
      <div style={readout}>
        <span style={readoutLabel}>TODAY</span>
        <span style={{ ...readoutValue, color: full ? red : amber }}>
          {used}
          {total > 0 ? ` / ${total}` : ""}
        </span>
      </div>
      <div style={meterTrack}>
        {Array.from({ length: blocks }, (_, i) => (
          <span
            key={i}
            style={{
              ...meterBlock,
              background: i < filled ? (full ? red : amber) : "#241a12",
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
    <div style={txRow}>
      <div style={txHead}>
        <span style={{ ...txState, color: ok ? green : red }}>
          {ok ? "PAID" : "REFUSED"}
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
          {tx.tx_hash.slice(0, 20)}
        </a>
      ) : (
        <span style={txWhy}>{shorten(tx.error ?? "", 52)}</span>
      )}
    </div>
  );
}

/* ---- Helpers ---- */

/** Stroops carry seven decimals, which is not a number anyone reads. */
function formatAmount(raw: string | null): string {
  if (!raw) return "0";
  try {
    const value = Number(BigInt(raw)) / 10_000_000;
    return value.toFixed(2);
  } catch {
    return raw;
  }
}

function shorten(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

function toneColor(type: LogEntry["type"]): string {
  if (type === "success") return green;
  if (type === "error") return red;
  return "#a8916f";
}

/* ---- Styles ---- */

const pixel = "'Press Start 2P', 'Courier New', monospace";

const green = "#8ed94f";
const red = "#e05a43";
const amber = "#e0a33c";
const parchment = "#f0e2cc";

const bevel =
  "inset 4px 4px 0 rgba(255,225,180,0.16), inset -4px -4px 0 rgba(0,0,0,0.5)";
const bevelPressed =
  "inset -4px -4px 0 rgba(255,225,180,0.1), inset 4px 4px 0 rgba(0,0,0,0.5)";
const sunken =
  "inset 4px 4px 0 rgba(0,0,0,0.55), inset -4px -4px 0 rgba(255,225,180,0.07)";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#1a120b",
  backgroundImage:
    "repeating-linear-gradient(0deg, rgba(255,200,140,0.02) 0 2px, transparent 2px 5px)",
  color: parchment,
  fontFamily: pixel,
  fontSize: 12,
  lineHeight: 2,
  padding: 24,
};

const shell: React.CSSProperties = {
  maxWidth: 1240,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 22,
};

const frame: React.CSSProperties = {
  position: "relative",
  background: "#4a3524",
  boxShadow: bevel,
  padding: 24,
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

const corner: React.CSSProperties = {
  position: "absolute",
  width: 12,
  height: 12,
  borderStyle: "solid",
  borderColor: amber,
  opacity: 0.75,
  pointerEvents: "none",
};

const rule: React.CSSProperties = {
  height: 3,
  background: "rgba(224,163,60,0.35)",
  marginTop: 12,
};

const titleText: React.CSSProperties = {
  fontSize: 14,
  color: amber,
  letterSpacing: 2,
  textShadow: "3px 3px 0 rgba(0,0,0,0.55)",
};

const count: React.CSSProperties = { color: "#a8916f", fontSize: 12 };

const body: React.CSSProperties = {
  fontSize: 10,
  color: "#c9b394",
  lineHeight: 2.2,
};

/* Sign in */

const gateLayout: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const gateBox: React.CSSProperties = {
  width: "min(520px, 100%)",
  textAlign: "center",
  alignItems: "center",
  padding: "48px 40px",
  gap: 20,
};

const gateLogo: React.CSSProperties = {
  width: 104,
  height: 104,
  imageRendering: "pixelated",
};

const gateTitle: React.CSSProperties = {
  fontSize: 30,
  color: parchment,
  textShadow: "4px 4px 0 rgba(0,0,0,0.6)",
  letterSpacing: 3,
};

const gateText: React.CSSProperties = {
  fontSize: 11,
  color: "#c9b394",
  lineHeight: 2.4,
  letterSpacing: 1,
};

const gateHint: React.CSSProperties = {
  fontSize: 9,
  color: "#a8916f",
  letterSpacing: 1,
  lineHeight: 2,
};

/* Top bar */

const topBar: React.CSSProperties = {
  flexDirection: "row",
  alignItems: "center",
  gap: 18,
  padding: "18px 24px",
};

const topLogo: React.CSSProperties = {
  width: 44,
  height: 44,
  imageRendering: "pixelated",
};

const topText: React.CSSProperties = { flex: 1, minWidth: 0 };

const topTitle: React.CSSProperties = {
  fontSize: 18,
  color: parchment,
  letterSpacing: 2,
  textShadow: "3px 3px 0 rgba(0,0,0,0.6)",
};

const topSub: React.CSSProperties = {
  fontSize: 9,
  color: "#a8916f",
  marginTop: 8,
};

const chip: React.CSSProperties = {
  fontSize: 11,
  padding: "10px 16px",
  border: "2px solid",
  letterSpacing: 2,
  flexShrink: 0,
};

/* Layout */

const columns: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
  gap: 22,
  alignItems: "start",
};

const column: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 22,
  minWidth: 0,
};

/* Controls */

const button: React.CSSProperties = {
  fontFamily: pixel,
  fontSize: 12,
  width: "100%",
  padding: "20px 18px",
  border: "none",
  textShadow: "2px 2px 0 rgba(0,0,0,0.6)",
  letterSpacing: 2,
  lineHeight: 1.6,
};

/* Readouts */

const readout: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  background: "#3a2a1c",
  boxShadow: sunken,
  padding: "14px 16px",
};

const readoutLabel: React.CSSProperties = {
  fontSize: 10,
  color: "#a8916f",
  letterSpacing: 1,
};

const readoutValue: React.CSSProperties = { fontSize: 12, letterSpacing: 1 };

const meterTrack: React.CSSProperties = {
  display: "flex",
  gap: 4,
  background: "#3a2a1c",
  boxShadow: sunken,
  padding: 6,
  marginTop: 10,
};

const meterBlock: React.CSSProperties = { flex: 1, height: 16 };

/* Lists */

const scroller: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  maxHeight: 380,
  overflowY: "auto",
};

const logScroller: React.CSSProperties = { ...scroller, maxHeight: 220 };

const txRow: React.CSSProperties = {
  background: "#3a2a1c",
  boxShadow: sunken,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const txHead: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
};

const txState: React.CSSProperties = { fontSize: 11, letterSpacing: 1 };
const txAmount: React.CSSProperties = { fontSize: 11, color: parchment };

const txLink: React.CSSProperties = {
  fontSize: 9,
  color: "#7fb0e0",
  textDecoration: "none",
  wordBreak: "break-all",
};

const txWhy: React.CSSProperties = { fontSize: 9, color: "#d09a8a", lineHeight: 2 };

const logRow: React.CSSProperties = { display: "flex", gap: 12 };

const logTime: React.CSSProperties = {
  fontSize: 9,
  color: "#8a7355",
  flexShrink: 0,
};

const logMsg: React.CSSProperties = {
  fontSize: 9,
  lineHeight: 2,
  wordBreak: "break-word",
};
