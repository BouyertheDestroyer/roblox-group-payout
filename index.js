/**
 * roblox-group-payout
 *
 * Pay outstanding balances to Roblox group members. Handles CSRF tokens,
 * cookie rotation, two-step verification, eligibility checks, and batching.
 *
 * The balance-based model acknowledges that some payments will inevitably fail
 * (ineligible users, API errors, rate limits). Instead of "pay these exact
 * amounts", the contract is "here are outstanding balances, clear as many as
 * you can". Callers persist the returned balances and re-run to retry.
 *
 * Usage:
 *   const { payBalances } = require('roblox-group-payout');
 *
 *   const result = await payBalances({
 *     cookie: process.env.ROBLOSECURITY,
 *     groupId: 12345678,
 *     payerUserId: 99999,    // alt account that has "Spend Group Funds" permission
 *     totpSecret: 'BASE32SECRET',
 *     balances: { "111": 500, "222": 300 },
 *   });
 *
 *   // result.paid     -- payments that succeeded
 *   // result.failed   -- payments that were eligible but the API call failed
 *   // result.ineligible -- users not eligible for group payouts
 */

const { createClient } = require('./roblox-api');
const { loadCookie, saveCookie } = require('./cookie-store');
const { loadConfig } = require('./totp');

function assert(condition, message) {
	if (!condition) {
		throw new Error(`ASSERTION FAILED: ${message}`);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pay outstanding balances for a Roblox group.
 *
 * @param {Object} options
 * @param {string} options.cookie - .ROBLOSECURITY cookie for the alt account
 * @param {number} options.groupId - Roblox group ID to pay from
 * @param {number} options.payerUserId - Roblox user ID of the alt account initiating payouts
 * @param {string} options.totpSecret - Base32-encoded TOTP secret for automatic 2SV
 * @param {Object} options.balances - Map of userId (string) -> robux owed (integer).
 *   Zero/negative balances are silently ignored.
 * @param {Function} [options.onCookieRotated] - Called with the new cookie string when Roblox rotates it.
 *   Caller is responsible for persisting the new cookie.
 *
 * @returns {Promise<{paid: Array, failed: Array, ineligible: Array}>}
 *   - paid: payments that succeeded ({ recipientId, amount })
 *   - failed: eligible payments where the batch API call failed
 *   - ineligible: payments skipped because the user isn't eligible for group payouts
 */
async function payBalances({ cookie, groupId, payerUserId, totpSecret, balances, onCookieRotated }) {
	assert(typeof cookie === 'string' && cookie.length > 0, 'cookie is required');
	assert(Number.isInteger(groupId) && groupId > 0, `groupId must be a positive integer. Got: ${groupId}`);
	assert(Number.isInteger(payerUserId) && payerUserId > 0, `payerUserId must be a positive integer. Got: ${payerUserId}`);
	assert(typeof totpSecret === 'string' && totpSecret.length > 0, 'totpSecret is required');
	assert(balances && typeof balances === 'object' && !Array.isArray(balances), 'balances must be a plain object');

	// Build payments list from positive balances, silently skip zero/negative/invalid
	const payments = [];
	for (const [userIdStr, amount] of Object.entries(balances)) {
		const uid = parseInt(userIdStr, 10);
		if (!Number.isInteger(uid) || uid <= 0) {
			console.error(`Skipping invalid userId: ${userIdStr}`);
			continue;
		}
		if (!Number.isInteger(amount) || amount <= 0) {
			continue;
		}
		payments.push({ recipientId: uid, amount });
	}

	if (payments.length === 0) {
		console.log('No positive balances to pay.');
		return { paid: [], failed: [], ineligible: [] };
	}

	const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0);
	console.log(`Processing ${payments.length} balances totaling ${totalAmount} Robux`);

	const client = createClient({ cookie, userId: payerUserId, totpSecret, onCookieRotated });

	// Check eligibility
	console.log('\nChecking payout eligibility...');
	const eligible = [];
	const ineligible = [];

	for (let i = 0; i < payments.length; i++) {
		const payment = payments[i];
		const isEligible = await client.checkPayoutEligibility(groupId, payment.recipientId);
		if (isEligible) {
			eligible.push(payment);
		} else {
			console.log(`  Creator ${payment.recipientId}: ineligible`);
			ineligible.push(payment);
		}

		const checked = i + 1;
		if (checked % 5 === 0 || checked === payments.length) {
			console.log(`  Checked ${checked}/${payments.length} (${eligible.length} eligible, ${ineligible.length} ineligible)`);
		}
		await sleep(200);
	}

	if (eligible.length === 0) {
		console.log('No eligible recipients.');
		return { paid: [], failed: [], ineligible };
	}

	// Execute in batches of 20 (Roblox API limit)
	const BATCH_SIZE = 20;
	const paid = [];
	const failed = [];
	const totalBatches = Math.ceil(eligible.length / BATCH_SIZE);

	console.log(`\nExecuting payments in ${totalBatches} batch(es)...`);

	for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
		const batch = eligible.slice(i, i + BATCH_SIZE);
		const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
		const batchAmount = batch.reduce((sum, p) => sum + p.amount, 0);

		console.log(`\n--- Batch ${batchNumber}/${totalBatches}: ${batch.length} recipients, ${batchAmount} Robux ---`);

		const success = await client.executeBatchPayout(groupId, batch);

		if (success) {
			paid.push(...batch);
		} else {
			failed.push(...batch);
			console.error(`Batch ${batchNumber} FAILED`);
		}

		if (i + BATCH_SIZE < eligible.length) {
			await sleep(5_000);
		}
	}

	// Print summary
	console.log('\n=== PAYOUT COMPLETE ===');
	console.log(`Paid: ${paid.length} (${paid.reduce((s, p) => s + p.amount, 0)} Robux)`);

	if (failed.length > 0) {
		const failedAmount = failed.reduce((s, p) => s + p.amount, 0);
		console.error(`FAILED: ${failed.length} (${failedAmount} Robux)`);
		console.error('Failed IDs:', failed.map((p) => p.recipientId).join(', '));
	}

	if (ineligible.length > 0) {
		console.log(`Ineligible: ${ineligible.length} (must be in group for minimum period)`);
	}

	return { paid, failed, ineligible };
}

/**
 * Convenience wrapper that loads credentials from disk automatically.
 * The alt account's cookie, TOTP secret, payerUserId, and groupId are all
 * stored in files managed by cookie-store.js and totp.js.
 *
 * @param {Object} options
 * @param {Object} options.balances - Map of userId (string) -> robux owed (integer)
 * @returns {Promise<{paid: Array, failed: Array, ineligible: Array}>}
 */
async function payBalancesFromConfig({ balances }) {
	const config = loadConfig();
	assert(config, 'No payout config found. Run setup first (npx roblox-group-payout setup).');
	const cookie = loadCookie();
	assert(cookie, 'No cookie found. Run setup first (npx roblox-group-payout setup).');

	return payBalances({
		cookie,
		groupId: config.groupId,
		payerUserId: config.userId,
		totpSecret: config.totpSecret,
		balances,
		onCookieRotated: (newCookie) => {
			saveCookie(newCookie);
			console.log('Cookie rotated and saved.');
		},
	});
}

module.exports = { payBalances, payBalancesFromConfig };
