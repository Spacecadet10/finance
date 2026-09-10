# Ledger — personal finance dashboard

Single-page vanilla-JS app. No framework, no bundler, no TypeScript, no git repo.
All state lives in one `S` object in `localStorage`. Nothing is sent anywhere except an
AI provider the user adds their own key for, and the optional OCR fallback.

## Commands

```
npm test          # jsdom suite against src/ — 35 suites, ~988 checks, clock pinned to 2026-09-09
npm run build     # inlines everything into dist/Ledger.html (the shareable artifact)
npm run test:dist # same suite against the built single file
npm run check     # all three, in order
```

`npm test 'themes' 'goals'` runs only suites whose names contain those strings.
`node tests/chrome-check.js dist/Ledger.html [--screenshot out.png] [--sample]` boots the
built file in real headless Chrome — use it for anything jsdom can't see (IndexedDB timing,
layout, canvas). jsdom stubs `getContext` to `null`.

**Do not report a change as done until `npm run check` passes.** Say so explicitly if you
skipped it. A passing `npm test` alone does not prove the built file works — the build has
fragile string surgery (below) that only `test:dist` catches.

## Layout

| Path | What |
|---|---|
| `finance-dashboard.html` | dev entry — markup + `<script src="src/NN-*.js">` tags |
| `src/01-core.js` … `07-app.js` | the app, ~7,200 lines, loaded in order as plain scripts |
| `ledger.css` | all styles, including the 20 theme blocks |
| `tools/build.js` | joins the parts into `dist/Ledger.html` |
| `tests/run.js` | the whole suite (one file); `tests/lib.js` boots the real page in jsdom |
| `vendor/` | pdf.js + fonts, inlined at build time |
| `dist/Ledger.html` | build output — never edit by hand |

The seven parts **share one scope** (they are plain scripts, not modules — no imports, no
exports). `tools/build.js` wraps them back into a single closure. So:

- Keep load-time code in the part that defines what it uses; a part can call forward into a
  later part at *runtime*, but not at *parse time*.
- Each part starts with `"use strict";` — the build strips them and adds one at the top.
- `src/07-app.js` ends with `window.__ledger = {...}` — the test surface. Anything a test
  needs must be exported there.

Events are delegated: one `document.addEventListener('click', ...)` in `src/07-app.js:513`
dispatches on `[data-act]`. Add a button with `data-act="thing"`, handle `case 'thing':` —
don't attach per-element listeners.

## Things that will bite you

- **`tools/build.js` does regex surgery on the HTML.** It requires: the `<script src="src/…">`
  tags to match exactly; the markup between `<body>` and the first part tag to contain no
  `</script>`; the fonts and css `<link>` tags to look as they do now. Each of those throws a
  named error if you break it. Reformatting `finance-dashboard.html` can break the build.
- **`APP_VERSION` in `src/01-core.js:11`** must stay `YYYY.MM.DD-N` — the build reads it by
  regex and a test asserts the shape. Bump the `-N` when shipping a build.
- **Cache-busting `?v=` query strings** on the css and part tags in `finance-dashboard.html`
  are manual. Bump them when a user is loading from localhost and won't see the change.
- **API keys live in `ledger-keys`, never in `ledger-v1`.** Two tests assert this. Don't put
  anything credential-shaped on `S`.
- **Multi-tab safety**: saves are revision-checked (`S.settings.rev`); a save over a newer
  revision is refused. Don't bypass `saveNow()`.
- The `QuotaExceededError` printed during `unhappy paths` is a deliberate test of the
  storage-full path, not a failure.

## Writing tests

`tests/lib.js` boots the real page: `const {L,S,ui,w,d,click,act}=await boot({today:'2026-09-09'})`.

- **A fresh boot has the Welcome sheet open** (and in `dist`, the lock offer after
  start-empty). Dismiss it before testing anything modal or focus-related.
- **Re-read `L.S` after `undo`, rollback, `load()` or restore** — those *replace* the `S`
  object, so a destructured `S` goes stale and your assertions test a dead object.
- Use `await L.saveNow()`, never the debounced `save()`.
- Form fields are `#f_<name>`; `act('thing',{v:'x'})` fires a synthetic `[data-act]` click.
- Anything a test touches must be exported on `window.__ledger` (end of `src/07-app.js`).
- Kill stray `chrome-profile` processes after headless runs.

## History

`docs/HISTORY.md` is the build log from before this repo existed (Aug 29 – Sep 10, 2026) —
why the parser is shaped the way it is, the vault/recovery design, three rounds of
adversarial review. Its early entries describe a single-file app and a `ledger.js` that no
longer exist; this file and the code are the authority on the present.

## Running it

`./Open\ Ledger\ (localhost).command` serves the folder on `http://localhost:8765` and opens
it. **That URL is the canonical book.** A `file://` copy is a separate browser origin with
separate storage — the header shows `● LOCALHOST` or `⚠ LOCAL FILE`, and moving data across
means Settings › Data › Back up / Restore.
