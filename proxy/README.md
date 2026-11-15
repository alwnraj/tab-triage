# The hosted tab-triage service

A single Vercel Edge Function, `POST /api/classify`, plus two static pages (`/` and `/privacy`). It holds the TypeSafe key so people who install the extension don't need one.

The extension sends `{v, site, title, groups: [{key, description}], order}` with an anonymous install id. The service checks the request, builds the TypeSafe questions itself (`src/providers/request.ts`, the same code the extension used to run), makes **one** call to TypeSafe, and returns `{choice, probabilities, noul, inputTokens, model}`.

## Abuse limits

| | |
| - | - |
| **Request shape** | Only the shape above: a hostname, a title (cut to 120 characters), 1–12 groups with lowercase keys and descriptions of at most 500 characters, and a body under 16 KB. A general TypeSafe request is refused, so the endpoint is useless as a free TypeSafe proxy. |
| **Origin** | Web pages (an `http(s)` Origin) are refused. Set `ALLOWED_ORIGINS` to the published extension's origin to refuse everything else too. |
| **Rate limits** | Per install (default 120/min) and per IP (default 300/min). Needs Redis. |
| **Daily cap** | Stops, with a "paused for today" message in the extension, once the day's input tokens cost `DAILY_BUDGET_USD` (default $5). Needs Redis. |
| **No retries** | The service never retries upstream; the extension does, with backoff. |

Without Redis, the request-shape and origin checks still apply, but there is no rate limit or daily cap. Don't publish the extension until Redis is connected.

## Privacy

The service logs only an outcome, a status and a duration per request: never the hostname, title or group descriptions. Rate-limit keys are salted SHA-256 hashes of the install id and the IP address, and expire after a minute. The daily token count expires after two days. See `site/privacy.html`.

## Setup (Vercel)

1. **Import the repo.** In Vercel, go to New Project and import `alwnraj/tab-triage`. Leave the framework as "Other". `vercel.json` sets the install and build commands (`node scripts/build-proxy.mjs`, which writes `.vercel/output`).
2. **Add the key.** Under Settings → Environment Variables, add `TYPESAFE_API_KEY` for Production and mark it **Sensitive**. Use a separate production key from TypeSafe, not your development one.
3. **Add Redis for the limits.** Under Storage, add Upstash Redis from the Marketplace and connect it to the project. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the service reads.
4. **Optional settings:**

   | Variable | Default | |
   | - | - | - |
   | `DAILY_BUDGET_USD` | `5` | Daily spending cap. |
   | `PER_INSTALL_PER_MIN` | `120` | |
   | `PER_IP_PER_MIN` | `300` | |
   | `RATE_LIMIT_SALT` | `tab-triage` | Any random string; set one. |
   | `ALLOWED_ORIGINS` | (any extension) | After the Chrome Web Store assigns an id: `chrome-extension://<id>`. |

5. **Redeploy** so the variables take effect.
6. **Point the extension at it.** The production service is `https://tab-triage-pi.vercel.app`, and that's the default. A fork or staging deployment builds with `TAB_TRIAGE_SERVICE=https://<your-domain> npm run build`, which sets both the URL in the code and the manifest's only host permission. Check the domain is really yours first: `tab-triage.vercel.app`, for example, belongs to an unrelated site.
7. **Check it.** `GET /api/classify` returns `{"configured": true, "limits": true}` when both the key and Redis are set, without showing either value. Don't publish the extension while `limits` is `false`.

## Notes from the first deploy

Vercel's Edge runtime rejects `redirect: "error"` in `fetch`. Every upstream call failed as a "network" error even though the same code ran fine on Node. The service now uses `redirect: "manual"` and drops the browser-only `cache` and `credentials` fields, so it still never follows a redirect with the key attached. A 502 now names the error kind and, for network errors, the underlying message (never any request data).

## Run it locally

```bash
node scripts/build-proxy.mjs
```

```bash
node --env-file-if-exists=.env scripts/serve-proxy.mjs
```

```bash
TAB_TRIAGE_SERVICE=http://localhost:8787 npm run build
```

Then load `dist/` in Chrome. Tests: `test/proxy.test.ts`.
