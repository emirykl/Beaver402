import { describe, it, expect } from "vitest";
import {
  extractRequestFromToolCall,
  isPaymentRequired,
  extractPaymentDetails,
} from "../src/mcp/mcp-tool-handler.js";

describe("MCP tool call extraction", () => {
  it("should extract GET request from tool call arguments", () => {
    const result = extractRequestFromToolCall({
      name: "fetch_data",
      arguments: {
        method: "GET",
        url: "https://api.merchant.com/data",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.httpMethod).toBe("GET");
    expect(result!.endpoint).toBe("https://api.merchant.com/data");
    expect(result!.bodyHash).toHaveLength(64);
  });

  it("should extract POST request with body", () => {
    const result = extractRequestFromToolCall({
      name: "submit_order",
      arguments: {
        httpMethod: "POST",
        endpoint: "https://api.merchant.com/submit",
        body: '{"item": "widget"}',
      },
    });

    expect(result).not.toBeNull();
    expect(result!.httpMethod).toBe("POST");
    expect(result!.rawBody).toBe('{"item": "widget"}');
  });

  it("should return null when no endpoint is found", () => {
    const result = extractRequestFromToolCall({
      name: "no_url_tool",
      arguments: { data: "something" },
    });

    expect(result).toBeNull();
  });

  it("should default to GET when no method specified", () => {
    const result = extractRequestFromToolCall({
      name: "simple_fetch",
      arguments: { url: "https://example.com/api" },
    });

    expect(result!.httpMethod).toBe("GET");
  });

  it("should reject invalid HTTP methods and default to GET", () => {
    const result = extractRequestFromToolCall({
      name: "bad_method",
      arguments: {
        method: "INVALID",
        url: "https://example.com/api",
      },
    });

    expect(result!.httpMethod).toBe("GET");
  });

  it("should normalize method to uppercase", () => {
    const result = extractRequestFromToolCall({
      name: "lowercase_method",
      arguments: {
        method: "post",
        url: "https://example.com/api",
        body: "data",
      },
    });

    expect(result!.httpMethod).toBe("POST");
  });

  it("should handle object body by stringifying", () => {
    const result = extractRequestFromToolCall({
      name: "object_body",
      arguments: {
        method: "POST",
        url: "https://example.com/api",
        body: { key: "value" },
      },
    });

    expect(result!.rawBody).toBe('{"key":"value"}');
  });
});

describe("payment detection", () => {
  it("should detect 402 status code", () => {
    expect(isPaymentRequired(402)).toBe(true);
    expect(isPaymentRequired(200)).toBe(false);
    expect(isPaymentRequired(401)).toBe(false);
  });

  it("should extract payment details from an x402 v2 answer", () => {
    const details = extractPaymentDetails({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "5000000",
          payTo: "GABCDEF...",
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true },
        },
      ],
      extensions: {
        beaver402: {
          challenge: {
            fields: {},
            hash: "abc123",
            merchantSignature: "sig",
            merchantPubkey: "GABCDEF...",
          },
        },
      },
    });

    expect(details).not.toBeNull();
    expect(details!.amount).toBe("5000000");
    expect(details!.network).toBe("stellar:testnet");
    expect(details!.recipient).toBe("GABCDEF...");
  });

  it("should return null when payment details are missing", () => {
    expect(extractPaymentDetails({})).toBeNull();
    expect(extractPaymentDetails({ accepts: [] })).toBeNull();
    // Standard x402 without the Beaver402 challenge is not something the
    // agent will pay.
    expect(extractPaymentDetails({ accepts: [{ amount: "1" }] })).toBeNull();
  });
});
