# roblox-group-payout

Reliably pay outstanding Roblox group balances. This is used by [BIRD](https://bird.games) to pay 500+ creators 100k+ robux every week.

The balance-based model acknowledges that some payments will inevitably fail (ineligible users, API errors, rate limits). Instead of "pay these exact amounts", the contract is "here are outstanding balances, clear as many as you can". Persist the returned balances and re-run to retry.

This library handles the operational complexities of Roblox payouts (auth challenges, eligibility, batching, retries, and partial-failure tracking).

See `ARCHITECTURE.md` for security model, internals, and design rationale.

## Current Crash Recovery Limitation

Example failure: you start a run for 400 recipients, 160 payouts succeed, then the machine crashes. At that point, some recipients are already paid and others are not. This library does not currently persist state to resume the payout where it left off.

## Install

Not published on npm. Install from GitHub (Node 18+):

```bash
npm install BouyertheDestroyer/roblox-group-payout
```

---

## Usage

Setup once (credentials stored on disk; cookie rotation saved automatically). Then call the library with your balances.

**Setup:** `npx roblox-group-payout setup` — use an alt account, enable 2SV, join group, grant **Spend Group Funds**.

**2SV code:** `npx roblox-group-payout code` — prints current 6-digit code, in case you ever need it.

**Test run:** `node example-pay-50-members-one-robux.js` — pays 50 group members 1 R$ each.

**From code:**

```js
const { payBalancesFromConfig } = require('roblox-group-payout');

const result = await payBalancesFromConfig({
  balances: { "111": 500, "222": 300, "333": 200 }, // userId (string) → robux (int)
});
result.paid.forEach(({ recipientId, amount }) => console.log(`Paid ${recipientId}: ${amount}`));
result.failed.forEach(({ recipientId, amount }) => console.log(`Failed ${recipientId}: ${amount}`));
result.ineligible.forEach(({ recipientId, amount }) => console.log(`Ineligible ${recipientId}: ${amount}`)); // too new to group
```

---

## Manage your own credentials

Use this when you supply credentials yourself instead of the CLI config files.

```js
const { payBalances } = require('roblox-group-payout');

const result = await payBalances({
  cookie: "_|WARNING:-DO-NOT-SHARE-THIS--Roblox-Security-Cookie-...a1b2c3d4e5f6",     // string
  groupId: 12345678,            // number
  payerUserId: 99999,           // number
  totpSecret: "JBSWY3DPEHPK3PXP", // string (Base32)
  balances: { "111": 500, "222": 300, "333": 200 }, // userId (string) → robux (int)
  onCookieRotated: (newCookie) => { /* persist newCookie for future runs */ },
});
result.paid.forEach(({ recipientId, amount }) => console.log(`Paid ${recipientId}: ${amount}`));
result.failed.forEach(({ recipientId, amount }) => console.log(`Failed ${recipientId}: ${amount}`));
result.ineligible.forEach(({ recipientId, amount }) => console.log(`Ineligible ${recipientId}: ${amount}`)); // too new to group
```
