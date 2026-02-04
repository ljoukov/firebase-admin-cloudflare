import { toFirestoreValue } from './value.js';
import type { FirestoreValue } from './types.js';

export type WhereOp = '==' | '<' | '<=' | '>' | '>=';
export type OrderDirection = 'asc' | 'desc';

type FieldFilter = {
	fieldFilter: {
		field: { fieldPath: string };
		op: string;
		value: FirestoreValue;
	};
};

type Filter = FieldFilter | { compositeFilter: { op: 'AND'; filters: Filter[] } };

function encodeOp(op: WhereOp): string {
	switch (op) {
		case '==':
			return 'EQUAL';
		case '<':
			return 'LESS_THAN';
		case '<=':
			return 'LESS_THAN_OR_EQUAL';
		case '>':
			return 'GREATER_THAN';
		case '>=':
			return 'GREATER_THAN_OR_EQUAL';
		default: {
			throw new Error(`Unsupported where op '${String(op)}'`);
		}
	}
}

export function encodeStructuredQuery(options: {
	collectionId: string;
	where: Array<{ fieldPath: string; op: WhereOp; value: unknown }>;
	orderBy: Array<{ fieldPath: string; direction: OrderDirection }>;
	limit: number | null;
}): unknown {
	const from = [{ collectionId: options.collectionId }];

	let where: Filter | undefined;
	const filters: Filter[] = options.where.map((entry) => ({
		fieldFilter: {
			field: { fieldPath: entry.fieldPath },
			op: encodeOp(entry.op),
			value: toFirestoreValue(entry.value)
		}
	}));
	if (filters.length === 1) {
		where = filters[0];
	} else if (filters.length > 1) {
		where = { compositeFilter: { op: 'AND', filters } };
	}

	const orderBy = options.orderBy.map((entry) => ({
		field: { fieldPath: entry.fieldPath },
		direction: entry.direction === 'desc' ? 'DESCENDING' : 'ASCENDING'
	}));

	const structuredQuery: Record<string, unknown> = { from };
	if (where) {
		structuredQuery.where = where;
	}
	if (orderBy.length > 0) {
		structuredQuery.orderBy = orderBy;
	}
	if (options.limit !== null) {
		structuredQuery.limit = options.limit;
	}
	return structuredQuery;
}
