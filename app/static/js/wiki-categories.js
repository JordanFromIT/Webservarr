/**
 * WebServarr — wiki categories, managed on the wiki index (window.WikiCategories)
 *
 * Inline forms instead of the old chain of browser prompts. Deleting a
 * category never deletes its pages; they become uncategorised, and the
 * dialog says so.
 *
 * One panel is one snapshot of the category list. While any write from it is
 * in flight every control in it is disabled (and the "Manage categories"
 * toggle with it), so a second click can never act on a list the first one is
 * about to change. A write that lands hands onChanged a focus hint and the
 * page draws a fresh panel in its place; a write that fails re-enables this one.
 *
 * While an Edit or Add form is open, everything outside that form is disabled
 * too (the toggle included): any other write would redraw the panel and throw
 * away what the admin has typed. Cancel, or a save that lands, ends it.
 */
var WikiCategories = (function () {
  'use strict';

  var UI = window.WSUI, el = UI.el, icon = UI.icon, cls = UI.cls;
  var ICON_NAME = /^[a-z0-9_]{1,64}$/;   // the server enforces the same rule

  // Never rejects: a network failure answers as status 0. Every write clears
  // the prefetched pages whatever it answered, since a reorder can half-land.
  function send(method, url, body) {
    return fetch(url, {
      method: method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, ok: r.ok, data: d }; });
    }, function () {
      return { status: 0, ok: false, data: {} };
    }).then(function (res) {
      if (window.WS && WS.clearPageCache) WS.clearPageCache();
      return res;
    });
  }

  function problem(res) {
    var d = res.data && res.data.detail;
    if (d && typeof d === 'object' && !Array.isArray(d) && d.message) return d.message;
    if (typeof d === 'string') return d;
    if (res.status === 0) return 'Couldn’t reach the server. Check your connection and try again.';
    if (res.status === 422) return 'Check the name and icon, then try again.';
    return 'That didn’t work. Try again.';
  }

  // onSave(values) resolves to an error message to show, or null once the
  // panel has taken over (it is about to be redrawn).
  function form(cat, onSave, onCancel) {
    var f = el('form', 'grid gap-4 sm:grid-cols-2 p-4');
    function field(id, label, value, placeholder, full) {
      var box = el('div', full ? 'sm:col-span-2' : '');
      var i = el('input', cls.input);
      i.id = id;
      i.value = value || '';
      if (placeholder) i.placeholder = placeholder;
      var l = el('label', cls.label, label);
      l.htmlFor = id;
      box.appendChild(l);
      box.appendChild(i);
      f.appendChild(box);
      return i;
    }
    var key = cat ? cat.slug : 'new';
    var name = field('wikiCatName-' + key, 'Name', cat && cat.name, 'For example: Getting started');
    var iconIn = field('wikiCatIcon-' + key, 'Icon', cat && cat.icon, 'folder');
    var desc = field('wikiCatDesc-' + key, 'One-line description (optional)', cat && cat.description, '', true);
    var err = el('p', cls.error + ' hidden sm:col-span-2');
    err.setAttribute('role', 'alert');
    f.appendChild(err);
    var row = el('div', 'sm:col-span-2 flex flex-wrap gap-2');
    var save = el('button', cls.btnPrimary, cat ? 'Save category' : 'Add category');
    save.type = 'submit';
    var cancel = el('button', cls.btnQuiet, 'Cancel');
    cancel.type = 'button';
    row.appendChild(save);
    row.appendChild(cancel);
    f.appendChild(row);
    function fail(message, field) {
      err.textContent = message;
      err.classList.remove('hidden');
      field.focus();
    }
    cancel.addEventListener('click', onCancel);
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!name.value.trim()) { fail('Give the category a name.', name); return; }
      if (iconIn.value.trim() && !ICON_NAME.test(iconIn.value.trim())) {
        fail('Use an icon name like folder or play_circle.', iconIn);
        return;
      }
      err.classList.add('hidden');
      onSave({ name: name.value.trim(), description: desc.value.trim() || null, icon: iconIn.value.trim() || null })
        .then(function (message) { if (message) fail(message, name); });
    });
    setTimeout(function () { name.focus(); }, 30);
    return f;
  }

  // opts.focus: what to focus once drawn ({slug, what: 'up'|'down'|'edit'} or
  // {what: 'add'}). opts.lock: controls outside the panel to disable with it.
  function panel(categories, onChanged, opts) {
    opts = opts || {};
    var cats = (categories || []).slice().sort(function (a, b) {
      return (a.sort_order - b.sort_order) || a.name.localeCompare(b.name);
    });
    var locks = (opts.lock || []).filter(Boolean);
    var busy = false;
    var formOpen = null;   // the open Edit or Add form, if any
    var buttons = {};   // slug -> {up, down, edit}, for the focus hint

    var root = el('section', 'mb-8 rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04]');
    root.id = 'wikiCatPanel';
    root.setAttribute('aria-label', 'Manage categories');
    var head = el('div', 'flex items-center justify-between gap-3 p-4 border-b border-frosted-blue/10 flex-wrap');
    var ht = el('div', 'min-w-0');
    ht.appendChild(el('h2', 'text-[17px] font-bold text-frosted-blue', 'Categories'));
    ht.appendChild(el('p', 'text-[13px] text-frosted-blue/70', 'One level of grouping. Deleting a category never deletes its pages.'));
    head.appendChild(ht);
    var addBtn = el('button', cls.btnGhost);
    addBtn.type = 'button';
    addBtn.appendChild(icon('add', 'text-base'));
    addBtn.appendChild(document.createTextNode('Add category'));
    head.appendChild(addBtn);
    root.appendChild(head);
    var list = el('ul', 'divide-y divide-frosted-blue/10');
    root.appendChild(list);
    var addSlot = el('div');
    root.appendChild(addSlot);

    // Every control in the panel, and the locked ones outside it, from the
    // two gates: a write in flight turns everything off; an open form turns
    // off everything outside it. A button that is off for good (the first
    // row's "up") says so with data-fixed. Real `disabled`, so it is announced.
    function sync() {
      root.setAttribute('aria-busy', busy ? 'true' : 'false');
      Array.prototype.forEach.call(root.querySelectorAll('button, input'), function (n) {
        n.disabled = busy || n.hasAttribute('data-fixed') || (formOpen !== null && !formOpen.contains(n));
      });
      locks.forEach(function (n) { n.disabled = busy || formOpen !== null; });
    }

    function setBusy(on) {
      busy = on;
      sync();
    }

    function showForm(slot, f) {
      slot.replaceChildren(f);
      formOpen = f;
      sync();
    }

    function closeForm(slot, restore) {
      if (restore) slot.replaceChildren(restore);
      else slot.replaceChildren();
      formOpen = null;
      sync();
    }

    // The one way into a write: refuses while another is in flight.
    function begin() {
      if (busy) return false;
      setBusy(true);
      return true;
    }

    // A write landed: the panel stays disabled until the page replaces it.
    function done(focus) { onChanged(focus); }

    function body(cat) {
      return { name: cat.name, slug: cat.slug, description: cat.description || null, icon: cat.icon || null,
               sort_order: cat.sort_order };
    }

    // Looked up by slug at click time, never by an index captured when the
    // row was drawn.
    function move(slug, delta) {
      var from = -1;
      cats.forEach(function (c, i) { if (c.slug === slug) from = i; });
      var to = from + delta;
      if (from < 0 || to < 0 || to >= cats.length) return;
      if (formOpen || !begin()) return;
      // The new order is worked out on a copy: this panel's list only changes
      // by being redrawn from what the server says.
      var order = cats.slice();
      order.splice(to, 0, order.splice(from, 1)[0]);
      var writes = [];
      order.forEach(function (c, i) {
        var want = i * 10;
        if (c.sort_order !== want) {
          var b = body(c);
          b.sort_order = want;
          writes.push(send('PUT', '/api/wiki/categories/' + encodeURIComponent(c.slug), b));
        }
      });
      var focus = { slug: slug, what: delta < 0 ? 'up' : 'down' };
      Promise.all(writes).then(function (results) {
        var landed = results.filter(function (r) { return r.ok; }).length;
        if (landed === results.length) { done(focus); return; }
        UI.toast(landed ? 'The new order didn’t fully save. Try again.' : problem(results[0]), 'err');
        if (landed) done(focus);   // part of it landed: redraw from the server
        else setBusy(false);
      });
    }

    function row(cat, index) {
      var li = el('li');
      var line = el('div', 'flex items-center gap-3 p-3 flex-wrap');
      line.appendChild(icon(cat.icon || 'folder', 'text-[22px] text-frosted-blue/70'));
      var text = el('div', 'min-w-0 flex-1');
      text.appendChild(el('p', 'text-[15px] font-semibold text-frosted-blue break-words', cat.name));
      var count = cat.page_count === 1 ? '1 page' : cat.page_count + ' pages';
      if (cat.draft_count) count += ' · ' + cat.draft_count + ' draft' + (cat.draft_count === 1 ? '' : 's');
      text.appendChild(el('p', 'text-[13px] text-frosted-blue/45', count));
      line.appendChild(text);
      var tools = el('div', 'flex items-center gap-1');
      line.appendChild(tools);
      function btn(glyph, label, onClick, fixedOff) {
        var b = el('button', cls.btnQuiet + ' px-2 disabled:opacity-40 disabled:cursor-not-allowed');
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.title = label;
        if (fixedOff) b.setAttribute('data-fixed', '');
        b.disabled = !!fixedOff;
        b.appendChild(icon(glyph, 'text-[20px]'));
        b.addEventListener('click', onClick);
        tools.appendChild(b);
        return b;
      }
      var own = buttons[cat.slug] = {};
      own.up = btn('arrow_upward', 'Move ' + cat.name + ' up', function () { move(cat.slug, -1); }, index === 0);
      own.down = btn('arrow_downward', 'Move ' + cat.name + ' down', function () { move(cat.slug, 1); },
        index === cats.length - 1);
      own.edit = btn('edit', 'Edit ' + cat.name, function () {
        if (busy || formOpen) return;
        showForm(li, form(cat, function (values) {
          if (!begin()) return Promise.resolve(null);
          var payload = body(cat);
          payload.name = values.name;
          payload.description = values.description;
          payload.icon = values.icon;
          // payload.slug stays cat.slug: renaming a category never changes its address.
          return send('PUT', '/api/wiki/categories/' + encodeURIComponent(cat.slug), payload).then(function (res) {
            if (!res.ok) { setBusy(false); return problem(res); }
            UI.toast('Category saved.', 'ok');
            done({ slug: (res.data && res.data.slug) || cat.slug, what: 'edit' });
            return null;
          });
        }, function () {
          closeForm(li, line);
          own.edit.focus();
        }));
      });
      btn('delete', 'Delete ' + cat.name, function () {
        if (busy || formOpen) return;
        var n = cat.page_count + (cat.draft_count || 0);
        UI.confirm({
          title: 'Delete “' + cat.name + '”?',
          body: n ? 'Its ' + n + ' page' + (n === 1 ? '' : 's') + ' will become uncategorised. No pages are deleted.'
                  : 'This category has no pages.',
          confirmLabel: 'Delete category', cancelLabel: 'Keep it', danger: true
        }).then(function (ok) {
          if (!ok || !begin()) return;
          send('DELETE', '/api/wiki/categories/' + encodeURIComponent(cat.slug)).then(function (res) {
            if (!res.ok) { setBusy(false); UI.toast(problem(res), 'err'); return; }
            UI.toast('Category deleted.', 'ok');
            done({ what: 'add' });
          });
        });
      });
      li.appendChild(line);
      return li;
    }

    if (!cats.length) {
      list.appendChild(el('li', 'p-4 text-[13px] text-frosted-blue/70',
        'No categories yet. Pages without one appear under “Uncategorised”.'));
    }
    cats.forEach(function (c, i) { list.appendChild(row(c, i)); });

    addBtn.addEventListener('click', function () {
      if (busy || formOpen) return;
      showForm(addSlot, form(null, function (values) {
        if (!begin()) return Promise.resolve(null);
        values.sort_order = cats.length ? cats[cats.length - 1].sort_order + 10 : 0;
        return send('POST', '/api/wiki/categories', values).then(function (res) {
          if (!res.ok) { setBusy(false); return problem(res); }
          UI.toast('Category added.', 'ok');
          done({ slug: res.data && res.data.slug, what: 'edit' });
          return null;
        });
      }, function () {
        closeForm(addSlot);
        addBtn.focus();
      }));
    });

    // Focus lands once the page has put the panel in the document. A moved
    // row at the top or bottom has lost that arrow, so it takes the other one.
    var hint = opts.focus;
    if (hint) {
      setTimeout(function () {
        var own = hint.slug && buttons[hint.slug];
        var target = hint.what === 'add' || !own ? addBtn : own[hint.what];
        if (target && target.disabled && own) target = hint.what === 'up' ? own.down : own.up;
        if (target && target.disabled) target = addBtn;
        if (target && document.contains(target)) target.focus();
      }, 0);
    }
    return root;
  }

  return { panel: panel };
})();
