import { describe, it, expect } from "vitest";

import { effectiveVelocity } from "../src/policy/velocity-window.js";

const DAY = 86_400;
const spent = { txCount: 3, totalAmount: "3000000", windowStart: 1_000_000 };
const daily = { windowSize: DAY };

describe("what the budget will be when the next payment arrives", () => {
  it("leaves the counters alone inside the window", () => {
    const now = spent.windowStart + DAY - 1;

    expect(effectiveVelocity(spent, daily, now)).toEqual({
      txCount: 3,
      totalAmount: "3000000",
      windowElapsed: false,
    });
  });

  it("rolls them forward the moment the window is up", () => {
    const now = spent.windowStart + DAY;

    expect(effectiveVelocity(spent, daily, now)).toEqual({
      txCount: 0,
      totalAmount: "0",
      windowElapsed: true,
    });
  });

  it("does not count a window twice over, however long it has been", () => {
    const now = spent.windowStart + DAY * 40;

    expect(effectiveVelocity(spent, daily, now).txCount).toBe(0);
  });

  it("holds still when there is no window configured", () => {
    const now = spent.windowStart + DAY * 40;

    expect(effectiveVelocity(spent, { windowSize: 0 }, now)).toEqual({
      txCount: 3,
      totalAmount: "3000000",
      windowElapsed: false,
    });
  });

  it("treats a clock behind the ledger as no time passing", () => {
    const now = spent.windowStart - DAY;

    expect(effectiveVelocity(spent, daily, now).windowElapsed).toBe(false);
  });

  it("has nothing to reset when nothing was spent", () => {
    const fresh = { txCount: 0, totalAmount: "0", windowStart: 0 };

    expect(effectiveVelocity(fresh, daily, 5_000_000).txCount).toBe(0);
  });
});
