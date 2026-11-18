# The hosted tab-triage service

A single Vercel Edge Function, `POST /api/classify`, plus static pages: `/`, `/privacy`, and `/install`, which serves `/download/tab-triage.zip` (built during the Vercel build by `scripts/package.mjs --download-to`). It holds the TypeSafe key so people who install the extension don't need one.

The extension sends `{v, site, title, groups: [{key, description}], order}` with an anonymous install id. The service checks the request, builds the TypeSafe questions itself (`src/providers/request.ts`), makes **one** call to TypeSafe, and returns `{choice, probabilities, noul, inputTokens, model}`.

## Abuse limits

| | |
| - | - |
| **Request shape** | Only the shape above: a hostname, a title (cut to 120 characters), 1–16 groups with lowercase keys and descriptions of at most 500 characters, and a body under 32 KB. Raw TypeSafe requests are refused. Callers still choose the title and group descriptions, so the endpoint is effectively a small free classifier: the caps below are what limit abuse. |
| **Origin** | Web pages (an `http(s)` Origin) are refused. `ALLOWED_ORIGINS` restricts it to named extension ids. Browsers can't fake the Origin header but scripts can, so this keeps out other web pages and extensions, not a determined caller. |
| **Rate limits** | Per install (default 240/min) and per IP, with IPv6 grouped by /64 (default 300/min). Needs Redis. |
| **Daily caps** | A total (`DAILY_BUDGET_USD`, default $5) and a per-IP share (`PER_IP_DAILY_USD`, default 2% of the total), so one network can't pause the service for everyone. Each request reserves an estimate of its tokens up front, atomically, so parallel requests can't overshoot; the estimate is corrected after the answer. Needs Redis. |
| **Fails closed** | If Redis errors (including per-command errors inside a 200 reply), requests are refused with 503 rather than served without a cap. |
| **No retries** | The service never retries upstream; the extension does, with backoff. |

Without Redis configured at all (local runs), the request-shape and origin checks still apply, but there are no rate limits or caps.

## Privacy

The service logs only an outcome, a status and a duration per request: never the hostname, title or group descriptions. Rate-limit keys are salted SHA-256 hashes of the install id and the IP address. The per-minute keys expire after a minute; the per-IP daily count and the daily total expire after two days. Upstream error details go to the log, never to callers. See `site/privacy.html`.

## Setup (Vercel)

1. **Import the repo.** In Vercel, go to New Project and import `alwnraj/tab-triage`. Leave the framework as "Other". `vercel.json` sets the install and build commands (`node scripts/build-proxy.mjs`, which writes `.vercel/output`).
2. **Add the key.** Under Settings → Environment Variables, add `TYPESAFE_API_KEY` for Production and mark it **Sensitive**. Use a separate production key from TypeSafe, not your development one.
3. **Add Redis for the limits.** Under Storage, add Upstash Redis from the Marketplace and connect it to the project. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the service reads.
4. **Optional settings:**

   | Variable | Default | |
   | - | - | - |
   | `DAILY_BUDGET_USD` | `5` | Daily spending cap. |
   | `PER_IP_DAILY_USD` | 2% of the daily cap | One network's daily share. |
   | `PER_INSTALL_PER_MIN` | `240` | |
   | `PER_IP_PER_MIN` | `300` | |
   | `RATE_LIMIT_SALT` | derived from the API key | Optional; any random string. |
   | `ALLOWED_ORIGINS` | (any extension) | Comma-separated. The website download has a fixed id, so once the store assigns one, set `chrome-extension://ophmdbgijgbjigemcpcgcmopkahoehkp,chrome-extension://<store id>`. |

5. **Redeploy** so the variables take effect.
6. **Point the extension at it.** The production service is `https://tab-triage-pi.vercel.app`, and that's the default. A fork or staging deployment builds with `TAB_TRIAGE_SERVICE=https://<your-domain> npm run build`, which sets both the URL in the code and the manifest's only host permission. Check the domain is really yours first: `tab-triage.vercel.app`, for example, belongs to an unrelated site.
7. **Check it.** `GET /api/classify` returns `{"ok": true, "configured": true, "limits": true, "model": …}` when the key and Redis are both set, without showing either value. It never touches Redis, so it can't be used to drain it; a broken Redis shows up as 503s on POST. Don't publish the extension while `limits` is `false`.

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
