import type { Response } from "express";

/**
 * What an error may say to whoever asked.
 *
 * Errors from the RPC provider, the database or the facilitator can carry
 * an endpoint URL with a key in it, a connection string, or a fragment of a
 * secret. None of that may reach a response or anything the public status
 * page shows. The detail goes to the server log; the caller gets a summary.
 */

const SECRET_PATTERNS: RegExp[] = [
  // Any URL. Provider endpoints often carry their API key in the path or
  // the query, so the whole URL goes rather than just a query string.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi,
  // Stellar secret keys.
  /\bS[A-Z2-7]{55}\b/g,
  // Supabase secret and service keys.
  /\bsb_secret_[A-Za-z0-9_-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/** The same text with anything that could be a credential taken out. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, "[redacted]"), text);
}

/**
 * An error as it may appear in a server log.
 *
 * Hosted logs are readable by anyone with access to the project, and they
 * outlive the request, so the same redaction applies there. The stack stays
 * because it is the useful part and holds file paths, not credentials.
 */
export function forLog(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause === undefined ? "" : `\ncaused by: ${forLog(err.cause)}`;
    return redact(err.stack ?? `${err.name}: ${err.message}`) + cause;
  }
  if (typeof err === "object" && err !== null) {
    try {
      return redact(JSON.stringify(err));
    } catch {
      return "[unprintable error]";
    }
  }
  return redact(String(err));
}

/** Log the detail, answer with a fixed summary. */
export function failPublicly(res: Response, status: number, summary: string, err: unknown): void {
  console.error(summary, forLog(err));
  res.status(status).json({ error: summary });
}
