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
import { listenToDocument } from './listen/listen.js';
import { FieldPath } from './field-path.js';
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

export type DocumentSnapshotData<T extends DocumentData> = T;

export class DocumentSnapshot<T extends DocumentData = DocumentData> {
	readonly ref: DocumentReference<T>;
	readonly exists: boolean;
	private readonly _data: T | null;
	private readonly _createTime: Timestamp | null;
	private readonly _updateTime: Timestamp | null;
	private readonly _readTime: Timestamp | null;

	constructor(options: {
		ref: DocumentReference<T>;
		exists: boolean;
		data: T | null;
		createTime?: Timestamp | null;
		updateTime?: Timestamp | null;
		readTime?: Timestamp | null;
	}) {
		this.ref = options.ref;
		this.exists = options.exists;
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

export class QuerySnapshot<T extends DocumentData = DocumentData> {
	readonly docs: QueryDocumentSnapshot<T>[];

	constructor(docs: QueryDocumentSnapshot<T>[]) {
		this.docs = docs;
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

function decodeDocumentData(doc: FirestoreDocument): DocumentData {
	const rawFields = doc.fields ?? {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawFields)) {
		out[key] = fromFirestoreValue(value);
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
			data: decodeDocumentData(doc) as T,
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
	): () => void {
		let unsubscribe: (() => void) | null = null;
		let cancelled = false;

		void listenToDocument({
			firestore: this.firestore,
			documentPath: this.path,
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

export class Query<T extends DocumentData = DocumentData> {
	readonly firestore: Firestore;
	protected readonly collectionPath: string;
	private readonly whereClauses: Array<{ fieldPath: string; op: WhereOp; value: unknown }>;
	private readonly orderByClauses: Array<{ fieldPath: string; direction: OrderDirection }>;
	private readonly limitValue: number | null;
	private readonly limitToLastValue: boolean;
	private readonly offsetValue: number | null;
	private readonly selectFieldPaths: string[] | null;
	private readonly allDescendants: boolean;

	constructor(options: {
		firestore: Firestore;
		collectionPath: string;
		where?: Array<{ fieldPath: string; op: WhereOp; value: unknown }>;
		orderBy?: Array<{ fieldPath: string; direction: OrderDirection }>;
		limit?: number | null;
		limitToLast?: boolean;
		offset?: number | null;
		select?: string[] | null;
		allDescendants?: boolean;
	}) {
		this.firestore = options.firestore;
		this.collectionPath = options.collectionPath;
		this.whereClauses = options.where ?? [];
		this.orderByClauses = options.orderBy ?? [];
		this.limitValue = options.limit ?? null;
		this.limitToLastValue = options.limitToLast ?? false;
		this.offsetValue = options.offset ?? null;
		this.selectFieldPaths = options.select ?? null;
		this.allDescendants = options.allDescendants ?? false;
	}

	where(fieldPath: string | FieldPath, op: WhereOp, value: unknown): Query<T> {
		const normalized = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: [...this.whereClauses, { fieldPath: normalized, op, value }],
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants
		});
	}

	orderBy(fieldPath: string | FieldPath, direction: OrderDirection = 'asc'): Query<T> {
		const normalized = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereClauses,
			orderBy: [...this.orderByClauses, { fieldPath: normalized, direction }],
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants
		});
	}

	limit(limit: number): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereClauses,
			orderBy: this.orderByClauses,
			limit,
			limitToLast: false,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants
		});
	}

	limitToLast(limit: number): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereClauses,
			orderBy: this.orderByClauses,
			limit,
			limitToLast: true,
			offset: this.offsetValue,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants
		});
	}

	offset(offset: number): Query<T> {
		const n = z.number().int().nonnegative().parse(offset);
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereClauses,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: n,
			select: this.selectFieldPaths,
			allDescendants: this.allDescendants
		});
	}

	select(...fieldPaths: Array<string | FieldPath>): Query<T> {
		const normalized = fieldPaths.map((fieldPath) =>
			fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath
		);
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereClauses,
			orderBy: this.orderByClauses,
			limit: this.limitValue,
			limitToLast: this.limitToLastValue,
			offset: this.offsetValue,
			select: normalized,
			allDescendants: this.allDescendants
		});
	}

	async get(): Promise<QuerySnapshot<T>> {
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

		let orderByClauses = this.orderByClauses;
		const shouldReverse = this.limitToLastValue && this.limitValue !== null;
		if (shouldReverse) {
			if (orderByClauses.length === 0) {
				orderByClauses = [{ fieldPath: '__name__', direction: 'desc' }];
			} else {
				orderByClauses = orderByClauses.map((entry) => ({
					fieldPath: entry.fieldPath,
					direction: entry.direction === 'desc' ? 'asc' : 'desc'
				}));
			}
		}

		const structuredQuery = encodeStructuredQuery({
			collectionId,
			allDescendants: this.allDescendants,
			select: this.selectFieldPaths,
			where: this.whereClauses,
			orderBy: orderByClauses,
			limit: this.limitValue,
			offset: this.offsetValue
		});

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
					data: decodeDocumentData(entry.document) as T,
					createTime: parseTimestampOrNull(entry.document.createTime),
					updateTime: parseTimestampOrNull(entry.document.updateTime),
					readTime: parseTimestampOrNull(entry.readTime)
				})
			);
		}
		if (shouldReverse) {
			docs.reverse();
		}
		return new QuerySnapshot(docs);
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
		return new DocumentSnapshot<T>({ ref, exists: true, data: decodeDocumentData(doc) as T });
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
