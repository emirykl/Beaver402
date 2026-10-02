import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { POLICY_ERRORS } from "../src/shared/policy-errors.js";
import { OWNER_ACTIONS } from "../src/policy/owner-actions.js";

/**
 * The backend repeats two things the contract defines: what its error codes
 * mean, and which of its functions only the owner may call. If either drifts
 * the panel would explain a refusal wrongly or offer an action the contract
 * treats as a payment, so both are read straight out of the contract source.
 */
const contract = (file: string) =>
  readFileSync(new URL(`../../contracts/payment_policy/src/${file}`, import.meta.url), "utf8");

describe("the backend agrees with the contract", () => {
  it("names every error code the contract can raise, and no others", () => {
    const declared = Object.fromEntries(
      [...contract("errors.rs").matchAll(/^\s*(\w+) = (\d+),/gm)].map(([, name, code]) => [code, name])
    );
    const known = Object.fromEntries(
      Object.entries(POLICY_ERRORS).map(([code, { name }]) => [code, name])
    );
    expect(known).toEqual(declared);
  });

  it("offers exactly the owner actions the contract gates on the passkey", () => {
    const block = contract("lib.rs").match(/const OWNER_ACTIONS: \[&str; \d+\] = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const gated = [...block![1]!.matchAll(/"(\w+)"/g)].map(([, name]) => name).sort();
    expect([...OWNER_ACTIONS].sort()).toEqual(gated);
  });
});
