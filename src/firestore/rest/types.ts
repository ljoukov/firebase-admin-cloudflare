import { z } from 'zod';

export type FirestoreValue =
	| { nullValue: null }
	| { booleanValue: boolean }
	| { integerValue: string }
	| { doubleValue: number }
	| { stringValue: string }
	| { bytesValue: string }
	| { timestampValue: string }
	| { mapValue: { fields?: Record<string, FirestoreValue> } }
	| { arrayValue: { values?: FirestoreValue[] } };

export const FirestoreValueSchema: z.ZodType<FirestoreValue> = z.lazy(() =>
	z.union([
		z.object({ nullValue: z.null() }),
		z.object({ booleanValue: z.boolean() }),
		z.object({ integerValue: z.string() }),
		z.object({ doubleValue: z.number() }),
		z.object({ stringValue: z.string() }),
		z.object({ bytesValue: z.string() }),
		z.object({ timestampValue: z.string() }),
		z.object({
			mapValue: z.object({
				fields: z.record(z.string(), FirestoreValueSchema).optional()
			})
		}),
		z.object({
			arrayValue: z.object({
				values: z.array(FirestoreValueSchema).optional()
			})
		})
	])
);

export type FirestoreDocument = {
	name: string;
	fields?: Record<string, FirestoreValue>;
	createTime?: string;
	updateTime?: string;
};

export const FirestoreDocumentSchema = z.object({
	name: z.string().trim().min(1),
	fields: z.record(z.string(), FirestoreValueSchema).optional(),
	createTime: z.string().optional(),
	updateTime: z.string().optional()
});

export type RunQueryResponse = {
	document?: FirestoreDocument;
	readTime?: string;
	skippedResults?: number;
	transaction?: string;
};

export const RunQueryResponseSchema = z.object({
	document: FirestoreDocumentSchema.optional(),
	readTime: z.string().optional(),
	skippedResults: z.number().optional(),
	transaction: z.string().optional()
});

export const BeginTransactionResponseSchema = z.object({
	transaction: z.string().trim().min(1)
});

export const CommitResponseSchema = z.object({
	commitTime: z.string().optional(),
	writeResults: z
		.array(
			z.object({
				updateTime: z.string().optional(),
				transformResults: z.array(FirestoreValueSchema).optional()
			})
		)
		.optional()
});
