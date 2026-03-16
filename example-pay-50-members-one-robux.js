#!/usr/bin/env node

/**
 * Example: pay 50 members of your group 1 Robux each.
 *
 * Use this to verify the library and your credentials before production use.
 * Requires: npx roblox-group-payout setup (cookie + config with groupId).
 *
 * Run from repo root: node example-pay-50-members-one-robux.js
 */

const https = require('https');
const readline = require('readline');
const { loadCookie } = require('./cookie-store');
const { loadConfig } = require('./totp');
const { payBalancesFromConfig } = require('./index');

function promptForConfirmation(message) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(message, () => {
			rl.close();
			resolve();
		});
	});
}

async function fetchGroupMemberUserIds(groupId, limit = 50) {
	const cookie = loadCookie();
	return new Promise((resolve, reject) => {
		const url = `https://groups.roblox.com/v1/groups/${groupId}/users?sortOrder=Asc&limit=${limit}`;
		const req = https.get(url, {
			headers: cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {},
		}, (res) => {
			let data = '';
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				if (res.statusCode !== 200) {
					reject(new Error(`Group users API returned ${res.statusCode}: ${data}`));
					return;
				}
				try {
					const body = JSON.parse(data);
					const users = body.data || body;
					const userIds = users.map((u) => u.userId ?? u.id ?? u).filter((id) => Number.isInteger(id) && id > 0);
					resolve(userIds);
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on('error', reject);
	});
}

async function main() {
	const config = loadConfig();
	if (!config || !config.groupId) {
		console.error('No config with groupId. Run: npx roblox-group-payout setup');
		process.exit(1);
	}
	if (!loadCookie()) {
		console.error('No cookie. Run: npx roblox-group-payout setup');
		process.exit(1);
	}

	const groupId = config.groupId;
	console.log(`Fetching up to 50 members from group ${groupId}...`);
	const userIds = await fetchGroupMemberUserIds(groupId, 50);
	if (userIds.length === 0) {
		console.error('No user IDs returned from group. Check groupId and API response.');
		process.exit(1);
	}

	const balances = {};
	for (const id of userIds) {
		balances[String(id)] = 1;
	}
	console.log(`Paying ${userIds.length} users 1 Robux each (${userIds.length} Robux total).\n`);
	await promptForConfirmation('Press Enter to execute payments (Ctrl+C to cancel)... ');

	const result = await payBalancesFromConfig({ balances });

	console.log('\nResult:');
	console.log(`  Paid: ${result.paid.length}`);
	console.log(`  Failed: ${result.failed.length}`);
	console.log(`  Ineligible: ${result.ineligible.length}`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
