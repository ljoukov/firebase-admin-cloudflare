# Firestore API compatibility

This project aims to be **source-compatible** with the Firebase Admin SDK Firestore API:

- Admin API (target surface): https://firebase.google.com/docs/reference/admin/node/firebase-admin.firestore

Under the hood, it talks to Firestore using:

- REST API: https://cloud.google.com/firestore/docs/reference/rest
- WebChannel RPC transport for realtime `Listen` streams (document + query listeners)

Because Cloudflare Workers don’t support Node gRPC, this library **does not** use `@google-cloud/firestore`.

Support levels used below:

- **Supported**: implemented and intended to behave like the Admin SDK for this feature.
- **Partially supported**: implemented, but missing overloads/options, or has known gaps.
- **Not supported**: not implemented (yet) in this package.

## Supported (Admin SDK style)

### Initialization

- `initializeApp({ credential: cert(serviceAccount), ... })` via `@ljoukov/firebase-admin-cloudflare/app` (**supported**)
- `getFirestore(app?)` via `@ljoukov/firebase-admin-cloudflare/firestore` (**supported**)

Deviation vs `firebase-admin`: Cloudflare Workers can’t read local JSON files, so examples typically pass the service
account JSON string via an environment variable (e.g. `GOOGLE_SERVICE_ACCOUNT_JSON`) and parse it in the Worker.

### Firestore

- `firestore.settings({ ignoreUndefinedProperties })` (**supported**)
- `firestore.collection(path)` (**supported**)
- `firestore.doc(path)` (**supported**)
- `firestore.collectionGroup(collectionId)` (**supported**; implemented via StructuredQuery `allDescendants`)
- `firestore.batch()` (**supported**)
- `firestore.bulkWriter(options?)` (**partially supported**; `throttling` options are currently ignored)
- `firestore.bundle(bundleId?)` (**not supported**; `build()` throws)
- `firestore.runTransaction(fn, { maxAttempts? })` (**supported**)
- `firestore.getAll(...docRefs)` (**supported**; uses REST `documents:batchGet`)
- `firestore.listCollections()` (**supported**; uses REST `listCollectionIds`)

### DocumentReference

- Properties: `id`, `path`, `parent`, `firestore` (**supported**)
- `get()` (**supported**)
- `create(data)` (**supported**)
- `set(data, { merge?, mergeFields? })` (**supported**)
- `update(data)` and `update(field, value, ...pairs)` (**supported**)
- `delete()` (**supported**)
- `collection(path)` (**supported**)
- `listCollections()` (**supported**; uses REST `listCollectionIds`)
- `onSnapshot(onNext, onError?)` (**supported**; document listeners only, via WebChannel `Listen`)

Note: write methods return a `WriteResult` (with `writeTime`), matching the Admin SDK shape.

### CollectionReference

- Properties: `id`, `path`, `parent`, `firestore` (**supported**)
- `CollectionReference.doc(documentId)` (**partially supported**; requires explicit `documentId` string)
- `CollectionReference.add(data)` (**supported**)
- `CollectionReference.listDocuments({ pageSize? })` (**supported**; uses REST `listDocuments`)

### Query

- `Query.where(fieldPath, op, value)` (**supported**; common ops include: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`,
  `not-in`, `array-contains`, `array-contains-any`)
- Composite filters: `Filter.where`, `Filter.or`, `Filter.and`, `Query.where(filter)` (**supported**)
- `Query.orderBy(fieldPath, direction)` (**supported**)
- Query cursors: `startAt`, `startAfter`, `endAt`, `endBefore` (**supported**)
- `Query.limit(n)` and `Query.limitToLast(n)` (**supported**; implemented by reversing the query order)
- `Query.offset(n)` (**supported**)
- `Query.select(...fieldPaths)` (**supported**)
- `Query.get()` (**supported**)
- Aggregations: `Query.count()`, `Query.aggregate({...}).get()` (**supported**; uses REST `runAggregationQuery`)
- Partition queries: `Query.getPartitions(n)` (**partially supported**; uses REST `partitionQuery`)
- Realtime: `Query.onSnapshot(...)` (**supported**; incremental WebChannel `Listen` watch processing)

### QueryPartition

- `QueryPartition.startAt`, `QueryPartition.endBefore`, `QueryPartition.toQuery()` (**supported**)

### AggregateQuerySnapshot

- `AggregateQuerySnapshot.data()`, `AggregateQuerySnapshot.readTime` (**supported**)

### Snapshots

- `DocumentSnapshot`: `exists`, `ref`, `id`, `data()`, `get(fieldPath)`, `createTime`, `updateTime`, `readTime`,
  `metadata` (**supported**)
- `QueryDocumentSnapshot`: `data()` always returns data (**supported**)
- `QuerySnapshot`: `docs`, `empty`, `size`, `forEach(cb)`, `docChanges()`, `metadata` (**supported**)
- `SnapshotMetadata.isEqual()` (**supported**)

Note: snapshot metadata is always `{ fromCache: false, hasPendingWrites: false }` (server reads).

### FieldPath / FieldValue

- `FieldPath` and `FieldPath.documentId()` (**supported**)
- `FieldValue.delete()`, `serverTimestamp()`, `arrayUnion()`, `arrayRemove()`, `increment()`, `maximum()`, `minimum()`
  (**supported**)
- `Bytes` and `GeoPoint` value types (**supported**)
- `DocumentReference` stored as a value (**supported**; encoded/decoded as `referenceValue`)

### WriteBatch / Transaction / BulkWriter

- `WriteBatch`: `create()`, `set()`, `update()`, `delete()`, `commit()` (**supported**)
- `Transaction`: `get()`, `create()`, `set()`, `update()`, `delete()`, `commit()` (**supported**)
- `BulkWriter`: `create()`, `set()`, `update()`, `delete()`, `flush()`, `close()`, `onWriteResult()`, `onWriteError()`
  (**supported**)

## Supported (client-style wrappers)

To make it easier to copy/paste examples from the client SDK docs, this package also exports a small set of
**modular-style helpers** from `@ljoukov/firebase-admin-cloudflare/firestore`:

- Reference builders: `doc()`, `collection()`
- Reads/writes: `getDoc()`, `getDocs()`, `setDoc()`, `addDoc()`, `updateDoc()`, `deleteDoc()`
- Query helpers: `query()`, `where()`, `orderBy()`, `limit()`, `limitToLast()`, `documentId()`
- Composite filters: `or()`, `and()`
- Cursors: `startAt()`, `startAfter()`, `endAt()`, `endBefore()`
- Aggregations: `count()`, `sum()`, `average()`, `getCountFromServer()`, `getAggregateFromServer()`
- Writes/transactions: `writeBatch()`, `runTransaction()`
- Sentinels: `serverTimestamp()`, `deleteField()`, `arrayUnion()`, `arrayRemove()`, `increment()`
- Realtime: `onSnapshot()` (documents and queries)

These helpers call into the Admin-style classes above; they don’t implement browser-only features like persistence or
offline cache.

## Not supported (yet)

- Bundles (`firestore.bundle(...).build()`) (method exists but `build()` throws)
- Streaming `Write` / gRPC-only APIs (Workers limitation)
- Converters (`withConverter(...)` APIs)
