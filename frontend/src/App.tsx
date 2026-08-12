import React, { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
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

const ease = [0.25, 0.1, 0.25, 1] as [number, number, number, number];
const stagger = { staggerChildren: 0.08 };

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
  const [authMode, setAuthMode] = useState<"idle" | "registering" | "authenticating">("idle");
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
      setLogs((prev) =>
        [{ id: ++logId, time, message, type }, ...prev].slice(0, 30)
      );
    },
    []
  );

  const refresh = useCallback(async () => {
    const state = await fetchPolicyState();
    setPolicyState(state);
    const txs = await fetchTransactions();
    setTransactions(txs);
    setMerchantInfo(await fetchMerchantInfo());
  }, []);

  const handleAuth = useCallback(async () => {
    const userId = "beaver402-owner";
    setAuthMode("authenticating");
    addLog("Authenticating with passkey...");

    try {
      // try authentication first (user already registered)
      const authOk = await authenticatePasskey(userId);
      if (authOk) {
        // notify backend of successful auth session
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        setAuthenticated(true);
        addLog("Passkey authenticated", "success");
        refresh();
        setAuthMode("idle");
        return;
      }
    } catch {
      // authentication failed, try registration
    }

    setAuthMode("registering");
    addLog("No passkey found, registering new one...");
    try {
      const regOk = await registerPasskey(userId);
      if (regOk) {
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "default" }),
        });
        setAuthenticated(true);
        addLog("Passkey registered and authenticated", "success");
        refresh();
      } else {
        addLog("Passkey registration failed", "error");
      }
    } catch (err) {
      addLog("Passkey error: check browser support", "error");
    }
    setAuthMode("idle");
  }, [addLog, refresh]);

  // load policy state on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAction = useCallback(
    async (
      action: string,
      fn: () => Promise<{
        success: boolean;
        txHash?: string;
        error?: string;
      }>
    ) => {
      if (!authenticated) {
        addLog("Authentication required", "error");
        return;
      }
      setLoading(action);
      addLog(`Submitting ${action}...`);
      try {
        const result = await fn();
        if (result.success) {
          addLog(
            `${capitalize(action)} confirmed${result.txHash ? ` ${result.txHash.slice(0, 12)}...` : ""}`,
            "success"
          );
          await refresh();
        } else {
          addLog(`${capitalize(action)} failed: ${result.error}`, "error");
        }
      } catch (err) {
        addLog(`${capitalize(action)} error`, "error");
      }
      setLoading(null);
    },
    [authenticated, addLog, refresh]
  );

  const stepsDone =
    (authenticated ? 1 : 0) + (policyState.merchantApproved ? 1 : 0);
  const setupDone = stepsDone === 2;

  return (
    <div style={page}>
      <motion.div
        style={container}
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: stagger,
        }}
      >
        {/* Header */}
        <motion.header
          style={header}
          variants={{
            hidden: { opacity: 0, y: -8 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease } },
          }}
        >
          <img src="/beaver402-logo.png" alt="" style={logo} />
          <h1 style={title}>Beaver402</h1>
          <p style={subtitle}>Your agent can only pay for what you approved</p>
        </motion.header>

        {/* Getting started */}
        {!setupDone && (
          <Card delay={0}>
            <div style={sectionHeader}>
              <span style={sectionTitle}>Getting started</span>
              <span style={countBadge}>
                {stepsDone} of 2
              </span>
            </div>
            <p style={bodyText}>
              Two things once, and the account is ready to protect payments.
            </p>
            <div style={actionList}>
              <StepRow
                number={1}
                label="Sign in with your passkey"
                desc="Touch ID proves you own this account. Nothing leaves your device."
                done={authenticated}
                busy={authMode !== "idle"}
                onClick={handleAuth}
              />
              <StepRow
                number={2}
                label="Approve the demo merchant"
                desc={
                  policyState.merchantApproved
                    ? "Approved. This merchant may now ask to be paid."
                    : "Until you approve one, every payment is refused."
                }
                done={policyState.merchantApproved}
                waiting={!authenticated}
                busy={loading === "approve"}
                onClick={() =>
                  merchantInfo &&
                  handleAction("approve", () =>
                    allowMerchant(merchantInfo.merchantPubkey)
                  )
                }
                last
              />
            </div>
          </Card>
        )}

        {/* Status */}
        <Card delay={1}>
          <div style={sectionHeader}>
            <div style={dot(policyState.frozen ? "#ff3b30" : "#34c759")} />
            <span style={sectionTitle}>Status</span>
            <motion.span
              style={{
                ...badge,
                background: policyState.frozen
                  ? "rgba(255,59,48,0.1)"
                  : "rgba(52,199,89,0.1)",
                color: policyState.frozen ? "#ff3b30" : "#34c759",
              }}
              layout
              transition={{ duration: 0.3, ease }}
            >
              {policyState.frozen ? "Payments stopped" : "Payments active"}
            </motion.span>
          </div>

          <p style={bodyText}>
            {policyState.frozen
              ? "Nothing can be paid until you resume. The account stopped either because you asked it to, or because it hit its daily limit."
              : policyState.agentSigner
                ? "The agent can pay approved merchants, up to the daily limit."
                : "The agent has no signing authority left, so nothing can be paid."}
          </p>

          <div style={infoList}>
            <Row
              label="Agent"
              value={policyState.agentSigner ? "Can pay" : "Revoked"}
              muted={!policyState.agentSigner}
            />
            <Row
              label="Used today"
              value={
                policyState.velocityMaxTxCount > 0
                  ? `${policyState.velocityTxCount} of ${policyState.velocityMaxTxCount} payments`
                  : `${policyState.velocityTxCount} payments`
              }
            />
            <Row label="Account" value={trunc(policyState.contractId, 18)} last />
          </div>
        </Card>

        {/* Controls */}
        {setupDone && (
          <Card delay={2}>
            <div style={sectionHeader}>
              <span style={sectionTitle}>Controls</span>
            </div>
            <p style={bodyText}>
              Each of these asks for Touch ID, because only you can authorize
              them.
            </p>
            <div style={actionList}>
              {policyState.frozen ? (
                <ActionRow
                  label="Resume payments"
                  desc="Let the agent pay again, and clear the daily counter"
                  loading={loading === "resume"}
                  onClick={() => handleAction("resume", restorePayments)}
                />
              ) : (
                <ActionRow
                  label="Stop all payments"
                  desc="Refuse every payment from now on, until you resume"
                  destructive
                  loading={loading === "stop"}
                  onClick={() => handleAction("stop", freezePayments)}
                />
              )}
              {policyState.agentSigner && (
                <ActionRow
                  label="Revoke the agent"
                  desc="Take away its signing key for good. This cannot be undone."
                  destructive
                  loading={loading === "revoke"}
                  onClick={() => handleAction("revoke", revokeAgentSigner)}
                  last
                />
              )}
            </div>
          </Card>
        )}

        {/* Transactions */}
        <Card delay={3}>
          <div style={sectionHeader}>
            <span style={sectionTitle}>Transaction History</span>
            <span style={countBadge}>{transactions.length}</span>
          </div>
          <div style={logBox}>
            {transactions.length === 0 ? (
              <p style={bodyTextMuted}>No transactions recorded</p>
            ) : (
              transactions.map((tx) => (
                <div key={tx.id} style={txRow}>
                  <div style={txTop}>
                    <span
                      style={{
                        ...txStatus,
                        color: tx.status === "success" ? "#34c759" : "#ff3b30",
                      }}
                    >
                      {tx.status === "success" ? "Confirmed" : "Failed"}
                    </span>
                    <span style={txAmount}>
                      {tx.amount ?? "0"} {tx.asset ?? ""}
                    </span>
                  </div>
                  <div style={txBottom}>
                    {tx.tx_hash ? (
                      <span style={txHash}>{trunc(tx.tx_hash, 20)}</span>
                    ) : tx.error ? (
                      <span style={txError}>{trunc(tx.error, 40)}</span>
                    ) : null}
                    <span style={txTime}>
                      {new Date(tx.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Log */}
        <Card delay={4}>
          <div style={sectionHeader}>
            <span style={sectionTitle}>Activity</span>
            <span style={countBadge}>{logs.length}</span>
          </div>
          <div style={logBox}>
            <AnimatePresence initial={false}>
              {logs.length === 0 ? (
                <motion.p
                  key="empty"
                  style={bodyTextMuted}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.4 }}
                >
                  No activity yet
                </motion.p>
              ) : (
                logs.map((entry) => (
                  <motion.div
                    key={entry.id}
                    style={logRow}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease }}
                  >
                    <span style={logTime}>{entry.time}</span>
                    <span
                      style={{
                        ...logMsg,
                        color:
                          entry.type === "success"
                            ? "#34c759"
                            : entry.type === "error"
                              ? "#ff3b30"
                              : "#8e8e93",
                      }}
                    >
                      {entry.message}
                    </span>
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}

/* ---- Sub Components ---- */

function Card({
  children,
  delay,
}: {
  children: React.ReactNode;
  delay: number;
}) {
  return (
    <motion.div
      style={card}
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.45, ease, delay: delay * 0.08 },
        },
      }}
    >
      {children}
    </motion.div>
  );
}

function Row({
  label,
  value,
  last,
  muted,
}: {
  label: string;
  value: string;
  last?: boolean;
  muted?: boolean;
}) {
  return (
    <div style={{ ...infoRow, ...(last ? { border: "none" } : {}) }}>
      <span style={infoLabel}>{label}</span>
      <span style={{ ...infoValue, ...(muted ? { color: "#636366" } : {}) }}>
        {value}
      </span>
    </div>
  );
}

function StepRow({
  number,
  label,
  desc,
  done,
  waiting,
  busy,
  onClick,
  last,
}: {
  number: number;
  label: string;
  desc: string;
  done: boolean;
  waiting?: boolean;
  busy?: boolean;
  onClick: () => void;
  last?: boolean;
}) {
  const blocked = done || waiting || busy;

  return (
    <motion.div
      style={{
        ...actionRow,
        ...(last ? { border: "none" } : {}),
        opacity: waiting ? 0.4 : busy ? 0.6 : 1,
        cursor: blocked ? "default" : "pointer",
      }}
      whileHover={blocked ? {} : { backgroundColor: "rgba(255,255,255,0.03)" }}
      whileTap={blocked ? {} : { scale: 0.995 }}
      onClick={blocked ? undefined : onClick}
    >
      <div style={stepBody}>
        <div style={done ? stepMarkDone : stepMark}>
          {done ? (
            <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
              <path
                d="M1 4.5L4 7.5L10 1.5"
                stroke="#000"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            number
          )}
        </div>
        <div>
          <div style={actionLabel}>{label}</div>
          <div style={actionDesc}>{desc}</div>
        </div>
      </div>
      {!done && !waiting && (
        <span style={chevron}>
          {busy ? (
            <motion.span
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }}
              style={{ display: "inline-block" }}
            >
              &bull;
            </motion.span>
          ) : (
            <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
              <path
                d="M1 1l5 5-5 5"
                stroke="#3a3a3c"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      )}
    </motion.div>
  );
}

function ActionRow({
  label,
  desc,
  destructive,
  loading: isLoading,
  onClick,
  last,
}: {
  label: string;
  desc: string;
  destructive?: boolean;
  loading: boolean;
  onClick: () => void;
  last?: boolean;
}) {
  return (
    <motion.div
      style={{
        ...actionRow,
        ...(last ? { border: "none" } : {}),
        opacity: isLoading ? 0.5 : 1,
      }}
      whileHover={{ backgroundColor: "rgba(255,255,255,0.03)" }}
      whileTap={{ scale: 0.995 }}
      onClick={isLoading ? undefined : onClick}
    >
      <div>
        <div
          style={{
            ...actionLabel,
            color: destructive ? "#ff3b30" : "#f5f5f7",
          }}
        >
          {label}
        </div>
        <div style={actionDesc}>{desc}</div>
      </div>
      <span style={chevron}>
        {isLoading ? (
          <motion.span
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }}
            style={{ display: "inline-block" }}
          >
            &bull;
          </motion.span>
        ) : (
          <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
            <path
              d="M1 1l5 5-5 5"
              stroke="#3a3a3c"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
    </motion.div>
  );
}

/* ---- Helpers ---- */

function trunc(s: string, n = 16): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---- Styles ---- */

const ff =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const mono =
  "'SF Mono', SFMono-Regular, ui-monospace, Menlo, Monaco, monospace";

const logo: React.CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 14,
  objectFit: "cover",
  marginBottom: 14,
};

const stepBody: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
};

const stepMark: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 11,
  border: "1px solid #3a3a3c",
  color: "#8e8e93",
  fontSize: 12,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  marginTop: 1,
};

const stepMarkDone: React.CSSProperties = {
  ...stepMark,
  border: "none",
  background: "#34c759",
};

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#000000",
  color: "#f5f5f7",
  fontFamily: ff,
  WebkitFontSmoothing: "antialiased",
  MozOsxFontSmoothing: "grayscale",
};

const container: React.CSSProperties = {
  maxWidth: 520,
  margin: "0 auto",
  padding: "60px 20px 80px",
};

const header: React.CSSProperties = {
  marginBottom: 40,
};

const title: React.CSSProperties = {
  fontSize: 34,
  fontWeight: 700,
  letterSpacing: "-0.022em",
  lineHeight: 1.1,
  color: "#f5f5f7",
  margin: 0,
};

const subtitle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 400,
  color: "#86868b",
  marginTop: 4,
};

const card: React.CSSProperties = {
  background: "#1c1c1e",
  borderRadius: 12,
  padding: "16px 20px",
  marginBottom: 12,
};

const sectionHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 12,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#86868b",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  flex: 1,
};

const dot = (color: string): React.CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: color,
  flexShrink: 0,
});

const badge: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "3px 8px",
  borderRadius: 6,
  letterSpacing: "0.01em",
};

const countBadge: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: "#636366",
  background: "#2c2c2e",
  padding: "2px 7px",
  borderRadius: 6,
};

const bodyText: React.CSSProperties = {
  fontSize: 15,
  color: "#f5f5f7",
  lineHeight: 1.47,
  marginBottom: 16,
};

const bodyTextMuted: React.CSSProperties = {
  fontSize: 15,
  color: "#636366",
  lineHeight: 1.47,
};

const btnPrimary: React.CSSProperties = {
  width: "100%",
  padding: "12px 20px",
  borderRadius: 10,
  border: "none",
  background: "#0a84ff",
  color: "#fff",
  fontSize: 15,
  fontWeight: 600,
  fontFamily: ff,
  cursor: "pointer",
  letterSpacing: "-0.01em",
};

const infoList: React.CSSProperties = {};

const infoRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 0",
  borderBottom: "0.5px solid #2c2c2e",
};

const infoLabel: React.CSSProperties = {
  fontSize: 15,
  color: "#f5f5f7",
  fontWeight: 400,
};

const infoValue: React.CSSProperties = {
  fontSize: 15,
  color: "#86868b",
  fontFamily: mono,
  fontWeight: 400,
};

const actionList: React.CSSProperties = {};

const actionRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 0",
  borderBottom: "0.5px solid #2c2c2e",
  cursor: "pointer",
  borderRadius: 0,
  transition: "background 0.15s",
};

const actionLabel: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 400,
  marginBottom: 2,
};

const actionDesc: React.CSSProperties = {
  fontSize: 13,
  color: "#636366",
  fontWeight: 400,
};

const chevron: React.CSSProperties = {
  flexShrink: 0,
  marginLeft: 8,
  display: "flex",
  alignItems: "center",
};

const logBox: React.CSSProperties = {
  maxHeight: 180,
  overflowY: "auto",
};

const logRow: React.CSSProperties = {
  display: "flex",
  gap: 10,
  padding: "5px 0",
  fontSize: 12,
  fontFamily: mono,
};

const logTime: React.CSSProperties = {
  color: "#3a3a3c",
  flexShrink: 0,
};

const logMsg: React.CSSProperties = {
  wordBreak: "break-all",
};

const txRow: React.CSSProperties = {
  padding: "10px 0",
  borderBottom: "0.5px solid #2c2c2e",
};

const txTop: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 4,
};

const txBottom: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const txStatus: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
};

const txAmount: React.CSSProperties = {
  fontSize: 13,
  fontFamily: mono,
  color: "#f5f5f7",
};

const txHash: React.CSSProperties = {
  fontSize: 11,
  fontFamily: mono,
  color: "#636366",
};

const txError: React.CSSProperties = {
  fontSize: 11,
  color: "#ff3b30",
};

const txTime: React.CSSProperties = {
  fontSize: 11,
  color: "#3a3a3c",
};
