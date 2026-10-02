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

/** Log the detail, answer with a fixed summary. */
export function failPublicly(res: Response, status: number, summary: string, err: unknown): void {
  console.error(summary, err);
  res.status(status).json({ error: summary });
}
