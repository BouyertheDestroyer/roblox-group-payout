/**
 * Roblox API helpers for group payouts.
 *
 * Handles all the tricky parts of talking to Roblox's payout APIs:
 * - CSRF token rotation (first POST is rejected, must retry with token)
 * - Cookie rotation (Roblox sends a new cookie; caller notified via onCookieRotated)
 * - Two-step verification (automatic via TOTP secret)
 * - Payout eligibility checks
 * - Batch payout execution (max 20 per request)
 *
 * Zero disk I/O. Credentials are provided by the caller.
 */

const https = require('https');
const crypto = require('crypto');

function assert(condition, message) {
	if (!condition) {
		throw new Error(`ASSERTION FAILED: ${message}`);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// TOTP generation (RFC 6238) — inlined so the core has no helper dependencies
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a Roblox API client for executing group payouts.
 *
 * @param {Object} options
 * @param {string} options.cookie - .ROBLOSECURITY cookie value
 * @param {number} options.userId - Roblox user ID of the account initiating payouts
 * @param {string} options.totpSecret - Base32-encoded TOTP secret for automatic 2SV
 * @param {Function} [options.onCookieRotated] - Called with new cookie string when Roblox rotates it
 */
function createClient({ cookie, userId, totpSecret, onCookieRotated }) {
	assert(cookie, 'cookie is required');
	assert(Number.isInteger(userId) && userId > 0,
		`userId must be a positive integer, got: ${userId}`);
	assert(typeof totpSecret === 'string' && totpSecret.length > 0,
		'totpSecret is required');

	let currentCookie = cookie;
	let csrfToken = null; // Cached across requests; refreshed when Roblox rejects it

	// -----------------------------------------------------------------------
	// HTTP layer
	// -----------------------------------------------------------------------

	function handleCookieRotation(responseHeaders) {
		const setCookie = responseHeaders['set-cookie'];
		if (!setCookie) return;

		for (const header of setCookie) {
			if (header.includes('.ROBLOSECURITY=')) {
				const match = header.match(/\.ROBLOSECURITY=([^;]+)/);
				if (match && match[1]) {
					const newCookie = match[1];
					if (newCookie !== currentCookie) {
						console.log('Cookie rotated by Roblox.');
						currentCookie = newCookie;
						if (onCookieRotated) {
							try {
								onCookieRotated(newCookie);
							} catch (error) {
								console.error('Warning: onCookieRotated callback failed:', error.message);
							}
						} else {
							console.warn('WARNING: Cookie was rotated but no onCookieRotated handler is set. The new cookie will be lost when this process exits. Future requests with the old cookie will fail.');
						}
					}
				}
			}
		}
	}

	/**
	 * Make an HTTPS request to Roblox with automatic CSRF token handling
	 * and cookie rotation.
	 *
	 * The CSRF token is cached and reused across requests. When Roblox
	 * rejects it (returns a new one in x-csrf-token header), we update
	 * the cache and retry once.
	 */
	function makeHttpRequest(options, body, _csrfRetry) {
		options.headers = {
			...options.headers,
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body),
			'Cookie': `.ROBLOSECURITY=${currentCookie}`,
		};
		if (csrfToken) {
			options.headers['X-CSRF-Token'] = csrfToken;
		}

		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let responseData = '';

				res.on('data', (chunk) => { responseData += chunk; });

				res.on('end', () => {
					handleCookieRotation(res.headers);

					if (res.statusCode === 401) {
						reject(new Error('401 Unauthorized -- cookie is invalid or expired.'));
						return;
					}

					if (res.statusCode === 429) {
						reject(new Error('429 Rate limited by Roblox. Wait and try again.'));
						return;
					}

					resolve({ body: responseData, headers: res.headers, statusCode: res.statusCode });
				});
			});

			req.on('error', (e) => reject(new Error(`Request error: ${e.message}`)));
			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Request timed out'));
			});

			req.setTimeout(15_000);
			req.write(body);
			req.end();
		}).then(async (response) => {
			const newCsrfToken = response.headers['x-csrf-token'];
			if (newCsrfToken && !_csrfRetry) {
				csrfToken = newCsrfToken;
				const retryOptions = {
					...options,
					headers: { ...options.headers, 'X-CSRF-Token': csrfToken },
				};
				return makeHttpRequest(retryOptions, body, true);
			}
			return response;
		});
	}

	// -----------------------------------------------------------------------
	// Two-step verification (automatic via TOTP)
	// -----------------------------------------------------------------------

	async function completeTwoStepChallenge(challengeHeaders) {
		const challengeId = challengeHeaders['rblx-challenge-id'];
		const metadata = JSON.parse(
			Buffer.from(challengeHeaders['rblx-challenge-metadata'], 'base64').toString('utf-8')
		);
		const code = generateTOTP(totpSecret);
		assert(code && code.length === 6, '2SV code generation failed');

		const challengeUserId = metadata.userId;
		const verifyResponse = await makeHttpRequest(
			{
				hostname: 'twostepverification.roblox.com',
				path: `/v1/users/${challengeUserId}/challenges/authenticator/verify`,
				method: 'POST',
			},
			JSON.stringify({
				actionType: metadata.actionType,
				challengeId: metadata.challengeId,
				code,
			})
		);

		const verifyBody = JSON.parse(verifyResponse.body);
		assert(verifyBody.verificationToken, `2SV verify failed: ${verifyResponse.body}`);
		const verificationToken = verifyBody.verificationToken;

		const continueMetadata = JSON.stringify({
			verificationToken,
			rememberDevice: false,
			challengeId: metadata.challengeId,
			actionType: metadata.actionType,
		});

		await makeHttpRequest(
			{
				hostname: 'apis.roblox.com',
				path: '/challenge/v1/continue',
				method: 'POST',
			},
			JSON.stringify({
				challengeId,
				challengeMetadata: continueMetadata,
				challengeType: 'twostepverification',
			})
		);

		return {
			'rblx-challenge-id': challengeId,
			'rblx-challenge-type': 'twostepverification',
			'rblx-challenge-metadata': Buffer.from(continueMetadata).toString('base64'),
		};
	}

	async function makeAuthenticatedRequest(options, body) {
		const maxAttempts = 3;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				let response = await makeHttpRequest(options, body);

				if (response.headers['rblx-challenge-id']) {
					console.log('Two-step verification required...');
					const proofHeaders = await completeTwoStepChallenge(response.headers);
					console.log('2SV completed. Retrying request with challenge proof...');

					const retryOptions = {
						...options,
						headers: { ...options.headers, ...proofHeaders },
					};
					response = await makeHttpRequest(retryOptions, body);
				}

				return response;
			} catch (error) {
				console.error(`Request attempt ${attempt}/${maxAttempts} failed:`, error.message);
				if (attempt === maxAttempts) throw error;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Public API methods
	// -----------------------------------------------------------------------

	/**
	 * Check if a user is eligible for group payouts.
	 * Retries on 429 rate limits with exponential backoff.
	 * Returns false on non-retryable errors (fail-safe: don't pay if we can't verify).
	 */
	async function checkPayoutEligibility(groupId, recipientUserId) {
		const maxRetries = 5;
		const baseDelay = 5_000;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const response = await makeHttpRequest(
					{
						hostname: 'economy.roblox.com',
						path: `/v1/groups/${groupId}/users-payout-eligibility?userIds=${recipientUserId}`,
						method: 'GET',
					},
					''
				);

				if (response.statusCode !== 200) return false;

				const parsed = JSON.parse(response.body);
				const eligibility = parsed.usersGroupPayoutEligibility;
				return eligibility && eligibility[recipientUserId.toString()] === 'Eligible';
			} catch (error) {
				const isRateLimit = error.message.includes('429');
				if (isRateLimit && attempt < maxRetries) {
					const delay = baseDelay * Math.pow(2, attempt - 1);
					console.log(`  Rate limited checking user ${recipientUserId}, retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`);
					await sleep(delay);
					continue;
				}
				console.error(`Eligibility check failed for user ${recipientUserId}:`, error.message);
				return false;
			}
		}
	}

	/**
	 * Execute a batch payout to up to 20 recipients.
	 * Each recipient: { recipientId: number, amount: number }
	 * Returns true on success, false on failure.
	 */
	async function executeBatchPayout(groupId, recipients) {
		assert(recipients.length > 0, 'Cannot execute empty batch payout');
		assert(recipients.length <= 20, `Batch size ${recipients.length} exceeds Roblox limit of 20`);

		for (const r of recipients) {
			assert(Number.isInteger(r.recipientId) && r.recipientId > 0,
				`Invalid recipientId: ${r.recipientId}`);
			assert(Number.isInteger(r.amount) && r.amount > 0,
				`Invalid amount ${r.amount} for recipient ${r.recipientId}`);
		}

		const totalAmount = recipients.reduce((sum, r) => sum + r.amount, 0);
		console.log(`Executing payout: ${recipients.length} recipients, ${totalAmount} Robux`);

		try {
			const response = await makeAuthenticatedRequest(
				{
					hostname: 'groups.roblox.com',
					path: `/v1/groups/${groupId}/payouts`,
					method: 'POST',
				},
				JSON.stringify({
					PayoutType: 1,
					Recipients: recipients,
				})
			);

			if (!response || response.statusCode !== 200) {
				console.error(`Payout failed (status ${response?.statusCode}):`, response?.body);
				return false;
			}

			const body = JSON.parse(response.body);
			if (body.errors && body.errors.length > 0) {
				console.error('Payout errors:', body.errors);
				return false;
			}

			console.log('Batch payout successful');
			return true;
		} catch (error) {
			console.error('Payout error:', error.message);
			return false;
		}
	}

	return {
		checkPayoutEligibility,
		executeBatchPayout,
	};
}

module.exports = { createClient };
