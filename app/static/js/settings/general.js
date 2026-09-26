/**
 * Settings > General: site name, tagline, logo, and settings backup.
 *
 * The logo upload stores the file straight away but only stages its address;
 * the setting is written when the admin presses Save, like everything else.
 * The logo address is checked by the server when it is saved (its message
 * lands on the field), never by a pattern here.
 */
(function () {
  'use strict';

  var el = WSSettings.el, icon = WSSettings.icon, cls = WSSettings.cls;
  var TAB_KEYS = ['branding.app_name', 'branding.tagline', 'branding.logo_url'];
  var LOGO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  var MAX_LOGO_BYTES = 2 * 1024 * 1024;       // upload-logo's own limit
  var MAX_IMPORT_BYTES = 1024 * 1024;         // a real backup is a few kilobytes

  var MSG = {
    offline: 'Couldn’t reach the server. Check your connection and try again.',
    forbidden: 'Only admins can change settings.',
    busy: 'That was a lot in a row. Wait a minute, then try again.',
    notImage: 'That file can’t be used as a logo. Choose a PNG, JPEG, GIF or WebP image.',
    bigImage: 'That image is over 2 MB. Choose a smaller one.',
    uploadFailed: 'The upload didn’t work. Try again.',
    exportFailed: 'Couldn’t export your settings. Try again.',
    notSettings: 'This isn’t a settings file.',
    bigFile: 'That file is too big to be a settings file.',
    unreadable: 'The file couldn’t be read. Try again.',
    checkFailed: 'The file couldn’t be checked. Try again.',
    stale: 'Settings changed since the preview — preview again.',
    importFailed: 'The import didn’t finish. Nothing was changed. Try again.',
    importUnknown: 'Couldn’t confirm the import finished. Reload the page to see your settings.',
    dirty: 'Save or discard your changes on this tab before importing.',
    uploading: 'Wait for the logo upload to finish, then import.'
  };

  // ---- Talking to the server ----

  // {status, data}: data is the parsed JSON object, or null when the body is
  // empty or not JSON (a proxy's error page, say), so no parser error or
  // "[object Object]" can reach the admin.
  function readBody(r) {
    return r.text().then(function (text) {
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      return { status: r.status, data: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
    }, function () { return { status: r.status, data: null }; });
  }

  // Status 0 means the server couldn't be reached.
  function request(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(readBody, function () { return { status: 0, data: null }; });
  }

  // A plain sentence for a failed call (the call's own wording first), or
  // null after sending an admin whose session has ended to the sign-in page.
  function failure(res, words) {
    var s = res.status, d = res.data;
    if (s === 401) { WSSettings.leave('/login'); return null; }
    if (words[s]) return words[s];
    if (s === 0) return MSG.offline;
    if (s === 403) return MSG.forbidden;
    if (s === 429) return MSG.busy;
    if (s === 503 && d && typeof d.detail === 'string' && d.detail) return d.detail;
    return words.fallback;
  }

  function tell(res, words) {
    var message = failure(res, words);
    if (message) WSSettings.toast(message, 'err');
  }

  function plainObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

  // What a setting is called: its description, or the key itself.
  function nameOf(key) {
    var m = WSSettings.metaFor(key);
    return m && m.description ? m.description : key;
  }

  // ---- Your site ----

  function siteCard(api) {
    var c = WSSettings.card('Your site', 'The name and words people see when they visit.');
    c.body.appendChild(api.text({
      key: 'branding.app_name', label: 'Site name',
      help: 'Shown in the sidebar, on the sign-in page and in browser tabs. Leave it empty to show only your logo.'
    }));
    c.body.appendChild(api.text({
      key: 'branding.tagline', label: 'Tagline',
      help: 'Shown under the site name on the sign-in page, and in link previews when someone shares your site.'
    }));
    return c.root;
  }

  // ---- Logo ----

  // shared: {uploading, changed()}, so the backup card knows an upload is running.
  function logoCard(api, shared) {
    var c = WSSettings.card('Logo', 'Shown at the top of the sidebar and on the sign-in page.');
    var row = el('div', 'flex flex-col sm:flex-row gap-5 sm:items-start');

    // A fixed size, so nothing moves while an image loads or changes.
    var box = el('div', 'flex items-center justify-center w-full sm:w-48 h-24 shrink-0 rounded-2xl ' +
      'bg-frosted-blue/[0.04] border border-frosted-blue/10 overflow-hidden');
    var img = el('img', 'max-w-full max-h-full object-contain hidden');
    img.alt = 'Logo preview';
    var none = el('div', 'flex flex-col items-center gap-1 text-frosted-blue/45 hidden');
    none.appendChild(icon('image', 'text-[28px]'));
    var noneText = el('span', 'text-[13px]');
    none.appendChild(noneText);
    box.appendChild(img);
    box.appendChild(none);

    var controls = el('div', 'flex-1 min-w-0 space-y-4');
    var buttons = el('div', 'flex flex-wrap gap-2');
    var file = el('input', 'hidden');
    file.type = 'file';
    file.accept = LOGO_TYPES.join(',');
    file.tabIndex = -1;
    file.setAttribute('aria-hidden', 'true');
    var upload = el('button', cls.btnGhost + ' aria-disabled:opacity-50 aria-disabled:cursor-not-allowed');
    upload.type = 'button';
    upload.appendChild(icon('upload', 'text-base'));
    upload.appendChild(document.createTextNode('Upload an image'));
    var builtIn = el('button', cls.btnQuiet, 'Use the built-in logo');
    builtIn.type = 'button';
    var noLogo = el('button', cls.btnQuiet, 'No logo');
    noLogo.type = 'button';
    buttons.appendChild(file);
    buttons.appendChild(upload);
    buttons.appendChild(builtIn);
    buttons.appendChild(noLogo);
    controls.appendChild(buttons);
    var field = api.text({
      key: 'branding.logo_url', label: 'Or use a web address', placeholder: 'https://',
      help: 'PNG, JPEG, GIF or WebP. Uploads can be up to 2 MB.'
    });
    controls.appendChild(field);
    // A text box with a URL keyboard, not type=url: a path on this site
    // ("/static/...") is a valid logo, and the browser would mark it invalid.
    var input = field.querySelector('input');
    input.inputMode = 'url';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    // One short line at most (errors go to a toast), so the page never moves.
    var status = el('p', 'text-[13px] text-frosted-blue/70 min-h-[1.25rem]');
    status.setAttribute('aria-live', 'polite');
    controls.appendChild(status);
    row.appendChild(box);
    row.appendChild(controls);
    c.body.appendChild(row);

    // The preview shows whatever the field holds, and says so when it can't
    // load it. Whether the address may be saved is the server's call.
    var shownUrl = null, typing = null, settle = null;
    var ready = new Promise(function (resolve) { settle = resolve; });
    function placeholder(text) {
      img.classList.add('hidden');
      noneText.textContent = text;
      none.classList.remove('hidden');
    }
    function paint(url) {
      url = url || '';
      if (url === shownUrl) return;
      shownUrl = url;
      if (!url) { img.removeAttribute('src'); placeholder('No logo'); settle(); return; }
      // Neither image nor placeholder until it loads, so "No logo" never flashes.
      img.classList.add('hidden');
      none.classList.add('hidden');
      img.src = url;
    }
    img.addEventListener('load', function () {
      if (!shownUrl) return;
      none.classList.add('hidden');
      img.classList.remove('hidden');
      settle();
    });
    img.addEventListener('error', function () {
      if (!shownUrl) return;
      placeholder('Can’t show this image');
      settle();
    });
    api.onChange('branding.logo_url', function (url) {
      clearTimeout(typing);
      // A typed address is previewed once the typing pauses, not per key.
      if (document.activeElement === input) {
        typing = setTimeout(function () { paint(api.get('branding.logo_url')); }, 400);
      } else {
        paint(url);
      }
    });
    paint(api.get('branding.logo_url'));

    var seq = 0, uploading = false;
    function say(text) { status.textContent = text; }
    function busy(on) {
      uploading = on;
      upload.setAttribute('aria-disabled', on ? 'true' : 'false');
      shared.uploading = on;
      shared.changed();
    }
    // Any other logo choice (or a Discard) wins over an upload still in
    // flight: its answer is dropped when it arrives.
    function cancelUpload() { seq += 1; busy(false); }

    builtIn.addEventListener('click', function () {
      cancelUpload();
      say('');
      api.set('branding.logo_url', WSSettings.metaFor('branding.logo_url').default);
    });
    noLogo.addEventListener('click', function () { cancelUpload(); say(''); api.set('branding.logo_url', ''); });
    input.addEventListener('input', function () { cancelUpload(); say(''); });
    upload.addEventListener('click', function () { if (!uploading) file.click(); });
    file.addEventListener('change', function () {
      var f = file.files[0];
      file.value = '';
      if (!f) return;
      if (LOGO_TYPES.indexOf(f.type) < 0) { say(''); WSSettings.toast(MSG.notImage, 'err'); return; }
      if (f.size > MAX_LOGO_BYTES) { say(''); WSSettings.toast(MSG.bigImage, 'err'); return; }
      var mine = ++seq;
      busy(true);
      say('Uploading…');
      var fd = new FormData();
      fd.append('file', f);
      request('/api/admin/upload-logo', { method: 'POST', body: fd }).then(function (res) {
        // Another choice or a Discard since this upload started wins.
        if (mine !== seq) return;
        busy(false);
        var url = res.status === 200 && res.data && typeof res.data.url === 'string' ? res.data.url : '';
        if (!url) {
          // A failed upload stages nothing.
          say('');
          if (res.status === 200) WSSettings.toast(MSG.uploadFailed, 'err');
          else tell(res, { 400: MSG.notImage, 413: MSG.bigImage, 415: MSG.notImage, fallback: MSG.uploadFailed });
          return;
        }
        api.set('branding.logo_url', url);
        say('Uploaded. Press Save to use it.');
      });
    });
    api.onSaved(function () { say(''); });
    api.onDiscard(function () { cancelUpload(); say(''); });

    // The tab waits (briefly) for the preview, so it arrives with the rest.
    return { root: c.root, ready: Promise.race([ready, new Promise(function (r) { setTimeout(r, 300); })]) };
  }

  // ---- Backup ----

  // Values are shown whole, never cut short: a long address is exactly the
  // kind of change an admin needs to read to the end before importing.
  function shown(v) {
    v = String(v == null ? '' : v);
    return v === '' ? '(empty)' : v;
  }

  function noteOf(c) { return typeof c.note === 'string' ? c.note : ''; }

  // A change the admin should stop and read: an icon and a plain sentence.
  function flag(text) {
    var p = el('p', 'mt-1 flex items-start gap-1.5 text-[13px] font-semibold text-frosted-blue');
    p.appendChild(icon('warning', 'text-[16px] leading-5 shrink-0'));
    p.appendChild(el('span', null, text));
    return p;
  }

  // Custom CSS in full, in a monospace block that scrolls on its own.
  function cssBlock(label, v) {
    var wrap = el('div', 'mt-2');
    wrap.appendChild(el('p', 'text-[12px] text-frosted-blue/45', label));
    wrap.appendChild(el('pre', 'mt-1 max-h-48 overflow-auto rounded-lg border border-frosted-blue/10 ' +
      'px-2 py-1.5 font-mono text-[12px] leading-5 text-frosted-blue/70 whitespace-pre-wrap break-all', shown(v)));
    return wrap;
  }

  // The preview: every change (old → new), then the unchanged values today's
  // rules would refuse, which the import leaves as they are. A saved key the
  // import clears (its address changed), or everyone's eBooks connection
  // being reset, reads as the server's sentence, and custom CSS is flagged
  // and shown in full.
  function previewBody(changes, ignored, warnings) {
    var wrap = el('div');
    if (changes.length) {
      var list = el('ul', 'mt-2 divide-y divide-frosted-blue/10 max-h-[40vh] overflow-y-auto rounded-xl border border-frosted-blue/10');
      changes.forEach(function (c) {
        var li = el('li', 'px-3 py-2');
        // An entry that is not a setting (resetting eBooks connections) names itself.
        var label = typeof c.label === 'string' && c.label ? c.label : nameOf(c.key);
        li.appendChild(el('p', 'text-[13px] font-semibold text-frosted-blue', label));
        if (noteOf(c)) {
          li.appendChild(flag(noteOf(c)));
        } else if (c.key === 'theme.custom_css') {
          li.appendChild(flag('Changes the site’s custom CSS'));
          li.appendChild(cssBlock('Now', c.old));
          li.appendChild(cssBlock('After the import', c['new']));
        } else {
          li.appendChild(el('p', 'text-[13px] text-frosted-blue/70 break-all font-mono',
            shown(c.old) + '  →  ' + shown(c['new'])));
        }
        list.appendChild(li);
      });
      wrap.appendChild(list);
    }
    if (Object.keys(warnings).length) {
      wrap.appendChild(el('p', 'mt-4 text-[13px] font-semibold text-frosted-blue', 'Kept as-is'));
      wrap.appendChild(el('p', 'text-[13px] text-frosted-blue/45',
        'These match what you have now, but wouldn’t be accepted as new values. They stay as they are.'));
      var kept = el('ul', 'mt-2 divide-y divide-frosted-blue/10 max-h-[30vh] overflow-y-auto rounded-xl border border-frosted-blue/10');
      Object.keys(warnings).forEach(function (k) {
        var li = el('li', 'px-3 py-2');
        li.appendChild(el('p', 'text-[13px] font-semibold text-frosted-blue', nameOf(k)));
        li.appendChild(el('p', 'text-[13px] text-frosted-blue/70 break-words',
          typeof warnings[k] === 'string' && warnings[k] ? warnings[k] : 'Kept as-is'));
        kept.appendChild(li);
      });
      wrap.appendChild(kept);
    }
    if (ignored.length) {
      wrap.appendChild(el('p', 'mt-3 text-[13px] text-frosted-blue/45', changes.some(function (c) { return noteOf(c) && !c.effect; })
        ? 'Passwords and keys in the file were skipped. Yours stay as they are, apart from any cleared above.'
        : 'Passwords and keys in the file were skipped; yours stay as they are.'));
    }
    return wrap;
  }

  // Every per-key problem the server found, not just the first.
  function showProblems(data) {
    var errs = plainObject(data && data.errors);
    var keys = Object.keys(errs);
    if (!keys.length) { WSSettings.toast(MSG.checkFailed, 'err'); return; }
    var list = el('ul', 'mt-2 space-y-3');
    keys.slice(0, 10).forEach(function (k) {
      var li = el('li');
      var message = typeof errs[k] === 'string' && errs[k] ? errs[k] : 'That value isn’t allowed';
      if (k !== '_file') {
        li.appendChild(el('p', 'text-[13px] font-semibold text-frosted-blue break-words', nameOf(k)));
        if (nameOf(k) !== k) li.appendChild(el('p', 'text-[13px] font-mono text-frosted-blue/45 break-words', k));
      }
      li.appendChild(el('p', 'text-[13px] text-frosted-blue/70 break-words', message));
      list.appendChild(li);
    });
    if (keys.length > 10) list.appendChild(el('li', 'text-[13px] text-frosted-blue/45', 'and ' + (keys.length - 10) + ' more'));
    return WSSettings.confirm({ title: 'This file can’t be imported', body: list, confirmLabel: 'OK', alert: true });
  }

  function postImport(data, dry, token) {
    return request('/api/admin/settings/import?dry_run=' + (dry ? 'true' : 'false'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: data, diff_token: token || null })
    });
  }

  // An edit on this tab since the import started would be thrown away by the
  // reload that follows it, so the import stops instead.
  function blockedByEdits(api) {
    if (!api.dirtyKeys().length) return false;
    WSSettings.toast(MSG.dirty, 'err');
    return true;
  }

  // Preview the file, show every change, then apply exactly that diff.
  // Resolves once the admin is done ('reloading' when the page is reloading).
  function startImport(f, api) {
    if (f.size > MAX_IMPORT_BYTES) { WSSettings.toast(MSG.bigFile, 'err'); return Promise.resolve(); }
    return f.text().then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { WSSettings.toast(MSG.notSettings, 'err'); return; }
      return postImport(data, true).then(function (res) {
        if (res.status === 422) return showProblems(res.data);
        if (res.status !== 200) {
          tell(res, { 413: MSG.bigFile, 415: MSG.notSettings, fallback: MSG.checkFailed });
          return;
        }
        var d = res.data || {};
        if (!Array.isArray(d.changes) || typeof d.diff_token !== 'string') {
          WSSettings.toast(MSG.checkFailed, 'err');
          return;
        }
        var changes = d.changes;
        var ignored = Array.isArray(d.ignored) ? d.ignored : [];
        var warnings = plainObject(d.warnings);
        if (!changes.length) {
          if (!Object.keys(warnings).length) {
            WSSettings.toast('Nothing to import — this file matches your current settings.', 'info');
            return;
          }
          var same = el('div');
          same.appendChild(el('p', null, 'This file matches your current settings.'));
          same.appendChild(previewBody([], ignored, warnings));
          return WSSettings.confirm({ title: 'Nothing to import', body: same, confirmLabel: 'OK', alert: true });
        }
        if (blockedByEdits(api)) return;
        return WSSettings.confirm({
          title: 'Import ' + changes.length + ' change' + (changes.length === 1 ? '' : 's') + '?',
          body: previewBody(changes, ignored, warnings),
          confirmLabel: 'Import', cancelLabel: 'Cancel'
        }).then(function (ok) {
          if (!ok || blockedByEdits(api)) return;
          return postImport(data, false, d.diff_token).then(function (applied) {
            if (applied.status === 200 && applied.data && Array.isArray(applied.data.applied)) {
              var n = applied.data.applied.length;
              // Pages prefetched or prerendered before the import hold the
              // old settings; dropped now, before the reload is even queued.
              if (window.WS && WS.clearPageCache) WS.clearPageCache();
              WSSettings.toast('Imported ' + n + ' setting' + (n === 1 ? '' : 's') + '. Reloading…', 'ok');
              setTimeout(function () { WSSettings.leave(); }, 900);
              return 'reloading';
            }
            if (applied.status === 422) return showProblems(applied.data);
            // No answer (or an unreadable one) mid-apply: it may have landed.
            tell(applied, { 0: MSG.importUnknown, 200: MSG.importUnknown, 409: MSG.stale, 413: MSG.bigFile,
                            415: MSG.notSettings, fallback: MSG.importFailed });
          });
        });
      });
    }, function () { WSSettings.toast(MSG.unreadable, 'err'); });
  }

  // A fetch rather than a plain link, so a failure is a sentence, not an
  // error page saved as the backup.
  function exportSettings() {
    return fetch('/api/admin/settings/export', { credentials: 'same-origin' }).then(function (r) {
      var json = (r.headers.get('Content-Type') || '').indexOf('application/json') === 0;
      if (!r.ok) return readBody(r).then(function (res) { tell(res, { fallback: MSG.exportFailed }); });
      if (!json) { WSSettings.toast(MSG.exportFailed, 'err'); return; }
      var m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
      return r.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = m ? m[1] : 'webservarr-settings.json';
        a.hidden = true;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        WSSettings.toast('Your settings file is downloading.', 'ok');
      });
    }).catch(function () { WSSettings.toast(MSG.offline, 'err'); });
  }

  // locked: the tab's other cards, which can't be edited while an import runs
  // (the upload button included). shared: the logo upload's state; an import
  // waits for an upload to finish, whose answer the reload would lose.
  function backupCard(api, locked, shared) {
    var c = WSSettings.card('Backup',
      'Save your settings to a file, or restore them from one. Passwords, tokens and API keys are never included.');
    var row = el('div', 'flex flex-wrap gap-2');
    var busyCls = ' aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';
    var exp = el('button', cls.btnGhost + busyCls);
    exp.type = 'button';
    exp.appendChild(icon('download', 'text-base'));
    exp.appendChild(document.createTextNode('Export settings'));
    var file = el('input', 'hidden');
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.tabIndex = -1;
    file.setAttribute('aria-hidden', 'true');
    var imp = el('button', cls.btnGhost + busyCls);
    imp.type = 'button';
    imp.appendChild(icon('upload_file', 'text-base'));
    imp.appendChild(document.createTextNode('Import settings'));
    row.appendChild(exp);
    row.appendChild(file);
    row.appendChild(imp);
    var note = el('p', cls.help);
    note.id = 'generalImportNote';
    imp.setAttribute('aria-describedby', note.id);
    c.body.appendChild(row);
    c.body.appendChild(note);

    var exporting = false, importing = false;

    // Only this tab can hold changes: switching tabs with changes already
    // makes the admin save or discard them.
    function sync() {
      var dirty = api.dirtyKeys().length > 0;
      imp.disabled = dirty || shared.uploading;
      imp.setAttribute('aria-disabled', importing ? 'true' : 'false');
      locked.forEach(function (n) {
        n.inert = importing;
        if (importing) n.setAttribute('aria-busy', 'true'); else n.removeAttribute('aria-busy');
      });
      note.textContent = dirty ? MSG.dirty : shared.uploading ? MSG.uploading
        : 'Importing shows every change first. Nothing is applied until you confirm.';
    }
    shared.changed = sync;
    TAB_KEYS.forEach(function (k) { api.onChange(k, sync); });
    api.onSaved(sync);
    api.onDiscard(sync);
    sync();

    exp.addEventListener('click', function () {
      if (exporting) return;
      exporting = true;
      exp.setAttribute('aria-disabled', 'true');
      exportSettings().then(function () {
        exporting = false;
        exp.setAttribute('aria-disabled', 'false');
      });
    });
    imp.addEventListener('click', function () {
      if (!importing && !shared.uploading && !api.dirtyKeys().length) file.click();
    });
    file.addEventListener('change', function () {
      var f = file.files[0];
      file.value = '';
      if (!f) return;
      // An upload may have started while the file chooser was open.
      if (shared.uploading) { WSSettings.toast(MSG.uploading, 'err'); return; }
      if (api.dirtyKeys().length) { WSSettings.toast(MSG.dirty, 'err'); return; }
      importing = true;
      sync();
      startImport(f, api).then(function (outcome) {
        if (outcome === 'reloading') return;       // stays busy until the page reloads
        importing = false;
        sync();
      }, function (e) {
        if (window.console) console.error(e);
        WSSettings.toast(MSG.checkFailed, 'err');
        importing = false;
        sync();
      });
    });
    return c.root;
  }

  WSSettings.registerTab('general', {
    mount: function (panel, api) {
      var shared = { uploading: false, changed: function () {} };
      var site = siteCard(api);
      var logo = logoCard(api, shared);
      panel.appendChild(site);
      panel.appendChild(logo.root);
      panel.appendChild(backupCard(api, [site, logo.root], shared));
      return logo.ready;
    }
  });
})();
