/**
 * WebServarr — Wiki Editor
 *
 * Edits happen on the page being read, not in Settings: same URL, the rendered
 * body swaps for a markdown form. Loaded by wiki.html only.
 *
 * The rule this file exists to keep: a failed save must never cost the author
 * their text. Every keystroke is mirrored to localStorage, every failure path
 * leaves the textarea populated, and the draft is cleared only after the server
 * confirms a write.
 *
 * Each open() is a session: the page it edits, the help links that page held
 * when it was loaded, and the form it drew. A save or delete carries its own
 * session, disables that form while it is in flight, and once it answers acts
 * on screen only while its session is still the one showing.
 *
 * A page helper for the soft-navigated /wiki (spec 4.3): loading this file
 * only defines WikiEditor. The page module calls init(ctx, host) from mount on
 * each visit; host is the wiki's own view (see pages/wiki.js). The form's
 * listeners end with the view it is drawn in, its requests with the visit.
 *
 * Leaving with unsaved text asks first (holds, canLeave): the wiki's claim
 * on its own URLs declines while this holds text, so an article link, Back
 * and Forward reach the router's leave guard, which asks here; a reload or a
 * typed address is asked by the browser (beforeunload). Leave keeps the text
 * as this device's draft, offered the next time the editor opens; a
 * navigation that then stays (ws:nav-stayed) asks again next time.
 */
var WikiEditor = (function () {
  'use strict';

  var DRAFT_PREFIX = 'webservarr.wiki.draft.';
  var MIRROR_DEBOUNCE_MS = 500;

  // The visit init() was given: its signal, and the wiki's view hooks.
  var signal = null, host = null;
  var _root = null;
  var _mirrorTimer = null;
  var _slug = null;          // null while creating a new page
  var _slugTouched = false;  // once the author edits the slug, stop deriving it
  var _cats = [];
  var _session = null;       // the editor on screen: { slug, helpBase, helpSeen, holders, form, busy }
                             // plus restored, baseline, closed, approved (leaving, below)

  // The places a page can be linked as help, in the order the editor lists them.
  var HELP_PLACES = [['tickets', 'Tickets'], ['issues', 'Issues'], ['playback', 'Playback problems']];

  // Order-free comparison of two help lists.
  function helpKey(list) { return (list || []).slice().sort().join(','); }

  // Who holds each help link as this editor sees it, as { slug, title }:
  // from the page response, or - for a new page, which has none - from the
  // branding payload already on this page, which names the published page
  // each help card points at. No extra request either way.
  function helpHolders(page) {
    var out = {};
    var hooks = (window.WEBSERVARR_THEME && window.WEBSERVARR_THEME.wiki_hooks) || {};
    HELP_PLACES.forEach(function (h) {
      var n = h[0], held = page ? (page.help_holders || {})[n] : hooks[n];
      out[n] = held && held.slug ? { slug: held.slug, title: held.title || held.slug } : null;
    });
    return out;
  }

  // One word per place for the state the boxes started from: 'self', the
  // holder by address ('page:' + slug) or '' for nobody. Addresses, not
  // titles: two pages can share a title, and a draft must not mistake one for
  // the other. A draft records this so a restore can tell whether a change
  // the admin made still applies.
  function helpSeen(helpBase, holders) {
    var seen = {};
    HELP_PLACES.forEach(function (h) {
      var n = h[0];
      seen[n] = helpBase.indexOf(n) >= 0 ? 'self' : (holders[n] ? 'page:' + holders[n].slug : '');
    });
    return seen;
  }

  // Keep the branding payload's help links in step with a landed write, so a
  // New page opened later on this page load (the wiki never reloads between
  // views) names the right holders. Mirrors /api/branding: a link to an
  // unpublished page shows as nobody.
  function syncHooks(s, saved, helpOn) {
    var hooks = window.WEBSERVARR_THEME && window.WEBSERVARR_THEME.wiki_hooks;
    if (!hooks) return;
    HELP_PLACES.forEach(function (h) {
      var n = h[0], cur = hooks[n];
      var mine = !!(cur && s.slug && cur.slug === s.slug);
      var holds = saved ? (helpOn ? helpOn.indexOf(n) >= 0 : s.helpBase.indexOf(n) >= 0) : false;
      if (holds) hooks[n] = saved.published ? { slug: saved.slug, title: saved.title } : null;
      else if (mine) hooks[n] = null;
    });
  }

  function clearPageCache() {
    // A saved page can change the help card on /tickets and /issues, and a
    // title or address on any page that lists it; drop what was prefetched.
    if (window.WS && WS.clearPageCache) WS.clearPageCache();
  }

  // ---------- draft mirroring ----------

  function draftKey(slug) { return DRAFT_PREFIX + (slug || '__new__'); }

  function saveDraft(slug, fields) {
    try {
      localStorage.setItem(draftKey(slug), JSON.stringify({
        fields: fields,
        at: new Date().toISOString()
      }));
    } catch (e) {
      // Private mode, quota, or storage disabled. The textarea is still the
      // source of truth, so this is a lost safety net, not a lost edit.
    }
  }

  function loadDraft(slug) {
    try { return JSON.parse(localStorage.getItem(draftKey(slug)) || 'null'); }
    catch (e) { return null; }
  }

  function clearDraft(slug) {
    try { localStorage.removeItem(draftKey(slug)); } catch (e) {}
  }

  // ---------- small DOM helpers ----------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function icon(name, cls) {
    var s = el('span', 'material-symbols-outlined ' + (cls || ''));
    s.textContent = name;
    return s;
  }

  function slugify(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 220) || 'page';
  }

  var INPUT_CLS = 'w-full px-3 py-2 rounded-lg bg-background-dark border border-steel-blue/40 ' +
                  'text-frosted-blue placeholder:text-steel-blue focus:border-primary focus:ring-0 transition-colors';
  var BTN_PRIMARY = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-bright ' +
                    'text-sm font-bold hover:opacity-90 transition-all';
  var BTN_GHOST = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 text-frosted-blue ' +
                  'border border-primary/30 text-sm font-bold hover:bg-primary/20 transition-all';
  var BTN_QUIET = 'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-steel-blue ' +
                  'text-sm font-bold hover:text-frosted-blue transition-colors';

  function field(labelText, control, hint) {
    var wrap = el('div');
    var label = el('label', 'block text-xs font-bold uppercase tracking-wider text-steel-blue mb-1.5', labelText);
    label.htmlFor = control.id;
    wrap.appendChild(label);
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el('p', 'text-xs text-steel-blue mt-1', hint));
    return wrap;
  }

  function status(msg, tone) {
    var box = document.getElementById('wikiEditStatus');
    if (!box) return;
    box.textContent = msg || '';
    box.className = 'text-sm ' + (tone === 'bad' ? 'text-frosted-blue font-bold' : 'text-steel-blue');
  }

  // ---------- API ----------

  function isAbort(e) { return !!e && e.name === 'AbortError'; }

  async function fetchCategories(vsig) {
    try {
      var res = await fetch('/api/wiki/categories', { signal: vsig });
      if (!res.ok) return [];
      return await res.json();
    } catch (e) { return []; }
  }

  async function fetchPage(slug, vsig) {
    var res = await fetch('/api/wiki/pages/' + encodeURIComponent(slug), { signal: vsig });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // On the editor view's signal (vs): an editor the admin has left stops
  // waiting for its image.
  async function uploadImage(file, vs) {
    var fd = new FormData();
    fd.append('file', file);
    var res = await fetch('/api/wiki/images', { method: 'POST', body: fd, signal: vs });
    if (!res.ok) {
      var body = await res.json().catch(function () { return {}; });
      throw new Error(typeof body.detail === 'string' ? body.detail : 'Upload failed');
    }
    var data = await res.json();
    return '![](' + data.url + ')';
  }

  // The fields of session s's form (the one on screen by default). Read from
  // the form itself, so a mirror that fires after the wiki has moved on to
  // another view still writes what was typed, never an empty draft.
  function collect(s) {
    s = s || _session;
    var f = (s && s.form) || document;
    function value(id) { return (f.querySelector('#' + id) || {}).value; }
    return {
      title: value('wikiEditTitle') || '',
      slug: value('wikiEditSlug') || '',
      summary: value('wikiEditSummary') || '',
      content: value('wikiEditContent') || '',
      category_slug: value('wikiEditCategory') || null,
      sort_order: parseInt(value('wikiEditSort'), 10) || 0,
      help_on: Array.prototype.slice.call(f.querySelectorAll('input[name="wikiEditHelp"]'))
        .filter(function (i) { return i.checked; })
        .map(function (i) { return i.value; })
    };
  }

  // While a write is in flight nothing in its form can be pressed or edited:
  // a second Publish would send a duplicate, and text typed now would be lost
  // when the save lands and shows the page.
  function setBusy(s, busy) {
    s.busy = busy;
    Array.prototype.slice.call(s.form.querySelectorAll('button, input, select, textarea'))
      .forEach(function (n) { n.disabled = busy; });
  }

  async function save(publish) {
    var s = _session;
    if (!s || s.busy) return;
    var sig = signal;
    var fields = collect(s);
    if (!fields.title.trim()) { status('Give the page a title before saving.', 'bad'); return; }
    if (!fields.content.trim()) { status('The page is empty.', 'bad'); return; }

    var payload = {
      title: fields.title,
      slug: fields.slug || null,
      summary: fields.summary || null,
      content: fields.content,
      category_slug: fields.category_slug || null,
      sort_order: fields.sort_order,
      published: publish,
      // Only a change the admin made to the boxes is sent; otherwise null
      // leaves the links as the server has them. So a save never moves a link
      // back that another page took after this editor opened, and an old
      // draft's boxes cannot either.
      help_on: helpKey(fields.help_on) !== helpKey(s.helpBase) ? fields.help_on : null
    };

    setBusy(s, true);
    status('Saving…');
    var res;
    try {
      res = await fetch(s.slug ? '/api/wiki/pages/' + encodeURIComponent(s.slug) : '/api/wiki/pages', {
        method: s.slug ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: sig
      });
    } catch (e) {
      // Network died. The text is still on screen and still mirrored. The
      // write may still have landed, so the prefetched pages go either way.
      clearPageCache();
      if (sig.aborted) return;        // the page was left: nothing to tell
      setBusy(s, false);
      if (_session === s) status('Could not reach the server. Your text is safe here — try again.', 'bad');
      return;
    }
    clearPageCache();
    var saved = res.ok ? await res.json().catch(function () { return null; }) : null;
    if (sig.aborted) return;
    if (saved) syncHooks(s, saved, payload.help_on);

    if (!res.ok) setBusy(s, false);
    // Another editor opened while this one was saving: its form is not ours to
    // write into, and a landed save must not pull the admin away from it.
    if (_session !== s) return;

    if (res.status === 409) {
      var body = await res.json().catch(function () { return {}; });
      var d = body.detail || {};
      var suggested = d.suggested_slug;
      status((d.message || 'That address is taken.') +
             (suggested ? ' Suggested: ' + suggested : ''), 'bad');
      var slugInput = document.getElementById('wikiEditSlug');
      if (slugInput && suggested) {
        slugInput.value = suggested;
        _slugTouched = true;
        slugInput.focus();
      }
      return;
    }

    if (res.status === 401) {
      status('Your session expired. Sign in again in a new tab, then press save — nothing is lost.', 'bad');
      var link = document.getElementById('wikiEditReauth');
      if (link) link.classList.remove('hidden');
      return;
    }

    if (res.status === 429) {
      status('Saving too quickly. Wait a moment and press save again.', 'bad');
      return;
    }

    if (res.status === 404) {
      // The page was deleted while this editor was open (or the category it
      // was filed under was). The draft is kept.
      var gone = await res.json().catch(function () { return {}; });
      status(gone.detail === 'Category not found'
        ? 'That category no longer exists. Pick another one and save again.'
        : 'This page was deleted while you were editing, so it can’t be saved. Your text is still here — copy it before you leave.', 'bad');
      return;
    }

    if (!res.ok) {
      status('The save failed (HTTP ' + res.status + '). Your text is still here — try again.', 'bad');
      return;
    }

    if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
    clearDraft(s.slug);
    clearDraft(null);
    status(publish ? 'Published.' : 'Saved as a draft.');

    // Land on the saved page so the author sees exactly what a reader will.
    // Nothing is left unsaved, so nothing asks on the way.
    s.closed = true;
    host.navigate('/wiki/' + encodeURIComponent(saved ? saved.slug : (s.slug || '')));
  }

  async function remove() {
    var s = _session;
    if (!s || s.busy) return;
    var sig = signal;
    if (!s.slug) { close(); return; }
    var ok = await window.WSUI.confirm({
      title: 'Delete this page?',
      body: 'It can’t be brought back, and any help links to it are removed.',
      confirmLabel: 'Delete page', cancelLabel: 'Keep it', danger: true
    });
    // The answer comes later: delete only if this editor is still the one
    // showing and nothing else is writing from it.
    if (!ok || _session !== s || s.busy) return;
    setBusy(s, true);
    var res;
    try {
      res = await fetch('/api/wiki/pages/' + encodeURIComponent(s.slug), { method: 'DELETE', signal: sig });
    } catch (e) {
      clearPageCache();
      if (sig.aborted) return;
      setBusy(s, false);
      if (_session === s) status('Could not reach the server.', 'bad');
      return;
    }
    clearPageCache();
    if (!res.ok && res.status !== 204) {
      setBusy(s, false);
      if (_session === s) status('Delete failed (HTTP ' + res.status + ').', 'bad');
      return;
    }
    syncHooks(s, null, null);
    if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
    clearDraft(s.slug);
    s.closed = true;
    if (_session === s && !sig.aborted) host.navigate('/wiki');
  }

  // Back to the page, or Cancel: the admin chose to go, and the text stays
  // as this device's draft (the editor offers it next time), so nothing asks.
  function close() {
    if (_session) _session.closed = true;
    if (_slug) host.navigate('/wiki/' + encodeURIComponent(_slug));
    else host.navigate('/wiki');
  }

  // ---------- markdown toolbar ----------

  // Session s's own textarea (the one on screen by default), never a lookup
  // in the document: an answer for one editor must not land in another's.
  function textarea(s) {
    s = s || _session;
    return s && s.form ? s.form.querySelector('#wikiEditContent') : null;
  }

  function wrapSelection(before, after, placeholder) {
    var ta = textarea();
    if (!ta) return;
    var start = ta.selectionStart, end = ta.selectionEnd;
    var selected = ta.value.slice(start, end) || placeholder || '';
    var inserted = before + selected + (after || '');
    ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
    ta.focus();
    ta.selectionStart = start + before.length;
    ta.selectionEnd = start + before.length + selected.length;
    mirror();
  }

  function insertAtCaret(text, s) {
    var ta = textarea(s);
    if (!ta) return;
    var start = ta.selectionStart;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(ta.selectionEnd);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + text.length;
    mirror();
  }

  function toolbar(vs) {
    var bar = el('div', 'flex flex-wrap gap-1 mb-2');
    var buttons = [
      ['format_bold', 'Bold', function () { wrapSelection('**', '**', 'bold text'); }],
      ['format_italic', 'Italic', function () { wrapSelection('*', '*', 'italic text'); }],
      ['title', 'Heading', function () { wrapSelection('\n## ', '\n', 'Heading'); }],
      ['format_list_bulleted', 'List', function () { wrapSelection('\n- ', '', 'item'); }],
      ['link', 'Link', function () { wrapSelection('[', '](/wiki/page-slug)', 'link text'); }],
      ['code', 'Code block', function () { wrapSelection('\n```\n', '\n```\n', 'code'); }]
    ];
    buttons.forEach(function (b) {
      var btn = el('button', 'p-2 rounded text-steel-blue hover:text-frosted-blue hover:bg-primary/10 transition-colors');
      btn.type = 'button';
      btn.title = b[1];
      btn.setAttribute('aria-label', b[1]);
      btn.appendChild(icon(b[0], 'text-lg'));
      btn.addEventListener('click', b[2], { signal: vs });
      bar.appendChild(btn);
    });
    return bar;
  }

  // ---------- mirroring wiring ----------

  function mirror() {
    if (_mirrorTimer) clearTimeout(_mirrorTimer);
    var s = _session;
    _mirrorTimer = setTimeout(function () {
      _mirrorTimer = null;
      if (_session !== s) return;
      // help_state records the state the boxes started from, so a restore can
      // tell a change the admin made, and whether it still applies. (Older
      // drafts carried help_base or help_seen, keyed on titles; they are never
      // replayed.)
      var fields = collect(s);
      fields.help_state = Object.assign({}, s.helpSeen);
      saveDraft(s.slug, fields);
    }, MIRROR_DEBOUNCE_MS);
  }

  // ---------- open ----------

  async function open(slug) {
    if (!host || !host.isAdmin()) return;
    // The view Edit or New page was pressed on. Moving on from it (another
    // article, or leaving the wiki) drops this open: nothing is drawn over
    // what replaced it.
    var vsig = host.view();

    _slug = slug || null;
    _slugTouched = !!slug;
    if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
    _root = host.root();
    if (!_root) return;

    var page = null;
    if (slug) {
      try { page = await fetchPage(slug, vsig); }
      catch (e) {
        if (vsig.aborted) return;
        // Stop here rather than falling through and loading `undefined` into the
        // fields — the News editor shipped exactly that bug once.
        window.WSUI.toast('Couldn’t load that page for editing. Try again.', 'err');
        return;
      }
    }

    _cats = await fetchCategories(vsig);
    if (vsig.aborted) return;

    var draft = loadDraft(_slug);
    var useDraft = false;
    if (draft && draft.fields) {
      var serverStamp = page && page.updated_at ? Date.parse(page.updated_at) : 0;
      var draftStamp = Date.parse(draft.at || '') || 0;
      var differs = !page || draft.fields.content !== page.content;
      if (differs && draftStamp > serverStamp) {
        var here = location.href;
        useDraft = await window.WSUI.confirm({
          title: 'Restore your unsaved changes?',
          body: 'You have unsaved changes from ' + new Date(draftStamp).toLocaleString() +
            '. Restore them, or keep the saved version.',
          confirmLabel: 'Restore changes', cancelLabel: 'Keep saved version'
        });
        // The reader may have gone elsewhere while the question was up; the
        // editor is then not drawn over the new view (the draft stays).
        if (location.href !== here || vsig.aborted) return;
        if (!useDraft) clearDraft(_slug);
      }
    }

    var helpBase = page ? (page.help_on || []).slice() : [];
    var holders = helpHolders(page);
    var seenNow = helpSeen(helpBase, holders);
    var dropped = false;
    var initial = useDraft ? draft.fields : {
      title: page ? page.title : '',
      slug: page ? page.slug : '',
      summary: page ? (page.summary || '') : '',
      content: page ? page.content : '',
      category_slug: page ? (page.category_slug || '') : '',
      sort_order: page ? page.sort_order : 0,
      help_on: helpBase.slice()
    };
    if (useDraft) {
      // A restored draft replays a box only where the admin changed it before
      // leaving AND that link is still where it was then. Everything else
      // shows the links as they are now, so an old draft can neither undo a
      // move made since nor quietly take a link another page now holds.
      var f = draft.fields, then = f.help_state;
      var usable = !!then && typeof then === 'object' && !Array.isArray(then) && Array.isArray(f.help_on);
      var on = [];
      HELP_PLACES.forEach(function (h) {
        var n = h[0], want = seenNow[n] === 'self';
        if (usable) {
          var ticked = f.help_on.indexOf(n) >= 0;
          if (ticked !== (then[n] === 'self')) {
            if (then[n] === seenNow[n]) want = ticked;
            else dropped = true;
          }
        }
        if (want) on.push(n);
      });
      initial = Object.assign({}, f, { help_on: on });
    }

    _session = { slug: _slug, helpBase: helpBase, helpSeen: seenNow, holders: holders, form: null, busy: false };
    _session.restored = useDraft;     // a restored draft is unsaved from the start
    _session.uploads = 0;             // images still uploading into this form
    render(initial, page);
    if (dropped) status('Your unsaved change to the help links was left out: that link has changed since.');
  }

  function render(initial, page) {
    // A view of the wiki's own: the article's listeners end here, and the
    // form's end when the wiki draws its next view.
    var vs = host.newView();
    while (_root.firstChild) _root.removeChild(_root.firstChild);

    var head = el('div', 'mb-6');
    var backBtn = el('button', 'inline-flex items-center gap-1 text-xs font-bold text-steel-blue hover:text-frosted-blue transition-colors mb-3');
    backBtn.type = 'button';
    backBtn.appendChild(icon('chevron_left', 'text-sm'));
    backBtn.appendChild(document.createTextNode(_slug ? 'Back to the page' : 'Back to the wiki'));
    backBtn.addEventListener('click', close, { signal: vs });
    head.appendChild(backBtn);
    head.appendChild(el('h1', 'text-2xl lg:text-3xl font-bold text-frosted-blue leading-tight',
      _slug ? 'Editing a page' : 'New page'));
    _root.appendChild(head);

    var form = el('div', 'grid gap-5');

    var title = el('input', INPUT_CLS);
    title.id = 'wikiEditTitle';
    title.type = 'text';
    title.value = initial.title || '';
    title.placeholder = 'What is this page about?';
    form.appendChild(field('Title', title));

    var slugIn = el('input', INPUT_CLS);
    slugIn.id = 'wikiEditSlug';
    slugIn.type = 'text';
    slugIn.value = initial.slug || '';
    slugIn.placeholder = 'auto-generated-from-the-title';
    form.appendChild(field('Address', slugIn, 'The page lives at /wiki/<address>. Changing it breaks links people already have.'));

    // Derive the slug from the title until the author takes it over.
    title.addEventListener('input', function () {
      if (!_slugTouched) slugIn.value = slugify(title.value);
      mirror();
    }, { signal: vs });
    slugIn.addEventListener('input', function () { _slugTouched = true; mirror(); }, { signal: vs });

    var summary = el('input', INPUT_CLS);
    summary.id = 'wikiEditSummary';
    summary.type = 'text';
    summary.value = initial.summary || '';
    summary.placeholder = 'One line shown under the title in lists';
    summary.addEventListener('input', mirror, { signal: vs });
    form.appendChild(field('Summary', summary));

    var row = el('div', 'grid gap-5 sm:grid-cols-2');
    var cat = el('select', INPUT_CLS);
    cat.id = 'wikiEditCategory';
    var none = el('option', null, 'Uncategorised');
    none.value = '';
    cat.appendChild(none);
    _cats.forEach(function (c) {
      var o = el('option', null, c.name);
      o.value = c.slug;
      if (c.slug === initial.category_slug) o.selected = true;
      cat.appendChild(o);
    });
    cat.addEventListener('change', mirror, { signal: vs });
    row.appendChild(field('Category', cat));

    var sort = el('input', INPUT_CLS);
    sort.id = 'wikiEditSort';
    sort.type = 'number';
    sort.value = initial.sort_order || 0;
    sort.addEventListener('input', mirror, { signal: vs });
    row.appendChild(field('Order', sort, 'Lower numbers appear first.'));
    form.appendChild(row);

    var help = el('fieldset', 'grid gap-2');
    help.appendChild(el('legend', 'block text-xs font-bold uppercase tracking-wider text-steel-blue mb-1.5', 'Show as help on'));
    var holders = _session.holders;
    HELP_PLACES.forEach(function (h) {
      var line = el('label', 'inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-frosted-blue cursor-pointer');
      var box = el('input', 'size-4 rounded border-steel-blue/40 bg-transparent text-primary focus:ring-primary');
      box.type = 'checkbox';
      box.name = 'wikiEditHelp';
      box.value = h[0];
      box.checked = (initial.help_on || []).indexOf(h[0]) >= 0;
      box.addEventListener('change', mirror, { signal: vs });
      line.appendChild(box);
      line.appendChild(document.createTextNode(h[1]));
      // The other page's title goes in as text, never as markup.
      if (holders[h[0]]) line.appendChild(el('span', 'text-xs text-steel-blue', '(now on “' + holders[h[0]].title + '” — ticking moves it here)'));
      help.appendChild(line);
    });
    help.appendChild(el('p', 'text-xs text-steel-blue', 'A link to this page appears above that form once the page is published. Only one page can be linked in each place.'));
    form.appendChild(help);

    var contentWrap = el('div');
    var contentLabel = el('label', 'block text-xs font-bold uppercase tracking-wider text-steel-blue mb-1.5', 'Content');
    contentLabel.htmlFor = 'wikiEditContent';
    contentWrap.appendChild(contentLabel);
    contentWrap.appendChild(toolbar(vs));

    var ta = el('textarea', INPUT_CLS + ' font-mono text-sm leading-relaxed');
    ta.id = 'wikiEditContent';
    ta.rows = 22;
    ta.value = initial.content || '';
    ta.placeholder = 'Write in Markdown. Drop an image anywhere to upload it.';
    ta.addEventListener('input', mirror, { signal: vs });

    // Drag-drop and paste both upload, because both are how a screenshot arrives.
    ta.addEventListener('dragover', function (e) { e.preventDefault(); }, { signal: vs });
    // An image belongs to the editor it was dropped or pasted into: it lands
    // only in that session's form, while that session is the one showing, and
    // an upload in flight is unsaved work (holds).
    ta.addEventListener('drop', async function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault();
      var s = _session;
      status('Uploading image…');
      s.uploads += 1;
      try {
        var md = await uploadImage(files[0], vs);
        if (vs.aborted || _session !== s) return;
        insertAtCaret('\n' + md + '\n', s);
        status('Image added.');
      } catch (err) {
        if (!isAbort(err) && !vs.aborted && _session === s) status(err.message, 'bad');
      } finally {
        s.uploads -= 1;
      }
    }, { signal: vs });
    ta.addEventListener('paste', async function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          e.preventDefault();
          var s = _session;
          status('Uploading image…');
          s.uploads += 1;
          try {
            var md = await uploadImage(items[i].getAsFile(), vs);
            if (vs.aborted || _session !== s) return;
            insertAtCaret('\n' + md + '\n', s);
            status('Image added.');
          } catch (err) {
            if (!isAbort(err) && !vs.aborted && _session === s) status(err.message, 'bad');
          } finally {
            s.uploads -= 1;
          }
          return;
        }
      }
    }, { signal: vs });
    contentWrap.appendChild(ta);
    form.appendChild(contentWrap);

    // Preview. A live client-side preview would need a markdown library from a
    // CDN, which is both a new dependency and a CSP change; showing the real
    // server-rendered HTML after each save is honest and costs nothing.
    var prev = el('div', 'rounded-lg bg-baltic-blue/15 border border-steel-blue/25 p-4');
    prev.appendChild(el('p', 'text-xs font-bold uppercase tracking-wider text-steel-blue mb-2', 'Preview'));
    if (page && page.content_html) {
      var body = el('article', 'wiki-body text-frosted-blue');
      body.innerHTML = page.content_html;   // server-sanitized on write
      prev.appendChild(body);
      prev.appendChild(el('p', 'text-xs text-steel-blue mt-3',
        'This shows the last saved version. Save to refresh it.'));
    } else {
      prev.appendChild(el('p', 'text-sm text-steel-blue', 'The preview appears after the first save.'));
    }
    form.appendChild(prev);

    var actions = el('div', 'flex flex-wrap items-center gap-3 pt-2');
    var draftBtn = el('button', BTN_GHOST);
    draftBtn.type = 'button';
    draftBtn.appendChild(icon('save', 'text-base'));
    draftBtn.appendChild(document.createTextNode('Save draft'));
    draftBtn.addEventListener('click', function () { save(false); }, { signal: vs });

    var pubBtn = el('button', BTN_PRIMARY);
    pubBtn.type = 'button';
    pubBtn.appendChild(icon('publish', 'text-base'));
    pubBtn.appendChild(document.createTextNode('Publish'));
    pubBtn.addEventListener('click', function () { save(true); }, { signal: vs });

    var cancelBtn = el('button', BTN_QUIET, 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', close, { signal: vs });

    actions.appendChild(draftBtn);
    actions.appendChild(pubBtn);
    actions.appendChild(cancelBtn);

    if (_slug) {
      var delBtn = el('button', BTN_QUIET);
      delBtn.type = 'button';
      delBtn.appendChild(icon('delete', 'text-base'));
      delBtn.appendChild(document.createTextNode('Delete'));
      delBtn.addEventListener('click', remove, { signal: vs });
      actions.appendChild(delBtn);
    }
    form.appendChild(actions);

    var statusRow = el('div', 'flex items-center gap-3 min-h-[1.5rem]');
    var statusEl = el('p', 'text-sm text-steel-blue');
    statusEl.id = 'wikiEditStatus';
    statusEl.textContent = page
      ? (page.published ? 'This page is published.' : 'This page is a draft — only admins can see it.')
      : 'Not saved yet.';
    statusRow.appendChild(statusEl);

    var reauth = el('a', 'hidden text-sm font-bold text-frosted-blue underline', 'Open sign-in');
    reauth.id = 'wikiEditReauth';
    reauth.href = '/login';
    reauth.target = '_blank';
    reauth.rel = 'noopener';
    statusRow.appendChild(reauth);
    form.appendChild(statusRow);

    _root.appendChild(form);
    _session.form = form;
    // What the form opened with: any difference from it is unsaved text.
    _session.baseline = fingerprint(_session);
  }

  // ---------- leaving with unsaved text ----------

  function fingerprint(s) { return JSON.stringify(collect(s)); }

  // The editor is on screen with text that is not saved: changed since it
  // opened, a restored draft, a save or an image upload still in flight. Not once the admin
  // chose to go (closed) or agreed to leave (approved).
  function holds() {
    var s = _session;
    if (!s || !s.form || s.closed || s.approved || !s.form.isConnected) return false;
    return s.busy || s.uploads > 0 || !!s.restored || fingerprint(s) !== s.baseline;
  }

  // A pending mirror is written now, so the last keystrokes are in the draft.
  function flush() {
    if (!_mirrorTimer) return;
    clearTimeout(_mirrorTimer);
    _mirrorTimer = null;
    var s = _session;
    if (!s || !s.form) return;
    var fields = collect(s);
    fields.help_state = Object.assign({}, s.helpSeen);
    saveDraft(s.slug, fields);
  }

  // The wiki's leave guard (ctx.beforeLeave) and its claim ask this: true to
  // go, or the admin's answer. One question however many ways out are tried
  // while it is open. Leave approves this way out and writes the draft; the
  // editor stays until the page really changes, so a navigation that fails
  // and stays keeps it (and ws:nav-stayed takes the approval back).
  function canLeave() {
    if (!holds()) return true;
    var s = _session;
    if (!s.asking) {
      s.asking = window.WSUI.confirm({
        title: 'Leave without saving?',
        body: 'Your changes to this page aren’t saved. A copy stays on this device, and the editor offers it ' +
          (s.slug ? 'the next time you edit this page.' : 'the next time you start a new page.'),
        confirmLabel: 'Leave page', cancelLabel: 'Keep editing'
      }).catch(function (e) {
        if (window.console) console.error(e);
        return false;                   // a dialog that failed counts as Keep editing
      }).then(function (ok) {
        s.asking = null;
        if (ok && _session === s) {
          s.approved = true;
          flush();
        }
        return !!ok;
      });
    }
    return s.asking;
  }

  // Each visit to /wiki, from its mount. host: the wiki's view hooks —
  // isAdmin(), navigate(url), root() (#wikiRoot), view() (the signal of the
  // view on screen) and newView() (a fresh one, at the top of the page).
  function init(ctx, h) {
    signal = ctx.signal;
    host = h;
    _root = null;
    _session = null;
    // A reload or a closed tab: the last keystrokes reach the draft first
    // (pagehide as well, for a way out that asks nothing).
    window.addEventListener('beforeunload', function (e) {
      flush();
      if (holds()) { e.preventDefault(); e.returnValue = ''; }
    }, { signal: signal });
    window.addEventListener('pagehide', flush, { signal: signal });
    window.addEventListener('ws:nav-stayed', function () {
      if (_session) _session.approved = false;
    }, { signal: signal });
    // Leaving: the last keystrokes go to the draft, and the visit's nodes go.
    signal.addEventListener('abort', function () {
      flush();
      _root = null;
      _session = null;
      host = null;
    }, { once: true });
  }

  return { init: init, open: open, holds: holds, canLeave: canLeave };
})();
