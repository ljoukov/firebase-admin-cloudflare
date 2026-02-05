const FIELD_VALUE_KIND = Symbol('FieldValueKind');

export type FieldValueKind =
	| 'delete'
	| 'serverTimestamp'
	| 'arrayUnion'
	| 'arrayRemove'
	| 'increment'
	| 'maximum'
	| 'minimum';

export class FieldValue {
	readonly [FIELD_VALUE_KIND]: FieldValueKind;
	readonly elements?: readonly unknown[];
	readonly operand?: unknown;

	private constructor(
		kind: FieldValueKind,
		options?: { elements?: readonly unknown[]; operand?: unknown }
	) {
		this[FIELD_VALUE_KIND] = kind;
		this.elements = options?.elements;
		this.operand = options?.operand;
	}

	static delete(): FieldValue {
		return new FieldValue('delete');
	}

	static serverTimestamp(): FieldValue {
		return new FieldValue('serverTimestamp');
	}

	static arrayUnion(...elements: unknown[]): FieldValue {
		return new FieldValue('arrayUnion', { elements });
	}

	static arrayRemove(...elements: unknown[]): FieldValue {
		return new FieldValue('arrayRemove', { elements });
	}

	static increment(n: number): FieldValue {
		if (!Number.isFinite(n)) {
			throw new Error('FieldValue.increment() requires a finite number.');
		}
		return new FieldValue('increment', { operand: n });
	}

	static maximum(value: unknown): FieldValue {
		return new FieldValue('maximum', { operand: value });
	}

	static minimum(value: unknown): FieldValue {
		return new FieldValue('minimum', { operand: value });
	}
}

export function getFieldValueKind(value: unknown): FieldValueKind | null {
	if (!(value instanceof FieldValue)) {
		return null;
	}
	return value[FIELD_VALUE_KIND];
}
