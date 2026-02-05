# Firestore API compatibility

This project implements a **subset** of the Firestore JavaScript API on top of:

- REST API: https://firebase.google.com/docs/firestore/reference/rest
- RPC (WebChannel) API: https://firebase.google.com/docs/firestore/reference/rpc
- JS API reference (target surface): https://firebase.google.com/docs/reference/js/firestore_

Notes:

- The current implementation is closer to the **Admin / “classic” OO style** (e.g. `docRef.get()`, `firestore.batch()`),
  not the **modular** `firebase/firestore` functional style (e.g. `getDoc(docRef)`, `writeBatch(firestore)`).
- This is a server runtime (Cloudflare Workers) implementation: offline persistence, IndexedDB cache, bundles, and other
  browser-only features are out of scope for now and are listed as **not supported**.

Support levels used below:

- **Fully supported**: implemented and intended to behave like the JS SDK for the supported subset.
- **Partially supported**: implemented, but missing overloads/options, has known gaps, or differs in behavior/types.
- **Not supported yet**: not implemented/exported by this package.

## Fully supported

### Core entry points

- `getFirestore(app?)`
- `new Firestore({ app, baseUrl? })`

### Document reads/writes

- `firestore.doc(path)`
- `DocumentReference.get()`
- `DocumentReference.delete()`

### Collections and basic queries

- `firestore.collection(path)`
- `CollectionReference.doc(documentId)`
- `Query.get()` (for queries composed of the supported `where`/`orderBy`/`limit` subset)

### Batched writes

- `firestore.batch()`
- `WriteBatch.delete(ref)`
- `WriteBatch.commit()`

### Transactions (basic)

- `firestore.runTransaction(updateFn, { maxAttempts? })`
- `Transaction.get(ref)`
- `Transaction.delete(ref)`
- `Transaction.commit()`

### Timestamp

- `Timestamp.now()`, `Timestamp.fromDate()`, `Timestamp.fromMillis()`
- `Timestamp.toDate()`, `Timestamp.toMillis()`, `Timestamp.isEqual()`, `Timestamp.valueOf()`

## Partially supported

### API shape vs `firebase/firestore` (modular)

Notable differences from the modular JS API:

- No top-level functions like `doc()`, `collection()`, `getDoc()`, `setDoc()`, `updateDoc()`, `deleteDoc()`.
- No `writeBatch(firestore)` / `runTransaction(firestore, ...)` function forms.
- Classes like `DocumentReference`, `Query`, and `WriteBatch` are project-specific and don’t implement converters/`toJSON()`
  helpers from the modular SDK.

### Document writes

- `DocumentReference.set(data, options)`
  - Supports `{ merge?: boolean }` only (no `mergeFields`).
  - `FieldValue.delete()` is only honored when `merge: true` (otherwise ignored).
- `DocumentReference.update(data)`
  - Supports “object map” form only (no varargs overload).
  - Nested updates require dot-separated paths (no `FieldPath`).

### WriteBatch / Transaction writes

- `WriteBatch.set(ref, data, options)` / `Transaction.set(ref, data, options)`
  - Supports `{ merge?: boolean }` only (no `mergeFields`).
- `WriteBatch.update(ref, data)` / `Transaction.update(ref, data)`
  - Supports “object map” form only (no varargs overload).
  - Dot-separated field paths only (no `FieldPath`).

### Queries

- `Query.where(fieldPath, op, value)`
  - Supported operators: `==`, `<`, `<=`, `>`, `>=`.
  - Multiple `where()` clauses are combined as `AND` only.
- `Query.orderBy(fieldPath, direction)`
  - Supported directions: `'asc' | 'desc'`.
- `Query.limit(n)`
  - Supported, but there is no `limitToLast`.

### Realtime listeners

- `DocumentReference.onSnapshot(onNext, onError?)`
  - Document listeners only (no query listeners).
  - No options (`includeMetadataChanges`, etc) and no snapshot metadata surface.
  - Implemented via WebChannel `Listen` (RPC), not the browser SDK’s local cache.

### Snapshots

- `DocumentSnapshot`
  - Supports: `ref`, `id`, `exists` (boolean property), `data()`.
  - Missing: `get(fieldPath)`, `metadata`, `toJSON()`, timestamps (`createTime`/`updateTime`/`readTime`), etc.
- `QuerySnapshot`
  - Supports: `docs`, `empty`, `size`.
  - Missing: `forEach`, `docChanges`, `metadata`, `query`, `toJSON()`, etc.

### FieldValue sentinels

- Implemented:
  - `FieldValue.delete()`
  - `FieldValue.serverTimestamp()`
  - `FieldValue.arrayUnion(...elements)`
- Missing from the JS SDK surface:
  - `arrayRemove`, `increment`, and other sentinels/helpers (see below).

### Emulator support

- Supported via `FIRESTORE_EMULATOR_HOST` or `new Firestore({ baseUrl })`.
- Not via `connectFirestoreEmulator()`.

### Value encoding/decoding

Supported value types (best-effort):

- `null`, `boolean`, `number`, `string`
- `Date`, `Timestamp`
- `Uint8Array` (encoded as base64)
- Arrays and plain objects

Gaps vs the JS SDK:

- No `Bytes`, `GeoPoint`, `DocumentReference` as a stored field value, vector values, etc.
- Some unsupported JS types are coerced to strings (`bigint`, `symbol`, `function`) instead of throwing.

## Not supported yet

### Modular `firebase/firestore` functions

- Document operations: `getDoc`, `getDocs`, `setDoc`, `addDoc`, `updateDoc`, `deleteDoc`
- Reference builders: `doc`, `collection`, `collectionGroup`
- Query helpers/constraints: `query`, `where`, `orderBy`, `limit`, `limitToLast`, `startAt`, `startAfter`, `endAt`,
  `endBefore`
- Realtime: `onSnapshot` (function form), `onSnapshotsInSync`
- Writes: `writeBatch` (function form)
- Transactions: `runTransaction` (function form)
- Aggregations: `getCountFromServer`, `getAggregateFromServer`, `count`, `sum`, `average`
- Settings/network/logging: `initializeFirestore`, `connectFirestoreEmulator`, `enableNetwork`, `disableNetwork`,
  `setLogLevel`, `FirestoreSettings`, persistence helpers

### Query features

- Cursor pagination: `startAt`, `startAfter`, `endAt`, `endBefore`
- Additional filters: `!=`, `in`, `not-in`, `array-contains`, `array-contains-any`, `or` filters
- `documentId()` / `FieldPath.documentId()` sentinels
- `collectionGroup()` queries
- Aggregation queries (`RunAggregationQuery`)

### REST/RPC surface (transport)

Not yet used/implemented in this project:

- REST: `batchGet`, `batchWrite`, `createDocument`, `patch` (`UpdateDocument`), `listDocuments`, `listCollectionIds`,
  `rollback`, `partitionQuery`, `runAggregationQuery`, import/export admin endpoints
- RPC: `Write` streaming, query targets in `Listen`, and other advanced RPC features

