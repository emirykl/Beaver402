import { describe, it, expect } from "vitest";

import {
  describePolicyError,
  describeOwnerActionError,
  policyErrorName,
  POLICY_ERRORS,
} from "../src/shared/policy-errors.js";

/**
 * A refusal exactly as the network reports one, shortened. The code that
 * explains it sits in the diagnostics rather than in the error itself, which
 * is the whole reason this module exists.
 */
function hostRefusal(code: number): string {
  return [
    "policy rejected the payment: HostError: Error(Auth, InvalidAction)",
    "",
    "Event log (newest first):",
    `   0: [Diagnostic Event] topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", Error(Contract, #${code})]`,
  ].join("\n");
}

describe("reading the policy's reason out of a host error", () => {
  it("names the error the contract actually raised", () => {
    expect(policyErrorName(hostRefusal(7))).toBe("NonceReused");
    expect(policyErrorName(hostRefusal(2))).toBe("UnauthorizedMerchant");
    expect(policyErrorName(hostRefusal(11))).toBe("AccountFrozen");
  });

  it("says nothing when the failure was not the policy refusing", () => {
    expect(policyErrorName("the network did not confirm within 60 seconds")).toBeUndefined();
    expect(policyErrorName(undefined)).toBeUndefined();
  });

  it("names a code it has never heard of rather than hiding it", () => {
    expect(policyErrorName(hostRefusal(99))).toBe("contract error #99");
  });
});

describe("writing a refusal for someone reading a screen", () => {
  it("gives the name and the reason together", () => {
    expect(describePolicyError(hostRefusal(7))).toBe(
      "NonceReused, this challenge had already been paid once"
    );
    expect(describePolicyError(hostRefusal(11))).toBe(
      "AccountFrozen, payments are halted until the owner resumes them"
    );
  });

  it("keeps every reason short enough for the panel to show whole", () => {
    for (const code of Object.keys(POLICY_ERRORS)) {
      expect(describePolicyError(hostRefusal(Number(code))).length).toBeLessThanOrEqual(96);
    }
  });

  it("does not repeat a page of diagnostics at anyone", () => {
    expect(describePolicyError(hostRefusal(2))).not.toContain("Diagnostic Event");
  });

  it("says plainly that the policy refused when it named no code", () => {
    expect(describePolicyError("HostError: Error(Auth, InvalidAction)")).toBe(
      "the policy refused to authorize this payment"
    );
  });

  it("leaves a failure that already explains itself alone", () => {
    const timeout =
      "the network did not confirm 236a596e within 60 seconds, so the outcome is unknown";

    expect(describePolicyError(timeout)).toBe(timeout);
  });

  it("has nothing to say about nothing", () => {
    expect(describePolicyError(undefined)).toBe("");
    expect(describePolicyError("")).toBe("");
  });
});

describe("telling the policy's refusals from the token's", () => {
  // As the host reports a transfer the token refused, from a testnet run on
  // 2026-10-02: the token's own code, which means something else entirely.
  const tokenRefusal = [
    "simulation failed: HostError: Error(Contract, #10)",
    "",
    "Event log (newest first):",
    '   0: [Diagnostic Event] contract:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA, topics:[error, Error(Contract, #10)], data:["balance is not sufficient to spend", 9000000]',
  ].join("\n");

  it("does not mistake a token error for a policy error", () => {
    expect(policyErrorName(tokenRefusal)).toBeUndefined();
  });

  it("says the token refused, and why", () => {
    expect(describePolicyError(tokenRefusal)).toBe(
      "the token contract refused the transfer: balance is not sufficient to spend"
    );
  });
});

describe("reading the refusal the way protocol 29 reports it", () => {
  // Verbatim from a testnet run on 2026-10-02, against a frozen account.
  const refusal = [
    "policy rejected the payment: HostError: Error(Auth, InvalidAction)",
    "",
    "Event log (newest first):",
    '   0: [Diagnostic Event] contract:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA, topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", CDXXP73UCD2IQICB5RWSD2JAZ72M3BL73O4W4R4GDWNIYM3T5SBJV7Y4, Error(Contract, #11)]',
  ].join("\n");

  it("finds the policy's code after the account's address", () => {
    expect(policyErrorName(refusal)).toBe("AccountFrozen");
  });
});

describe("explaining a refused owner action", () => {
  it("names the policy's code when the policy itself refused", () => {
    expect(describeOwnerActionError("Error: simulation failed: HostError: Error(Contract, #22)")).toBe(
      "LimitIncrease, limits can only be lowered"
    );
  });

  it("still reads a passkey refusal through the authentication path", () => {
    expect(
      describeOwnerActionError(
        'failed: data:["failed account authentication with error", CDXXP73UCD2IQICB5RWSD2JAZ72M3BL73O4W4R4GDWNIYM3T5SBJV7Y4, Error(Contract, #28)]'
      )
    ).toBe("WrongRelyingParty, the passkey answered for a different site");
  });
});
