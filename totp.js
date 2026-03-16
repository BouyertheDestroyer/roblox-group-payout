/**
 * TOTP (Time-based One-Time Password) generation and config file storage.
 *
 * Implements RFC 6238 (TOTP) / RFC 4226 (HOTP) using Node's built-in crypto.
 * No dependencies.
 *
 * Config (totpSecret, userId, groupId) is stored as a plain JSON file on disk.
 * Canonical file name: payout-auth-config.json.
 * Legacy file name: totp-config.json (auto-migrated on load).
 * Auto-migrates from the legacy encrypted format (.enc) on first load.
 *
 * This is a helper module. The core library (index.js, roblox-api.js) does not
 * depend on it -- the core has generateTOTP inlined. This module is provided
 * for CLI convenience (config file storage).
 */

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'payout-auth-config.json');
const LEGACY_PLAINTEXT_CONFIG_FILE = path.join(__dirname, 'totp-config.json');
const LEGACY_CONFIG_FILE = path.join(__dirname, 'totp-config.enc');

// --- Base32 decoding (RFC 4648) ---

function base32Decode(encoded) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	const cleaned = encoded.replace(/[\s=]/g, '').toUpperCase();

	let bits = '';
	for (const char of cleaned) {
		const val = alphabet.indexOf(char);
		if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
		bits += val.toString(2).padStart(5, '0');
	}

	const bytes = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		bytes.push(parseInt(bits.substring(i, i + 8), 2));
	}
	return Buffer.from(bytes);
}

// --- TOTP generation (RFC 6238) ---

/**
 * Generate a 6-digit TOTP code from a base32-encoded secret.
 * Uses the standard 30-second time step and SHA-1 HMAC.
 */
function generateTOTP(base32Secret) {
	const key = base32Decode(base32Secret);
	const counter = Math.floor(Date.now() / 1000 / 30);

	const counterBuffer = Buffer.alloc(8);
	counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
	counterBuffer.writeUInt32BE(counter >>> 0, 4);

	const hmac = crypto.createHmac('sha1', key);
	hmac.update(counterBuffer);
	const hash = hmac.digest();

	const offset = hash[hash.length - 1] & 0x0f;
	const binary =
		((hash[offset] & 0x7f) << 24) |
		((hash[offset + 1] & 0xff) << 16) |
		((hash[offset + 2] & 0xff) << 8) |
		(hash[offset + 3] & 0xff);

	const otp = binary % 1_000_000;
	return otp.toString().padStart(6, '0');
}

// --- Legacy encrypted format support (for migration only) ---

function legacyDeriveKey() {
	const machineIdentity = [
		os.hostname(),
		os.userInfo().username,
		os.platform(),
		os.arch(),
		os.homedir(),
	].join(':');
	return crypto.scryptSync(machineIdentity, 'roblox-group-payout', 32);
}

function legacyDecrypt(stored) {
	const key = legacyDeriveKey();
	const { iv, authTag, data } = JSON.parse(stored);
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
	decipher.setAuthTag(Buffer.from(authTag, 'hex'));
	let decrypted = decipher.update(data, 'hex', 'utf8');
	decrypted += decipher.final('utf8');
	return decrypted;
}

/**
 * Attempt to migrate from legacy encrypted config file to plaintext JSON.
 * Returns the config object if migration succeeded, null otherwise.
 */
function migrateFromEncrypted() {
	try {
		const stored = fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8');
		const config = JSON.parse(legacyDecrypt(stored));
		saveConfig(config);
		fs.unlinkSync(LEGACY_CONFIG_FILE);
		console.log('Migrated TOTP config from encrypted format to plaintext.');
		return config;
	} catch (error) {
		return null;
	}
}

/**
 * Migrate legacy plaintext config file to the canonical config file.
 * Keeps the old file in place for rollback safety.
 */
function migrateFromLegacyPlaintext() {
	try {
		const raw = fs.readFileSync(LEGACY_PLAINTEXT_CONFIG_FILE, 'utf8');
		const config = JSON.parse(raw);
		saveConfig(config);
		console.log('Migrated payout auth config from totp-config.json to payout-auth-config.json.');
		return config;
	} catch (error) {
		return null;
	}
}

// --- Public API ---

/**
 * Save TOTP config (secret + userId + groupId) as JSON file.
 */
function saveConfig(config, configPath) {
	const filePath = configPath || CONFIG_FILE;
	fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Load TOTP config from JSON file.
 * Auto-migrates from legacy encrypted format if needed.
 * Returns { totpSecret, userId, groupId } or null if not set up.
 */
function loadConfig(configPath) {
	const filePath = configPath || CONFIG_FILE;
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		return JSON.parse(raw);
	} catch (error) {
		if (error.code !== 'ENOENT') return null;

		// When using default path, support migration from legacy plaintext and encrypted formats.
		if (!configPath) {
			const plaintextMigrated = migrateFromLegacyPlaintext();
			if (plaintextMigrated) return plaintextMigrated;

			const migrated = migrateFromEncrypted();
			if (migrated) return migrated;
		}
		return null;
	}
}

module.exports = {
	generateTOTP,
	saveConfig,
	loadConfig,
};
