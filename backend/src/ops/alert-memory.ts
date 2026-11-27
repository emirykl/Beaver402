import type { Alert, AlertKind, AlertStore, OpenAlert } from "./alerts.js";

/** Open incidents kept in memory. For tests and the alert rehearsal. */
export function memoryAlertStore(): AlertStore & { all(): (OpenAlert & { resolved: boolean; emailed: boolean })[] } {
  const rows = new Map<string, OpenAlert & { resolved: boolean; emailed: boolean }>();
  return {
    async find(key) {
      const row = rows.get(key);
      return row && !row.resolved ? row : null;
    },
    async open(alert: Alert) {
      rows.set(alert.key, { ...alert, openedAt: new Date().toISOString(), repeats: 0, resolved: false, emailed: false });
    },
    async seenAgain(key) {
      const row = rows.get(key);
      if (row) row.repeats++;
    },
    async markEmailed(key) {
      const row = rows.get(key);
      if (row) row.emailed = true;
    },
    async resolve(kind: AlertKind, network: string) {
      const closed = [...rows.values()].filter((r) => r.kind === kind && r.network === network && !r.resolved);
      closed.forEach((r) => (r.resolved = true));
      return closed;
    },
    all: () => [...rows.values()],
  };
}
