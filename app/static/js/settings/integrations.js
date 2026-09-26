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
  var GROUPS = [
    ['Media server', ['plex']],
    ['Requests', ['seerr']],
    ['Books', ['chaptarr', 'kavita', 'nyt']],
    ['Calendar', ['sonarr', 'radarr']],
    ['Monitoring', ['uptime_kuma', 'netdata']]
  ];
  var CARDS = {
    plex: { name: 'Plex', icon: 'play_circle', purpose: 'Shows what’s playing, and lets people sign in with Plex.',
      url: 'integration.plex.url', placeholder: 'http://192.168.1.10:32400',
      secret: ['integration.plex.token', 'Plex token', 'In Plex, open any title → Get Info → View XML. The token is the X-Plex-Token part of the address.'] },
    seerr: { name: 'Seerr', icon: 'download', purpose: 'Movie and TV requests, and the artwork on the sign-in page.',
      url: 'integration.seerr.url', placeholder: 'http://192.168.1.10:5055',
      secret: ['integration.seerr.api_key', 'API key', 'In Seerr: Settings → General → API key.'] },
    chaptarr: { name: 'Chaptarr', icon: 'auto_stories', purpose: 'Book and audiobook requests.',
      url: 'integration.chaptarr.url', placeholder: 'http://192.168.1.10:8789',
      secret: ['integration.chaptarr.api_key', 'API key', 'In Chaptarr: Settings → General → API key.'], chaptarr: true },
    kavita: { name: 'Kavita', icon: 'menu_book', purpose: 'The eBooks page. Each person signs in to Kavita through your sign-in provider.',
      url: 'integration.kavita.url', placeholder: 'http://192.168.1.10:5000' },
    nyt: { name: 'New York Times Books', icon: 'newspaper', purpose: 'Bestseller shelves on the Requests page.',
      secret: ['integration.nyt.api_key', 'API key', 'Free from developer.nytimes.com.'] },
    sonarr: { name: 'Sonarr', icon: 'tv', purpose: 'TV episodes on the Calendar.',
      url: 'integration.sonarr.url', placeholder: 'http://192.168.1.10:8989',
      secret: ['integration.sonarr.api_key', 'API key', 'In Sonarr: Settings → General → API key.'] },
    radarr: { name: 'Radarr', icon: 'movie', purpose: 'Movie releases on the Calendar.',
      url: 'integration.radarr.url', placeholder: 'http://192.168.1.10:7878',
      secret: ['integration.radarr.api_key', 'API key', 'In Radarr: Settings → General → API key.'] },
    uptime_kuma: { name: 'Uptime Kuma', icon: 'monitor_heart', purpose: 'Service Health on the home page.',
      url: 'integration.uptime_kuma.url', placeholder: 'http://192.168.1.10:3001',
      extra: [['integration.uptime_kuma.slug', 'Status page slug', 'The last part of your status page address.']],
      note: 'Choose which services appear on the home page in Pages → Home.' },
    netdata: { name: 'Netdata', icon: 'speed', purpose: 'CPU, memory and network gauges on the home page.',
      url: 'integration.netdata.url', placeholder: 'http://192.168.1.10:19999',
      secret: ['integration.netdata.api_key', 'API token', 'Only needed if your Netdata asks for one.'], netdata: true }
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
    typeInstead: 'Type the values instead.'
  };

  function keysOf(id) {
    var c = CARDS[id], keys = [];
    if (c.url) keys.push(c.url);
    if (c.secret) keys.push(c.secret[0]);
    (c.extra || []).forEach(function (x) { keys.push(x[0]); });
    if (c.chaptarr) CHAPTARR_KEYS.forEach(function (x) { keys.push(x[0]); });
    if (c.netdata) keys = keys.concat(NETDATA_KEYS);
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

  WSSettings.registerTab('integrations', {
    mount: function (panel, api) {
      var cards = {};
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
        return fetch(url, { credentials: 'same-origin' }).then(function (r) {
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
        fetch('/api/admin/chaptarr/options', { credentials: 'same-origin' }).then(readJson, function () {
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
        var root = el('section', 'scroll-mt-6 rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] ' +
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
        var when = el('span', 'text-frosted-blue/45 shrink-0');
        status.appendChild(light);
        status.appendChild(reason);
        status.appendChild(when);
        text.appendChild(status);
        head.appendChild(text);
        var chev = icon('expand_more', 'text-[22px] text-frosted-blue/45 transition-transform');
        head.appendChild(chev);
        root.appendChild(head);

        var body = el('div', 'hidden border-t border-frosted-blue/10 p-5 space-y-5');
        body.id = 'integration-body-' + id;
        head.setAttribute('aria-controls', body.id);
        var grid = el('div', 'grid sm:grid-cols-2 gap-5 ' + cls.fieldWidth);
        if (c.url) grid.appendChild(api.text({ key: c.url, label: 'Address', inputType: 'url', placeholder: c.placeholder }));
        if (c.secret) grid.appendChild(api.secret({ key: c.secret[0], label: c.secret[1], help: c.secret[2] }));
        (c.extra || []).forEach(function (x) { grid.appendChild(api.text({ key: x[0], label: x[1], help: x[2] })); });
        body.appendChild(grid);
        if (c.chaptarr) chaptarrFields(body);
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
        actions.appendChild(testBtn);
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
          body.classList.toggle('hidden', !open);
          chev.style.transform = open ? 'rotate(180deg)' : '';
        }
        head.addEventListener('click', function () { expand(head.getAttribute('aria-expanded') !== 'true'); });
        // A link from another tab (WSSettings.go) scrolls here and focuses the
        // card: it opens, and focus moves to its header. A click inside an
        // open card that lands on blank space leaves it alone.
        root.addEventListener('focus', function (e) {
          if (e.relatedTarget && root.contains(e.relatedTarget)) return;
          if (head.getAttribute('aria-expanded') !== 'true') expand(true);
          head.focus({ preventScroll: true });
        });

        testBtn.addEventListener('click', function () {
          var payload = { service: id, url: c.url ? api.get(c.url) : '',
                          credentials: c.secret ? api.get(c.secret[0]) : null };
          if (id === 'uptime_kuma') payload.slug = api.get('integration.uptime_kuma.slug');
          var mine = ++testSeq;
          showResult('checking', MSG.testing);
          testBtn.disabled = true;
          fetch('/api/admin/test-connection', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            credentials: 'same-origin'
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
        });

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
        });

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
          if (touches(keys, keysOf(id))) { cards[id].clearResult(); refresh(id); }
        });
        if (chaptarr && touches(keys, CHAPTARR_CONN)) loadChoices();
      });
      api.onDiscard(function () {
        Object.keys(cards).forEach(function (id) { cards[id].clearResult(); });
      });
      // "checked … ago" keeps counting while the tab is open.
      if (window.WS && WS.poll) {
        WS.poll(function () { Object.keys(cards).forEach(function (id) { if (health[id]) paint(id); }); }, 30000);
      }
      // Signed in with Plex: ask before a save clears or changes the Plex
      // address or token, the way the Sign-in tab asks about its own switches.
      WSSettings.ownSignIn.guard(api, { plex: ['integration.plex.url', 'integration.plex.token'] }, { askOnChange: true });
      // Not returned: the tab shows at once and the lights fill in.
      refresh();
    }
  });
})();
