import { getFieldValueKind } from '../field-value.js';
import type { FieldValueKind } from '../field-value.js';
import type { FieldPath } from '../field-path.js';

import { toFirestoreValue, type FirestoreValueEncodeOptions } from './value.js';
import type { FirestoreValue } from './types.js';

type FieldPathInput = string | FieldPath;

type FieldTransform =
	| { fieldPath: string; setToServerValue: 'REQUEST_TIME' }
	| { fieldPath: string; appendMissingElements: { values: FirestoreValue[] } }
	| { fieldPath: string; removeAllFromArray: { values: FirestoreValue[] } }
	| { fieldPath: string; increment: FirestoreValue }
	| { fieldPath: string; maximum: FirestoreValue }
	| { fieldPath: string; minimum: FirestoreValue };

export type EncodedDocumentWrite = {
	fields: Record<string, FirestoreValue>;
	updateMaskFieldPaths?: string[];
	updateTransforms?: FieldTransform[];
};

function normalizeFieldPath(input: FieldPathInput): { fieldPath: string; segments: string[] } {
	if (typeof input === 'string') {
		const fieldPath = input;
		const segments = input.split('.').filter((segment) => segment.length > 0);
		return { fieldPath, segments };
	}
	const fieldPath = input.toString();
	return { fieldPath, segments: [...input.segments] };
}

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

function collectLeafFieldPaths(
	value: unknown,
	currentPath: string,
	out: string[],
	options: FirestoreValueEncodeOptions
): void {
	const ignoreUndefinedProperties = options.ignoreUndefinedProperties ?? false;
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
	if (value === undefined) {
		if (ignoreUndefinedProperties) {
			return;
		}
		throw new Error('Cannot use "undefined" as a Firestore value.');
	}
	if (typeof value !== 'object') {
		out.push(currentPath);
		return;
	}
	if (Array.isArray(value)) {
		if (!ignoreUndefinedProperties && value.some((entry) => entry === undefined)) {
			throw new Error('Cannot use "undefined" as a Firestore value.');
		}
		out.push(currentPath);
		return;
	}
	// Plain object: recurse into leaves.
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry === undefined) {
			if (ignoreUndefinedProperties) {
				continue;
			}
			throw new Error('Cannot use "undefined" as a Firestore value.');
		}
		const next = currentPath ? `${currentPath}.${key}` : key;
		collectLeafFieldPaths(entry, next, out, options);
	}
}

function encodeFieldTransform(
	kind: FieldValueKind,
	fieldPath: string,
	value: unknown,
	options: FirestoreValueEncodeOptions
): FieldTransform {
	if (kind === 'serverTimestamp') {
		return { fieldPath, setToServerValue: 'REQUEST_TIME' };
	}
	if (kind === 'arrayUnion') {
		const rawElements = (value as { elements?: readonly unknown[] }).elements ?? [];
		const elements = Array.isArray(rawElements) ? rawElements : [];
		return {
			fieldPath,
			appendMissingElements: { values: elements.map((entry) => toFirestoreValue(entry, options)) }
		};
	}
	if (kind === 'arrayRemove') {
		const rawElements = (value as { elements?: readonly unknown[] }).elements ?? [];
		const elements = Array.isArray(rawElements) ? rawElements : [];
		return {
			fieldPath,
			removeAllFromArray: { values: elements.map((entry) => toFirestoreValue(entry, options)) }
		};
	}
	if (kind === 'increment') {
		const operand = (value as { operand?: unknown }).operand;
		return { fieldPath, increment: toFirestoreValue(operand, options) };
	}
	if (kind === 'maximum') {
		const operand = (value as { operand?: unknown }).operand;
		return { fieldPath, maximum: toFirestoreValue(operand, options) };
	}
	if (kind === 'minimum') {
		const operand = (value as { operand?: unknown }).operand;
		return { fieldPath, minimum: toFirestoreValue(operand, options) };
	}
	throw new Error(`Unsupported FieldValue transform '${kind}'`);
}

function encodeUpdateEntry(options: {
	fields: Record<string, FirestoreValue>;
	updateMaskFieldPaths: string[];
	updateTransforms: FieldTransform[];
	fieldPath: FieldPathInput;
	value: unknown;
	encodeOptions: FirestoreValueEncodeOptions;
}): void {
	const { fields, updateMaskFieldPaths, updateTransforms, fieldPath, value, encodeOptions } =
		options;
	const normalized = normalizeFieldPath(fieldPath);
	const kind = getFieldValueKind(value);
	if (kind === 'delete') {
		updateMaskFieldPaths.push(normalized.fieldPath);
		return;
	}
	if (
		kind === 'serverTimestamp' ||
		kind === 'arrayUnion' ||
		kind === 'arrayRemove' ||
		kind === 'increment' ||
		kind === 'maximum' ||
		kind === 'minimum'
	) {
		updateTransforms.push(encodeFieldTransform(kind, normalized.fieldPath, value, encodeOptions));
		return;
	}

	updateMaskFieldPaths.push(normalized.fieldPath);
	setNestedField(fields, normalized.segments, toFirestoreValue(value, encodeOptions));
}

export function encodeSetData(options: {
	data: Record<string, unknown>;
	merge: boolean;
	mergeFields?: readonly FieldPathInput[];
	ignoreUndefinedProperties: boolean;
}): EncodedDocumentWrite {
	const { data, merge, mergeFields, ignoreUndefinedProperties } = options;
	const encodeOptions: FirestoreValueEncodeOptions = { ignoreUndefinedProperties };
	const fields: Record<string, FirestoreValue> = {};
	const updateMaskFieldPaths: string[] = [];
	const updateTransforms: FieldTransform[] = [];

	if (mergeFields && mergeFields.length > 0) {
		const seen = new Set<string>();
		for (const fieldPathInput of mergeFields) {
			const normalized = normalizeFieldPath(fieldPathInput);
			if (seen.has(normalized.fieldPath)) {
				continue;
			}
			seen.add(normalized.fieldPath);

			let value: unknown = data;
			for (const segment of normalized.segments) {
				if (value === null || typeof value !== 'object') {
					value = undefined;
					break;
				}
				value = (value as Record<string, unknown>)[segment];
			}

			if (value === undefined) {
				if (ignoreUndefinedProperties) {
					continue;
				}
				throw new Error(`Missing value for merge field '${normalized.fieldPath}'.`);
			}

			const kind = getFieldValueKind(value);
			if (kind === 'delete') {
				updateMaskFieldPaths.push(normalized.fieldPath);
				continue;
			}
			if (
				kind === 'serverTimestamp' ||
				kind === 'arrayUnion' ||
				kind === 'arrayRemove' ||
				kind === 'increment' ||
				kind === 'maximum' ||
				kind === 'minimum'
			) {
				updateTransforms.push(
					encodeFieldTransform(kind, normalized.fieldPath, value, encodeOptions)
				);
				continue;
			}

			updateMaskFieldPaths.push(normalized.fieldPath);
			setNestedField(fields, normalized.segments, toFirestoreValue(value, encodeOptions));
		}

		return {
			fields,
			updateMaskFieldPaths,
			updateTransforms: updateTransforms.length > 0 ? updateTransforms : undefined
		};
	}

	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) {
			if (ignoreUndefinedProperties) {
				continue;
			}
			throw new Error('Cannot use "undefined" as a Firestore value.');
		}
		const kind = getFieldValueKind(value);
		if (kind === 'delete') {
			if (merge) {
				updateMaskFieldPaths.push(key);
			}
			continue;
		}
		if (
			kind === 'serverTimestamp' ||
			kind === 'arrayUnion' ||
			kind === 'arrayRemove' ||
			kind === 'increment' ||
			kind === 'maximum' ||
			kind === 'minimum'
		) {
			updateTransforms.push(encodeFieldTransform(kind, key, value, encodeOptions));
			continue;
		}
		if (merge) {
			setNestedField(
				fields,
				key.split('.').filter((segment) => segment.length > 0),
				toFirestoreValue(value, encodeOptions)
			);
		} else {
			fields[key] = toFirestoreValue(value, encodeOptions);
		}
		if (merge) {
			collectLeafFieldPaths(value, key, updateMaskFieldPaths, encodeOptions);
		}
	}

	return {
		fields,
		updateMaskFieldPaths: merge ? updateMaskFieldPaths : undefined,
		updateTransforms: updateTransforms.length > 0 ? updateTransforms : undefined
	};
}

export function encodeUpdateData(options: {
	data: Record<string, unknown>;
	ignoreUndefinedProperties: boolean;
}): EncodedDocumentWrite {
	const encodeOptions: FirestoreValueEncodeOptions = {
		ignoreUndefinedProperties: options.ignoreUndefinedProperties
	};
	const fields: Record<string, FirestoreValue> = {};
	const updateMaskFieldPaths: string[] = [];
	const updateTransforms: FieldTransform[] = [];

	for (const [fieldPath, value] of Object.entries(options.data)) {
		if (value === undefined) {
			if (options.ignoreUndefinedProperties) {
				continue;
			}
			throw new Error('Cannot use "undefined" as a Firestore value.');
		}
		encodeUpdateEntry({
			fields,
			updateMaskFieldPaths,
			updateTransforms,
			fieldPath,
			value,
			encodeOptions
		});
	}

	return {
		fields,
		updateMaskFieldPaths,
		updateTransforms: updateTransforms.length > 0 ? updateTransforms : undefined
	};
}
