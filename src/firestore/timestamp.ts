export class Timestamp {
	readonly seconds: number;
	readonly nanoseconds: number;

	constructor(seconds: number, nanoseconds: number) {
		if (!Number.isFinite(seconds)) {
			throw new Error('Timestamp seconds must be a finite number');
		}
		if (!Number.isFinite(nanoseconds)) {
			throw new Error('Timestamp nanoseconds must be a finite number');
		}
		const normalizedSeconds = Math.trunc(seconds);
		const normalizedNanoseconds = Math.trunc(nanoseconds);
		if (normalizedNanoseconds < 0 || normalizedNanoseconds >= 1_000_000_000) {
			throw new Error('Timestamp nanoseconds must be in [0, 1_000_000_000)');
		}
		this.seconds = normalizedSeconds;
		this.nanoseconds = normalizedNanoseconds;
	}

	static now(): Timestamp {
		return Timestamp.fromMillis(Date.now());
	}

	static fromDate(date: Date): Timestamp {
		return Timestamp.fromMillis(date.getTime());
	}

	static fromMillis(milliseconds: number): Timestamp {
		if (!Number.isFinite(milliseconds)) {
			throw new Error('Timestamp milliseconds must be a finite number');
		}
		const ms = Math.trunc(milliseconds);
		const seconds = Math.floor(ms / 1000);
		const remainderMs = ms - seconds * 1000;
		const nanoseconds = remainderMs * 1_000_000;
		return new Timestamp(seconds, nanoseconds);
	}

	toDate(): Date {
		return new Date(this.toMillis());
	}

	toMillis(): number {
		return this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000);
	}

	isEqual(other: Timestamp): boolean {
		return this.seconds === other.seconds && this.nanoseconds === other.nanoseconds;
	}

	valueOf(): string {
		// Match firebase-admin: return a string that preserves ordering.
		const seconds = String(this.seconds).padStart(12, '0');
		const nanoseconds = String(this.nanoseconds).padStart(9, '0');
		return `${seconds}.${nanoseconds}`;
	}
}
