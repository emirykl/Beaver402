# Replacing the account

The pilot contract cannot be upgraded. That is deliberate: an upgrade entry
point would let whoever holds it replace every rule the owner is relying on.
Changing the rules therefore means creating a new account and moving to it.
This is the procedure, and it is rehearsed on testnet before it is ever
needed on mainnet.

## When

- A defect in the contract.
- A limit has to go up. Limits can only be lowered on an existing account.
- The panel has to move to another domain. The owner passkey belongs to the
  domain it was registered on, and the account checks that domain.
- The account is no longer trusted after an incident.

## Steps

1. **Halt the old account.** No payment can settle during the move.
2. **Revoke the old agent key.** The old account can then sign nothing at all.
3. **Recover the funds.** RECOVER FUNDS sends the whole balance to the old
   account's recovery address.
4. **Preserve the evidence.** Collect and export the old account's events.
   Record the final state in the deployment record: contract id, final
   balance, the recovery transaction.
5. **Prepare the new account.** If the code changed, it goes through the
   same review and readiness checklist as the first release. Register the
   owner passkey on the panel's domain.
6. **Deploy** with `scripts/deploy.sh`, which checks the configuration, the
   passkey and, on mainnet, that the artifact is the reviewed one.
7. **Approve the merchant again** with the passkey. The new account starts
   with no merchant.
8. **Point the deployments at it.** Set `POLICY_CONTRACT_ID` in the agent
   deployment, redeploy, and check `/api/config` and `/status` show the new
   account.
9. **Fund it** from the recovery address, within the pilot limit.
10. **Run the scenarios** against the new account before resuming.
11. **Record it**: a new section in the deployment record linking the old
    account, the recovery transaction and the new account.

The old account stays on the ledger, halted, revoked and empty. It is never
deleted, so its history remains checkable.

## Rehearsal

The rehearsal runs the steps above on testnet, from a funded account with
the merchant approved to a new account that has completed a payment. The
record of the rehearsal, with every transaction, goes in
`docs/operations/rehearsals/`.
