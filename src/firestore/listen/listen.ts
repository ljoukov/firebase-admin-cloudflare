import { z } from 'zod';

import type { FirestoreRestClient } from '../rest/client.js';
import { FirestoreApiError } from '../rest/client.js';
import type { FirestoreValue } from '../rest/types.js';
import { fromFirestoreValue } from '../rest/value.js';

import { openWebChannel } from './webchannel.js';
import { ListenResponseSchema, WebChannelErrorSchema } from './types.js';

const AddTargetRequestSchema = z.object({
	database: z.string().min(1),
	addTarget: z.object({
		targetId: z.number().int().positive(),
		documents: z.object({
			documents: z.array(z.string().min(1)).min(1)
		})
	})
});

type Unsubscribe = () => void;

export type FirestoreListenDocumentEvent = {
	exists: boolean;
	data: Record<string, unknown> | null;
};

type FirestoreLike = {
	_getRestClient(): FirestoreRestClient;
	_getBaseUrl(): string;
	_getAccessToken(): Promise<string | null>;
};

function decodeDocumentFields(
	fields: Record<string, FirestoreValue> | undefined
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields ?? {})) {
		out[key] = fromFirestoreValue(value);
	}
	return out;
}

export async function listenToDocument(options: {
	firestore: FirestoreLike;
	documentPath: string;
	onNext: (event: FirestoreListenDocumentEvent) => void;
	onError?: (error: unknown) => void;
}): Promise<Unsubscribe> {
	const rest = options.firestore._getRestClient();
	const database = rest.databaseResourceName();
	const documentName = rest.documentResourceName(options.documentPath);
	const accessToken = await options.firestore._getAccessToken();

	const headers: Record<string, string> = {};
	if (accessToken) {
		headers.Authorization = `Bearer ${accessToken}`;
	}

	let closed = false;
	let closeResolver: (() => void) | null = null;
	const closedPromise = new Promise<void>((resolve) => {
		closeResolver = resolve;
	});

	const listener = openWebChannel({
		baseUrl: options.firestore._getBaseUrl(),
		rpcPath: 'google.firestore.v1.Firestore',
		methodName: 'Listen',
		database,
		initMessageHeaders: headers,
		onMessage(message) {
			if (closed) {
				return;
			}

			const errorParsed = WebChannelErrorSchema.safeParse(message);
			if (errorParsed.success) {
				const status = errorParsed.data.error.status ?? 'UNKNOWN';
				const msg = errorParsed.data.error.message ?? 'WebChannel error';
				options.onError?.(new FirestoreApiError(msg, { httpStatus: 0, apiStatus: status }));
				listener.close();
				return;
			}

			const parsed = ListenResponseSchema.safeParse(message);
			if (!parsed.success) {
				return;
			}

			const value = parsed.data;
			if ('documentChange' in value) {
				const doc = value.documentChange.document;
				const data = decodeDocumentFields(doc.fields);
				options.onNext({ exists: true, data });
				return;
			}

			if ('documentDelete' in value || 'documentRemove' in value) {
				options.onNext({ exists: false, data: null });
				return;
			}
		},
		onError(error) {
			if (closed) {
				return;
			}
			options.onError?.(error);
		},
		onClose() {
			if (closed) {
				return;
			}
			closed = true;
			closeResolver?.();
		}
	});

	const request = AddTargetRequestSchema.parse({
		database,
		addTarget: {
			targetId: 1,
			documents: { documents: [documentName] }
		}
	});
	listener.send(request);

	return () => {
		if (closed) {
			return;
		}
		closed = true;
		listener.close();
		closeResolver?.();
		void closedPromise;
	};
}
