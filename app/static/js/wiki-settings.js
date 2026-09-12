/**
 * WebServarr — Settings > Wiki tab
 *
 * Categories and contextual links only. Wiki pages are written and edited on
 * /wiki itself, where they are read, so nothing here touches page content.
 *
 * Split out of settings.html rather than inlined: that file is already the
 * largest page in the project and this tab would have pushed it another ~215
 * lines. Depends on showStatus() from settings.html, which is global.
 */
// ============================================================
// Wiki tab
//
// Categories and contextual links only. Page authoring lives on /wiki,
// so nothing here edits page content.
// ============================================================

var _wikiCats = [];
var _wikiPages = [];

async function loadWikiTab() {
    await Promise.all([loadWikiCategories(), loadWikiHookOptions()]);
}

async function loadWikiCategories() {
    var list = document.getElementById('wikiCatList');
    try {
        var resp = await fetch('/api/wiki/categories');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        _wikiCats = await resp.json();
    } catch (e) {
        list.innerHTML = '<div class="text-center text-steel-blue py-6 text-sm">Could not load categories.</div>';
        return;
    }
    renderWikiCategories();
}

function renderWikiCategories() {
    var list = document.getElementById('wikiCatList');
    list.innerHTML = '';
    if (!_wikiCats.length) {
        list.innerHTML = '<div class="text-center text-steel-blue py-6 text-sm">' +
            'No categories yet. Pages without one appear under &ldquo;Uncategorised&rdquo;.</div>';
        return;
    }
    _wikiCats.forEach(function (cat) {
        var row = document.createElement('div');
        row.className = 'flex items-center gap-3 p-3 rounded-lg bg-background-dark border border-steel-blue/25 flex-wrap';

        var ic = document.createElement('span');
        ic.className = 'material-symbols-outlined text-steel-blue shrink-0';
        ic.textContent = cat.icon || 'folder';
        row.appendChild(ic);

        var col = document.createElement('div');
        col.className = 'min-w-0 flex-1';
        var name = document.createElement('p');
        name.className = 'font-bold text-frosted-blue';
        name.textContent = cat.name;
        col.appendChild(name);
        var meta = document.createElement('p');
        meta.className = 'text-xs text-steel-blue';
        meta.textContent = '/wiki?category=' + cat.slug + ' · ' +
            (cat.page_count === 1 ? '1 page' : cat.page_count + ' pages') +
            (cat.draft_count ? ' · ' + cat.draft_count + ' draft' + (cat.draft_count === 1 ? '' : 's') : '');
        col.appendChild(meta);
        row.appendChild(col);

        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'px-3 py-1.5 rounded-lg text-sm font-bold text-primary hover:bg-primary/15 transition-colors';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', function () { editWikiCategory(cat); });
        row.appendChild(editBtn);

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'px-3 py-1.5 rounded-lg text-sm font-bold text-steel-blue hover:text-frosted-blue transition-colors';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function () { deleteWikiCategory(cat); });
        row.appendChild(delBtn);

        list.appendChild(row);
    });
}

async function createWikiCategory() {
    var name = prompt('Category name (for example: Getting Started)');
    if (!name || !name.trim()) return;
    var desc = prompt('One-line description (optional)') || '';
    var icon = prompt('Material Symbols icon name (optional, e.g. play_circle)') || '';
    await writeWikiCategory(null, {
        name: name.trim(),
        description: desc.trim() || null,
        icon: icon.trim() || null,
        sort_order: _wikiCats.length
    });
}

async function editWikiCategory(cat) {
    var name = prompt('Category name', cat.name);
    if (name === null) return;
    if (!name.trim()) return;
    var desc = prompt('One-line description (optional)', cat.description || '');
    if (desc === null) return;
    var icon = prompt('Material Symbols icon name (optional)', cat.icon || '');
    if (icon === null) return;
    var order = prompt('Sort order (lower appears first)', String(cat.sort_order));
    if (order === null) return;
    await writeWikiCategory(cat.slug, {
        name: name.trim(),
        slug: cat.slug,
        description: desc.trim() || null,
        icon: icon.trim() || null,
        sort_order: parseInt(order, 10) || 0
    });
}

async function writeWikiCategory(slug, payload) {
    var statusDiv = document.getElementById('statusWikiCats');
    try {
        var resp = await fetch(slug ? '/api/wiki/categories/' + encodeURIComponent(slug) : '/api/wiki/categories', {
            method: slug ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (resp.status === 409) {
            var body = await resp.json().catch(function () { return {}; });
            var d = body.detail || {};
            showStatus(statusDiv, false, d.message || 'That category already exists');
            return;
        }
        if (!resp.ok) { showStatus(statusDiv, false, 'Save failed (HTTP ' + resp.status + ')'); return; }
        showStatus(statusDiv, true, slug ? 'Category updated' : 'Category created');
        await loadWikiCategories();
        await loadWikiHookOptions();
    } catch (e) {
        showStatus(statusDiv, false, 'Error: ' + e.message);
    }
}

async function deleteWikiCategory(cat) {
    // Name the consequence exactly. "Delete" on a container reads as
    // "delete everything inside" unless told otherwise.
    var count = cat.page_count + (cat.draft_count || 0);
    var msg = count
        ? 'Delete "' + cat.name + '"? Its ' + count + ' page' + (count === 1 ? '' : 's') +
          ' will become uncategorised \u2014 they will NOT be deleted.'
        : 'Delete "' + cat.name + '"?';
    if (!confirm(msg)) return;

    var statusDiv = document.getElementById('statusWikiCats');
    try {
        var resp = await fetch('/api/wiki/categories/' + encodeURIComponent(cat.slug), { method: 'DELETE' });
        if (!resp.ok) { showStatus(statusDiv, false, 'Delete failed (HTTP ' + resp.status + ')'); return; }
        var result = await resp.json().catch(function () { return {}; });
        showStatus(statusDiv, true, result.pages_uncategorised
            ? 'Category deleted; ' + result.pages_uncategorised + ' page(s) kept as uncategorised'
            : 'Category deleted');
        await loadWikiCategories();
    } catch (e) {
        showStatus(statusDiv, false, 'Error: ' + e.message);
    }
}

async function loadWikiHookOptions() {
    var ids = ['wikiHookTickets', 'wikiHookIssues', 'wikiHookPlayback'];
    try {
        var resp = await fetch('/api/wiki/pages?limit=200');
        _wikiPages = resp.ok ? await resp.json() : [];
    } catch (e) {
        _wikiPages = [];
    }

    var current = {};
    try {
        var sResp = await fetch('/api/admin/settings');
        if (sResp.ok) {
            var rows = await sResp.json();
            (Array.isArray(rows) ? rows : (rows.settings || [])).forEach(function (r) {
                if (r.key && r.key.indexOf('wiki.hook_') === 0) current[r.key] = r.value;
            });
        }
    } catch (e) { /* leave every select on None */ }

    var keyFor = {
        wikiHookTickets: 'wiki.hook_tickets',
        wikiHookIssues: 'wiki.hook_issues',
        wikiHookPlayback: 'wiki.hook_playback'
    };

    ids.forEach(function (id) {
        var sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '';
        var none = document.createElement('option');
        none.value = '';
        none.textContent = 'None';
        sel.appendChild(none);
        _wikiPages.forEach(function (p) {
            var o = document.createElement('option');
            o.value = p.slug;
            o.textContent = p.title;
            if (current[keyFor[id]] === p.slug) o.selected = true;
            sel.appendChild(o);
        });
    });
}

async function saveWikiHooks() {
    var statusDiv = document.getElementById('statusWikiHooks');
    var settings = [
        { key: 'wiki.hook_tickets', value: document.getElementById('wikiHookTickets').value, description: 'Wiki page slug linked above the support ticket form' },
        { key: 'wiki.hook_issues', value: document.getElementById('wikiHookIssues').value, description: 'Wiki page slug linked above the media-issue form' },
        { key: 'wiki.hook_playback', value: document.getElementById('wikiHookPlayback').value, description: 'Wiki page slug linked on the Playback Issue category' }
    ];
    try {
        var resp = await fetch('/api/admin/settings/bulk', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: settings })
        });
        showStatus(statusDiv, resp.ok, resp.ok ? 'Links saved' : 'Save failed');
    } catch (e) {
        showStatus(statusDiv, false, 'Error: ' + e.message);
    }
}

document.getElementById('wikiCatNewBtn').addEventListener('click', createWikiCategory);
document.getElementById('wikiHooksSaveBtn').addEventListener('click', saveWikiHooks);
