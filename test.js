/**
 * Tests for roblox-group-payout.
 *
 * Tests cookie storage (helper), input validation, and the public API contract.
 * Does NOT make real Roblox API calls.
 *
 * Run: node test.js
 */

const fs = require('fs');
const path = require('path');
const { saveCookie, loadCookie } = require('./cookie-store');
const { saveConfig, loadConfig } = require('./totp');

let passed = 0;
let failed = 0;
const asyncTests = [];

function test(name, fn) {
	const result = fn();
	if (result && typeof result.then === 'function') {
		asyncTests.push(
			result
				.then(() => { console.log(`  PASS: ${name}`); passed++; })
				.catch((error) => { console.log(`  FAIL: ${name}`); console.log(`        ${error.message}`); failed++; })
		);
	} else {
		console.log(`  PASS: ${name}`);
		passed++;
	}
}

function testSync(name, fn) {
	try {
		fn();
		console.log(`  PASS: ${name}`);
		passed++;
	} catch (error) {
		console.log(`  FAIL: ${name}`);
		console.log(`        ${error.message}`);
		failed++;
	}
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

const testCookiePath = path.join(__dirname, 'test-cookie-temp.txt');
const testConfigPath = path.join(__dirname, 'test-config-temp.json');

function cleanup() {
	try { fs.unlinkSync(testCookiePath); } catch (e) { /* ignore */ }
	try { fs.unlinkSync(testConfigPath); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Cookie storage tests (helper module)
// ---------------------------------------------------------------------------

console.log('Cookie storage tests (helper)...\n');

testSync('round-trip: save then load returns original cookie', () => {
	cleanup();
	const original = '_|WARNING:-DO-NOT-SHARE-THIS-fake-cookie-value-for-testing-1234567890|_abcdef';
	saveCookie(original, testCookiePath);
	const loaded = loadCookie(testCookiePath);
	assertEqual(loaded, original, 'Loaded cookie');
	cleanup();
});

testSync('loadCookie returns null for missing file', () => {
	cleanup();
	const result = loadCookie(testCookiePath);
	assertEqual(result, null, 'Should return null');
});

testSync('saving a new cookie overwrites the old one', () => {
	cleanup();
	saveCookie('first-cookie', testCookiePath);
	saveCookie('second-cookie', testCookiePath);
	const loaded = loadCookie(testCookiePath);
	assertEqual(loaded, 'second-cookie', 'Should load the second cookie');
	cleanup();
});

// ---------------------------------------------------------------------------
// Config storage tests (helper module)
// ---------------------------------------------------------------------------

console.log('\nConfig storage tests (helper)...\n');

testSync('round-trip: save then load config returns original', () => {
	cleanup();
	const original = { totpSecret: 'JBSWY3DPEHPK3PXP', userId: 12345, groupId: 67890 };
	saveConfig(original, testConfigPath);
	const loaded = loadConfig(testConfigPath);
	assertEqual(loaded.totpSecret, original.totpSecret, 'totpSecret');
	assertEqual(loaded.userId, original.userId, 'userId');
	assertEqual(loaded.groupId, original.groupId, 'groupId');
	cleanup();
});

testSync('loadConfig returns null for missing file', () => {
	cleanup();
	const result = loadConfig(testConfigPath);
	assertEqual(result, null, 'Should return null');
});

// ---------------------------------------------------------------------------
// Core API input validation tests
// ---------------------------------------------------------------------------

console.log('\nInput validation tests (core)...\n');

const VALID_OPTS = {
	cookie: 'fake-cookie',
	groupId: 1,
	userId: 1,
	totpSecret: 'JBSWY3DPEHPK3PXP',
	balances: {},
};

test('payBalances rejects missing cookie', async () => {
	const { payBalances } = require('./index');
	try {
		await payBalances({ ...VALID_OPTS, cookie: '' });
		throw new Error('Should have thrown');
	} catch (error) {
		if (!error.message.includes('cookie')) {
			throw new Error(`Expected cookie error, got: ${error.message}`);
		}
	}
});

test('payBalances rejects missing groupId', async () => {
	const { payBalances } = require('./index');
	try {
		await payBalances({ ...VALID_OPTS, groupId: undefined });
		throw new Error('Should have thrown');
	} catch (error) {
		if (!error.message.includes('groupId')) {
			throw new Error(`Expected groupId error, got: ${error.message}`);
		}
	}
});

test('payBalances rejects missing userId', async () => {
	const { payBalances } = require('./index');
	try {
		await payBalances({ ...VALID_OPTS, userId: undefined });
		throw new Error('Should have thrown');
	} catch (error) {
		if (!error.message.includes('userId')) {
			throw new Error(`Expected userId error, got: ${error.message}`);
		}
	}
});

test('payBalances rejects missing totpSecret', async () => {
	const { payBalances } = require('./index');
	try {
		await payBalances({ ...VALID_OPTS, totpSecret: '' });
		throw new Error('Should have thrown');
	} catch (error) {
		if (!error.message.includes('totpSecret')) {
			throw new Error(`Expected totpSecret error, got: ${error.message}`);
		}
	}
});

test('payBalances rejects non-object balances', async () => {
	const { payBalances } = require('./index');
	try {
		await payBalances({ ...VALID_OPTS, balances: [{ recipientId: 1, amount: 1 }] });
		throw new Error('Should have thrown');
	} catch (error) {
		if (!error.message.includes('plain object')) {
			throw new Error(`Expected plain object error, got: ${error.message}`);
		}
	}
});

test('payBalances rejects null balances', async () => {
	const { payBalances } = require('./index');
	try {
		await payBalances({ ...VALID_OPTS, balances: null });
		throw new Error('Should have thrown');
	} catch (error) {
		if (!error.message.includes('plain object')) {
			throw new Error(`Expected plain object error, got: ${error.message}`);
		}
	}
});

test('payBalances returns immediately for empty balances', async () => {
	const { payBalances } = require('./index');
	const result = await payBalances({ ...VALID_OPTS, balances: {} });
	assertEqual(result.paid.length, 0, 'paid count');
	assertEqual(result.failed.length, 0, 'failed count');
	assertEqual(result.ineligible.length, 0, 'ineligible count');
});

test('payBalances skips zero and negative balances', async () => {
	const { payBalances } = require('./index');
	const result = await payBalances({ ...VALID_OPTS, balances: { '1': 0, '2': -5 } });
	assertEqual(result.paid.length, 0, 'paid count');
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

Promise.all(asyncTests).then(() => {
	console.log(`\n${passed} passed, ${failed} failed`);
	cleanup();
	if (failed > 0) {
		process.exitCode = 1;
	}
});
