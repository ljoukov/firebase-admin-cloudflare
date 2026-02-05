function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

export class Bytes {
	private readonly bytes: Uint8Array;

	private constructor(bytes: Uint8Array) {
		this.bytes = new Uint8Array(bytes);
	}

	static fromBase64String(base64: string): Bytes {
		return new Bytes(base64ToBytes(base64));
	}

	static fromUint8Array(array: Uint8Array): Bytes {
		return new Bytes(array);
	}

	toBase64(): string {
		return bytesToBase64(this.bytes);
	}

	toUint8Array(): Uint8Array {
		return new Uint8Array(this.bytes);
	}

	isEqual(other: Bytes): boolean {
		const a = this.bytes;
		const b = other.bytes;
		if (a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i += 1) {
			if (a[i] !== b[i]) {
				return false;
			}
		}
		return true;
	}
}
