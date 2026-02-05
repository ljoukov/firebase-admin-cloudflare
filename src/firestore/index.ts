export { FieldValue, getFieldValueKind, type FieldValueKind } from './field-value.js';
export { FieldPath } from './field-path.js';
export { Filter, type FilterNode } from './filter.js';
export { Bytes } from './bytes.js';
export { GeoPoint } from './geo-point.js';
export { Timestamp } from './timestamp.js';
export type {
	BulkWriterOptions,
	DocumentChange,
	DocumentChangeType,
	DocumentData,
	SetOptions,
	TransactionOptions
} from './firestore.js';
export {
	AggregateField,
	AggregateQuery,
	AggregateQuerySnapshot,
	BulkWriter,
	BulkWriterError,
	BundleBuilder,
	CollectionReference,
	DocumentReference,
	DocumentSnapshot,
	Firestore,
	Query,
	QueryDocumentSnapshot,
	QueryPartition,
	QuerySnapshot,
	SnapshotMetadata,
	Transaction,
	WriteResult,
	WriteBatch,
	getFirestore
} from './firestore.js';

export * from './modular.js';
