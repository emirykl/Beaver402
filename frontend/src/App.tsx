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
  fetchConfig,
  reduceLimits,
  recoverFunds,
  removeMerchant,
  type Limits,
  type PolicyState,
  type PublicConfig,
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
  txTime,
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

/**
 * A passkey only works on the domain it was made for, and the local panel
 * shares its database with the hosted one. So the local panel enrols an
 * owner of its own, which never collides with the hosted owner's passkey.
 */
function ownerId(): string {
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" ? "beaver402-owner-local" : "beaver402-owner";
}

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
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // Recovering the funds and removing the merchant are hard to undo in the
  // middle of an incident, so each takes two presses.
  const [recoveryArmed, setRecoveryArmed] = useState(false);
  const [removalArmed, setRemovalArmed] = useState(false);

  const addLog = useCallback(
    (message: string, type: LogEntry["type"] = "info") => {
      const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
      setLogs((prev) => [{ id: ++logId, time, message, type }, ...prev].slice(0, 8));
    },
    []
  );

  const refresh = useCallback(async () => {
    setConfig(await fetchConfig());
    setPolicyState(await fetchPolicyState());
    setTransactions(await fetchTransactions());
    setMerchantInfo(await fetchMerchantInfo());
  }, []);

  const handleAuth = useCallback(async () => {
    const userId = ownerId();
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

  const deployed = /^C[A-Z2-7]{55}$/.test(policyState.contractId);
  const needsMerchant = deployed && policyState.merchantApproved === false;
  const live = deployed && !policyState.frozen && policyState.agentSigner !== null;
  const explorer = config?.explorer ?? "https://stellar.expert/explorer/testnet";
  // The merchant runs as its own deployment on mainnet, so its key comes from
  // the public config when the merchant's own endpoint is not served here.
  const merchantKey = merchantInfo?.merchantPubkey ?? config?.merchantPubkey ?? null;
  const limits = policyState.limits ?? null;

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
              <span style={topSubLabel}>
                {config?.network === "mainnet" ? "MAINNET ACCOUNT" : "TESTNET ACCOUNT"}
              </span>
              <a
                style={topSubLink}
                href={`${explorer}/contract/${policyState.contractId}`}
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
              {!deployed ? "NO ACCOUNT" : policyState.frozen ? "HALTED" : live ? "ARMED" : "NOT READY"}
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
                  disabled={loading !== null || !merchantKey}
                  onClick={() =>
                    merchantKey &&
                    handleAction("Approve merchant", () => allowMerchant(merchantKey))
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
              {limits && (
                <>
                  <Line
                    label="Spent in window"
                    value={`${formatAmount(policyState.velocityTotalAmount)} of ${formatAmount(limits.maxTotalAmount)} USDC`}
                  />
                  <Line
                    label="Per payment"
                    value={`up to ${formatAmount(limits.maxPaymentAmount)} USDC`}
                  />
                </>
              )}
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
                {policyState.frozen && (
                  <Button
                    label={recoveryArmed ? "CONFIRM: SEND ALL FUNDS TO RECOVERY" : "RECOVER FUNDS"}
                    danger
                    busy={loading === "Recover"}
                    disabled={loading !== null}
                    onClick={() => {
                      if (!recoveryArmed) {
                        setRecoveryArmed(true);
                        addLog("Press again to send the whole balance to the recovery address");
                        return;
                      }
                      setRecoveryArmed(false);
                      handleAction("Recover", recoverFunds);
                    }}
                  />
                )}
                {merchantKey && (
                  <Button
                    label={removalArmed ? "CONFIRM: STOP PAYING THIS MERCHANT" : "REMOVE MERCHANT"}
                    danger
                    busy={loading === "Remove merchant"}
                    disabled={loading !== null}
                    onClick={() => {
                      if (!removalArmed) {
                        setRemovalArmed(true);
                        addLog("Press again to remove the merchant; it can be approved again later");
                        return;
                      }
                      setRemovalArmed(false);
                      handleAction("Remove merchant", () => removeMerchant(merchantKey));
                    }}
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

            {!needsMerchant && limits && (
              <LimitsForm
                current={limits}
                busy={loading === "Lower limits"}
                disabled={loading !== null}
                onSubmit={(next) => handleAction("Lower limits", () => reduceLimits(next))}
              />
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
                    <TxRow key={tx.id} tx={tx} explorer={explorer} />
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

/**
 * Lower one or more limits. The window is left as it is: a shorter one would
 * let payments stop counting sooner, which the contract treats as raising a
 * limit and refuses.
 */
function LimitsForm({
  current,
  busy,
  disabled,
  onSubmit,
}: {
  current: Limits;
  busy: boolean;
  disabled: boolean;
  onSubmit: (next: Limits) => void;
}) {
  const [perPayment, setPerPayment] = useState(formatExact(current.maxPaymentAmount));
  const [count, setCount] = useState(String(current.maxTxCount));
  const [total, setTotal] = useState(formatExact(current.maxTotalAmount));

  const next = {
    maxPaymentAmount: toStroops(perPayment),
    maxTxCount: Number.parseInt(count, 10),
    maxTotalAmount: toStroops(total),
    windowSize: current.windowSize,
  };
  const valid =
    next.maxPaymentAmount !== null &&
    next.maxTotalAmount !== null &&
    Number.isInteger(next.maxTxCount) &&
    next.maxTxCount > 0 &&
    BigInt(next.maxPaymentAmount) > 0n &&
    BigInt(next.maxPaymentAmount) <= BigInt(next.maxTotalAmount);
  const lower =
    valid &&
    BigInt(next.maxPaymentAmount!) <= BigInt(current.maxPaymentAmount) &&
    next.maxTxCount <= current.maxTxCount &&
    BigInt(next.maxTotalAmount!) <= BigInt(current.maxTotalAmount);
  const changed =
    lower &&
    (next.maxPaymentAmount !== current.maxPaymentAmount ||
      next.maxTxCount !== current.maxTxCount ||
      next.maxTotalAmount !== current.maxTotalAmount);

  return (
    <section style={panel}>
      <h2 style={heading}>LIMITS</h2>
      <p style={body}>Limits can only go down. Raising one needs a new account.</p>
      <LimitField label="Per payment, USDC" value={perPayment} onChange={setPerPayment} />
      <LimitField label="Payments per window" value={count} onChange={setCount} />
      <LimitField label="Total per window, USDC" value={total} onChange={setTotal} />
      {!lower && valid && <p style={{ ...body, color: red }}>That would raise a limit.</p>}
      <Button
        label="LOWER LIMITS"
        busy={busy}
        disabled={disabled || !changed}
        onClick={() =>
          changed &&
          onSubmit({
            maxPaymentAmount: next.maxPaymentAmount!,
            maxTxCount: next.maxTxCount,
            maxTotalAmount: next.maxTotalAmount!,
            windowSize: next.windowSize,
          })
        }
      />
    </section>
  );
}

function LimitField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label style={lineRow}>
      <span style={lineLabel}>{label}</span>
      <input
        value={value}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        style={{
          ...lineValue,
          width: "6.5em",
          textAlign: "right",
          background: "transparent",
          border: `1px solid ${edge}`,
          color: text,
          padding: "2px 6px",
          font: "inherit",
        }}
      />
    </label>
  );
}

function TxRow({ tx, explorer }: { tx: Transaction; explorer: string }) {
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
          href={`${explorer}/tx/${tx.tx_hash}`}
          target="_blank"
          rel="noreferrer"
        >
          {tx.tx_hash.slice(0, 24)}
        </a>
      ) : (
        <span style={txWhy}>{tx.error}</span>
      )}
      <span style={txTime}>{formatUtc(tx.created_at)}</span>
    </div>
  );
}

/* ---- Helpers ---- */

/** Stroops as USDC with every significant decimal, for editing. */
function formatExact(raw: string): string {
  const value = BigInt(raw);
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** A USDC amount someone typed, in stroops, or null if it is not one. */
function toStroops(value: string): string | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d{0,7}))?$/);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  return (BigInt(whole!) * 10_000_000n + BigInt(fraction.padEnd(7, "0") || "0")).toString();
}

/** Stroops carry seven decimals, which is not a number anyone reads. */
function formatAmount(raw: string | null): string {
  if (!raw) return "0.00";
  try {
    return (Number(BigInt(raw)) / 10_000_000).toFixed(2);
  } catch {
    return raw;
  }
}

/**
 * When this happened, in UTC.
 *
 * Payments are evidence, and evidence read in someone else's timezone is
 * evidence nobody can line up against an explorer. The zone is named rather
 * than assumed.
 */
function formatUtc(raw: string): string {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "";

  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function toneColor(type: LogEntry["type"]): string {
  if (type === "success") return green;
  if (type === "error") return red;
  return dim;
}
