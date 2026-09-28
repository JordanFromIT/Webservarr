/**
 * WebServarr — Service Worker
 *
 * Push notifications and notification clicks. Nothing else: page prefetch is
 * the soft-navigation router's (router.js), so the worker keeps no page cache
 * and handles no fetch.
 */

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  // Drop every page cache an earlier worker kept (ws-pages-*, from before the
  // router took over prefetch), so none outlives the update.
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) {
        return name.indexOf('ws-pages-') === 0;
      }).map(function (name) { return caches.delete(name); }));
    }).then(function () { return self.clients.claim(); })
  );
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
