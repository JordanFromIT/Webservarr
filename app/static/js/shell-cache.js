/**
 * WebServarr — sessionStorage stale-while-revalidate for shell data.
 * Paint from cache synchronously, refresh in the background, repaint only
 * if the answer changed. Display-only: authorization stays server-side.
 */
window.wsCache = (function () {
  // Bumped by clear() (logout, or a 401 discovered mid-request). A fetch
  // that was already in flight when that happened cannot be cancelled --
  // location.href doesn't abort pending promises -- so every swr()
  // continuation checks this against the generation it started with and
  // silently drops its own result (no sessionStorage write, no repaint) if
  // it moved. Otherwise a slow request racing a logout could write the
  // previous session's identity/status/notifications back into
  // sessionStorage just after clear() ran, where it would survive into the
  // next sign-in on the same tab.
  var generation = 0;

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
    generation++;
    try {
      Object.keys(sessionStorage).forEach(function (k) {
        if (k.indexOf('ws.') === 0) sessionStorage.removeItem(k);
      });
    } catch (e) {}
  }
  function swr(key, url, maxAgeMs, apply) {
    var startGeneration = generation;
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
        // A clear() (logout, or the 401 branch above, from this call or
        // any other in-flight one) landed while this fetch was in the air.
        // Its answer is stale/foreign now -- surface it to the caller but
        // never let it touch storage or the DOM.
        if (generation !== startGeneration) return data;
        var changed = JSON.stringify(data) !== JSON.stringify(cached);
        write(key, data);
        if (changed) apply(data, false);
        return data;
      });
  }
  return { read: read, write: write, swr: swr, clear: clear };
})();
