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
  "19": {
    name: "PaymentLimitExceeded",
    reason: "the payment is larger than a single payment may be",
  },
  "20": {
    name: "AssetNotAllowed",
    reason: "the account only pays in its own token",
  },
  "21": {
    name: "ExpiryTooFar",
    reason: "the challenge stays valid for longer than the account allows",
  },
  "22": {
    name: "LimitIncrease",
    reason: "limits can only be lowered",
  },
  "23": {
    name: "NotFrozen",
    reason: "funds can only be recovered from a frozen account",
  },
  "24": {
    name: "NothingToRecover",
    reason: "the account holds none of that token",
  },
  "25": {
    name: "ProofNotFound",
    reason: "there is no recorded payment with that nonce",
  },
  "26": {
    name: "ProofAlreadyPublished",
    reason: "the proof of intent for this payment was already published",
  },
  "27": {
    name: "InvalidConfig",
    reason: "those limits are not ones the account can run with",
  },
  "28": {
    name: "WrongRelyingParty",
    reason: "the passkey answered for a different site",
  },
  "29": {
    name: "UserNotVerified",
    reason: "the passkey did not verify who was holding it",
  },
};

/**
 * The policy's code, dug out of whatever the host wrapped it in.
 *
 * Only a code the account itself returned counts: the host reports it as
 * the reason the account's authentication failed. A contract error anywhere
 * else in the diagnostics belongs to some other contract, most often the
 * token refusing the transfer, and its codes mean something else entirely.
 */
function codeIn(message: string): string | undefined {
  // Newer hosts name the account between the text and the code.
  return message.match(
    /failed account authentication with error",\s*(?:[A-Z0-9]{56},\s*)?Error\(Contract, #(\d+)\)/
  )?.[1];
}

/** A refusal by a contract other than the policy, such as the token. */
function otherContractRefusal(message: string): string | undefined {
  if (!/Error\(Contract, #\d+\)/.test(message)) return undefined;
  const explanation = message.match(/topics:\[error, Error\(Contract, #\d+\)\], data:\["([^"]+)"/)?.[1];
  return explanation
    ? `the token contract refused the transfer: ${explanation}`
    : "the token contract refused the transfer";
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
    const other = otherContractRefusal(message);
    if (other) return other;
    // A refusal the policy did not name. Saying so beats a page of diagnostics.
    if (message.includes("Error(Auth")) {
      return "the policy refused to authorize this payment";
    }
    return message;
  }

  const known = POLICY_ERRORS[code];
  return known ? `${known.name}, ${known.reason}` : `the policy refused this payment, contract error #${code}`;
}

/**
 * The reason an owner action failed.
 *
 * An owner action calls the policy account itself, so a contract error at
 * the top of the host's report is the policy's own. (Recovering funds also
 * calls the token, whose refusals carry their own explanation and are
 * reported as the token's.)
 */
export function describeOwnerActionError(message: string): string {
  const fromAuth = codeIn(message);
  const direct = message.match(/HostError: Error\(Contract, #(\d+)\)/)?.[1];
  const code = fromAuth ?? direct;
  const known = code ? POLICY_ERRORS[code] : undefined;
  if (known && !/data:\["[^"]*balance/.test(message)) {
    return `${known.name}, ${known.reason}`;
  }
  return describePolicyError(message);
}
