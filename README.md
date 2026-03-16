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

Run setup once, then call the library with your balances. Credentials (cookie, groupId, payer user ID, TOTP secret) are read from disk; cookie rotation is saved automatically.

### Setup (one-time)

```bash
npx roblox-group-payout setup
```

Paying account setup (alt recommended): enable 2-Step Verification, join the payout group, grant **Spend Group Funds**. The CLI stores cookie and config in the library directory.

### Generate 2SV code (optional)

```bash
npx roblox-group-payout code
```

Prints the current 6-digit 2SV code (e.g. for manual login). The library uses the stored TOTP secret for automatic 2SV during payouts.

### Try a small test payout (optional)

```bash
node example-pay-50-members-one-robux.js
```

Pays up to 50 group members 1 Robux each. Asks for confirmation before executing. Use it to verify credentials before integrating.

### Call the library from your code

```js
const { payBalancesFromConfig } = require('roblox-group-payout');

const result = await payBalancesFromConfig({
  balances: { "111": 500, "222": 300, "333": 200 }, // userId (string) → robux (int)
});

// paid / failed / ineligible — same shape; persist non-paid and re-run to retry
console.log(`Paid: ${result.paid.length}, Failed: ${result.failed.length}, Ineligible: ${result.ineligible.length}`);
```

Persist remaining balances (e.g. zero out `result.paid`, keep the rest) and re-run to retry unpaid users.

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
// result: { paid, failed, ineligible } — same shape as above
```
