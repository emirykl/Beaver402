import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  fetchPolicyState,
  freezePayments,
  restorePayments,
  revokeAgentSigner,
  type PolicyState,
} from "./stellar-ops.js";

const spring = { type: "spring", stiffness: 300, damping: 30 };
const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
};

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
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<string | null>(null);

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [{ id: ++logId, time, message, type }, ...prev].slice(0, 50));
  }, []);

  const refresh = useCallback(async () => {
    const state = await fetchPolicyState();
    setPolicyState(state);
  }, []);

  const handleAuth = useCallback(() => {
    setAuthenticated(true);
    addLog("authenticated with passkey", "success");
    refresh();
  }, [addLog, refresh]);

  const handleAction = useCallback(
    async (action: string, fn: () => Promise<{ success: boolean; txHash?: string; error?: string }>) => {
      if (!authenticated) {
        addLog("please sign in first", "error");
        return;
      }
      setLoading(action);
      addLog(`submitting ${action} transaction...`);
      try {
        const result = await fn();
        if (result.success) {
          addLog(`${action} completed${result.txHash ? `, tx: ${result.txHash}` : ""}`, "success");
          await refresh();
        } else {
          addLog(`${action} failed: ${result.error}`, "error");
        }
      } catch (err) {
        addLog(`${action} error: ${err}`, "error");
      }
      setLoading(null);
    },
    [authenticated, addLog, refresh]
  );

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <h1 style={styles.title}>Beaver402</h1>
          <p style={styles.subtitle}>Payment policy control panel</p>
        </motion.div>

        {/* Auth Card */}
        <motion.div style={styles.card} {...fadeUp} transition={{ delay: 0.1, ...spring }}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            <span style={styles.cardTitle}>Authentication</span>
            <AnimatePresence>
              {authenticated && (
                <motion.span
                  style={{ ...styles.badge, ...styles.badgeSuccess }}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={spring}
                >
                  connected
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          {!authenticated ? (
            <motion.div style={styles.authButtons}>
              <motion.button
                style={{ ...styles.btn, ...styles.btnPrimary }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleAuth}
              >
                Sign in with Passkey
              </motion.button>
            </motion.div>
          ) : (
            <p style={styles.mutedText}>passkey authenticated, you can manage the policy below</p>
          )}
        </motion.div>

        {/* Status Card */}
        <motion.div style={styles.card} {...fadeUp} transition={{ delay: 0.2, ...spring }}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </span>
            <span style={styles.cardTitle}>Policy Status</span>
            <motion.span
              style={{
                ...styles.badge,
                ...(policyState.frozen ? styles.badgeDanger : styles.badgeSuccess),
              }}
              layout
              transition={spring}
            >
              {policyState.frozen ? "frozen" : "active"}
            </motion.span>
          </div>

          <div style={styles.infoGrid}>
            <InfoRow label="Contract" value={truncate(policyState.contractId, 20)} />
            <InfoRow label="Agent Signer" value={policyState.agentSigner ? truncate(policyState.agentSigner, 20) : "revoked"} />
            <InfoRow label="TX Count" value={String(policyState.velocityTxCount)} />
            <InfoRow label="Total Volume" value={`${policyState.velocityTotalAmount} stroops`} />
          </div>
        </motion.div>

        {/* Actions Card */}
        <motion.div style={styles.card} {...fadeUp} transition={{ delay: 0.3, ...spring }}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </span>
            <span style={styles.cardTitle}>Owner Actions</span>
          </div>

          <div style={styles.actionGrid}>
            <ActionButton
              label="Freeze Payments"
              variant="danger"
              loading={loading === "freeze"}
              onClick={() => handleAction("freeze", freezePayments)}
            />
            <ActionButton
              label="Restore Payments"
              variant="success"
              loading={loading === "restore"}
              onClick={() => handleAction("restore", restorePayments)}
            />
            <ActionButton
              label="Revoke Agent Signer"
              variant="danger"
              loading={loading === "revoke"}
              onClick={() => handleAction("revoke", revokeAgentSigner)}
            />
          </div>
        </motion.div>

        {/* Activity Log */}
        <motion.div style={styles.card} {...fadeUp} transition={{ delay: 0.4, ...spring }}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </span>
            <span style={styles.cardTitle}>Activity</span>
          </div>

          <div style={styles.logContainer}>
            <AnimatePresence mode="popLayout">
              {logs.length === 0 ? (
                <motion.p key="empty" style={styles.mutedText} {...fadeUp}>
                  waiting for events...
                </motion.p>
              ) : (
                logs.map((entry) => (
                  <motion.div
                    key={entry.id}
                    style={{
                      ...styles.logEntry,
                      color:
                        entry.type === "success"
                          ? "#34d399"
                          : entry.type === "error"
                          ? "#f87171"
                          : "#94a3b8",
                    }}
                    initial={{ opacity: 0, x: -20, height: 0 }}
                    animate={{ opacity: 1, x: 0, height: "auto" }}
                    exit={{ opacity: 0, x: 20, height: 0 }}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  >
                    <span style={styles.logTime}>{entry.time}</span>
                    <span>{entry.message}</span>
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.infoRow}>
      <span style={styles.infoLabel}>{label}</span>
      <span style={styles.infoValue}>{value}</span>
    </div>
  );
}

function ActionButton({
  label,
  variant,
  loading,
  onClick,
}: {
  label: string;
  variant: "danger" | "success";
  loading: boolean;
  onClick: () => void;
}) {
  const variantStyles =
    variant === "danger"
      ? { borderColor: "#ef4444", color: "#ef4444" }
      : { borderColor: "#22c55e", color: "#22c55e" };

  return (
    <motion.button
      style={{ ...styles.btn, ...styles.btnOutline, ...variantStyles, opacity: loading ? 0.6 : 1 }}
      whileHover={{ scale: 1.03, backgroundColor: variant === "danger" ? "rgba(239,68,68,0.08)" : "rgba(34,197,94,0.08)" }}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      disabled={loading}
    >
      {loading ? "submitting..." : label}
    </motion.button>
  );
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + "...";
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #000000 0%, #0a0a0f 50%, #111118 100%)",
    color: "#f0f0f5",
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    padding: "3rem 1.5rem",
  },
  container: {
    maxWidth: "640px",
    margin: "0 auto",
  },
  title: {
    fontSize: "2rem",
    fontWeight: 700,
    letterSpacing: "-0.03em",
    marginBottom: "0.25rem",
    background: "linear-gradient(135deg, #e0e7ff, #818cf8)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  subtitle: {
    fontSize: "0.9rem",
    color: "#64748b",
    marginBottom: "2.5rem",
    fontWeight: 400,
  },
  card: {
    background: "rgba(255,255,255,0.03)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: "16px",
    padding: "1.5rem",
    marginBottom: "1rem",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginBottom: "1rem",
  },
  cardIcon: {
    color: "#818cf8",
    display: "flex",
    alignItems: "center",
  },
  cardTitle: {
    fontSize: "0.95rem",
    fontWeight: 600,
    flex: 1,
  },
  badge: {
    display: "inline-block",
    padding: "0.2rem 0.6rem",
    borderRadius: "999px",
    fontSize: "0.7rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  badgeSuccess: {
    background: "rgba(34,197,94,0.12)",
    color: "#34d399",
  },
  badgeDanger: {
    background: "rgba(239,68,68,0.12)",
    color: "#f87171",
  },
  infoGrid: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0",
  },
  infoRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.6rem 0",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    fontSize: "0.85rem",
  },
  infoLabel: {
    color: "#64748b",
    fontWeight: 500,
  },
  infoValue: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  actionGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "0.5rem",
  },
  btn: {
    padding: "0.65rem 1rem",
    borderRadius: "10px",
    fontSize: "0.85rem",
    fontWeight: 500,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
    border: "none",
    transition: "all 0.2s ease",
  },
  btnPrimary: {
    background: "linear-gradient(135deg, #6366f1, #818cf8)",
    color: "white",
    width: "100%",
  },
  btnOutline: {
    background: "transparent",
    border: "1px solid",
  },
  authButtons: {
    display: "flex",
    gap: "0.5rem",
  },
  mutedText: {
    color: "#475569",
    fontSize: "0.85rem",
  },
  logContainer: {
    maxHeight: "200px",
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.25rem",
  },
  logEntry: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: "0.75rem",
    padding: "0.3rem 0",
    display: "flex",
    gap: "0.5rem",
    overflow: "hidden",
  },
  logTime: {
    opacity: 0.5,
    flexShrink: 0,
  },
};
