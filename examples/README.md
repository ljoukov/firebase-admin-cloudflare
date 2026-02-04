# Examples

This folder contains Cloudflare Worker examples for `firebase-admin-cloudflare`.

## Worker demo

Run locally (real Firestore):

1. Create a `.env.local` at the repo root with:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (service account JSON as a string)
2. Start the worker:

```bash
npm run example:dev
```

Then open `http://127.0.0.1:8788/`.
