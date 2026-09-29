/**
 * WebServarr — audiobook playback engine (ES module, document-lifetime)
 *
 * One <audio> element in #wsPlayer, which soft navigation never touches, so
 * a book started on any page keeps playing on every page. Loaded once by the
 * shell partial after the router; not a page module: it lives as long as the
 * document, and its own timers and listeners are its to tear down (close()).
 * Design: docs/superpowers/specs/2026-09-28-audiobook-player-design.md,
 * sections 4, 6 and 9.
 *
 * A book is its parts (tracks) laid end to end: book time is the durations
 * of the parts before plus the offset in the current part. The audio streams
 * straight from the Plex server's own https connection, with the listener's
 * server token in the query string (an <audio> element cannot send headers).
 * That URL is built here, in memory, only when it is handed to an element's
 * src: the token is never logged, never in an error, an event or state(), and
 * never in the page except in that src.
 *
 * Connection: the local connection is tried first with a throwaway element
 * that loads only metadata (a fetch would be refused: connect-src is 'self'),
 * 1.5 s at most, else the remote one; the choice is kept for the page
 * session. When the stream fails, in order: the other connection at the same
 * offset; then a fresh token (GET /api/player/book/<key>?refresh=1) once;
 * then "Can't reach the media server" with a retry. A stream that stops
 * without an error (8 s waiting with nothing arriving) counts as a failure.
 * A part that 404s or will not decode while the connection is shown to work
 * (another part, or the same one, still loads its metadata there) is skipped
 * with a notice. The place (state().position, what the save loop stores)
 * never moves because of a failure: after a skipped part it stays where the
 * failed part stopped until the next part has really played (1 s of it), so a
 * run of broken parts never carries it past the first.
 *
 * Pure (importable by Node, no DOM at import time):
 *   toTrackOffset(tracks, bookMs)  -> { index, track, offset_ms } | null
 *   toBookMs(tracks, trackKey, offsetMs) -> number | null
 *   chapterAt(chapters, bookMs)    -> the chapter's position in the list, -1 if none
 *   createEngine(env)              the engine, given its surroundings (tests)
 *   boot(win, overrides)           mounts the engine in #wsPlayer as WS.player
 *
 * In the browser, window.WS.player:
 *   open(key, { at: { track, offset_ms }, autoplay }) -> Promise<void>
 *       loads the book (at its start, or at the place given) and plays it
 *       (autoplay false: loads only). Resolves once playback is set going;
 *       a failure is an 'error' event and state().error, never a rejection.
 *   play(), pause(), toggle()
 *   seek(bookMs), skip(deltaS), jumpToChapter(i)   i: a position in state().chapters
 *   setSpeed(x)       0.75 to 2 in 0.05 steps (clamped, rounded); returns the speed
 *   retry()           after an error: again from the place
 *   close()           stops and forgets the book
 *   state()           { book (the key), title, author, narrator, series, cover,
 *                       chapters, chapterIndex, trackIndex, bookMs, bookDurationMs,
 *                       position: { track, offset_ms, duration_ms } | null,
 *                       playing, loading, speed, connection: 'local'|'remote'|null,
 *                       error: { code, message } | null, lastSavedAt, saveError }
 *       bookMs is the playhead (what to show); position is the place to save.
 *       They differ only while a skipped part's successor has not played yet.
 *   on(event, fn) -> unsubscribe; fn gets one object:
 *     'change'   { reason, state } and, for 'seek' | 'skip' | 'jump', from and to
 *                (book ms). reason: 'loading' (a book is being fetched), 'open'
 *                (its parts and chapters are known), 'play', 'pause', 'time' (the
 *                element's timeupdate while playing), 'seek', 'skip', 'jump',
 *                'part' (one part ended, the next starts at 0), 'part-skipped',
 *                'connection' (switched, or refreshed its token), 'speed',
 *                'ready' (loaded, not playing), 'retry', 'error', 'ended', 'close'
 *     'ended'    { state } at the end of the last part
 *     'error'    { code, message, retry: function | null }; code 'unreachable',
 *                'part', 'forbidden', 'not-found', 'signed-out', 'busy', 'empty'
 *     'warning'  { kind: 'part-skipped', message }
 */

export const PROBE_MS = 1500;          // the local connection's probe
export const STALL_MS = 8000;          // waiting with nothing arriving: the stream has failed
export const PLAYED_MS = 1000;         // this much real playback shows a part plays
export const SPEED_MIN = 0.75;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.05;
export const SKIP_S = 10;              // Media Session seek back and forward, until the listener's setting
export const UNREACHABLE = "Can't reach the media server";

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;

// ---------------------------------------------------------------------------
// Book time
// ---------------------------------------------------------------------------

function durationOf(track) {
  const d = Number(track && track.duration_ms);
  return isFinite(d) && d > 0 ? d : 0;
}

function clampNumber(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* The part and the offset in it for a book time. A part's first instant is
   that part's (the end of one part is the start of the next); the end of the
   book is the end of the last part; outside the book is clamped to it. */
export function toTrackOffset(tracks, bookMs) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  let ms = Number(bookMs);
  if (!isFinite(ms) || ms < 0) ms = 0;
  let start = 0;
  for (let i = 0; i < tracks.length; i++) {
    const d = durationOf(tracks[i]);
    if (ms < start + d || i === tracks.length - 1) {
      return { index: i, track: String(tracks[i].key), offset_ms: clampNumber(ms - start, 0, d) };
    }
    start += d;
  }
  return null;
}

/* The book time of an offset in a part (clamped to the part), or null for a
   part that is not the book's. */
export function toBookMs(tracks, trackKey, offsetMs) {
  if (!Array.isArray(tracks)) return null;
  let start = 0;
  for (let i = 0; i < tracks.length; i++) {
    const d = durationOf(tracks[i]);
    if (String(tracks[i].key) === String(trackKey)) {
      let off = Number(offsetMs);
      if (!isFinite(off)) off = 0;
      return start + clampNumber(off, 0, d);
    }
    start += d;
  }
  return null;
}

/* The chapter a book time is in, as its position in the list: the last one
   starting at or before it. An offset exactly on a chapter's start is that
   chapter's; the book's end (the last chapter's end) is the last chapter's;
   before the first is the first. -1 when there are none. */
export function chapterAt(chapters, bookMs) {
  if (!Array.isArray(chapters) || !chapters.length) return -1;
  const ms = Number(bookMs);
  let lo = 0;
  let hi = chapters.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(chapters[mid].start_ms) <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function roundSpeed(x) {
  const v = Number(x);
  if (!isFinite(v)) return null;
  const stepped = Math.round(v / SPEED_STEP) * SPEED_STEP;
  return Math.round(clampNumber(stepped, SPEED_MIN, SPEED_MAX) * 100) / 100;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/* env: { host (where the element goes), createAudio(), fetch, setTimeout,
   clearTimeout, mediaSession, MediaMetadata, baseUrl, skipSeconds }. */
export function createEngine(env) {
  const setT = env.setTimeout;
  const clearT = env.clearTimeout;
  const fetchFn = env.fetch;
  const session = env.mediaSession || null;
  const Metadata = env.MediaMetadata || null;
  const baseUrl = env.baseUrl || '';
  const skipS = env.skipSeconds || SKIP_S;

  const audio = env.createAudio();
  audio.preload = 'auto';
  if (audio.setAttribute) audio.setAttribute('data-ws-player-audio', '');
  if (env.host) env.host.appendChild(audio);

  const handlers = { change: new Set(), ended: new Set(), error: new Set(), warning: new Set() };

  // The book: { key, title, author, narrator, series, cover, tracks, starts,
  // durationMs, chapters }. The stream's token and URIs are kept apart from
  // it, and never leave this closure except inside an element's src.
  let book = null;
  let stream = null;
  let lastOpen = null;        // { key, opts } of the last open(), for its retry
  let openGen = 0;

  // Where: the loaded part and its connection, the playhead, where the load
  // is heading, and the place held after a skipped part.
  let cur = null;             // { index, side }
  let playhead = null;        // { index, offset }
  let target = null;          // { index, offset }
  let hold = null;            // { index, offset } | null

  // The load in progress. gen changes with every src handed to the element;
  // anything waiting (a probe, a refresh) checks it is still the same.
  let gen = 0;
  let pending = false;        // the element's time is not the playhead yet
  let seekApplied = false;
  let metaLoaded = false;
  let failedGen = -1;

  let wantPlay = false;
  let loading = false;
  let speed = 1;
  let error = null;           // { code, message }
  let errorRetry = null;

  // Connection: the choice kept for the page session, what has loaded on
  // each side with the current token, and the failure ladder's progress.
  let chosen = null;
  const proven = new Map();   // side -> index of a part that loaded there
  const tried = new Set();
  let refreshed = false;

  let watchdog = null;
  const probes = new Map();   // live probe element -> its finish(ok)
  let sessionReady = false;

  // ---- Events ----

  function emit(type, detail) {
    for (const fn of Array.from(handlers[type])) {
      try {
        fn(detail);
      } catch (e) {
        console.error('[player] a ' + type + ' listener failed', e);
      }
    }
  }

  function changed(reason, extra) {
    const detail = Object.assign({ reason: reason }, extra || {});
    detail.state = state();
    emit('change', detail);
    if (reason !== 'time') sessionPosition();
  }

  function setLoading(on) {
    loading = on;
  }

  // ---- State ----

  function bookMsNow() {
    if (!book || !playhead) return 0;
    return book.starts[playhead.index] + playhead.offset;
  }

  function state() {
    const bookMs = bookMsNow();
    const place = hold || playhead;
    return {
      book: book ? book.key : null,
      title: book ? book.title : '',
      author: book ? book.author : '',
      narrator: book ? book.narrator : '',
      series: book ? book.series : '',
      cover: book ? book.cover : '',
      chapters: book ? book.chapters : [],
      chapterIndex: book ? chapterAt(book.chapters, bookMs) : -1,
      trackIndex: book && playhead ? playhead.index : -1,
      bookMs: bookMs,
      bookDurationMs: book ? book.durationMs : 0,
      position: book && place ? {
        track: String(book.tracks[place.index].key),
        offset_ms: Math.round(place.offset),
        duration_ms: durationOf(book.tracks[place.index])
      } : null,
      playing: !!(book && wantPlay && !error),
      loading: loading,
      speed: speed,
      connection: book && cur ? cur.side : null,
      error: error ? { code: error.code, message: error.message } : null,
      lastSavedAt: null,
      saveError: false
    };
  }

  // ---- Streams ----

  function hasSide(side) {
    return !!(stream && stream.uris && Array.isArray(stream.uris[side]) && stream.uris[side].length);
  }

  function otherSide(side) {
    return side === 'local' ? 'remote' : 'local';
  }

  function preferredSide() {
    if (chosen && hasSide(chosen)) return chosen;
    if (hasSide('local')) return 'local';
    return hasSide('remote') ? 'remote' : null;
  }

  // Built only to be handed to an element's src, never stored or logged.
  function urlFor(side, index) {
    if (!hasSide(side) || !book || !book.tracks[index]) return '';
    const origin = String(stream.uris[side][0]).replace(/\/+$/, '');
    return origin + book.tracks[index].part_path + '?X-Plex-Token=' + encodeURIComponent(stream.token);
  }

  /* Does this side answer for this part? A throwaway element loads only its
     metadata, 1.5 s at most, and is then emptied so it holds no connection.
     Its handlers are properties, dropped with it. */
  function probe(side, index) {
    return new Promise(function (resolve) {
      const url = urlFor(side, index);
      if (!url) {
        resolve(false);
        return;
      }
      const el = env.createAudio();
      let timer = null;
      function finish(ok) {
        if (!probes.has(el)) return;
        probes.delete(el);
        clearT(timer);
        el.onloadedmetadata = null;
        el.onerror = null;
        try {
          el.removeAttribute('src');
          el.load();
        } catch (e) { /* nothing to release */ }
        if (ok) proven.set(side, index);
        resolve(ok);
      }
      probes.set(el, finish);
      el.preload = 'metadata';
      el.muted = true;
      el.onloadedmetadata = function () { finish(true); };
      el.onerror = function () { finish(false); };
      timer = setT(function () { finish(false); }, PROBE_MS);
      el.src = url;
    });
  }

  async function chooseSide(index) {
    const kept = preferredSide();
    if (chosen && kept === chosen) return chosen;
    if (hasSide('local')) {
      if (await probe('local', index)) return 'local';
      return hasSide('remote') ? 'remote' : 'local';
    }
    return kept;
  }

  // ---- Loading a part ----

  function applyRate() {
    try {
      audio.defaultPlaybackRate = speed;
      audio.playbackRate = speed;
    } catch (e) { /* not while the element has no media */ }
  }

  function load(index, offset, side) {
    gen += 1;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    disarm();
    cur = { index: index, side: side };
    target = { index: index, offset: offset };
    playhead = { index: index, offset: offset };
    setLoading(true);
    audio.src = urlFor(side, index);
    applyRate();
    if (wantPlay) startPlay();
  }

  function startPlay() {
    const g = gen;
    arm();
    let p = null;
    try {
      p = audio.play();
    } catch (e) {
      p = null;
    }
    if (p && typeof p.catch === 'function') {
      p.catch(function (e) {
        // A newer load interrupted it (AbortError), or the element failed
        // (its error event handles that). Only a refusal is the listener's.
        if (g !== gen || !wantPlay || !e || e.name !== 'NotAllowedError') return;
        wantPlay = false;
        disarm();
        if (metaLoaded) setLoading(false);
        sessionState();
        changed('pause');
      });
    }
  }

  // ---- The stall watchdog ----

  function arm() {
    disarm();
    const g = gen;
    watchdog = setT(function () {
      watchdog = null;
      if (g === gen && book && wantPlay) fail('network');
    }, STALL_MS);
  }

  function disarm() {
    if (watchdog !== null) {
      clearT(watchdog);
      watchdog = null;
    }
  }

  // ---- The element ----

  audio.addEventListener('loadedmetadata', function () {
    if (!book || !cur || !pending) return;
    metaLoaded = true;
    proven.set(cur.side, cur.index);
    applyRate();
    if (!seekApplied) {
      if (target.offset > 0) {
        try {
          audio.currentTime = target.offset / 1000;
        } catch (e) { /* applied on the next seek */ }
      }
      seekApplied = true;
    }
    if (!wantPlay && loading) {
      setLoading(false);
      changed('ready');
    }
  });

  audio.addEventListener('progress', function () {
    // Data is arriving: the connection is alive, whatever the playhead does.
    if (watchdog !== null && wantPlay) arm();
  });

  audio.addEventListener('waiting', function () {
    if (book && wantPlay) arm();
  });

  audio.addEventListener('playing', function () {
    if (!book || !cur) return;
    disarm();
    if (pending && seekApplied) pending = false;
    // This connection works: the failure ladder starts afresh next time.
    chosen = cur.side;
    tried.clear();
    refreshed = false;
    if (loading) {
      setLoading(false);
      changed('play');
    }
  });

  audio.addEventListener('timeupdate', function () {
    if (!book || !cur) return;
    if (pending) {
      if (!seekApplied || audio.seeking) return;
      pending = false;
    }
    const d = durationOf(book.tracks[cur.index]);
    let off = Math.round(Number(audio.currentTime) * 1000);
    if (!isFinite(off) || off < 0) off = 0;
    if (off > d) off = d;
    const moved = !playhead || playhead.index !== cur.index || playhead.offset !== off;
    playhead = { index: cur.index, offset: off };
    if (hold && !audio.paused && off >= target.offset + PLAYED_MS) hold = null;
    if (moved && wantPlay && !audio.paused) disarm();
    changed('time');
  });

  audio.addEventListener('play', function () {
    // Started from outside the engine (the browser's own controls).
    if (!book || pending || wantPlay || error) return;
    wantPlay = true;
    sessionState();
    changed('play');
  });

  audio.addEventListener('pause', function () {
    // The element pauses itself at the end of a part and when its src
    // changes; anything else is the browser or the system pausing it.
    if (!book || pending || audio.ended || !wantPlay) return;
    wantPlay = false;
    disarm();
    sessionState();
    changed('pause');
  });

  audio.addEventListener('ended', function () {
    if (!book || !cur || !audio.ended) return;
    const i = cur.index;
    hold = null;
    if (i + 1 < book.tracks.length) {
      load(i + 1, 0, cur.side);
      changed('part');
      return;
    }
    playhead = { index: i, offset: durationOf(book.tracks[i]) };
    wantPlay = false;
    disarm();
    setLoading(false);
    sessionState();
    changed('ended');
    emit('ended', { state: state() });
  });

  audio.addEventListener('error', function () {
    const err = audio.error;
    if (!book || !cur || !err || err.code === MEDIA_ERR_ABORTED) return;
    fail(err.code === MEDIA_ERR_NETWORK ? 'network' : 'media');
  });

  // ---- Failures ----

  /* The stream failed at the playhead. kind: 'network' (the connection
     dropped or stalled) or 'media' (the part would not load or decode). */
  async function fail(kind) {
    if (failedGen === gen || !book || !cur) return;
    failedGen = gen;
    const g = gen;
    pending = true;
    metaLoaded = false;
    disarm();
    const at = { index: playhead.index, offset: playhead.offset };
    const side = cur.side;
    setLoading(true);

    // A part that will not play where the connection is shown to work.
    if (kind === 'media' && proven.has(side)) {
      const ok = await probe(side, verifyIndex(side, at.index));
      if (g !== gen) return;
      if (ok) {
        skipPart(at, side);
        return;
      }
    }

    // 1. The other connection, at the same offset.
    tried.add(side);
    const other = otherSide(side);
    if (hasSide(other) && !tried.has(other)) {
      load(at.index, at.offset, other);
      changed('connection');
      return;
    }

    // 2. A fresh token and connections, once.
    if (!refreshed) {
      refreshed = true;
      let data = null;
      try {
        data = await fetchBook(book.key, true);
      } catch (e) {
        data = null;
      }
      if (g !== gen || !book) return;
      if (data) {
        stream = { token: String(data.stream.token || ''), uris: data.stream.uris || {} };
        proven.clear();
        tried.clear();
        const next = preferredSide();
        if (next) {
          load(at.index, at.offset, next);
          changed('connection');
          return;
        }
      }
    }

    // 3. The server answers for another part: this one is the problem.
    if (book.tracks.length > 1) {
      const s = preferredSide();
      if (s && await probe(s, verifyIndex(s, at.index))) {
        if (g !== gen) return;
        skipPart(at, s);
        return;
      }
      if (g !== gen) return;
    }

    stopWith('unreachable', UNREACHABLE, retry);
  }

  // A part to test the connection with: one that loaded there, else a
  // neighbour, else (a single file) the part itself.
  function verifyIndex(side, index) {
    const good = proven.get(side);
    if (good !== undefined && good !== index) return good;
    if (index > 0) return index - 1;
    if (index + 1 < book.tracks.length) return index + 1;
    return index;
  }

  function skipPart(at, side) {
    if (!hold) hold = { index: at.index, offset: at.offset };
    const n = book.tracks.length;
    emit('warning', {
      kind: 'part-skipped',
      message: 'Part ' + (at.index + 1) + ' of ' + n + " couldn't be played, so it was skipped."
    });
    if (at.index + 1 < n) {
      load(at.index + 1, 0, side);
      changed('part-skipped');
      return;
    }
    cur = { index: at.index, side: side };
    stopWith('part', "The rest of this book couldn't be played.", retry);
  }

  function stopWith(code, message, retryFn) {
    wantPlay = false;
    pending = true;
    metaLoaded = false;
    disarm();
    try {
      audio.pause();
    } catch (e) { /* already */ }
    release();
    setLoading(false);
    error = { code: code, message: message };
    errorRetry = retryFn || null;
    sessionState();
    emit('error', { code: code, message: message, retry: errorRetry });
    changed('error');
  }

  // Empty the element, so it holds no connection and no URL.
  function release() {
    if (audio.getAttribute && audio.getAttribute('src') === null) return;
    try {
      audio.removeAttribute('src');
      audio.load();
    } catch (e) { /* nothing held */ }
  }

  // ---- The book ----

  async function fetchBook(key, refresh) {
    let resp;
    try {
      resp = await fetchFn('/api/player/book/' + encodeURIComponent(key) + (refresh ? '?refresh=1' : ''), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
    } catch (e) {
      throw { status: 0, detail: '' };
    }
    if (!resp.ok) {
      let detail = '';
      try {
        const body = await resp.json();
        if (body && typeof body.detail === 'string' && body.detail.length <= 200) detail = body.detail;
      } catch (e) { /* no body */ }
      throw { status: resp.status, detail: detail };
    }
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw { status: 0, detail: '' };
    }
    if (!data || !Array.isArray(data.tracks) || !data.stream || typeof data.stream !== 'object') {
      throw { status: 0, detail: '' };
    }
    return data;
  }

  function makeBook(key, data) {
    const tracks = data.tracks.map(function (t) {
      return Object.freeze({
        key: String(t.key),
        part_path: String(t.part_path || ''),
        duration_ms: durationOf(t),
        index: t.index
      });
    });
    const starts = [];
    let sum = 0;
    tracks.forEach(function (t) {
      starts.push(sum);
      sum += t.duration_ms;
    });
    const chapters = Object.freeze((Array.isArray(data.chapters) ? data.chapters : []).map(function (c) {
      return Object.freeze(Object.assign({}, c));
    }));
    return {
      key: key,
      title: String(data.title || ''),
      author: String(data.author || ''),
      narrator: String(data.narrator || ''),
      series: String(data.series || ''),
      cover: String(data.cover || ''),
      tracks: tracks,
      starts: starts,
      durationMs: sum,
      chapters: chapters
    };
  }

  function openError(e, retryFn) {
    const status = e && typeof e.status === 'number' ? e.status : 0;
    const detail = e && e.detail ? e.detail : '';
    if (status === 401) return { code: 'signed-out', message: 'Your session has ended. Sign in again to listen.', retry: null };
    if (status === 403) return { code: 'forbidden', message: detail || "Your account can't play audiobooks here.", retry: null };
    if (status === 404) return { code: 'not-found', message: "This book isn't available.", retry: null };
    if (status === 429) return { code: 'busy', message: 'Too many requests. Try again in a moment.', retry: retryFn };
    return { code: 'unreachable', message: UNREACHABLE, retry: retryFn };
  }

  // Stops whatever plays and forgets the book (the connection choice stays).
  function teardown() {
    gen += 1;
    wantPlay = false;
    pending = true;
    metaLoaded = false;
    disarm();
    Array.from(probes.values()).forEach(function (finish) { finish(false); });
    try {
      audio.pause();
    } catch (e) { /* already */ }
    release();
    book = null;
    stream = null;
    cur = null;
    playhead = null;
    target = null;
    hold = null;
    error = null;
    errorRetry = null;
    setLoading(false);
    proven.clear();
    tried.clear();
    refreshed = false;
  }

  async function open(key, opts) {
    opts = opts || {};
    key = key == null ? '' : String(key);
    if (!key) return;
    const autoplay = opts.autoplay !== false;
    if (book && book.key === key && !opts.at && !error) {
      if (autoplay) await play();
      return;
    }
    const my = ++openGen;
    teardown();
    lastOpen = { key: key, opts: opts };
    setLoading(true);
    changed('loading');
    let data;
    try {
      data = await fetchBook(key, false);
    } catch (e) {
      if (my !== openGen) return;
      const err = openError(e, function () { return open(key, opts); });
      setLoading(false);
      error = { code: err.code, message: err.message };
      errorRetry = err.retry;
      emit('error', err);
      changed('error');
      return;
    }
    if (my !== openGen) return;
    book = makeBook(key, data);
    stream = { token: String(data.stream.token || ''), uris: data.stream.uris || {} };
    if (!book.tracks.length) {
      stopWith('empty', 'This book has nothing to play.', null);
      return;
    }
    let startMs = 0;
    if (opts.at && typeof opts.at === 'object') {
      const b = toBookMs(book.tracks, opts.at.track, opts.at.offset_ms);
      if (b !== null) startMs = b;
    }
    const to = toTrackOffset(book.tracks, startMs);
    playhead = { index: to.index, offset: to.offset_ms };
    target = { index: to.index, offset: to.offset_ms };
    installSession();
    sessionMetadata();
    changed('open');
    const side = await chooseSide(to.index);
    if (my !== openGen || !book) return;
    if (!side) {
      stopWith('unreachable', UNREACHABLE, retry);
      return;
    }
    chosen = side;
    wantPlay = autoplay || wantPlay;
    load(playhead.index, playhead.offset, side);
    sessionState();
    changed(wantPlay ? 'play' : 'ready');
  }

  // ---- Controls ----

  function atEnd() {
    return !!(book && playhead && playhead.index === book.tracks.length - 1 &&
      playhead.offset >= durationOf(book.tracks[playhead.index]));
  }

  function play() {
    if (!book) return Promise.resolve();
    if (error) return retry();
    if (wantPlay) return Promise.resolve();
    wantPlay = true;
    if (!cur) {
      // Still choosing a connection: open() starts it.
      changed('play');
      return Promise.resolve();
    }
    if (atEnd()) {
      hold = null;
      load(0, 0, cur.side);
    } else {
      startPlay();
    }
    sessionState();
    changed('play');
    return Promise.resolve();
  }

  function pause() {
    if (!book || !wantPlay) return;
    wantPlay = false;
    disarm();
    try {
      audio.pause();
    } catch (e) { /* already */ }
    sessionState();
    changed('pause');
  }

  function toggle() {
    if (wantPlay) pause();
    else return play();
  }

  function seek(bookMs, reason) {
    if (!book || !playhead) return;
    const v = Number(bookMs);
    if (!isFinite(v)) return;
    const from = bookMsNow();
    const to = toTrackOffset(book.tracks, clampNumber(v, 0, book.durationMs));
    hold = null;
    const next = { index: to.index, offset: to.offset_ms };
    if (error || !cur) {
      // Nothing loaded (an error, or still choosing): the place moves, and
      // play or retry loads it.
      playhead = next;
      target = { index: next.index, offset: next.offset };
    } else if (to.index === cur.index && metaLoaded) {
      playhead = next;
      target = { index: next.index, offset: next.offset };
      seekApplied = true;
      try {
        audio.currentTime = next.offset / 1000;
      } catch (e) { /* applied with the next load */ }
    } else if (to.index === cur.index && pending && !seekApplied && failedGen !== gen) {
      // Its metadata is still loading: it seeks there when it arrives. (A
      // load that failed is loaded again, which also ends its recovery.)
      playhead = next;
      target = { index: next.index, offset: next.offset };
    } else {
      load(next.index, next.offset, cur.side);
    }
    changed(reason || 'seek', { from: from, to: bookMsNow() });
  }

  function skip(deltaS) {
    const d = Number(deltaS);
    if (!book || !isFinite(d)) return;
    seek(bookMsNow() + d * 1000, 'skip');
  }

  function jumpToChapter(i) {
    if (!book) return;
    const c = book.chapters[Number(i)];
    if (!c) return;
    seek(Number(c.start_ms), 'jump');
  }

  function setSpeed(x) {
    const v = roundSpeed(x);
    if (v === null) return speed;
    speed = v;
    applyRate();
    changed('speed');
    return speed;
  }

  function retry() {
    if (!book) {
      if (lastOpen) return open(lastOpen.key, lastOpen.opts);
      return Promise.resolve();
    }
    if (!error || !playhead) return Promise.resolve();
    const side = preferredSide();
    error = null;
    errorRetry = null;
    tried.clear();
    refreshed = false;
    failedGen = -1;
    wantPlay = true;
    if (!side) {
      stopWith('unreachable', UNREACHABLE, retry);
      return Promise.resolve();
    }
    load(playhead.index, playhead.offset, side);
    sessionState();
    changed('retry');
    return Promise.resolve();
  }

  function close() {
    openGen += 1;
    const had = !!(book || error);
    teardown();
    lastOpen = null;
    if (session) {
      try {
        session.metadata = null;
        session.playbackState = 'none';
      } catch (e) { /* not supported */ }
    }
    if (had) changed('close');
  }

  function on(type, fn) {
    const set = handlers[type];
    if (!set || typeof fn !== 'function') return function () {};
    set.add(fn);
    return function () { set.delete(fn); };
  }

  // ---- Media Session (lock screen, headphones, keyboard media keys) ----

  function installSession() {
    if (!session || sessionReady || typeof session.setActionHandler !== 'function') return;
    sessionReady = true;
    const actions = {
      play: function () { play(); },
      pause: function () { pause(); },
      seekbackward: function (d) { skip(-((d && d.seekOffset) || skipS)); },
      seekforward: function (d) { skip((d && d.seekOffset) || skipS); },
      seekto: function (d) {
        if (d && isFinite(d.seekTime)) seek(Number(d.seekTime) * 1000);
      },
      // Chapters are not skip buttons: no previous and next track.
      previoustrack: null,
      nexttrack: null
    };
    Object.keys(actions).forEach(function (name) {
      try {
        session.setActionHandler(name, actions[name]);
      } catch (e) { /* this browser has no such action */ }
    });
  }

  function sessionMetadata() {
    if (!session) return;
    try {
      if (!book || !Metadata) {
        session.metadata = null;
        return;
      }
      const artwork = [];
      if (book.cover) artwork.push({ src: new URL(book.cover, baseUrl).href });
      session.metadata = new Metadata({ title: book.title, artist: book.author, album: book.series, artwork: artwork });
    } catch (e) { /* not supported */ }
  }

  function sessionState() {
    if (!session) return;
    try {
      session.playbackState = !book ? 'none' : (wantPlay && !error ? 'playing' : 'paused');
    } catch (e) { /* not supported */ }
  }

  function sessionPosition() {
    if (!session || typeof session.setPositionState !== 'function' || !book || !(book.durationMs > 0)) return;
    try {
      session.setPositionState({
        duration: book.durationMs / 1000,
        playbackRate: speed,
        position: Math.min(bookMsNow(), book.durationMs) / 1000
      });
    } catch (e) { /* not supported */ }
  }

  return {
    open: open,
    play: play,
    pause: pause,
    toggle: toggle,
    seek: function (bookMs) { seek(bookMs, 'seek'); },
    skip: skip,
    jumpToChapter: jumpToChapter,
    setSpeed: setSpeed,
    retry: retry,
    close: close,
    state: state,
    on: on
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/* Mounts the engine in #wsPlayer as WS.player, once per document. Its fetch
   and timers are the window's own, taken now. Returns the engine, or null on
   a page without the shell. */
export function boot(win, overrides) {
  const WS = win.WS || (win.WS = {});
  if (WS.player) return WS.player;
  const doc = win.document;
  const host = doc.getElementById('wsPlayer');
  if (!host) return null;
  const nav = win.navigator || {};
  const engine = createEngine(Object.assign({
    host: host,
    createAudio: function () { return doc.createElement('audio'); },
    fetch: win.fetch.bind(win),
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    mediaSession: nav.mediaSession || null,
    MediaMetadata: win.MediaMetadata || null,
    baseUrl: win.location.href
  }, overrides || {}));
  WS.player = engine;
  return engine;
}

if (typeof window !== 'undefined' && window.document) boot(window);
