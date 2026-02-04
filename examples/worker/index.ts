import { Firestore, cert, getApps, initializeApp } from '../../src/index.js';
import { parseServiceAccountJson } from '../../src/google/service-account.js';
import { FieldValue } from '../../src/firestore/index.js';

type Env = {
	GOOGLE_SERVICE_ACCOUNT_JSON: string;
	FIRESTORE_EMULATOR_HOST?: string;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function json(data: JsonValue, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function html(body: string, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set('content-type', 'text/html; charset=utf-8');
	return new Response(body, { ...init, headers });
}

let cachedAppName: string | null = null;
let cachedFirestore: Firestore | null = null;

function ensureApp(env: Env) {
	const existing = getApps();
	if (cachedAppName && existing.some((app) => app.name === cachedAppName)) {
		const match = existing.find((app) => app.name === cachedAppName);
		if (match) {
			return match;
		}
	}

	if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON.trim().length === 0) {
		throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
	}

	const sa = parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON);
	const app = initializeApp(
		{
			credential: cert({
				projectId: sa.projectId,
				clientEmail: sa.clientEmail,
				privateKey: sa.privateKey
			}),
			projectId: sa.projectId
		},
		'example'
	);

	cachedAppName = app.name;
	return app;
}

function ensureFirestore(env: Env) {
	if (cachedFirestore) {
		return cachedFirestore;
	}
	const app = ensureApp(env);
	const baseUrl = env.FIRESTORE_EMULATOR_HOST?.trim().length
		? env.FIRESTORE_EMULATOR_HOST.includes('://')
			? env.FIRESTORE_EMULATOR_HOST
			: `http://${env.FIRESTORE_EMULATOR_HOST}`
		: undefined;
	cachedFirestore = new Firestore({ app, baseUrl });
	return cachedFirestore;
}

function itemsCollectionPath(): string {
	return 'firebase-admin-cloudflare/demo/items';
}

function controlDocPath(): string {
	return 'firebase-admin-cloudflare/control';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (!signal) {
			return;
		}
		if (signal.aborted) {
			clearTimeout(timer);
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

async function runStopDemo(env: Env): Promise<void> {
	const firestore = ensureFirestore(env);
	const controlRef = firestore.doc(controlDocPath());

	const controller = new AbortController();
	const stopSignal = controller.signal;

	const unsubscribe = controlRef.onSnapshot(
		(snapshot) => {
			const command = snapshot.data()?.command ?? null;
			if (command === 'stop') {
				console.log('[demo] stop requested via Firestore');
				controller.abort();
			}
		},
		(error) => {
			console.error('[demo] listen error', error);
			controller.abort();
		}
	);

	try {
		let i = 0;
		while (!stopSignal.aborted) {
			i += 1;
			console.log(`[demo] hello #${String(i)}`);
			await sleep(4000, stopSignal);
		}
	} finally {
		unsubscribe();
		console.log('[demo] stopped');
	}
}

function page(): string {
	return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>firebase-admin-cloudflare example</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin: 2rem; }
      button { padding: 0.6rem 0.8rem; margin: 0.25rem 0.5rem 0.25rem 0; }
      pre { background: #0b1020; color: #e6e6e6; padding: 1rem; border-radius: 10px; overflow: auto; }
      .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
      input { padding: 0.5rem 0.6rem; min-width: 18rem; }
    </style>
  </head>
  <body>
    <h1>firebase-admin-cloudflare example (Worker + real Firestore)</h1>
    <p>Uses collection <code>${itemsCollectionPath()}</code> and control doc <code>${controlDocPath()}</code>.</p>

    <div class="row">
      <input id="docId" placeholder="doc id (optional)" />
      <button id="create">Create doc</button>
      <button id="merge">Merge update (set+merge)</button>
      <button id="update">Update (dot paths)</button>
      <button id="read">Read doc</button>
      <button id="list">List docs</button>
    </div>

    <h2>Stop demo</h2>
    <div class="row">
      <button id="start">Start background loop</button>
      <button id="stop">Stop (writes command=stop)</button>
      <button id="clearStop">Clear stop</button>
    </div>
    <p>Open your Worker logs; the background loop prints "hello #n" and should stop immediately when you press Stop.</p>

    <h2>Response</h2>
    <pre id="out">Click a button…</pre>

    <script>
      const out = document.getElementById('out');
      const docIdInput = document.getElementById('docId');
      function val() { return (docIdInput.value || '').trim(); }
      async function call(method, path, body) {
        const resp = await fetch(path, {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined
        });
        const text = await resp.text();
        out.textContent = text;
      }

      document.getElementById('create').onclick = () => call('POST', '/api/create', { id: val() || null });
      document.getElementById('merge').onclick = () => call('POST', '/api/merge', { id: val() || null });
      document.getElementById('update').onclick = () => call('POST', '/api/update', { id: val() || null });
      document.getElementById('read').onclick = () => call('POST', '/api/read', { id: val() || null });
      document.getElementById('list').onclick = () => call('GET', '/api/list');
      document.getElementById('start').onclick = () => call('POST', '/api/start');
      document.getElementById('stop').onclick = () => call('POST', '/api/stop');
      document.getElementById('clearStop').onclick = () => call('POST', '/api/clear-stop');
    </script>
  </body>
</html>`;
}

async function parseJsonBody(request: Request): Promise<unknown> {
	const text = await request.text();
	if (!text) {
		return null;
	}
	return JSON.parse(text) as unknown;
}

function resolveDocId(input: unknown): string {
	if (typeof input === 'string' && input.trim().length > 0) {
		return input.trim();
	}
	return `doc-${String(Date.now())}`;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const url = new URL(request.url);
			const { pathname } = url;

			if (pathname === '/') {
				return html(page());
			}

			if (pathname === '/api/list' && request.method === 'GET') {
				const firestore = ensureFirestore(env);
				const snap = await firestore
					.collection(itemsCollectionPath())
					.orderBy('createdAt', 'desc')
					.limit(20)
					.get();
				return json({
					docs: snap.docs.map((doc) => ({ id: doc.id, data: doc.data() as JsonValue }))
				});
			}

			if (pathname.startsWith('/api/') && request.method === 'POST') {
				const body = (await parseJsonBody(request)) as { id?: unknown } | null;
				const id = resolveDocId(body?.id);
				const firestore = ensureFirestore(env);
				const docRef = firestore.collection(itemsCollectionPath()).doc(id);

				if (pathname === '/api/create') {
					await docRef.set({
						id,
						message: 'created',
						createdAt: FieldValue.serverTimestamp(),
						updatedAt: FieldValue.serverTimestamp(),
						nested: { count: 1 }
					});
					return json({ ok: true, id });
				}

				if (pathname === '/api/merge') {
					await docRef.set(
						{
							updatedAt: FieldValue.serverTimestamp(),
							nested: { count: 2 }
						},
						{ merge: true }
					);
					return json({ ok: true, id });
				}

				if (pathname === '/api/update') {
					await docRef.update({
						'nested.count': 3,
						updatedAt: FieldValue.serverTimestamp(),
						'nested.note': 'updated via update()'
					});
					return json({ ok: true, id });
				}

				if (pathname === '/api/read') {
					const snap = await docRef.get();
					return json({
						ok: true,
						id,
						exists: snap.exists,
						data: (snap.data() ?? null) as JsonValue
					});
				}

				if (pathname === '/api/start') {
					const controlRef = firestore.doc(controlDocPath());
					await controlRef.set(
						{ command: 'run', updatedAt: FieldValue.serverTimestamp() },
						{ merge: true }
					);
					ctx.waitUntil(runStopDemo(env));
					return json({ ok: true, status: 'started' });
				}

				if (pathname === '/api/stop') {
					const controlRef = firestore.doc(controlDocPath());
					await controlRef.set(
						{ command: 'stop', updatedAt: FieldValue.serverTimestamp() },
						{ merge: true }
					);
					return json({ ok: true, status: 'stop_written' });
				}

				if (pathname === '/api/clear-stop') {
					const controlRef = firestore.doc(controlDocPath());
					await controlRef.set(
						{ command: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
						{ merge: true }
					);
					return json({ ok: true, status: 'cleared' });
				}
			}

			return json({ error: 'not_found' }, { status: 404 });
		} catch (error) {
			console.error('[worker] unhandled error', error);
			const message = error instanceof Error ? error.message : String(error);
			return json({ error: message }, { status: 500 });
		}
	}
};
