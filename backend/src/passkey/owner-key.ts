import { convertCOSEtoPKCS } from "@simplewebauthn/server/helpers";

/** An uncompressed secp256r1 point: the 0x04 marker, then x, then y. */
const UNCOMPRESSED_LENGTH = 65;
const UNCOMPRESSED_MARKER = 0x04;

/**
 * Convert a registered passkey into the owner key the contract stores.
 *
 * Authenticators describe their public key in COSE, which is a map holding
 * the curve and the two coordinates. The contract wants the plain
 * uncompressed point, because that is what secp256r1 verification takes.
 */
export function coseToOwnerKey(credentialPublicKey: Uint8Array): Buffer {
  // The helper insists on a view over a plain ArrayBuffer, while callers hand
  // us whatever the storage layer produced, so the bytes are copied first.
  const copy = Uint8Array.from(credentialPublicKey);
  const pkcs = Buffer.from(convertCOSEtoPKCS(copy));

  if (pkcs.length !== UNCOMPRESSED_LENGTH) {
    throw new Error(
      `expected a 65 byte uncompressed point, got ${pkcs.length} bytes. ` +
        "The passkey is probably not on the P-256 curve, which is the only " +
        "curve the contract can verify."
    );
  }
  if (pkcs[0] !== UNCOMPRESSED_MARKER) {
    throw new Error(
      `expected an uncompressed point starting with 0x04, got 0x${pkcs[0]!.toString(16)}`
    );
  }

  return pkcs;
}

/** The form the deploy script passes to the contract constructor. */
export function ownerKeyToHex(credentialPublicKey: Uint8Array): string {
  return coseToOwnerKey(credentialPublicKey).toString("hex");
}
