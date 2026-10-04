/**
 * Settings > Books: how the Books catalog is doing, and the pairings an admin
 * decides by hand. Everything here is an action with its own button (Rebuild
 * now, Pair these two, Keep apart, Remove); nothing goes through the save bar.
 * The Kavita API key and the Chaptarr webhook are settings, so they sit on
 * their own cards under Integrations.
 *
 * The catalog joins every Kavita ebook and Plex audiobook into one list. It
 * pairs them by title and author, and the admin has the last word: an
 * override pairs an ebook with one audiobook edition, or keeps the two apart,
 * and survives every rebuild. A change shows at the next rebuild, so this tab
 * says when one is waiting.
 *
 * The tab waits (briefly) for its four lists. Each box keeps one height
 * whatever it holds, so nothing moves when it fills in or after a pairing.
 */
(function () {
  'use strict';

  var el = WSSettings.el, icon = WSSettings.icon, cls = WSSettings.cls;
  var BASE = '/api/admin/books';
  var LOAD_WAIT = 3000;
  var POLL_MS = 15000;
  // The matched list shows this many at once and says so; typing narrows it.
  var MATCHED_CAP = 40;

  var MSG = {
    notBuilt: 'Not built yet.',
    building: 'Building the catalog now…',
    loadFailed: 'This couldn’t load. Try again in a moment.',
    noAccess: 'Only admins can change how books are matched.',
    rebuildFailed: 'The rebuild didn’t run. Try again.',
    rebuildBusy: 'A rebuild is already running. Give it a moment.',
    offline: 'That didn’t go through. Check your connection and try again.',
    waiting: 'Your changes show after the next rebuild.',
    pickBoth: 'Pick an ebook and an audiobook that are the same book.',
    allMatched: 'Every ebook and audiobook has its match.',
    noEbooks: 'No ebooks without an audiobook.',
    noAudio: 'No audiobooks without an ebook.',
    noMatched: 'No books have both an ebook and an audiobook yet.',
    nothingFound: 'Nothing matches that.',
    noChoices: 'Nothing set by hand yet.'
  };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function num(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0; }

  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return plural(m, 'minute', 'minutes') + ' ago';
    var h = Math.round(s / 3600);
    if (h < 24) return plural(h, 'hour', 'hours') + ' ago';
    return plural(Math.round(s / 86400), 'day', 'days') + ' ago';
  }

  function sentence(text) {
    text = String(text).trim();
    return /[.!?…]$/.test(text) ? text : text + '.';
  }

  function setText(node, text) {
    if (node.textContent !== text || node.firstElementChild) node.textContent = text;
  }

  function str(v) { return typeof v === 'string' ? v : ''; }

  // The body as JSON, or {} for an empty body or an error page.
  function readJson(r) {
    return r.text().then(function (text) {
      var d = null;
      try { d = text ? JSON.parse(text) : null; } catch (e) { d = null; }
      return { status: r.status, ok: r.ok, d: d && typeof d === 'object' ? d : {} };
    }, function () { return { status: r.status, ok: r.ok, d: {} }; });
  }

  // "Title, Author" lines: whatever of these a book has, joined with a comma.
  function byline() {
    return Array.prototype.slice.call(arguments).filter(function (x) { return !!x; }).join(', ');
  }

  function narration(narrator) { return narrator ? 'Read by ' + narrator : ''; }

  // The same box for every list: one fixed height, scrolling inside.
  var BOX = 'h-72 overflow-y-auto rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] p-2';
  var ROW = 'flex items-start gap-3 w-full text-left rounded-[10px] px-3 py-2.5 min-h-12 transition-colors';
  var ROW_OFF = 'hover:bg-frosted-blue/[0.06]';
  var ROW_ON = 'bg-frosted-blue/[0.12]';

  WSSettings.registerTab('books', {
    // ctx: the page's (the kit passes it on each visit). Every listener,
    // request, timer and the clock below end with its signal.
    mount: function (panel, api, ctx) {
      var signal = ctx.signal;
      var data = { status: null, unpaired: null, paired: null, overrides: null };
      var failed = { status: false, lists: false };
      var pick = { ebook: null, audio: null };
      var filter = '';
      var changed = false;                 // a change was made here since the last rebuild
      var rebuilding = false;
      var lastRebuildAt = null;
      var seq = 0;

      // ---- The catalog ----

      var catalog = WSSettings.card('Catalog', 'Your books from Kavita and Plex, put together into one library. It updates every 15 minutes and after each Chaptarr import.');
      var statusBox = el('div', 'space-y-2');
      var lineWhen = el('p', 'min-h-6 flex items-start gap-2 text-[15px] leading-6 text-frosted-blue');
      var light = el('span', 'ws-light ws-light-checking mt-[7px]');
      light.setAttribute('aria-hidden', 'true');
      var whenText = el('span', 'min-w-0');
      whenText.appendChild(el('span', 'skel skel-line inline-block align-middle w-56'));
      lineWhen.appendChild(light);
      lineWhen.appendChild(whenText);
      var lineCounts = el('p', 'min-h-5 text-[13px] leading-5 text-frosted-blue/70');
      lineCounts.appendChild(el('span', 'skel skel-line inline-block align-middle w-64 max-w-full'));
      var notes = el('div', 'min-h-5 space-y-1 text-[13px] leading-5 text-frosted-blue');
      notes.setAttribute('role', 'status');
      statusBox.appendChild(lineWhen);
      statusBox.appendChild(lineCounts);
      statusBox.appendChild(notes);
      catalog.body.appendChild(statusBox);

      var rebuildRow = el('div');
      var rebuildBtn = el('button', cls.btnGhost + ' aria-disabled:opacity-50 aria-disabled:cursor-not-allowed min-w-[10.5rem]');
      rebuildBtn.type = 'button';
      rebuildBtn.id = 'booksRebuild';
      var rebuildIcon = icon('sync', 'text-base');
      var rebuildLabel = document.createTextNode('Rebuild now');
      rebuildBtn.appendChild(rebuildIcon);
      rebuildBtn.appendChild(rebuildLabel);
      rebuildRow.appendChild(rebuildBtn);
      rebuildRow.appendChild(el('p', cls.help, 'Takes a few seconds. The library stays open while it runs.'));
      catalog.body.appendChild(rebuildRow);
      panel.appendChild(catalog.root);

      function noteLine(text, tone) {
        var p = el('p', 'flex items-start gap-2');
        var dot = el('span', 'ws-light mt-[7px] ' + tone);
        dot.setAttribute('aria-hidden', 'true');
        p.appendChild(dot);
        p.appendChild(el('span', 'min-w-0', text));
        return p;
      }

      function paintCatalog() {
        var s = data.status;
        if (!s) {
          if (failed.status) {
            light.className = 'ws-light mt-[7px] ws-light-unconfigured';
            setText(whenText, MSG.loadFailed);
            setText(lineCounts, '');
          }
          return;
        }
        var errors = s.errors && typeof s.errors === 'object' ? s.errors : {};
        var bad = !!(str(errors.kavita) || str(errors.plex));
        var tone = s.running ? 'ws-light-checking' : (s.last_rebuild_at ? (bad ? 'ws-light-warn' : 'ws-light-ok') : 'ws-light-off');
        var lightCls = 'ws-light mt-[7px] ' + tone;
        if (light.className !== lightCls) light.className = lightCls;
        setText(whenText, s.running ? MSG.building
          : (s.last_rebuild_at ? 'Built ' + ago(s.last_rebuild_at) + '.' : MSG.notBuilt));
        var c = s.counts && typeof s.counts === 'object' ? s.counts : {};
        setText(lineCounts, s.last_rebuild_at
          ? plural(num(c.books), 'book', 'books') + ': ' + plural(num(c.ebooks), 'ebook', 'ebooks') + ' and ' +
            plural(num(c.audiobooks), 'audiobook edition', 'audiobook editions') + '.'
          : '');
        notes.replaceChildren();
        if (str(errors.kavita)) notes.appendChild(noteLine(sentence(errors.kavita), 'ws-light-warn'));
        if (str(errors.plex)) notes.appendChild(noteLine(sentence(errors.plex), 'ws-light-warn'));
        if (changed || waitingOverrides()) notes.appendChild(noteLine(MSG.waiting, 'ws-light-unconfigured'));
        rebuildBtn.setAttribute('aria-disabled', s.running || rebuilding ? 'true' : 'false');
      }

      // An override made since the last rebuild has not shown yet (a removal leaves no row to count).
      function waitingOverrides() {
        var built = Date.parse((data.status && data.status.last_rebuild_at) || '');
        return (data.overrides || []).some(function (o) {
          var t = Date.parse(o.created_at || '');
          return !!t && (!built || t > built);
        });
      }

      function paintRebuildButton() {
        rebuildLabel.textContent = rebuilding ? 'Rebuilding…' : 'Rebuild now';
        rebuildIcon.className = 'material-symbols-outlined text-base' + (rebuilding ? ' motion-safe:animate-spin' : '');
        rebuildBtn.setAttribute('aria-disabled', rebuilding || (data.status && data.status.running) ? 'true' : 'false');
      }

      // ---- Not matched ----

      var unmatched = WSSettings.card('Not matched', 'Books that turned up in only one place. If an ebook and an audiobook are the same book, pick both and pair them.');
      var pickGrid = el('div', 'grid lg:grid-cols-2 gap-5');
      var ebookCol = el('div', 'min-w-0');
      var audioCol = el('div', 'min-w-0');
      var ebookHead = el('h3', 'text-[15px] font-semibold text-frosted-blue mb-2', 'Ebooks without an audiobook');
      var audioHead = el('h3', 'text-[15px] font-semibold text-frosted-blue mb-2', 'Audiobooks without an ebook');
      var ebookBox = el('div', BOX);
      var audioBox = el('div', BOX);
      ebookBox.setAttribute('role', 'radiogroup');
      audioBox.setAttribute('role', 'radiogroup');
      ebookBox.setAttribute('aria-label', 'Ebooks without an audiobook');
      audioBox.setAttribute('aria-label', 'Audiobooks without an ebook');
      ebookCol.appendChild(ebookHead);
      ebookCol.appendChild(ebookBox);
      audioCol.appendChild(audioHead);
      audioCol.appendChild(audioBox);
      pickGrid.appendChild(ebookCol);
      pickGrid.appendChild(audioCol);
      unmatched.body.appendChild(pickGrid);

      var pairRow = el('div', 'flex flex-wrap items-center gap-x-4 gap-y-2');
      var pairBtn = el('button', cls.btnPrimary + ' aria-disabled:opacity-50 aria-disabled:cursor-not-allowed');
      pairBtn.type = 'button';
      pairBtn.id = 'booksPair';
      pairBtn.appendChild(icon('link', 'text-base'));
      pairBtn.appendChild(document.createTextNode('Pair these two'));
      var pairHint = el('p', 'min-w-0 flex-1 basis-60 text-[13px] leading-5 text-frosted-blue/70 min-h-10');
      pairHint.setAttribute('aria-live', 'polite');
      pairRow.appendChild(pairBtn);
      pairRow.appendChild(pairHint);
      unmatched.body.appendChild(pairRow);
      panel.appendChild(unmatched.root);

      function empty(text, icon_) {
        var box = el('div', 'h-full grid place-items-center text-center px-4');
        var inner = el('div', 'text-frosted-blue/70');
        inner.appendChild(icon(icon_ || 'check_circle', 'text-[28px] block mx-auto mb-1'));
        inner.appendChild(el('p', 'text-[15px]', text));
        box.appendChild(inner);
        return box;
      }

      function boxFailed(box) {
        box.replaceChildren(empty(MSG.loadFailed, 'cloud_off'));
      }

      function radioRow(group, value, title, lines, chosen, onPick) {
        var label = el('label', 'block cursor-pointer');
        var input = el('input', 'peer sr-only');
        input.type = 'radio';
        input.name = group;
        input.value = String(value);
        input.checked = chosen;
        var face = el('span', ROW + ' peer-focus-visible:outline peer-focus-visible:outline-2 ' +
          'peer-focus-visible:outline-offset-[-2px] peer-focus-visible:outline-primary');
        var mark = icon('radio_button_unchecked', 'text-[20px] mt-0.5 shrink-0 text-frosted-blue/70');
        var text = el('span', 'min-w-0 break-words');
        text.appendChild(el('span', 'block text-[15px] font-semibold leading-snug text-frosted-blue', title || 'Untitled'));
        lines.forEach(function (line) {
          if (line) text.appendChild(el('span', 'block text-[13px] leading-5 text-frosted-blue/70', line));
        });
        face.appendChild(mark);
        face.appendChild(text);
        label.appendChild(input);
        label.appendChild(face);
        input.addEventListener('change', function () {
          if (!input.checked) return;
          onPick();
          markRows(label.parentNode);
          paintPair();
        }, { signal: signal });
        return label;
      }

      // The chosen row reads as chosen by its mark as well as its tint. Done in place, so the
      // list keeps its scroll position and the keyboard stays on the radio it is on.
      function markRows(box) {
        Array.prototype.forEach.call(box.querySelectorAll('label'), function (label) {
          var on = label.querySelector('input').checked;
          var face = label.lastChild;
          face.className = face.className.replace(on ? ROW_OFF : ROW_ON, '').trim();
          if (face.className.indexOf(on ? ROW_ON : ROW_OFF) < 0) face.className += ' ' + (on ? ROW_ON : ROW_OFF);
          var mark = face.firstChild;
          var name = on ? 'radio_button_checked' : 'radio_button_unchecked';
          if (mark.textContent !== name) mark.textContent = name;
        });
      }

      function paintUnpaired() {
        var u = data.unpaired;
        if (!u) { if (failed.lists) { boxFailed(ebookBox); boxFailed(audioBox); } return; }
        var ebooks = Array.isArray(u.ebooks) ? u.ebooks : [];
        var audio = Array.isArray(u.audiobooks) ? u.audiobooks : [];
        if (pick.ebook && !ebooks.some(function (e) { return e.kavita_chapter_id === pick.ebook.kavita_chapter_id; })) pick.ebook = null;
        if (pick.audio && !audio.some(function (a) { return a.plex_book_key === pick.audio.plex_book_key; })) pick.audio = null;

        var ebookTop = ebookBox.scrollTop, audioTop = audioBox.scrollTop;
        ebookBox.replaceChildren();
        if (!ebooks.length) ebookBox.appendChild(empty(audio.length ? MSG.noEbooks : MSG.allMatched));
        ebooks.forEach(function (e) {
          ebookBox.appendChild(radioRow('booksPickEbook', e.kavita_chapter_id, e.title, [byline(e.author, e.series)],
            !!pick.ebook && pick.ebook.kavita_chapter_id === e.kavita_chapter_id, function () { pick.ebook = e; }));
        });
        audioBox.replaceChildren();
        if (!audio.length) audioBox.appendChild(empty(ebooks.length ? MSG.noAudio : MSG.allMatched));
        audio.forEach(function (a) {
          audioBox.appendChild(radioRow('booksPickAudio', a.plex_book_key, a.title, [byline(a.author, a.series), narration(a.narrator)],
            !!pick.audio && pick.audio.plex_book_key === a.plex_book_key, function () { pick.audio = a; }));
        });
        markRows(ebookBox);
        markRows(audioBox);
        ebookBox.scrollTop = ebookTop;
        audioBox.scrollTop = audioTop;
        paintPair();
      }

      function paintPair() {
        var ready = !!(pick.ebook && pick.audio);
        pairBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
        setText(pairHint, ready
          ? 'Pair “' + pick.ebook.title + '” with “' + pick.audio.title + '”' +
            (pick.audio.narrator ? ', read by ' + pick.audio.narrator : '') + '.'
          : MSG.pickBoth);
      }

      // ---- Matched books ----

      var matched = WSSettings.card('Matched books', 'Books that have an ebook and one or more audiobooks. If a pair is wrong, keep that audiobook apart.');
      var findWrap = el('div', 'max-w-sm');
      var findLabel = el('label', cls.label, 'Find a book');
      var find = el('input', cls.input);
      find.id = 'booksFind';
      find.type = 'search';
      find.autocomplete = 'off';
      find.maxLength = 100;
      findLabel.htmlFor = find.id;
      findWrap.appendChild(findLabel);
      findWrap.appendChild(find);
      var matchedBox = el('div', BOX);
      matchedBox.id = 'booksMatched';
      matchedBox.tabIndex = -1;
      var matchedNote = el('p', cls.help + ' min-h-5');
      matchedNote.setAttribute('aria-live', 'polite');
      matched.body.appendChild(findWrap);
      matched.body.appendChild(matchedBox);
      matched.body.appendChild(matchedNote);
      panel.appendChild(matched.root);

      function paintMatched() {
        var m = data.paired;
        if (!m) { if (failed.lists) { boxFailed(matchedBox); setText(matchedNote, ''); } return; }
        var all = Array.isArray(m.books) ? m.books : [];
        var q = filter.trim().toLowerCase();
        var shown = all.filter(function (b) {
          return !q || (b.title + ' ' + b.author + ' ' + b.series).toLowerCase().indexOf(q) >= 0;
        });
        var list = shown.slice(0, MATCHED_CAP);
        var apart = {};
        (data.overrides || []).forEach(function (o) {
          if (o.action === 'apart') apart[o.kavita_chapter_id + '|' + o.plex_book_key] = true;
        });
        var top = matchedBox.scrollTop;
        matchedBox.replaceChildren();
        if (!all.length) matchedBox.appendChild(empty(MSG.noMatched, 'link_off'));
        else if (!shown.length) matchedBox.appendChild(empty(MSG.nothingFound, 'search_off'));
        list.forEach(function (b) {
          var row = el('div', 'rounded-[10px] px-3 py-2.5');
          var head = el('div', 'min-w-0 break-words');
          head.appendChild(el('p', 'text-[15px] font-semibold leading-snug text-frosted-blue', b.title || 'Untitled'));
          var by = byline(b.author, b.series);
          if (by) head.appendChild(el('p', 'text-[13px] leading-5 text-frosted-blue/70', by));
          row.appendChild(head);
          var eds = el('ul', 'mt-1');
          (b.editions || []).forEach(function (e) {
            var li = el('li', 'flex items-center justify-between gap-3 min-h-10');
            li.appendChild(el('span', 'min-w-0 break-words text-[13px] leading-5 text-frosted-blue/70',
              e.narrator ? narration(e.narrator) : 'Audiobook'));
            if (apart[b.kavita_chapter_id + '|' + e.plex_book_key]) {
              li.appendChild(el('span', 'shrink-0 text-[13px] font-semibold text-frosted-blue', 'Kept apart at the next rebuild'));
            } else {
              var btn = el('button', cls.btnQuiet + ' shrink-0 h-10');
              btn.type = 'button';
              btn.textContent = 'Keep apart';
              // Starts with the words on the button, so the name holds the label (WCAG 2.5.3).
              btn.setAttribute('aria-label', 'Keep apart: ' + (e.narrator ? 'the audiobook read by ' + e.narrator : 'this audiobook') +
                ' and the ebook of ' + (b.title || 'this book'));
              btn.addEventListener('click', function () { keepApart(b, e, btn); }, { signal: signal });
              li.appendChild(btn);
            }
            eds.appendChild(li);
          });
          row.appendChild(eds);
          matchedBox.appendChild(row);
        });
        matchedBox.scrollTop = top;
        setText(matchedNote, shown.length > MATCHED_CAP
          ? 'Showing ' + MATCHED_CAP + ' of ' + shown.length + '. Type to narrow it down.' : '');
      }

      // ---- Your choices ----

      var choices = WSSettings.card('Your choices', 'Pairs and splits you set by hand. They stay through every rebuild.');
      var choiceList = el('div', 'space-y-2');
      choiceList.id = 'booksChoices';
      choiceList.tabIndex = -1;
      choices.body.appendChild(choiceList);
      panel.appendChild(choices.root);

      // The narrator of an edition, from whichever list still knows it.
      function narratorOf(key) {
        var found = '';
        ((data.paired && data.paired.books) || []).forEach(function (b) {
          (b.editions || []).forEach(function (e) { if (e.plex_book_key === key) found = e.narrator; });
        });
        ((data.unpaired && data.unpaired.audiobooks) || []).forEach(function (a) {
          if (a.plex_book_key === key) found = a.narrator;
        });
        return found || '';
      }

      function paintChoices() {
        var list = data.overrides;
        if (!list) {
          if (failed.lists) choiceList.replaceChildren(el('p', 'text-[15px] text-frosted-blue/70', MSG.loadFailed));
          return;
        }
        choiceList.replaceChildren();
        if (!list.length) choiceList.appendChild(el('p', 'text-[15px] text-frosted-blue/70', MSG.noChoices));
        list.forEach(function (o) {
          var row = el('div', 'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] px-4 py-3');
          var text = el('div', 'min-w-0 flex-1 basis-60 break-words');
          var apart = o.action === 'apart';
          text.appendChild(el('p', 'text-[13px] font-semibold leading-5 text-frosted-blue/70', apart ? 'Kept apart' : 'Paired'));
          var narrator = narratorOf(o.plex_book_key);
          text.appendChild(el('p', 'text-[15px] leading-snug text-frosted-blue',
            (o.ebook_title || 'An ebook no longer in the catalog') + (apart ? ' and ' : ' with ') +
            (o.audio_title || 'an audiobook no longer in the catalog') + (narrator ? ', read by ' + narrator : '')));
          var btn = el('button', cls.btnQuiet + ' shrink-0 h-10');
          btn.type = 'button';
          btn.textContent = 'Remove';
          btn.setAttribute('aria-label', 'Remove this choice: ' + (apart ? 'keep ' : 'pair ') +
            (o.ebook_title || 'the ebook') + (apart ? ' and ' : ' with ') + (o.audio_title || 'the audiobook'));
          btn.addEventListener('click', function () { removeChoice(o, btn); }, { signal: signal });
          row.appendChild(text);
          row.appendChild(btn);
          choiceList.appendChild(row);
        });
      }

      // ---- Loading ----

      function get(path) {
        return fetch(BASE + path, { credentials: 'same-origin', signal: signal }).then(readJson, function () {
          return { status: 0, ok: false, d: {} };
        });
      }

      function send(method, path, body) {
        var init = { method: method, credentials: 'same-origin', signal: signal };
        if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
        return fetch(BASE + path, init).then(readJson, function () { return null; });
      }

      function leaveIf401(res) {
        if (res && res.status === 401) { WSSettings.leave('/login'); return true; }
        return false;
      }

      var denied = false;
      function deny() {
        if (denied) return;
        denied = true;
        var note = el('p', 'text-[15px] text-frosted-blue/70 max-w-2xl', MSG.noAccess);
        panel.replaceChildren(note);
      }

      function loadStatus() {
        return get('/status').then(function (res) {
          if (leaveIf401(res) || signal.aborted) return;
          if (res.status === 403) { deny(); return; }
          if (!res.ok || !res.d.counts) { failed.status = !data.status; paintCatalog(); return; }
          failed.status = false;
          var moved = lastRebuildAt !== null && lastRebuildAt !== res.d.last_rebuild_at;
          lastRebuildAt = res.d.last_rebuild_at || '';
          data.status = res.d;
          if (!res.d.running && moved) { changed = false; loadLists(); }
          paintCatalog();
          paintRebuildButton();
        });
      }

      var listSeq = 0;
      function loadLists() {
        var mine = ++listSeq;
        return Promise.all([get('/unpaired'), get('/paired'), get('/overrides')]).then(function (all) {
          if (mine !== listSeq || signal.aborted) return;
          for (var i = 0; i < all.length; i++) if (leaveIf401(all[i])) return;
          if (all.some(function (r) { return r.status === 403; })) { deny(); return; }
          var u = all[0], p = all[1], o = all[2];
          failed.lists = !(u.ok && p.ok && o.ok) && !data.unpaired;
          if (u.ok && Array.isArray(u.d.ebooks)) data.unpaired = u.d;
          if (p.ok && Array.isArray(p.d.books)) data.paired = p.d;
          if (o.ok && Array.isArray(o.d.overrides)) data.overrides = o.d.overrides;
          paintUnpaired();
          paintMatched();
          paintChoices();
          paintCatalog();
        });
      }

      function reloadAll() { return Promise.all([loadStatus(), loadLists()]); }

      // ---- Actions ----

      function failToast(res, fallback) {
        if (res && typeof res.d.detail === 'string' && res.d.detail.trim() && res.status >= 400 && res.status < 500) {
          WSSettings.toast(sentence(res.d.detail), 'err');
        } else {
          WSSettings.toast(res ? fallback : MSG.offline, 'err');
        }
      }

      function afterChange(message) {
        changed = true;
        WSSettings.toast(message, 'ok');
        paintCatalog();
      }

      rebuildBtn.addEventListener('click', function () {
        if (rebuilding || rebuildBtn.getAttribute('aria-disabled') === 'true') return;
        rebuilding = true;
        paintRebuildButton();
        send('POST', '/rebuild').then(function (res) {
          if (signal.aborted || (res && leaveIf401(res))) return;
          if (!res || !res.ok) { failToast(res, MSG.rebuildFailed); return; }
          var d = res.d;
          if (d.skipped) { WSSettings.toast(MSG.rebuildBusy, 'info'); return; }
          var errors = d.errors && typeof d.errors === 'object' ? d.errors : {};
          if (str(errors.kavita) || str(errors.plex)) {
            WSSettings.toast('Rebuilt, but a source didn’t answer. The books it had before are kept.', 'info');
          } else {
            WSSettings.toast('Rebuilt: ' + plural(num(d.books), 'book', 'books') + '.', 'ok');
          }
          changed = false;
        }).catch(function (e) {
          if (window.console) console.error(e);
          WSSettings.toast(MSG.rebuildFailed, 'err');
        }).then(function () {
          rebuilding = false;
          paintRebuildButton();
          if (!signal.aborted) return reloadAll();
        });
      }, { signal: signal });

      function setOverride(body, done) {
        return send('POST', '/overrides', body).then(function (res) {
          if (signal.aborted || (res && leaveIf401(res))) return false;
          if (!res || !res.ok) {
            failToast(res, 'That couldn’t be saved. Try again.');
            // A 404 means the catalog moved on under this page: show what it has now.
            if (res && res.status === 404) loadLists();
            return false;
          }
          done();
          return loadLists().then(function () { return true; });
        }).catch(function (e) {
          if (window.console) console.error(e);
          WSSettings.toast('That couldn’t be saved. Try again.', 'err');
          return false;
        });
      }

      var busy = false;
      pairBtn.addEventListener('click', function () {
        if (busy || pairBtn.getAttribute('aria-disabled') === 'true') {
          if (!busy) WSSettings.toast(MSG.pickBoth, 'info');
          return;
        }
        var e = pick.ebook, a = pick.audio;
        busy = true;
        setOverride({ kavita_chapter_id: e.kavita_chapter_id, plex_book_key: a.plex_book_key, action: 'pair' }, function () {
          pick.ebook = null;
          pick.audio = null;
          afterChange('Paired. It shows after the next rebuild.');
        }).then(function () { busy = false; paintPair(); });
      }, { signal: signal });

      function keepApart(book, edition, btn) {
        if (busy) return;
        busy = true;
        btn.setAttribute('aria-disabled', 'true');
        setOverride({ kavita_chapter_id: book.kavita_chapter_id, plex_book_key: edition.plex_book_key, action: 'apart' }, function () {
          afterChange('Kept apart. It shows after the next rebuild.');
        }).then(function () { busy = false; if (!signal.aborted) matchedBox.focus({ preventScroll: true }); });
      }

      function removeChoice(o, btn) {
        if (busy) return;
        busy = true;
        btn.setAttribute('aria-disabled', 'true');
        send('DELETE', '/overrides?kavita_chapter_id=' + encodeURIComponent(String(o.kavita_chapter_id)) +
          '&plex_book_key=' + encodeURIComponent(o.plex_book_key)).then(function (res) {
          if (signal.aborted || (res && leaveIf401(res))) return;
          // 404: someone else removed it already, which is what was asked.
          if (!res || (!res.ok && res.status !== 404)) { failToast(res, 'That couldn’t be removed. Try again.'); return; }
          changed = true;
          WSSettings.toast('Removed. It shows after the next rebuild.', 'ok');
          return loadLists().then(focusChoices);
        }).catch(function (e) {
          if (window.console) console.error(e);
          WSSettings.toast('That couldn’t be removed. Try again.', 'err');
        }).then(function () { busy = false; });
      }

      // The row that was pressed is gone after a repaint: focus goes to the next Remove, or the list.
      function focusChoices() {
        if (signal.aborted) return;
        var next = choiceList.querySelector('button');
        (next || choiceList).focus({ preventScroll: true });
      }

      find.addEventListener('input', function () { filter = find.value; paintMatched(); }, { signal: signal });

      // "Built … ago" keeps counting, and a rebuild that finished elsewhere shows up.
      ctx.poll(function () { loadStatus(); }, POLL_MS);

      return Promise.race([reloadAll(), new Promise(function (done) { ctx.setTimeout(done, LOAD_WAIT); })]);
    }
  });
})();
