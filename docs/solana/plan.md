# Beaver402 on Solana devnet: plan

Goal: Beaver402 does on Solana devnet everything it does today on Stellar
testnet. The Stellar side keeps its behaviour, and the release candidate with
the reviewer is not touched.

Branch: `multichain`, on top of `contract-hardening`.

---

## 0. The finding that shapes the design

The x402 `exact` scheme on Solana (`specs/schemes/exact/scheme_exact_svm.md`)
defines the transaction a facilitator accepts very narrowly:

1. Compute Budget: set compute unit limit
2. Compute Budget: set compute unit price
3. SPL Token or Token-2022 `TransferChecked`
4. Up to three optional instructions, Lighthouse or Memo only

**A standard facilitator will not run our program inside the payment.** On
Stellar this never came up, because `__check_auth` runs inside the standard
transfer. Solana has no equivalent.

Options considered:

| Option | What it does | Outcome |
|---|---|---|
| A. Our program makes the transfer, the merchant settles | The agent signs a transaction holding the `pay` instruction, the merchant signs it as fee payer and submits it | **Chosen.** Every security check stays on chain |
| B. The program `approve`s, then a standard `TransferChecked` | Two transactions, the second through a hosted facilitator | The amount is bound but **the recipient is not bound on chain**: whoever holds the delegate key can send the approved amount anywhere. Breaks the core of Beaver402 |
| C. Plain SPL delegate | Works with existing facilitators | No merchant signature, no intent, no nonce. This is what competing projects do |

The cost of option A: no hosted facilitator on Solana. The merchant acts as
its own facilitator. It verifies the transaction, signs it as fee payer,
submits it and confirms it on the ledger. The x402 messages stay standard
(402, `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). Only the
scheme name differs, `beaver402` rather than `exact`, because the transaction
is not the one `exact` describes and claiming otherwise would be dishonest.
This goes into the known limitations and into the hackathon text.

Later: a proposal to add program-mediated transfers to the x402 SVM scheme.
Out of scope for the hackathon.

---

## 1. Stellar and Solana side by side

| Topic | Stellar (today) | Solana (new) |
|---|---|---|
| Account | Soroban smart account, `__check_auth` | Anchor program + `Policy` PDA + a USDC token account owned by the PDA (the vault) |
| Payment | Standard `transfer`, authorized by the account | The program's `pay` instruction, `TransferChecked` through CPI |
| Agent signature | ed25519 over the Soroban auth payload | The agent signs the transaction (`Signer`), the program compares it with `agent_signer` |
| Merchant signature | `env.crypto().ed25519_verify` | An Ed25519 precompile instruction in the same transaction. The program reads the instructions sysvar and checks it ran with this key over this message |
| Passkey | `secp256r1_verify` host function | secp256r1 precompile (`Secp256r1SigVerify1111…`, SIMD-0075, live on mainnet), same introspection |
| Owner action replay | Prevented by the Soroban auth nonce | An `owner_nonce` counter in the policy account, covered by the passkey challenge |
| Network id | `sha256(passphrase)`, read from the ledger | A program cannot read the genesis hash. `sha256(CAIP-2)` is stored when the account is created and cannot change |
| Proof of intent | Separate `publish_proof` transaction, because the facilitator accepts no extra events | We settle ourselves, so `pay` emits the event and no second transaction is needed |
| Rent / TTL | Slot design driven by the fee ceiling | The account is allocated at full size up front, no rent concern. The slot logic stays the same |
| Address format | 56 character strkey | 32 byte public key (base58) |
| USDC | SAC, 7 decimals | Circle devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals |

The same passkey can own the account on both chains, since both use P-256
and the same `rp_id`. Merchant and agent keys are ed25519 on both chains too,
so one key could serve both. The plan still keeps them separate.

---

## 2. Canonical encoding, Solana family

The existing encoding does not change. A Solana family is added, and the
Stellar vectors stay byte for byte the same.

- Domains: `beaver402:challenge:solana:v1`, `beaver402:intent:solana:v1`,
  `beaver402:request:v1` (the request digest does not depend on the chain)
- `request_digest`: same formula. `merchantPubkey` goes in as base58 text.
- Settlement preimage (Solana, 208 bytes):

| Offset | Length | Contents |
|---|---|---|
| 0 | 32 | `request_digest` |
| 32 | 32 | `recipient`, the owner public key of the destination (x402 `payTo`) |
| 64 | 32 | `asset`, the USDC mint |
| 96 | 32 | `policy`, the paying policy account |
| 128 | 8 | `amount`, big endian `u64` |
| 136 | 32 | network id, `sha256("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")` |
| 168 | 32 | `nonce` |
| 200 | 8 | `expiry`, big endian `u64` |

The `policy` field is new on Solana, so a merchant signature cannot be used
against another policy account with the same limits. On Stellar the
authorization chain already took care of this.

- `test-vectors/vectors-solana.json`: produced by TypeScript, read by the
  Rust program. The same arrangement as the Stellar `cross-lang` test.

---

## 3. The Anchor program: `solana/programs/beaver402_policy`

A separate Cargo workspace (`solana/`). The root `Cargo.toml` and
`Cargo.lock` stay untouched, otherwise the hash of the Stellar release WASM
could change.

### 3.1 Accounts

`Policy` PDA, seeds `["policy", owner_key_hash, policy_id]`:

```
owner: [u8; 33]              // compressed P-256 key, as the precompile wants it
rp_id_hash: [u8; 32]
network_id: [u8; 32]         // sha256(CAIP-2), fixed at creation
agent_signer: Option<Pubkey>
asset: Pubkey                // USDC mint
recovery: Pubkey             // owner of the token account funds go to in an emergency
frozen: bool
owner_nonce: u64
velocity: VelocityConfig     // max_payment_amount, max_tx_count, max_total_amount, window_size
slots: [PaymentRecord; 16]   // same design as Stellar
merchants: [Pubkey; 8], merchant_count: u8
bump, vault_bump
```

Vault: the USDC associated token account of the Policy PDA. The PDA owns it,
so only the program can move money out.

### 3.2 Instructions

| Instruction | Who | What |
|---|---|---|
| `initialize` | anyone pays | The Stellar constructor. Config validated (`is_valid`), vault created |
| `pay` | agent signs, merchant pays the fee | See 3.3 |
| `freeze_payments`, `restore_payments` | owner passkey | |
| `revoke_agent_signer`, `set_agent_signer` | owner passkey | |
| `add_merchant`, `remove_merchant` | owner passkey | |
| `reduce_limits` | owner passkey | `only_reduces` unchanged |
| `recover_funds` | owner passkey | Frozen accounts only, to the fixed recovery address |

Stellar's `publish_proof` and `extend_ttl` are not needed on Solana. The
design document records why.

### 3.3 Order of checks in `pay` (same as Stellar's `check_payment_authorization`)

1. Refuse if the account is frozen (`AccountFrozen`).
2. `agent_signer` exists and is the transaction signer (`SignerRevoked`, `InvalidBuyerSigner`).
3. The merchant is on the allowlist (`UnauthorizedMerchant`).
4. `asset` is the policy's mint, the destination is `ATA(recipient, mint)` (`AssetNotAllowed`, `SettlementMismatch`).
5. Amount above zero and within `max_payment_amount`.
6. Expiry: not zero, not passed, at most 900 seconds ahead (`Clock` sysvar).
7. The program builds the preimage and both hashes **itself**.
8. Merchant signature: from the instructions sysvar, the previous instruction
   is the Ed25519 precompile, holds a single signature, its offsets point into
   that same instruction, the key is `merchant_pubkey` and the message is the
   `challenge_hash` the program built (`InvalidMerchantSignature`).
9. Count the instructions in the transaction: only compute budget, the
   Ed25519 precompile and a single `pay`. No second `pay` in the same
   transaction. The counterpart of Stellar's "no second transfer in the
   batch".
10. Velocity slots: nonce replay, count, total, and the payment that fills
    the window freezes the account. `velocity.rs` logic unchanged.
11. CPI `TransferChecked`: vault to `ATA(recipient)`, signed by the PDA.
12. Emit the `ProofOfIntent` event (nonce, both hashes, merchant, amount).

Error codes keep the numbers of Stellar's `PolicyError`, so
`policy-errors.ts` produces the same sentence on both chains.

### 3.4 Owner path (passkey)

Every owner instruction arrives as `[secp256r1 precompile, owner instruction]`.

- The challenge the passkey signs:
  `sha256(len ‖ "beaver402:owner:solana:v1" ‖ program_id ‖ policy ‖ instruction_name ‖ args ‖ owner_nonce ‖ valid_until)`
- The program checks that the precompile instruction ran with the `owner`
  key over `authenticatorData ‖ sha256(clientDataJSON)`.
- The checks in `passkey.rs` carry over: rpIdHash, the UP and UV flags,
  `webauthn.get`, the challenge inside clientDataJSON.
- On success `owner_nonce += 1`, so the same signature never passes twice.
- The owner path ignores the frozen flag, as on Stellar.
- The precompile requires low S. `normalizeS` already exists in the backend.

### 3.5 Program tests

Rust tests on LiteSVM. Every one of Stellar's 35 contract tests gets a
Solana counterpart, plus attacks specific to Solana:

- An Ed25519 instruction for another key or another message
- Ed25519 offsets pointing into another instruction
- Two `pay` instructions in one transaction
- The wrong vault, or someone else's policy account
- A token account other than the recipient's ATA
- Replaying an owner signature (`owner_nonce`)
- `pay` where the signer is the fee payer but not the agent

---

## 4. Backend

Principle: first the Stellar code moves behind an interface without changing
behaviour, and the existing 145+ tests pass as they are. Solana comes after
that.

### 4.1 Chain interface

```
backend/src/chains/
  types.ts          ChainAdapter interface, ChainId = "stellar" | "solana"
  registry.ts       which chains are enabled, from the environment
  stellar/          today's code moves here, behaviour unchanged
  solana/
    config.ts       cluster, RPC, CAIP-2, USDC mint, program id, explorer
    encoding.ts     Solana settlement preimage (section 2)
    adapter.ts      agent: builds the pay transaction from a 402, simulates, partially signs
    settlement.ts   merchant: verifies, signs as fee payer, submits, confirms on the ledger
    owner-actions.ts builds the passkey challenge, sends precompile + instruction
    views.ts        reads the Policy account (frozen, limits, slots, merchants)
    collector.ts    getSignaturesForAddress + decoding Anchor events
```

Roughly:

```ts
interface ChainAdapter {
  id: ChainId;
  caip2: string;
  requirementsFor(merchant): PaymentRequirements;
  createChallenge(...): SignedChallenge;
  preparePayment(required, observed): Promise<PreparedPayment>;   // agent
  settle(payload, observed, merchant): Promise<SettledPayment>;   // merchant
  prepareOwnerAction(action, input): Promise<PreparedOwnerAction>;
  submitOwnerAction(prepared, assertion): Promise<{ txHash }>;
  readPolicy(): Promise<PolicyView>;
  explorerTx(hash): string;
}
```

### 4.2 Files that change

| File | Change |
|---|---|
| `config/network.ts` | Becomes `chains/stellar/config.ts`. `BEAVER_NETWORK` stays. New `BEAVER_CHAINS=stellar,solana` |
| `shared/hashing.ts` | Stellar functions unchanged, the Solana preimage goes to `chains/solana/encoding.ts` |
| `shared/types.ts` | Field descriptions become chain neutral. The fields stay the same |
| `adapter/x402-client.ts` | Shared steps 1 to 6 (challenge, merchant signature, intent, expiry) move into a chain neutral function. Step 7, building the transaction, is per chain |
| `merchant/x402-merchant.ts` | The 402 answer carries one `accepts` entry per enabled chain, each with its own challenge: `extensions.beaver402.challenges[caip2]`. An incoming payment is routed by `accepted.network`. The Stellar path keeps the hosted facilitator |
| `merchant/payment-binding.ts` | `bindPaymentToRequest` stays chain neutral, `authorizedTerms` becomes per chain (Stellar: the auth entry, Solana: the `pay` instruction's arguments) |
| `merchant/demo-endpoint.ts` | `MerchantConfig` carries a recipient and asset per chain. Price per chain by decimals: Stellar 1000000 (7 decimals), Solana 100000 (6 decimals), both 0.1 USDC |
| `policy/owner-actions.ts`, `policy/policy-routes.ts` | A `?chain=` parameter, routed to the adapter |
| `agent/paid-fetch.ts`, `agent/agent-routes.ts` | The agent picks a chain by preference (`AGENT_CHAIN_PREFERENCE`). The log records the chain |
| `mcp/server.ts` | Optional `chain` parameter on `fetch_paid_resource` |
| `ops/collector.ts`, `ops/ops-routes.ts` | One collector per chain. The status page shows the chains separately |
| `shared/policy-errors.ts` | Maps Anchor error codes (6000 + code) to the same names |

New dependencies: `@solana/kit` (or `@solana/web3.js`), `@solana-program/token`,
`@solana-program/compute-budget`, a client generated from the Anchor IDL
(Codama).

### 4.3 Supabase

There is already a `network` column. Solana rows store the CAIP-2 there,
Stellar rows stay as they are. Migration 004 adds:

- A `chain text not null default 'stellar'` column on `transactions`, `settled_payments`, `chain_events`, `collector_state`
- The chain in the `collector_state` key (on Solana the cursor is the last signature, not a ledger)
- An updated mainnet verification SQL

### 4.4 Backend tests

- Every existing test passes without any change. This is the acceptance test for the refactor
- `solana-encoding.test.ts`: vectors, identical to Rust
- `solana-adapter.test.ts`: transaction shape, partial signature, fee payer
- `solana-settlement.test.ts`: instruction count and order, a forged Ed25519 instruction, the wrong program, an extra instruction, the wrong fee payer
- `merchant-multichain.test.ts`: two `accepts`, routing to the right chain, a challenge for one chain refused on the other
- `solana-owner-actions.test.ts`: the challenge formula, identical to Rust

---

## 5. Frontend (owner panel)

The panel already works through the backend and does not use the Stellar SDK
directly. The change is small:

- A chain switch at the top (Stellar / Solana), sent as `?chain=`
- Balance, limits, merchants and payments come from the selected chain
- Explorer links per chain (Solana Explorer with `?cluster=devnet`)
- Amounts shown with 6 or 7 decimals
- `stellar-ops.ts` becomes the chain neutral `policy-ops.ts`
- Landing and status pages say "Stellar and Solana" and link the Solana devnet evidence

---

## 6. Scripts and setup

The Solana tools are not installed locally. To install:

- Solana CLI (Anza installer), `cargo-build-sbf`
- Anchor 1.x through `avm` (1.2.0 is current)
- The npm dependencies on the Node side

New scripts:

| Script | What it does |
|---|---|
| `scripts/solana/setup-keys.sh` | Deployer, agent, merchant and fee payer keys; devnet SOL airdrop; writes `.env` |
| `scripts/solana/deploy.sh` | `anchor build` and deploy to devnet, writes the program id to `.env` |
| `backend/scripts/solana-init.ts` | `initialize` with the registered passkey: owner, rp_id, agent, mint, recovery, pilot limits (with 6 decimals: 1 USDC per payment, 5 payments and 5 USDC per 24 hours) |
| `backend/scripts/preflight.ts` | Solana checks: the RPC really is devnet (genesis hash), the program exists, the vault holds USDC, the merchant ATA exists |
| `backend/scripts/scenarios.ts`, `rehearse.ts` | `--chain solana` |

Devnet USDC comes from Circle's faucet (faucet.circle.com, Solana Devnet).
Claude tries it through the browser. If the faucet asks for a captcha or a
sign-in, Emir takes it from there.

---

## 7. Devnet rehearsal and evidence

The Solana counterpart of `docs/operations/rehearsals/2026-10-02-testnet-hosted.md`:

1. Program deployed, policy account created with the passkey
2. Merchant approved with the passkey
3. A successful payment: 402, challenge, intent, `pay`, merchant settlement, ledger confirmation, event
4. A payment started from the MCP tool
5. Eight refusals, each with its own error code: endpoint, body, recipient, amount, replay, expired, unapproved merchant, limit
6. Freeze, a payment refused while frozen, restore
7. Agent revoked, a payment refused after revocation, agent reinstated
8. Recovery
9. The same agent paying the same merchant on Stellar and on Solana (the multi-chain evidence)

Each step goes into `docs/solana/devnet-rehearsal.md` with its Solana
Explorer link.

---

## 8. Documentation

- `docs/solana/design.md`: the lasting version of sections 0 to 3
- `docs/canonical-encoding.md`: the Solana family
- `docs/threat-model.md`: Solana specific threats (precompile introspection, instruction injection, account substitution)
- `docs/known-limitations.md`: no hosted facilitator on Solana, the merchant settles
- `README.md`: "Stellar and Solana", setup steps

---

## 9. Order and acceptance criteria

| Stage | Work | Done when |
|---|---|---|
| 1 | Install the tools, create the `solana/` workspace | `anchor build` works, the root `Cargo.lock` is unchanged, `scripts/build-release.sh` gives the same hash |
| 2 | Backend refactor: Stellar behind `chains/stellar/` | Every existing test passes unchanged, the Stellar testnet rehearsal runs the same |
| 3 | Solana encoding (TS and Rust) and vectors | Both sides produce the same hashes |
| 4 | Anchor program and LiteSVM tests | The Stellar test counterparts and the Solana specific attacks pass |
| 5 | Backend Solana adapter, settlement, owner actions | Unit tests, one payment against devnet |
| 6 | Multi-chain 402 in the merchant, chain choice in the agent, MCP | The same merchant takes payment on both chains |
| 7 | Chain switch in the panel | Freeze, restore and add a merchant on Solana with the passkey |
| 8 | Supabase migration 004, collector, status | The status page shows both chains |
| 9 | Devnet rehearsal and evidence | Every step in section 7 has an explorer link |
| 10 | Docs, README, updated hackathon text | The text matches the running system exactly |

Stage 2 and stages 3 and 4 are independent of each other and can run in
parallel.

---

## 10. Risks and open questions

| Risk | Impact | Response |
|---|---|---|
| No hosted facilitator on Solana | Standard x402 clients cannot pay this merchant on Solana | Documented. A Beaver402 payer already brings its own client, on Stellar too |
| Transaction size (1232 bytes): Ed25519 instruction, `pay` arguments, accounts | The transaction may not fit | Address lookup table or smaller arguments. Measured in the first prototype |
| Compute: scanning 16 slots, two sha256, a CPI | May exceed 200k CU | Set with a compute limit instruction, measured |
| Precompile introspection mistakes | A classic Solana bug: bypassing a signature with a forged Ed25519 instruction | Check the offsets point into the same instruction and there is one signature, with dedicated tests |
| clientDataJSON size in owner actions | Transaction size limit | Measured, an ALT for owner actions if needed |
| Devnet USDC faucet limits | Not enough USDC for the rehearsal | Small limits (0.1 USDC payments), a daily faucet draw is enough |
| Breaking the Stellar RC | The hash with the reviewer becomes invalid | The contract and the root workspace stay untouched, the acceptance criterion for stage 1 |
| The merchant is also the fee payer | The merchant needs SOL | Devnet airdrop, documented |
