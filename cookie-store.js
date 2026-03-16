/**
 * Cookie file storage.
 *
 * Stores the .ROBLOSECURITY cookie as a plain text file on disk.
 * We assume you're running on a machine you control — the recommended
 * security model is to use a dedicated alt account, not to encrypt cookies.
 *
 * Auto-migrates from the legacy encrypted format (.enc) on first load.
 *
 * This is a helper module. The core library (index.js, roblox-api.js) does not
 * depend on it. It's provided for CLI and local script convenience.
 */

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, 'rb-cookie.txt');
const LEGACY_COOKIE_FILE = path.join(__dirname, 'rb-cookie.enc');

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
 * Attempt to migrate from legacy encrypted cookie file to plaintext.
 * Returns the cookie string if migration succeeded, null otherwise.
 */
function migrateFromEncrypted() {
	try {
		const stored = fs.readFileSync(LEGACY_COOKIE_FILE, 'utf8');
		const cookie = legacyDecrypt(stored);
		saveCookie(cookie);
		fs.unlinkSync(LEGACY_COOKIE_FILE);
		console.log('Migrated cookie from encrypted format to plaintext.');
		return cookie;
	} catch (error) {
		return null;
	}
}

// --- Public API ---

/**
 * Save a cookie to the file.
 */
function saveCookie(cookie, cookiePath) {
	const filePath = cookiePath || COOKIE_FILE;
	fs.writeFileSync(filePath, cookie, 'utf8');
}

/**
 * Load the cookie from the file.
 * Auto-migrates from legacy encrypted format if needed.
 * Returns the cookie string, or null if no cookie is stored.
 */
function loadCookie(cookiePath) {
	const filePath = cookiePath || COOKIE_FILE;
	try {
		return fs.readFileSync(filePath, 'utf8').trim();
	} catch (error) {
		if (error.code !== 'ENOENT') return null;

		// File doesn't exist — check for legacy encrypted file
		if (!cookiePath) {
			const migrated = migrateFromEncrypted();
			if (migrated) return migrated;
		}
		return null;
	}
}

module.exports = {
	saveCookie,
	loadCookie,
};
