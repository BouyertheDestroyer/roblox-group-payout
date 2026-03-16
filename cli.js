#!/usr/bin/env node

/**
 * CLI for roblox-group-payout.
 *
 * Credential setup and 2SV code generation only. Actual payouts are done by
 * invoking the library (payBalances / payBalancesFromConfig) from your code.
 *
 * Commands:
 *   setup   -- Set up payout credentials for the paying account (2SV secret, cookie, group)
 *   code    -- Generate current 2SV code (e.g. for manual login)
 *
 * Usage:
 *   npx roblox-group-payout setup
 *   npx roblox-group-payout code
 */

const readline = require('readline');
const { loadCookie, saveCookie } = require('./cookie-store');
const { generateTOTP, saveConfig, loadConfig } = require('./totp');

function printUsage() {
	console.log('Usage:');
	console.log('  npx roblox-group-payout setup');
	console.log('  npx roblox-group-payout code');
	console.log('');
	console.log('Commands:');
	console.log('  setup   Set up payout credentials (2SV secret, cookie, group ID, payer user ID)');
	console.log('  code    Generate current 2SV code for the paying account');
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

async function main() {
	const argv = process.argv.slice(2);
	const command = argv[0];

	switch (command) {
		case 'setup':
			await runSetup();
			break;
		case 'code':
			await runCode();
			break;
		case '--help':
		case '-h':
		case undefined:
			printUsage();
			process.exit(command !== undefined ? 0 : 1);
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
