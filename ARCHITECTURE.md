# Architecture and Security

## Security Model

This library assumes you're running on a machine you control. Credentials (cookie, TOTP secret) are stored as plain text files on disk.

Instead of encrypting secrets with machine-derived keys, the recommended approach is to use a dedicated paying account (alt recommended) with limited permissions.

## Paying Account Setup

Use a dedicated paying account whose sole purpose is executing payouts. Do not use your main account's cookie.

1. Enable 2-Step Verification
2. Join the group
3. Grant **Spend Group Funds**

If the paying account's cookie is compromised, only delegated payout permissions are exposed.

## Module Layout

Core (zero disk I/O, Node built-ins only):

- `index.js` - `payBalances()` orchestration, eligibility, batching
- `roblox-api.js` - HTTP layer, CSRF handling, cookie rotation, 2SV

Helpers (optional convenience for local/CLI usage):

- `cookie-store.js` - `.ROBLOSECURITY` cookie file storage
- `totp.js` - payout auth config storage + TOTP generation
- `cli.js` - interactive setup and 2SV code generation (no pay-from-CLI)
- `example-pay-50-members-one-robux.js` - sample script to run a small test payout (50 group members, 1 R$ each)

The core accepts plain values (cookie string, TOTP secret string). It does not read or write files directly.

## Why This Exists

Roblox group payouts require handling several edge cases correctly:

1. CSRF token handshake for write requests
2. Cookie rotation persistence
3. Two-step verification challenge completion
4. Per-user payout eligibility checks
5. Batch limits and retry strategy

This library centralizes those behaviors so calling code can focus on balances and payout policy.
