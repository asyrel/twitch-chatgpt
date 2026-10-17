# Miwaku – team review

Miwaku was reviewed the way a full mobile app team would. Each role below lists what that person owns,
what they found, what was fixed in this round, and what's left (the backlog).
Roles follow common industry practice for mobile teams, plus three specialist roles an 18+ content app needs.

Legend: ✅ done this round · 🔜 backlog (prioritised at the end)

---

## 1. Product manager
**Owns:** the vision, who the app is for, what gets built next and why, the backlog and release priorities.

- **Product:** Miwaku is a reference and inspiration app for NSFW artists: discover (For You), browse (luscious, 4 art boards), study (viewer tools, refs, gesture practice) and collect (boards, likes, artists).
- **Biggest risk:** nothing has been verified against the real sites yet. Every feature was tested only against fakes.
- ✅ Wrote this review and a prioritised backlog.
- ✅ Added a Connection check so real-world problems show up as one copyable report.
- 🔜 First real-device session: install, run the Connection check, fix whatever fails (P0).

## 2. UX designer
**Owns:** user flows, information architecture, onboarding, empty and error states, usability testing.

- **Finding:** new users landed in an unexplained feed. Key choices (what to hide, where to save) were buried in Settings.
- ✅ First-run setup: 18+ confirmation → what you see → where to save → a 4-point tour.
- ✅ Help & tips page (Settings → ❓).
- ✅ Earlier rounds: bottom tab bar, For You as home, search only while browsing, back button on album pages.
- 🔜 Long-press menus on thumbnails (save to board, similar, hide) instead of opening the viewer first.
- 🔜 Pull-to-refresh on lists and the feed.

## 3. UI / visual designer
**Owns:** the look: icon, colours, type, spacing, components, consistency.

- ✅ App icon: gold pen nib on charcoal (adaptive and themed-icon versions, launch screen).
- ✅ Gold accent throughout, with dark text on gold for contrast.
- 🔜 One shared set of spacing and size values (tokens) instead of per-screen values; a light theme (optional).

## 4. Mobile (front-end) developer
**Owns:** the app's screens and logic (here: the web layer in `www/`), state, performance.

- **Fixed in earlier rounds:** a list still loading drew over a newly opened screen; parallel queries gave up after another request learned about a rejected field; the empty-list flash before sort options loaded.
- **Code layout:** one module per feature (feed, art, refs, boards, artists, gesture, similar, diag, onboarding).
- 🔜 Move to a small build step (bundling, minification) only if startup time becomes an issue on the A25.

## 5. Android (native) developer
**Owns:** the native layer: storage, permissions, background work, hardware keys, system UI, the build.

- **Finding:** Android's automatic Google backup was on. Your likes, taste, notes and login cookie could be copied to Google Drive.
- ✅ Turned off (`allowBackup=false`).
- **Reviewed and OK:** a foreground service (data sync type) keeps downloads alive; storage via app folders or a picked folder, hidden from Gallery with `.nomedia`; volume keys, full-screen reading and keep-awake; edge-to-edge insets.
- 🔜 Move signing to a GitHub secret instead of the committed sideload key (only matters if the app is ever shared publicly).

## 6. Backend / integration developer
**Owns:** talking to external services: APIs, auth, retries, rate limits, data mapping.

- **Finding:** network requests had no time limit, so a site that stopped responding could spin forever. Art sites' "too many requests" replies weren't handled.
- ✅ Timeouts on every request (15s to connect, 30–60s to read).
- ✅ Automatic wait-and-retry on HTTP 429 or 503.
- **Already in place:** luscious host fallback and memory, schema-based detection (sorts, login, picture search), dropping unknown fields and retrying, and fallback to 1680px previews when originals are refused.
- 🔜 Per-site request pacing in the For You feed if Danbooru starts rate-limiting real use.

## 7. QA engineer
**Owns:** test plans, automated tests, regression safety, bug reports.

- **Finding:** all testing so far was one-off scripts, so nothing stopped future changes from breaking working features.
- ✅ Automated end-to-end test suite (`android-app/tests/`, run with `npm test`): fake luscious and art-site servers seeded with content that must never appear. The 12 tests cover onboarding and the 18+ gate, content filters including the minor block, the art sites and the Danbooru tag limit, For You learning and likes, the viewer's study tools, boards, Refs, More like this, sign-in, the Connection check and sort detection.
- 🔜 Add tests for downloads, gesture practice and artist tracking.
- 🔜 A short manual test checklist for each release on the Galaxy A25.

## 8. DevOps / release engineer
**Owns:** builds, automation, release pipeline, versioning.

- ✅ Tests now run on GitHub before every build; a failing test blocks the release.
- ✅ Release notes list the latest changes automatically.
- **Already in place:** every push builds a signed APK that updates in place, published at a fixed link (`miwaku-latest/Miwaku.apk`); version number = build number.
- 🔜 In-app "new version available" notice (declined for now).

## 9. Security & privacy
**Owns:** data protection, attack surface, secrets, privacy defaults.

- ✅ Audit: all text from websites is escaped or set as plain text before it's shown, so a malicious title or tag can't inject code.
- ✅ Google backup disabled (see Android).
- **By design:** your password goes only to luscious.net and is never stored; taste, boards and notes stay on the phone; downloads are hidden from Gallery; WebView debugging is off in release builds.
- **Note:** the optional Danbooru/Gelbooru API keys are stored in the app's private storage.
- 🔜 Optional app lock (declined for now).

## 10. Trust & safety / content policy
**Owns:** what content may appear, age gating, safety filters.

- ✅ 18+ confirmation on first launch; under-18 users are stopped.
- **In place and now covered by automated tests:** content involving minors is always blocked on every site. It's excluded in queries where the site allows, filtered from all results, and can't be turned off. Real-life photos are never shown. Gay, futa and furry are hidden by default and user-adjustable; extra tags can be hidden.
- 🔜 Periodically review the blocked-tag list against the tags the sites actually use.

## 11. Accessibility
**Owns:** usable by everyone: contrast, touch targets, screen readers, motion.

- ✅ Respects Android's "remove animations" setting (no heart pop or animated transitions).
- ✅ Visible focus outline for keyboards and switch access.
- **Reviewed:** gold-on-charcoal and dark-on-gold contrast are high; touch targets are 40–56px; icon buttons have labels.
- 🔜 A larger-text option in Settings.

## 12. Technical writer / support
**Owns:** help content, release notes, troubleshooting.

- ✅ In-app Help & tips; automatic release notes; README updated.
- ✅ Troubleshooting path: Connection check → Copy report → send it.

---

## Prioritised backlog
| Priority | Item | Owner |
|---|---|---|
| P0 | Install on the A25, run Connection check, fix failures | PM, Backend, QA |
| P1 | Tests for downloads, gesture practice, artist tracking | QA |
| P1 | Per-site request pacing for the feed (if rate-limited) | Backend |
| P2 | Long-press thumbnail menus, pull-to-refresh | UX, Front-end |
| P2 | Manual release checklist for the A25 | QA |
| P3 | Larger-text option | Accessibility |
| P3 | Shared design tokens / optional light theme | UI |
