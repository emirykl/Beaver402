# Mainnet pilot log

What was done on the mainnet account, in order, with the result each step
produced. Refused payments leave no transaction, so the agent's answer is
recorded here instead. Times are UTC, 8 October 2026.

Account: [`CBSMQ7LU…FVXL`](https://stellar.expert/explorer/public/contract/CBSMQ7LUZYAAN5P2JAAR74AFNKRZYF32JA4VTX3BFBFDCY4JXF5SFVXL)

| Time | Step | Result | Evidence |
|---|---|---|---|
| 06:56 | Account created with the owner passkey | done | [`f48eeaa4`](https://stellar.expert/explorer/public/tx/f48eeaa4aaf6619d1caa0f467b56284eb5d47f0a335c1d90579af9858a77d077) |
| 07:14 | Merchant approved, passkey | done | [`75e6ba9a`](https://stellar.expert/explorer/public/tx/75e6ba9ae2113ddb01cef0bf37fc099e5236006c411ea38f70cde9556fc273f4) |
| 07:14 | Halt and resume from the panel, passkey | done | [`99c5d648`](https://stellar.expert/explorer/public/tx/99c5d648de39acd0c173ac551b4516724da8c92ca899a46976d758a8cb6fe3d0) |
| 07:21 | Payment of 0.1 USDC from the MCP tool, settled by the OpenZeppelin facilitator, which paid the fee | settled, content released | [`035fdb6d`](https://stellar.expert/explorer/public/tx/035fdb6d1e816eb832168510aac99397e743448302c3e86274479840ee5568c4) |
| 07:21 | Its proof of intent, published by the merchant | done | [`cb59a5ed`](https://stellar.expert/explorer/public/tx/cb59a5ed1335446f3506e40721cde7116a6831be112cbcbb4d56f0151a3c784a) |
| 07:23 | Halt, passkey | done | [`119d9dbf`](https://stellar.expert/explorer/public/tx/119d9dbf8e6676a056c91218e6dab121f0217e4dbef12486a1c07576656a3f2f) |
| 07:24 | Payment from the MCP tool while halted | refused: `AccountFrozen, payments are halted until the owner resumes them` | agent response |
| 07:24 | Resume, passkey | done | [`5db6b018`](https://stellar.expert/explorer/public/tx/5db6b0185416b5f2156d9991dc70b98f51bec324f088126030bbf1b601d03c50) |
| 07:25 | Agent key revoked, passkey | done | [`7a539f58`](https://stellar.expert/explorer/public/tx/7a539f5810ad70e8d61672fe05352a2455d0d0370cbbf021b45d32133422aeb3) |
| 07:26 | Payment from the MCP tool after revocation | refused: `SignerRevoked, the agent key was revoked, so nothing can be paid` | agent response |
| 07:29 | Agent key reinstated, passkey | done | [`4e4bed49`](https://stellar.expert/explorer/public/tx/4e4bed49dce390f5e29385ac4ff5b5ead2e40914f9e10233b2bf09e2bc793767) |
| 07:29 | Second payment from the MCP tool | settled, content released | [`98d4a50a`](https://stellar.expert/explorer/public/tx/98d4a50aff86e6ccca03e2ec51bef337f4425c6ea465c3c8598208325d1db9b9), proof [`7bf2bc08`](https://stellar.expert/explorer/public/tx/7bf2bc08d6504b48e054fc25919acd8d042d94c41580f5085b68052d2321106a) |
| 07:31 | Adversarial scenarios (`scripts/scenarios.ts`) against the mainnet merchant, including requests changed after the merchant signed | two allowed payments settled; the window then held 4 of 5 payments, 0.4 of 5 USDC | settlements [`5fe62168`](https://stellar.expert/explorer/public/tx/5fe621682b5d1c492ac4e64048876fc19775d694b478502bbd3554e7af977c29), [`5da913f9`](https://stellar.expert/explorer/public/tx/5da913f993e97fcc0deb278dd519d632685255fb3525e6294a7bd1afae4cd61e); proofs [`8f790063`](https://stellar.expert/explorer/public/tx/8f7900632f8c129b5132e87f6861eaf2b1254b9f5bd49890735d08126a0a7279), [`486f2f15`](https://stellar.expert/explorer/public/tx/486f2f15c84d7384eb0eaccb613d7f1fd2d8064f47dca737d8e0d95a3ec0d508) |

The payment's merchant challenge hash was
`def0e9a63880cb3370309aef05ced76b71fc51bfeb162bb81feba9517049d578` and
the buyer intent hash `0e875c9e3302a690ae2b9a9498259e13cec3b5eb74617536bdaca2e6fd47bb41`.

Screenshots of each transaction are in [`screenshots/mainnet`](../screenshots/mainnet).
