#!/usr/bin/env bash
# Runs when the codespace opens: sets the merchant up, starts it, makes its
# port public so the account owner's agent can reach it, and prints the two
# things to send the owner.
set -uo pipefail
cd "$(dirname "$0")"

npx beaver402-merchant init </dev/null || { echo "Setup stopped. Run: bash start-codespace.sh"; exit 1; }

npm start &
SERVER=$!

for _ in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:4021/merchant && break
  sleep 1
done

if gh codespace ports visibility 4021:public -c "$CODESPACE_NAME" >/dev/null 2>&1; then
  VISIBLE="yes"
else
  VISIBLE="no"
fi

KEY=$(curl -s http://localhost:4021/merchant | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).merchantPubkey))")
URL=$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)

cat <<MSG

============================================================
 Your paid API is running. Send these two lines to the
 account owner (never send MERCHANT_SECRET from .env):

   Key:     $KEY
   Address: $URL

 What happens next:
   1. <address>/forecast answers 402 Payment Required. That
      means your API is for sale.
   2. The owner approves your key with their passkey. Until
      then their payments are refused; that is expected.
   3. Their agent pays and the request appears below.

 Keep this tab open until the owner says the payment is done.
============================================================
MSG
if [ "$VISIBLE" = "no" ]; then
  echo "One manual step: open the PORTS tab below, right click port 4021,"
  echo "choose Port Visibility > Public. Otherwise the owner cannot reach you."
fi

wait $SERVER
