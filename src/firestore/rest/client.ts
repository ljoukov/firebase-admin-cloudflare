import { z } from 'zod';

import type {
	BatchGetDocumentsResponse,
	CommitResponse,
	FirestoreDocument,
	RunQueryResponse
} from './types.js';
import {
	BatchGetDocumentsResponseSchema,
	BeginTransactionResponseSchema,
	CommitResponseSchema,
	FirestoreDocumentSchema,
	ListCollectionIdsResponseSchema,
	ListDocumentsResponseSchema,
	RunQueryResponseSchema
} from './types.js';

export type FetchLike = typeof fetch;

const GoogleApiErrorSchema = z.object({
	error: z
		.object({
			code: z.number().optional(),
			message: z.string().optional(),
			status: z.string().optional()
		})
		.optional()
});

export class FirestoreApiError extends Error {
	readonly httpStatus: number;
	readonly apiStatus: string | null;

	constructor(message: string, options: { httpStatus: number; apiStatus?: string | null }) {
		super(message);
		this.name = 'FirestoreApiError';
		this.httpStatus = options.httpStatus;
		this.apiStatus = options.apiStatus ?? null;
	}
}

function splitPathSegments(path: string): string[] {
	return path.split('/').filter((segment) => segment.length > 0);
}

function encodeResourceNameForUrl(resourceName: string): string {
	return resourceName
		.split('/')
		.filter((segment) => segment.length > 0)
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

function normalizePathForResource(path: string): string {
	return splitPathSegments(path).join('/');
}

function encodePathForUrl(path: string): string {
	return splitPathSegments(path)
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

export type FirestoreRestClientOptions = {
	projectId: string;
	databaseId?: string;
	baseUrl: string;
	getAccessToken?: () => Promise<string | null>;
	fetch?: FetchLike;
};

export class FirestoreRestClient {
	private readonly projectId: string;
	private readonly databaseId: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;
	private readonly getAccessToken?: () => Promise<string | null>;

	constructor(options: FirestoreRestClientOptions) {
		this.projectId = options.projectId;
		this.databaseId = options.databaseId ?? '(default)';
		this.baseUrl = options.baseUrl.replace(/\/+$/g, '');
		this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.getAccessToken = options.getAccessToken;
	}

	databaseResourceName(): string {
		return `projects/${this.projectId}/databases/${this.databaseId}`;
	}

	documentResourceName(documentPath: string): string {
		const normalized = normalizePathForResource(documentPath);
		return `${this.databaseResourceName()}/documents/${normalized}`;
	}

	documentUrl(documentPath: string): string {
		const encoded = encodePathForUrl(documentPath);
		return `${this.baseUrl}/v1/${this.databaseResourceName()}/documents/${encoded}`;
	}

	runQueryUrl(parentResourceName: string): string {
		const encoded = encodeResourceNameForUrl(parentResourceName);
		return `${this.baseUrl}/v1/${encoded}:runQuery`;
	}

	beginTransactionUrl(): string {
		return `${this.baseUrl}/v1/${this.databaseResourceName()}/documents:beginTransaction`;
	}

	commitUrl(): string {
		return `${this.baseUrl}/v1/${this.databaseResourceName()}/documents:commit`;
	}

	listDocumentsUrl(collectionPath: string): string {
		const encoded = encodePathForUrl(collectionPath);
		return `${this.baseUrl}/v1/${this.databaseResourceName()}/documents/${encoded}`;
	}

	listCollectionIdsUrl(parentResourceName: string): string {
		const encoded = encodeResourceNameForUrl(parentResourceName);
		return `${this.baseUrl}/v1/${encoded}:listCollectionIds`;
	}

	batchGetDocumentsUrl(): string {
		return `${this.baseUrl}/v1/${this.databaseResourceName()}/documents:batchGet`;
	}

	async getDocument(options: {
		documentPath: string;
		transaction?: string;
	}): Promise<FirestoreDocument | null> {
		const url = new URL(this.documentUrl(options.documentPath));
		if (options.transaction) {
			url.searchParams.set('transaction', options.transaction);
		}

		const resp = await this.authedFetch(url.toString(), { method: 'GET' });
		if (resp.status === 404) {
			return null;
		}
		if (!resp.ok) {
			throw await this.toError(resp, 'Firestore GET failed');
		}
		const json = await resp.json();
		return FirestoreDocumentSchema.parse(json);
	}

	async batchGetDocuments(options: {
		documentNames: string[];
		transaction?: string;
	}): Promise<BatchGetDocumentsResponse[]> {
		const body: Record<string, unknown> = {
			documents: options.documentNames
		};
		if (options.transaction) {
			body.transaction = options.transaction;
		}

		const resp = await this.authedFetch(this.batchGetDocumentsUrl(), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!resp.ok) {
			throw await this.toError(resp, 'Firestore batchGetDocuments failed');
		}

		const json = await resp.json();
		const parsed = z.array(BatchGetDocumentsResponseSchema).safeParse(json);
		if (!parsed.success) {
			throw new Error('Firestore batchGetDocuments returned an invalid JSON payload.');
		}
		return parsed.data;
	}

	async deleteDocument(options: { documentPath: string }): Promise<void> {
		const resp = await this.authedFetch(this.documentUrl(options.documentPath), {
			method: 'DELETE'
		});
		if (resp.status === 404) {
			return;
		}
		if (!resp.ok) {
			throw await this.toError(resp, 'Firestore DELETE failed');
		}
	}

	async runQuery(options: {
		parentResourceName: string;
		structuredQuery: unknown;
		transaction?: string;
	}): Promise<RunQueryResponse[]> {
		const body: Record<string, unknown> = {
			structuredQuery: options.structuredQuery
		};
		if (options.transaction) {
			body.transaction = options.transaction;
		}

		const resp = await this.authedFetch(this.runQueryUrl(options.parentResourceName), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!resp.ok) {
			throw await this.toError(resp, 'Firestore runQuery failed');
		}

		const json = await resp.json();
		const parsed = z.array(RunQueryResponseSchema).safeParse(json);
		if (!parsed.success) {
			throw new Error('Firestore runQuery returned an invalid JSON payload.');
		}
		return parsed.data;
	}

	async beginTransaction(): Promise<string> {
		const resp = await this.authedFetch(this.beginTransactionUrl(), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		if (!resp.ok) {
			throw await this.toError(resp, 'Firestore beginTransaction failed');
		}
		const json = await resp.json();
		return BeginTransactionResponseSchema.parse(json).transaction;
	}

	async commit(options: { writes: unknown[]; transaction?: string }): Promise<CommitResponse> {
		const body: Record<string, unknown> = {
			writes: options.writes
		};
		if (options.transaction) {
			body.transaction = options.transaction;
		}

		const resp = await this.authedFetch(this.commitUrl(), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!resp.ok) {
			throw await this.toError(resp, 'Firestore commit failed');
		}

		const json = await resp.json();
		return CommitResponseSchema.parse(json);
	}

	async listDocuments(options: {
		collectionPath: string;
		pageSize?: number;
		pageToken?: string;
	}): Promise<{ documents: FirestoreDocument[]; nextPageToken: string | null }> {
		const url = new URL(this.listDocumentsUrl(options.collectionPath));
		if (options.pageSize !== undefined) {
			url.searchParams.set('pageSize', String(options.pageSize));
		}
		if (options.pageToken) {
			url.searchParams.set('pageToken', options.pageToken);
		}

		const resp = await this.authedFetch(url.toString(), { method: 'GET' });
		if (!resp.ok) {
			throw await this.toError(resp, 'Firestore listDocuments failed');
		}
		const json = await resp.json();
		const parsed = ListDocumentsResponseSchema.parse(json);
		return {
			documents: parsed.documents ?? [],
			nextPageToken: parsed.nextPageToken ?? null
		};
	}

	async listCollectionIds(options: {
		parentResourceName: string;
		pageSize?: number;
		pageToken?: string;
	}): Promise<{ collectionIds: string[]; nextPageToken: string | null }> {
		const body: Record<string, unknown> = {};
		if (options.pageSize !== undefined) {
			body.pageSize = options.pageSize;
		}
		if (options.pageToken) {
			body.pageToken = options.pageToken;
		}

		const resp = await this.authedFetch(this.listCollectionIdsUrl(options.parentResourceName), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!resp.ok) {
			throw await this.toError(resp, 'Firestore listCollectionIds failed');
		}
		const json = await resp.json();
		const parsed = ListCollectionIdsResponseSchema.parse(json);
		return {
			collectionIds: parsed.collectionIds ?? [],
			nextPageToken: parsed.nextPageToken ?? null
		};
	}

	private async authedFetch(input: string, init: RequestInit): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.getAccessToken) {
			const token = await this.getAccessToken();
			if (token) {
				headers.set('authorization', `Bearer ${token}`);
			}
		}
		return await this.fetchImpl(input, { ...init, headers });
	}

	private async toError(resp: Response, prefix: string): Promise<FirestoreApiError> {
		const bodyText = await resp.text().catch(() => '');
		let apiStatus: string | null = null;
		let apiMessage: string | null = null;

		try {
			const parsed = GoogleApiErrorSchema.safeParse(JSON.parse(bodyText));
			if (parsed.success && parsed.data.error) {
				apiStatus = parsed.data.error.status ?? null;
				apiMessage = parsed.data.error.message ?? null;
			}
		} catch {
			// ignore
		}

		const suffix = apiMessage ? `: ${apiMessage}` : bodyText ? `: ${bodyText.slice(0, 500)}` : '';
		return new FirestoreApiError(`${prefix} (${String(resp.status)})${suffix}`, {
			httpStatus: resp.status,
			apiStatus
		});
	}
}
