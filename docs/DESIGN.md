# tab-triage design

Status: written before any code for review #1, then kept current. Sections 1–14 are the original design, updated in place where reviews changed it; sections 15–16 record what changed and why.

## 1. What it does

When you click **Sort** in the popup, tab-triage sorts the tabs in the current window into native Chrome tab groups that you defined. It only groups a tab when a calibrated classifier is confident. Every other tab stays where it is. **Undo** puts everything back.

## 2. Sources this design relies on

- OpenAPI spec `https://api.typesafe.ai/openapi.json` (v0.2.0): `POST /v1/systemone`, Bearer auth. The request body is `{model, state, questions}`. The response is `{model, answers, usage: {input_tokens, output_tokens}}`.
- Docs pages: Choice, Noul, Confidence, Companion Noul, Probability routing, Request rules and errors, Models, Model jaggedness.
- Price: $0.042 per million input tokens (`docs.typesafe.ai/models`, Jev 1.13 and 1.14). Output tokens are free. It is stored in one constant, `PRICE_USD_PER_INPUT_TOKEN`.
- Model: pinned to `jev-1.14.0` rather than `jev-latest`. The Models page warns that aliases move and change answers, and thresholds tuned against one version should pin it. This is the `MODEL_ID` constant.

## 3. Pipeline (per Sort run)

```
popup ──{sort, windowId, threshold}──▶ service worker
  1. snapshot window (tabs: id,index,groupId,pinned; groups: id,title,color,collapsed)
  2. filter: skip pinned, non-http(s) (chrome://, chrome-extension://, file:, about:),
     blocklisted hostnames, tabs already in a group
  3. domain table: hostname matches a user-mapped domain → decided, p = 1, source = "domain"
  4. remaining tabs → classifier (cache first), concurrency ≤ 4
  5. decide (pure function of raw answers + threshold)
  6. if ANY classifier call failed → move nothing, report error
     else apply plan (group, title, color, collapse)
  7. persist snapshot for Undo, return results + metrics to popup
```

**Classify everything first, then apply.** A run either applies its whole plan or moves nothing. With the cache, a retry after a transient failure costs almost no calls.

**The pipeline runs in the service worker.** The popup closes as soon as it loses focus, so it can't run the pipeline itself. The worker has no "current window", so the popup sends its own `windowId` (from `chrome.windows.getCurrent()`, or from a `?window=` query parameter when the popup is opened in a popup-type window for the demo).

## 4. The request (one per tab per ordering)

```jsonc
{
  "model": "jev-1.14.0",
  "state": { "site": "<hostname>", "title": "<title, max 120 chars>" },
  "questions": {
    "group": {
      "type": "choice",
      "instructions": "Which of these tab groups does the browser tab described by `site` and `title` belong in?",
      "criteria": { "research": "<user description>", "shopping": "<user description>" }
    },
    "fits": {
      "type": "noul",
      "instructions": {
        "question": "Does the browser tab described by `site` and `title` clearly belong in one of `groups`?",
        "groups": { "research": "<description>", "...": "..." }
      },
      "criteria": {
        "true": "The tab plainly matches the description of one of the groups.",
        "false": "The tab is about a topic that none of the group descriptions cover."
      }
    }
  }
}
```

- **Option keys** are a lowercase ASCII slug of the group name (`research`), de-duplicated with `_2`, `_3`. Option names are sent to the model, so they stay plain descriptive words. Only an all-digit name gets a `g_` prefix (`g_2024`), because JavaScript orders integer-like keys first and that would quietly undo the reversal. (Until prompt version `p2`, every key had the prefix.) The key is mapped back to the group id in code. Probabilities are read **by key** and never by position.
- **The state is kept minimal.** The model-jaggedness doc says unrelated content in `state` costs accuracy, so it holds only the hostname and title.
- **Zero model-eligible groups means no API call.** This is the case when every group is domain-only, or there are no groups.

## 5. Decision rule (pure, `src/core/decide.ts`)

Let `t` be the threshold (default 0.8). `top` is the Choice's selected key, `p = probabilities[top]`, and `n = fits.noul`. The rule thresholds the **probability** and the **Noul**, not `confidence`.

1. `n < t` or `p < t` → **ungrouped** (reason `no-fit` or `low-prob`).
2. `p ≥ t + 0.1` → **grouped** as `top`.
3. `t ≤ p < t + 0.1` (near the threshold) → look at the reversed-order answer:
   - it chose the same `top` → **grouped**
   - it chose something else → **ungrouped** (reason `order-disagree`)
   - it hasn't been fetched yet → `needs-reverse`, so fetch it and decide again.

The brief says "within 0.1 of the threshold". Answers that are 0.1 or less **below** `t` still fail rule 1, and agreement can't rescue them, so they never trigger a reverse request. Rule 3 implements that brief with no blending: the base rule still applies, and the reversed answer can only veto. The probability shown in the UI is the forward answer's.

**Order reversal:** the reversed request lists both the Choice `criteria` and the Noul `groups` in reverse insertion order. JSON objects are unordered by spec, so whether the server's model actually sees the order we send is **unverified** until it can be tested with a live key (see DEVLOG). Logging the reversed answers in the eval will show whether order changes anything.

## 6. Caching (`src/core/cache.ts`)

- Key: `sha256(hostname + "\n" + title120 + "\n" + groupsHash + "\n" + MODEL_ID + "\n" + PROMPT_VERSION + "\n" + order)`, where `order` is `fwd` or `rev`. Mock answers are never cached.
- `groupsHash` = sha256 of the canonical JSON of the model-eligible groups' `(key, description)` pairs in order. Editing a description invalidates the cache.
- Value: the **raw answer** `{choice, probabilities, noul, inputTokens, at}`, not the decision. The slider changes what the decision is, so we cache what the API returned and decide afterwards.
- TTL is 7 days. Expired entries are evicted on read and pruned at the start of each run. Stored in `chrome.storage.local` under the `cache:` prefix.
- Cache keys are hashes, but the stored values hold no hostname or title. Only probabilities and the chosen key are kept.

## 7. Provider (`src/providers/typesafe.ts`) behind `Classifier`

```ts
interface Classifier {
  readonly id: string;              // "typesafe:jev-1.14.0", "mock"
  classify(input: TabInput, groups: ModelGroup[], order: "fwd" | "rev", signal?: AbortSignal): Promise<RawAnswer>;
}
```

- `fetch` is injected, so it is mockable in tests and works in both Node and the service worker.
- Timeout: 5 s per attempt (`AbortController`). Up to 2 retries (3 attempts in total) with backoff of 500 ms and then 1500 ms, plus jitter.
- **Retried:** network errors, timeouts, 429, 529 and other 5xx. A `retry-after` header (in seconds) is honored, capped at 5 s.
- **Not retried:** 400, 401, 403, 413, 415 and 422. These raise a typed `ClassifierError` with a `kind`: `auth`, `rate_limit`, `bad_request`, `timeout`, `network`, `server`.
- The response is validated (it must contain `answers.group.type === "choice"`, a `probabilities` object, and `answers.fits.noul` as a number). Otherwise it fails with `bad_response`.
- The API key never appears in error messages or logs. Errors carry the status and kind only, never the request body.
- **Gemini later:** a second `Classifier` implementation can map to the same `RawAnswer`. `decide`, `plan` and `cache` don't change. The only provider-specific part is the shape of the request.

`MockClassifier` matches keywords from the group descriptions against the hostname and title, and returns made-up probabilities. It drives tests and demo rehearsal, and the UI labels any run that used it as **MOCK**.

## 8. Applying the plan (`src/core/plan.ts` + `src/browser/adapter.ts`)

- `buildPlan(decisions, groups, existingGroups)` is a pure function that returns `[{groupId, tabIds, reuseExistingGroupId?}]`. It reuses an existing group in the window whose title equals the group's name.
- The adapter uses `chrome.tabs.group({tabIds, groupId?, createProperties: {windowId}})` and then `chrome.tabGroups.update(id, {title, color, collapsed})`.
- `withEditRetry(fn)`: if the error message contains "Tabs cannot be edited right now", wait 50 ms and retry, at most 10 times.
- Everything is scoped to `windowId`.

## 9. Undo

The snapshot is taken right before the first move (after classification) and stored in `chrome.storage.session`, so it survives a service-worker restart but not a browser restart, and never touches disk. It holds, for every tab in the window: `{tabId, index, groupId, pinned}`. For every group: `{groupId, title, color, collapsed}`.

Restoring works like this:
1. Skip tabs that no longer exist.
2. Ungroup the tabs that were ungrouped before.
3. For tabs that were in a group before: if that group still exists, put them back in it. If it was emptied and deleted, recreate it from the snapshot's title, color and collapsed state, and map the old group id to the new one.
4. Move tabs to their original indexes in ascending order.
5. Restore the title, color and collapsed state of groups that already existed and that we changed.

Undo covers one level only, and only the last run.

## 10. Privacy

- Sent: `site` (the hostname only, from `new URL(url).hostname`), `title` (truncated to 120 characters), and the user's group slugs and descriptions. Nothing else: no path, query, fragment, favicon, page content or tab IDs.
- Skipped entirely: non-http(s) URLs, extension pages, pinned tabs and blocklisted hostnames (a suffix match, so `bank.com` also blocks `www.bank.com`).
- Domain-table matches never reach the API.
- A first-run consent screen appears. Sort stays disabled until the user accepts, and the options page has a "what gets sent" panel that shows a live example built from the same `buildRequest()` function the provider uses.
- Permissions: `tabs`, `tabGroups`, `storage`, and host permission `https://api.typesafe.ai/*`. Nothing else.
- The key lives in `chrome.storage.local`. Nothing logs it, and dev scripts read `TYPESAFE_API_KEY` from the environment.
- Eval files: `eval/labeled.json` (real titles) and `eval/out/` are **gitignored**. Only the synthetic set, a template and aggregate results are ever committed.

## 11. Metrics shown in the popup

- `latencyMs`: wall-clock time from the start of the run to the moment the plan was applied, measured in the worker.
- `inputTokens`: the sum of `usage.input_tokens` over the API calls made this run. Cache hits count 0.
- `estCostUsd = inputTokens × PRICE_USD_PER_INPUT_TOKEN`.
- `apiCalls`, `cacheHits`, `sortedPct` (grouped / eligible).

## 12. Eval

- `eval/synthetic.dev.json` holds about 60 hand-written tabs. It is **SYNTHETIC, dev-only**, and every output generated from it is stamped `SYNTHETIC — not a real result`.
- `npm run eval:label` writes `eval/labeled.json` with `label: null`. On macOS it reads the open tabs through AppleScript, read-only and only when you run it. It can also convert an export file from the Options page. It never touches the browser profile on disk.
- `npm run eval` makes one pass over the API that collects both orderings for every tab. Before starting it refuses if the planned requests (tabs × 2 orders) exceed `--max-calls` (default 100); during the pass, every HTTP attempt including retries counts against the same cap, and the pass stops if retries would push it over. A threshold sweep then runs in code:
  - coverage(t) is the share of tabs that get grouped.
  - accuracy(t) is the share of grouped tabs whose group matches the label (`none` labels count as wrong whenever they get grouped).
  - Reliability bins (10 bins over [0, 1]) for the Choice's top probability compared with being correct, and for the Noul compared with whether the label is not `none`. ECE is reported too.
  - Domain-table rows are **reported separately** and left out of the calibration bins, because their probability of 1 would flatter the result.
- Outputs: aggregates in `eval/results/<name>.{csv,svg,json}` (the SVG is self-contained); per-row answers, which contain titles, in gitignored `eval/out/`. Data is treated as synthetic if the flag, the path or the file's `_WARNING` field says so, and such outputs are stamped and named `synthetic*`.

## 13. Failure UX

The popup shows a single line, such as "Couldn't reach TypeSafe (timeout after 3 tries). No tabs were moved." It never throws to the console without catching. An auth failure links to Options.

## 14. Open questions and risks

- Key order inside the JSON object, see §5. Unverified.
- `tabs.group` throws on tabs in another window. We guard against that by scope.
- Chrome may batch-delete emptied groups at different times. The undo path re-queries groups instead of trusting the snapshot ids.

## 15. Changes after review #1

These items override the sections above where the two conflict.

| Finding | Change |
| - | - |
| Mock answers could be served from the cache as real | Mock answers are **never cached**. The cache key includes the model id (`mock` ≠ `jev-1.14.0`) and a `PROMPT_VERSION`. Mock mode is a developer toggle on the Options page, and every report, popup footer and caption shows **MOCK**. |
| Snapshot saved after apply | The snapshot is saved **before the first move**. If applying fails partway, the run rolls back from the snapshot (`runSort` in `src/core/sort.ts`). |
| Undo across browser restarts | The snapshot lives in `chrome.storage.session`, which is cleared when the browser restarts (tab ids don't survive a restart anyway). It still survives service-worker restarts. It stores `windowId`. |
| One bad tab could block every run | 400, 422 and malformed answers are **per-tab**: that tab stays ungrouped (reason `error`) and the run continues. Auth, 429, 529, 5xx, network and timeout errors abort the run with no moves. |
| Stale plan | Before applying, the worker re-queries the window and moves only tabs whose hostname and title still match what was classified. Changed tabs are counted as `staleTabs`. |
| Concurrent Sorts / popup closed | The worker holds a run lock (a second Sort is refused). The last report is saved in `chrome.storage.session`, and the popup reads it when it opens. |
| Worker lifetime | Each extension API call and pending `fetch` keeps an MV3 worker alive (Chrome ≥ 116 resets the idle timer on extension API calls). Worst case per tab is 3 × 5 s + 2 s backoff per ordering, and runs use a concurrency of 4. |
| Privacy gaps | Incognito windows are refused. localhost, IP literals, single-label intranet names and private suffixes (`.local`, `.internal`, …) are never sent. The worker itself refuses to Sort before consent is given. `eval:label` applies the same filters and writes only hostname plus the 120-char title. `.gitignore` is in the first commit. |
| Untrusted titles | All UI renders text with `textContent` and never `innerHTML`. The manifest sets a strict `content_security_policy.extension_pages` (`script-src 'self'; object-src 'none'`). The worker accepts messages only from its own extension id and checks that `windowId` is an integer. |
| The re-ask could be a silent no-op | The API only accepts `criteria` as an object (`maxProperties: 255`). There is no ordered-array form. The eval reports how often fwd and rev give **identical** distributions. If that is 100%, the server is probably not honoring key order, and the README will say so. The reversed answer still only checks agreement, as the brief says. A stricter variant (it must also pass the threshold) is noted in the DEVLOG. |
| Eval call cap | The eval counts the planned calls (tabs × 2 orders) *before* starting and refuses if that exceeds `--max-calls` (default 100); retries also count against the cap during the run. Per-row outputs go to gitignored `eval/out/`. Aggregates (CSV + SVG) go to `eval/results/`, which is committable, and the synthetic ones are stamped SYNTHETIC. |

## 16. Changes after review #2

- **Undo restores by units.** First ungroup the tabs that were loose, then regroup (recreating deleted groups), then move units left to right (a loose tab via `tabs.move`, a whole group via `tabGroups.move`), then fix the order inside each group, restore group metadata and the active tab, and **re-query to verify** (`exact` flag; the popup says so if it isn't exact). This replaces §9's per-tab move pass, which Chrome's contiguous-group rule breaks.
- The snapshot is taken **after** classification, right before applying.
- Any run-level error aborts in-flight requests through an `AbortSignal`.
- `top` in §5 is the argmax of `probabilities` read by key. The API defines `choice` as exactly that, so the two agree. Reading probabilities keeps us independent of how a response orders its keys.
- Titles that look like URLs are sent as an empty string.
