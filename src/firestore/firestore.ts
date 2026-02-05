import { z } from 'zod';

import type { App } from '../app/lifecycle.js';
import { getApp } from '../app/lifecycle.js';
import { getGoogleAccessToken } from '../google/access-token.js';

import type { EncodedDocumentWrite } from './rest/write-encoding.js';
import { encodeSetData, encodeUpdateData } from './rest/write-encoding.js';
import { encodeStructuredQuery, type OrderDirection, type WhereOp } from './rest/query-encoding.js';
import { FirestoreApiError, FirestoreRestClient } from './rest/client.js';
import type { CommitResponse, FirestoreDocument } from './rest/types.js';
import { fromFirestoreValue } from './rest/value.js';
import { listenToDocument, listenToQuery } from './listen/listen.js';
import { FieldPath } from './field-path.js';
import { Filter, type FilterNode } from './filter.js';
import { Timestamp } from './timestamp.js';

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

export type DocumentData = Record<string, unknown>;

export type SetOptions = {
	merge?: boolean;
	mergeFields?: Array<string | FieldPath>;
};

export type TransactionOptions = {
	maxAttempts?: number;
};

export class WriteResult {
	readonly writeTime: Timestamp;

	constructor(writeTime: Timestamp) {
		this.writeTime = writeTime;
	}
}

export class SnapshotMetadata {
	readonly fromCache: boolean;
	readonly hasPendingWrites: boolean;

	constructor(fromCache: boolean, hasPendingWrites: boolean) {
		this.fromCache = fromCache;
		this.hasPendingWrites = hasPendingWrites;
	}

	isEqual(other: SnapshotMetadata): boolean {
		return (
			other instanceof SnapshotMetadata &&
			this.fromCache === other.fromCache &&
			this.hasPendingWrites === other.hasPendingWrites
		);
	}
}

const DEFAULT_SNAPSHOT_METADATA = new SnapshotMetadata(false, false);

export type DocumentSnapshotData<T extends DocumentData> = T;

export class DocumentSnapshot<T extends DocumentData = DocumentData> {
	readonly ref: DocumentReference<T>;
	readonly exists: boolean;
	readonly metadata: SnapshotMetadata;
	private readonly _data: T | null;
	private readonly _createTime: Timestamp | null;
	private readonly _updateTime: Timestamp | null;
	private readonly _readTime: Timestamp | null;

	constructor(options: {
		ref: DocumentReference<T>;
		exists: boolean;
		data: T | null;
		metadata?: SnapshotMetadata;
		createTime?: Timestamp | null;
		updateTime?: Timestamp | null;
		readTime?: Timestamp | null;
	}) {
		this.ref = options.ref;
		this.exists = options.exists;
		this.metadata = options.metadata ?? DEFAULT_SNAPSHOT_METADATA;
		this._data = options.data;
		this._createTime = options.createTime ?? null;
		this._updateTime = options.updateTime ?? null;
		this._readTime = options.readTime ?? null;
	}

	get id(): string {
		return this.ref.id;
	}

	data(): DocumentSnapshotData<T> | undefined {
		return this._data ?? undefined;
	}

	get createTime(): Timestamp | undefined {
		return this._createTime ?? undefined;
	}

	get updateTime(): Timestamp | undefined {
		return this._updateTime ?? undefined;
	}

	get readTime(): Timestamp | undefined {
		return this._readTime ?? undefined;
	}

	get(fieldPath: string | FieldPath): unknown {
		if (!this.exists || !this._data) {
			return undefined;
		}
		const segments =
			typeof fieldPath === 'string'
				? fieldPath.split('.').filter((segment) => segment.length > 0)
				: [...fieldPath.segments];
		let cursor: unknown = this._data;
		for (const segment of segments) {
			if (!cursor || typeof cursor !== 'object') {
				return undefined;
			}
			if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
				return undefined;
			}
			cursor = (cursor as Record<string, unknown>)[segment];
		}
		return cursor;
	}
}

export class QueryDocumentSnapshot<
	T extends DocumentData = DocumentData
> extends DocumentSnapshot<T> {
	constructor(options: {
		ref: DocumentReference<T>;
		data: T;
		createTime?: Timestamp | null;
		updateTime?: Timestamp | null;
		readTime?: Timestamp | null;
	}) {
		super({
			ref: options.ref,
			exists: true,
			data: options.data,
			createTime: options.createTime,
			updateTime: options.updateTime,
			readTime: options.readTime
		});
	}

	override data(): DocumentSnapshotData<T> {
		return super.data() as DocumentSnapshotData<T>;
	}
}

export type DocumentChangeType = 'added' | 'modified' | 'removed';

export type DocumentChange<T extends DocumentData = DocumentData> = {
	type: DocumentChangeType;
	doc: QueryDocumentSnapshot<T>;
	oldIndex: number;
	newIndex: number;
};

function snapshotKey(snapshot: QueryDocumentSnapshot): string {
	return snapshot.ref.path;
}

function timestampKey(value: Timestamp | undefined): string | null {
	return value ? value.valueOf() : null;
}

function computeDocChanges<T extends DocumentData>(
	previous: QuerySnapshot<T>,
	nextDocs: QueryDocumentSnapshot<T>[]
): Array<DocumentChange<T>> {
	const prevByKey = new Map<
		string,
		{ index: number; updateTime: string | null; doc: QueryDocumentSnapshot<T> }
	>();
	for (let i = 0; i < previous.docs.length; i += 1) {
		const doc = previous.docs[i];
		prevByKey.set(snapshotKey(doc), {
			index: i,
			updateTime: timestampKey(doc.updateTime),
			doc
		});
	}

	const nextByKey = new Map<string, { index: number; updateTime: string | null }>();
	for (let i = 0; i < nextDocs.length; i += 1) {
		const doc = nextDocs[i];
		nextByKey.set(snapshotKey(doc), { index: i, updateTime: timestampKey(doc.updateTime) });
	}

	const changes: Array<DocumentChange<T>> = [];

	for (let i = 0; i < nextDocs.length; i += 1) {
		const doc = nextDocs[i];
		const key = snapshotKey(doc);
		const previousEntry = prevByKey.get(key);
		if (!previousEntry) {
			changes.push({ type: 'added', doc, oldIndex: -1, newIndex: i });
			continue;
		}
		const updateChanged = previousEntry.updateTime !== timestampKey(doc.updateTime);
		const indexChanged = previousEntry.index !== i;
		if (updateChanged || indexChanged) {
			changes.push({ type: 'modified', doc, oldIndex: previousEntry.index, newIndex: i });
		}
	}

	for (const [key, entry] of prevByKey.entries()) {
		if (nextByKey.has(key)) {
			continue;
		}
		changes.push({ type: 'removed', doc: entry.doc, oldIndex: entry.index, newIndex: -1 });
	}

	return changes;
}

export class QuerySnapshot<T extends DocumentData = DocumentData> {
	readonly docs: QueryDocumentSnapshot<T>[];
	readonly metadata: SnapshotMetadata;
	private readonly changes: Array<DocumentChange<T>>;

	constructor(
		docs: QueryDocumentSnapshot<T>[],
		options: { metadata?: SnapshotMetadata; changes?: Array<DocumentChange<T>> } = {}
	) {
		this.docs = docs;
		this.metadata = options.metadata ?? DEFAULT_SNAPSHOT_METADATA;
		this.changes = options.changes ?? [];
	}

	get empty(): boolean {
		return this.docs.length === 0;
	}

	get size(): number {
		return this.docs.length;
	}

	forEach(callback: (snapshot: QueryDocumentSnapshot<T>) => void): void {
		for (const doc of this.docs) {
			callback(doc);
		}
	}

	docChanges(options: { includeMetadataChanges?: boolean } = {}): Array<DocumentChange<T>> {
		void options;
		return [...this.changes];
	}
}

const RelativeDocumentPathSchema = z
	.string()
	.trim()
	.min(1)
	.refine((value) => !value.startsWith('/'), { message: 'Document path must be relative.' })
	.refine((value) => value.split('/').filter(Boolean).length % 2 === 0, {
		message: 'Document path must have an even number of segments.'
	});

const RelativeCollectionPathSchema = z
	.string()
	.trim()
	.min(1)
	.refine((value) => !value.startsWith('/'), { message: 'Collection path must be relative.' })
	.refine((value) => value.split('/').filter(Boolean).length % 2 === 1, {
		message: 'Collection path must have an odd number of segments.'
	});

function joinPath(base: string, suffix: string): string {
	return `${base.replace(/\/+$/g, '')}/${suffix.replace(/^\/+/g, '')}`;
}

const AUTO_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function autoId(length = 20): string {
	const bytes = new Uint8Array(length);
	try {
		globalThis.crypto.getRandomValues(bytes);
	} catch {
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	let out = '';
	for (const byte of bytes) {
		out += AUTO_ID_CHARS[byte % AUTO_ID_CHARS.length];
	}
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimestampOrNull(value: string | undefined): Timestamp | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return Timestamp.fromDate(date);
}

function decodeDocumentData(doc: FirestoreDocument, firestore: Firestore): DocumentData {
	const rawFields = doc.fields ?? {};
	const out: Record<string, unknown> = {};
	const rest = firestore._getRestClient();
	const databaseResourceName = rest.databaseResourceName();
	const referenceValueResolver = (resourceName: string) => {
		const docPath = decodeDocumentPathFromName(resourceName, databaseResourceName);
		return new DocumentReference({ firestore, path: docPath });
	};
	for (const [key, value] of Object.entries(rawFields)) {
		out[key] = fromFirestoreValue(value, { referenceValueResolver });
	}
	return out;
}

function baseUrlFromEnv(): string {
	const emulatorHost = (globalThis as unknown as { process?: { env?: Record<string, string> } })
		.process?.env?.FIRESTORE_EMULATOR_HOST;
	if (emulatorHost && emulatorHost.trim().length > 0) {
		const normalized = emulatorHost.includes('://') ? emulatorHost : `http://${emulatorHost}`;
		return normalized.replace(/\/+$/g, '');
	}
	return 'https://firestore.googleapis.com';
}

export class Firestore {
	private readonly rest: FirestoreRestClient;
	private readonly projectId: string;
	private readonly baseUrl: string;
	private readonly accessTokenProvider: () => Promise<string | null>;
	private ignoreUndefinedProperties = false;

	constructor(options: { app: App; baseUrl?: string }) {
		const serviceAccount = options.app.options.credential.getServiceAccount();
		this.projectId = options.app.options.projectId ?? serviceAccount.projectId;
		this.baseUrl = options.baseUrl ?? baseUrlFromEnv();

		this.accessTokenProvider = async () => {
			if (this.baseUrl !== 'https://firestore.googleapis.com') {
				// Emulator: no auth required.
				return null;
			}
			const { accessToken } = await getGoogleAccessToken({
				serviceAccount: {
					projectId: this.projectId,
					clientEmail: serviceAccount.clientEmail,
					privateKey: serviceAccount.privateKey,
					tokenUri: undefined
				},
				scopes: [FIRESTORE_SCOPE]
			});
			return accessToken;
		};

		this.rest = new FirestoreRestClient({
			projectId: this.projectId,
			baseUrl: this.baseUrl,
			getAccessToken: this.accessTokenProvider
		});
	}

	settings(options: { ignoreUndefinedProperties?: boolean }): void {
		if (typeof options.ignoreUndefinedProperties === 'boolean') {
			this.ignoreUndefinedProperties = options.ignoreUndefinedProperties;
		}
	}

	collection<T extends DocumentData = DocumentData>(
		collectionPath: string
	): CollectionReference<T> {
		const validated = RelativeCollectionPathSchema.parse(collectionPath);
		return new CollectionReference<T>({ firestore: this, path: validated });
	}

	collectionGroup<T extends DocumentData = DocumentData>(collectionId: string): Query<T> {
		const id = z
			.string()
			.trim()
			.min(1)
			.refine((value) => !value.includes('/'), {
				message: 'Collection group must be a collection id.'
			})
			.parse(collectionId);
		return new Query<T>({ firestore: this, collectionPath: id, allDescendants: true });
	}

	doc<T extends DocumentData = DocumentData>(documentPath: string): DocumentReference<T> {
		const validated = RelativeDocumentPathSchema.parse(documentPath);
		return new DocumentReference<T>({ firestore: this, path: validated });
	}

	batch(): WriteBatch {
		return new WriteBatch(this);
	}

	bulkWriter(options: BulkWriterOptions = {}): BulkWriter {
		return new BulkWriter(this, options);
	}

	bundle(bundleId: string = autoId()): BundleBuilder {
		return new BundleBuilder(bundleId);
	}

	async getAll<T extends DocumentData>(
		...refs: Array<DocumentReference<T>>
	): Promise<Array<DocumentSnapshot<T>>> {
		return await Promise.all(refs.map((ref) => ref.get()));
	}

	async listCollections(): Promise<Array<CollectionReference>> {
		const rest = this._getRestClient();
		const parentResourceName = `${rest.databaseResourceName()}/documents`;
		const { collectionIds } = await rest.listCollectionIds({ parentResourceName });
		return collectionIds.map((id) => this.collection(id));
	}

	async runTransaction<T>(
		updateFn: (tx: Transaction) => Promise<T>,
		options: TransactionOptions = {}
	): Promise<T> {
		const maxAttempts = options.maxAttempts ?? 5;
		let attempt = 0;
		let lastError: unknown = null;

		while (attempt < maxAttempts) {
			attempt += 1;
			try {
				const transactionId = await this.rest.beginTransaction();
				const tx = new Transaction(this, transactionId);
				const result = await updateFn(tx);
				await tx.commit();
				return result;
			} catch (error) {
				lastError = error;
				const apiStatus =
					error instanceof FirestoreApiError
						? error.apiStatus
						: error instanceof Error
							? null
							: null;
				const retryable =
					apiStatus === 'ABORTED' ||
					apiStatus === 'UNAVAILABLE' ||
					apiStatus === 'DEADLINE_EXCEEDED';
				if (!retryable || attempt >= maxAttempts) {
					throw error;
				}
				const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
				await sleep(backoffMs);
			}
		}

		throw lastError instanceof Error ? lastError : new Error('Firestore transaction failed');
	}

	// Internal hooks for references.
	_getRestClient(): FirestoreRestClient {
		return this.rest;
	}

	_getProjectId(): string {
		return this.projectId;
	}

	_getBaseUrl(): string {
		return this.baseUrl;
	}

	async _getAccessToken(): Promise<string | null> {
		return await this.accessTokenProvider();
	}

	_ignoreUndefinedProperties(): boolean {
		return this.ignoreUndefinedProperties;
	}
}

export class DocumentReference<T extends DocumentData = DocumentData> {
	readonly firestore: Firestore;
	readonly path: string;

	constructor(options: { firestore: Firestore; path: string }) {
		this.firestore = options.firestore;
		this.path = options.path;
	}

	get id(): string {
		const segments = this.path.split('/').filter(Boolean);
		const id = segments.at(-1);
		if (!id) {
			throw new Error(`Invalid document path '${this.path}'`);
		}
		return id;
	}

	get parent(): CollectionReference<T> {
		const segments = this.path.split('/').filter(Boolean);
		const parentPath = segments.slice(0, -1).join('/');
		return new CollectionReference<T>({ firestore: this.firestore, path: parentPath });
	}

	collection<U extends DocumentData = DocumentData>(
		collectionPath: string
	): CollectionReference<U> {
		const validated = RelativeCollectionPathSchema.parse(collectionPath);
		return new CollectionReference<U>({
			firestore: this.firestore,
			path: joinPath(this.path, validated)
		});
	}

	async get(): Promise<DocumentSnapshot<T>> {
		const doc = await this.firestore._getRestClient().getDocument({ documentPath: this.path });
		if (!doc) {
			return new DocumentSnapshot<T>({ ref: this, exists: false, data: null });
		}
		return new DocumentSnapshot<T>({
			ref: this,
			exists: true,
			data: decodeDocumentData(doc, this.firestore) as T,
			createTime: parseTimestampOrNull(doc.createTime),
			updateTime: parseTimestampOrNull(doc.updateTime)
		});
	}

	async create(data: T): Promise<WriteResult> {
		const encoded = encodeSetData({
			data,
			merge: false,
			ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties()
		});
		return await this.writeUpdate(encoded, { precondition: 'not-exists' });
	}

	async set(data: T, options: SetOptions = {}): Promise<WriteResult> {
		const encoded = encodeSetData({
			data,
			merge: options.merge ?? false,
			mergeFields: options.mergeFields,
			ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties()
		});
		return await this.writeUpdate(encoded, { precondition: null });
	}

	async update(data: Record<string, unknown>): Promise<WriteResult>;
	async update(
		field: string | FieldPath,
		value: unknown,
		...moreFieldsAndValues: unknown[]
	): Promise<WriteResult>;
	async update(
		dataOrField: Record<string, unknown> | string | FieldPath,
		value?: unknown,
		...moreFieldsAndValues: unknown[]
	): Promise<WriteResult> {
		const ignoreUndefinedProperties = this.firestore._ignoreUndefinedProperties();
		let data: Record<string, unknown>;

		if (typeof dataOrField === 'string' || dataOrField instanceof FieldPath) {
			const pairs = [dataOrField, value, ...moreFieldsAndValues];
			if (pairs.length < 2 || pairs.length % 2 !== 0) {
				throw new Error('update() requires field/value pairs.');
			}
			const out: Record<string, unknown> = {};
			for (let i = 0; i < pairs.length; i += 2) {
				const fieldPath = pairs[i];
				const fieldValue = pairs[i + 1];
				if (!(typeof fieldPath === 'string' || fieldPath instanceof FieldPath)) {
					throw new Error('update() field paths must be strings or FieldPath instances.');
				}
				const key = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
				out[key] = fieldValue;
			}
			data = out;
		} else {
			data = dataOrField;
		}

		const encoded = encodeUpdateData({ data, ignoreUndefinedProperties });
		return await this.writeUpdate(encoded, { precondition: 'exists' });
	}

	async delete(): Promise<WriteResult> {
		const rest = this.firestore._getRestClient();
		const docName = rest.documentResourceName(this.path);
		const resp = await rest.commit({ writes: [{ delete: docName }] });
		return writeResultFromCommit(resp, 0);
	}

	async listCollections(): Promise<Array<CollectionReference>> {
		const rest = this.firestore._getRestClient();
		const parentResourceName = rest.documentResourceName(this.path);
		const { collectionIds } = await rest.listCollectionIds({ parentResourceName });
		return collectionIds.map((id) => this.collection(id));
	}

	onSnapshot(
		onNext: (snapshot: DocumentSnapshot<T>) => void,
		onError?: (error: unknown) => void
	): () => void;
	onSnapshot(
		_options: { includeMetadataChanges?: boolean },
		onNext: (snapshot: DocumentSnapshot<T>) => void,
		onError?: (error: unknown) => void
	): () => void;
	onSnapshot(
		optionsOrOnNext:
			| { includeMetadataChanges?: boolean }
			| ((snapshot: DocumentSnapshot<T>) => void),
		onNextOrOnError?: ((snapshot: DocumentSnapshot<T>) => void) | ((error: unknown) => void),
		maybeOnError?: (error: unknown) => void
	): () => void {
		const onNext =
			typeof optionsOrOnNext === 'function'
				? optionsOrOnNext
				: (onNextOrOnError as (snapshot: DocumentSnapshot<T>) => void);
		const onError =
			typeof optionsOrOnNext === 'function'
				? (onNextOrOnError as ((error: unknown) => void) | undefined)
				: maybeOnError;

		let unsubscribe: (() => void) | null = null;
		let cancelled = false;

		void listenToDocument({
			firestore: this.firestore,
			documentPath: this.path,
			referenceValueResolver: (resourceName: string) => {
				const rest = this.firestore._getRestClient();
				const docPath = decodeDocumentPathFromName(resourceName, rest.databaseResourceName());
				return new DocumentReference({ firestore: this.firestore, path: docPath });
			},
			onNext: (event) => {
				onNext(
					new DocumentSnapshot<T>({
						ref: this,
						exists: event.exists,
						data: (event.exists ? (event.data as T) : null) ?? null
					})
				);
			},
			onError
		})
			.then((unsub) => {
				unsubscribe = unsub;
				if (cancelled) {
					unsub();
				}
			})
			.catch((error: unknown) => {
				onError?.(error);
			});

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}

	private async writeUpdate(
		encoded: EncodedDocumentWrite,
		options: { precondition: 'exists' | 'not-exists' | null }
	): Promise<WriteResult> {
		const rest = this.firestore._getRestClient();
		const write = buildUpdateWrite(this.firestore, this, encoded, {
			precondition: options.precondition
		});
		const resp = await rest.commit({ writes: [write] });
		return writeResultFromCommit(resp, 0);
	}
}

type CursorConstraint =
	| { kind: 'values'; inclusive: boolean; values: unknown[] }
	| { kind: 'snapshot'; inclusive: boolean; snapshot: DocumentSnapshot };

type QueryBound = { inclusive: boolean; values: unknown[] };

function parseCursorConstraint(inclusive: boolean, args: unknown[]): CursorConstraint {
	if (args.length === 0) {
		throw new Error('Cursor constraints require at least one value.');
	}
	if (args.length === 1 && args[0] instanceof DocumentSnapshot) {
		const snapshot = args[0];
		if (!snapshot.exists) {
			throw new Error('Cannot use a non-existing DocumentSnapshot for a query cursor.');
		}
		return { kind: 'snapshot', inclusive, snapshot: snapshot as DocumentSnapshot };
	}
	return { kind: 'values', inclusive, values: args };
}

export class Query<T extends DocumentData = DocumentData> {
	readonly firestore: Firestore;
	protected readonly collectionPath: string;
	private readonly whereFilter: FilterNode | null;
	private readonly orderByClauses: Array<{ fieldPath: string; direction: OrderDirection }>;
	private readonly limitValue: number | null;
	private readonly limitToLastValue: boolean;
	private readonly offsetValue: number | null;
	private readonly selectFieldPaths: string[] | null;
	private readonly allDescendants: boolean;
	private readonly startAtBound: CursorConstraint | null;
	private readonly endAtBound: CursorConstraint | null;

	constructor(options: {
		firestore: Firestore;
		collectionPath: string;
		where?: FilterNode | null;
		orderBy?: Array<{ fieldPath: string; direction: OrderDirection }>;
		limit?: number | null;
		limitToLast?: boolean;
		offset?: number | null;
		select?: string[] | null;
		allDescendants?: boolean;
		startAt?: CursorConstraint | null;
		endAt?: CursorConstraint | null;
	}) {
		this.firestore = options.firestore;
		this.collectionPath = options.collectionPath;
		this.whereFilter = options.where ?? null;
		this.orderByClauses = options.orderBy ?? [];
		this.limitValue = options.limit ?? null;
		this.limitToLastValue = options.limitToLast ?? false;
		this.offsetValue = options.offset ?? null;
		this.selectFieldPaths = options.select ?? null;
		this.allDescendants = options.allDescendants ?? false;
		this.startAtBound = options.startAt ?? null;
		this.endAtBound = options.endAt ?? null;
	}

	where(fieldPath: string | FieldPath, op: WhereOp, value: unknown): Query<T>;
	where(filter: Filter): Query<T>;
	where(fieldPathOrFilter: string | FieldPath | Filter, op?: WhereOp, value?: unknown): Query<T> {
		let nextFilter: FilterNode;
		if (fieldPathOrFilter instanceof Filter) {
			nextFilter = fieldPathOrFilter._toFilterNode();
		} else {
			if (!op) {
				throw new Error('where() requires an operator.');
			}
			const normalized =
				fieldPathOrFilter instanceof FieldPath ? fieldPathOrFilter.toString() : fieldPathOrFilter;
			nextFilter = { kind: 'field', fieldPath: normalized, op, value };
		}

		const combined: FilterNode =
			this.whereFilter === null
				? nextFilter
				: this.whereFilter.kind === 'composite' && this.whereFilter.op === 'AND'
					? nextFilter.kind === 'composite' && nextFilter.op === 'AND'
						? {
								kind: 'composite',
								op: 'AND',
								filters: [...this.whereFilter.filters, ...nextFilter.filters]
							}
						: { kind: 'composite', op: 'AND', filters: [...this.whereFilter.filters, nextFilter] }
					: nextFilter.kind === 'composite' && nextFilter.op === 'AND'
						? { kind: 'composite', op: 'AND', filters: [this.whereFilter, ...nextFilter.filters] }
						: { kind: 'composite', op: 'AND', filters: [this.whereFilter, nextFilter] };

		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: combined,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: this.startAtBound,
			endAt: this.endAtBound
		});
	}

	orderBy(fieldPath: string | FieldPath, direction: OrderDirection = 'asc'): Query<T> {
		const normalized = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: [...this.orderByClauses, { fieldPath: normalized, direction }],
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: this.startAtBound,
			endAt: this.endAtBound
		});
	}

	limit(limit: number): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: this.orderByClauses,
			limit,
			limitToLast: false,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: this.startAtBound,
			endAt: this.endAtBound
		});
	}

	limitToLast(limit: number): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: this.orderByClauses,
			limit,
			limitToLast: true,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: this.startAtBound,
			endAt: this.endAtBound
		});
	}

	offset(offset: number): Query<T> {
		const n = z.number().int().nonnegative().parse(offset);
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: n,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: this.startAtBound,
			endAt: this.endAtBound
		});
	}

	select(...fieldPaths: Array<string | FieldPath>): Query<T> {
		const normalized = fieldPaths.map((fieldPath) =>
			fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath
		);
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: normalized,
			allDescendants: this.allDescendants,
			startAt: this.startAtBound,
			endAt: this.endAtBound
		});
	}

	startAt(snapshot: DocumentSnapshot<T>): Query<T>;
	startAt(...fieldValues: unknown[]): Query<T>;
	startAt(...args: unknown[]): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: parseCursorConstraint(true, args),
			endAt: this.endAtBound
		});
	}

	startAfter(snapshot: DocumentSnapshot<T>): Query<T>;
	startAfter(...fieldValues: unknown[]): Query<T>;
	startAfter(...args: unknown[]): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: parseCursorConstraint(false, args),
			endAt: this.endAtBound
		});
	}

	endAt(snapshot: DocumentSnapshot<T>): Query<T>;
	endAt(...fieldValues: unknown[]): Query<T>;
	endAt(...args: unknown[]): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: this.startAtBound,
			endAt: parseCursorConstraint(true, args)
		});
	}

	endBefore(snapshot: DocumentSnapshot<T>): Query<T>;
	endBefore(...fieldValues: unknown[]): Query<T>;
	endBefore(...args: unknown[]): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereFilter,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants,
			startAt: this.startAtBound,
			endAt: parseCursorConstraint(false, args)
		});
	}

	async *getPartitions(desiredPartitionCount: number): AsyncIterable<QueryPartition<T>> {
		const partitionCount = z.number().int().positive().parse(desiredPartitionCount);
		const { rest, parentResourceName, structuredQuery } = this._buildStructuredQueryRequest();

		const databaseResourceName = rest.databaseResourceName();
		const referenceValueResolver = (resourceName: string) => {
			const docPath = decodeDocumentPathFromName(resourceName, databaseResourceName);
			return new DocumentReference({ firestore: this.firestore, path: docPath });
		};

		const splitPoints: unknown[][] = [];
		let pageToken: string | null = null;
		do {
			const resp = await rest.partitionQuery({
				parentResourceName,
				structuredQuery,
				partitionCount,
				pageToken: pageToken ?? undefined
			});
			for (const cursor of resp.partitions ?? []) {
				const values = cursor.values ?? [];
				splitPoints.push(
					values.map((value) => fromFirestoreValue(value, { referenceValueResolver }))
				);
			}
			pageToken = resp.nextPageToken;
		} while (pageToken);

		for (let i = 0; i <= splitPoints.length; i += 1) {
			yield new QueryPartition<T>({
				query: this,
				startAt: i === 0 ? undefined : splitPoints[i - 1],
				endBefore: i === splitPoints.length ? undefined : splitPoints[i]
			});
		}
	}

	private _buildStructuredQueryRequest(): {
		rest: FirestoreRestClient;
		parentResourceName: string;
		structuredQuery: unknown;
		shouldReverse: boolean;
	} {
		const validated = RelativeCollectionPathSchema.parse(this.collectionPath);
		const segments = validated.split('/').filter(Boolean);
		const collectionId = segments.at(-1);
		if (!collectionId) {
			throw new Error(`Invalid collection path '${validated}'`);
		}
		const parentPath = segments.slice(0, -1).join('/');
		const rest = this.firestore._getRestClient();

		const parentResourceName = this.allDescendants
			? `${rest.databaseResourceName()}/documents`
			: parentPath
				? rest.documentResourceName(parentPath)
				: `${rest.databaseResourceName()}/documents`;

		const shouldReverse = this.limitToLastValue && this.limitValue !== null;

		const needsOrdering = shouldReverse || this.startAtBound !== null || this.endAtBound !== null;

		let orderByClauses = this.orderByClauses;
		if (orderByClauses.length === 0 && needsOrdering) {
			orderByClauses = [{ fieldPath: '__name__', direction: 'asc' }];
		}

		if (
			needsOrdering &&
			orderByClauses.length > 0 &&
			!orderByClauses.some((entry) => entry.fieldPath === '__name__')
		) {
			const tailDir = orderByClauses.at(-1)?.direction ?? 'asc';
			orderByClauses = [...orderByClauses, { fieldPath: '__name__', direction: tailDir }];
		}

		const toBound = (cursor: CursorConstraint): QueryBound => {
			if (cursor.kind === 'snapshot') {
				const snapshot = cursor.snapshot;
				const values = orderByClauses.map((entry) => {
					if (entry.fieldPath === '__name__') {
						return snapshot.ref;
					}
					const value = snapshot.get(entry.fieldPath);
					return value === undefined ? null : value;
				});
				return { inclusive: cursor.inclusive, values };
			}

			if (cursor.values.length > orderByClauses.length) {
				throw new Error(`Too many cursor values provided (${String(cursor.values.length)}).`);
			}

			const values: unknown[] = [];
			for (let i = 0; i < cursor.values.length; i += 1) {
				const fieldPath = orderByClauses[i].fieldPath;
				let value = cursor.values[i];

				if (value instanceof DocumentSnapshot) {
					if (fieldPath !== '__name__') {
						throw new Error(
							'DocumentSnapshots can only be used as cursor values when ordering by documentId.'
						);
					}
					value = value.ref;
				}

				if (value instanceof DocumentReference && fieldPath !== '__name__') {
					throw new Error(
						'DocumentReferences can only be used as cursor values when ordering by documentId.'
					);
				}

				if (fieldPath === '__name__' && typeof value === 'string') {
					const trimmed = value.trim().replace(/^\/+/, '');
					if (trimmed.length === 0) {
						throw new Error('documentId cursor values must be non-empty strings.');
					}
					let docPath: string;
					if (trimmed.includes('/')) {
						docPath = RelativeDocumentPathSchema.parse(trimmed);
					} else {
						if (this.allDescendants) {
							throw new Error(
								'When querying a collection group, documentId cursor values must be full document paths.'
							);
						}
						docPath = joinPath(validated, trimmed);
					}
					value = new DocumentReference({ firestore: this.firestore, path: docPath });
				}

				values.push(value);
			}

			return { inclusive: cursor.inclusive, values };
		};

		const startAt = this.startAtBound ? toBound(this.startAtBound) : null;
		const endAt = this.endAtBound ? toBound(this.endAtBound) : null;

		let orderByForQuery = orderByClauses;
		let startAtForQuery = startAt;
		let endAtForQuery = endAt;
		if (shouldReverse) {
			orderByForQuery = orderByClauses.map((entry) => ({
				fieldPath: entry.fieldPath,
				direction: entry.direction === 'desc' ? 'asc' : 'desc'
			}));
			startAtForQuery = endAt;
			endAtForQuery = startAt;
		}

		const structuredQuery = encodeStructuredQuery({
			collectionId,
			allDescendants: this.allDescendants,
			select: this.selectFieldPaths,
			where: this.whereFilter,
			orderBy: orderByForQuery,
			limit: this.limitValue,
			offset: this.offsetValue,
			startAt: startAtForQuery,
			endAt: endAtForQuery
		});

		return { rest, parentResourceName, structuredQuery, shouldReverse };
	}

	async get(): Promise<QuerySnapshot<T>> {
		const { rest, parentResourceName, structuredQuery, shouldReverse } =
			this._buildStructuredQueryRequest();

		const responses = await rest.runQuery({ parentResourceName, structuredQuery });
		const docs: QueryDocumentSnapshot<T>[] = [];
		for (const entry of responses) {
			if (!entry.document) {
				continue;
			}
			const docPath = decodeDocumentPathFromName(entry.document.name, rest.databaseResourceName());
			const ref = new DocumentReference<T>({ firestore: this.firestore, path: docPath });
			docs.push(
				new QueryDocumentSnapshot<T>({
					ref,
					data: decodeDocumentData(entry.document, this.firestore) as T,
					createTime: parseTimestampOrNull(entry.document.createTime),
					updateTime: parseTimestampOrNull(entry.document.updateTime),
					readTime: parseTimestampOrNull(entry.readTime)
				})
			);
		}
		if (shouldReverse) {
			docs.reverse();
		}
		const changes = docs.map((doc, index) => ({
			type: 'added' as const,
			doc,
			oldIndex: -1,
			newIndex: index
		}));
		return new QuerySnapshot(docs, { changes });
	}

	onSnapshot(
		onNext: (snapshot: QuerySnapshot<T>) => void,
		onError?: (error: unknown) => void
	): () => void;
	onSnapshot(
		_options: { includeMetadataChanges?: boolean },
		onNext: (snapshot: QuerySnapshot<T>) => void,
		onError?: (error: unknown) => void
	): () => void;
	onSnapshot(
		optionsOrOnNext: { includeMetadataChanges?: boolean } | ((snapshot: QuerySnapshot<T>) => void),
		onNextOrOnError?: ((snapshot: QuerySnapshot<T>) => void) | ((error: unknown) => void),
		maybeOnError?: (error: unknown) => void
	): () => void {
		const onNext =
			typeof optionsOrOnNext === 'function'
				? optionsOrOnNext
				: (onNextOrOnError as (snapshot: QuerySnapshot<T>) => void);
		const onError =
			typeof optionsOrOnNext === 'function'
				? (onNextOrOnError as ((error: unknown) => void) | undefined)
				: maybeOnError;

		let unsubscribe: (() => void) | null = null;
		let cancelled = false;
		let lastSnapshot: QuerySnapshot<T> | null = null;
		let refreshing = false;
		let refreshQueued = false;

		const refresh = async () => {
			if (cancelled) {
				return;
			}
			if (refreshing) {
				refreshQueued = true;
				return;
			}
			refreshing = true;
			try {
				const latest = await this.get();
				const snapshot =
					lastSnapshot === null
						? latest
						: new QuerySnapshot<T>(latest.docs, {
								changes: computeDocChanges(lastSnapshot, latest.docs)
							});
				lastSnapshot = snapshot;
				onNext(snapshot);
			} catch (error) {
				onError?.(error);
			} finally {
				refreshing = false;
				if (refreshQueued) {
					refreshQueued = false;
					void refresh();
				}
			}
		};

		void refresh();

		const { parentResourceName, structuredQuery } = this._buildStructuredQueryRequest();

		void listenToQuery({
			firestore: this.firestore,
			parentResourceName,
			structuredQuery,
			onNext() {
				void refresh();
			},
			onError
		})
			.then((unsub) => {
				unsubscribe = unsub;
				if (cancelled) {
					unsub();
				}
			})
			.catch((error: unknown) => {
				onError?.(error);
			});

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}

	count(): AggregateQuery<T> {
		return this.aggregate({ count: AggregateField.count() });
	}

	aggregate(aggregations: Record<string, AggregateField>): AggregateQuery<T> {
		const aggregationsValue: unknown = aggregations;
		if (typeof aggregationsValue !== 'object' || aggregationsValue === null) {
			throw new Error('aggregate() requires an object mapping aliases to AggregateField.');
		}
		const entries = Object.entries(aggregations);
		if (entries.length === 0) {
			throw new Error('aggregate() requires at least one aggregation.');
		}
		for (const [alias, field] of entries) {
			if (alias.trim().length === 0) {
				throw new Error('aggregate() aliases must be non-empty strings.');
			}
			if (!(field instanceof AggregateField)) {
				throw new Error(`aggregate() value for '${alias}' must be an AggregateField.`);
			}
		}

		const { parentResourceName, structuredQuery } = this._buildStructuredQueryRequest();
		const encodedAggregations = entries.map(([alias, field]) => field._encode(alias));
		return new AggregateQuery<T>({
			query: this,
			parentResourceName,
			structuredQuery,
			aggregations: encodedAggregations
		});
	}
}

export class AggregateField {
	private readonly kind: 'count' | 'sum' | 'avg';
	private readonly fieldPath: string | null;

	private constructor(kind: 'count' | 'sum' | 'avg', fieldPath: string | null) {
		this.kind = kind;
		this.fieldPath = fieldPath;
	}

	static count(): AggregateField {
		return new AggregateField('count', null);
	}

	static sum(fieldPath: string | FieldPath): AggregateField {
		const normalized = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
		return new AggregateField('sum', normalized);
	}

	static average(fieldPath: string | FieldPath): AggregateField {
		const normalized = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
		return new AggregateField('avg', normalized);
	}

	_encode(alias: string): unknown {
		if (this.kind === 'count') {
			return { alias, count: {} };
		}
		if (!this.fieldPath) {
			throw new Error('AggregateField is missing a field path.');
		}
		if (this.kind === 'sum') {
			return { alias, sum: { field: { fieldPath: this.fieldPath } } };
		}
		return { alias, avg: { field: { fieldPath: this.fieldPath } } };
	}
}

export class AggregateQuerySnapshot {
	private readonly snapshotData: Record<string, unknown>;
	private readonly snapshotReadTime: Timestamp | null;

	constructor(options: { data: Record<string, unknown>; readTime?: Timestamp | null }) {
		this.snapshotData = options.data;
		this.snapshotReadTime = options.readTime ?? null;
	}

	data(): Record<string, unknown> {
		return { ...this.snapshotData };
	}

	get readTime(): Timestamp | undefined {
		return this.snapshotReadTime ?? undefined;
	}
}

export class AggregateQuery<T extends DocumentData = DocumentData> {
	readonly query: Query<T>;
	private readonly parentResourceName: string;
	private readonly structuredQuery: unknown;
	private readonly aggregations: unknown[];

	constructor(options: {
		query: Query<T>;
		parentResourceName: string;
		structuredQuery: unknown;
		aggregations: unknown[];
	}) {
		this.query = options.query;
		this.parentResourceName = options.parentResourceName;
		this.structuredQuery = options.structuredQuery;
		this.aggregations = options.aggregations;
	}

	async get(): Promise<AggregateQuerySnapshot> {
		const rest = this.query.firestore._getRestClient();
		const responses = await rest.runAggregationQuery({
			parentResourceName: this.parentResourceName,
			structuredAggregationQuery: {
				structuredQuery: this.structuredQuery,
				aggregations: this.aggregations
			}
		});

		const match = responses.find((entry) => entry.result?.aggregateFields);
		const aggregateFields = match?.result?.aggregateFields ?? {};
		const data: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(aggregateFields)) {
			data[key] = fromFirestoreValue(value);
		}

		return new AggregateQuerySnapshot({
			data,
			readTime: parseTimestampOrNull(match?.readTime) ?? null
		});
	}
}

export class QueryPartition<T extends DocumentData = DocumentData> {
	private readonly baseQuery: Query<T>;
	private readonly startAtValues: unknown[] | undefined;
	private readonly endBeforeValues: unknown[] | undefined;

	constructor(options: {
		query: Query<T>;
		startAt?: unknown[] | undefined;
		endBefore?: unknown[] | undefined;
	}) {
		this.baseQuery = options.query;
		this.startAtValues = options.startAt;
		this.endBeforeValues = options.endBefore;
	}

	get startAt(): unknown[] | undefined {
		return this.startAtValues ? [...this.startAtValues] : undefined;
	}

	get endBefore(): unknown[] | undefined {
		return this.endBeforeValues ? [...this.endBeforeValues] : undefined;
	}

	toQuery(): Query<T> {
		let q = this.baseQuery;
		if (this.startAtValues && this.startAtValues.length > 0) {
			q = q.startAt(...this.startAtValues);
		}
		if (this.endBeforeValues && this.endBeforeValues.length > 0) {
			q = q.endBefore(...this.endBeforeValues);
		}
		return q;
	}
}

export class CollectionReference<T extends DocumentData = DocumentData> extends Query<T> {
	readonly path: string;

	constructor(options: { firestore: Firestore; path: string }) {
		super({ firestore: options.firestore, collectionPath: options.path });
		this.path = options.path;
	}

	get id(): string {
		const segments = this.path.split('/').filter(Boolean);
		const id = segments.at(-1);
		if (!id) {
			throw new Error(`Invalid collection path '${this.path}'`);
		}
		return id;
	}

	get parent(): DocumentReference | null {
		const segments = this.path.split('/').filter(Boolean);
		if (segments.length <= 1) {
			return null;
		}
		const parentPath = segments.slice(0, -1).join('/');
		return new DocumentReference({ firestore: this.firestore, path: parentPath });
	}

	doc(documentId: string): DocumentReference<T> {
		const id = z.string().trim().min(1).parse(documentId);
		return new DocumentReference<T>({ firestore: this.firestore, path: joinPath(this.path, id) });
	}

	async add(data: T): Promise<DocumentReference<T>> {
		const ref = this.doc(autoId());
		await ref.create(data);
		return ref;
	}

	async listDocuments(options: { pageSize?: number } = {}): Promise<Array<DocumentReference<T>>> {
		const rest = this.firestore._getRestClient();
		const { documents } = await rest.listDocuments({
			collectionPath: this.path,
			pageSize: options.pageSize
		});
		return documents.map((doc) => {
			const docPath = decodeDocumentPathFromName(doc.name, rest.databaseResourceName());
			return new DocumentReference<T>({ firestore: this.firestore, path: docPath });
		});
	}
}

export class WriteBatch {
	private readonly firestore: Firestore;
	private readonly writes: unknown[] = [];

	constructor(firestore: Firestore) {
		this.firestore = firestore;
	}

	create<T extends DocumentData>(ref: DocumentReference<T>, data: T): this {
		const encoded = encodeSetData({
			data,
			merge: false,
			ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties()
		});
		this.writes.push(
			buildUpdateWrite(this.firestore, ref, encoded, { precondition: 'not-exists' })
		);
		return this;
	}

	set<T extends DocumentData>(ref: DocumentReference<T>, data: T, options: SetOptions = {}): this {
		const encoded = encodeSetData({
			data,
			merge: options.merge ?? false,
			mergeFields: options.mergeFields,
			ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties()
		});
		this.writes.push(buildUpdateWrite(this.firestore, ref, encoded, { precondition: null }));
		return this;
	}

	update<T extends DocumentData>(ref: DocumentReference<T>, data: Record<string, unknown>): this;
	update<T extends DocumentData>(
		ref: DocumentReference<T>,
		field: string | FieldPath,
		value: unknown,
		...moreFieldsAndValues: unknown[]
	): this;
	update<T extends DocumentData>(
		ref: DocumentReference<T>,
		dataOrField: Record<string, unknown> | string | FieldPath,
		value?: unknown,
		...moreFieldsAndValues: unknown[]
	): this {
		const ignoreUndefinedProperties = this.firestore._ignoreUndefinedProperties();
		let data: Record<string, unknown>;

		if (typeof dataOrField === 'string' || dataOrField instanceof FieldPath) {
			const pairs = [dataOrField, value, ...moreFieldsAndValues];
			if (pairs.length < 2 || pairs.length % 2 !== 0) {
				throw new Error('update() requires field/value pairs.');
			}
			const out: Record<string, unknown> = {};
			for (let i = 0; i < pairs.length; i += 2) {
				const fieldPath = pairs[i];
				const fieldValue = pairs[i + 1];
				if (!(typeof fieldPath === 'string' || fieldPath instanceof FieldPath)) {
					throw new Error('update() field paths must be strings or FieldPath instances.');
				}
				const key = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
				out[key] = fieldValue;
			}
			data = out;
		} else {
			data = dataOrField;
		}

		const encoded = encodeUpdateData({ data, ignoreUndefinedProperties });
		this.writes.push(buildUpdateWrite(this.firestore, ref, encoded, { precondition: 'exists' }));
		return this;
	}

	delete<T extends DocumentData>(ref: DocumentReference<T>): this {
		this.writes.push(buildDeleteWrite(this.firestore, ref));
		return this;
	}

	async commit(): Promise<WriteResult[]> {
		const resp = await this.firestore._getRestClient().commit({ writes: this.writes });
		return writeResultsFromCommit(resp, this.writes.length);
	}
}

export type BulkWriterOptions = {
	throttling?:
		| boolean
		| {
				initialOpsPerSecond?: number;
				maxOpsPerSecond?: number;
		  };
};

export class BulkWriterError extends Error {
	readonly code: number;
	readonly documentRef: DocumentReference;
	readonly operationType: 'create' | 'set' | 'update' | 'delete';
	readonly failedAttempts: number;

	constructor(options: {
		code: number;
		message: string;
		documentRef: DocumentReference;
		operationType: 'create' | 'set' | 'update' | 'delete';
		failedAttempts: number;
	}) {
		super(options.message);
		this.name = 'BulkWriterError';
		this.code = options.code;
		this.documentRef = options.documentRef;
		this.operationType = options.operationType;
		this.failedAttempts = options.failedAttempts;
	}
}

type BulkWriterOperation = {
	opId: number;
	write: unknown;
	documentRef: DocumentReference;
	operationType: 'create' | 'set' | 'update' | 'delete';
	failedAttempts: number;
	resolve: (result: WriteResult) => void;
	reject: (error: BulkWriterError) => void;
};

export class BulkWriter {
	private readonly firestore: Firestore;
	private readonly queue: BulkWriterOperation[] = [];
	private readonly pendingOpIds = new Set<number>();
	private readonly flushWaiters: Array<{ targetId: number; resolve: () => void }> = [];
	private readonly writeResultListeners: Array<
		(documentRef: DocumentReference, result: WriteResult) => void
	> = [];
	private writeErrorListener: ((error: BulkWriterError) => boolean) | null = null;
	private nextOpId = 1;
	private scheduled = false;
	private processing = false;
	private closed = false;
	private readonly maxBatchSize = 20;
	private readonly maxAttempts = 10;

	constructor(firestore: Firestore, options: BulkWriterOptions = {}) {
		void options;
		this.firestore = firestore;
	}

	private ensureOpen(): void {
		if (this.closed) {
			throw new Error('BulkWriter has already been closed.');
		}
	}

	onWriteResult(callback: (documentRef: DocumentReference, result: WriteResult) => void): void {
		this.ensureOpen();
		this.writeResultListeners.push(callback);
	}

	onWriteError(shouldRetryCallback: (error: BulkWriterError) => boolean): void {
		this.ensureOpen();
		this.writeErrorListener = shouldRetryCallback;
	}

	create<T extends DocumentData>(documentRef: DocumentReference<T>, data: T): Promise<WriteResult> {
		this.ensureOpen();
		const encoded = encodeSetData({
			data,
			merge: false,
			ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties()
		});
		const write = buildUpdateWrite(this.firestore, documentRef, encoded, {
			precondition: 'not-exists'
		});
		return this.enqueue('create', documentRef, write);
	}

	set<T extends DocumentData>(documentRef: DocumentReference<T>, data: T): Promise<WriteResult>;
	set<T extends DocumentData>(
		documentRef: DocumentReference<T>,
		data: Partial<T>,
		options: SetOptions
	): Promise<WriteResult>;
	set<T extends DocumentData>(
		documentRef: DocumentReference<T>,
		data: T | Partial<T>,
		options: SetOptions = {}
	): Promise<WriteResult> {
		this.ensureOpen();
		const encoded = encodeSetData({
			data: data as Record<string, unknown>,
			merge: options.merge ?? false,
			mergeFields: options.mergeFields,
			ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties()
		});
		const write = buildUpdateWrite(this.firestore, documentRef, encoded, { precondition: null });
		return this.enqueue('set', documentRef, write);
	}

	update<T extends DocumentData>(
		documentRef: DocumentReference<T>,
		data: Record<string, unknown>
	): Promise<WriteResult>;
	update(
		documentRef: DocumentReference,
		field: string | FieldPath,
		value: unknown,
		...moreFieldsAndValues: unknown[]
	): Promise<WriteResult>;
	update(
		documentRef: DocumentReference,
		dataOrField: Record<string, unknown> | string | FieldPath,
		value?: unknown,
		...moreFieldsAndValues: unknown[]
	): Promise<WriteResult> {
		this.ensureOpen();
		const ignoreUndefinedProperties = this.firestore._ignoreUndefinedProperties();
		let data: Record<string, unknown>;

		if (typeof dataOrField === 'string' || dataOrField instanceof FieldPath) {
			const pairs = [dataOrField, value, ...moreFieldsAndValues];
			if (pairs.length < 2 || pairs.length % 2 !== 0) {
				throw new Error('update() requires field/value pairs.');
			}
			const out: Record<string, unknown> = {};
			for (let i = 0; i < pairs.length; i += 2) {
				const fieldPath = pairs[i];
				const fieldValue = pairs[i + 1];
				if (!(typeof fieldPath === 'string' || fieldPath instanceof FieldPath)) {
					throw new Error('update() field paths must be strings or FieldPath instances.');
				}
				const key = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
				out[key] = fieldValue;
			}
			data = out;
		} else {
			data = dataOrField;
		}

		const encoded = encodeUpdateData({ data, ignoreUndefinedProperties });
		const write = buildUpdateWrite(this.firestore, documentRef, encoded, {
			precondition: 'exists'
		});
		return this.enqueue('update', documentRef, write);
	}

	delete(documentRef: DocumentReference): Promise<WriteResult> {
		this.ensureOpen();
		const write = buildDeleteWrite(this.firestore, documentRef);
		return this.enqueue('delete', documentRef, write);
	}

	flush(): Promise<void> {
		this.ensureOpen();
		const targetId = this.nextOpId - 1;
		this.schedule();
		const hasPending = [...this.pendingOpIds].some((id) => id <= targetId);
		if (!hasPending) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.flushWaiters.push({ targetId, resolve });
		});
	}

	async close(): Promise<void> {
		this.ensureOpen();
		this.closed = true;
		const targetId = this.nextOpId - 1;
		this.schedule();
		const hasPending = [...this.pendingOpIds].some((id) => id <= targetId);
		if (!hasPending) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.flushWaiters.push({ targetId, resolve });
		});
	}

	private enqueue(
		operationType: BulkWriterOperation['operationType'],
		documentRef: DocumentReference,
		write: unknown
	): Promise<WriteResult> {
		const opId = this.nextOpId;
		this.nextOpId += 1;

		let resolveFn!: (result: WriteResult) => void;
		let rejectFn!: (error: BulkWriterError) => void;
		const promise = new Promise<WriteResult>((resolve, reject) => {
			resolveFn = resolve;
			rejectFn = reject as (error: BulkWriterError) => void;
		});

		this.pendingOpIds.add(opId);
		this.queue.push({
			opId,
			write,
			documentRef,
			operationType,
			failedAttempts: 0,
			resolve: resolveFn,
			reject: rejectFn
		});

		this.schedule();
		return promise;
	}

	private schedule(): void {
		if (this.scheduled) {
			return;
		}
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			void this.processQueue();
		});
	}

	private notifyFlushWaiters(): void {
		for (let i = this.flushWaiters.length - 1; i >= 0; i -= 1) {
			const waiter = this.flushWaiters[i];
			const hasPending = [...this.pendingOpIds].some((id) => id <= waiter.targetId);
			if (hasPending) {
				continue;
			}
			this.flushWaiters.splice(i, 1);
			waiter.resolve();
		}
	}

	private takeBatch(): BulkWriterOperation[] {
		const selected: BulkWriterOperation[] = [];
		const seenPaths = new Set<string>();
		for (let i = 0; i < this.queue.length && selected.length < this.maxBatchSize; ) {
			const op = this.queue[i];
			const key = op.documentRef.path;
			if (seenPaths.has(key)) {
				i += 1;
				continue;
			}
			seenPaths.add(key);
			selected.push(op);
			this.queue.splice(i, 1);
		}
		return selected;
	}

	private async processQueue(): Promise<void> {
		if (this.processing) {
			return;
		}
		this.processing = true;
		try {
			while (this.queue.length > 0) {
				const batch = this.takeBatch();
				if (batch.length === 0) {
					break;
				}
				await this.processBatch(batch);
			}
		} finally {
			this.processing = false;
		}
	}

	private async processBatch(batch: BulkWriterOperation[]): Promise<void> {
		const rest = this.firestore._getRestClient();

		let response: Awaited<ReturnType<typeof rest.batchWrite>> | null = null;
		try {
			response = await rest.batchWrite({ writes: batch.map((entry) => entry.write) });
		} catch (error) {
			const retryQueue: BulkWriterOperation[] = [];
			let retryBackoffMs = 0;
			for (const entry of batch) {
				entry.failedAttempts += 1;
				const message = error instanceof Error ? error.message : String(error);
				const errorObj = new BulkWriterError({
					code: 0,
					message,
					documentRef: entry.documentRef,
					operationType: entry.operationType,
					failedAttempts: entry.failedAttempts
				});
				const defaultRetryable =
					error instanceof FirestoreApiError &&
					(error.apiStatus === 'ABORTED' || error.apiStatus === 'UNAVAILABLE') &&
					entry.failedAttempts < this.maxAttempts;
				const shouldRetry = this.writeErrorListener
					? this.writeErrorListener(errorObj)
					: defaultRetryable;
				if (shouldRetry && entry.failedAttempts < this.maxAttempts) {
					retryQueue.push(entry);
					const backoff = Math.min(1000 * 2 ** (entry.failedAttempts - 1), 10_000);
					retryBackoffMs = Math.max(retryBackoffMs, backoff);
					continue;
				}
				entry.reject(errorObj);
				this.pendingOpIds.delete(entry.opId);
				this.notifyFlushWaiters();
			}
			if (retryQueue.length > 0) {
				if (retryBackoffMs > 0) {
					await sleep(retryBackoffMs);
				}
				for (let i = retryQueue.length - 1; i >= 0; i -= 1) {
					this.queue.unshift(retryQueue[i]);
				}
			}
			return;
		}

		const statuses = response.status ?? [];
		const writeResults = response.writeResults ?? [];
		const retryQueue: BulkWriterOperation[] = [];
		let retryBackoffMs = 0;

		for (let i = 0; i < batch.length; i += 1) {
			const entry = batch[i];
			const status = statuses.at(i);
			const ok = !status || status.code === 0 || status.status === 'OK';
			if (ok) {
				const writeResult = writeResults.at(i);
				const writeTime = parseTimestampOrNull(writeResult?.updateTime) ?? Timestamp.now();
				const result = new WriteResult(writeTime);
				entry.resolve(result);
				for (const listener of this.writeResultListeners) {
					listener(entry.documentRef, result);
				}
				this.pendingOpIds.delete(entry.opId);
				this.notifyFlushWaiters();
				continue;
			}

			entry.failedAttempts += 1;
			const code = status.code ?? 0;
			const message = status.message ?? 'BulkWriter operation failed';
			const errorObj = new BulkWriterError({
				code,
				message,
				documentRef: entry.documentRef,
				operationType: entry.operationType,
				failedAttempts: entry.failedAttempts
			});

			const defaultRetryable =
				(status.status === 'ABORTED' || status.status === 'UNAVAILABLE') &&
				entry.failedAttempts < this.maxAttempts;
			const shouldRetry = this.writeErrorListener
				? this.writeErrorListener(errorObj)
				: defaultRetryable;

			if (shouldRetry && entry.failedAttempts < this.maxAttempts) {
				retryQueue.push(entry);
				const backoff = Math.min(1000 * 2 ** (entry.failedAttempts - 1), 10_000);
				retryBackoffMs = Math.max(retryBackoffMs, backoff);
				continue;
			}

			entry.reject(errorObj);
			this.pendingOpIds.delete(entry.opId);
			this.notifyFlushWaiters();
		}

		if (retryQueue.length > 0) {
			if (retryBackoffMs > 0) {
				await sleep(retryBackoffMs);
			}
			for (let i = retryQueue.length - 1; i >= 0; i -= 1) {
				this.queue.unshift(retryQueue[i]);
			}
		}
	}
}

export class BundleBuilder {
	readonly bundleId: string;

	constructor(bundleId: string) {
		this.bundleId = bundleId;
	}

	add(snapshotOrName: unknown, maybeSnapshot?: unknown): this {
		void snapshotOrName;
		void maybeSnapshot;
		return this;
	}

	build(): Uint8Array {
		throw new Error('Firestore bundles are not supported in firebase-admin-cloudflare yet.');
	}
}

export class Transaction {
	private readonly firestore: Firestore;
	private readonly transactionId: string;
	private readonly writes: unknown[] = [];
	private didWrite = false;

	constructor(firestore: Firestore, transactionId: string) {
		this.firestore = firestore;
		this.transactionId = transactionId;
	}

	async get<T extends DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
		if (this.didWrite) {
			throw new Error('Firestore transactions require all reads to be performed before writes.');
		}
		const rest = this.firestore._getRestClient();
		const docName = rest.documentResourceName(ref.path);
		const responses = await rest.batchGetDocuments({
			documentNames: [docName],
			transaction: this.transactionId
		});
		const doc = responses.find((resp) => !!resp.found)?.found ?? null;
		if (!doc) {
			return new DocumentSnapshot<T>({ ref, exists: false, data: null });
		}
		return new DocumentSnapshot<T>({
			ref,
			exists: true,
			data: decodeDocumentData(doc, this.firestore) as T,
			createTime: parseTimestampOrNull(doc.createTime),
			updateTime: parseTimestampOrNull(doc.updateTime)
		});
	}

	set<T extends DocumentData>(ref: DocumentReference<T>, data: T, options: SetOptions = {}): this {
		const encoded = encodeSetData({
			data,
			merge: options.merge ?? false,
			mergeFields: options.mergeFields,
			ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties()
		});
		this.didWrite = true;
		this.writes.push(buildUpdateWrite(this.firestore, ref, encoded, { precondition: null }));
		return this;
	}

	create<T extends DocumentData>(ref: DocumentReference<T>, data: T): this {
		const encoded = encodeSetData({
			data,
			merge: false,
			ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties()
		});
		this.didWrite = true;
		this.writes.push(
			buildUpdateWrite(this.firestore, ref, encoded, { precondition: 'not-exists' })
		);
		return this;
	}

	update<T extends DocumentData>(ref: DocumentReference<T>, data: Record<string, unknown>): this;
	update<T extends DocumentData>(
		ref: DocumentReference<T>,
		field: string | FieldPath,
		value: unknown,
		...moreFieldsAndValues: unknown[]
	): this;
	update<T extends DocumentData>(
		ref: DocumentReference<T>,
		dataOrField: Record<string, unknown> | string | FieldPath,
		value?: unknown,
		...moreFieldsAndValues: unknown[]
	): this {
		const ignoreUndefinedProperties = this.firestore._ignoreUndefinedProperties();
		let data: Record<string, unknown>;

		if (typeof dataOrField === 'string' || dataOrField instanceof FieldPath) {
			const pairs = [dataOrField, value, ...moreFieldsAndValues];
			if (pairs.length < 2 || pairs.length % 2 !== 0) {
				throw new Error('update() requires field/value pairs.');
			}
			const out: Record<string, unknown> = {};
			for (let i = 0; i < pairs.length; i += 2) {
				const fieldPath = pairs[i];
				const fieldValue = pairs[i + 1];
				if (!(typeof fieldPath === 'string' || fieldPath instanceof FieldPath)) {
					throw new Error('update() field paths must be strings or FieldPath instances.');
				}
				const key = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
				out[key] = fieldValue;
			}
			data = out;
		} else {
			data = dataOrField;
		}

		const encoded = encodeUpdateData({ data, ignoreUndefinedProperties });
		this.didWrite = true;
		this.writes.push(buildUpdateWrite(this.firestore, ref, encoded, { precondition: 'exists' }));
		return this;
	}

	delete<T extends DocumentData>(ref: DocumentReference<T>): this {
		this.didWrite = true;
		this.writes.push(buildDeleteWrite(this.firestore, ref));
		return this;
	}

	async commit(): Promise<void> {
		await this.firestore
			._getRestClient()
			.commit({ writes: this.writes, transaction: this.transactionId });
	}
}

function buildUpdateWrite<T extends DocumentData>(
	firestore: Firestore,
	ref: DocumentReference<T>,
	encoded: EncodedDocumentWrite,
	options: { precondition: 'exists' | 'not-exists' | null }
): unknown {
	const rest = firestore._getRestClient();
	const docName = rest.documentResourceName(ref.path);
	const write: Record<string, unknown> = {
		update: {
			name: docName,
			fields: encoded.fields
		}
	};
	if (encoded.updateMaskFieldPaths) {
		write.updateMask = { fieldPaths: encoded.updateMaskFieldPaths };
	}
	if (encoded.updateTransforms) {
		write.updateTransforms = encoded.updateTransforms;
	}
	if (options.precondition === 'exists') {
		write.currentDocument = { exists: true };
	}
	if (options.precondition === 'not-exists') {
		write.currentDocument = { exists: false };
	}
	return write;
}

function buildDeleteWrite<T extends DocumentData>(
	firestore: Firestore,
	ref: DocumentReference<T>
): unknown {
	const rest = firestore._getRestClient();
	return { delete: rest.documentResourceName(ref.path) };
}

function writeResultFromCommit(resp: CommitResponse, index: number): WriteResult {
	const updateTime = resp.writeResults?.[index]?.updateTime;
	const fallback = resp.commitTime;
	const parsed = parseTimestampOrNull(updateTime ?? fallback);
	return new WriteResult(parsed ?? Timestamp.now());
}

function writeResultsFromCommit(resp: CommitResponse, expectedWrites: number): WriteResult[] {
	const results: WriteResult[] = [];
	for (let i = 0; i < expectedWrites; i += 1) {
		results.push(writeResultFromCommit(resp, i));
	}
	return results;
}

function decodeDocumentPathFromName(resourceName: string, databaseResourceName: string): string {
	const prefix = `${databaseResourceName}/documents/`;
	if (!resourceName.startsWith(prefix)) {
		throw new Error(`Unexpected document name '${resourceName}'`);
	}
	return resourceName.slice(prefix.length);
}

const firestoreInstances = new WeakMap<App, Firestore>();

export function getFirestore(app: App = getApp()): Firestore {
	const existing = firestoreInstances.get(app);
	if (existing) {
		return existing;
	}
	const firestore = new Firestore({ app });
	firestoreInstances.set(app, firestore);
	return firestore;
}
