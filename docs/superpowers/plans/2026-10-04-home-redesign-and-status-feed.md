# Home redesign, status feed and audit design items: implementation plan

> **For agentic workers:** carry this out task by task with
> superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-10-04-home-redesign-and-status-feed-design.md`. Read it
first.

**Process (Jordan, 2026-10-04):**
- Coders and webdevs run on Opus.
- No bug-hunter.
- Tests plus CI are the gate, and CI must be green after every push.
- One full live check runs at the end (Task 3), using the devkit.
- Parallel agents in one clone follow the CLAUDE.md rules: explicit file ownership; app.css built
  in a temporary worktree from the committed tree.

**Global Constraints:** the same as the Books plans:
- whitelisted commands only, never chained;
- dev only, never production, no merges or tags;
- the repo identity, with no trailer and no instance names;
- 4xx/503 responses only;
- no module caches;
- every query scoped by identity;
- ES2017, textContent only, theme vars only;
- CLS 0 and no overflow at 320/375/430 px;
- secrets never printed;
- no rm/mv/chmod on remote hosts except the agent's own /tmp files.

**Deferred from the mechanical audit fixes:** H2, M10, L3 and L6, plus the Home and shell parts of
the fixed findings, all listed in `.superpowers/sdd/audit-mechanical-report.md`. Task 2 picks
these up.

## Review Focus

1. A monitor that flaps (down/up/down within 2 polls) opens no incident. An outage is posted and
   pushed exactly once across 2 workers. *(Task 1)*
2. With Uptime Kuma unreachable, nothing ever claims "All services running". *(Tasks 1-2)*
3. The public status summary reveals only the one-line current state. *(Task 1)*
4. Home at 320 px, for admin and member, with every section present (outage, Continue, streams):
   no overflow and CLS 0. *(Task 2)*
5. The login page keeps its auth-ready reveal and visibility behaviour exactly. *(Task 3)*

---

### Task 1: Status feed server

**Files:**
- `app/models.py` (`StatusUpdate` fields) and a migration in `app/seed.py`
- the Uptime Kuma transition detection, in the existing poller
- `app/routers/status.py`: admin notes CRUD, and the public feed for signed-in users
- `app/routers/integrations.py`: status-summary names the down service
- the push for status
- the `status` notification category, added to `NOTIFICATION_CATEGORIES` and notifications.js in
  the same commit
- the `/status` page route in `app/pages.py` (registry entry only)
- tests

**Produces:**
- `GET /api/status/feed?days=30` returns `{open: [...], items: [...]}`.
- `POST /api/status/notes`, `PUT /api/status/notes/{id}`, `DELETE /api/status/notes/{id}`, and
  `POST /api/status/notes/{id}/resolve`, all admin only and same-origin.
- `GET /api/integrations/status-summary` adds `down_service` (one name, or null).

**Steps:**
- [ ] Write failing tests, including Review Focus 1-3, the 10-minute push threshold, preference
      gating, and migrations under 2 workers.
- [ ] Implement.
- [ ] Run the full suite until green, and confirm CI is green.
- [ ] Commit: `feat(status): a live status feed from Uptime Kuma and admin notes, with push for
      big ones`.

### Task 2: Home and the /status page

**Files:**
- `app/static/js/pages/home.js` and `index.html`
- a new `/status` page module
- CSS, tests, and the deferred Home items

**Consumes:** Task 1, and the shell from the phone-navigation build.

**Steps:**
- [ ] Write failing runtime tests for every section and state in spec section 2, plus Review
      Focus 4.
- [ ] Implement.
- [ ] Run both suites until green, and confirm CI is green.
- [ ] Commit: `feat(home): status first, then requests and news, in the Books style`.

### Task 3: Audit design items and the live check

**Files:**
- Requests (restyle and regroup)
- Issues, Tickets, Wiki and News card language
- the login card and its one-line status
- the theme-derived secondary palette, in theme.css and settings_registry
- the font preload
- tests

**Steps:**
- [ ] Write failing runtime tests, including Review Focus 5 and the shell contract.
- [ ] Implement.
- [ ] Run both suites until green, and confirm CI is green.
- [ ] Run the full live check from spec section 6, with screenshots of every restyled page.
      Restore everything afterwards.
- [ ] Commit: `feat(ui): Requests and the older pages in the Books style, a calmer login, theme
      palette and font`.
