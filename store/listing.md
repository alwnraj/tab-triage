# Chrome Web Store listing: tab-triage 1.0.0

Everything to paste into the [developer dashboard](https://chrome.google.com/webstore/devconsole), in the order the dashboard asks for it. The package is `release/tab-triage-1.0.0.zip` (`npm run package`). The images are in this folder (`npx tsx store/make-assets.ts` regenerates them from the latest real-classifier demo).

## Package tab

Upload `release/tab-triage-1.0.0.zip`.

## Store listing tab

**Name** (from the manifest): tab-triage

**Summary** (from the manifest, 112 characters):
> Sorts open tabs into your tab groups, only when a calibrated classifier is confident. Undo puts everything back.

**Description:**

> Too many tabs? tab-triage sorts the tabs in your current window into real Chrome tab groups (Research, Code, News, Cooking, Shopping, or groups you define), but only the ones it's confident about.
>
> HOW IT WORKS
> • Click the toolbar icon and press Sort tabs.
> • Each tab is classified by a calibrated model, which returns a real probability, not a guess dressed up as certainty.
> • A tab is grouped only when the model is at least 80% sure which group it belongs in AND that the group really fits (you can change the threshold).
> • Tabs it isn't sure about stay exactly where they are, and the popup tells you why ("Not sure which group · leaned Research").
> • Undo puts every tab back: order, groups, even the groups you made yourself.
>
> YOUR GROUPS
> Describe each group in plain words on the Options page. Optional domain rules (for example arxiv.org → Research) are matched on your device and never sent anywhere.
>
> PRIVACY
> • Nothing leaves your browser until you accept a one-screen consent and press Sort.
> • For each tab, only the hostname (e.g. en.wikipedia.org, never the full address) and the title, cut to 120 characters, are sent, with your group descriptions.
> • Pinned tabs, incognito windows, browser and local pages, and sites on your blocklist are never sent.
> • The tab-triage service passes the request to TypeSafe for classification and stores and logs none of it. No accounts, no ads, no analytics.
> • The Options page shows the exact request that's sent.
>
> No account and no API key needed. Open source: github.com/alwnraj/tab-triage

**Category:** Workflow & Planning (Productivity). **Language:** English.

**Graphic assets:**
- Store icon (128×128): `dist/icons/icon128.png` (after `npm run package`)
- Screenshots (1280×800), in this order: `screenshot-1.png` to `screenshot-5.png`
- Small promo tile (440×280): `promo-small.png`
- Marquee (1400×560): optional, skip

**Additional fields:**
- Official URL / homepage: `https://tab-triage-pi.vercel.app`
- Support URL: `https://github.com/alwnraj/tab-triage/issues`
- Mature content: No

## Privacy practices tab

**Single purpose:**
> Sort the open tabs in the current window into Chrome tab groups, grouping only tabs a classifier is confident about, and undo that sorting on request.

**Permission justifications:**

| Permission | Justification |
| - | - |
| `tabs` | Reads the title and URL of the tabs in the current window when the user presses Sort, so each tab can be classified (only the hostname and the first 120 characters of the title leave the device), and moves tabs into position. Also used to restore tab order on Undo. |
| `tabGroups` | Creates, names, colours and optionally collapses the tab groups the tabs are sorted into, and restores the user's original groups on Undo. |
| `storage` | Saves the user's settings, group definitions, blocklist and consent, an anonymous install id, a 7-day cache of classification answers (probabilities only, under a hashed key), and the Undo snapshot (session storage). |
| Host permission `https://tab-triage-pi.vercel.app/*` | The extension's own classification service. When the user presses Sort, it receives each eligible tab's hostname, its title (cut to 120 characters) and the user's group descriptions, and returns probabilities. It is the only host the extension can contact. |

**Remote code:** No, I am not using remote code. (All JavaScript is in the package. The service returns JSON data only.)

**Data usage:** tick these:
- **Web history**: the hostname and title of open tabs, sent only when the user presses Sort, to classify them.

  Leave everything else unticked. The anonymous install id isn't personally identifiable, and no personal information, authentication, location, communications, financial, health or user-activity data is collected.

**Certifications:** tick all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

(Passing the hostname and title to TypeSafe is part of the single purpose, classifying the tab, which is an approved use case. The privacy policy says so.)

**Privacy policy URL:** `https://tab-triage-pi.vercel.app/privacy`

## Distribution tab

- Visibility: **Unlisted** for a soft launch (anyone with the link can install it; it doesn't appear in search), then **Public** once you're happy. Or Public straight away.
- Regions: all. Price: free.

## Test instructions (for the reviewer)

> No account or login is needed.
> 1. Open several tabs on different public sites (e.g. a Wikipedia article, a GitHub repository, a recipe page, a news site).
> 2. On first install the Options page opens: press "I understand, enable sorting".
> 3. Click the tab-triage toolbar icon and press "Sort tabs". Confident tabs move into colored tab groups; others are listed under "Left alone" with the reason.
> 4. Press "Undo" to put every tab back.
> The threshold and group descriptions can be changed on the Options page.

## After it's approved

1. Copy the extension's id from the dashboard and set `ALLOWED_ORIGINS=chrome-extension://<id>` in the Vercel project's environment variables, then redeploy. The service will then refuse requests from any other origin.
2. Check `https://tab-triage-pi.vercel.app/api/classify` still shows `"limits": true, "limitsReachable": true`.
3. Add the store link to the README and to `site/index.html`.

For each update: bump the version in `package.json` and `src/manifest.json`, run `npm run package`, and upload the new zip.
