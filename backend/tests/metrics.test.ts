import { describe, it, expect } from "vitest";

import { parseMetric } from "../src/ops/metrics-routes.js";

describe("counting traffic without tracking anyone", () => {
  it("counts a view of a known page", () => {
    expect(parseMetric({ path: "/", kind: "view" })).toEqual({ path: "/", kind: "view", target: "" });
  });

  it("counts a click on a known link", () => {
    expect(parseMetric({ path: "/", kind: "click", target: "demo" })).toEqual({
      path: "/",
      kind: "click",
      target: "demo",
    });
  });

  it("ignores anything a visitor attaches to a view", () => {
    expect(parseMetric({ path: "/status", kind: "view", target: "someone@example.com" })).toEqual({
      path: "/status",
      kind: "view",
      target: "",
    });
  });

  it("refuses pages and links it does not know, so nothing else can be stored", () => {
    expect(parseMetric({ path: "/anything", kind: "view" })).toBeNull();
    expect(parseMetric({ path: "/", kind: "click", target: "https://tracker.example" })).toBeNull();
    expect(parseMetric({ path: "/", kind: "scroll" })).toBeNull();
    expect(parseMetric(null)).toBeNull();
  });
});
