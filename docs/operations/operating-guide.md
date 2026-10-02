# Operating guide

How the pilot runs day to day, and how to deploy it.

## What runs where

| Piece | Where | Holds |
|---|---|---|
| Panel, landing page, status page | Vercel, the frontend project | nothing secret |
| Agent backend (`BEAVER402_ROLE=agent`) | Vercel, its own project | agent secret, fee account secret, agent API token, database secret, facilitator key |
| Merchant (`BEAVER402_ROLE=merchant`) | Vercel, its own project | merchant secret, facilitator key, database secret |
| Database | Supabase, one project per network | passkey credentials, sessions, payment log, settlements, events, traffic counts |
| MCP server | the owner's machine | the agent API token |
| Policy account | Stellar | the funds and the rules |

The frontend sends `/api/*` to the agent backend, so the browser sees one
origin, which is the one the owner passkey belongs to.

## Environment

Every variable is described in `backend/.env.example`. On mainnet the
backend refuses to start without the ones that have no safe default:
`SOROBAN_RPC_URL`, `RP_ID` and `ORIGIN`, `AGENT_API_TOKEN` and
`AGENT_ALLOWED_ORIGINS` for the agent, `RECIPIENT_ADDRESS` and
`FACILITATOR_API_KEY` for the merchant. It also refuses anything that
disagrees with the network: a testnet passphrase, RPC, token or facilitator.

## Database

Run, in order, in the Supabase SQL editor of the project for the network:

1. `scripts/supabase-migration.sql`
2. `scripts/supabase-migration-002.sql`
3. `scripts/supabase-migration-003.sql`

Each is safe to run again.

## Deploying the contract

```bash
./scripts/deploy.sh                    # testnet, reads backend/.env
./scripts/deploy.sh --network mainnet  # mainnet, reads backend/.env.mainnet
```

Before it deploys anything the script runs the backend's own configuration
checks, asks the RPC which network it serves, reads the owner passkey, and on
mainnet refuses any artifact but the reviewed one (`EXPECTED_WASM_HASH`) and
waits for the words `deploy to mainnet`. Mainnet also needs
`RECOVERY_ADDRESS`, which cannot be changed later.

After deploying:

1. Approve the merchant in the panel.
2. Fund the account, within the pilot limit.
3. Set `POLICY_CONTRACT_ID` and `POLICY_DEPLOY_LEDGER` in the agent
   deployment.
4. Run the event collector once by hand.
5. Fill in the deployment record.

## Every day

- **Status page.** Payments accepting, agent active, merchant approved, the
  lifetime well above 30 days, the last collection recent and without error.
- **Collector.** Runs on the schedule in `backend/vercel.json`. If the plan
  allows only a daily run, start it by hand after any burst of activity:

  ```bash
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<agent>/api/ops/collect
  ```

## Every week

- Call `extend_ttl` if the status page shows less than 140 days of lifetime.
  Any owner action or published proof does this as well.
- Export the events (`/api/ops/events?format=csv`) into the evidence folder.
- Check the facilitator still lists `exact` on the network
  (`/supported`).

## Limits

The account allows 1 USDC per payment and 5 payments or 5 USDC in any 24
hours, and it is never funded with more than 10 USDC. Check the balance
before funding: `stellar contract invoke --id <USDC> -- balance --id <account>`.

When something goes wrong, follow the [incident procedure](incident-response.md).
