# Third month final report

Instawards, third period, November 2026. This report covers the merchant
integration kit, the independent developer setup, the three customer
conversations, the second merchant on mainnet, the collector alert tests,
the improvement made in response to feedback, public communication, and the
resulting pilot decision. Each statement links to its evidence; the full
index is in [evidence.md](evidence.md).

## Summary

- **The kit works without the builder.** A developer who had not contributed
  to Beaver402 set up a merchant from the published guide in about 11
  minutes, without help, and received a testnet payment after the owner's
  passkey approval. The merchant kit was released as
  [`merchant-v0.1.0`](https://github.com/emirykl/Beaver402/releases/tag/merchant-v0.1.0)
  with the changes that the developer's notes called for.
- **A second merchant was paid on mainnet under the same limits.** It was
  approved with the owner's passkey and received 0.1 USDC, with a Proof of
  Intent and a matching collector record. The limits were unchanged.
- **The protection is understood and valued.** All three conversation
  participants found the core controls convincing. None was ready for
  production use.
- **The strongest adoption barrier is trust for real funds:** there is no
  independent security audit and no way to recover from a lost owner
  passkey. Two of four respondents named both conditions.
- **Demand is not yet shown.** No pilot partner application or developer
  inquiry was received during the period. Interest expressed in
  conversations is recorded separately from willingness to pay, which was
  not established.

## 1. Merchant integration kit

`@beaver402/merchant` puts an Express route behind an x402 USDC payment with
Proof of Intent. Five release candidates preceded the final release; each
was installed from its release URL into an empty project.

| Release | Change |
|---|---|
| `rc.1` | First release: challenge signing, payment checks, ledger confirmation, settlement stores, Proof of Intent |
| `rc.2` | A settlement store for hosts without a lasting disk, and a Vercel deployment, used for the second mainnet merchant |
| `rc.3` | One command testnet setup (`beaver402-merchant init`) and a guide rewritten for a first-time developer, after the builder's [newcomer review](guide-review.md) |
| `rc.4` | A GitHub Codespaces route: no local installation and no tunnel |
| `0.1.0` | The independent developer's feedback applied (section 3) |

The kit has 84 automated tests. A payment through the kit's example, with a
query and with a request body, settled on testnet with linked Proofs of
Intent, and changed requests, other recipients and unapproved merchants were
refused ([evidence, D1](evidence.md#d1-merchant-integration-kit-and-developer-guide)).

## 2. Independent developer setup

On 27 November 2026 a developer who had not contributed to the project
followed the guide's Codespaces route on a computer other than the builder's.
The codespace ran under the builder's GitHub account, which was signed in on
that computer. The developer completed the setup without help and made the
port public by hand, as the terminal instructed.

| Measure | Result |
|---|---|
| Time to the first `402 Payment Required` | about 11 minutes |
| Time until both example routes were checked | about 13 minutes |
| Help given by the builder | none |
| Payment before the owner's approval | refused by the policy, nothing settled |
| Payment after the owner's passkey approval | 0.1 test USDC settled: [settlement](https://stellar.expert/explorer/testnet/tx/7f6cb9c23e737cb659c13807cfd6cebe051577744fc3717fe8461efce71e41e7), [Proof of Intent](https://stellar.expert/explorer/testnet/tx/05df29b3e2c4f8e0f24b14625786f18c80d96c271cee74e6e83e4f25d3a719a0) |

Difficulties reported: an SSH error when checking the codespace from the
GitHub CLI, a port that started private, an estimate of two minutes that did
not hold, and an owner approval step that was easy to miss. The full notes
are in [developer-feedback.md](developer-feedback.md).

## 3. Improvement made in response to feedback

Released in `merchant-v0.1.0`
([commit `632b346`](https://github.com/emirykl/Beaver402/commit/632b346)):

- The guide gives a realistic duration, about ten minutes the first time,
  and lists the six steps in order, with the owner's passkey approval as a
  step of its own between the first 402 and the completed payment.
- The codespace's terminal explains what follows the first 402: the API is
  for sale, and payments are refused until the owner approves the key.
- A Codespaces section in troubleshooting covers build time, GitHub's
  authorization screen, the CLI's SSH error, private ports, a 402 with no
  payment yet, and a stopped codespace.

The port still has to be made public by hand, because the token available
inside a codespace cannot change port visibility.

## 4. Customer conversations

Three online conversations over Google Meet, summarized without names in
[interviews.md](interviews.md).

| | Role | Date | Decision |
|---|---|---|---|
| A | IT specialist, fintech company | 13 November 2026 | A limited value security trial; no production approval |
| B | Team lead, SaaS company | 15 November 2026 | A pilot on one workflow; wider use needs team controls and more flexible policies |
| C | Developer, API company | 17 November 2026 | A testnet trial of the Express integration before estimating production work |

The shared priority was an easier first completed payment, followed by
team level controls and passkey recovery.

## 5. Participant follow-up

The consented follow-up video with a second period participant, and its
comparison note, are not yet complete. They will be added to the
[evidence index](evidence.md#d3-developer-validation-and-public-communication)
when recorded. This report does not draw conclusions from them.

## 6. Second merchant on mainnet

A second merchant was deployed from the kit's release at
`https://beaver402-merchant-2.vercel.app` and operated by the builder. The
refusal of an unapproved merchant was shown on testnet, as the scope
provides.

| Step | Link |
|---|---|
| Owner approval with the passkey | [`6512938a`](https://stellar.expert/explorer/public/tx/6512938a70160da4b2868f31ba0d31bf480e1764a8fdff62e30cd2cf185964b0) |
| 0.1 USDC settlement by the OpenZeppelin facilitator | [`23812035`](https://stellar.expert/explorer/public/tx/238120350b217d6c5e018b04f7dfdc1348b4f236663a191a1164ffa3c49d87da) |
| Proof of Intent | [`a900dfc4`](https://stellar.expert/explorer/public/tx/a900dfc4bcbb497bdd307ebbc01ae35898137025103b39350732badbacb030a6) |
| Collector record | ledger 65702372, the transfer of 1,000,000 units in `23812035`; ledger 65702374, `poi/verified` in `a900dfc4` |

The limits read back unchanged after the approval: at most 1 USDC per
payment, and at most 5 payments and 5 USDC in any 24 hours. Approving a second
merchant did not create a separate allowance. On 28 November 2026 the
account held 0.2 USDC and was not halted.

The approval transaction cost 12.05 XLM, almost all of it storage rent for
extending the account and its code. This is recorded as finding I21 in
[docs/security/findings.md](../security/findings.md).

## 7. Collector alerts

| Test | Result |
|---|---|
| Rehearsal, 27 November 2026 | three emails sent: collector failed, collector recovered, gap in the ledger history; repeated conditions were not emailed again ([alerts](../operations/alerts.md#rehearsal)) |
| Unplanned, 27 November 2026, mainnet | the first manual mainnet run failed and raised the `collector_failed` alert by email. The cause, a per call limit of the RPC provider, was fixed in `dd608c3` and the pilot events were backfilled (finding I20) |

The received emails are kept with the submission.

## 8. Public communication

The [Beaver402 X account](https://x.com/Beaver402) is linked from the landing
page, together with a pilot partner application route.

| Post | Date (Türkiye time) | Link |
|---|---|---|
| Project and audience, thread | 28 November 2026, 00:59 | [post](https://x.com/Beaver402/status/2126435283730096333) |
| Payment risk example | 28 November 2026, 03:00, scheduled | to be recorded |
| Mainnet pilot evidence | 28 November 2026, 05:00, scheduled | to be recorded |
| Owner passkey controls | 28 November 2026, 07:00, scheduled | to be recorded |
| Merchant integration guide | 28 November 2026, 09:00, scheduled | to be recorded |
| Third month results and pilot invitation, thread | 28 November 2026, 03:29 | [post](https://x.com/Beaver402/status/2126473459673022507) |

A further post reported the project's presentation at Stellar Builder Day
İzmir on 26 November 2026. Views and engagement will be recorded in the
[evidence index](evidence.md) once the posts have been live for several days.

### Inquiry summary

| Channel | Inquiries during the period |
|---|---|
| Pilot partner application (GitHub issue form) | none |
| GitHub issues | none |
| Replies and messages on X | none recorded at the time of writing |
| Landing page | 9 page views and 61 owner panel views between 4 and 27 November 2026, from the site's aggregate report; most panel views are the builder's own testing |

Post views without relevant visits or inquiries are not treated as evidence
of demand.

## 9. Hypotheses

Verdicts are **supported**, **partly supported** or **unresolved**. The
sample is small, three conversations and one observed setup, and the
verdicts are limited to it.

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Teams recognize a meaningful difference between a valid payment and the request and merchant terms the owner approved | **Supported** | All three participants found the protection convincing; participant A said it answers the concern that an agent could pay for a request it did not intend. How teams check this difference today was not recorded in enough detail to compare with current alternatives |
| H2 | The merchant signed challenge and independently built buyer intent form a useful trust model, practical for another API operator | **Supported** | Participant A valued the merchant signed request; the independent developer set up a merchant from the guide without help and took a payment |
| H3 | Passkey control is understandable, and a second merchant is not mistaken for higher limits | **Partly supported** | Participant A found halting, revoking the agent key and removing a merchant clear, and the panel showed both approval states with unchanged limits. No participant was asked directly whether a second merchant raises the allowance, so that half remains untested with users |
| H4 | Public mainnet evidence for a second merchant makes technical evaluation easier than testnet alone | **Unresolved** | The evidence exists and is public. No participant cited it as the reason for their decision; they named what is missing instead: an audit, passkey recovery and team controls |
| H5 | A target developer can understand and test the integration within one observed session, and the X posts reach relevant developers | **Partly supported** | The setup took about 11 minutes in one session, without help. The X posts have not yet produced relevant visits or inquiries |

## 10. Strongest adoption barrier

**For real funds, the barrier is trust in the account's safety:** there is no
independent security audit and no way to recover from a lost owner passkey.
Participant A and the independent developer named both as conditions for real
use. The project has had an AI assisted technical review, not a formal audit.
The account's recovery path moves funds to a fixed address but does not
replace a lost owner passkey.

For a first trial, the barrier was the number of steps before a first
completed payment. Participant C and the independent developer named it, and
this period's releases reduced it for testnet.

For teams, the barrier is policy flexibility: separate budgets per agent and
merchant, roles, usage reports, and limits that can be changed without a new
account (participant B).

## 11. Pilot decision

- **Continue the limited pilot; do not broaden mainnet availability.** The
  mainnet account stays at the current limits with builder funded USDC.
  Other teams are invited to try the kit on testnet and apply as technical
  pilot partners through the landing page.
- **Next product change: owner passkey recovery.** Allow a second owner
  credential, or a time delayed recovery of owner control, so that a lost
  device does not leave the account without an owner. It is the barrier
  that the project can remove itself; an external audit should follow it,
  so that the audit covers the recovery design as well.
- **After that:** an end to end payment example that a newcomer can run in
  one command, then team level budgets and roles if pilot partners ask for
  them.
- **Remaining security and operational work:** an external security audit
  before any wider mainnet use; monitoring of storage rent costs (I21); the
  open dependency audit allowlist in CI; and longer running reliability of
  the collector. Willingness to pay and a commercial model were not tested
  this period and remain open.

Technical success and evidence of customer demand are assessed separately.
The technical deliverables were completed; demand beyond conversation
interest has not yet been shown.

## Evidence index

| Deliverable | Where |
|---|---|
| Final tagged release | [`merchant-v0.1.0`](https://github.com/emirykl/Beaver402/releases/tag/merchant-v0.1.0) |
| Guide, configuration, troubleshooting | [packages/merchant](../../packages/merchant/README.md) |
| Independent developer setup and notes | [evidence](evidence.md#independent-developer-run-on-testnet-27-november-2026), [developer-feedback.md](developer-feedback.md) |
| Improvement from the feedback | [developer-feedback.md](developer-feedback.md#what-changed-in-merchant-v010), commit `632b346` |
| Three anonymized conversation summaries | [interviews.md](interviews.md) |
| Second merchant on testnet and mainnet | [evidence, D2](evidence.md#d2-second-merchant-and-mainnet-operations) |
| Collector comparison and alert tests | [evidence, D2](evidence.md#d2-second-merchant-and-mainnet-operations), [alerts](../operations/alerts.md) |
| X posts and inquiry summary | section 8 |
| Participant follow-up video and comparison note | pending |
