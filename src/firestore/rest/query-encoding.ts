import { toFirestoreValue } from './value.js';
import type { FirestoreValue } from './types.js';
import type { FilterNode } from '../filter.js';

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
	fieldFilter: { field: { fieldPath: string }; op: string; value: FirestoreValue };
};

type StructuredQueryFilter =
	| FieldFilter
	| { compositeFilter: { op: 'AND' | 'OR'; filters: StructuredQueryFilter[] } };

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

function encodeFilterNode(node: FilterNode): StructuredQueryFilter {
	if (node.kind === 'field') {
		return {
			fieldFilter: {
				field: { fieldPath: node.fieldPath },
				op: encodeOp(node.op),
				value: toFirestoreValue(node.value)
			}
		};
	}
	return {
		compositeFilter: {
			op: node.op,
			filters: node.filters.map((entry) => encodeFilterNode(entry))
		}
	};
}

export function encodeStructuredQuery(options: {
	collectionId: string;
	allDescendants?: boolean;
	where: FilterNode | null;
	orderBy: Array<{ fieldPath: string; direction: OrderDirection }>;
	limit: number | null;
	offset?: number | null;
	select?: string[] | null;
	startAt?: { values: unknown[]; inclusive: boolean } | null;
	endAt?: { values: unknown[]; inclusive: boolean } | null;
}): unknown {
	const from = [
		options.allDescendants
			? { collectionId: options.collectionId, allDescendants: true }
			: { collectionId: options.collectionId }
	];

	const where = options.where ? encodeFilterNode(options.where) : undefined;

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
	if (options.startAt && options.startAt.values.length > 0) {
		structuredQuery.startAt = {
			before: options.startAt.inclusive,
			values: options.startAt.values.map((entry) => toFirestoreValue(entry))
		};
	}
	if (options.endAt && options.endAt.values.length > 0) {
		structuredQuery.endAt = {
			before: !options.endAt.inclusive,
			values: options.endAt.values.map((entry) => toFirestoreValue(entry))
		};
	}
	return structuredQuery;
}
