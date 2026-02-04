const FIELD_VALUE_KIND = Symbol('FieldValueKind');

export type FieldValueKind = 'delete' | 'serverTimestamp' | 'arrayUnion';

export class FieldValue {
	readonly [FIELD_VALUE_KIND]: FieldValueKind;
	readonly elements?: readonly unknown[];

	private constructor(kind: FieldValueKind, elements?: readonly unknown[]) {
		this[FIELD_VALUE_KIND] = kind;
		this.elements = elements;
	}

	static delete(): FieldValue {
		return new FieldValue('delete');
	}

	static serverTimestamp(): FieldValue {
		return new FieldValue('serverTimestamp');
	}

	static arrayUnion(...elements: unknown[]): FieldValue {
		return new FieldValue('arrayUnion', elements);
	}
}

export function getFieldValueKind(value: unknown): FieldValueKind | null {
	if (!(value instanceof FieldValue)) {
		return null;
	}
	return value[FIELD_VALUE_KIND];
}
