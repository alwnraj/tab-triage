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

The Fable reviewer hit its weekly usage limit (resets 2026-11-16, 8am ET) before it returned anything, so review #3 has **not** run yet. In the meantime I did a manual pre-push pass:
- Pattern-scanned all git history for key-like strings (none).
- Checked that no `.env`, labels, exports, recordings or `dist/` were ever committed.
- Confirmed the only author email is the GitHub noreply address.
- Confirmed there are no HTML sinks for untrusted text, the extension never logs the key, and there are only 4 permissions.

That pass found one real issue. In a real demo run the API key sat in the temporary profile until cleanup, and an interrupted run could leave it in `/tmp`. The key is now removed from the profile right after the sort, and signal handlers delete the profile. The Fable review should still run before the repo goes public.
