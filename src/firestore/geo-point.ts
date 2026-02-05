export class GeoPoint {
	readonly latitude: number;
	readonly longitude: number;

	constructor(latitude: number, longitude: number) {
		if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
			throw new Error('GeoPoint latitude/longitude must be finite numbers.');
		}
		if (latitude < -90 || latitude > 90) {
			throw new Error('GeoPoint latitude must be in [-90, 90].');
		}
		if (longitude < -180 || longitude > 180) {
			throw new Error('GeoPoint longitude must be in [-180, 180].');
		}
		this.latitude = latitude;
		this.longitude = longitude;
	}

	isEqual(other: GeoPoint): boolean {
		return this.latitude === other.latitude && this.longitude === other.longitude;
	}
}
