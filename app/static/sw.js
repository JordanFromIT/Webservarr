/**
 * HMS Dashboard — Service Worker
 * Handles push notifications and notification click events.
 */

self.addEventListener('push', function(event) {
  var payload = { title: 'HMS Dashboard', body: 'You have a new notification.', category: 'general', url: '/' };

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
