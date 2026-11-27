# Independent developer setup: notes and what changed

The developer had not contributed to Beaver402. They set a testnet merchant
up from the published guide, through its "Open in GitHub Codespaces" route,
on 27 November 2026, and took a payment from the builder's agent after the
owner's passkey approval. The run itself is in the
[evidence](evidence.md#independent-developer-run-on-testnet-27-november-2026).
The notes below are the developer's written answers, translated from Turkish
and shortened; nothing identifying is kept.

## What they reported

| Question | Answer |
|---|---|
| How long did it take? | About 11 minutes from creating the codespace to the first `402 Payment Required`, and about 13 minutes until both example routes were checked. GitHub's authorization screen at the start is not counted. |
| Where did you get stuck? | The codespace opened, but checking it with the GitHub CLI failed with an SSH server error; opening it in the browser worked. Port 4021 started private and they made it public by hand. No step of the setup itself was unclear. |
| What could the guide do better? | The difference between the key and the secret key is clear, and the port step is written down. The "about two minutes" estimate did not hold. A short troubleshooting note for GitHub's authorization screen and the CLI's SSH error would help. The owner's approval, between the first 402 and the completed payment, could be shown more clearly. |
| Would you use it in your own API? | Before using it for real, they would want an independent security audit, a passkey recovery plan, and a simpler example that shows a first payment end to end. |

What they checked on their own server: `/merchant` answered 200, `GET /forecast`
and `POST /summarize` answered 402, and three faulty payment attempts were
refused.

## What changed, in `merchant-v0.1.0`

| Feedback | Change |
|---|---|
| "About two minutes" did not hold | The guide now says about ten minutes the first time and why, and that GitHub's authorization screen comes on top |
| Owner approval not visible enough | The guide's Codespaces section lists the six steps in order, with the passkey approval as its own step; the codespace's terminal box and its README say the 402 means the API is for sale and that payments are refused until the owner approves |
| No help for the authorization screen and the SSH error | A new [Codespaces section](../../packages/merchant/docs/troubleshooting.md#codespaces) in troubleshooting covers build time, the authorization screen, the SSH error, private ports, a 402 with no payment yet, and a stopped codespace |

Port 4021 still has to be made public by hand. The setup tries
`gh codespace ports visibility`, but the token a codespace receives cannot
change port visibility, so the guide and the terminal ask for the one manual
step instead.

## What is left for later

The answer to the last question is a list of adoption conditions rather
than guide fixes: an independent security audit, a passkey recovery plan and
a simpler end to end example. They go to the final report as adoption
barriers.
