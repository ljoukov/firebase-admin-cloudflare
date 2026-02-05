import { FieldPath } from './field-path.js';
import type { WhereOp } from './rest/query-encoding.js';

export type FilterNode =
	| { kind: 'field'; fieldPath: string; op: WhereOp; value: unknown }
	| { kind: 'composite'; op: 'AND' | 'OR'; filters: FilterNode[] };

function normalizeFieldPath(fieldPath: string | FieldPath): string {
	return fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
}

function flattenComposite(op: 'AND' | 'OR', nodes: FilterNode[]): FilterNode[] {
	const out: FilterNode[] = [];
	for (const node of nodes) {
		if (node.kind === 'composite' && node.op === op) {
			out.push(...node.filters);
		} else {
			out.push(node);
		}
	}
	return out;
}

export class Filter {
	private readonly node: FilterNode;

	private constructor(node: FilterNode) {
		this.node = node;
	}

	static where(fieldPath: string | FieldPath, op: WhereOp, value: unknown): Filter {
		return new Filter({
			kind: 'field',
			fieldPath: normalizeFieldPath(fieldPath),
			op,
			value
		});
	}

	static or(...filters: Filter[]): Filter {
		if (filters.length < 2) {
			throw new Error('Filter.or() requires at least two filters.');
		}
		return new Filter({
			kind: 'composite',
			op: 'OR',
			filters: flattenComposite(
				'OR',
				filters.map((entry) => entry.node)
			)
		});
	}

	static and(...filters: Filter[]): Filter {
		if (filters.length < 2) {
			throw new Error('Filter.and() requires at least two filters.');
		}
		return new Filter({
			kind: 'composite',
			op: 'AND',
			filters: flattenComposite(
				'AND',
				filters.map((entry) => entry.node)
			)
		});
	}

	_toFilterNode(): FilterNode {
		return this.node;
	}
}
