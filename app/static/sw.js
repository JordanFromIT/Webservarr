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

var PAGE_CACHE = 'ws-pages-v1';
var PAGE_TTL_MS = 30 * 1000;
var pending = {};

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

function prefetchPage(key) {
  if (pending[key]) return pending[key];
  var p = fetch(key, { credentials: 'same-origin', headers: { 'X-WS-Prefetch': '1' } })
    .then(function (res) {
      var type = res.headers.get('content-type') || '';
      // A redirect means the session is gone (login page); never cache that.
      if (!res.ok || res.redirected || type.indexOf('text/html') === -1) return null;
      var headers = new Headers(res.headers);
      headers.set('X-WS-Cached-At', String(Date.now()));
      return res.arrayBuffer().then(function (body) {
        return caches.open(PAGE_CACHE).then(function (cache) {
          return cache.put(key, new Response(body, { status: 200, headers: headers }));
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
    var hit = await cache.match(key);
    if (hit) {
      await cache.delete(key);                  // single use
      var at = Number(hit.headers.get('X-WS-Cached-At') || 0);
      if (Date.now() - at < PAGE_TTL_MS) return hit;
    }
    return fetch(req);
  })());
});

self.addEventListener('push', function(event) {
  var payload = { title: 'WebServarr', body: 'You have a new notification.', category: 'general', url: '/' };

  if (event.data) {
    try {
      var data = event.data.json();
      if (data.title) payload.title = data.title;
      if (data.body) payload.body = data.body;
      if (data.category) payload.category = data.category;
      if (data.url) payload.url = data.url;
    } catch (e) {
      // If JSON parsing fails, use the text as body
      payload.body = event.data.text() || payload.body;
    }
  }

  var options = {
    body: payload.body,
    icon: '/static/uploads/logo.png',
    badge: '/static/uploads/logo.png',
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

  // Resolve relative URLs against the service worker origin
  var targetUrl = new URL(url, self.location.origin).href;

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
