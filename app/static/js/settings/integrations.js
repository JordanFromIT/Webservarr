/**
 * Settings > Integrations: one collapsible card per service, grouped by what
 * it powers. The light comes from real checks (GET /api/admin/integrations/health):
 * an empty ring = not set up, green = connected, amber = reachable but
 * misconfigured, red = unreachable, always with the reason in plain words.
 * Checked when the tab opens, after each save of a card, and on Test.
 *
 * The tab never waits for the checks: the cards arrive at once with
 * "Checking…" (a cold check can take 5 s), and the status line keeps its
 * height when the reason lands, so nothing moves.
 */
(function () {
  'use strict';

  var el = WSSettings.el, icon = WSSettings.icon, cls = WSSettings.cls;
  var HEALTH_URL = '/api/admin/integrations/health';
  // Where this site takes Sonarr's, Radarr's and Chaptarr's webhook calls
  // (app/routers/chaptarr_webhook.py): this base plus the card's id.
  var WEBHOOK_BASE = '/api/webhooks/';
  // Kometa's address once its token is saved (and can't be shown again).
  var TOKEN_HINT = '<your token>';
  var GROUPS = [
    ['Media server', ['plex']],
    ['Requests', ['seerr']],
    ['Books', ['chaptarr', 'kavita', 'nyt']],
    ['Calendar', ['sonarr', 'radarr']],
    ['Monitoring', ['uptime_kuma', 'netdata']],
    ['Event log', ['n8n', 'kometa']]
  ];
  var CARDS = {
    plex: { name: 'Plex', icon: 'play_circle', purpose: 'Shows what’s playing, and lets people sign in with Plex.',
      url: 'integration.plex.url', placeholder: 'http://192.168.1.10:32400',
      secret: ['integration.plex.token', 'Plex token', 'In Plex, open any title → Get Info → View XML. The token is the X-Plex-Token part of the address.'],
      extra: [['integration.plex.audiobook_library', 'Audiobook library',
        'Turns on the audiobook player. In Plex, open the library: its number follows source= in the address. Leave empty to keep the player off.',
        'For example 5']] },
    seerr: { name: 'Seerr', icon: 'download', purpose: 'Movie and TV requests, and the artwork on the sign-in page.',
      url: 'integration.seerr.url', placeholder: 'http://192.168.1.10:5055',
      secret: ['integration.seerr.api_key', 'API key', 'In Seerr: Settings → General → API key.'] },
    chaptarr: { name: 'Chaptarr', icon: 'auto_stories', purpose: 'Book and audiobook requests, and new books on the Books page right after they arrive.',
      url: 'integration.chaptarr.url', placeholder: 'http://192.168.1.10:8789',
      secret: ['integration.chaptarr.api_key', 'API key', 'In Chaptarr: Settings → General → API key.'], chaptarr: true,
      webhook: ['integration.chaptarr.webhook_secret', 'Webhook secret'],
      webhookSteps: 'In Chaptarr: Settings → Connect → + → Webhook. Tick On Grab, On Release Import, On Upgrade, On Book Delete, On Book File Delete and On Author Delete. Leave On Book File Delete For Upgrade unticked, or upgrades show as removed. Method POST. Any Username. Password = the secret.' },
    kavita: { name: 'Kavita', icon: 'menu_book', purpose: 'The ebooks on the Books page. Each person signs in to Kavita through your sign-in provider.',
      url: 'integration.kavita.url', placeholder: 'http://192.168.1.10:5000',
      secret: ['integration.kavita.api_key', 'API key', 'Lets the Books page list your ebooks for everyone. In Kavita: your account settings → API Key. It only goes to the address above.'] },
    nyt: { name: 'New York Times Books', icon: 'newspaper', purpose: 'Bestseller shelves on the Requests page.',
      secret: ['integration.nyt.api_key', 'API key', 'Free from developer.nytimes.com.'] },
    sonarr: { name: 'Sonarr', icon: 'tv', purpose: 'TV episodes on the Calendar.',
      url: 'integration.sonarr.url', placeholder: 'http://192.168.1.10:8989',
      secret: ['integration.sonarr.api_key', 'API key', 'In Sonarr: Settings → General → API key.'],
      webhook: ['integration.sonarr.webhook_secret', 'Webhook secret'],
      webhookSteps: 'In Sonarr: Settings → Connect → + → Webhook. Tick On Grab, On File Import, On File Upgrade, On Import Complete, On Rename, On Series Add, On Series Delete and On Episode File Delete. Method POST. Any Username. Password = the secret.' },
    radarr: { name: 'Radarr', icon: 'movie', purpose: 'Movie releases on the Calendar.',
      url: 'integration.radarr.url', placeholder: 'http://192.168.1.10:7878',
      secret: ['integration.radarr.api_key', 'API key', 'In Radarr: Settings → General → API key.'],
      webhook: ['integration.radarr.webhook_secret', 'Webhook secret'],
      webhookSteps: 'In Radarr: Settings → Connect → + → Webhook. Tick On Grab, On File Import, On File Upgrade, On Movie Added, On Movie Delete and On Movie File Delete. Method POST. Any Username. Password = the secret.' },
    uptime_kuma: { name: 'Uptime Kuma', icon: 'monitor_heart', purpose: 'Service Health on the home page.',
      url: 'integration.uptime_kuma.url', placeholder: 'http://192.168.1.10:3001',
      extra: [['integration.uptime_kuma.slug', 'Status page slug', 'The last part of your status page address.']],
      note: 'Choose which services appear on the home page in Pages → Home.' },
    netdata: { name: 'Netdata', icon: 'speed', purpose: 'CPU, memory and network gauges on the home page.',
      url: 'integration.netdata.url', placeholder: 'http://192.168.1.10:19999',
      secret: ['integration.netdata.api_key', 'API token', 'Only needed if your Netdata asks for one.'], netdata: true },
    // Inbound only (app/routers/activity_webhooks.py): nothing here to test,
    // so the card says whether its secret is saved, and has no Test.
    n8n: { name: 'n8n', icon: 'hub', purpose: 'Adds a “Fixed” line to the event log when a workflow sorts out a reported problem.',
      inbound: { key: 'integration.n8n.webhook_secret', label: 'Webhook secret', path: 'n8n',
        help: 'n8n sends it in the X-Webhook-Secret header. Make one here, copy it, then save.',
        steps: 'In n8n: an HTTP Request node, method POST, this address, a header X-Webhook-Secret = the secret, and a JSON body: {"kind": "issue_fixed", "title": …, "code": "S02E03" or null, "year": … or null, "problem": "subtitles", "audio", "video", "playback", "wrong_file" or "other", "ref": the issue id}.' } },
    kometa: { name: 'Kometa', icon: 'photo_library', purpose: 'Adds a “posters updated” line to the event log after Kometa runs.',
      inbound: { key: 'integration.kometa.webhook_token', label: 'Webhook token', path: 'kometa/', token: true,
        help: 'Kometa can’t send a password, so the token is the end of the address. It shows only while it’s new: copy the address or the snippet before you save.',
        steps: 'Paste the snippet into Kometa’s config.yml (replacing an empty webhooks: block). Only the end of each run is used.' } }
  };
  var CHAPTARR_KEYS = [
    ['integration.chaptarr.root_folder', 'eBook folder', 'folder'],
    ['integration.chaptarr.quality_profile_id', 'eBook quality profile', 'quality'],
    ['integration.chaptarr.metadata_profile_id', 'eBook metadata profile', 'metadata'],
    ['integration.chaptarr.audiobook_root_folder', 'Audiobook folder', 'folder'],
    ['integration.chaptarr.audiobook_quality_profile_id', 'Audiobook quality profile', 'quality'],
    ['integration.chaptarr.audiobook_metadata_profile_id', 'Audiobook metadata profile', 'metadata']
  ];
  // Saving either of these changes what Chaptarr can list, so the choices load again.
  var CHAPTARR_CONN = ['integration.chaptarr.url', 'integration.chaptarr.api_key'];
  var NETDATA_KEYS = ['netdata.cpu_label', 'netdata.ram_label', 'netdata.net_label', 'netdata.net_unit', 'netdata.net_max'];
  // "Not set up" is its own empty ring (ws-light-off); "couldn't check" is the
  // neutral filled dot (ws-light-unconfigured, also the info toast's tone).
  var LIGHT = { ok: 'ws-light-ok', warn: 'ws-light-warn', error: 'ws-light-error', unconfigured: 'ws-light-off',
                unknown: 'ws-light-unconfigured' };
  // Plain words for the network units. The units themselves are the setting's choices, from meta.
  var UNIT_LABELS = { mbps: 'Megabits per second (Mbps)', MBps: 'Megabytes per second (MB/s)' };

  var MSG = {
    checking: 'Checking…',
    unavailable: 'Couldn’t check right now',
    testing: 'Testing…',
    testFailed: 'The test couldn’t run. Try again.',
    choicesNeedSave: 'Save the address and API key to pick these from lists.',
    choicesLoading: 'Loading choices from Chaptarr…',
    choicesLoaded: 'Choices come from your Chaptarr.',
    choicesFailed: 'Couldn’t load choices from Chaptarr. Type the values instead.',
    typeInstead: 'Type the values instead.',
    inboundOn: 'Set up',
    inboundOff: 'Not set up'
  };

  function keysOf(id) {
    var c = CARDS[id], keys = [];
    if (c.url) keys.push(c.url);
    if (c.secret) keys.push(c.secret[0]);
    (c.extra || []).forEach(function (x) { keys.push(x[0]); });
    if (c.chaptarr) CHAPTARR_KEYS.forEach(function (x) { keys.push(x[0]); });
    if (c.webhook) keys.push(c.webhook[0]);
    if (c.netdata) keys = keys.concat(NETDATA_KEYS);
    if (c.inbound) keys.push(c.inbound.key);
    return keys;
  }

  function touches(keys, list) {
    return list.some(function (k) { return keys.indexOf(k) >= 0; });
  }

  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'checked just now';
    var m = Math.round(s / 60);
    if (m < 60) return 'checked ' + m + ' min ago';
    return 'checked ' + Math.round(s / 3600) + ' h ago';
  }

  // The body as JSON, or {} for an empty body or an error page.
  function readJson(r) {
    return r.text().then(function (text) {
      var d = null;
      try { d = text ? JSON.parse(text) : null; } catch (e) { d = null; }
      return { status: r.status, ok: r.ok, d: d && typeof d === 'object' ? d : {} };
    }, function () { return { status: r.status, ok: r.ok, d: {} }; });
  }

  function sentence(text) {
    text = String(text).trim();
    return /[.!?…]$/.test(text) ? text : text + '.';
  }

  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  // The server's same_address() (app/integrations/config.py), exactly: the
  // address trimmed and without trailing slashes, split the way Python's
  // urlsplit splits it, then scheme and host compared in any case and the
  // rest as written. Deliberately not new URL(): it also drops default ports
  // and rewrites IPv6 and paths, which the server does not, so it would call
  // two addresses the same that the server treats as a move. An address the
  // server can't split is never the same as anything. The shared cases in
  // app/tests/same_address_vectors.json hold the two to each other.
  // Python's str.strip() whitespace (not quite JavaScript's trim()).
  var PY_SPACE = '[\\t\\n\\x0b\\x0c\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
  var PY_STRIP = new RegExp('^' + PY_SPACE + '+|' + PY_SPACE + '+$', 'g');

  function splitAddress(u) {
    // same_address: strip(), rstrip('/'); then urlsplit: leading C0 controls
    // and spaces go, and tabs and newlines anywhere.
    u = String(u == null ? '' : u).replace(PY_STRIP, '').replace(/\/+$/, '')
      .replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
    var scheme = '', netloc = '', query = '', fragment = '';
    var i = u.indexOf(':');
    if (i > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(u.slice(0, i))) {
      scheme = u.slice(0, i).toLowerCase();
      u = u.slice(i + 1);
    }
    if (u.slice(0, 2) === '//') {
      var end = u.length;
      '/?#'.split('').forEach(function (c) {
        var at = u.indexOf(c, 2);
        if (at >= 0 && at < end) end = at;
      });
      netloc = u.slice(2, end);
      u = u.slice(end);
      var open = netloc.indexOf('[') >= 0, close = netloc.indexOf(']') >= 0;
      if (open !== close) return null;
      if (open && !bracketedHostOk(netloc.split('[')[1].split(']')[0])) return null;
    }
    var hash = u.indexOf('#');
    if (hash >= 0) { fragment = u.slice(hash + 1); u = u.slice(0, hash); }
    var q = u.indexOf('?');
    if (q >= 0) { query = u.slice(q + 1); u = u.slice(0, q); }
    return [scheme, netloc.toLowerCase(), u, query, fragment];
  }

  // What urlsplit accepts inside [ ]: an IPv6 address or an IPvFuture literal.
  function bracketedHostOk(h) {
    if (/^v/.test(h)) return /^v[a-fA-F0-9]+\.[a-zA-Z0-9._~\-+!$&'()*,;=:]+$/.test(h);
    if (h.indexOf(':') < 0) return false;
    try { new URL('http://[' + h + ']/'); return true; } catch (e) { return false; }
  }

  function sameAddress(a, b) {
    var na = splitAddress(a), nb = splitAddress(b);
    return na !== null && nb !== null && na.join('\u0000') === nb.join('\u0000');
  }

  WSSettings.registerTab('integrations', {
    // ctx: the page's (the kit passes it on each visit). Every listener,
    // request and the clock below end with its signal.
    mount: function (panel, api, ctx) {
      var signal = ctx.signal;
      var cards = {};
      var inbound = {};
      var health = {};
      // Answers can land out of order (a slow first check, then a card's
      // re-check). Each request is numbered. A card takes the entry for
      // itself from an answer to a request that asked for it, and only if no
      // newer request for it was made since. Every answer also carries the
      // other cards' cached entries: a card takes one of those only while
      // nothing is being asked for it, and only if it is strictly newer than
      // the answer it has (checked_at is whole seconds, so a same-second
      // cached entry may be the staler one) or it has none yet.
      var seq = 0, asked = {}, inflight = {};
      var UNAVAILABLE = function () { return { state: 'unknown', reason: MSG.unavailable, checked_at: '' }; };

      function newer(entry, old) {
        if (!old) return true;
        var a = Date.parse(entry.checked_at || ''), b = Date.parse(old.checked_at || '');
        return !b || (!!a && a > b);
      }

      function settle(ids, mine) {
        ids.forEach(function (k) { if (inflight[k] === mine) delete inflight[k]; });
      }

      function paint(id) {
        var c = cards[id], h = health[id];
        if (!c) return;
        var light = 'ws-light ' + (h ? (LIGHT[h.state] || LIGHT.unknown) : 'ws-light-checking');
        if (c.light.className !== light) c.light.className = light;
        var reason = h ? String(h.reason || '') : MSG.checking;
        setText(c.reason, reason);
        c.reason.title = reason;
        setText(c.when, h && h.state !== 'unconfigured' ? ago(h.checked_at) : '');
      }

      function refresh(id) {
        var mine = ++seq;
        var ids = id ? [id] : Object.keys(cards);
        ids.forEach(function (k) { asked[k] = mine; inflight[k] = mine; });
        if (id) { delete health[id]; paint(id); }
        var url = HEALTH_URL + (id ? '?refresh=1&service=' + encodeURIComponent(id) : '');
        return fetch(url, { credentials: 'same-origin', signal: signal }).then(function (r) {
          if (r.status === 401) { WSSettings.leave('/login'); throw new Error('HTTP 401'); }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function (data) {
          settle(ids, mine);
          var all = (data && data.integrations) || {};
          Object.keys(cards).forEach(function (k) {
            var entry = all[k] && typeof all[k] === 'object' ? all[k] : null;
            if (ids.indexOf(k) >= 0) {
              // Asked for here: the answer, or "couldn't check" if it has none.
              if (mine >= (asked[k] || 0)) health[k] = entry || UNAVAILABLE();
            } else if (entry && !inflight[k] && newer(entry, health[k])) {
              health[k] = entry;
            }
            paint(k);
          });
        }).catch(function () {
          settle(ids, mine);
          ids.forEach(function (k) {
            if (!health[k] && mine >= (asked[k] || 0)) health[k] = UNAVAILABLE();
            paint(k);
          });
        });
      }

      var chaptarr = null;

      function chaptarrFields(body) {
        var grid = el('div', 'grid sm:grid-cols-2 gap-5 ' + cls.fieldWidth);
        var slots = {};
        CHAPTARR_KEYS.forEach(function (k) {
          var slot = el('div', 'min-w-0');
          slots[k[0]] = slot;
          grid.appendChild(slot);
        });
        var hint = el('p', cls.help + ' min-h-[1.25rem]');
        hint.setAttribute('aria-live', 'polite');
        body.appendChild(grid);
        body.appendChild(hint);
        chaptarr = { slots: slots, hint: hint, seq: 0, lists: true };
        typed();
        loadChoices();
      }

      // Typed fields in the six slots (kept as they are if already typed, so
      // a reload of the lists doesn't rebuild them under the admin's cursor).
      function typed() {
        if (!chaptarr.lists) return;
        chaptarr.lists = false;
        CHAPTARR_KEYS.forEach(function (k) {
          chaptarr.slots[k[0]].replaceChildren(api.text({ key: k[0], label: k[1],
            inputType: k[2] === 'folder' ? 'text' : 'number' }));
        });
      }

      // Lists from Chaptarr when its address and key are saved, else typed values.
      function loadChoices() {
        var mine = ++chaptarr.seq, hint = chaptarr.hint;
        function stale() { return mine !== chaptarr.seq; }
        if (!api.saved('integration.chaptarr.url') || api.saved('integration.chaptarr.api_key') !== WSSettings.MASK) {
          typed();
          setText(hint, MSG.choicesNeedSave);
          return;
        }
        setText(hint, MSG.choicesLoading);
        fetch('/api/admin/chaptarr/options', { credentials: 'same-origin', signal: signal }).then(readJson, function () {
          return { status: 0, ok: false, d: {} };
        }).then(function (res) {
          if (stale()) return;
          if (res.status === 401) { WSSettings.leave('/login'); return; }
          var d = res.d;
          if (!res.ok || !Array.isArray(d.root_folders) || !Array.isArray(d.quality_profiles) ||
              !Array.isArray(d.metadata_profiles)) {
            typed();
            setText(hint, typeof d.detail === 'string' && d.detail.trim()
              ? sentence(d.detail) + ' ' + MSG.typeInstead : MSG.choicesFailed);
            return;
          }
          CHAPTARR_KEYS.forEach(function (k) {
            var current = api.get(k[0]), options;
            if (k[2] === 'folder') {
              options = [{ value: '', label: 'Not set' }].concat(d.root_folders.filter(function (f) {
                return f && typeof f.path === 'string' && f.path;
              }).map(function (f) { return { value: f.path, label: f.path }; }));
            } else {
              var list = k[2] === 'quality' ? d.quality_profiles : d.metadata_profiles;
              options = list.filter(function (p) { return p && p.id != null; }).map(function (p) {
                return { value: String(p.id), label: String(p.name || p.id) };
              });
            }
            if (current && !options.some(function (o) { return o.value === current; })) {
              options.unshift({ value: current,
                label: (k[2] === 'folder' ? current : 'Profile ' + current) + ' (not found in Chaptarr)' });
            }
            chaptarr.slots[k[0]].replaceChildren(api.select({ key: k[0], label: k[1], options: options }));
          });
          chaptarr.lists = true;
          setText(hint, MSG.choicesLoaded);
        }).catch(function (e) {
          if (window.console) console.error(e);
          if (stale()) return;
          typed();
          setText(hint, MSG.choicesFailed);
        });
      }

      // The app calls this site on the events the card's steps list: Home's
      // event log shows them, and new books show up on the Books page at once
      // instead of at the next 15-minute rebuild. The address is this page's
      // own origin (never typed in), so it is the one the app can reach when
      // it can reach this page.
      function webhookFields(body, id, c) {
        var box = el('div', 'space-y-5 border-t border-frosted-blue/10 pt-5');
        box.appendChild(el('h3', 'text-[15px] font-semibold text-frosted-blue', 'Tell ' + c.name + ' to ping this site'));
        var addr = el('div', 'min-w-0 ' + cls.fieldWidth);
        var label = el('label', cls.label, 'Webhook address');
        var row = el('div', 'flex flex-wrap items-center gap-2');
        var field = el('input', cls.input + ' flex-1 min-w-0 basis-52');
        field.id = id + 'WebhookUrl';
        field.type = 'text';
        field.readOnly = true;
        field.value = window.location.origin + WEBHOOK_BASE + id;
        label.htmlFor = field.id;
        var copy = el('button', cls.btnGhost);
        copy.type = 'button';
        copy.appendChild(icon('content_copy', 'text-base'));
        copy.appendChild(document.createTextNode('Copy'));
        copy.addEventListener('click', function () {
          var done = function () { WSSettings.toast('Copied', 'ok'); };
          var fallback = function () {
            field.focus();
            field.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            if (ok) done(); else WSSettings.toast('Couldn’t copy. Select it and copy by hand.', 'err');
          };
          if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
            window.navigator.clipboard.writeText(field.value).then(done, fallback);
          } else {
            fallback();
          }
        }, { signal: signal });
        row.appendChild(field);
        row.appendChild(copy);
        addr.appendChild(label);
        addr.appendChild(row);
        box.appendChild(addr);
        box.appendChild(api.secret({ key: c.webhook[0], label: c.webhook[1], generate: 32,
          help: c.name + ' sends it as the password. Make one here, copy it, then save.' }));
        box.appendChild(el('p', cls.help + ' ' + cls.fieldWidth, c.webhookSteps));
        body.appendChild(box);
      }

      // A read-only field with a Copy button: an address or a snippet to paste elsewhere.
      function copyField(fieldId, labelText, value, multiline) {
        var wrap = el('div', 'min-w-0 ' + cls.fieldWidth);
        var label = el('label', cls.label, labelText);
        var row = el('div', 'flex flex-wrap items-start gap-2');
        var field = el(multiline ? 'textarea' : 'input', cls.input + ' flex-1 min-w-0 basis-52' +
          (multiline ? ' font-mono text-[13px] resize-none' : ''));
        field.id = fieldId;
        if (multiline) field.rows = 3; else field.type = 'text';
        field.readOnly = true;
        field.spellcheck = false;
        field.value = value;
        label.htmlFor = field.id;
        var copy = el('button', cls.btnGhost);
        copy.type = 'button';
        copy.appendChild(icon('content_copy', 'text-base'));
        copy.appendChild(document.createTextNode('Copy'));
        copy.addEventListener('click', function () {
          var done = function () { WSSettings.toast('Copied', 'ok'); };
          var fallback = function () {
            field.focus();
            field.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            if (ok) done(); else WSSettings.toast('Couldn’t copy. Select it and copy by hand.', 'err');
          };
          if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
            window.navigator.clipboard.writeText(field.value).then(done, fallback);
          } else {
            fallback();
          }
        }, { signal: signal });
        row.appendChild(field);
        row.appendChild(copy);
        wrap.appendChild(label);
        wrap.appendChild(row);
        return { root: wrap, field: field };
      }

      // An inbound card's address and secret. Kometa's token is part of its
      // address: while a new one shows, the address and the config.yml
      // snippet carry it; once saved they say where it goes instead.
      function inboundFields(body, id, c) {
        var w = c.inbound;
        var base = window.location.origin + WEBHOOK_BASE + w.path;
        var addr = copyField(id + 'WebhookUrl', 'Webhook address', w.token ? base + TOKEN_HINT : base);
        var snippet = w.token ? copyField(id + 'Snippet', 'For config.yml', '', true) : null;
        function show(token) {
          if (!w.token) return;
          var url = base + (token || TOKEN_HINT);
          addr.field.value = url;
          snippet.field.value = 'webhooks:\n  run_end: ' + url;
        }
        show('');
        body.appendChild(addr.root);
        body.appendChild(api.secret({ key: w.key, label: w.label, generate: 32, help: w.help, onReveal: show }));
        if (snippet) body.appendChild(snippet.root);
        body.appendChild(el('p', cls.help + ' ' + cls.fieldWidth, w.steps));
      }

      function netdataFields(body) {
        var grid = el('div', 'grid sm:grid-cols-2 gap-5 ' + cls.fieldWidth);
        grid.appendChild(api.text({ key: 'netdata.cpu_label', label: 'CPU gauge label', placeholder: 'For example 8 cores' }));
        grid.appendChild(api.text({ key: 'netdata.ram_label', label: 'Memory gauge label', placeholder: 'Leave empty to detect' }));
        grid.appendChild(api.text({ key: 'netdata.net_label', label: 'Network gauge label', placeholder: 'Leave empty to detect' }));
        var unit = WSSettings.metaFor('netdata.net_unit');
        var units = unit && Array.isArray(unit.choices) ? unit.choices : [];
        grid.appendChild(api.select({ key: 'netdata.net_unit', label: 'Network unit',
          options: units.map(function (u) {
            return { value: u, label: Object.prototype.hasOwnProperty.call(UNIT_LABELS, u) ? UNIT_LABELS[u] : u };
          }) }));
        grid.appendChild(api.text({ key: 'netdata.net_max', label: 'Network gauge maximum', inputType: 'number',
          help: 'The speed that fills the gauge, in the unit above.' }));
        body.appendChild(grid);
      }

      function buildCard(id) {
        var c = CARDS[id];
        // ws-lift while collapsed only: a closed card answers the pointer like
        // a card; an open one is a form, and a form should not rise under the
        // hand that is filling it in.
        var root = el('section', 'ws-lift scroll-mt-6 rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] ' +
          'focus:outline-none');
        root.id = 'integration-card-' + id;
        root.tabIndex = -1;
        var head = el('button', 'w-full flex items-center gap-4 p-4 text-left rounded-2xl hover:bg-frosted-blue/[0.03] ' +
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary');
        head.type = 'button';
        head.setAttribute('aria-expanded', 'false');
        head.appendChild(icon(c.icon, 'text-[26px] text-frosted-blue/70'));
        var text = el('div', 'flex-1 min-w-0');
        text.appendChild(el('p', 'text-[17px] font-bold text-frosted-blue', c.name));
        text.appendChild(el('p', 'text-[13px] text-frosted-blue/70', c.purpose));
        // One line of fixed height: the reason and "checked … ago" fill in
        // without moving anything.
        var status = el('p', 'mt-1 h-5 flex items-center gap-2 text-[13px] leading-5 text-frosted-blue/70');
        var light = el('span', 'ws-light ws-light-checking');
        light.setAttribute('aria-hidden', 'true');
        var reason = el('span', 'min-w-0 truncate', MSG.checking);
        var when = el('span', 'text-frosted-blue/60 shrink-0');
        status.appendChild(light);
        status.appendChild(reason);
        status.appendChild(when);
        text.appendChild(status);
        head.appendChild(text);
        var chev = icon('expand_more', 'text-[22px] text-frosted-blue/60 transition-transform');
        head.appendChild(chev);
        root.appendChild(head);

        var body = el('div', 'hidden border-t border-frosted-blue/10 p-5 space-y-5');
        body.id = 'integration-body-' + id;
        head.setAttribute('aria-controls', body.id);
        var grid = el('div', 'grid sm:grid-cols-2 gap-5 ' + cls.fieldWidth);
        if (c.url) grid.appendChild(api.text({ key: c.url, label: 'Address', inputType: 'url', placeholder: c.placeholder }));
        if (c.secret) grid.appendChild(api.secret({ key: c.secret[0], label: c.secret[1], help: c.secret[2] }));
        (c.extra || []).forEach(function (x) {
          grid.appendChild(api.text({ key: x[0], label: x[1], help: x[2], placeholder: x[3] }));
        });
        if (grid.childNodes.length) body.appendChild(grid);
        if (c.inbound) inboundFields(body, id, c);
        if (c.chaptarr) chaptarrFields(body);
        if (c.webhook) webhookFields(body, id, c);
        if (c.netdata) netdataFields(body);
        if (c.note) body.appendChild(el('p', cls.help, c.note));

        var actions = el('div', 'flex flex-wrap items-center gap-2');
        var testBtn = el('button', cls.btnGhost);
        testBtn.type = 'button';
        testBtn.appendChild(icon('wifi_tethering', 'text-base'));
        testBtn.appendChild(document.createTextNode('Test'));
        var clearBtn = el('button', cls.btnQuiet);
        clearBtn.type = 'button';
        clearBtn.appendChild(icon('delete', 'text-base'));
        clearBtn.appendChild(document.createTextNode('Clear'));
        // On a phone the result has its own line, reserved, so it lands without moving anything.
        var result = el('p', 'basis-full sm:basis-auto min-w-0 min-h-5 flex items-center gap-2 text-[13px] text-frosted-blue/70');
        result.setAttribute('aria-live', 'polite');
        if (!c.inbound) actions.appendChild(testBtn);
        actions.appendChild(clearBtn);
        actions.appendChild(result);
        body.appendChild(actions);
        root.appendChild(body);

        // Each Test is numbered; Save, Discard and a newer Test move the
        // number on, so an answer still in flight from before is dropped.
        var testSeq = 0;
        function clearResult() {
          testSeq += 1;
          result.replaceChildren();
        }

        function showResult(state, message) {
          var dot = el('span', 'ws-light ' + (state === 'checking' ? 'ws-light-checking' : (LIGHT[state] || LIGHT.unknown)));
          dot.setAttribute('aria-hidden', 'true');
          result.replaceChildren(dot, el('span', 'min-w-0', message));
        }

        function expand(open) {
          head.setAttribute('aria-expanded', open ? 'true' : 'false');
          root.classList.toggle('ws-lift', !open);
          body.classList.toggle('hidden', !open);
          chev.style.transform = open ? 'rotate(180deg)' : '';
        }
        head.addEventListener('click', function () { expand(head.getAttribute('aria-expanded') !== 'true'); }, { signal: signal });
        // A link from another tab (WSSettings.go) scrolls here and focuses the
        // card: it opens, and focus moves to its header. A click inside an
        // open card that lands on blank space leaves it alone.
        root.addEventListener('focus', function (e) {
          if (e.relatedTarget && root.contains(e.relatedTarget)) return;
          if (head.getAttribute('aria-expanded') !== 'true') expand(true);
          head.focus({ preventScroll: true });
        }, { signal: signal });

        testBtn.addEventListener('click', function () {
          var payload = { service: id, url: c.url ? api.get(c.url) : '',
                          credentials: c.secret ? api.get(c.secret[0]) : null };
          if (id === 'uptime_kuma') payload.slug = api.get('integration.uptime_kuma.slug');
          var mine = ++testSeq;
          showResult('checking', MSG.testing);
          testBtn.disabled = true;
          fetch('/api/admin/test-connection', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            credentials: 'same-origin', signal: signal
          }).then(readJson).then(function (res) {
            if (res.status === 401) { WSSettings.leave('/login'); return; }
            if (mine !== testSeq) return;
            var d = res.d;
            var message = d.message || (typeof d.detail === 'string' && d.detail) || MSG.testFailed;
            showResult(LIGHT[d.state] ? d.state : (res.ok ? 'unknown' : 'error'), String(message));
            // The saved values were tested: the light takes the fresh answer too.
            if (res.ok && !touches(api.dirtyKeys(), keysOf(id))) refresh(id);
          }).catch(function () {
            if (mine === testSeq) showResult('error', MSG.testFailed);
          }).then(function () { testBtn.disabled = false; });
        }, { signal: signal });

        clearBtn.addEventListener('click', function () {
          WSSettings.confirm({
            title: 'Clear ' + c.name + '?',
            body: 'This empties every field on this card. Nothing changes until you press Save.',
            confirmLabel: 'Clear fields', cancelLabel: 'Cancel', danger: true
          }).then(function (ok) {
            if (!ok) return;
            keysOf(id).forEach(function (k) {
              var m = WSSettings.metaFor(k);
              api.set(k, m && !m.allow_empty ? m.default : '');
            });
          });
        }, { signal: signal });

        if (c.inbound) {
          // Not checked by the server: set up is a saved secret.
          inbound[id] = function () {
            var on = api.saved(c.inbound.key) === WSSettings.MASK;
            light.className = 'ws-light ' + (on ? LIGHT.ok : LIGHT.unconfigured);
            setText(reason, on ? MSG.inboundOn : MSG.inboundOff);
          };
          inbound[id]();
          return root;
        }
        cards[id] = { light: light, reason: reason, when: when, clearResult: clearResult };
        return root;
      }

      var intro = el('p', 'text-[15px] text-frosted-blue/70 mb-8 max-w-2xl',
        'Connect the services your site uses. Each card shows whether it’s working and why.');
      panel.appendChild(intro);
      GROUPS.forEach(function (g) {
        var group = WSSettings.card(g[0]);
        group.body.className = 'space-y-3';
        g[1].forEach(function (id) { group.body.appendChild(buildCard(id)); });
        panel.appendChild(group.root);
      });

      // After a save, each card whose settings were in it checks again, and
      // Chaptarr's lists load again when its address or key changed.
      // A Test result describes the values tested; once those are saved or
      // discarded it no longer does, and the light speaks for the card.
      document.addEventListener('ws-settings:saved', function (e) {
        var keys = e.detail && Array.isArray(e.detail.keys) ? e.detail.keys : [];
        Object.keys(CARDS).forEach(function (id) {
          if (inbound[id]) { if (touches(keys, keysOf(id))) inbound[id](); return; }
          if (touches(keys, keysOf(id))) { cards[id].clearResult(); refresh(id); }
        });
        if (chaptarr && touches(keys, CHAPTARR_CONN)) loadChoices();
      }, { signal: signal });
      api.onDiscard(function () {
        Object.keys(cards).forEach(function (id) { cards[id].clearResult(); });
      });
      // "checked … ago" keeps counting while the page is open.
      ctx.poll(function () { Object.keys(cards).forEach(function (id) { if (health[id]) paint(id); }); }, 30000);
      // Signed in with Plex: ask before a save clears or changes the Plex
      // address or token, the way the Sign-in tab asks about its own switches.
      WSSettings.ownSignIn.guard(api, { plex: ['integration.plex.url', 'integration.plex.token'] }, { askOnChange: true });
      // Each member's eBooks sign-in belongs to the Kavita address it came
      // from, so moving the address resets them all (the server does it on
      // save). Ask first. Respelling the address or clearing it resets
      // nothing and doesn't ask.
      api.beforeSave(function (keys) {
        var k = CARDS.kavita.url;
        if (keys.indexOf(k) < 0) return true;
        var next = api.get(k);
        if (!next || sameAddress(next, api.saved(k))) return true;
        return WSSettings.confirm({
          title: 'Change the Kavita address?',
          body: 'Changing this address resets everyone’s eBooks connection. They’ll sign in to eBooks again.',
          confirmLabel: 'Save the change', cancelLabel: 'Keep the old one', danger: true
        }).then(function (ok) {
          if (!ok) api.set(k, api.saved(k));
          return ok;
        });
      });
      // Not returned: the tab shows at once and the lights fill in.
      refresh();
    }
  });
})();
