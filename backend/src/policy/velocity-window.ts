export interface VelocityReading {
  txCount: number;
  totalAmount: string;
  windowStart: number;
}

export interface VelocityLimits {
  windowSize: number;
}

export interface EffectiveVelocity {
  txCount: number;
  totalAmount: string;
  /** True when the counters on chain belong to a window that has passed. */
  windowElapsed: boolean;
}

/**
 * What the budget will actually be when the next payment arrives.
 *
 * A contract cannot wake up when a window ends. The counters it stores are
 * only rolled over when someone next asks it to authorize a payment, so a
 * budget that has already reset still reads as spent until then. Reading the
 * stored numbers back without this makes the panel report three payments
 * against a budget that is, in every way that matters, untouched.
 *
 * The rule here is the contract's own, from
 * contracts/payment_policy/src/velocity.rs, so what the panel shows is what
 * the account will do rather than a friendlier guess.
 */
export function effectiveVelocity(
  reading: VelocityReading,
  limits: VelocityLimits,
  now: number
): EffectiveVelocity {
  const elapsed = Math.max(0, now - reading.windowStart);
  const windowElapsed = limits.windowSize > 0 && elapsed >= limits.windowSize;

  if (!windowElapsed) {
    return {
      txCount: reading.txCount,
      totalAmount: reading.totalAmount,
      windowElapsed: false,
    };
  }

  return { txCount: 0, totalAmount: "0", windowElapsed: true };
}
