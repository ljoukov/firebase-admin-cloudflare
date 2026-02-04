import { z } from 'zod';

import { FirestoreDocumentSchema } from '../rest/types.js';

const TargetChangeSchema = z.object({
	targetChangeType: z.string().optional(),
	targetIds: z.array(z.number().int()).optional(),
	readTime: z.string().optional(),
	resumeToken: z.string().optional(),
	cause: z
		.object({
			code: z.number().int().optional(),
			message: z.string().optional(),
			status: z.string().optional()
		})
		.optional()
});

const DocumentChangeSchema = z.object({
	document: FirestoreDocumentSchema,
	targetIds: z.array(z.number().int()).optional(),
	removedTargetIds: z.array(z.number().int()).optional()
});

const DocumentDeleteSchema = z.object({
	document: z.string(),
	removedTargetIds: z.array(z.number().int()).optional(),
	readTime: z.string().optional()
});

const DocumentRemoveSchema = z.object({
	document: z.string(),
	removedTargetIds: z.array(z.number().int()).optional()
});

const FilterSchema = z.object({
	targetId: z.number().int(),
	count: z.number().int().optional(),
	unchangedNames: z.string().optional()
});

export const ListenResponseSchema = z.union([
	z.object({ targetChange: TargetChangeSchema }),
	z.object({ documentChange: DocumentChangeSchema }),
	z.object({ documentDelete: DocumentDeleteSchema }),
	z.object({ documentRemove: DocumentRemoveSchema }),
	z.object({ filter: FilterSchema })
]);

export type ListenResponse = z.infer<typeof ListenResponseSchema>;

export const WebChannelErrorSchema = z.object({
	error: z.object({
		status: z.string().optional(),
		message: z.string().optional()
	})
});
