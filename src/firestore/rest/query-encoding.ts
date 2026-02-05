import { toFirestoreValue } from './value.js';
import type { FirestoreValue } from './types.js';

export type WhereOp =
	| '=='
	| '<'
	| '<='
	| '>'
	| '>='
	| '!='
	| 'in'
	| 'not-in'
	| 'array-contains'
	| 'array-contains-any';
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
		case '!=':
			return 'NOT_EQUAL';
		case 'in':
			return 'IN';
		case 'not-in':
			return 'NOT_IN';
		case 'array-contains':
			return 'ARRAY_CONTAINS';
		case 'array-contains-any':
			return 'ARRAY_CONTAINS_ANY';
		default: {
			throw new Error(`Unsupported where op '${String(op)}'`);
		}
	}
}

export function encodeStructuredQuery(options: {
	collectionId: string;
	allDescendants?: boolean;
	where: Array<{ fieldPath: string; op: WhereOp; value: unknown }>;
	orderBy: Array<{ fieldPath: string; direction: OrderDirection }>;
	limit: number | null;
	offset?: number | null;
	select?: string[] | null;
}): unknown {
	const from = [
		options.allDescendants
			? { collectionId: options.collectionId, allDescendants: true }
			: { collectionId: options.collectionId }
	];

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
	if (options.select && options.select.length > 0) {
		structuredQuery.select = {
			fields: options.select.map((fieldPath) => ({ fieldPath }))
		};
	}
	if (where) {
		structuredQuery.where = where;
	}
	if (orderBy.length > 0) {
		structuredQuery.orderBy = orderBy;
	}
	if (options.limit !== null) {
		structuredQuery.limit = options.limit;
	}
	if (options.offset !== null && options.offset !== undefined) {
		structuredQuery.offset = options.offset;
	}
	return structuredQuery;
}
