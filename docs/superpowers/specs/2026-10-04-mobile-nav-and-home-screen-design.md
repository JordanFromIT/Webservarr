# Phone navigation and home-screen app: design

Status: approved in conversation 2026-10-04 (written by the Worker3 session). On 2026-10-04 Jordan
told the build session to incorporate it into v2 roadmap step 5, which counts as approval to build.
Two details he did not discuss explicitly are built as written: Sign out moves into More, and the
320px fix is folded in.

## Why

At a family event (2026-10-03) several users said the site is hard to use, and the group chat
showed it. Users are family and friends, mostly on phones, not technical.

- They did not know the hamburger icon was a menu ("what is hamburger?").
- They lost the home-screen shortcut Jordan had set up and asked for "a way to keep the tab
  open so I can get to it easier".
- Sign-in through authentik dead-ended in a popup tab. **Already fixed** on 2026-10-04 with
  the authentik Plex-redirect overlay (`JordanFromIT/authentik-plex-redirect`), so sign-in is
  out of scope here.

**Success:** a non-technical user on a phone can sign in, find Requests and Issues, and get
back to the site later, all without contacting Jordan.

## Constraints

- **The repo is a generic template.** No hmserver branding, page choices or labels in code.
  Anything Jordan wants different goes in Settings. New defaults go in both `DEFAULTS` in
  `app/routers/branding.py` and `DEFAULT_SETTINGS` in `app/seed.py`.
- **Desktop does not change.** The sidebar stays at `lg` (1024px) and wider.
- **It builds on the soft-navigation shell** (sub-project 1): the tab bar and the More sheet are
  part of the shell, so they persist across page changes and the active tab follows the router.
- **The fixed player bar** (sub-project 2) must never overlap the tab bar.

## Part 1: phone navigation

Applies below `lg` (under 1024px). It replaces the hamburger button, the drawer
(`#drawerOverlay` / `#drawerPanel`) and the mobile user menu.

1. **Bottom tab bar**, fixed to the bottom of the viewport.
   - 5 tabs, each an icon with its label always visible underneath.
   - Tap targets are at least 48px.
   - The bar pads for the iPhone home indicator with `env(safe-area-inset-bottom)`.
   - Active tab: filled icon, theme primary colour and a visible indicator. It never relies on
     colour alone.
   - The Requests tab keeps the existing pending-requests badge (`requestsBadge`).
2. **Which pages become tabs:** the first 4 entries of `visible_nav_items()` for that user, in
   the operator's configured order. The 5th tab is always **More**.
   - If a user can see 4 pages or fewer, they all become tabs and there is no More tab.
   - Labels, icons, on/off switches and order all come from the existing settings. No new
     setting is needed.
3. **More sheet:** a bottom sheet that opens from the More tab.
   - Rows: every remaining nav item. Each row shows its icon, label and existing sublabel (e.g.
     "Report a problem with media"). Then "Add to home screen" (Part 2), then Account settings
     (admin only, as today), then Sign out.
   - Rows are at least 56px tall.
   - Closes on: a tap outside it, a downward swipe, Back, Escape, or picking a row. Focus moves
     into the sheet when it opens and returns to the More tab when it closes.
   - When the current page is one of the More pages, the More tab shows as active.
4. **Top bar (phones):** the current page's label on the left and the notification bell on the
   right. There is no menu button and no user menu, since account and sign-out moved into More.
   The bell and its dropdown behave as they do today.
5. **Layout:**
   - Page content gets bottom padding equal to the tab bar height plus the safe area, so the
     last item is never hidden.
   - The player bar sits directly above the tab bar.
   - Fix the known overflow: the Home gauges row is 369px wide at 320px for admins (V2-ROADMAP
     item 5). Nothing may scroll sideways at 320px.

## Part 2: home-screen app

1. **Web app manifest**, served by the app at `/manifest.webmanifest` and linked from every
   page and from `/login`.
   - Built from branding settings:
     - `name` and `short_name` come from `branding.app_name`.
     - `theme_color` and `background_color` come from the theme colours.
     - `start_url` is `/` and `display` is `standalone`.
   - Icons: a new setting, **`branding.app_icon_url`** ("Home-screen icon", a square PNG,
     ideally 512x512). The default is a bundled generic WebServarr PNG at 192px and 512px.
   - Also add `apple-touch-icon` and the `theme-color` meta, using the same icon.
   - The existing service worker (`app/static/sw.js`, push only) is enough for Android to treat
     the site as installable. It needs no fetch handler or offline page.
2. **"Add to home screen" card on Home** (removed 2026-10-06: on a phone it and the push card took
   most of the first screen. Install lives in the More row only, item 3; Home's push offer became
   a one-row banner at the top, and on phones News now comes first, then the event log, then
   Recent Requests):
   - **When it shows:** below `lg`, signed in, and not already running as an installed app.
     "Installed" means `display-mode: standalone`, or `navigator.standalone` on iOS.
   - **Android/Chromium:** capture `beforeinstallprompt`. The card's button calls `prompt()`,
     and the card hides once the app is installed. If the event never fires (an unsupported
     browser), show no card.
   - **iOS and iPadOS Safari:** two pictured steps, "Tap Share" (with the share icon) and "Tap
     Add to Home Screen". There is no button, because Apple has no API for it.
   - **"Not now":** hides the card on that device. This is stored in `localStorage` inside
     try/catch. If storage is blocked, the card simply shows again next time.
   - Its position among the Home sections is fixed (it is not a `HOME_SECTION_IDS` section). The
     copy follows the usual rules: generic, and it uses `branding.app_name`.
3. **"Add to home screen" row in More:** always shown while not installed. It runs the same
   install step: the native prompt on Android, the two steps on iOS.
4. **Side effect:** iOS only allows web push from a home-screen app (16.4 and later). The
   existing push subscription flow should work from the installed app without changes. Verify
   this, don't assume it.
5. **Known behaviour:** an iOS home-screen app keeps its own cookies, separate from Safari, so
   the first launch shows the sign-in page once. This is expected, needs no fix, and gets no
   explanatory copy.

## Out of scope

- Sign-in changes (done via the authentik overlay).
- An offline mode or page caching in the service worker.
- Any desktop layout change.
- Redesigning page content beyond the 320px overflow fix.

## Acceptance

Automated (webdev, real browser):
- At 320, 375 and 430px wide, on every shell page:
  - nothing scrolls sideways;
  - the tab bar and player bar never overlap content or each other;
  - every page is reachable in 2 taps or fewer.
- Keyboard and screen reader pass on the tab bar and More sheet: focus order, focus trap in the
  sheet, Escape, and `aria-current` on the active tab.
- The tab set follows Settings order and switches. Admin and non-admin get their own sets.
- At 1024px and wider, desktop is unchanged (screenshot comparison).
- `/manifest.webmanifest` is valid, reflects branding, and Chromium reports the site
  installable (Lighthouse PWA installability).
- The shell contract tests (`app/tests/test_shell_contract.py`) are extended for the new markup.

Real devices (Jordan):
- Android Chrome: the install prompt works; the installed app opens full-screen to Home; Plex
  sign-in works inside the installed app.
- iPhone Safari: the two-step card shows; the installed app opens full-screen; Plex sign-in
  works inside it; a push notification arrives.

## Build process

Per the v2 rules in force since Jordan's 2026-10-04 override:
- `webdev` builds, on Opus.
- No `bug-hunter`. The tests and the acceptance checks below are the gate.
- `auditor` runs once before release with the rest of v2.

**Roadmap position is Jordan's call.** It is independent of Books (sub-project 3), so it can
slot in after 3a or run between slices.
