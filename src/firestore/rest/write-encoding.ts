import { getFieldValueKind } from '../field-value.js';
import type { FieldValueKind } from '../field-value.js';

import { toFirestoreValue } from './value.js';
import type { FirestoreValue } from './types.js';

type FieldTransform =
	| { fieldPath: string; setToServerValue: 'REQUEST_TIME' }
	| { fieldPath: string; appendMissingElements: { values: FirestoreValue[] } };

export type EncodedDocumentWrite = {
	fields: Record<string, FirestoreValue>;
	updateMaskFieldPaths?: string[];
	updateTransforms?: FieldTransform[];
};

function ensureMap(
	fields: Record<string, FirestoreValue>,
	key: string
): Record<string, FirestoreValue> {
	const hasExisting = Object.prototype.hasOwnProperty.call(fields, key);
	const existing = hasExisting ? fields[key] : undefined;
	if (existing && 'mapValue' in existing) {
		if (!existing.mapValue.fields) {
			existing.mapValue.fields = {};
		}
		return existing.mapValue.fields;
	}
	fields[key] = { mapValue: { fields: {} } };
	return (fields[key] as { mapValue: { fields: Record<string, FirestoreValue> } }).mapValue.fields;
}

function setNestedField(
	fields: Record<string, FirestoreValue>,
	path: readonly string[],
	value: FirestoreValue
): void {
	if (path.length === 0) {
		return;
	}
	if (path.length === 1) {
		const key = path[0];
		if (!key) {
			return;
		}
		fields[key] = value;
		return;
	}
	const [head, ...rest] = path;
	if (!head) {
		return;
	}
	const child = ensureMap(fields, head);
	setNestedField(child, rest, value);
}

function collectLeafFieldPaths(value: unknown, currentPath: string, out: string[]): void {
	const kind = getFieldValueKind(value);
	if (kind) {
		out.push(currentPath);
		return;
	}
	if (value === null) {
		out.push(currentPath);
		return;
	}
	if (value instanceof Date) {
		out.push(currentPath);
		return;
	}
	if (value === undefined || typeof value !== 'object') {
		out.push(currentPath);
		return;
	}
	if (Array.isArray(value)) {
		out.push(currentPath);
		return;
	}
	// Plain object: recurse into leaves.
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry === undefined) {
			continue;
		}
		const next = currentPath ? `${currentPath}.${key}` : key;
		collectLeafFieldPaths(entry, next, out);
	}
}

function encodeFieldTransform(
	kind: FieldValueKind,
	fieldPath: string,
	value: unknown
): FieldTransform {
	if (kind === 'serverTimestamp') {
		return { fieldPath, setToServerValue: 'REQUEST_TIME' };
	}
	if (kind === 'arrayUnion') {
		const rawElements = (value as { elements?: readonly unknown[] }).elements ?? [];
		const elements = Array.isArray(rawElements) ? rawElements : [];
		return {
			fieldPath,
			appendMissingElements: { values: elements.map((entry) => toFirestoreValue(entry)) }
		};
	}
	throw new Error(`Unsupported FieldValue transform '${kind}'`);
}

function encodeUpdateEntry(options: {
	fields: Record<string, FirestoreValue>;
	updateMaskFieldPaths: string[];
	updateTransforms: FieldTransform[];
	fieldPath: string;
	value: unknown;
}): void {
	const { fields, updateMaskFieldPaths, updateTransforms, fieldPath, value } = options;
	const kind = getFieldValueKind(value);
	if (kind === 'delete') {
		updateMaskFieldPaths.push(fieldPath);
		return;
	}
	if (kind === 'serverTimestamp' || kind === 'arrayUnion') {
		updateTransforms.push(encodeFieldTransform(kind, fieldPath, value));
		return;
	}

	updateMaskFieldPaths.push(fieldPath);
	setNestedField(
		fields,
		fieldPath.split('.').filter((segment) => segment.length > 0),
		toFirestoreValue(value)
	);
}

export function encodeSetData(options: {
	data: Record<string, unknown>;
	merge: boolean;
}): EncodedDocumentWrite {
	const { data, merge } = options;
	const fields: Record<string, FirestoreValue> = {};
	const updateMaskFieldPaths: string[] = [];
	const updateTransforms: FieldTransform[] = [];

	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) {
			continue;
		}
		const kind = getFieldValueKind(value);
		if (kind === 'delete') {
			if (merge) {
				updateMaskFieldPaths.push(key);
			}
			continue;
		}
		if (kind === 'serverTimestamp' || kind === 'arrayUnion') {
			updateTransforms.push(encodeFieldTransform(kind, key, value));
			continue;
		}
		if (merge) {
			setNestedField(
				fields,
				key.split('.').filter((segment) => segment.length > 0),
				toFirestoreValue(value)
			);
		} else {
			fields[key] = toFirestoreValue(value);
		}
		if (merge) {
			collectLeafFieldPaths(value, key, updateMaskFieldPaths);
		}
	}

	return {
		fields,
		updateMaskFieldPaths: merge ? updateMaskFieldPaths : undefined,
		updateTransforms: updateTransforms.length > 0 ? updateTransforms : undefined
	};
}

export function encodeUpdateData(options: { data: Record<string, unknown> }): EncodedDocumentWrite {
	const fields: Record<string, FirestoreValue> = {};
	const updateMaskFieldPaths: string[] = [];
	const updateTransforms: FieldTransform[] = [];

	for (const [fieldPath, value] of Object.entries(options.data)) {
		if (value === undefined) {
			continue;
		}
		encodeUpdateEntry({ fields, updateMaskFieldPaths, updateTransforms, fieldPath, value });
	}

	return {
		fields,
		updateMaskFieldPaths,
		updateTransforms: updateTransforms.length > 0 ? updateTransforms : undefined
	};
}
