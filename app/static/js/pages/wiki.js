/**
 * WebServarr — Wiki (page module)
 *
 * One page serving four views: the index, a category, search results and an
 * article. Moving between them swaps only #wikiRoot, so the page is never
 * mounted again for its own links.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. The page claims its own addresses (/wiki, /wiki?q=,
 * /wiki?category=, /wiki/<slug>) with ctx.onNavigate: a wiki link, the search
 * box, Back and Forward between wiki entries reach the router, which records
 * history and hands the URL to render() here instead of fetching and
 * mounting. This file writes no history of its own.
 *
 * Each view has its own AbortController under the visit's signal: drawing
 * the next view ends the last one's listeners and cancels its reads, so a
 * long read of the wiki keeps no dead views alive and a late answer never
 * paints over the view that replaced it.
 *
 * Admins' tools are page helpers (spec 4.3, data-ws-page-script), started
 * from mount with the same ctx: wiki-categories.js (the index's category
 * panel) and wiki-editor.js (the editor, drawn as a view of its own). While
 * the editor holds unsaved text the claim declines, so the router asks the
 * leave guard (ctx.beforeLeave, answered by the editor) before any way out,
 * an article link included.
 */

function isAbort(e) { return !!e && e.name === 'AbortError'; }

// /wiki, /wiki/ and /wiki/<slug>: the addresses this page draws itself.
function isWikiPath(path) {
  return path === '/wiki' || path.startsWith('/wiki/');
}

function parse(url) {
  var path = url.pathname.replace(/\/+$/, '');
  var params = url.searchParams;
  var q = (params.get('q') || '').trim();
  var cat = (params.get('category') || '').trim();
  if (path === '/wiki' || path === '') {
    if (q) return { view: 'search', q: q };
    if (cat) return { view: 'category', slug: cat };
    return { view: 'index' };
  }
  var slug = path.replace(/^\/wiki\//, '');
  try { slug = decodeURIComponent(slug); } catch (e) { /* keep it raw */ }
  return { view: 'page', slug: slug };
}

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

function dateLabel(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildToc(bodyEl) {
  var heads = bodyEl.querySelectorAll('h2, h3');
  if (heads.length < 3) return null;   // a one- or two-item TOC is noise
  var items = [];
  Array.prototype.forEach.call(heads, function (h, i) {
    var id = 'h-' + i + '-' + (h.textContent || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    h.id = id;
    items.push({ id: id, text: h.textContent, level: h.tagName === 'H3' ? 3 : 2 });
  });
  return items;
}

function tocNode(items) {
  var nav = el('nav', 'text-sm');
  nav.appendChild(el('p', 'text-xs font-bold uppercase tracking-wider text-steel-blue mb-2', 'On this page'));
  var ul = el('ul', 'space-y-1.5 border-l border-steel-blue/30 pl-3');
  items.forEach(function (it) {
    var li = el('li', it.level === 3 ? 'pl-3' : '');
    var a = el('a', 'text-steel-blue hover:text-frosted-blue transition-colors block', it.text);
    a.href = '#' + it.id;
    li.appendChild(a);
    ul.appendChild(li);
  });
  nav.appendChild(ul);
  return nav;
}

function snippetNode(item) {
  // Built from text nodes and a <mark>, never innerHTML: the snippet is raw
  // page source and must never be interpreted as markup.
  var p = el('p', 'text-sm text-steel-blue mt-1');
  var text = item.snippet || '';
  var off = item.match_offset || 0;
  var len = item.match_length || 0;
  if (!len || off < 0 || off + len > text.length) {
    p.textContent = text;
    return p;
  }
  p.appendChild(document.createTextNode(text.slice(0, off)));
  var hit = el('span', 'wiki-hit', text.slice(off, off + len));
  p.appendChild(hit);
  p.appendChild(document.createTextNode(text.slice(off + len)));
  return p;
}

// Phones scroll the document; from lg #wsPage scrolls itself (<main> is one
// screen tall on every page). The same choice the router makes for its own
// scroll handling.
function scroller(page) {
  var main = page ? page.closest('main') : null;
  var list = [main, page].concat(page ? Array.prototype.slice.call(page.children) : []);
  for (var i = 0; i < list.length; i++) {
    if (!list[i]) continue;
    var oy = getComputedStyle(list[i]).overflowY;
    if (oy === 'auto' || oy === 'scroll') return list[i];
  }
  return document.scrollingElement || document.documentElement;
}

export async function mount(ctx) {
  var signal = ctx.signal;
  var root = ctx.root.querySelector('#wikiRoot');
  var _user = ctx.data && ctx.data.user;

  var _cats = null;   // cached category list; invalidated on every write
  // Bumped by every view render. An index load that answers after a newer
  // render started is dropped, so it can never paint over what replaced it.
  var _gen = 0;
  // Whether the category panel is open. It survives the panel's own redraws
  // (after each category write) and closes on any navigation.
  var _manage = false;
  // The view on screen: its listeners and reads end when the next is drawn.
  var _view = null;

  // ---------- helpers ----------

  function isAdmin() { return !!(_user && _user.is_admin); }

  // A fresh view: the last one's listeners and reads end now. Under the
  // visit's signal, so leaving the page ends it too.
  function newView() {
    if (_view) _view.abort();
    var v = _view = new AbortController();
    if (signal.aborted) v.abort();
    else signal.addEventListener('abort', function () { v.abort(); }, { once: true, signal: v.signal });
    return v.signal;
  }

  function toTop() {
    window.scrollTo(0, 0);
    scroller(ctx.root).scrollTop = 0;
  }

  // Back or Forward: the position that entry saved. The article may still be
  // growing (images), so try for a few frames; never into the next view.
  function restoreScroll(y) {
    y = y || 0;
    var frames = 0;
    var gen = _gen;
    (function step() {
      if (signal.aborted || gen !== _gen) return;
      var box = scroller(ctx.root);
      box.scrollTop = y;
      if (Math.abs(box.scrollTop - y) > 1 && ++frames < 30) requestAnimationFrame(step);
    })();
  }

  function scrollToHash(url) {
    if (!url.hash || url.hash.length < 2) return;
    var id = url.hash.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* keep it raw */ }
    var target = document.getElementById(id);
    if (target && root.contains(target)) target.scrollIntoView();
  }

  // After a navigation, focus goes to the new view's heading, as the router
  // does for a page it swaps in; unless the visitor has already moved it.
  function focusHeading(from) {
    var h1 = root.querySelector('h1');
    if (!h1) return;
    var now = document.activeElement;
    if (now && now !== document.body && now !== from && !root.contains(now)) return;
    if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
  }

  function navigate(url) {
    return WS.router.navigate(new URL(url, location.href).href);
  }

  async function api(path, vs) {
    var res = await fetch(path, { signal: vs });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('unauthenticated'); }
    if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  function clear() { while (root.firstChild) root.removeChild(root.firstChild); }

  function skeleton(kind) {
    clear();
    var wrap = el('div');
    if (kind === 'page') {
      wrap.appendChild(el('div', 'wiki-skel h-8 w-2/3 mb-3'));
      wrap.appendChild(el('div', 'wiki-skel h-4 w-40 mb-8'));
      for (var i = 0; i < 6; i++) {
        wrap.appendChild(el('div', 'wiki-skel h-4 w-full mb-3'));
      }
    } else {
      wrap.appendChild(el('div', 'wiki-skel h-8 w-48 mb-3'));
      wrap.appendChild(el('div', 'wiki-skel h-12 w-full mb-8'));
      var grid = el('div', 'grid gap-4 sm:grid-cols-2');
      for (var j = 0; j < 4; j++) grid.appendChild(el('div', 'wiki-skel h-28'));
      wrap.appendChild(grid);
    }
    root.appendChild(wrap);
  }

  // ---------- shared chrome ----------

  function pageHeader(titleText, subtitleText, backHref, backText) {
    var head = el('div', 'mb-6');
    var back = el('a', 'inline-flex items-center gap-1 text-xs font-bold text-steel-blue hover:text-frosted-blue transition-colors mb-3');
    back.href = backHref || '/';
    back.appendChild(icon('chevron_left', 'text-sm'));
    back.appendChild(document.createTextNode(backText || 'Back to home'));
    head.appendChild(back);

    var row = el('div', 'flex items-center gap-3');
    row.appendChild(icon('library_books', 'text-steel-blue text-3xl'));
    var col = el('div', 'min-w-0');
    col.appendChild(el('h1', 'text-2xl lg:text-3xl font-bold text-frosted-blue leading-tight', titleText));
    if (subtitleText) col.appendChild(el('p', 'text-sm text-steel-blue mt-0.5', subtitleText));
    row.appendChild(col);
    head.appendChild(row);
    return head;
  }

  function searchBox(initial, vs) {
    var form = el('form', 'relative mb-8');
    var input = el('input',
      'w-full pl-11 pr-4 py-3 rounded-lg bg-baltic-blue/20 border border-steel-blue/30 ' +
      'text-frosted-blue placeholder:text-steel-blue focus:border-primary focus:ring-0 transition-colors');
    input.type = 'search';
    input.name = 'q';
    input.placeholder = 'Search the wiki…';
    input.value = initial || '';
    input.setAttribute('aria-label', 'Search the wiki');
    var mag = icon('search', 'text-steel-blue absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none');
    form.appendChild(mag);
    form.appendChild(input);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var term = input.value.trim();
      navigate(term ? '/wiki?q=' + encodeURIComponent(term) : '/wiki');
    }, { signal: vs });
    return form;
  }

  function adminBar(onNew, onManage, vs) {
    if (!isAdmin()) return null;
    var bar = el('div', 'flex flex-wrap justify-end gap-2 mb-4');
    function button(glyph, label, handler, primary) {
      var btn = el('button', primary
        ? 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/15 text-frosted-blue border border-primary/30 text-sm font-bold hover:bg-primary/25 transition-all'
        : 'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-frosted-blue/70 border border-frosted-blue/10 text-sm font-bold hover:text-frosted-blue hover:bg-frosted-blue/[0.06] transition-all disabled:opacity-50 disabled:cursor-not-allowed');
      btn.type = 'button';
      btn.appendChild(icon(glyph, 'text-base'));
      btn.appendChild(document.createTextNode(label));
      btn.addEventListener('click', handler, { signal: vs });
      bar.appendChild(btn);
      return btn;
    }
    if (onManage) {
      var manage = button('category', 'Manage categories', onManage, false);
      manage.setAttribute('data-wiki-manage', '');
      manage.setAttribute('aria-controls', 'wikiCatPanel');
      manage.setAttribute('aria-expanded', _manage ? 'true' : 'false');
    }
    button('add', 'New page', onNew, true);
    return bar;
  }

  function emptyState(iconName, title, detail) {
    var box = el('div', 'text-center text-steel-blue py-12');
    box.appendChild(icon(iconName, 'text-4xl mb-2 block opacity-50'));
    box.appendChild(el('p', 'text-frosted-blue font-bold', title));
    if (detail) box.appendChild(el('p', 'text-sm mt-1', detail));
    return box;
  }

  // The editor, awaited: work it does after its own awaits then still traces
  // back to this page (the leak checker's stacks, in debug mode).
  async function openEditor(slug) {
    await WikiEditor.open(slug);
  }

  // ---------- index ----------

  // A plain link: the router hands it back to render() through the claim.
  function categoryCard(cat) {
    var a = el('a',
      'group flex flex-col gap-2 p-5 rounded-xl bg-baltic-blue/20 border border-steel-blue/30 ' +
      'hover:border-primary/50 hover:bg-baltic-blue/30 transition-all');
    a.href = '/wiki?category=' + encodeURIComponent(cat.slug);

    var top = el('div', 'flex items-center gap-3');
    top.appendChild(icon(cat.icon || 'folder', 'text-steel-blue group-hover:text-frosted-blue transition-colors'));
    top.appendChild(el('h2', 'font-bold text-frosted-blue', cat.name));
    a.appendChild(top);

    if (cat.description) a.appendChild(el('p', 'text-sm text-steel-blue', cat.description));

    var count = cat.page_count === 1 ? '1 page' : cat.page_count + ' pages';
    if (cat.draft_count) count += ' · ' + cat.draft_count + ' draft' + (cat.draft_count === 1 ? '' : 's');
    a.appendChild(el('p', 'text-xs text-steel-blue mt-auto pt-1', count));
    return a;
  }

  function pageRow(page, showCategory) {
    var a = el('a',
      'flex items-start gap-3 p-4 rounded-lg bg-baltic-blue/15 border border-steel-blue/25 ' +
      'hover:border-primary/50 hover:bg-baltic-blue/25 transition-all');
    a.href = '/wiki/' + encodeURIComponent(page.slug);
    a.appendChild(icon('description', 'text-steel-blue shrink-0'));

    var col = el('div', 'min-w-0 flex-1');
    var titleRow = el('div', 'flex items-center gap-2 flex-wrap');
    titleRow.appendChild(el('span', 'font-bold text-frosted-blue', page.title));
    if (!page.published) {
      titleRow.appendChild(el('span',
        'text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-steel-blue/25 text-frosted-blue/80',
        'Draft'));
    }
    col.appendChild(titleRow);
    if (page.summary) col.appendChild(el('p', 'text-sm text-steel-blue mt-0.5', page.summary));
    if (showCategory && page.category_name) {
      col.appendChild(el('p', 'text-xs text-steel-blue mt-1', page.category_name));
    }
    a.appendChild(col);
    return a;
  }

  // keep: redraw in place after a category write - no skeleton, no scroll,
  // the panel reopened with focus where the hint says.
  async function renderIndex(keep, focus) {
    var gen = ++_gen;
    if (!keep) skeleton('index');
    var vs = newView();
    var results;
    try {
      results = await Promise.all([
        api('/api/wiki/categories', vs),
        api('/api/wiki/pages?include_drafts=' + (isAdmin() ? 'true' : 'false') + '&limit=200', vs)
      ]);
    } catch (e) {
      if (gen !== _gen) return;
      if (vs.aborted || isAbort(e) || e.message === 'unauthenticated') return;
      clear();
      root.appendChild(pageHeader('Wiki', null, '/', 'Back to home'));
      root.appendChild(emptyState('cloud_off', "The wiki didn't load",
        'Reload the page. If it keeps happening, the server may be restarting.'));
      return 'Wiki';
    }

    if (gen !== _gen) return;
    _cats = results[0];
    var pages = results[1];

    clear();
    root.appendChild(pageHeader('Wiki', 'Guides and how-tos for the whole setup.', '/', 'Back to home'));
    root.appendChild(searchBox('', vs));

    var catPanel = null;
    var bar = adminBar(function () {
      openEditor(null);
    }, function () {
      _manage = !catPanel;
      if (catPanel) { catPanel.remove(); catPanel = null; }
      else openPanel(null);
      manageBtn.setAttribute('aria-expanded', _manage ? 'true' : 'false');
    }, vs);
    var manageBtn = bar && bar.querySelector('[data-wiki-manage]');
    function openPanel(hint) {
      catPanel = WikiCategories.panel(_cats, function (next) {
        // A category write landed. Redraw the index in place with the panel
        // still open - unless the admin has since moved to another view.
        _cats = null;
        if (gen === _gen) renderIndex(true, next);
      }, { focus: hint, lock: [manageBtn], signal: vs });
      bar.parentNode.insertBefore(catPanel, bar.nextSibling);
    }
    if (bar) {
      root.appendChild(bar);
      if (_manage) openPanel(focus || null);
    }

    if (!_cats.length && !pages.length) {
      root.appendChild(emptyState('menu_book', 'The wiki is empty',
        isAdmin() ? 'Use New page above to write the first guide.'
                  : 'Nothing has been written here yet.'));
      return 'Wiki';
    }

    if (_cats.length) {
      var grid = el('div', 'grid gap-4 sm:grid-cols-2 mb-8');
      _cats.forEach(function (c) { grid.appendChild(categoryCard(c)); });
      root.appendChild(grid);
    }

    var loose = pages.filter(function (p) { return !p.category_slug; });
    if (loose.length) {
      root.appendChild(el('h2', 'text-sm font-bold uppercase tracking-wider text-steel-blue mb-3',
        _cats.length ? 'Uncategorised' : 'Pages'));
      var list = el('div', 'grid gap-2 mb-8');
      loose.forEach(function (p) { list.appendChild(pageRow(p, false)); });
      root.appendChild(list);
    }

    var recent = pages.slice().sort(function (a, b) {
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    }).slice(0, 5);
    if (recent.length && _cats.length) {
      root.appendChild(el('h2', 'text-sm font-bold uppercase tracking-wider text-steel-blue mb-3',
        'Recently updated'));
      var rlist = el('div', 'grid gap-2');
      recent.forEach(function (p) { rlist.appendChild(pageRow(p, true)); });
      root.appendChild(rlist);
    }
    return 'Wiki';
  }

  // ---------- category ----------

  async function renderCategory(slug) {
    _gen += 1;
    var gen = _gen;
    skeleton('index');
    var vs = newView();
    var pages, cats;
    try {
      cats = _cats || await api('/api/wiki/categories', vs);
      _cats = cats;
      pages = await api('/api/wiki/pages?category=' + encodeURIComponent(slug) +
                        '&include_drafts=' + (isAdmin() ? 'true' : 'false') + '&limit=200', vs);
    } catch (e) {
      if (gen !== _gen || vs.aborted || isAbort(e) || e.message === 'unauthenticated') return;
      clear();
      root.appendChild(pageHeader('Wiki', null, '/wiki', 'Back to the wiki'));
      root.appendChild(emptyState('folder_off', 'That category doesn’t exist',
        'It may have been renamed or removed.'));
      return 'Wiki';
    }
    if (gen !== _gen || vs.aborted) return;

    var cat = cats.filter(function (c) { return c.slug === slug; })[0];
    clear();
    root.appendChild(pageHeader(cat ? cat.name : 'Category',
      cat && cat.description ? cat.description : null, '/wiki', 'Back to the wiki'));
    root.appendChild(searchBox('', vs));

    if (!pages.length) {
      root.appendChild(emptyState('description', 'No pages here yet',
        isAdmin() ? 'Create one from the wiki index.' : null));
    } else {
      var list = el('div', 'grid gap-2');
      pages.forEach(function (p) { list.appendChild(pageRow(p, false)); });
      root.appendChild(list);
    }
    return cat ? cat.name : 'Wiki';
  }

  // ---------- search ----------

  async function renderSearch(term) {
    _gen += 1;
    var gen = _gen;
    skeleton('index');
    var vs = newView();
    var results;
    try {
      results = await api('/api/wiki/pages?q=' + encodeURIComponent(term) +
                          '&include_drafts=' + (isAdmin() ? 'true' : 'false') + '&limit=100', vs);
    } catch (e) {
      if (gen !== _gen || vs.aborted || isAbort(e) || e.message === 'unauthenticated') return;
      results = [];
    }
    if (gen !== _gen || vs.aborted) return;

    clear();
    root.appendChild(pageHeader('Search', results.length
      ? results.length + (results.length === 1 ? ' result' : ' results') + ' for “' + term + '”'
      : null, '/wiki', 'Back to the wiki'));
    root.appendChild(searchBox(term, vs));

    if (!results.length) {
      root.appendChild(emptyState('search_off', 'Nothing matched “' + term + '”',
        'Try a single word, or browse the categories below.'));
      if (_cats && _cats.length) {
        var grid = el('div', 'grid gap-4 sm:grid-cols-2 mt-6');
        _cats.forEach(function (c) { grid.appendChild(categoryCard(c)); });
        root.appendChild(grid);
      } else {
        api('/api/wiki/categories', vs).then(function (cats) {
          _cats = cats;
          if (!cats.length) return;
          var g = el('div', 'grid gap-4 sm:grid-cols-2 mt-6');
          cats.forEach(function (c) { g.appendChild(categoryCard(c)); });
          root.appendChild(g);
        }).catch(function () {});
      }
      return 'Search';
    }

    var list = el('div', 'grid gap-2');
    results.forEach(function (item) {
      var a = el('a',
        'block p-4 rounded-lg bg-baltic-blue/15 border border-steel-blue/25 ' +
        'hover:border-primary/50 hover:bg-baltic-blue/25 transition-all');
      a.href = '/wiki/' + encodeURIComponent(item.slug);

      var row = el('div', 'flex items-center gap-2 flex-wrap');
      row.appendChild(el('span', 'font-bold text-frosted-blue', item.title));
      if (item.category_name) {
        row.appendChild(el('span', 'text-xs text-steel-blue', item.category_name));
      }
      if (item.matched_in === 'body') {
        row.appendChild(el('span',
          'text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-steel-blue/25 text-frosted-blue/80',
          'in body'));
      }
      if (!item.published) {
        row.appendChild(el('span',
          'text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-steel-blue/25 text-frosted-blue/80',
          'Draft'));
      }
      a.appendChild(row);
      a.appendChild(snippetNode(item));
      list.appendChild(a);
    });
    root.appendChild(list);
    return 'Search';
  }

  // ---------- single page ----------

  async function renderPage(slug) {
    _gen += 1;
    var gen = _gen;
    skeleton('page');
    var vs = newView();
    var page;
    try {
      page = await api('/api/wiki/pages/' + encodeURIComponent(slug), vs);
    } catch (e) {
      if (gen !== _gen || vs.aborted || isAbort(e) || e.message === 'unauthenticated') return;
      clear();
      root.appendChild(pageHeader('Wiki', null, '/wiki', 'Back to the wiki'));
      root.appendChild(emptyState('find_in_page', 'That page doesn’t exist',
        'It may have been renamed or removed. Try searching for it.'));
      root.appendChild(searchBox('', vs));
      api('/api/wiki/categories', vs).then(function (cats) {
        _cats = cats;
        if (!cats.length) return;
        var g = el('div', 'grid gap-4 sm:grid-cols-2');
        cats.forEach(function (c) { g.appendChild(categoryCard(c)); });
        root.appendChild(g);
      }).catch(function () {});
      return 'Wiki';
    }
    if (gen !== _gen || vs.aborted) return;

    clear();

    var backHref = page.category_slug ? '/wiki?category=' + encodeURIComponent(page.category_slug) : '/wiki';
    var backText = page.category_name ? 'Back to ' + page.category_name : 'Back to the wiki';

    var head = el('div', 'mb-6');
    var back = el('a', 'inline-flex items-center gap-1 text-xs font-bold text-steel-blue hover:text-frosted-blue transition-colors mb-3');
    back.href = backHref;
    back.appendChild(icon('chevron_left', 'text-sm'));
    back.appendChild(document.createTextNode(backText));
    head.appendChild(back);

    var titleRow = el('div', 'flex items-start justify-between gap-4 flex-wrap');
    var titleCol = el('div', 'min-w-0');
    var h1Row = el('div', 'flex items-center gap-2 flex-wrap');
    h1Row.appendChild(el('h1', 'text-2xl lg:text-3xl font-bold text-frosted-blue leading-tight', page.title));
    if (!page.published) {
      h1Row.appendChild(el('span',
        'text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-steel-blue/25 text-frosted-blue/80',
        'Draft'));
    }
    titleCol.appendChild(h1Row);
    var meta = 'Last updated ' + dateLabel(page.updated_at);
    titleCol.appendChild(el('p', 'text-sm text-steel-blue mt-1', meta));
    titleRow.appendChild(titleCol);

    if (isAdmin()) {
      var editBtn = el('button',
        'shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/15 text-frosted-blue ' +
        'border border-primary/30 text-sm font-bold hover:bg-primary/25 transition-all');
      editBtn.type = 'button';
      editBtn.appendChild(icon('edit', 'text-base'));
      editBtn.appendChild(document.createTextNode('Edit this page'));
      editBtn.addEventListener('click', function () {
        openEditor(page.slug);
      }, { signal: vs });
      titleRow.appendChild(editBtn);
    }
    head.appendChild(titleRow);
    root.appendChild(head);

    // The shipped example page says so, to admins only — a member has no way to
    // act on it and no reason to distrust the content.
    if (page.is_example && isAdmin()) {
      var banner = el('div',
        'flex items-start gap-3 p-4 rounded-lg bg-baltic-blue/25 border border-steel-blue/40 mb-6');
      banner.appendChild(icon('info', 'text-steel-blue shrink-0'));
      banner.appendChild(el('p', 'text-sm text-steel-blue',
        'This is an example page shipped with WebServarr. Edit it or delete it.'));
      root.appendChild(banner);
    }

    var layout = el('div', 'lg:flex lg:gap-10 lg:items-start');
    var bodyWrap = el('div', 'min-w-0 flex-1');
    var body = el('article', 'wiki-body text-frosted-blue');
    body.innerHTML = page.content_html || '';   // server-sanitized on write
    bodyWrap.appendChild(body);

    var toc = buildToc(body);
    if (toc) {
      var aside = el('aside', 'hidden lg:block lg:w-56 lg:shrink-0 lg:sticky lg:top-8');
      aside.appendChild(tocNode(toc));
      layout.appendChild(bodyWrap);
      layout.appendChild(aside);

      var details = el('details', 'lg:hidden mb-6 rounded-lg bg-baltic-blue/20 border border-steel-blue/30 p-4');
      var summary = el('summary', 'text-sm font-bold text-frosted-blue cursor-pointer', 'On this page');
      details.appendChild(summary);
      var inner = tocNode(toc);
      inner.className = 'text-sm mt-3';
      details.appendChild(inner);
      root.appendChild(details);
    } else {
      layout.appendChild(bodyWrap);
    }
    root.appendChild(layout);

    if (page.siblings && page.siblings.length) {
      var more = el('div', 'mt-10 pt-6 border-t border-steel-blue/25');
      more.appendChild(el('h2', 'text-sm font-bold uppercase tracking-wider text-steel-blue mb-3',
        'More in ' + (page.category_name || 'this category')));
      var list = el('div', 'grid gap-2');
      page.siblings.forEach(function (s) {
        var a = el('a',
          'flex items-center gap-3 p-3 rounded-lg bg-baltic-blue/15 border border-steel-blue/25 ' +
          'hover:border-primary/50 transition-all');
        a.href = '/wiki/' + encodeURIComponent(s.slug);
        a.appendChild(icon('description', 'text-steel-blue shrink-0'));
        a.appendChild(el('span', 'text-frosted-blue', s.title));
        list.appendChild(a);
      });
      more.appendChild(list);
      root.appendChild(more);
    }
    return page.title;
  }

  // ---------- routing ----------

  // Draws the view for url. how: { first } the mount's own render (the
  // router scrolls it); { pop, scrollY } Back or Forward to a wiki entry;
  // { focus, from } the heading takes focus once drawn, unless the visitor
  // moved it away from `from` meanwhile. A new view starts at the top.
  // Resolves to the drawn view's name (its title), or null once another view
  // has replaced it.
  function render(url, how) {
    var s = parse(url);
    _manage = false;
    how = how || {};
    if (!how.first && !how.pop) toTop();
    var drawn;
    if (s.view === 'index') drawn = renderIndex();
    else if (s.view === 'search') drawn = renderSearch(s.q);
    else if (s.view === 'category') drawn = renderCategory(s.slug);
    else drawn = renderPage(s.slug);
    var gen = _gen;
    return drawn.then(function (name) {
      if (gen !== _gen || signal.aborted) return null;   // another view has replaced it
      if (how.pop) restoreScroll(how.scrollY);
      else if (!how.first) scrollToHash(url);
      if (how.focus) focusHeading(how.from);
      return name || null;
    });
  }

  // What the editor needs of this page: whether the visitor is an admin, the
  // way to move on, #wikiRoot, and views of its own (see newView).
  WikiCategories.init(ctx);
  WikiEditor.init(ctx, {
    isAdmin: isAdmin,
    navigate: navigate,
    root: function () { return root; },
    view: function () { return _view ? _view.signal : newView(); },
    newView: function () {
      _gen += 1;
      _manage = false;
      var vs = newView();
      toTop();
      return vs;
    }
  });

  // Any way out of the page (a link, Back, Forward, navigate()) while the
  // editor holds unsaved text asks first.
  ctx.beforeLeave(function () { return WikiEditor.canLeave(); });

  // The wiki's own addresses are drawn here; the router records history,
  // and titles and announces the view with the name render() resolves to.
  // Not while the editor holds unsaved text: the router then asks the guard
  // above, and on Leave loads the address as a new visit.
  ctx.onNavigate(function (url, how) {
    if (!isWikiPath(url.pathname)) return false;
    if (WikiEditor.holds()) return false;
    return render(url, {
      pop: !!(how && how.pop), scrollY: how && how.scrollY,
      focus: true, from: document.activeElement
    });
  });

  // A soft navigation in focused the page's heading (the skeleton's);
  // the drawn view's takes it over. A cold load leaves focus alone.
  var arrivedFocused = ctx.root.contains(document.activeElement);
  var name = await render(ctx.url, { first: true, focus: arrivedFocused, from: document.activeElement });
  if (name && !signal.aborted) ctx.setTitle(name);
}
