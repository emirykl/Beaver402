# Screenshots

Frames taken from the demo recording, at the moments each claim is visible on
screen. Timestamps refer to the video. They come from the uncaptioned master,
so no subtitle or section card covers the screen.

| # | File | At | What it shows |
|---|---|---|---|
| 1 | `01-sign-in-screen.png` | 0:20 | The control panel asks for a passkey, not a password |
| 2 | `02-touch-id-prompt.png` | 0:39 | Owner identity is a WebAuthn assertion from device hardware |
| 3 | `03-console-armed.png` | 0:46 | Policy state read from the deployed contract: armed, agent authorized, budget |
| 4 | `04-agent-asks-permission.png` | 1:22 | The agent has to ask before it can call the paying tool |
| 5 | `05-agent-paid.png` | 1:52 | The agent paid and got the content: transaction, challenge hash, intent hash, no key |
| 6 | `06-settlement-in-panel.png` | 2:12 | The payment appears to the owner as settled, with amount and UTC time |
| 7 | `07-transaction-on-explorer.png` | 2:25 | The same payment on a public explorer, out of the policy account |
| 8 | `08-touch-id-during-halt.png` | 2:37 | Every owner action is authorized by the passkey |
| 9 | `09-console-halted.png` | 2:46 | The owner halted payments on chain |
| 10 | `10-account-frozen-refusal.png` | 3:16 | The agent is refused with `AccountFrozen`, named by the contract |
| 11 | `11-console-armed-again.png` | 3:46 | A frozen account can still accept the call that thaws it |
| 12 | `12-agent-revoked.png` | 4:21 | The delegated agent signer was revoked on chain |
| 13 | `13-signer-revoked-refusal.png` | 4:38 | The revoked key is refused with `SignerRevoked` |
| 14 | `14-agent-authorized-again.png` | 5:02 | Revocation is reversible, so it cannot brick the account |
| 15 | `15-adversarial-scenarios.png` | 5:44 | Eight adversarial cases against the deployed contract: 8 scenarios, 0 unexpected |
| 16 | `16-contract-tests.png` | 5:58 | Contract test suite: 35 passed |
| 17 | `17-backend-tests.png` | 6:02 | Backend test suite: 145 passed |
| 18 | `18-contract-on-chain.png` | 6:32 | The whole demo on the contract itself: transfers, `freeze_payments`, `restore_payments`, `revoke_agent_signer`, `set_agent_signer` |
