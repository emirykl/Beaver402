import type { CSSProperties } from "react";

/**
 * How the console looks.
 *
 * Kept apart from what it does, so reading the panel logic does not mean
 * scrolling past three hundred lines of padding and colour.
 */

export const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const amber = "#e0a94a";
export const green = "#93c06a";
export const red = "#d4674f";
export const text = "#ece0cf";
export const dim = "#9c8a75";
export const edge = "#3b2f24";

export const page: CSSProperties = {
  minHeight: "100vh",
  background: "#15100b",
  color: text,
  fontFamily: mono,
  fontSize: 16,
  lineHeight: 1.7,
  padding: 32,
};

export const shell: CSSProperties = {
  position: "relative",
  zIndex: 1,
  maxWidth: 1200,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 26,
};

export const panel: CSSProperties = {
  background: "#1d1610",
  border: `1px solid ${edge}`,
  padding: 32,
  display: "flex",
  flexDirection: "column",
  gap: 22,
};

export const heading: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 4,
  color: dim,
};

export const body: CSSProperties = {
  fontSize: 15,
  color: dim,
  lineHeight: 1.8,
};

/* Gate */

export const gateLayout: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

export const gateBox: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "min(540px, 100%)",
  alignItems: "center",
  textAlign: "center",
  padding: "56px 48px",
  gap: 26,
};

export const gateLogo: CSSProperties = { width: 104, height: 104 };

export const gateTitle: CSSProperties = {
  fontSize: 34,
  fontWeight: 700,
  letterSpacing: 9,
  color: text,
};

export const gateText: CSSProperties = {
  fontSize: 17,
  color: dim,
  lineHeight: 1.8,
};

export const gateNote: CSSProperties = { fontSize: 14, color: dim };

export const gateError: CSSProperties = {
  fontSize: 14,
  color: red,
  lineHeight: 1.7,
};

/* Top bar */

export const topBar: CSSProperties = {
  flexDirection: "row",
  alignItems: "center",
  gap: 22,
  padding: "24px 32px",
};

export const topLogo: CSSProperties = { width: 52, height: 52 };

export const topTitle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: 6,
  color: text,
};

export const topSub: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 12,
  marginTop: 8,
  minWidth: 0,
};

export const topSubLabel: CSSProperties = {
  fontSize: 11,
  letterSpacing: 2,
  color: dim,
  flexShrink: 0,
};

export const topSubLink: CSSProperties = {
  fontSize: 13,
  color: "#8fb4d8",
  textDecoration: "none",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const indicator: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  border: `1px solid ${edge}`,
  padding: "12px 18px",
  flexShrink: 0,
};

export const lamp: CSSProperties = { width: 10, height: 10, borderRadius: 5 };

export const indicatorText: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 3,
};

/* Layout */

export const columns: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))",
  gap: 26,
  alignItems: "start",
};

export const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 26,
  minWidth: 0,
};

/* Readouts */

export const lineRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 16,
};

export const lineLabel: CSSProperties = { fontSize: 16, color: dim };

export const lineValue: CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  letterSpacing: 1,
};

export const meterTrack: CSSProperties = {
  display: "flex",
  gap: 4,
  marginTop: 14,
};

export const meterSegment: CSSProperties = { flex: 1, height: 12 };

/* Command */

export const button: CSSProperties = {
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

export const scroller: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  maxHeight: 420,
  overflowY: "auto",
};

export const txRow: CSSProperties = {
  background: "rgba(255,255,255,0.02)",
  borderLeft: "3px solid",
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

export const txHead: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 16,
};

export const txState: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 2,
};

export const txAmount: CSSProperties = { fontSize: 16, color: text };

export const txLink: CSSProperties = {
  fontSize: 14,
  color: "#8fb4d8",
  textDecoration: "none",
  wordBreak: "break-all",
};

/**
 * Why a payment was refused, shown whole.
 *
 * The reason wraps onto as many lines as it needs. Cutting it was hiding the
 * end of the sentence, which is the part that says what to do about it.
 */
export const txWhy: CSSProperties = {
  fontSize: 14,
  color: "#c98b80",
  lineHeight: 1.7,
  overflowWrap: "anywhere",
};

/** When a payment happened, tucked under it rather than competing with it. */
export const txTime: CSSProperties = {
  alignSelf: "flex-end",
  fontSize: 12,
  color: dim,
  opacity: 0.75,
  letterSpacing: 0.4,
};

export const logList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

export const logRow: CSSProperties = { display: "flex", gap: 16 };

export const logTime: CSSProperties = { fontSize: 14, color: "#6b5a48", flexShrink: 0 };

export const logMsg: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  wordBreak: "break-word",
};
