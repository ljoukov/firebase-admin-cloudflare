import { describe, expect, it } from 'vitest';

import { FirestoreRestClient } from '../src/firestore/rest/client.js';

describe('FirestoreRestClient path handling', () => {
	it('does not URL-encode resource names but encodes URLs', () => {
		const client = new FirestoreRestClient({
			projectId: 'p',
			baseUrl: 'https://firestore.googleapis.com'
		});

		expect(client.documentResourceName('a b/c')).toBe(
			'projects/p/databases/(default)/documents/a b/c'
		);
		expect(client.documentUrl('a b/c')).toBe(
			'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/a%20b/c'
		);
	});
});
