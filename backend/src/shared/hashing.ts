import { createHash } from "crypto";
import type { ChallengeFields, IntentFields } from "./types.js";

export const CHALLENGE_DOMAIN = "beaver402:challenge:v1";
export const INTENT_DOMAIN = "beaver402:intent:v1";

export function normalizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

export function normalizeAmount(amount: string | number): string {
  return BigInt(amount).toString();
}

export function hashBody(body: string | Buffer | null | undefined): string {
  if (!body || (typeof body === "string" && body.length === 0)) {
    return createHash("sha256").update("").digest("hex");
  }
  const data = typeof body === "string" ? Buffer.from(body) : body;
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalEncode(fields: ChallengeFields | IntentFields): Buffer {
  const parts: string[] = [
    fields.version,
    fields.domainSeparator,
    fields.merchantPubkey,
    fields.httpMethod.toUpperCase(),
    normalizeEndpoint(fields.normalizedEndpoint),
    fields.bodyHash,
    fields.recipient,
    fields.asset,
    normalizeAmount(fields.amount),
    fields.network,
    fields.nonce,
    fields.expiry,
  ];

  return Buffer.from(parts.join("|"), "utf-8");
}

export function domainSeparatedHash(
  domain: string,
  data: Buffer
): Buffer {
  const domainBytes = Buffer.from(domain, "utf-8");
  const domainLen = Buffer.alloc(1);
  domainLen.writeUInt8(domainBytes.length);

  const preimage = Buffer.concat([domainLen, domainBytes, data]);
  return createHash("sha256").update(preimage).digest();
}

export function hashChallenge(fields: ChallengeFields): Buffer {
  const encoded = canonicalEncode(fields);
  return domainSeparatedHash(CHALLENGE_DOMAIN, encoded);
}

export function hashIntent(fields: IntentFields): Buffer {
  const encoded = canonicalEncode(fields);
  return domainSeparatedHash(INTENT_DOMAIN, encoded);
}

export function fieldsMatch(
  challenge: ChallengeFields,
  intent: IntentFields
): boolean {
  return (
    challenge.version === intent.version &&
    challenge.merchantPubkey === intent.merchantPubkey &&
    challenge.httpMethod.toUpperCase() === intent.httpMethod.toUpperCase() &&
    normalizeEndpoint(challenge.normalizedEndpoint) ===
      normalizeEndpoint(intent.normalizedEndpoint) &&
    challenge.bodyHash === intent.bodyHash &&
    challenge.recipient === intent.recipient &&
    challenge.asset === intent.asset &&
    normalizeAmount(challenge.amount) === normalizeAmount(intent.amount) &&
    challenge.network === intent.network &&
    challenge.nonce === intent.nonce &&
    challenge.expiry === intent.expiry
  );
}
