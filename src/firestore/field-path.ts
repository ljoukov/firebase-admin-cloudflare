const SAFE_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeBacktickSegment(segment: string): string {
	return segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

function formatSegment(segment: string): string {
	if (SAFE_SEGMENT_RE.test(segment)) {
		return segment;
	}
	return `\`${escapeBacktickSegment(segment)}\``;
}

export class FieldPath {
	readonly segments: readonly string[];

	constructor(...segments: string[]) {
		if (segments.length === 0) {
			throw new Error('FieldPath must have at least one segment.');
		}
		const normalized = segments.map((segment) => {
			if (typeof segment !== 'string' || segment.trim().length === 0) {
				throw new Error('FieldPath segments must be non-empty strings.');
			}
			return segment;
		});
		this.segments = normalized;
	}

	static documentId(): FieldPath {
		return new FieldPath('__name__');
	}

	isEqual(other: FieldPath): boolean {
		if (!(other instanceof FieldPath)) {
			return false;
		}
		if (this.segments.length !== other.segments.length) {
			return false;
		}
		for (let i = 0; i < this.segments.length; i += 1) {
			if (this.segments[i] !== other.segments[i]) {
				return false;
			}
		}
		return true;
	}

	toString(): string {
		return this.segments.map((segment) => formatSegment(segment)).join('.');
	}
}
