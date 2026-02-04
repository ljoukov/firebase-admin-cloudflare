import { z } from 'zod';

import type { App } from '../app/lifecycle.js';
import { getApp } from '../app/lifecycle.js';
import { getGoogleAccessToken } from '../google/access-token.js';

import type { EncodedDocumentWrite } from './rest/write-encoding.js';
import { encodeSetData, encodeUpdateData } from './rest/write-encoding.js';
import { encodeStructuredQuery, type OrderDirection, type WhereOp } from './rest/query-encoding.js';
import { FirestoreApiError, FirestoreRestClient } from './rest/client.js';
import type { FirestoreDocument } from './rest/types.js';
import { fromFirestoreValue } from './rest/value.js';
import { listenToDocument } from './listen/listen.js';

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

export type DocumentData = Record<string, unknown>;

export type SetOptions = { merge?: boolean };

export type TransactionOptions = {
	maxAttempts?: number;
};

export type DocumentSnapshotData<T extends DocumentData> = T;

export class DocumentSnapshot<T extends DocumentData = DocumentData> {
	readonly ref: DocumentReference<T>;
	readonly exists: boolean;
	private readonly _data: T | null;

	constructor(options: { ref: DocumentReference<T>; exists: boolean; data: T | null }) {
		this.ref = options.ref;
		this.exists = options.exists;
		this._data = options.data;
	}

	get id(): string {
		return this.ref.id;
	}

	data(): DocumentSnapshotData<T> | undefined {
		return this._data ?? undefined;
	}
}

export class QueryDocumentSnapshot<
	T extends DocumentData = DocumentData
> extends DocumentSnapshot<T> {
	constructor(options: { ref: DocumentReference<T>; data: T }) {
		super({ ref: options.ref, exists: true, data: options.data });
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function apiKeyFromEnv(): string | undefined {
	const apiKey = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process
		?.env?.GOOGLE_API_KEY;
	if (!apiKey || apiKey.trim().length === 0) {
		return undefined;
	}
	return apiKey.trim();
}

export class Firestore {
	private readonly rest: FirestoreRestClient;
	private readonly projectId: string;
	private readonly baseUrl: string;
	private readonly apiKey: string | null;
	private readonly accessTokenProvider: () => Promise<string | null>;

	constructor(options: { app: App; baseUrl?: string; apiKey?: string }) {
		const serviceAccount = options.app.options.credential.getServiceAccount();
		this.projectId = options.app.options.projectId ?? serviceAccount.projectId;
		this.baseUrl = options.baseUrl ?? baseUrlFromEnv();
		this.apiKey = options.apiKey?.trim().length ? options.apiKey.trim() : null;

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

	collection<T extends DocumentData = DocumentData>(
		collectionPath: string
	): CollectionReference<T> {
		const validated = RelativeCollectionPathSchema.parse(collectionPath);
		return new CollectionReference<T>({ firestore: this, path: validated });
	}

	doc<T extends DocumentData = DocumentData>(documentPath: string): DocumentReference<T> {
		const validated = RelativeDocumentPathSchema.parse(documentPath);
		return new DocumentReference<T>({ firestore: this, path: validated });
	}

	batch(): WriteBatch {
		return new WriteBatch(this);
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

	_getApiKey(): string | null {
		return this.apiKey;
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
		return new DocumentSnapshot<T>({ ref: this, exists: true, data: decodeDocumentData(doc) as T });
	}

	async set(data: T, options: SetOptions = {}): Promise<void> {
		const encoded = encodeSetData({ data, merge: options.merge ?? false });
		await this.writeUpdate(encoded, { requireExists: false });
	}

	async update(data: Record<string, unknown>): Promise<void> {
		const encoded = encodeUpdateData({ data });
		await this.writeUpdate(encoded, { requireExists: true });
	}

	async delete(): Promise<void> {
		await this.firestore._getRestClient().deleteDocument({ documentPath: this.path });
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
		options: { requireExists: boolean }
	): Promise<void> {
		const rest = this.firestore._getRestClient();
		const docName = rest.documentResourceName(this.path);

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
		if (options.requireExists) {
			write.currentDocument = { exists: true };
		}
		await rest.commit({ writes: [write] });
	}
}

export class Query<T extends DocumentData = DocumentData> {
	protected readonly firestore: Firestore;
	protected readonly collectionPath: string;
	private readonly whereClauses: Array<{ fieldPath: string; op: WhereOp; value: unknown }>;
	private readonly orderByClauses: Array<{ fieldPath: string; direction: OrderDirection }>;
	private readonly limitValue: number | null;

	constructor(options: {
		firestore: Firestore;
		collectionPath: string;
		where?: Array<{ fieldPath: string; op: WhereOp; value: unknown }>;
		orderBy?: Array<{ fieldPath: string; direction: OrderDirection }>;
		limit?: number | null;
	}) {
		this.firestore = options.firestore;
		this.collectionPath = options.collectionPath;
		this.whereClauses = options.where ?? [];
		this.orderByClauses = options.orderBy ?? [];
		this.limitValue = options.limit ?? null;
	}

	where(fieldPath: string, op: WhereOp, value: unknown): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: [...this.whereClauses, { fieldPath, op, value }],
			orderBy: this.orderByClauses,
			limit: this.limitValue
		});
	}

	orderBy(fieldPath: string, direction: OrderDirection = 'asc'): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereClauses,
			orderBy: [...this.orderByClauses, { fieldPath, direction }],
			limit: this.limitValue
		});
	}

	limit(limit: number): Query<T> {
		return new Query<T>({
			firestore: this.firestore,
			collectionPath: this.collectionPath,
			where: this.whereClauses,
			orderBy: this.orderByClauses,
			limit
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

		const parentResourceName = parentPath
			? rest.documentResourceName(parentPath)
			: `${rest.databaseResourceName()}/documents`;

		const structuredQuery = encodeStructuredQuery({
			collectionId,
			where: this.whereClauses,
			orderBy: this.orderByClauses,
			limit: this.limitValue
		});

		const responses = await rest.runQuery({ parentResourceName, structuredQuery });
		const docs: QueryDocumentSnapshot<T>[] = [];
		for (const entry of responses) {
			if (!entry.document) {
				continue;
			}
			const docPath = decodeDocumentPathFromName(
				entry.document.name,
				this.firestore._getProjectId()
			);
			const ref = new DocumentReference<T>({ firestore: this.firestore, path: docPath });
			docs.push(
				new QueryDocumentSnapshot<T>({ ref, data: decodeDocumentData(entry.document) as T })
			);
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

	doc(documentId: string): DocumentReference<T> {
		const id = z.string().trim().min(1).parse(documentId);
		return new DocumentReference<T>({ firestore: this.firestore, path: joinPath(this.path, id) });
	}
}

export class WriteBatch {
	private readonly firestore: Firestore;
	private readonly writes: unknown[] = [];

	constructor(firestore: Firestore) {
		this.firestore = firestore;
	}

	set<T extends DocumentData>(ref: DocumentReference<T>, data: T, options: SetOptions = {}): this {
		const encoded = encodeSetData({ data, merge: options.merge ?? false });
		this.writes.push(buildUpdateWrite(this.firestore, ref, encoded, { requireExists: false }));
		return this;
	}

	update<T extends DocumentData>(ref: DocumentReference<T>, data: Record<string, unknown>): this {
		const encoded = encodeUpdateData({ data });
		this.writes.push(buildUpdateWrite(this.firestore, ref, encoded, { requireExists: true }));
		return this;
	}

	delete<T extends DocumentData>(ref: DocumentReference<T>): this {
		const rest = this.firestore._getRestClient();
		this.writes.push({ delete: rest.documentResourceName(ref.path) });
		return this;
	}

	async commit(): Promise<void> {
		await this.firestore._getRestClient().commit({ writes: this.writes });
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
		const doc = await this.firestore
			._getRestClient()
			.getDocument({ documentPath: ref.path, transaction: this.transactionId });
		if (!doc) {
			return new DocumentSnapshot<T>({ ref, exists: false, data: null });
		}
		return new DocumentSnapshot<T>({ ref, exists: true, data: decodeDocumentData(doc) as T });
	}

	set<T extends DocumentData>(ref: DocumentReference<T>, data: T, options: SetOptions = {}): this {
		const encoded = encodeSetData({ data, merge: options.merge ?? false });
		this.didWrite = true;
		this.writes.push(buildUpdateWrite(this.firestore, ref, encoded, { requireExists: false }));
		return this;
	}

	update<T extends DocumentData>(ref: DocumentReference<T>, data: Record<string, unknown>): this {
		const encoded = encodeUpdateData({ data });
		this.didWrite = true;
		this.writes.push(buildUpdateWrite(this.firestore, ref, encoded, { requireExists: true }));
		return this;
	}

	delete<T extends DocumentData>(ref: DocumentReference<T>): this {
		const rest = this.firestore._getRestClient();
		this.didWrite = true;
		this.writes.push({ delete: rest.documentResourceName(ref.path) });
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
	options: { requireExists: boolean }
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
	if (options.requireExists) {
		write.currentDocument = { exists: true };
	}
	return write;
}

function decodeDocumentPathFromName(resourceName: string, projectId: string): string {
	const prefix = `projects/${projectId}/databases/(default)/documents/`;
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
	const firestore = new Firestore({ app, apiKey: apiKeyFromEnv() });
	firestoreInstances.set(app, firestore);
	return firestore;
}
