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

  it("should extract payment details from response body", () => {
    const details = extractPaymentDetails({
      paymentDetails: {
        amount: "5000000",
        asset: "USDC",
        recipient: "GABCDEF...",
        network: "testnet",
      },
      challenge: {
        fields: {},
        hash: "abc123",
        merchantSignature: "sig",
        merchantPubkey: "GABCDEF...",
      },
    });

    expect(details).not.toBeNull();
    expect(details!.amount).toBe("5000000");
    expect(details!.asset).toBe("USDC");
  });

  it("should return null when payment details are missing", () => {
    expect(extractPaymentDetails({})).toBeNull();
    expect(extractPaymentDetails({ paymentDetails: {} })).toBeNull();
  });
});
