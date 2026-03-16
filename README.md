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

## CLI

The CLI is for **credential setup and 2SV codes only**. It does not run payouts. Payouts are done by your code calling the library (or by running the example script to try a small test).

### Setup (one-time)

```bash
npx roblox-group-payout setup
```

Paying account setup (alt recommended): enable 2-Step Verification, join the payout group, grant **Spend Group Funds**. The setup stores cookie and config (groupId, payer user ID, TOTP secret) in the library directory.

### Generate 2SV code

```bash
npx roblox-group-payout code
```

Prints the current 6-digit 2SV code (e.g. for manual login). The library uses the stored TOTP secret for automatic 2SV during payouts.

### Example: small test payout

To see the library run a real payout before integrating into your app:

```bash
node example-pay-50-members-one-robux.js
```

This pays up to 50 members of your group 1 Robux each (requires `setup` to be done). It asks for confirmation before executing. Use it to verify credentials and debug issues on a small run.

## Library Usage

```js
const { payBalances } = require('roblox-group-payout');

const result = await payBalances({
  cookie: process.env.ROBLOSECURITY,
  groupId: 12345678,
  payerUserId: 99999,         // alt account with "Spend Group Funds" permission
  totpSecret: 'JBSWY3DPEHPK3PXP',
  balances: {
    "111": 500,
    "222": 300,
    "333": 200,
  },
  onCookieRotated: (newCookie) => {
    // Persist the new cookie however you want
    saveToDatabase(newCookie);
  },
});

console.log(`Paid: ${result.paid.length}`);
console.log(`Failed: ${result.failed.length}`);
console.log(`Ineligible: ${result.ineligible.length}`);

// Persist remaining balances and re-run to retry unpaid users
```

To load credentials from the same files as the CLI (cookie + config on disk), use `payBalancesFromConfig({ balances })` instead of `payBalances()`.

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `cookie` | string | Yes | `.ROBLOSECURITY` cookie for the alt account |
| `groupId` | number | Yes | Roblox group ID to pay from |
| `payerUserId` | number | Yes | Roblox user ID of the paying account (alt) initiating payouts |
| `totpSecret` | string | Yes | Base32-encoded TOTP secret for automatic 2SV |
| `balances` | object | Yes | Map of `{ userId: amount }` -- outstanding robux owed |
| `onCookieRotated` | function | No | Called with new cookie string when Roblox rotates it |

### Return Value

```js
{
  paid: [],        // Payments that succeeded ({ recipientId, amount })
  failed: [],      // Payments that were eligible but the API call failed
  ineligible: [],  // Payments skipped (user not eligible for group payouts)
}
```

## License

MIT
