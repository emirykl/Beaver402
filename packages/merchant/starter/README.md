# Your Beaver402 merchant, in the browser

This codespace sets up a paid API on Stellar testnet by itself. Everything
on testnet is free.

When it opens, the terminal at the bottom runs the setup and ends with a box
like this:

```
 Key:     G...
 Address: https://....app.github.dev
```

1. Send those two lines to the account owner who asked you to try this.
   Never send anything from `.env`: `MERCHANT_SECRET` there is your
   merchant's private key.
2. Keep this tab open. The owner approves your key and their agent pays
   your API. Each paid request shows up in the terminal.
3. Open `server.ts` to see the two paid routes: `GET /forecast` at 0.1 USDC
   and `POST /summarize` at 0.2 USDC. `merchant.protect()` is all it takes
   to put a route behind a payment.

If the terminal stopped or you closed it, run `bash start-codespace.sh`.

The full guide: [packages/merchant](../README.md).
