/**
 * WebServarr — sessionStorage stale-while-revalidate for shell data.
 * Paint from cache synchronously, refresh in the background, repaint only
 * if the answer changed. Display-only: authorization stays server-side.
 */
window.wsCache = (function () {
  function read(key, maxAgeMs) {
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      var hit = JSON.parse(raw);
      if (maxAgeMs && Date.now() - hit.t > maxAgeMs) return null;
      return hit.d;
    } catch (e) { return null; }
  }
  function write(key, data) {
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data })); } catch (e) {}
  }
  function clear() {
    try {
      Object.keys(sessionStorage).forEach(function (k) {
        if (k.indexOf('ws.') === 0) sessionStorage.removeItem(k);
      });
    } catch (e) {}
  }
  function swr(key, url, maxAgeMs, apply) {
    var cached = read(key, null); // stale is fine for paint
    if (cached !== null) apply(cached, true);
    var fresh = read(key, maxAgeMs);
    if (fresh !== null) return Promise.resolve(fresh); // young enough, skip refetch
    return fetch(url, { credentials: 'include' })
      .then(function (r) {
        if (r.status === 401) { clear(); throw { unauthorized: true }; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var changed = JSON.stringify(data) !== JSON.stringify(cached);
        write(key, data);
        if (changed) apply(data, false);
        return data;
      });
  }
  return { read: read, write: write, swr: swr, clear: clear };
})();
