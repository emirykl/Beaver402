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
      setLogs((prev) => [{ id: ++logId, time, message, type }, ...prev].slice(0, 40));
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

  const stepsDone = (authenticated ? 1 : 0) + (policyState.merchantApproved ? 1 : 0);
  const setupDone = stepsDone === 2;

  // ── The gate ────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <div style={{ ...page, ...gateLayout }}>
        <div style={gateBox}>
          <img src="/beaver402-logo.png" alt="" style={gateLogo} />
          <h1 style={gateTitle}>BEAVER402</h1>
          <p style={gateText}>
            Your agent can only pay
            <br />
            for what you approved
          </p>
          <Button
            label={
              authMode === "authenticating"
                ? "CHECKING..."
                : authMode === "registering"
                  ? "CREATING..."
                  : "SIGN IN WITH PASSKEY"
            }
            wide
            disabled={authMode !== "idle"}
            onClick={handleAuth}
          />
          <p style={gateHint}>Touch ID confirms you own this account</p>
        </div>
      </div>
    );
  }

  // ── The panel ───────────────────────────────────────────────────
  return (
    <div style={page}>
      <header style={topBar}>
        <img src="/beaver402-logo.png" alt="" style={topLogo} />
        <span style={topTitle}>BEAVER402</span>
        <span style={{ ...pill, ...(policyState.frozen ? pillRed : pillGreen) }}>
          {policyState.frozen ? "STOPPED" : "RUNNING"}
        </span>
      </header>

      <div style={columns}>
        {/* Left */}
        <div style={column}>
          {!setupDone && (
            <Panel title={`SETUP  ${stepsDone}/2`}>
              <Step n={1} label="Sign in with your passkey" done />
              <Step
                n={2}
                label="Approve the demo merchant"
                done={policyState.merchantApproved}
                note="Until you do, every payment is refused"
              />
              {!policyState.merchantApproved && (
                <Button
                  label={loading === "approve" ? "WAITING..." : "APPROVE MERCHANT"}
                  wide
                  disabled={loading !== null || !merchantInfo}
                  onClick={() =>
                    merchantInfo &&
                    handleAction("approve", () =>
                      allowMerchant(merchantInfo.merchantPubkey)
                    )
                  }
                />
              )}
            </Panel>
          )}

          <Panel title="STATUS">
            <Stat
              label="Payments"
              value={policyState.frozen ? "STOPPED" : "RUNNING"}
              tone={policyState.frozen ? "red" : "green"}
            />
            <Stat
              label="Agent"
              value={policyState.agentSigner ? "CAN PAY" : "REVOKED"}
              tone={policyState.agentSigner ? "green" : "red"}
            />
            <Meter
              used={policyState.velocityTxCount}
              total={policyState.velocityMaxTxCount}
            />
            <p style={note}>
              {policyState.frozen
                ? "Nothing can be paid until you resume."
                : policyState.agentSigner
                  ? "The agent can pay approved merchants, up to the daily limit."
                  : "The agent has no key left, so nothing can be paid."}
            </p>
            <Slot label="ACCOUNT" value={policyState.contractId} />
            {merchantInfo && (
              <Slot label="MERCHANT" value={merchantInfo.merchantPubkey} />
            )}
          </Panel>

          {setupDone && (
            <Panel title="CONTROLS">
              {policyState.frozen ? (
                <Button
                  label={loading === "resume" ? "WAITING..." : "RESUME PAYMENTS"}
                  wide
                  disabled={loading !== null}
                  onClick={() => handleAction("resume", restorePayments)}
                />
              ) : (
                <Button
                  label={loading === "stop" ? "WAITING..." : "STOP ALL PAYMENTS"}
                  wide
                  danger
                  disabled={loading !== null}
                  onClick={() => handleAction("stop", freezePayments)}
                />
              )}
              {policyState.agentSigner && (
                <Button
                  label={loading === "revoke" ? "WAITING..." : "REVOKE THE AGENT"}
                  wide
                  danger
                  disabled={loading !== null}
                  onClick={() => handleAction("revoke", revokeAgentSigner)}
                />
              )}
              <p style={note}>Each one asks for Touch ID. Only you can approve them.</p>
            </Panel>
          )}
        </div>

        {/* Right */}
        <div style={column}>
          <Panel title={`PAYMENTS  ${transactions.length}`}>
            {transactions.length === 0 ? (
              <p style={empty}>Nothing paid yet</p>
            ) : (
              <div style={list}>
                {transactions.map((tx) => (
                  <TxRow key={tx.id} tx={tx} />
                ))}
              </div>
            )}
          </Panel>

          <Panel title="ACTIVITY">
            {logs.length === 0 ? (
              <p style={empty}>Nothing yet</p>
            ) : (
              <div style={list}>
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
  );
}

/* ---- Pieces ---- */

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={panel}>
      <div style={panelTitle}>{title}</div>
      <div style={panelBody}>{children}</div>
    </section>
  );
}

function Button({
  label,
  onClick,
  disabled,
  danger,
  wide,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  wide?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [held, setHeld] = useState(false);

  const face = disabled
    ? "#4a4a4a"
    : danger
      ? hover
        ? "#c65246"
        : "#a63f34"
      : hover
        ? "#7d7d7d"
        : "#6a6a6a";

  return (
    <button
      style={{
        ...button,
        ...(wide ? { width: "100%" } : {}),
        background: face,
        color: disabled ? "#8b8b8b" : "#ffffff",
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

function Step({
  n,
  label,
  done,
  note: hint,
}: {
  n: number;
  label: string;
  done: boolean;
  note?: string;
}) {
  return (
    <div style={stepRow}>
      <span style={{ ...stepBox, ...(done ? stepBoxDone : {}) }}>{done ? "✓" : n}</span>
      <span>
        <span style={{ ...stepLabel, color: done ? "#8b8b8b" : "#ffffff" }}>
          {label}
        </span>
        {hint && !done && <span style={stepNote}>{hint}</span>}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "red";
}) {
  return (
    <div style={statRow}>
      <span style={statLabel}>{label}</span>
      <span style={{ ...statValue, color: tone === "green" ? "#55ff55" : "#ff5555" }}>
        {value}
      </span>
    </div>
  );
}

/** A blocky bar for the daily budget, in the spirit of a game meter. */
function Meter({ used, total }: { used: number; total: number }) {
  const blocks = total > 0 ? total : 10;
  const filled = Math.min(used, blocks);

  return (
    <div style={meterWrap}>
      <div style={statRow}>
        <span style={statLabel}>Used today</span>
        <span style={statValue}>
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
              background:
                i < filled ? (filled >= blocks ? "#ff5555" : "#55ff55") : "#2a2a2a",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Slot({ label, value }: { label: string; value: string }) {
  return (
    <div style={slot}>
      <div style={slotLabel}>{label}</div>
      <div style={slotValue}>{value}</div>
    </div>
  );
}

function TxRow({ tx }: { tx: Transaction }) {
  const ok = tx.status === "success";
  return (
    <div style={txRow}>
      <div style={txHead}>
        <span style={{ ...txState, color: ok ? "#55ff55" : "#ff5555" }}>
          {ok ? "PAID" : "REFUSED"}
        </span>
        <span style={txAmount}>{formatAmount(tx.amount)} USDC</span>
      </div>
      <div style={txSub}>
        {tx.tx_hash ? (
          <a
            style={txLink}
            href={`https://stellar.expert/explorer/testnet/tx/${tx.tx_hash}`}
            target="_blank"
            rel="noreferrer"
          >
            {tx.tx_hash.slice(0, 18)}
          </a>
        ) : (
          <span style={txWhy}>{shorten(tx.error ?? "", 46)}</span>
        )}
        <span style={txTime}>{new Date(tx.created_at).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

/* ---- Helpers ---- */

/** Stroops carry seven decimals, which is not a number anyone reads. */
function formatAmount(raw: string | null): string {
  if (!raw) return "0";
  try {
    const value = Number(BigInt(raw)) / 10_000_000;
    return value.toFixed(value < 1 ? 2 : 1);
  } catch {
    return raw;
  }
}

function shorten(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

function toneColor(type: LogEntry["type"]): string {
  if (type === "success") return "#55ff55";
  if (type === "error") return "#ff5555";
  return "#a8a8a8";
}

/* ---- Styles ---- */

const pixel = "'Press Start 2P', 'Courier New', monospace";

/** The raised edge every control in the game shares. */
const bevel =
  "inset 3px 3px 0 rgba(255,255,255,0.28), inset -3px -3px 0 rgba(0,0,0,0.45)";
const bevelPressed =
  "inset -3px -3px 0 rgba(255,255,255,0.16), inset 3px 3px 0 rgba(0,0,0,0.45)";
const sunken =
  "inset 3px 3px 0 rgba(0,0,0,0.55), inset -3px -3px 0 rgba(255,255,255,0.12)";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#1b1b1b",
  backgroundImage:
    "repeating-linear-gradient(0deg, rgba(255,255,255,0.014) 0 2px, transparent 2px 4px)",
  color: "#e8e8e8",
  fontFamily: pixel,
  fontSize: 10,
  lineHeight: 1.9,
  padding: 20,
};

const gateLayout: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const gateBox: React.CSSProperties = {
  width: "min(420px, 100%)",
  textAlign: "center",
  background: "#3a3a3a",
  boxShadow: bevel,
  padding: "36px 28px",
};

const gateLogo: React.CSSProperties = {
  width: 72,
  height: 72,
  imageRendering: "pixelated",
  marginBottom: 20,
};

const gateTitle: React.CSSProperties = {
  fontSize: 20,
  color: "#ffffff",
  textShadow: "3px 3px 0 #202020",
  marginBottom: 18,
  letterSpacing: 1,
};

const gateText: React.CSSProperties = {
  color: "#b8b8b8",
  fontSize: 9,
  lineHeight: 2.2,
  marginBottom: 28,
};

const gateHint: React.CSSProperties = {
  color: "#8b8b8b",
  fontSize: 7,
  marginTop: 18,
  lineHeight: 2,
};

const topBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: 1180,
  margin: "0 auto 18px",
  background: "#3a3a3a",
  boxShadow: bevel,
  padding: "12px 16px",
};

const topLogo: React.CSSProperties = {
  width: 26,
  height: 26,
  imageRendering: "pixelated",
};

const topTitle: React.CSSProperties = {
  fontSize: 12,
  color: "#ffffff",
  textShadow: "2px 2px 0 #202020",
  flex: 1,
};

const pill: React.CSSProperties = {
  fontSize: 8,
  padding: "6px 10px",
  boxShadow: sunken,
  background: "#2a2a2a",
};

const pillGreen: React.CSSProperties = { color: "#55ff55" };
const pillRed: React.CSSProperties = { color: "#ff5555" };

const columns: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  gap: 18,
  maxWidth: 1180,
  margin: "0 auto",
  alignItems: "start",
};

const column: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
  minWidth: 0,
};

const panel: React.CSSProperties = {
  background: "#3a3a3a",
  boxShadow: bevel,
};

const panelTitle: React.CSSProperties = {
  fontSize: 9,
  color: "#ffffff",
  textShadow: "2px 2px 0 #202020",
  padding: "12px 16px",
  borderBottom: "3px solid rgba(0,0,0,0.35)",
  letterSpacing: 1,
};

const panelBody: React.CSSProperties = {
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const button: React.CSSProperties = {
  fontFamily: pixel,
  fontSize: 9,
  padding: "14px 16px",
  border: "none",
  textShadow: "2px 2px 0 rgba(0,0,0,0.55)",
  letterSpacing: 1,
  lineHeight: 1.6,
};

const stepRow: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
};

const stepBox: React.CSSProperties = {
  width: 20,
  height: 20,
  flexShrink: 0,
  background: "#2a2a2a",
  boxShadow: sunken,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 8,
  color: "#8b8b8b",
};

const stepBoxDone: React.CSSProperties = { background: "#3d7a3d", color: "#ffffff" };

const stepLabel: React.CSSProperties = { fontSize: 9, display: "block" };

const stepNote: React.CSSProperties = {
  fontSize: 7,
  color: "#8b8b8b",
  display: "block",
  marginTop: 6,
  lineHeight: 2,
};

const statRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
};

const statLabel: React.CSSProperties = { fontSize: 8, color: "#a8a8a8" };
const statValue: React.CSSProperties = { fontSize: 9, color: "#ffffff" };

const meterWrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const meterTrack: React.CSSProperties = {
  display: "flex",
  gap: 3,
  background: "#2a2a2a",
  boxShadow: sunken,
  padding: 4,
};

const meterBlock: React.CSSProperties = { flex: 1, height: 10 };

const note: React.CSSProperties = {
  fontSize: 7,
  color: "#8b8b8b",
  lineHeight: 2.2,
};

const slot: React.CSSProperties = {
  background: "#2a2a2a",
  boxShadow: sunken,
  padding: "10px 12px",
};

const slotLabel: React.CSSProperties = { fontSize: 7, color: "#8b8b8b" };

const slotValue: React.CSSProperties = {
  fontSize: 7,
  color: "#d8d8d8",
  wordBreak: "break-all",
  lineHeight: 2,
  marginTop: 4,
};

const list: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxHeight: 340,
  overflowY: "auto",
};

const empty: React.CSSProperties = { fontSize: 8, color: "#6a6a6a" };

const txRow: React.CSSProperties = {
  background: "#2a2a2a",
  boxShadow: sunken,
  padding: "10px 12px",
};

const txHead: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
};

const txState: React.CSSProperties = { fontSize: 8 };
const txAmount: React.CSSProperties = { fontSize: 8, color: "#ffffff" };

const txSub: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  marginTop: 6,
};

const txLink: React.CSSProperties = {
  fontSize: 7,
  color: "#7aa8ff",
  textDecoration: "none",
  wordBreak: "break-all",
};

const txWhy: React.CSSProperties = { fontSize: 7, color: "#c88b8b", lineHeight: 2 };
const txTime: React.CSSProperties = { fontSize: 7, color: "#6a6a6a", flexShrink: 0 };

const logRow: React.CSSProperties = { display: "flex", gap: 10 };
const logTime: React.CSSProperties = { fontSize: 7, color: "#6a6a6a", flexShrink: 0 };
const logMsg: React.CSSProperties = {
  fontSize: 7,
  lineHeight: 2,
  wordBreak: "break-word",
};
