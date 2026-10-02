/**
 * Count a page view or an outbound click, without cookies and without
 * anything that identifies the visitor. The backend keeps a daily total per
 * page and per link, and refuses anything it does not know.
 */
export type Page = "/" | "/status" | "/panel";

export type Link =
  | "demo"
  | "repository"
  | "contract"
  | "deployment-record"
  | "evidence"
  | "encoding"
  | "threat-model"
  | "x402"
  | "limitations"
  | "status"
  | "panel"
  | "transaction";

function send(body: Record<string, string>): void {
  try {
    const payload = JSON.stringify(body);
    // A beacon survives the page being left, which is exactly when an
    // outbound click is counted.
    if (!navigator.sendBeacon?.("/api/metrics", new Blob([payload], { type: "application/json" }))) {
      void fetch("/api/metrics", { method: "POST", headers: { "content-type": "application/json" }, body: payload, keepalive: true });
    }
  } catch {
    // Counting is never allowed to break the page.
  }
}

export function trackView(path: Page): void {
  send({ path, kind: "view" });
}

export function trackClick(path: Page, target: Link): void {
  send({ path, kind: "click", target });
}
