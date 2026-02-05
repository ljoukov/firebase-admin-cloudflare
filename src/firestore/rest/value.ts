import { Timestamp } from '../timestamp.js';
import { Bytes } from '../bytes.js';
import { GeoPoint } from '../geo-point.js';

import type { FirestoreValue } from './types.js';

export type FirestoreValueEncodeOptions = {
	ignoreUndefinedProperties?: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value.constructor === Object || Object.getPrototypeOf(value) === null)
	);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export function toFirestoreValue(
	value: unknown,
	options: FirestoreValueEncodeOptions = {}
): FirestoreValue {
	const ignoreUndefinedProperties = options.ignoreUndefinedProperties ?? false;

	if (value === null) {
		return { nullValue: null };
	}
	if (value === undefined) {
		throw new Error('Cannot use "undefined" as a Firestore value.');
	}
	if (typeof value === 'boolean') {
		return { booleanValue: value };
	}
	if (typeof value === 'number') {
		if (Number.isInteger(value) && Number.isSafeInteger(value)) {
			return { integerValue: String(value) };
		}
		return { doubleValue: value };
	}
	if (typeof value === 'string') {
		return { stringValue: value };
	}
	if (value instanceof Timestamp) {
		return { timestampValue: value.toDate().toISOString() };
	}
	if (value instanceof Date) {
		return { timestampValue: value.toISOString() };
	}
	if (value instanceof Bytes) {
		return { bytesValue: value.toBase64() };
	}
	if (value instanceof GeoPoint) {
		return { geoPointValue: { latitude: value.latitude, longitude: value.longitude } };
	}
	if (value instanceof Uint8Array) {
		return { bytesValue: bytesToBase64(value) };
	}
	if (Array.isArray(value)) {
		if (!ignoreUndefinedProperties && value.some((entry) => entry === undefined)) {
			throw new Error('Cannot use "undefined" as a Firestore value.');
		}
		const values = value
			.filter((entry) => entry !== undefined)
			.map((entry) => toFirestoreValue(entry, options));
		return { arrayValue: { values } };
	}
	if (isPlainObject(value)) {
		const fields: Record<string, FirestoreValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry === undefined) {
				if (ignoreUndefinedProperties) {
					continue;
				}
				throw new Error('Cannot use "undefined" as a Firestore value.');
			}
			fields[key] = toFirestoreValue(entry, options);
		}
		return { mapValue: { fields } };
	}
	if (typeof value === 'bigint') {
		return { stringValue: value.toString() };
	}
	if (typeof value === 'symbol') {
		return { stringValue: value.description ?? String(value) };
	}
	if (typeof value === 'function') {
		return { stringValue: '[function]' };
	}
	throw new Error('Unsupported value type for Firestore encoding.');
}

export function fromFirestoreValue(value: FirestoreValue): unknown {
	if ('nullValue' in value) {
		return null;
	}
	if ('booleanValue' in value) {
		return value.booleanValue;
	}
	if ('integerValue' in value) {
		const n = Number(value.integerValue);
		if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
			return value.integerValue;
		}
		return n;
	}
	if ('doubleValue' in value) {
		return value.doubleValue;
	}
	if ('stringValue' in value) {
		return value.stringValue;
	}
	if ('bytesValue' in value) {
		return Bytes.fromBase64String(value.bytesValue);
	}
	if ('timestampValue' in value) {
		const date = new Date(value.timestampValue);
		if (Number.isNaN(date.getTime())) {
			return value.timestampValue;
		}
		return Timestamp.fromDate(date);
	}
	if ('referenceValue' in value) {
		return value.referenceValue;
	}
	if ('geoPointValue' in value) {
		return new GeoPoint(value.geoPointValue.latitude, value.geoPointValue.longitude);
	}
	if ('arrayValue' in value) {
		const values = value.arrayValue.values ?? [];
		return values.map((entry) => fromFirestoreValue(entry));
	}
	if ('mapValue' in value) {
		const out: Record<string, unknown> = {};
		const fields = value.mapValue.fields ?? {};
		for (const [key, entry] of Object.entries(fields)) {
			out[key] = fromFirestoreValue(entry);
		}
		return out;
	}
	return null;
}

export function toFirestoreValueLenient(value: unknown): FirestoreValue {
	// Backwards-compat for internal callsites that intentionally ignore undefined values.
	// Prefer `toFirestoreValue(value, { ignoreUndefinedProperties: true })`.
	if (value === undefined) {
		return { nullValue: null };
	}
	if (Array.isArray(value)) {
		return toFirestoreValue(value, { ignoreUndefinedProperties: true });
	}
	if (typeof value === 'object' && value !== null) {
		return toFirestoreValue(value, { ignoreUndefinedProperties: true });
	}
	return toFirestoreValue(value);
}
