import * as StellarSdk from "@stellar/stellar-sdk";

import type { ResolvedConfig } from "./config.js";
import type { Facilitator } from "./facilitator.js";
import type { Rpc } from "./ledger.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  /** A warning does not stop the merchant; a failed check does. */
  severity: "error" | "warning";
  detail: string;
}

/** Below this the merchant account may not cover proof of intent fees. */
export const MIN_SIGNER_XLM = 2;

/**
 * Everything that has to be true on the network before the merchant hands
 * out a challenge: the RPC serves the network that was named, the recipient
 * can receive USDC, the facilitator settles on this network, and the signing
 * account can pay for proofs of intent.
 */
export async function preflight(
  config: ResolvedConfig,
  rpc: Pick<Rpc, "getNetwork" | "getAccountEntry" | "getTrustline">,
  facilitator: Pick<Facilitator, "supports">
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string, severity: CheckResult["severity"] = "error") =>
    results.push({ name, ok, severity, detail });

  try {
    const reported = await rpc.getNetwork();
    add(
      "network",
      reported.passphrase === config.constants.passphrase,
      reported.passphrase === config.constants.passphrase
        ? `${config.rpcUrl} serves ${config.network}`
        : `${config.rpcUrl} serves "${reported.passphrase}", not ${config.network}`
    );
  } catch (err) {
    add("network", false, `${config.rpcUrl} could not be reached: ${message(err)}`);
    return results;
  }

  const usdc = new StellarSdk.Asset("USDC", config.constants.usdcIssuer);
  try {
    await rpc.getAccountEntry(config.recipient);
    try {
      const line = await rpc.getTrustline(config.recipient, usdc);
      const authorized = (line.flags() & StellarSdk.xdr.TrustLineFlags.authorizedFlag().value) !== 0;
      add(
        "recipient trustline",
        authorized,
        authorized
          ? `${config.recipient} holds a USDC trustline`
          : `${config.recipient} has a USDC trustline that the issuer has not authorized`
      );
    } catch {
      add("recipient trustline", false, `${config.recipient} has no USDC trustline. Add one for USDC:${config.constants.usdcIssuer} before taking payments`);
    }
  } catch {
    add("recipient account", false, `${config.recipient} does not exist on ${config.network}. Fund it with XLM first`);
  }

  const signer = config.keypair.publicKey();
  try {
    const entry = await rpc.getAccountEntry(signer);
    const xlm = Number(entry.balance().toBigInt()) / 1e7;
    add(
      "signer balance",
      xlm >= MIN_SIGNER_XLM,
      `${signer} holds ${xlm} XLM${xlm >= MIN_SIGNER_XLM ? "" : `; keep at least ${MIN_SIGNER_XLM} so proofs of intent can be published`}`,
      "warning"
    );
  } catch {
    add("signer account", false, `the merchant signing account ${signer} does not exist on ${config.network}. Fund it with a little XLM: it pays for proofs of intent`, "warning");
  }

  try {
    const ok = await facilitator.supports(config.constants.caip2);
    add("facilitator", ok, ok ? `${config.facilitatorUrl} settles exact payments on ${config.constants.caip2}` : `${config.facilitatorUrl} does not settle exact payments on ${config.constants.caip2}`);
  } catch (err) {
    add("facilitator", false, `${config.facilitatorUrl} could not be reached or refused the API key: ${message(err)}`);
  }

  add(
    "settlement store",
    config.store.persistent || config.network === "testnet",
    config.store.persistent ? "payments are recorded persistently" : "payments are kept in memory and forgotten on restart; fine for testnet only",
    config.store.persistent ? "error" : "warning"
  );

  return results;
}

/** Whether nothing that blocks payments failed. */
export function passed(results: CheckResult[]): boolean {
  return results.every((r) => r.ok || r.severity === "warning");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
