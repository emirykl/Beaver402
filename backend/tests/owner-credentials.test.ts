import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { isoCBOR } from "@simplewebauthn/server/helpers";

import { ownerCredentialIds } from "../src/policy/owner-actions.js";

const CONTRACT = "CCBW3NIND6TOSLXRNXV7SYWRU4CCIQPYWYRJC2MACSAA777OATMDQYVF";

function cose(fill: number): Uint8Array {
  const map = new Map<number, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(32).fill(fill)],
    [-3, new Uint8Array(32).fill(fill + 1)],
  ]);
  return new Uint8Array(isoCBOR.encode(map));
}

function point(fill: number): Buffer {
  return Buffer.concat([Buffer.from([4]), Buffer.alloc(32, fill), Buffer.alloc(32, fill + 1)]);
}

/** An account whose instance storage holds this owner key. */
function ledgerWithOwner(owner: Buffer) {
  const instance = new StellarSdk.xdr.ScContractInstance({
    executable: StellarSdk.xdr.ContractExecutable.contractExecutableStellarAsset(),
    storage: [
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol("Owner")]),
        val: StellarSdk.xdr.ScVal.scvBytes(owner),
      }),
    ],
  });
  const data = new StellarSdk.xdr.ContractDataEntry({
    ext: new StellarSdk.xdr.ExtensionPoint(0),
    contract: StellarSdk.Address.fromString(CONTRACT).toScAddress(),
    key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: StellarSdk.xdr.ContractDataDurability.persistent(),
    val: StellarSdk.xdr.ScVal.scvContractInstance(instance),
  });
  return {
    getLedgerEntries: async () =>
      ({ entries: [{ val: StellarSdk.xdr.LedgerEntryData.contractData(data) }] }) as never,
  };
}

const credential = (id: string, fill: number) =>
  ({ credentialID: id, credentialPublicKey: cose(fill), counter: 0 }) as never;

describe("which passkey may sign an owner action", () => {
  it("offers only the passkeys whose key is the account's owner", async () => {
    const ids = await ownerCredentialIds(CONTRACT, ledgerWithOwner(point(0x44)), async () => [
      credential("other-account", 0x11),
      credential("this-account", 0x44),
    ]);
    expect(ids).toEqual(["this-account"]);
  });

  it("says so when no registered passkey owns the account", async () => {
    await expect(
      ownerCredentialIds(CONTRACT, ledgerWithOwner(point(0x44)), async () => [credential("other-account", 0x11)])
    ).rejects.toThrow(/no registered passkey matches/);
  });

  it("leaves the choice to the browser when there is no credential store", async () => {
    expect(await ownerCredentialIds(CONTRACT, ledgerWithOwner(point(0x44)), async () => [])).toBeUndefined();
  });
});
