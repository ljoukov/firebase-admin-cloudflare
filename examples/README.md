# Examples

This folder contains Cloudflare Worker examples for `@ljoukov/firebase-admin-cloudflare`.

## Worker demo

Run locally (real Firestore):

1. Create a `.env.local` at the repo root with:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (the contents of a service account key JSON file, as a string)

   You can generate/download a service account key JSON from:
   - Firebase Console → Project settings → Service accounts → Generate new private key
   - Google Cloud Console → IAM & Admin → Service Accounts → Keys → Add key → Create new key → JSON

   For Wrangler `--env-file`, you typically want the JSON on one line:

   ```bash
   jq -c . < path/to/service-account.json
   ```

2. Start the worker:

```bash
npm run example:dev
```

Then open `http://127.0.0.1:8788/`.

Deploy to Cloudflare:

```bash
npx wrangler deploy --config examples/worker/wrangler.toml
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --config examples/worker/wrangler.toml
```
