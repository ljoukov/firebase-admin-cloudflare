import { describe, expect, it } from 'vitest';

import { FieldPath } from '../src/firestore/field-path.js';

describe('FieldPath', () => {
	it('joins simple segments with dots', () => {
		expect(new FieldPath('a', 'b').toString()).toBe('a.b');
	});

	it('quotes segments with special characters', () => {
		expect(new FieldPath('a-b').toString()).toBe('`a-b`');
		expect(new FieldPath('a', 'b-c').toString()).toBe('a.`b-c`');
	});

	it('provides a documentId sentinel', () => {
		expect(FieldPath.documentId().toString()).toBe('__name__');
	});
});
