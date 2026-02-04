function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

export function base64UrlEncodeBytes(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlEncodeJson(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return base64UrlEncodeBytes(bytes);
}

export function pemToPkcs8DerBytes(pem: string): Uint8Array {
	const trimmed = pem.trim();
	const normalized = trimmed
		.replace(/-----BEGIN PRIVATE KEY-----/g, '')
		.replace(/-----END PRIVATE KEY-----/g, '')
		.replace(/\s+/g, '');
	return base64ToBytes(normalized);
}

export async function signJwtRs256(options: {
	privateKeyPem: string;
	claims: Record<string, unknown>;
	header?: Record<string, unknown>;
}): Promise<string> {
	const { privateKeyPem, claims, header } = options;
	const resolvedHeader = header ?? { alg: 'RS256', typ: 'JWT' };
	const signingInput = `${base64UrlEncodeJson(resolvedHeader)}.${base64UrlEncodeJson(claims)}`;

	const cryptoApi = globalThis.crypto.subtle;

	const keyBytes = Uint8Array.from(pemToPkcs8DerBytes(privateKeyPem));
	const privateKey = await cryptoApi.importKey(
		'pkcs8',
		keyBytes,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await cryptoApi.sign(
		{ name: 'RSASSA-PKCS1-v1_5' },
		privateKey,
		new TextEncoder().encode(signingInput)
	);

	return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}
