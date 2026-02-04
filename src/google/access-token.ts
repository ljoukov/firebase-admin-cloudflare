import { z } from 'zod';

import type { GoogleServiceAccount } from './service-account.js';
import { signJwtRs256 } from './webcrypto-jwt.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const TokenResponseSchema = z.object({
	access_token: z.string().trim().min(1),
	expires_in: z.number().positive().optional()
});

type TokenCacheEntry = {
	accessToken: string;
	expiresAtMs: number;
};

const tokenCache = new Map<string, TokenCacheEntry>();

function cacheKey(options: { serviceAccount: GoogleServiceAccount; scopes: string[] }): string {
	const { serviceAccount, scopes } = options;
	return `${serviceAccount.clientEmail}::${serviceAccount.tokenUri ?? GOOGLE_TOKEN_ENDPOINT}::${scopes
		.slice()
		.sort()
		.join(' ')}`;
}

export async function getGoogleAccessToken(options: {
	serviceAccount: GoogleServiceAccount;
	scopes: string[];
}): Promise<{ accessToken: string; projectId: string }> {
	const { serviceAccount, scopes } = options;
	const key = cacheKey({ serviceAccount, scopes });
	const cached = tokenCache.get(key);
	if (cached && Date.now() < cached.expiresAtMs - 60_000) {
		return { accessToken: cached.accessToken, projectId: serviceAccount.projectId };
	}

	const scopeKey = scopes.slice().sort().join(' ');
	const nowSeconds = Math.floor(Date.now() / 1000);
	const expSeconds = nowSeconds + 60 * 50;

	const jwt = await signJwtRs256({
		privateKeyPem: serviceAccount.privateKey,
		claims: {
			iss: serviceAccount.clientEmail,
			scope: scopeKey,
			aud: serviceAccount.tokenUri ?? GOOGLE_TOKEN_ENDPOINT,
			iat: nowSeconds,
			exp: expSeconds
		}
	});

	const body = new URLSearchParams();
	body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
	body.set('assertion', jwt);

	const resp = await fetch(serviceAccount.tokenUri ?? GOOGLE_TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body
	});

	if (!resp.ok) {
		const text = await resp.text().catch(() => '');
		throw new Error(
			`Google OAuth token exchange failed (${String(resp.status)}): ${text.slice(0, 500)}`
		);
	}

	const parsed = TokenResponseSchema.safeParse(await resp.json());
	if (!parsed.success) {
		throw new Error('Google OAuth token exchange returned an invalid JSON payload.');
	}

	const expiresInSeconds = parsed.data.expires_in ?? 3600;
	const expiresAtMs = Date.now() + expiresInSeconds * 1000;

	tokenCache.set(key, {
		accessToken: parsed.data.access_token,
		expiresAtMs
	});

	return { accessToken: parsed.data.access_token, projectId: serviceAccount.projectId };
}

export function clearGoogleAccessTokenCacheForTests(): void {
	tokenCache.clear();
}
