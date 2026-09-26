/**
 * WebServarr — Service Worker
 *
 * 1. Push notifications and notification clicks.
 * 2. Page prefetch: the shell asks for the next page while the pointer is over
 *    its link (shell.js); the document is fetched here and handed to the
 *    navigation that follows, so a click lands on a page already in hand.
 *    Entries are single-use and expire after 30 s, so nothing stale can be
 *    served twice, and the cache is cleared on sign-out.
 */

var PAGE_CACHE = 'ws-pages-v2';
var PAGE_TTL_MS = 30 * 1000;
var pending = {};
// key -> ms the worker itself cached that page. Lives only in worker memory, so
// page scripts (incl. an XSS) can't forge it. The fetch handler serves a cached
// page ONLY when its key is in here, which stops an attacker who can write the
// Cache API from planting a page the worker will replay.
var prefetched = new Map();

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  // Drop every prefetch cache a previous worker left, under this name or an
  // older one (a PAGE_CACHE bump), so a poisoned or stale entry can't survive
  // a service-worker update.
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) {
        return name.indexOf('ws-pages-') === 0;
      }).map(function (name) { return caches.delete(name); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function prefetchPage(key) {
  if (pending[key]) return pending[key];
  var p = fetch(key, { credentials: 'same-origin', headers: { 'X-WS-Prefetch': '1' } })
    .then(function (res) {
      var type = res.headers.get('content-type') || '';
      // A redirect means the session is gone (login page); never cache that.
      if (!res.ok || res.redirected || type.indexOf('text/html') === -1) return null;
      var cachedAt = Date.now();
      var headers = new Headers(res.headers);
      headers.set('X-WS-Cached-At', String(cachedAt));
      return res.arrayBuffer().then(function (body) {
        return caches.open(PAGE_CACHE).then(function (cache) {
          return cache.put(key, new Response(body, { status: 200, headers: headers })).then(function () {
            prefetched.set(key, cachedAt);   // mark it as worker-prefetched
          });
        });
      });
    })
    .catch(function () { return null; })
    .then(function (v) { delete pending[key]; return v; });
  pending[key] = p;
  return p;
}

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'prefetch' && typeof data.url === 'string') {
    var u = new URL(data.url, self.location.origin);
    if (u.origin === self.location.origin && u.pathname.indexOf('/auth/') !== 0) {
      prefetchPage(u.pathname + u.search);
    }
  } else if (data.type === 'clear-pages') {
    prefetched.clear();
    event.waitUntil(caches.delete(PAGE_CACHE));
  }
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var key = url.pathname + url.search;

  event.respondWith((async function () {
    var cache = await caches.open(PAGE_CACHE);
    if (pending[key]) await pending[key];       // the click beat the prefetch: wait for it
    // Only replay a page THIS worker prefetched (key present in the in-memory
    // Map), so a Cache API write from a page script can't be served back.
    var prefetchedAt = prefetched.get(key);
    if (prefetchedAt !== undefined) {
      prefetched.delete(key);                   // single use
      var hit = await cache.match(key);
      if (hit) {
        await cache.delete(key);                // single use
        var at = Number(hit.headers.get('X-WS-Cached-At') || 0);
        // Ignore a future timestamp (poisoned), and gate freshness on the
        // trusted in-worker time so a tampered entry can't extend its own life.
        if (at <= Date.now() && Date.now() - prefetchedAt < PAGE_TTL_MS) return hit;
      }
    }
    return fetch(req);
  })());
});

// The server sends the operator's logo when it is a same-origin path; anything
// else falls back to the bundled logo so the notification never shows a
// broken image. A PNG, because Chromium does not rasterise SVG notification
// icons. Keep in step with DEFAULT_PUSH_ICON in app/services/push.py.
var DEFAULT_ICON = '/static/webservarr-192.png';

function sameOriginPath(value) {
  try {
    var u = new URL(value, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search : '';
  } catch (e) {
    return '';
  }
}

// Chromium does not rasterise SVG notification icons (the shipped default
// logo is one), so an .svg path falls back to the bundled PNG as well.
function rasterIcon(value) {
  var path = sameOriginPath(value);
  if (!path) return DEFAULT_ICON;
  var file = path.split('#')[0].split('?')[0];
  return /\.svg$/i.test(file) ? DEFAULT_ICON : path;
}

self.addEventListener('push', function(event) {
  var payload = { title: 'WebServarr', body: 'You have a new notification.', category: 'general', url: '/', icon: DEFAULT_ICON };

  if (event.data) {
    try {
      var data = event.data.json();
      if (data.title) payload.title = data.title;
      if (data.body) payload.body = data.body;
      if (data.category) payload.category = data.category;
      if (data.url) payload.url = data.url;
      if (data.icon) payload.icon = rasterIcon(data.icon);
    } catch (e) {
      // If JSON parsing fails, use the text as body
      payload.body = event.data.text() || payload.body;
    }
  }

  var options = {
    body: payload.body,
    icon: payload.icon,
    // No badge: Android draws it as a monochrome alpha mask, which turns a
    // full-colour logo into a flat blob. The platform default is cleaner.
    tag: payload.category,
    data: {
      url: payload.url,
      category: payload.category
    },
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  var url = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/';

  // Resolve relative URLs against the service worker origin, and only ever
  // open/navigate to a same-origin URL. Anything cross-origin (or unparseable)
  // in the push payload falls back to the app root.
  var rootUrl = new URL('/', self.location.origin).href;
  var targetUrl;
  try {
    var parsed = new URL(url, self.location.origin);
    targetUrl = parsed.origin === self.location.origin ? parsed.href : rootUrl;
  } catch (e) {
    targetUrl = rootUrl;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Try to focus an existing tab at the same origin
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      // No existing tab found — open a new one
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
