# 10 concepts to defend tab-triage in an interview

Each concept has what it is, where it lives in this repo, and the question you're likely to get, with a short answer.

---

## 1. Calibration

**What.** A model is *calibrated* if, of all the answers it gives with probability 0.9, about 90% are right. Accuracy tells you how often the model is right overall. Calibration tells you whether its stated confidence *means* anything. Without calibration, a threshold is just a number someone picked.

**Here.** The whole design assumes Jev's probabilities are calibrated (TypeSafe trains for that). The eval *checks* that assumption instead of trusting it: `eval/metrics.ts → reliability()` buckets predictions and compares the mean predicted probability against the observed hit rate, then summarises the gap as **ECE** (expected calibration error, the size-weighted average gap). The reliability chart shows the same thing as a picture: points on the diagonal are calibrated.

**Likely question.** *"How do you know 0.8 means 80%?"* I don't assume it. I measure it on my own labelled tabs, because calibration on a vendor benchmark doesn't carry over to a new distribution like tab titles.

## 2. Thresholds turn probabilities into actions

**What.** A probability isn't a decision. Your code decides, and the threshold encodes how bad a mistake is. Moving a tab into the wrong group is annoying but reversible, so 0.8 is a reasonable default. Riskier actions deserve higher thresholds (TypeSafe's *probability routing* pattern).

**Here.** `src/core/decide.ts`. The tab is grouped only when **both** the Choice's top probability and the Noul are ≥ t. The decision reads the *probability*, not `confidence`. Confidence is a summary of how spread out the distribution is, while the rule needs "how likely is this specific group", which is the probability.

**Likely question.** *"Why not use `confidence`?"* Confidence measures how peaked the distribution is. With two groups at 0.5 and 0.5 it's low, which is right. But it never tells you *which* group or how likely that one is. The probability does.

## 3. Coverage versus accuracy (selective prediction)

**What.** Raising the threshold makes the system answer less often (**coverage** falls) and be right more often when it does answer (**accuracy** on the answered set rises). You pick a point on that curve; you don't get both for free.

**Here.** `npm run eval` sweeps t = 0.50 … 0.95 and plots both lines (`eval/results/labeled.svg`). The product decision behind it is that an ungrouped tab costs nothing, while a wrongly grouped tab costs trust. So tab-triage sits on the high-accuracy end, and the popup shows the tabs it left alone, with their probabilities.

**Likely question.** *"Your tool only sorted 60% of tabs. Isn't that bad?"* That's the coverage it was set to give. The interesting numbers are the accuracy of the 60% it did sort, and whether a user would trade some of that accuracy for more coverage. The slider lets them make that trade.

## 4. The companion Noul (detecting "none of the above")

**What.** A Choice question always returns *some* option, and can do so with a high probability, even when none fits. A recipe tab asked to choose between "Research" and "Code" will still pick one. A **companion Noul** in the same request asks a separate yes/no question: does *any* option fit? The code trusts the Choice only when the Noul says yes.

**Here.** `src/providers/request.ts` sends both questions in one request (no extra latency, a few more tokens). TypeSafe's docs explain why this beats adding an `other` option: `other` competes for probability mass, so a half-fitting tab splits its probability and neither number is clean.

**Likely question.** *"Why not just add an 'Other' group?"* See above: a probability split between a real group and `other` is ambiguous. A separate binary question with explicit true and false criteria gives two numbers that each mean one thing.

## 5. Option-order bias and the reversal check

**What.** Some models lean toward whichever option is listed first. TypeSafe's docs say Jev can do this. That's a *systematic* error: re-asking the same way won't reveal it.

**Here.** In the band just above the threshold (t ≤ p < t + 0.1), `src/core/pipeline.ts` re-asks with both the Choice options *and* the Noul's group list reversed, and groups the tab only if the top pick doesn't change. Two details matter:
- the reversed answer can only *veto*; it never rescues a tab that already failed, and
- a group whose name is all digits gets its key prefixed (`g_2024`), because JavaScript sorts integer-like object keys first, which would silently undo the reversal. Other keys stay plain words, because option names are sent to the model and descriptive names help it.

**Likely question.** *"How do you know the reversal does anything?"* The eval records how often the forward and reversed distributions are **identical**. If that's 100%, the server isn't honouring key order, and the check is a no-op I'd have to redesign (for example, by shuffling the option names themselves).

## 6. Funnel design: cheap, deterministic steps first

**What.** Put the cheapest, most certain decisions first and only send what's left to the expensive, uncertain step. Each stage removes work from the next.

**Here.** Skip filters (pinned, internal pages, blocklist, local hosts), then the **domain table** (exact rule, p = 1, free, private), then the **cache** (free), then **one API request**, then the reversal only near the threshold. In the eval, domain-table rows are reported separately and **left out of the calibration bins**, because rows with p = 1 by construction would make calibration look better than it is.

**Likely question.** *"Why call a model for github.com at all?"* You shouldn't, which is exactly why the user can map domains. The model is for the long tail that rules can't cover.

## 7. Atomicity: classify everything, then apply (plus Undo)

**What.** A user-facing batch operation should either happen fully or not at all, and always be reversible.

**Here.** `src/core/sort.ts`:
1. Classify every tab first; any run-level failure (timeout, 429/529, auth) means **no tab moves**.
2. Re-check that each tab still has the same hostname and title, in case it navigated meanwhile.
3. Snapshot the strip *right before* moving and save it **before** the first move.
4. If Chrome refuses a move partway through, roll back.

Undo has to respect a Chrome invariant: **groups are always contiguous**. Moving one member away silently ungroups it. So Undo restores whole *units* (a loose tab or a whole group) from left to right, fixes the order inside each group, then re-queries to verify. The test fake enforces that invariant after every operation, which is how two real Undo bugs were caught.

**Likely question.** *"What happens if the API dies halfway through 40 tabs?"* In-flight calls are aborted, nothing moves, and the popup says so. Answers that already came back are cached, so a retry is nearly free.

## 8. Reliability engineering for an external API

**What.** Every network call can be slow, fail, or be rate-limited. Bound the latency, retry only what's retryable, and back off.

**Here.** `src/providers/typesafe.ts`:
- 5 s timeout per attempt, 2 retries with exponential backoff and jitter;
- 429, 529 and 5xx are retried, honouring `retry-after` (capped);
- 400/401/403/422 are *not* retried, because repeating a bad request just fails again;
- concurrency is capped at 4;
- errors carry a kind and status only, and the key sits in a `#private` field so logging the object can't leak it;
- per-tab errors (one weird title) leave that tab alone, while systemic errors stop the run.

**Likely question.** *"Why not retry 400?"* It's deterministic. The same body gets the same rejection, so a retry only burns quota and time.

## 9. Privacy by construction (data minimisation)

**What.** Send the minimum the decision needs, decide it in code that's easy to test, and show users exactly what leaves their machine.

**Here.**
- `toTabInput()` reduces a tab to `{hostname, title ≤ 120 chars}` before anything else sees it, and blanks titles that are really URLs (Chrome shows the URL as the title while a page loads).
- Local, intranet, incognito, pinned and blocklisted tabs never get that far.
- The cache stores only hashed keys and probabilities.
- The "what gets sent" panel is rendered by the **same `buildRequest()`** the provider uses, so it can't drift from what's actually sent.
- Permissions are just `tabs`, `tabGroups`, `storage` and one API host.

**Likely question.** *"Isn't sending tab titles a privacy problem?"* It's a real cost, which is why it's minimised, opt-in (consent screen), avoidable per domain (blocklist and domain table), and documented. The next step would be an on-device model for the long tail.

## 10. Honest measurement

**What.** Numbers you can't reproduce, or that come from data you invented, undermine everything else you say.

**Here.**
- The synthetic eval set is labelled as such, its outputs get a red "NOT A REAL RESULT" banner, and they're gitignored.
- The README says "pending real labels" until real labels exist.
- The eval asks *before* spending more than 100 calls.
- Cost comes from the API's own `usage.input_tokens` × a price checked on the vendor's page.
- The demo end card reads latency, cost and percent sorted from that run's report, never from constants. Mock mode is stamped on every caption, and the committed GIF and poster are only written by a real-classifier run.

**Likely question.** *"How accurate is it?"* Give the number from `eval/results/labeled.*`, say how many tabs it rests on, and say what the reliability chart showed. If you haven't labelled any data yet, say exactly that.
