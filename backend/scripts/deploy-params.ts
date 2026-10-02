/**
 * Print what the deploy script needs to know about the network, after the
 * same validation the backend applies at startup.
 *
 * Deploying with values the backend would refuse to run with would create an
 * account nothing can operate, so the deploy reads them from here rather
 * than from its own copy.
 *
 * Run with: npx tsx --env-file=<env file> scripts/deploy-params.ts
 */
import { network, verifyNetwork } from "../src/config/network.js";
import { passkey, rpIdHash } from "../src/config/passkey.js";

async function main() {
  const config = network();
  await verifyNetwork(config);
  const { rpId, origin } = passkey();

  console.log(
    JSON.stringify({
      network: config.name,
      passphrase: config.passphrase,
      rpcUrl: config.rpcUrl,
      usdcContract: config.usdcContract,
      explorer: config.explorer,
      rpId,
      origin,
      rpIdHash: rpIdHash(rpId).toString("hex"),
    })
  );
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
