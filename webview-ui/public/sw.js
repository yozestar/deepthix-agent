// Remote access: shows the agent's push notifications (new connection,
// pairing request) even when the home-screen app is closed.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Elyone', {
      body: data.body || '',
      icon: '/brand/app-icon-256.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (windows.length > 0) return windows[0].focus();
      return self.clients.openWindow('/');
    }),
  );
});
