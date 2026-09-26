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
 */
var WikiEditor = (function () {
  'use strict';

  var DRAFT_PREFIX = 'webservarr.wiki.draft.';
  var MIRROR_DEBOUNCE_MS = 500;

  var _root = null;
  var _mirrorTimer = null;
  var _slug = null;          // null while creating a new page
  var _slugTouched = false;  // once the author edits the slug, stop deriving it
  var _cats = [];
  var _session = null;       // the editor on screen: { slug, helpBase, form, busy }

  // The places a page can be linked as help, in the order the editor lists them.
  var HELP_PLACES = [['tickets', 'Tickets'], ['issues', 'Issues'], ['playback', 'Playback problems']];

  // Order-free comparison of two help lists.
  function helpKey(list) { return (list || []).slice().sort().join(','); }

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
  var BTN_PRIMARY = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-background-dark ' +
                    'text-sm font-bold hover:opacity-90 transition-all';
  var BTN_GHOST = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 text-primary ' +
                  'border border-primary/30 text-sm font-bold hover:bg-primary/20 transition-all';
  var BTN_QUIET = 'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-steel-blue ' +
                  'text-sm font-bold hover:text-frosted-blue transition-colors';

  function field(labelText, control, hint) {
    var wrap = el('div');
    wrap.appendChild(el('label', 'block text-xs font-bold uppercase tracking-wider text-steel-blue mb-1.5', labelText));
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

  async function fetchCategories() {
    try {
      var res = await fetch('/api/wiki/categories');
      if (!res.ok) return [];
      return await res.json();
    } catch (e) { return []; }
  }

  async function fetchPage(slug) {
    var res = await fetch('/api/wiki/pages/' + encodeURIComponent(slug));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function uploadImage(file) {
    var fd = new FormData();
    fd.append('file', file);
    var res = await fetch('/api/wiki/images', { method: 'POST', body: fd });
    if (!res.ok) {
      var body = await res.json().catch(function () { return {}; });
      throw new Error(typeof body.detail === 'string' ? body.detail : 'Upload failed');
    }
    var data = await res.json();
    return '![](' + data.url + ')';
  }

  function collect() {
    return {
      title: (document.getElementById('wikiEditTitle') || {}).value || '',
      slug: (document.getElementById('wikiEditSlug') || {}).value || '',
      summary: (document.getElementById('wikiEditSummary') || {}).value || '',
      content: (document.getElementById('wikiEditContent') || {}).value || '',
      category_slug: (document.getElementById('wikiEditCategory') || {}).value || null,
      sort_order: parseInt((document.getElementById('wikiEditSort') || {}).value, 10) || 0,
      help_on: Array.prototype.slice.call(document.querySelectorAll('input[name="wikiEditHelp"]'))
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
    var fields = collect();
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
        body: JSON.stringify(payload)
      });
    } catch (e) {
      // Network died. The text is still on screen and still mirrored. The
      // write may still have landed, so the prefetched pages go either way.
      clearPageCache();
      setBusy(s, false);
      if (_session === s) status('Could not reach the server. Your text is safe here — try again.', 'bad');
      return;
    }
    clearPageCache();

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

    if (!res.ok) {
      status('The save failed (HTTP ' + res.status + '). Your text is still here — try again.', 'bad');
      return;
    }

    var saved = await res.json();
    if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
    clearDraft(s.slug);
    clearDraft(null);
    status(publish ? 'Published.' : 'Saved as a draft.');

    // Land on the saved page so the author sees exactly what a reader will.
    WikiView.navigate('/wiki/' + encodeURIComponent(saved.slug));
  }

  async function remove() {
    var s = _session;
    if (!s || s.busy) return;
    if (!s.slug) { close(); return; }
    var ok = window.confirm('Delete this page? This cannot be undone.');
    if (!ok) return;
    setBusy(s, true);
    var res;
    try {
      res = await fetch('/api/wiki/pages/' + encodeURIComponent(s.slug), { method: 'DELETE' });
    } catch (e) {
      clearPageCache();
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
    if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
    clearDraft(s.slug);
    if (_session === s) WikiView.navigate('/wiki');
  }

  function close() {
    if (_slug) WikiView.navigate('/wiki/' + encodeURIComponent(_slug));
    else WikiView.navigate('/wiki');
  }

  // ---------- markdown toolbar ----------

  function wrapSelection(before, after, placeholder) {
    var ta = document.getElementById('wikiEditContent');
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

  function insertAtCaret(text) {
    var ta = document.getElementById('wikiEditContent');
    if (!ta) return;
    var start = ta.selectionStart;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(ta.selectionEnd);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + text.length;
    mirror();
  }

  function toolbar() {
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
      var btn = el('button', 'p-2 rounded text-steel-blue hover:text-primary hover:bg-primary/10 transition-colors');
      btn.type = 'button';
      btn.title = b[1];
      btn.setAttribute('aria-label', b[1]);
      btn.appendChild(icon(b[0], 'text-lg'));
      btn.addEventListener('click', b[2]);
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
      // help_base records the links the boxes started from, so a restore can
      // tell a change the admin made from boxes they never touched.
      var fields = collect();
      fields.help_base = s.helpBase.slice();
      saveDraft(s.slug, fields);
    }, MIRROR_DEBOUNCE_MS);
  }

  // ---------- open ----------

  async function open(slug) {
    if (!WikiView.isAdmin()) return;

    _slug = slug || null;
    _slugTouched = !!slug;
    if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }
    _root = document.getElementById('wikiRoot');
    if (!_root) return;

    var page = null;
    if (slug) {
      try { page = await fetchPage(slug); }
      catch (e) {
        // Stop here rather than falling through and loading `undefined` into the
        // fields — the News editor shipped exactly that bug once.
        window.alert('Could not load that page for editing.');
        return;
      }
    }

    _cats = await fetchCategories();

    var draft = loadDraft(_slug);
    var useDraft = false;
    if (draft && draft.fields) {
      var serverStamp = page && page.updated_at ? Date.parse(page.updated_at) : 0;
      var draftStamp = Date.parse(draft.at || '') || 0;
      var differs = !page || draft.fields.content !== page.content;
      if (differs && draftStamp > serverStamp) {
        useDraft = window.confirm(
          'You have unsaved changes from ' + new Date(draftStamp).toLocaleString() +
          '. Restore them?\n\nCancel keeps the saved version.');
        if (!useDraft) clearDraft(_slug);
      }
    }

    var helpBase = page ? (page.help_on || []).slice() : [];
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
      // A restored draft keeps its help boxes only where the admin changed
      // them before leaving. Boxes they never touched show the links as they
      // are now, so an old draft cannot quietly move a link back.
      var f = draft.fields;
      var touched = Array.isArray(f.help_on) && Array.isArray(f.help_base) &&
                    helpKey(f.help_on) !== helpKey(f.help_base);
      initial = Object.assign({}, f, { help_on: touched ? f.help_on.slice() : helpBase.slice() });
    }

    _session = { slug: _slug, helpBase: helpBase, form: null, busy: false };
    render(initial, page);
  }

  function render(initial, page) {
    while (_root.firstChild) _root.removeChild(_root.firstChild);
    window.scrollTo(0, 0);

    var head = el('div', 'mb-6');
    var backBtn = el('button', 'inline-flex items-center gap-1 text-xs font-bold text-steel-blue hover:text-primary transition-colors mb-3');
    backBtn.type = 'button';
    backBtn.appendChild(icon('chevron_left', 'text-sm'));
    backBtn.appendChild(document.createTextNode(_slug ? 'Back to the page' : 'Back to the wiki'));
    backBtn.addEventListener('click', close);
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
    });
    slugIn.addEventListener('input', function () { _slugTouched = true; mirror(); });

    var summary = el('input', INPUT_CLS);
    summary.id = 'wikiEditSummary';
    summary.type = 'text';
    summary.value = initial.summary || '';
    summary.placeholder = 'One line shown under the title in lists';
    summary.addEventListener('input', mirror);
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
    cat.addEventListener('change', mirror);
    row.appendChild(field('Category', cat));

    var sort = el('input', INPUT_CLS);
    sort.id = 'wikiEditSort';
    sort.type = 'number';
    sort.value = initial.sort_order || 0;
    sort.addEventListener('input', mirror);
    row.appendChild(field('Order', sort, 'Lower numbers appear first.'));
    form.appendChild(row);

    var help = el('fieldset', 'grid gap-2');
    help.appendChild(el('legend', 'block text-xs font-bold uppercase tracking-wider text-steel-blue mb-1.5', 'Show as help on'));
    var holders = (page && page.help_holders) || {};
    HELP_PLACES.forEach(function (h) {
      var line = el('label', 'inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-frosted-blue cursor-pointer');
      var box = el('input', 'size-4 rounded border-steel-blue/40 bg-transparent text-primary focus:ring-primary');
      box.type = 'checkbox';
      box.name = 'wikiEditHelp';
      box.value = h[0];
      box.checked = (initial.help_on || []).indexOf(h[0]) >= 0;
      box.addEventListener('change', mirror);
      line.appendChild(box);
      line.appendChild(document.createTextNode(h[1]));
      // The other page's title goes in as text, never as markup.
      if (holders[h[0]]) line.appendChild(el('span', 'text-xs text-steel-blue', '(now on “' + holders[h[0]] + '” — ticking moves it here)'));
      help.appendChild(line);
    });
    help.appendChild(el('p', 'text-xs text-steel-blue', 'A link to this page appears above that form. Only one page can be linked in each place.'));
    form.appendChild(help);

    var contentWrap = el('div');
    contentWrap.appendChild(el('label', 'block text-xs font-bold uppercase tracking-wider text-steel-blue mb-1.5', 'Content'));
    contentWrap.appendChild(toolbar());

    var ta = el('textarea', INPUT_CLS + ' font-mono text-sm leading-relaxed');
    ta.id = 'wikiEditContent';
    ta.rows = 22;
    ta.value = initial.content || '';
    ta.placeholder = 'Write in Markdown. Drop an image anywhere to upload it.';
    ta.addEventListener('input', mirror);

    // Drag-drop and paste both upload, because both are how a screenshot arrives.
    ta.addEventListener('dragover', function (e) { e.preventDefault(); });
    ta.addEventListener('drop', async function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault();
      status('Uploading image…');
      try {
        var md = await uploadImage(files[0]);
        insertAtCaret('\n' + md + '\n');
        status('Image added.');
      } catch (err) {
        status(err.message, 'bad');
      }
    });
    ta.addEventListener('paste', async function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          e.preventDefault();
          status('Uploading image…');
          try {
            var md = await uploadImage(items[i].getAsFile());
            insertAtCaret('\n' + md + '\n');
            status('Image added.');
          } catch (err) {
            status(err.message, 'bad');
          }
          return;
        }
      }
    });
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
    draftBtn.addEventListener('click', function () { save(false); });

    var pubBtn = el('button', BTN_PRIMARY);
    pubBtn.type = 'button';
    pubBtn.appendChild(icon('publish', 'text-base'));
    pubBtn.appendChild(document.createTextNode('Publish'));
    pubBtn.addEventListener('click', function () { save(true); });

    var cancelBtn = el('button', BTN_QUIET, 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', close);

    actions.appendChild(draftBtn);
    actions.appendChild(pubBtn);
    actions.appendChild(cancelBtn);

    if (_slug) {
      var delBtn = el('button', BTN_QUIET);
      delBtn.type = 'button';
      delBtn.appendChild(icon('delete', 'text-base'));
      delBtn.appendChild(document.createTextNode('Delete'));
      delBtn.addEventListener('click', remove);
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

    var reauth = el('a', 'hidden text-sm font-bold text-primary underline', 'Open sign-in');
    reauth.id = 'wikiEditReauth';
    reauth.href = '/login';
    reauth.target = '_blank';
    reauth.rel = 'noopener';
    statusRow.appendChild(reauth);
    form.appendChild(statusRow);

    _root.appendChild(form);
    _session.form = form;
  }

  return { open: open };
})();
