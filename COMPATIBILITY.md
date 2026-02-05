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

- `initializeApp({ credential: cert(serviceAccount), ... })` via `@ljoukov/firebase-admin-cloudflare/app`
- `getFirestore(app?)` via `@ljoukov/firebase-admin-cloudflare/firestore`

Deviation vs `firebase-admin`: Cloudflare Workers can’t read local JSON files, so examples typically pass the service
account JSON string via an environment variable (e.g. `GOOGLE_SERVICE_ACCOUNT_JSON`) and parse it in the Worker.

### Firestore

- `firestore.collection(path)`
- `firestore.doc(path)`
- `firestore.collectionGroup(collectionId)` (**supported**; implemented via StructuredQuery `allDescendants`)
- `firestore.batch()`
- `firestore.runTransaction(fn, { maxAttempts? })`
- `firestore.getAll(...docRefs)` (**supported**; implemented as parallel `get()` calls)
- `firestore.listCollections()` (**supported**; uses REST `listCollectionIds`)
- `firestore.settings({ ignoreUndefinedProperties })` (**supported**)

### DocumentReference

- `get()`
- `create(data)` (**supported**)
- `set(data, { merge?, mergeFields? })` (**supported**)
- `update(data)` and `update(field, value, ...pairs)` (**supported**)
- `delete()` (**supported**)
- `collection(path)`
- `listCollections()` (**supported**; uses REST `listCollectionIds`)
- `onSnapshot(onNext, onError?)` (**supported**; document listeners only, via WebChannel `Listen`)

Note: write methods return a `WriteResult` (with `writeTime`), matching the Admin SDK shape.

### CollectionReference / Query

- `CollectionReference.add(data)` (**supported**)
- `CollectionReference.listDocuments({ pageSize? })` (**supported**; uses REST `listDocuments`)
- `Query.where(fieldPath, op, value)` (**supported**, common ops including: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`,
  `not-in`, `array-contains`, `array-contains-any`)
- Composite filters: `Filter.where`, `Filter.or`, `Filter.and`, `Query.where(filter)` (**supported**)
- `Query.orderBy(fieldPath, direction)`
- Query cursors: `startAt`, `startAfter`, `endAt`, `endBefore` (**supported**)
- `Query.limit(n)` and `Query.limitToLast(n)` (**supported**; implemented by reversing the query order)
- `Query.offset(n)` (**supported**)
- `Query.select(...fieldPaths)` (**supported**)
- `Query.get()`
- Aggregations: `Query.count()`, `Query.aggregate({...}).get()` (**supported**; uses REST `runAggregationQuery`)
- Partition queries: `Query.getPartitions(n)` (**partially supported**; uses REST `partitionQuery`)
- Realtime: `Query.onSnapshot(...)` (**partially supported**; uses WebChannel `Listen` and refreshes via REST `get()`)

### Snapshots

- `DocumentSnapshot`: `exists`, `ref`, `id`, `data()`, `get(fieldPath)`, `createTime`, `updateTime`, `readTime`,
  `metadata`
- `QuerySnapshot`: `docs`, `empty`, `size`, `forEach(cb)`, `docChanges()`, `metadata`

Note: snapshot metadata is always `{ fromCache: false, hasPendingWrites: false }` (server reads).

### FieldPath / FieldValue

- `FieldPath` and `FieldPath.documentId()`
- `FieldValue.delete()`, `serverTimestamp()`, `arrayUnion()`, `arrayRemove()`, `increment()`, `maximum()`, `minimum()`
- `Bytes` and `GeoPoint` value types
- `DocumentReference` stored as a value (**supported**; encoded/decoded as `referenceValue`)

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

The Admin SDK surface is large (it re-exports most of `@google-cloud/firestore`). Notable gaps include:

- Bundles (`firestore.bundle(...).build()`) (method exists but `build()` throws)
- Streaming `Write` / gRPC-only APIs (Workers limitation)
