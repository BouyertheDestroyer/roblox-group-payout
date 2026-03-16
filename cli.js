#!/usr/bin/env node

/**
 * CLI for roblox-group-payout.
 *
 * Uses the helper modules (cookie-store, totp) to load credentials,
 * then passes them into the core payBalances API.
 *
 * Commands:
 *   setup                              -- Set up payout credentials for the paying account
 *   pay --balances <file>              -- Pay outstanding balances
 *
 * Usage:
 *   npx roblox-group-payout setup
 *   npx roblox-group-payout pay --balances balances.json
 *
 * balances.json format:
 *   { "111": 500, "222": 300 }
 */

const fs = require('fs');
const https = require('https');
const readline = require('readline');
const { payBalances } = require('./index');
const { loadCookie, saveCookie } = require('./cookie-store');
const { generateTOTP, saveConfig, loadConfig } = require('./totp');

function printUsage() {
	console.log('Usage:');
	console.log('  npx roblox-group-payout setup');
	console.log('  npx roblox-group-payout pay --balances <file>');
	console.log('  npx roblox-group-payout code');
	console.log('');
	console.log('Commands:');
	console.log('  setup              Set up payout credentials (2SV + cookie + group)');
	console.log('  pay                Pay outstanding balances from a JSON file');
	console.log('  code               Generate a 2SV code for the paying account');
	console.log('');
	console.log('Pay options:');
	console.log('  --balances <file>  JSON file with { userId: amount } balances');
	console.log('  --group <id>       Roblox group ID (optional, loaded from setup config)');
	console.log('  --help             Show this help message');
	console.log('');
	console.log('After execution, the balances file is updated in-place with remaining');
	console.log('balances. Re-run the same command to retry any unpaid balances.');
}

function parsePayArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case '--group':
				args.groupId = parseInt(argv[++i], 10);
				break;
			case '--balances':
				args.balancesFile = argv[++i];
				break;
			case '--help':
				args.help = true;
				break;
			default:
				console.error(`Unknown argument: ${argv[i]}`);
				process.exit(1);
		}
	}
	return args;
}

function promptForInput(prompt) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function waitForConfirmation() {
	return promptForInput('\nPress Enter to execute payments (Ctrl+C to cancel)... ');
}

/**
 * Check if the acting userId is the group owner. If so, warn the user
 * that they should use a dedicated paying account (alt recommended) instead.
 */
async function checkForOwnerAccount(groupId, userId) {
	try {
		const url = `https://groups.roblox.com/v1/groups/${groupId}`;
		const response = await new Promise((resolve, reject) => {
			https.get(url, (res) => {
				let data = '';
				res.on('data', (chunk) => { data += chunk; });
				res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
				res.on('error', reject);
			}).on('error', reject);
		});

		if (response.statusCode !== 200) return;

		const group = JSON.parse(response.body);
		if (group.owner && group.owner.userId === userId) {
			console.warn('\n⚠️  You are using the group owner account to execute payouts.');
			console.warn('   Consider using a dedicated alt account instead. Benefits:');
			console.warn('   - Keeps your primary Roblox account credentials off-disk');
			console.warn('   - Limit privileges to take group actions\n');
		}
	} catch (error) {
		// Non-fatal — don't block payouts if we can't check
	}
}

async function requireCookie() {
	const existing = loadCookie();
	if (existing) return existing;

	console.log('No saved cookie found. Let\'s set one up.\n');
	console.log('To get your .ROBLOSECURITY cookie:');
	console.log('  1. Log into Roblox in your browser');
	console.log('  2. Open Developer Tools (F12)');
	console.log('  3. Go to Application > Cookies > .roblox.com');
	console.log('  4. Find .ROBLOSECURITY and copy its value\n');

	const cookie = await promptForInput('Paste your .ROBLOSECURITY cookie value: ');
	if (!cookie) {
		throw new Error('No cookie provided');
	}

	saveCookie(cookie);
	console.log('Cookie saved.\n');
	return cookie;
}

async function runSetup() {
	console.log('=== Payout Account Setup ===\n');
	console.log('This sets up the paying Roblox account used to execute payouts.');
	console.log('(A dedicated alt is recommended.)\n');

	// Step 1: TOTP secret
	console.log('Step 1: Two-Step Verification\n');
	console.log('On your paying account, go to Settings > Security > 2-Step Verification');
	console.log('and choose "Authenticator App". Roblox will show a QR code.\n');
	console.log('Click "Can\'t scan the QR code? Click here for manual entry."');
	console.log('to reveal the secret key as text.\n');
	console.log('Paste that secret key here instead of into an authenticator app.');
	console.log('This CLI will become your authenticator.\n');

	const totpSecret = await promptForInput('Paste the 2SV secret key: ');
	if (!totpSecret) {
		throw new Error('No TOTP secret provided');
	}

	let code;
	try {
		code = generateTOTP(totpSecret);
	} catch (error) {
		throw new Error(`Invalid TOTP secret: ${error.message}`);
	}

	console.log(`\nYour 2SV code is: ${code}`);
	console.log('Enter this code on the Roblox setup page to complete 2SV setup.');
	console.log('Roblox will then show you backup codes.\n');

	// Step 2: Backup codes
	console.log('Step 2: Backup Codes (optional)\n');
	const backupCodes = await promptForInput('Paste backup codes (or Enter to skip): ');

	// Step 3: User ID
	console.log('\nStep 3: Payer User ID\n');
	const userIdStr = await promptForInput('Paste the paying account user ID: ');
	const userId = parseInt(userIdStr, 10);
	if (!Number.isInteger(userId) || userId <= 0) {
		throw new Error(`Invalid user ID: ${userIdStr}`);
	}

	// Step 4: Group ID
	console.log('\nStep 4: Group ID\n');
	const groupIdStr = await promptForInput('Paste the group ID: ');
	const groupId = parseInt(groupIdStr, 10);
	if (!Number.isInteger(groupId) || groupId <= 0) {
		throw new Error(`Invalid group ID: ${groupIdStr}`);
	}

	// Step 5: Cookie
	console.log('\nStep 5: Cookie\n');
	await requireCookie();

	// Save config
	const config = { totpSecret, userId, groupId };
	if (backupCodes) {
		config.backupCodes = backupCodes;
	}
	saveConfig(config);
	console.log('\nAll credentials saved. Setup complete.');
}

async function runCode() {
	const config = loadConfig();
	if (!config || !config.totpSecret) {
		console.error('No TOTP config found. Run "npx roblox-group-payout setup" first.');
		process.exit(1);
	}

	const code = generateTOTP(config.totpSecret);
	const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);
	console.log(`${code}  (expires in ${secondsRemaining}s)`);
}

async function runPay(argv) {
	const args = parsePayArgs(argv);

	if (args.help || !args.balancesFile) {
		printUsage();
		process.exit(args.help ? 0 : 1);
	}

	// Load credentials from helper modules
	const totpConfig = loadConfig();
	if (!totpConfig) {
		console.error('No TOTP config found. Run "npx roblox-group-payout setup" first.');
		process.exit(1);
	}

	const cookie = await requireCookie();
	const groupId = args.groupId || totpConfig.groupId;
	const userId = totpConfig.userId;
	const totpSecret = totpConfig.totpSecret;

	if (!groupId) {
		console.error('No group ID. Pass --group <id> or run setup.');
		process.exit(1);
	}

	await checkForOwnerAccount(groupId, userId);

	// Load balances file
	let balances;
	try {
		const raw = fs.readFileSync(args.balancesFile, 'utf8');
		balances = JSON.parse(raw);
	} catch (error) {
		if (error.code === 'ENOENT') {
			console.error(`File not found: ${args.balancesFile}`);
		} else {
			console.error(`Error reading ${args.balancesFile}:`, error.message);
		}
		process.exit(1);
	}

	if (typeof balances !== 'object' || Array.isArray(balances) || balances === null) {
		console.error('Balances file must contain a JSON object mapping userId to amount.');
		process.exit(1);
	}

	// Count positive balances for summary
	const positiveEntries = Object.entries(balances).filter(([, v]) => Number.isInteger(v) && v > 0);
	const totalAmount = positiveEntries.reduce((sum, [, v]) => sum + v, 0);

	console.log(`Group: ${groupId}`);
	console.log(`Balances: ${positiveEntries.length} users with positive balance`);
	console.log(`Total: ${totalAmount} Robux`);

	if (positiveEntries.length === 0) {
		console.log('\nNo positive balances to pay.');
		return;
	}

	await waitForConfirmation();

	const result = await payBalances({
		cookie,
		groupId,
		userId,
		totpSecret,
		balances,
		onCookieRotated: (newCookie) => {
			saveCookie(newCookie);
			console.log('Cookie rotated and saved.');
		},
	});

	// Build updated balances: zero out paid, keep rest
	const updatedBalances = { ...balances };
	for (const payment of result.paid) {
		updatedBalances[payment.recipientId.toString()] = 0;
	}

	fs.writeFileSync(args.balancesFile, JSON.stringify(updatedBalances, null, 2));
	console.log(`\nUpdated balances written to ${args.balancesFile}`);

	const remaining = Object.values(updatedBalances).filter(v => v > 0);
	if (remaining.length > 0) {
		const remainingTotal = remaining.reduce((s, v) => s + v, 0);
		console.log(`${remaining.length} users still have outstanding balances (${remainingTotal} Robux)`);
		console.log('Re-run the same command to retry.');
	}

	if (result.failed.length > 0) {
		process.exitCode = 1;
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const command = argv[0];

	switch (command) {
		case 'setup':
			await runSetup();
			break;
		case 'pay':
			await runPay(argv.slice(1));
			break;
		case 'code':
			await runCode();
			break;
		case '--help':
		case undefined:
			printUsage();
			process.exit(command ? 0 : 1);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printUsage();
			process.exit(1);
	}
}

main().catch((error) => {
	console.error('Fatal error:', error.message);
	process.exitCode = 1;
});
