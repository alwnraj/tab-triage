# tab-triage

A Chrome extension that sorts your open tabs into **native Chrome tab groups**, but only when a calibrated classifier is confident. Tabs it isn't sure about stay where they are, with their probability shown. **Undo** puts everything back.

<!-- demo: replaced by the real-classifier recording (demo/demo.gif, demo/poster.png) once it's made -->
> Demo video: pending the real-classifier recording (`npm run demo`).

## What it does

1. **Popup.** **Sort tabs** asks the classifier about the tabs in the current window and moves the confident ones into colored, named groups. A **threshold slider** (default 0.80) sets how confident it has to be. A results list shows every tab with the group it went to and its probability, or why it was left alone. The footer shows the **measured latency** and the **estimated cost** of the last run, worked out from the input tokens the API reports.
2. **Options page.** Here you define your groups (name, color, a plain-language description that serves as the classification criterion, and an optional domain list). You also set your API key and a domain blocklist, and there's a plain **"what gets sent"** panel.
3. **Undo** restores each tab's original position and group, including groups you had made yourself before sorting.

## Install (load unpacked)

```bash
npm ci
```

```bash
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the `dist/` folder. The first time it runs, the Options page opens a consent screen. Sorting stays off until you accept it, and you need to paste a [TypeSafe](https://docs.typesafe.ai) API key there.

## How a tab gets sorted (the funnel)

```
all tabs in this window
 └─ skip: pinned · already in a group · chrome:// / extension / file pages · localhost / IPs / intranet · your blocklist · incognito
     └─ domain table: host matches a domain you mapped → grouped locally (no API call)
         └─ ONE request: Choice over your groups + companion Noul ("does any group fit?")
             ├─ Noul < t or top probability < t ............ leave it alone
             ├─ top probability ≥ t + 0.1 .................. group it
             └─ t ≤ top probability < t + 0.1 ............. re-ask with options reversed;
                                                              group only if both answers agree
```

- **Companion Noul.** A Choice always picks *something*, even for a tab that fits none of your groups. The Noul is a separate yes/no question in the same request ("does this tab clearly belong in one of these groups?"), and the tab is grouped only when **both** pass the threshold. ([TypeSafe docs: Companion Noul](https://docs.typesafe.ai/patterns/companion-noul.md))
- **Order bias.** TypeSafe's docs say Jev can lean toward the first option listed. Near the threshold, the same question is asked again with the options reversed, and the tab is grouped only if the answer doesn't change. ([Model jaggedness §8](https://docs.typesafe.ai/model-jaggedness.md))
- **All or nothing.** Every tab is classified *before* anything moves. If the API fails (timeout after 5 s, 2 retries with backoff, 429/529 rate limiting, auth), **no tab moves** and the popup says why. A tab whose own request is rejected stays put while the others are sorted. If Chrome refuses a move halfway through, the run is rolled back.
- **Pinned model.** The model is pinned to `jev-1.14.0` instead of `jev-latest`, because thresholds are tuned per model version.

More detail in [docs/DESIGN.md](docs/DESIGN.md). The build history and the reasoning behind each decision are in [docs/DEVLOG.md](docs/DEVLOG.md).

## Privacy

| | |
| - | - |
| **Sent per tab** | the hostname only (no path, query or fragment) and the title cut to 120 characters. A title that is really a URL (untitled or loading tabs) is sent as an empty string. |
| **Sent with each request** | your group keys and descriptions. Colors and domain lists stay local. |
| **Never sent** | full URLs, page content, cookies, history; pinned tabs; incognito windows; `chrome://`, extension and file pages; localhost, IP addresses and intranet names; blocklisted domains; tabs matched by your domain rules. |
| **Stored locally** | answers cached for 7 days under a SHA-256 key of (hostname, title, groups hash, model, prompt version, order). The cached value holds only probabilities, no hostname or title. The API key lives in `chrome.storage.local`, is sent only to `api.typesafe.ai`, and is never logged. |
| **Permissions** | `tabs`, `tabGroups`, `storage`, and the host `https://api.typesafe.ai/*`. Nothing else. A strict extension CSP. |

TypeSafe is a third party. See its [legal and data-handling pages](https://docs.typesafe.ai/legal.md).

## Cost

TypeSafe charges per input token; output tokens are free. The price is one constant, `PRICE_USD_PER_INPUT_TOKEN` in [`src/core/config.ts`](src/core/config.ts), currently **$0.042 per million input tokens**, checked against [docs.typesafe.ai/models](https://docs.typesafe.ai/models.md) on 2026-11-15. The popup multiplies it by the `usage.input_tokens` the API actually reports. Cache hits cost nothing.

## Evaluation

> **Results: pending real labels.** No accuracy numbers are reported yet. `eval/synthetic.dev.json` holds hand-written examples for building the pipeline only, and anything produced from it is stamped *SYNTHETIC: NOT A REAL RESULT* and gitignored. (One early commit included a stamped synthetic mock run; the next commit removed it.) The eval detects the synthetic set from its contents, not only from a flag.

1. `npm run eval:label` writes `eval/labeled.json` from your open tabs (hostname and title only). On macOS it reads them from Chrome through AppleScript. Anywhere else, use Options → *Export open tabs for labelling* with `--from <file>`. Then fill in each `label` with a group id or `"none"`. The file is gitignored.
2. `npm run eval` makes one API pass, collecting both option orders per tab. It refuses to start if it would need more than `--max-calls` (default 100) requests. It then reports:
   - **coverage and accuracy** at thresholds 0.50–0.95 (coverage = share of tabs grouped; accuracy = share of grouped tabs that went to the right group),
   - **reliability bins** for the Choice probability and the Noul (is "0.9" right about 90% of the time?) plus ECE,
   - how often reversing the option order changed the answer,
   - tokens, estimated cost and median latency.
   Outputs go to `eval/results/labeled.{csv,svg,json}`, and the SVG is self-contained.

## Demo video

`npm run demo` records the real extension in a headed Chromium with a **fresh temporary profile** (none of your tabs, bookmarks or accounts), opening ~30 public, logged-out pages from [`demo/urls.json`](demo/urls.json), six of which are deliberately ambiguous (marked in the file). It captures the screen with ffmpeg (avfoundation on macOS, x11grab under Xvfb on Linux), so the **real tab strip** is in frame, unlike Playwright's page-only `recordVideo`. The popup is opened in a popup-type window next to the strip and clicked by Playwright rather than through the toolbar button, because synthetic toolbar clicks aren't reliable. Captions and cards are rendered as images, and the end card's latency, cost and percent-sorted figures are read from that run's own report. The published video uses the real classifier. `--mock` is for rehearsal only: every caption carries a red MOCK badge, and the committed GIF and poster can only be written by a real-classifier run.

Before recording on macOS, turn on **Do Not Disturb** and close anything that might pop up. avfoundation captures the whole screen. The edit crops to the browser window and writes `demo/out/frame-check.png`. **Look at it before committing the GIF**: with several displays, "Capture screen 0" may not be the screen Chromium opened on. The raw capture is deleted when the run ends, also when editing fails. In a real run the API key is kept out of the processes the script starts and written only into the throwaway profile. It is removed from the extension's storage as soon as the sort finishes, but that is a logical delete: the real protection is that the profile is deleted on exit (including Ctrl-C), and the next run sweeps any profile a crashed run left behind. The script also checks that screen capture works before it starts, and a real run stops if any page serves a bot check.

## API key for the scripts

`npm run probe`, `npm run eval` and `npm run demo` read `TYPESAFE_API_KEY` from the environment. The npm scripts also load a `.env` file in the repo root if there is one (Node's `--env-file-if-exists`), so you can keep the key there as `TYPESAFE_API_KEY="…"`. `.env` is gitignored. `npm run probe` is a capped check of 13 requests on public pages, to try before anything larger.

## Development

```bash
npm run typecheck   # tsc
npm test            # Vitest unit tests (fake browser that enforces Chrome's tab-group rules)
npm run test:e2e    # real Chromium smoke test: fresh profile, mock classifier, no network
npm run build       # dist/
```

```
src/core/       pure logic: privacy filter, decision rule, cache, pipeline, plan/undo
src/providers/  Classifier interface, TypeSafe provider, MockClassifier, request builder
src/browser/    the only code that touches chrome.tabs / chrome.tabGroups
src/popup, src/options, src/background.ts
eval/           labelling, threshold sweep, reliability, SVG chart
demo/           screen-capture demo pipeline
```

**A second provider.** Everything depends on the `Classifier` interface (`src/providers/classifier.ts`). A provider such as Google's Gemini Decisions API would only need to map its response onto `RawAnswer` (`choice`, `probabilities`, `noul`, `inputTokens`).

## License

MIT
