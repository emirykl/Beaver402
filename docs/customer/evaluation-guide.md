# Technical evaluation guide

Two structured evaluations with target users, one of them recorded with
consent. Each session tests the five hypotheses in the customer development
plan, and every observation is written down against the hypothesis it bears
on.

| | Participant | Role | Session |
|---|---|---|---|
| A | founder | decides whether a team adopts a payment safety layer | structured evaluation, notes only |
| B | builder | would integrate it | structured evaluation and recorded product session |

About 45 minutes each. Use the same questions in the same order with both,
so the answers can be compared.

## Before the session

- Send the consent text ([consent.md](consent.md)) a day ahead. For B, confirm
  the recording consent in writing and again on the recording.
- Have open: the landing page, the status page, the owner panel signed in,
  the MCP tool ready, an explorer tab.
- Fill the header of a copy of [notes-template.md](notes-template.md).

## Part 1: the problem (10 minutes, both)

Tests H1: teams using delegated x402 payments see a gap between a payment the
protocol accepts and the one the owner approved.

1. How do you, or would you, let software pay for an API on its own today?
2. Who holds the key that pays, and what stops it paying for the wrong thing?
3. Has anything paid, or nearly paid, for something nobody meant? What
   happened?
4. If an agent's request were rewritten after the price was agreed, how would
   you find out?

Do not explain Beaver402 before these four are answered.

## Part 2: the model (10 minutes, both)

Tests H2: a merchant signed challenge combined with an independently built
buyer intent is a more credible model than binding on the buyer side alone.

Show the landing page's "How it works". Then:

5. In your own words, what has to be true before the account pays?
6. What does the merchant's signature add, compared with the agent alone
   deciding what it is paying for?
7. Would you, as a merchant, sign every 402 answer like this? What would stop
   you?

## Part 3: the product (15 minutes, B recorded; A walks through it)

Tests H3 (the owner controls are understandable and fast enough) and H5 (the
integration can be evaluated in one session).

Tasks, in order. Say the task, then watch; help only when asked, and note
where help was needed.

| # | Task | Watch for |
|---|---|---|
| T1 | Find out from the landing page what this product does. | time to a correct summary |
| T2 | Make a paid request with the MCP tool and read what came back. | does the price, recipient and transaction make sense |
| T3 | Find that payment on the explorer. Show the transfer and the proof of intent. | can the two be connected |
| T4 | On the status page, how much of today's budget is left? | read correctly or not |
| T5 | Something looks wrong. Stop all payments. | time from the request to the halt |
| T6 | Try a payment while halted. Why was it refused? | is the reason understood |
| T7 | Take the agent's key away, then give it back. | does the difference from halting come across |
| T8 | Where would the money go if you recovered it, and when is that possible? | read from the panel or the docs |
| T9 | Open the repository. How would you put this in front of your own API? | where they look, where they stop |

## Part 4: adoption (10 minutes, both)

Tests H4: public mainnet evidence raises confidence more than testnet
evidence alone. Then the open questions.

10. Does it change anything for you that this runs on mainnet with real
    USDC, rather than testnet? Why?
11. What would you need to see before using it with your own money?
12. What is missing for your team to try it?
13. If this were a product, would it be a library you run, a service, or
    something else? Would anyone pay for it?

## After the session

Within a day, while it is fresh:

- Finish the notes. Quote where possible; mark interpretations as such.
- For each hypothesis, write what was observed that supports it, contradicts
  it, or neither.
- Note every place the participant was confused or needed help. Those are
  the candidates for the product or documentation change.
- For B, list the timestamps of T1 to T9 in the recording.

When both sessions are done, fill in
[hypothesis-results.md](hypothesis-results.md) and pick at least one change
the evidence supports. Make it, and link the commit.
