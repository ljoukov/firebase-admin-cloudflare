# @ljoukov/firebase-admin-cloudflare

[![npm version](https://img.shields.io/npm/v/@ljoukov/firebase-admin-cloudflare.svg)](https://www.npmjs.com/package/@ljoukov/firebase-admin-cloudflare)
[![npm downloads](https://img.shields.io/npm/dm/@ljoukov/firebase-admin-cloudflare.svg)](https://www.npmjs.com/package/@ljoukov/firebase-admin-cloudflare)
[![CI](https://github.com/ljoukov/firebase-admin-cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/ljoukov/firebase-admin-cloudflare/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ljoukov/firebase-admin-cloudflare.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)

Firestore “admin SDK” implementation that works on **Cloudflare Workers**, **Node.js** (18+), and **Bun** by using:

- **Firestore REST API** for CRUD / queries
- **Firestore WebChannel** transport for realtime `Listen` streams (document + query listeners)

This project is **not** an official Google/Firebase SDK.

## Status

- Stable for a growing subset of the Firebase Admin SDK Firestore API (`firebase-admin/firestore`).
- See `COMPATIBILITY.md` for the supported API surface and known gaps.

## Why this exists

The official `firebase-admin` Node SDK relies on **gRPC**, which is not available in Cloudflare Workers. Firestore’s public endpoint does **not** expose gRPC‑web, but it _does_ expose WebChannel for realtime listeners (the same transport the Firebase Web SDK uses).

## Runtime support

- **Cloudflare Workers** (primary target)
- **Node.js** 18+ (uses built-in `fetch`)
- **Bun** (uses built-in `fetch`)

## Install

```bash
npm i @ljoukov/firebase-admin-cloudflare
```

## Usage

### Initialize

#### 1) Get a service account key JSON

You need a **Google service account key JSON** for your Firebase / GCP project (this is what you put into
`GOOGLE_SERVICE_ACCOUNT_JSON`).

- **Firebase Console:** your project → ⚙️ Project settings → **Service accounts** → **Generate new private key**
- **Google Cloud Console:** IAM & Admin → **Service Accounts** → select/create an account → **Keys** → **Add key** →
  **Create new key** → JSON

![Firebase Console: service accounts → generate new private key](https://github.com/user-attachments/assets/9939573e-f2f1-48bc-93ec-b50830d5f0bb)

#### 2) Set `GOOGLE_SERVICE_ACCOUNT_JSON`

`GOOGLE_SERVICE_ACCOUNT_JSON` must be the **contents of the JSON file** (not a file path).

**Cloudflare Workers (recommended):** store it as a Wrangler secret (paste the JSON file contents when prompted):

```bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

For local dev with Wrangler `--env-file` (like this repo’s example), you typically want the JSON on one line:

```bash
jq -c . < path/to/service-account.json
```

Then copy/paste that output into your `.env.local` as the value of `GOOGLE_SERVICE_ACCOUNT_JSON`.

**Node.js / Bun (one-liner):**

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON="$(jq -c . < path/to/service-account.json)"
```

#### 3) Initialize the app

```ts
import { initializeApp } from '@ljoukov/firebase-admin-cloudflare/app';
import { getFirestore } from '@ljoukov/firebase-admin-cloudflare/firestore';

// Node.js / Bun: reads process.env.GOOGLE_SERVICE_ACCOUNT_JSON
const app = initializeApp();
const db = getFirestore(app);
```

Cloudflare Workers (module syntax) exposes secrets on the `env` argument, so pass it explicitly:

```ts
const app = initializeApp({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON });
const db = getFirestore(app);
```

You can also provide a credential directly:

```ts
import { cert, initializeApp } from '@ljoukov/firebase-admin-cloudflare/app';

const app = initializeApp({
	credential: cert({
		projectId: 'my-project',
		clientEmail: 'firebase-adminsdk-…@my-project.iam.gserviceaccount.com',
		privateKey: '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n'
	})
});
```

### Read / write documents

```ts
import { FieldValue } from '@ljoukov/firebase-admin-cloudflare/firestore';

const ref = db.collection('firebase-admin-cloudflare/demo/items').doc('item-1');

await ref.set({
	message: 'hello',
	createdAt: FieldValue.serverTimestamp()
});

await ref.set({ nested: { count: 2 } }, { merge: true });

await ref.update({
	'nested.count': 3,
	updatedAt: FieldValue.serverTimestamp()
});

const snap = await ref.get();
console.log(snap.exists, snap.data());
```

### Query

```ts
const snap = await db
	.collection('firebase-admin-cloudflare/demo/items')
	.where('status', '==', 'active')
	.orderBy('createdAt', 'desc')
	.limit(20)
	.get();

for (const doc of snap.docs) {
	console.log(doc.id, doc.data());
}
```

### Modular-style wrappers (optional)

This package also exports a small set of client-style helpers so you can copy/paste many `firebase/firestore` examples:

```ts
import {
	collection,
	getDocs,
	limit,
	orderBy,
	query,
	where
} from '@ljoukov/firebase-admin-cloudflare/firestore';

const q = query(
	collection(db, 'firebase-admin-cloudflare/demo/items'),
	where('status', '==', 'active'),
	orderBy('createdAt', 'desc'),
	limit(20)
);

const snap = await getDocs(q);
snap.forEach((doc) => console.log(doc.id, doc.data()));
```

### Realtime listen (document)

```ts
const unsubscribe = db.doc('firebase-admin-cloudflare/control').onSnapshot(
	(snap) => {
		console.log('changed', snap.exists, snap.data());
	},
	(err) => {
		console.error('listen error', err);
	}
);

// later
unsubscribe();
```

## Authentication / security

This library authenticates to Firestore using a **Google service account** and obtains an OAuth2 access token
with the `https://www.googleapis.com/auth/datastore` scope.

- This project does **not** use Application Default Credentials (ADC) or `GOOGLE_APPLICATION_CREDENTIALS`.
- If you don’t pass `credential`, `initializeApp()` will use `GOOGLE_SERVICE_ACCOUNT_JSON` (if available).
- Treat your service account JSON / private key as a **server secret**.
- Never ship it to browsers.
- In Cloudflare, store it as a **secret** (e.g. `GOOGLE_SERVICE_ACCOUNT_JSON`).

## Implemented API (current)

Surface area is intentionally minimal and grows based on real usage.

- App lifecycle:
  - `initializeApp`, `getApp`, `getApps`, `deleteApp`
  - `cert()` credential helper
- Firestore:
  - `getFirestore()`, `new Firestore({ app, baseUrl? })`
  - `collection()`, `doc()`
  - `DocumentReference`: `get`, `set({ merge? })`, `update`, `delete`, `onSnapshot`
  - `Query`: `where` (+ `Filter.or/and`), `orderBy`, `limit`, `limitToLast`, cursors (`startAt`/`endAt`…), `get`,
    `onSnapshot`
  - Aggregations: `Query.count()`, `Query.aggregate({...}).get()`
  - Partition queries: `Query.getPartitions(n)`
  - `WriteBatch`: `set`, `update`, `delete`, `commit`
  - `BulkWriter`: `bulkWriter()`, `create`, `set`, `update`, `delete`, `flush`, `close`
  - `runTransaction()` with retries for retryable errors
- Sentinels:
  - `FieldValue.delete()`, `FieldValue.serverTimestamp()`, `FieldValue.arrayUnion()`
  - `Timestamp`

## Example Worker app

There’s a runnable example Worker UI that:

- Creates / reads / updates / lists documents in `firebase-admin-cloudflare/demo/items`
- Runs a server-side background loop with `ctx.waitUntil(...)`
- Uses a Firestore document listener to stop the loop immediately when the UI writes `command=stop` to
  `firebase-admin-cloudflare/control`

### Run locally (workerd runtime + real Firestore)

1. Create `.env.local` at the repo root:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (service account key JSON as a single string — see “Usage → Initialize” above)

2. Start the example worker:

```bash
npm run example:dev
```

Then open `http://127.0.0.1:8788/`.

### Deploy to Cloudflare

```bash
npx wrangler deploy --config examples/worker/wrangler.toml
```

Then set the service account secret:

```bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --config examples/worker/wrangler.toml
```

See `examples/README.md` for more context.

## Dev

- `npm run check` → format + lint + tests + build (local)
- `npm run verify` → lint + tests + build (CI/publish)
- `npm run test:integration` → runs integration tests against the Firestore emulator (requires Java)

## Limitations / roadmap

- `firestore.bundle(...).build()` is not implemented yet (method exists; `build()` throws).

## License

MIT (see `LICENSE`).
