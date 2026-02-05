import type { DocumentData, SetOptions, TransactionOptions } from './firestore.js';
import {
	CollectionReference,
	DocumentReference,
	DocumentSnapshot,
	Firestore,
	Query,
	QuerySnapshot,
	Transaction,
	WriteBatch
} from './firestore.js';
import { FieldPath } from './field-path.js';
import { FieldValue } from './field-value.js';
import type { OrderDirection, WhereOp } from './rest/query-encoding.js';

export type Unsubscribe = () => void;

export type QueryConstraint<T extends DocumentData = DocumentData> = {
	_apply(query: Query<T>): Query<T>;
};

function joinSegments(segments: readonly string[]): string {
	return segments.filter((s) => s.length > 0).join('/');
}

export function doc<T extends DocumentData = DocumentData>(
	parent: Firestore | CollectionReference<T> | DocumentReference<T>,
	...pathSegments: string[]
): DocumentReference<T> {
	if (parent instanceof Firestore) {
		return parent.doc<T>(joinSegments(pathSegments));
	}
	if (parent instanceof CollectionReference) {
		const suffix = joinSegments(pathSegments);
		return parent.firestore.doc<T>(`${parent.path}/${suffix}`);
	}
	const suffix = joinSegments(pathSegments);
	return parent.firestore.doc<T>(`${parent.path}/${suffix}`);
}

export function collection<T extends DocumentData = DocumentData>(
	parent: Firestore | DocumentReference<T> | CollectionReference<T>,
	...pathSegments: string[]
): CollectionReference<T> {
	if (parent instanceof Firestore) {
		return parent.collection<T>(joinSegments(pathSegments));
	}
	const suffix = joinSegments(pathSegments);
	return parent.firestore.collection<T>(`${parent.path}/${suffix}`);
}

export async function getDoc<T extends DocumentData = DocumentData>(
	ref: DocumentReference<T>
): Promise<DocumentSnapshot<T>> {
	return await ref.get();
}

export async function getDocs<T extends DocumentData = DocumentData>(
	query: Query<T>
): Promise<QuerySnapshot<T>> {
	return await query.get();
}

export async function setDoc<T extends DocumentData = DocumentData>(
	ref: DocumentReference<T>,
	data: T,
	options: SetOptions = {}
): Promise<void> {
	await ref.set(data, options);
}

export async function addDoc<T extends DocumentData = DocumentData>(
	ref: CollectionReference<T>,
	data: T
): Promise<DocumentReference<T>> {
	return await ref.add(data);
}

export async function updateDoc<T extends DocumentData = DocumentData>(
	ref: DocumentReference<T>,
	data: Record<string, unknown>
): Promise<void>;
export async function updateDoc<T extends DocumentData = DocumentData>(
	ref: DocumentReference<T>,
	field: string | FieldPath,
	value: unknown,
	...moreFieldsAndValues: unknown[]
): Promise<void>;
export async function updateDoc<T extends DocumentData = DocumentData>(
	ref: DocumentReference<T>,
	dataOrField: Record<string, unknown> | string | FieldPath,
	value?: unknown,
	...moreFieldsAndValues: unknown[]
): Promise<void> {
	if (typeof dataOrField === 'string' || dataOrField instanceof FieldPath) {
		await ref.update(dataOrField, value, ...moreFieldsAndValues);
		return;
	}
	await ref.update(dataOrField);
}

export async function deleteDoc<T extends DocumentData = DocumentData>(
	ref: DocumentReference<T>
): Promise<void> {
	await ref.delete();
}

export function writeBatch(firestore: Firestore): WriteBatch {
	return firestore.batch();
}

export async function runTransaction<T>(
	firestore: Firestore,
	updateFn: (tx: Transaction) => Promise<T>,
	options: TransactionOptions = {}
): Promise<T> {
	return await firestore.runTransaction(updateFn, options);
}

export function query<T extends DocumentData = DocumentData>(
	base: Query<T>,
	...constraints: Array<QueryConstraint<T>>
): Query<T> {
	return constraints.reduce((acc, constraint) => constraint._apply(acc), base);
}

export function where<T extends DocumentData = DocumentData>(
	fieldPath: string | FieldPath,
	op: WhereOp,
	value: unknown
): QueryConstraint<T> {
	return {
		_apply(q) {
			return q.where(fieldPath, op, value);
		}
	};
}

export function orderBy<T extends DocumentData = DocumentData>(
	fieldPath: string | FieldPath,
	direction: OrderDirection = 'asc'
): QueryConstraint<T> {
	return {
		_apply(q) {
			return q.orderBy(fieldPath, direction);
		}
	};
}

export function limit<T extends DocumentData = DocumentData>(n: number): QueryConstraint<T> {
	return {
		_apply(q) {
			return q.limit(n);
		}
	};
}

export function limitToLast<T extends DocumentData = DocumentData>(n: number): QueryConstraint<T> {
	return {
		_apply(q) {
			return q.limitToLast(n);
		}
	};
}

export function documentId(): FieldPath {
	return FieldPath.documentId();
}

export function serverTimestamp(): FieldValue {
	return FieldValue.serverTimestamp();
}

export function deleteField(): FieldValue {
	return FieldValue.delete();
}

export function arrayUnion(...elements: unknown[]): FieldValue {
	return FieldValue.arrayUnion(...elements);
}

export function arrayRemove(...elements: unknown[]): FieldValue {
	return FieldValue.arrayRemove(...elements);
}

export function increment(n: number): FieldValue {
	return FieldValue.increment(n);
}

export function onSnapshot<T extends DocumentData = DocumentData>(
	ref: DocumentReference<T>,
	onNext: (snapshot: DocumentSnapshot<T>) => void,
	onError?: (error: unknown) => void
): Unsubscribe {
	return ref.onSnapshot(onNext, onError);
}
