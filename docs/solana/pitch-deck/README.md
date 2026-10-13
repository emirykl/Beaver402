# Beaver402 Solana pitch deck

Fourteen 16:9 slides. Open `index.html` in a browser and use the arrow keys or the
on-screen controls. The PDF is ready to present or import into Canva.

## Slides

1. Cover
2. Problem
3. Solution
4. Flow: owner sets policy and funds the vault
5. Flow: AI agent requests the API
6. Flow: merchant returns a signed 402 offer
7. Flow: agent checks the offer and signs the payment
8. Flow: merchant co-signs and submits
9. Flow: Beaver402 policy checks and settles on Solana
10. Solana architecture
11. Product evidence: Solana devnet owner approval and finalized USDC payment
12. Solana market
13. Proposed business model
14. Team

The copy describes a Solana devnet build with a completed end-to-end payment.
It does not claim a Solana mainnet deployment. Slide 11 shows the owner's
merchant approval in the devnet panel and the finalized payment in Solana
Explorer. The agent fetched a protected API resource for 0.10 devnet USDC.
Settlement transaction:
`4cnJExiJgLtVpkE5mLcfa6TzRLKUumhTrkW9C3NkT9b9PzDAmC1AXMNacnfsh6waxbiE7Spd5cu5Kwtbxu5R9D3b`.

## Assets

- `assets/beaver402-mark.png` is the existing project logo from
  `frontend/public/beaver402-mark.png`.
- `assets/stellar-mark.svg` and `assets/solana-mark.svg` use the existing
  code-native brand marks from `frontend/src/chain-logos.tsx`.
- `assets/emir-yenikale.jpeg` is the photo supplied by Emir for the team slide.
- `assets/role-owner.svg`, `assets/role-agent.svg`, and
  `assets/role-merchant.svg` are editable vector illustrations created for the
  payment sequence. The four actors appear in six chronological steps.
- `assets/cover-background.png` was generated with the built-in imagegen tool
  for this deck. The text, arrows, diagrams and cards are editable HTML/CSS.
- `assets/solana-devnet-owner-approved.png` is the owner's screenshot of the
  live Solana devnet panel immediately after passkey merchant approval.
- `assets/solana-devnet-payment-explorer.png` is a screenshot of the finalized
  payment transaction in Solana Explorer.

The market slide cites the Solana Foundation's
[July 2026](https://solana.com/news/solana-ecosystem-roundup-july-2026) and
[August 2026](https://solana.com/news/solana-ecosystem-roundup-august-2026)
ecosystem reports. The 35M+ figure counts cumulative Solana x402 transactions
as of July; the 5.4M figure is BlockRun payments through PayAI during one week
in August. These figures do not measure the share of agent payments with errors.

The business-model slide includes the founder-provided $10,000 grant amount.
It separates that support from proposed revenue. There is no Beaver402 platform
fee in the current devnet payment code. The Solana merchant pays the network
fee; a subscription and usage-tier model would need commercial implementation
and pricing before it can be presented as live revenue.

Final image prompt:

> Use case: productivity-visual. Asset type: premium 16:9 pitch deck background
> for Beaver402, a security layer for AI agent payments on Solana. Create a
> sophisticated abstract visual background only, to sit behind editable
> presentation text and the existing beaver shield logo. Almost black charcoal
> fading into deep espresso brown, with an elegant sculptural ribbon or curved
> topographic form on the right half, subtly evoking a secure payment path and
> a protective shield silhouette. Restrained warm copper and amber edge
> lighting, subtle grain and atmospheric depth. Keep the left 55% dark,
> uncluttered and empty for large white headings. High-end 3D editorial
> illustration, matte ceramic and brushed metal. Palette: #08090B, #17100D,
> #382113, #B8753A, #E8A849. No text, letters, numerals, logos, animals,
> coin symbols, watermarks, UI widgets, bright purple, bright blue, generic
> blockchain hexagons or circuit boards.
