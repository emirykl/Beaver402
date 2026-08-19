/**
 * What the policy's own error codes mean, in words.
 *
 * The network wraps a refusal from a custom account in a generic
 * authorization failure that looks identical whatever the reason, and the
 * code that actually explains it only appears in the diagnostics. Reading it
 * back out is the difference between "refused" and "refused because this
 * challenge was already paid once".
 *
 * The codes are the ones in contracts/payment_policy/src/errors.rs.
 */
export const POLICY_ERRORS: Record<string, { name: string; reason: string }> = {
  "1": {
    name: "InvalidBuyerSigner",
    reason: "the agent signature did not match the delegated signer",
  },
  "2": {
    name: "UnauthorizedMerchant",
    reason: "the owner has not approved this merchant",
  },
  "3": {
    name: "InvalidMerchantSignature",
    reason: "the merchant signature did not cover these terms",
  },
  "4": {
    name: "ChallengeMismatch",
    reason: "the passkey signed a different action",
  },
  "7": {
    name: "NonceReused",
    reason: "this challenge had already been paid once",
  },
  "8": {
    name: "ChallengeExpired",
    reason: "the challenge had already expired",
  },
  "10": {
    name: "VelocityExceeded",
    reason: "the budget for this window is used up",
  },
  "11": {
    name: "AccountFrozen",
    reason: "payments are halted until the owner resumes them",
  },
  "12": {
    name: "SignerRevoked",
    reason: "the agent key was revoked, so nothing can be paid",
  },
  "13": {
    name: "UnauthorizedOwnerAction",
    reason: "an owner action cannot be authorized this way",
  },
  "14": {
    name: "InvalidSignatureFormat",
    reason: "the signature was not in a shape the account accepts",
  },
  "15": {
    name: "NotInitialized",
    reason: "the account has no owner on record",
  },
  "16": {
    name: "AlreadyInitialized",
    reason: "the account was already set up",
  },
  "17": {
    name: "InvalidAmount",
    reason: "the amount was not a positive number",
  },
  "18": {
    name: "SettlementMismatch",
    reason: "the transfer was not the one both sides signed for",
  },
};

/** The policy's code, dug out of whatever the host wrapped it in. */
function codeIn(message: string): string | undefined {
  return message.match(/Error\(Contract, #(\d+)\)/)?.[1];
}

/** The name of the error the policy raised, if it raised one. */
export function policyErrorName(message: string | undefined): string | undefined {
  if (!message) return undefined;

  const code = codeIn(message);
  if (!code) return undefined;

  return POLICY_ERRORS[code]?.name ?? `contract error #${code}`;
}

/**
 * The same refusal, written for someone reading a screen.
 *
 * Anything that is not a policy refusal is handed back untouched, because a
 * timeout or a network problem already says what it is.
 */
export function describePolicyError(message: string | undefined): string {
  if (!message) return "";

  const code = codeIn(message);
  if (!code) {
    // A refusal the policy did not name. Saying so beats a page of diagnostics.
    if (message.includes("Error(Auth")) {
      return "the policy refused to authorize this payment";
    }
    return message;
  }

  const known = POLICY_ERRORS[code];
  return known ? `${known.name}, ${known.reason}` : `the policy refused this payment, contract error #${code}`;
}
