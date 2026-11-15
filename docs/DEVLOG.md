# Dev log

## 1. Reading the API, then designing

I read the TypeSafe `llms.txt` index, the OpenAPI spec and the Choice, Noul, Confidence, Companion Noul, Errors, Models and Model-jaggedness pages before writing any code. The key facts are these. One `POST /v1/systemone` call can carry a Choice and a Noul together. Probabilities come keyed by option name, the price is $0.042 per million input tokens, aliases like `jev-latest` move, and the docs openly say Jev leans toward the first option. That led to three choices: pin `jev-1.14.0`, threshold on the probability and the Noul rather than on `confidence`, and use non-numeric `g_` option keys so that JavaScript's integer-key ordering can't silently undo the order reversal. I also decided to classify everything before moving anything, so a run applies its whole plan or nothing.

## 2. Review #1 (design)

The `.claude/agents/reviewer.md` file was created mid-session, and the agent registry is only loaded at session start, so `subagent_type: reviewer` was not found. The review ran as a general-purpose agent pinned to `model: fable`, briefed to follow reviewer.md and to use only Read, Grep and Glob. (It tried one Bash listing, which was denied, so nothing ran.) It found two real blockers I had missed. First, mock answers could land in the cache and later be served as real. Second, my design saved the Undo snapshot after applying the moves, so a crash halfway through would have left no Undo. I accepted every finding; see DESIGN §15. One judgment call: the reversed-order ask still only checks agreement, as the brief specifies. Requiring the reversed answer to also clear the threshold would be stricter, but it would quietly lower coverage, and I'd rather test that with real data.

## 3. Core logic, provider, UI and review #2

I built the pure core (privacy filter, `g_` option keys, decision rule, cache, pipeline, plan and undo), the TypeSafe provider behind a `Classifier` interface, a keyword `MockClassifier`, then the service worker, popup and options page. Unit tests use a fake browser, and a real-Chromium smoke test (`npm run test:e2e`, fresh temp profile, mock mode, pages served by request interception so there's no network) checks actual `chrome.tabs.group` and Undo behaviour. Review #2 (general-purpose agent on `fable` again, same reason as before) caught a real Undo bug. Chrome keeps every group contiguous, so moving tabs back one at a time can silently pull a tab out of a group the user already had. My fake browser didn't enforce that, so the tests passed anyway. I rewrote Undo to restore by *units* (a loose tab, or a whole group via `tabGroups.move`) from left to right, then fix the order inside each group. I also made the fake enforce Chrome's invariants after every operation. The stricter fake immediately found a second bug: the order inside a group wasn't restored. Both are now covered by tests, and the review's exact scenario passes in real Chromium.

Other review #2 fixes:
- A run-level error now aborts in-flight calls instead of grinding through every tab.
- The Undo snapshot is taken right before applying, not before the slow classification.
- Rollback clears the saved Undo.
- Titles that are really URLs (untitled or loading tabs) are blanked, so a path or query never leaks.
- Cache failures can no longer fail a tab.
- A body-read timeout is retried.
- "Every call rejected" is treated as a setup error.
- The API key moved to a true `#private` field.
- `retry-after: 0` still backs off.
- Probabilities are range-checked.
- The mock's first-option lean now really changes the probabilities, so it can exercise `order-disagree`.

Not changed: 404 is still a per-tab `bad_request`, but the "all calls rejected" rule turns a retired model id into a clear run error, which covers the case the reviewer worried about.

## 4. Eval harness

`npm run eval` makes one pass over the API that collects *both* option orders for every model-routed tab, then sweeps thresholds 0.50–0.95 in code. Trying ten thresholds therefore costs the same as trying one, and the same data shows how often reversing the order changes the answer. Before it makes any call, the run computes how many requests it needs and refuses if that's over `--max-calls` (default 100). The provider also counts real HTTP attempts as a hard stop. Domain-table rows are reported separately and left out of the reliability bins, because they're p = 1 by construction and would make calibration look better than it is. Everything produced from `synthetic.dev.json` or with `--mock` gets a red "NOT A REAL RESULT" banner in the CSV, JSON and SVG. Your real labels (`eval/labeled.json`) and the per-row outputs are gitignored. Only the aggregates in `eval/results/` are meant for git.

## 5. Demo pipeline

Playwright's `recordVideo` only captures page content, so the demo records the OS screen instead (avfoundation on this Mac, x11grab under Xvfb on Linux) and crops to the browser window. That puts the real tab strip in frame. The Homebrew ffmpeg here has no `drawtext` filter, so captions, the title card and the end card are HTML pages rendered to PNG by Chromium and composited with `overlay`. That also looks better. The end card reads latency, cost and percent sorted from the run's own report in `chrome.storage.session`, never from constants. The popup runs in a popup-type window and is clicked by Playwright, because macOS has no xdotool and synthetic toolbar clicks aren't reliable. The README says so. I tested the flow headless with the mock classifier and the ffmpeg edit on a synthetic 2560×1664 clip (output: H.264, yuv420p, faststart, 30 s, 7.6 MB GIF). The real recording waits on screen-recording permission and an API key.

## 6. Review #3 (pre-push)

The first attempt at review #3 hit the Fable reviewer's weekly usage limit before it returned anything, so I first did a manual pre-push pass (below). The review itself ran on 2026-11-15; its findings are in "Review #3 findings" at the end.

Manual pre-push pass:
- Pattern-scanned all git history for key-like strings (none).
- Checked that no `.env`, labels, exports, recordings or `dist/` were ever committed.
- Confirmed the only author email is the GitHub noreply address.
- Confirmed there are no HTML sinks for untrusted text, the extension never logs the key, and there are only 4 permissions.

That pass found one real issue. In a real demo run the API key sat in the temporary profile until cleanup, and an interrupted run could leave it in `/tmp`. The key is now removed from the profile right after the sort, and signal handlers delete the profile. The Fable review should still run before the repo goes public.

Before pushing, I re-checked one assumption against the docs. The companion Noul's `instructions` is an object `{question, groups}`, and the question refers to `groups` in backticks. That matches TypeSafe's documented structured-instructions pattern exactly (its example puts `potential_duplicate` inside `instructions` and names it in the question), so I didn't change it. Whether the live model reads it as intended is still unverified until there's a key. I also changed the Options page so it no longer shows the last four characters of the saved key, since the brief says never to print it.

## 7. Demo rehearsal

The first rehearsal hung: without macOS Screen Recording permission, avfoundation opens but never delivers a frame, and ffmpeg ignores SIGTERM. `npm run demo` now probes capture for 1 s under a SIGKILL deadline and stops with instructions. Once permission was granted, the recording showed two problems. On macOS, Chrome opened the popup window at the browser's full size, covering the tab strip, so the script now sets its bounds again after creating it. Four pages served a Cloudflare "Just a moment…" check, so I replaced them and the script now names any bot-check page it sees. Captions were moved off the popup's footer. I checked frames for the three key moments (grouped, collapsed, undone) in the real tab strip.

## 8. Review #3 findings

No blockers. The reviewer said the repo is OK to make public after the history checks it couldn't run (I ran them: only the noreply email; no ignored file was ever committed except one stamped `synthetic-mock` eval result, added and removed in consecutive commits. I corrected the README instead of rewriting public history).

Acted on:
- **Synthetic data could produce an unstamped result.** `npm run eval -- --data eval/synthetic.dev.json` wrote `labeled.*` with no banner. Synthetic is now detected from the path and the file's `_WARNING` field too (`isSyntheticData`, with a test). This was the failure the brief forbids most directly.
- **"MOCK on every caption" wasn't true.** Only three of seven captions said so. Every rehearsal caption now has a red MOCK badge, and `edit()` refuses to write `demo/demo.gif`/`poster.png` unless both the flag and the report say the run was real and the classifier is TypeSafe.
- **Demo key cleanup.** The signal handler deleted the profile while Chromium was still writing it; it now closes Chromium first and retries the delete, with an `exit` fallback. `storage.local.remove()` is only a logical delete, so stale profiles from crashed runs are swept at startup, and the README now says the protection is deleting the profile. The key is removed from `process.env` so Chromium and ffmpeg never inherit it. The raw full-screen capture is deleted in `finally`, also when editing fails or on Ctrl-C.
- **Export and labelling filters.** The Options export passed `pinned: false` for every tab; it now passes the real value. The AppleScript labelling path can't see the blocklist or pinned state, so it has `--exclude` and says so, and both it and the eval print that every labelled row is sent to the API.
- **Stale docs.** DESIGN §6, §9 and §12 are updated in place (cache key includes `PROMPT_VERSION`, Undo state is in `storage.session`, eval output paths and how the call cap counts), and the README's ambiguous-tab count was wrong (six, not two).
- Smaller: a real demo run now stops on bot-check pages; the consent text says titles can contain personal text; the API fetch uses `redirect: "error"`, `credentials: "omit"`, `cache: "no-store"`; the "every call rejected" error no longer claims N retries.

Not acted on, and why:
- **Reversed answer only vetoes on the top key.** Documented as deliberate (§16). It should be revisited once real labelled data shows how often the reversed probability falls below the threshold.
- **Skipped tabs' titles in the session report.** They're memory-only, never sent, and the popup shows them to the user, who already has them open.
- **Popup opened mid-run stays disabled.** Real but cosmetic: reopening the popup fixes it. Left for later.
- **URLs or emails inside titles.** Only whole-URL titles are blanked. Scrubbing arbitrary text would make the model's input unpredictable, so I disclosed it in the consent text instead.
- **CI actions pinned by tag, not SHA.** Read-only permissions and no secrets, so the risk is low; left as is.
- **Multi-monitor capture.** Documented: the README now says to look at `frame-check.png` before committing the GIF.

## 9. Checked against TypeSafe's own skill

TypeSafe publishes an agent skill (`typesafe-ai/skills`, v0.6.2) with integration guidance. I installed it and checked tab-triage against it. Most of the design already matches: judgments from the model and the decision in code (the funnel and `decide.ts`), a companion Noul instead of a "none" option, probabilities rather than `confidence` as the gate, reordering options to check for order bias, all question wording in one module (`request.ts`), the exact payload shown to the user, and failed calls surfaced as errors rather than as "no".

Changed:
- **Option names.** The skill says option names are sent to the model and descriptive names help, while prefixes and positional names give it nothing. Keys are now plain slugs (`research`). Only an all-digit name keeps the `g_` prefix the reversal needs. `PROMPT_VERSION` went to `p2`, so old cached answers aren't reused.
- **The Noul's `false` criterion** was "matches none of the groups, or only loosely": a negation joined by an "or". The skill recommends a concrete situation and one judgment, so it now reads "The tab is about a topic that none of the group descriptions cover."

Kept, with reasons:
- **One threshold for the Choice and the Noul.** The skill suggests starting a Noul at 0.7/0.3 and giving the middle band its own outcome. Here every Noul below the threshold, including the middle band, means "leave the tab alone", which is a defined outcome, and the popup has a single slider. The eval's Noul reliability bins will show whether the Noul needs a separate threshold.
- **The API key lives in the browser.** The skill recommends keeping keys on a server. This is a bring-your-own-key extension with no server, so the key stays in `chrome.storage.local`, is sent only to `api.typesafe.ai`, and never appears in the UI or logs.
- **Titles truncated to 120 characters and only the hostname sent.** The skill warns that truncation can remove context. Here it's a privacy requirement, and a tab title rarely runs longer.

The skill also says to get permission and a budget before probing the live API, and to disclose what data is sent. No live call has been made yet.


## 10. First live API probe

`npm run probe` sent 13 requests to `jev-1.14.0`: 11 public demo pages, with two of them also asked in reversed order. The key came from a gitignored `.env`, which the npm scripts load with Node's built-in `--env-file-if-exists` flag, and nothing about it was printed. This is a smoke test with 11 cases I picked, **not an accuracy result**: the eval with real labels is still pending.

What it settled:
- **The request and response shapes are right.** The API accepted the extension's exact payload (structured Noul instructions included) and every response parsed: `{model, answers, usage}`. A bad key returns a 401 with `authentication_error`, which the provider reports as an error.
- **Cost and speed.** About 600 input tokens per request, $0.000326 for all 13 (≈ $0.000025 per tab), median latency 109 ms (89–187).
- **The companion Noul earns its place.** timeanddate.com's Choice said *research* at 0.92, but the Noul said 0.09, so the tab was left alone; weather.gov likewise (Choice *news* 0.68, Noul 0.13). Without the Noul, both would have been filed confidently into the wrong group.
- **The server honours option order, so the reversal check isn't a no-op.** Reversed distributions differed: Maillard reaction *research* 0.77 → 0.84; Hacker News *news* 0.94 → 0.89.

All six representative tabs were grouped correctly, with Choice ≥ 0.99 and Noul ≥ 0.98. The three hard ones: Hacker News → news; Maillard reaction left alone (research 0.77 < 0.8); Wirecutter left alone (shopping 0.91 but Noul 0.77). Nothing was grouped wrongly.

Noted, not acted on (one probe is too few cases to tune on, which TypeSafe's skill also warns against):
- **The Noul moves with group order too:** Hacker News 0.84 forward, 0.70 reversed. The decision rule only checks the reversed *top choice*, not the reversed Noul. If the eval shows this often, the reversed Noul should have to pass as well.
- **Wirecutter's Noul of 0.77** would pass the 0.7 starting point the skill suggests for a Noul but not the shared 0.8. Whether the Noul needs its own threshold is a question for the eval's reliability bins.

## 11. Real demo recorded

`npm run demo` with the real classifier: 30 public pages, 29 API calls (one tab went through the arXiv domain rule), 17,304 input tokens, $0.00073, 2.3 s from click to grouped. 26 tabs were grouped into five groups and 4 were left alone: GitHub Actions docs (62%), Maillard reaction (77%, so no reversed re-ask was needed), timeanddate (Noul 0.08) and weather.gov (Noul 0.12). The end card reads these numbers from the run's own report. I checked frames for every step (messy, grouped, left alone, collapsed, undone) and the frame check: only the browser window is in frame. The video is 36.1 s, H.264, yuv420p, faststart; the GIF is 1.5 MB. Only `demo/demo.gif` and `demo/poster.png` are committed. The MP4 stays in gitignored `demo/out/`.

One thing to watch: the Wirecutter tab's title came through as "nyt.net" rather than the article title (the page probably didn't finish loading or served an interstitial that the bot-check filter doesn't recognise). It was grouped as News from that. Replace that URL before re-recording.

## 12. Popup redesign and the real dropdown

The popup was restyled after a reference the user shared: large rounded tiles, the threshold as a −/value/+ stepper with preset chips instead of a slider, summary chips, tabs left alone listed first (they're the ones that may need attention; the grouped ones are visible in the tab strip), and an icon footer. The layout is a flex column capped at 600 px, which is Chrome's limit for an action popup, so the footer always shows and the list scrolls.

The demo now shows Chrome's real toolbar dropdown, opened with `chrome.action.openPopup()`, instead of a separate popup window. Playwright can't click inside an action popup, so the demo starts the sort and undo through the worker. To make that honest, the popup now updates itself live: the worker records a running sort or undo in `storage.session` (`run:<windowId>`), and the popup re-renders on session changes. That also fixes the review #3 nit that a popup opened mid-run stayed disabled. The e2e test covers it: a sort started from the worker shows up in an already-open popup.

Re-recorded with the real classifier: 26 of 30 grouped, 1.6 s, $0.00075 for 30 calls. The Wirecutter URL now 404s, so it was replaced with an RTINGS review page, and a real run now also stops on "not found"/404 titles. RTINGS was left alone because its Choice said shopping at 0.99 but the Noul only 0.76, another case for the eval's question about the Noul threshold.

## 13. A quieter popup

The user found the redesigned popup too busy. The threshold stepper, preset chips and metrics footer are gone: the popup is Sort, Undo, a settings button, two summary counts and the results. The threshold is now a slider on the Options page, beside a "Last sort" line with latency, cost, tokens and calls read from the most recent report. This departs from the original brief, which put the slider and the latency/cost footer in the popup; the user asked for it, and both still exist one click away. Mock runs still show a MOCK line in the popup. Per-tab reasons are shorter ("Not sure which group · leaned Research"). Re-recorded with the real classifier: 25 of 30 grouped, 3.5 s, $0.00073.

## 14. Hosted service: no key for users

To publish for anyone, the TypeSafe key moved to a server: a key shipped inside an extension can be extracted by anyone who installs it, and TypeSafe's own guidance is to keep keys server-side. `proxy/` is one Vercel Edge Function, built to Vercel's Build Output API by `scripts/build-proxy.mjs`, plus a landing page and a privacy policy.

Design choices:
- **Narrow on purpose.** The service accepts only `{site, title, groups, order}` and builds the TypeSafe questions with the same `buildRequest()`, so the endpoint can't be used as a free general-purpose TypeSafe API.
- **Abuse limits:** request shape and size; an origin check (web pages refused, with an optional allow-list once the Web Store id exists); per-install and per-IP rate limits; and a daily dollar cap on input tokens. The last two use Upstash Redis and fail open on a Redis outage (logged), so a limiter blip doesn't take sorting down.
- **One upstream call per request.** The extension already retries with backoff; retrying on the server too would multiply load during an incident.
- **Privacy:** no hostnames or titles in logs; rate-limit keys are salted hashes that expire in a minute; the install id is random.
- The extension's `HostedClassifier` shares its retry/timeout code with the TypeSafe client (`providers/http.ts`); the refactor kept all 21 existing provider tests passing unchanged. The API-key card is gone, and an update removes any saved key. The service URL is a build-time constant that also writes the manifest's single host permission.

Verified locally: 14 new unit tests for the service and client, and a real sort of 6 tabs in Chromium through the built service running locally with the key (5 grouped, $0.00013), with a service log of outcome, status and timing only. Not yet deployed: the Vercel connector in this session can't create projects (403), so the import and the production key are set in the Vercel dashboard (proxy/README.md).

## 15. Deployed

The service is live at `https://tab-triage-pi.vercel.app` (Vercel, imported from GitHub, so every push to `main` redeploys it). Two surprises:
- **`tab-triage.vercel.app` was already taken** by an unrelated site, and I had used it as the default service URL. Nothing was ever sent there (no extension was built or installed against it), but it was caught only because the deploy check fetched that page and found someone else's site. Lesson: verify a domain is yours before writing it into code. The default is now the confirmed deployment.
- **Every upstream call failed as "network"** on Vercel's Edge runtime, though the same bundle worked on Node: the runtime doesn't support `fetch(..., { redirect: "error" })`. Making the 502 report the error kind narrowed it down in one redeploy. The service now uses `redirect: "manual"`.

Verified live: the landing and privacy pages; refusals for web-page origins (403), raw TypeSafe requests (400), missing install ids (400) and other methods (405); one classification (research, p = 1.00, 468 tokens); and a real sort of 6 tabs in Chromium with the extension built against the live service (5 grouped, 1.6 s, $0.00013, no key in the extension). The health check reported `limits: false`: Redis isn't connected yet, so the rate limits and the daily cap are off until it is.

Redis followed: the health check first still said `limits: false`, either because the function hadn't been redeployed after connecting Upstash or because the integration used a different variable prefix. The service now finds Upstash's REST credentials under any prefix, and the health check lists Redis-related variable *names* (never values) when it can't. Because the limiter fails open, "configured" isn't proof it works, so the health check now queries Redis and reports `limitsReachable`. Live result: `{"configured": true, "limits": true, "limitsReachable": true}`, and a classification through the limited path still answers in about 0.3 s.
