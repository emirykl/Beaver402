import { hashBody } from "../shared/hashing.js";

export interface MCPToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ExtractedRequestInfo {
  httpMethod: string;
  endpoint: string;
  bodyHash: string;
  rawBody?: string;
}

export function extractRequestFromToolCall(
  toolCall: MCPToolCall
): ExtractedRequestInfo | null {
  const args = toolCall.arguments;

  const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

  // look for common patterns in tool call arguments
  const rawMethod = (
    (args.method as string) ||
    (args.httpMethod as string) ||
    (args.http_method as string) ||
    "GET"
  ).toUpperCase();

  const method = VALID_METHODS.has(rawMethod) ? rawMethod : "GET";

  const endpoint =
    (args.url as string) ||
    (args.endpoint as string) ||
    (args.uri as string) ||
    null;

  if (!endpoint) {
    return null;
  }

  let rawBody: string | undefined;
  if (args.body) {
    rawBody =
      typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  } else if (args.data) {
    rawBody =
      typeof args.data === "string" ? args.data : JSON.stringify(args.data);
  }

  return {
    httpMethod: method,
    endpoint,
    bodyHash: hashBody(rawBody ?? null),
    rawBody,
  };
}

export function isPaymentRequired(statusCode: number): boolean {
  return statusCode === 402;
}

/**
 * The payment an x402 v2 402 answer asks for, with the Beaver402 challenge
 * that comes with it. Null when the body is not one.
 */
export function extractPaymentDetails(responseBody: Record<string, unknown>) {
  const accepts = responseBody.accepts as Array<Record<string, unknown>> | undefined;
  const requirements = Array.isArray(accepts) ? accepts[0] : undefined;
  const extensions = responseBody.extensions as Record<string, { challenge?: unknown }> | undefined;
  const challenge = extensions?.beaver402?.challenge;

  if (!requirements || !challenge) {
    return null;
  }

  return {
    amount: String(requirements.amount),
    asset: String(requirements.asset),
    recipient: String(requirements.payTo),
    network: String(requirements.network),
    scheme: String(requirements.scheme),
    challenge,
  };
}
