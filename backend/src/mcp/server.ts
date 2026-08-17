#!/usr/bin/env node
/**
 * The Beaver402 MCP server.
 *
 * This is what an agent talks to. It exposes one tool that fetches a resource
 * and pays for it when the merchant asks, and it deliberately holds no keys:
 * every payment goes through the backend, which is the only process that can
 * sign. The model sees a price, a transaction hash and the content, and never
 * anything it could spend.
 *
 * Run with: npm run mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.BEAVER402_BACKEND_URL || "http://localhost:3000";

interface PaidFetchResponse {
  status: number;
  paid: boolean;
  content: unknown;
  payment?: {
    txHash?: string;
    challengeHash?: string;
    intentHash?: string;
    amount: string;
    asset: string;
    recipient: string;
  };
  error?: string;
}

async function callBackend(payload: unknown): Promise<PaidFetchResponse> {
  const response = await fetch(`${BACKEND_URL}/api/agent/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  try {
    return JSON.parse(text) as PaidFetchResponse;
  } catch {
    throw new Error(`backend returned a non JSON response: ${text.slice(0, 200)}`);
  }
}

function describe(result: PaidFetchResponse): string {
  const lines: string[] = [];

  if (result.paid && result.payment) {
    const { amount, asset, recipient, txHash, challengeHash, intentHash } = result.payment;
    lines.push(`Paid ${amount} of ${asset} to ${recipient}.`);
    if (txHash) lines.push(`Transaction: ${txHash}`);
    if (challengeHash) lines.push(`Merchant challenge: ${challengeHash}`);
    if (intentHash) lines.push(`Buyer intent: ${intentHash}`);
    lines.push("");
  } else if (result.error) {
    lines.push(`Payment did not go through: ${result.error}`);
    lines.push("");
  }

  lines.push(typeof result.content === "string"
    ? result.content
    : JSON.stringify(result.content, null, 2));

  return lines.join("\n");
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "beaver402",
    version: "0.1.0",
  });

  server.registerTool(
    "fetch_paid_resource",
    {
      title: "Fetch a paid resource",
      description:
        "Fetch an HTTP resource. If the server answers with 402 Payment Required, " +
        "settle the payment through the Beaver402 policy account and return the " +
        "content. The payment is only authorized when the merchant's signed " +
        "challenge and the independently reconstructed buyer intent agree on the " +
        "endpoint, body, recipient, asset and amount.",
      inputSchema: {
        url: z.string().describe("The resource to fetch."),
        method: z
          .string()
          .optional()
          .describe("HTTP method. Defaults to GET."),
        body: z
          .string()
          .optional()
          .describe("Request body, already serialized."),
      },
      annotations: {
        // Paying is not something to retry blindly.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, method, body }) => {
      try {
        const result = await callBackend({ url, method, body });
        return {
          content: [{ type: "text" as const, text: describe(result) }],
          isError: Boolean(result.error),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not reach the Beaver402 backend at ${BACKEND_URL}: ${err}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_policy_state",
    {
      title: "Read the policy account state",
      description:
        "Report whether payments are frozen, which agent signer is active, and " +
        "how much of the velocity budget has been used.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/api/policy/state`);
        const state = await response.json();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Could not read policy state: ${err}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// Only start talking on stdio when run directly, so tests can import the
// server without it seizing the streams. Compare module URLs rather than the
// source filename so both server.ts and the compiled server.js work.
const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypointUrl) {
  main().catch((err) => {
    console.error("beaver402 mcp server failed to start:", err);
    process.exit(1);
  });
}
