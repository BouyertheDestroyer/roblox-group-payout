# roblox-group-payout

Reliably pay outstanding Roblox group balances. This is used by [BIRD](https://bird.games) to pay 500+ creators 100k+ robux every week.

The balance-based model acknowledges that some payments will inevitably fail (ineligible users, API errors, rate limits). Instead of "pay these exact amounts", the contract is "here are outstanding balances, clear as many as you can". Persist the returned balances and re-run to retry.

This library handles the operational complexities of Roblox payouts (auth challenges, eligibility, batching, retries, and partial-failure tracking).

See `ARCHITECTURE.md` for security model, internals, and design rationale.

## Current Crash Recovery Limitation

Example failure: you start a run for 400 recipients, 160 payouts succeed, then the machine crashes. At that point, some recipients are already paid and others are not. This library does not currently persist state to resume the payout where it left off.

## Install

Not published on npm. Install from GitHub:

```bash
npm install BouyertheDestroyer/roblox-group-payout
```

## CLI Usage

The CLI uses the helper modules for credential storage.

### Setup (one-time)

```bash
npx roblox-group-payout setup
```

#### Paying account setup (alt recommended)

1. Enable 2-Step Verification and paste the authenticator setup code into the setup CLI.
2. Join the payout group.
3. Grant **Spend Group Funds** permission.

The setup command will store credentials in plain-text files in the library directory.

### Pay balances

```bash
npx roblox-group-payout pay --balances balances.json
```

The `balances.json` file:

```json
{
  "111": 500,
  "222": 300
}
```

After execution, the file is updated in-place with remaining balances. Re-run the same command to retry any unpaid balances.

## Library Usage

```js
const { payBalances } = require('roblox-group-payout');

const result = await payBalances({
  cookie: process.env.ROBLOSECURITY,
  groupId: 12345678,
  userId: 99999,              // alt account with "Spend Group Funds" permission
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

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `cookie` | string | Yes | `.ROBLOSECURITY` cookie for the alt account |
| `groupId` | number | Yes | Roblox group ID to pay from |
| `userId` | number | Yes | Roblox user ID of the alt account initiating payouts |
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
