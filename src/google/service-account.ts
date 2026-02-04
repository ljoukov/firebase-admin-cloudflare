import { z } from 'zod';

export const ServiceAccountJsonSchema = z
	.object({
		project_id: z.string().trim().min(1),
		client_email: z.string().trim().min(1),
		private_key: z.string().trim().min(1),
		token_uri: z.string().trim().min(1).optional()
	})
	.transform(({ project_id, client_email, private_key, token_uri }) => ({
		projectId: project_id,
		clientEmail: client_email,
		privateKey: private_key.replace(/\\n/g, '\n'),
		tokenUri: token_uri
	}));

export type GoogleServiceAccount = z.infer<typeof ServiceAccountJsonSchema>;

export function parseServiceAccountJson(raw: string): GoogleServiceAccount {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid service account JSON: ${message}`);
	}
	return ServiceAccountJsonSchema.parse(parsed);
}
