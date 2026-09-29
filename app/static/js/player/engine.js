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
 * session. Where the browser gates private addresses behind a Local Network
 * Access prompt, local is tried only if that permission is already granted:
 * the engine never makes the browser ask. When the stream fails, in order:
 * the other connection at the same offset; then a fresh token
 * (GET /api/player/book/<key>?refresh=1) once; then "Can't reach the media
 * server" with a retry. A stream that stops without an error (8 s waiting
 * with nothing arriving) counts as a failure. Only a part that will not load
 * or decode (never a dropped connection) can be skipped, with a notice, and
 * only when it fails that way twice, the second time on a connection just
 * shown to work (another part, or the same one, loads its metadata there).
 * The place (state().position, what the save loop stores) never moves
 * because of a failure, and is frozen in the error state: after a skipped
 * part it stays where the failed part stopped until the next part has really
 * played (1 s of it), so a run of broken parts never carries it past the
 * first.
 *
 * Formats (spec 11a): before a part is loaded or probed, the browser is asked
 * (canPlayType, with the container and codec Plex reports) whether it can
 * decode it. If it says it cannot, the part streams from Plex's own
 * transcoder on the same connection, as MP3, from a session the server asks
 * Plex for (POST /api/player/transcode/<key>). The stream cannot seek: a seek
 * starts it again at the new place once the seeking settles, and the
 * element's time counts from there, so the place (track, offset) means the
 * same in both modes; the part's length is always Plex's, never the
 * element's. Failures take the same ladder. A part that neither the browser
 * nor Plex can play is "This book's audio format can't play in this
 * browser", with the place held, never skipped. Sessions are ended when the
 * part, the book or the page is left (best effort; Plex ends idle ones).
 *
 * Pure (importable by Node, no DOM at import time):
 *   toTrackOffset(tracks, bookMs)  -> { index, track, offset_ms } | null
 *   toBookMs(tracks, trackKey, offsetMs) -> number | null
 *   chapterAt(chapters, bookMs)    -> the chapter's position in the list, -1 if none
 *   mimeFor(container, codec, profile) -> the MIME type for canPlayType, '' if unknown
 *   createEngine(env)              the engine, given its surroundings (tests)
 *   boot(win, overrides)           mounts the engine in #wsPlayer as WS.player
 *   UnknownTrack                   open()'s rejection for a place not in the book
 *
 * In the browser, window.WS.player:
 *   open(key, { at: { track, offset_ms }, autoplay, resume }) -> Promise<void>
 *       loads the book (at the place given, else where the listener left
 *       off, else its start) and plays it (autoplay false: loads only).
 *       Resolves once playback is set going; a failure is an 'error' event
 *       and state().error. It rejects only with UnknownTrack: the place
 *       given is in a part the book does not have; then nothing is loaded
 *       and no place is reported (the 'loading' change is followed by a
 *       'close' one, no book, no place).
 *       Where the listener left off (with a saver, and no at; resume: false
 *       skips it): the newest of WebServarr's copy, Plex's and this
 *       browser's (GET /api/player/position/<key> and the local copy), the
 *       next newest when a copy's part is not in the book, else the start
 *       with a 'warning' { kind: 'resume-lost' }. A local copy that wins is
 *       sent to the server at once. If the copies cannot be read, the open
 *       fails like a failed book fetch (with a retry), so nothing ever
 *       starts from 0 over a place it did not see.
 *   play(), pause(), toggle()
 *   seek(bookMs), skip(deltaS), jumpToChapter(i)   i: a position in state().chapters
 *   setSpeed(x)       0.75 to 2 in 0.05 steps (clamped, rounded); returns the speed
 *   setSkip(s)        the Media Session seek back and forward, 5 to 60 s
 *                     (clamped, rounded); returns it
 *   retry()           after an error: again from the place. After a failed
 *                     first fetch it opens the book again, so like open() it
 *                     can reject with UnknownTrack.
 *   close()           stops and forgets the book
 *   state()           { book (the key), title, author, narrator, series, cover,
 *                       chapters, chapterIndex, trackIndex, bookMs, bookDurationMs,
 *                       position: { track, offset_ms, duration_ms } | null,
 *                       playing, loading, speed, connection: 'local'|'remote'|null,
 *                       error: { code, message } | null, lastSavedAt, saveError,
 *                       resumedFrom: { source, device, updated_at } | null }
 *       bookMs is the playhead (what to show); position is the place to save.
 *       They differ only while a skipped part's successor has not played yet.
 *       lastSavedAt: ms (this device's clock) of the last save the server
 *       took, or null; saveError: the "not saved" warning is showing.
 *       resumedFrom: which copy open() resumed from ('web', 'plex', 'local').
 *   on(event, fn) -> unsubscribe; fn gets one object:
 *     'change'   { reason, state } and, for 'seek' | 'skip' | 'jump', from and to
 *                (book ms). reason: 'loading' (a book is being fetched), 'open'
 *                (its parts and chapters are known), 'play', 'pause', 'time' (the
 *                element's timeupdate while playing), 'seek', 'skip', 'jump',
 *                'part' (one part ended, the next starts at 0), 'part-skipped',
 *                'connection' (switched, or refreshed its token), 'speed',
 *                'ready' (loaded, not playing), 'retry', 'error', 'ended', 'close',
 *                'save' (state().saveError changed)
 *     'ended'    { state } at the end of the last part
 *     'error'    { code, message, retry: function | null }; code 'unreachable',
 *                'part', 'format', 'forbidden', 'not-found', 'signed-out', 'busy',
 *                'empty'
 *     'warning'  { kind: 'part-skipped', message }
 *                { kind: 'resume-lost', message } (see open)
 *                { kind: 'not-saved', active, lastSavedAt, message } (saves.js):
 *                active true: "Your place isn't being saved. Last saved <time>."
 *                to show; false: it cleared (a save succeeded, or the book was
 *                closed or switched while it showed), with a 'save' change
 *
 * Saving (saves.js) is injected as env.saver: the engine hands it every
 * change and opens and stops it with each book. Without one (the engine's
 * own tests) nothing is saved and open() does not look for a place.
 */

export const PROBE_MS = 1500;          // the local connection's probe
export const STALL_MS = 8000;          // waiting with nothing arriving: the stream has failed
export const PLAYED_MS = 1000;         // this much real playback shows a part plays
export const SPEED_MIN = 0.75;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.05;
export const SKIP_S = 10;              // Media Session seek back and forward: the default
export const SKIP_MIN_S = 5;
export const SKIP_MAX_S = 60;
export const SEEK_SETTLE_MS = 400;     // a seek on a transcoded part restarts once it settles
export const ASK_MS = 10000;           // asking for a transcode session, at most
export const END_SLACK_MS = 5000;      // a transcoded stream ending sooner than this before its end was cut off
export const CHECK_LEAD_MS = 5000;     // an early end is checked by playing from this far before it
export const CHECK_PLAYED_MS = 3000;   // the check must play this much real audio to confirm an end
export const CHECK_PAST_MS = 2000;     // playing this far past the early end shows it was a hiccup
export const CHECK_MS = 20000;         // the whole check, at most
export const UNREACHABLE = "Can't reach the media server";
export const RESUME_LOST = "Couldn't find your saved place in this book";
export const FORMAT_UNSUPPORTED = "This book's audio format can't play in this browser";

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const TRANSCODE_SESSION = /^ws[0-9a-f]{32}$/;
const MP4 = ['mp4', 'm4a', 'm4b', 'mov'];

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

/* open()'s rejection when the place it was given is in a part this book
   does not have (the book changed in Plex since the place was saved). Nothing
   is loaded and no place is reported, so no save can overwrite the stored one
   with the start of the book; the caller decides where to start. */
export class UnknownTrack extends Error {
  constructor(track) {
    super("The saved place is in a part this book doesn't have");
    this.name = 'UnknownTrack';
    this.track = String(track);
  }
}

/* The MIME type, codecs included, that a track's container and codec (as
   Plex reports them) make, for the browser's canPlayType. '' when the codec
   is unknown or empty: such a track plays direct, as before. */
export function mimeFor(container, codec, profile) {
  const c = String(container || '').toLowerCase();
  const k = String(codec || '').toLowerCase();
  const p = String(profile || '').toLowerCase();
  const mp4 = MP4.indexOf(c) !== -1;
  const inMp4 = function (codecs) { return mp4 ? 'audio/mp4; codecs="' + codecs + '"' : ''; };
  switch (k) {
    case 'mp3':
      return c === 'mp3' ? 'audio/mpeg' : inMp4('mp4a.6B');
    case 'aac':
      if (c === 'aac') return 'audio/aac';
      if (p.indexOf('v2') !== -1) return inMp4('mp4a.40.29');
      if (p.indexOf('he') !== -1) return inMp4('mp4a.40.5');
      return inMp4('mp4a.40.2');
    case 'eac3':
      return inMp4('ec-3');
    case 'ac3':
      return inMp4('ac-3');
    case 'alac':
      return inMp4('alac');
    case 'flac':
      return c === 'flac' ? 'audio/flac' : inMp4('flac');
    case 'opus':
      return c === 'ogg' ? 'audio/ogg; codecs="opus"' : c === 'webm' ? 'audio/webm; codecs="opus"' : inMp4('opus');
    case 'vorbis':
      return c === 'ogg' ? 'audio/ogg; codecs="vorbis"' : c === 'webm' ? 'audio/webm; codecs="vorbis"' : '';
    default:
      return '';
  }
}

// Only a finite number is a skip length; anything else (null, '', false, a
// string) changes nothing.
function roundSkip(x) {
  if (typeof x !== 'number' || !isFinite(x)) return null;
  return clampNumber(Math.round(x), SKIP_MIN_S, SKIP_MAX_S);
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
   clearTimeout, mediaSession, MediaMetadata, permissions, baseUrl,
   skipSeconds, saver (saves.js createSaver), clientId (this browser's id
   for Plex's transcoder), stopTranscode(session) (ends one, best effort),
   onPageHide(fn) }. */
export function createEngine(env) {
  const setT = env.setTimeout;
  const clearT = env.clearTimeout;
  const fetchFn = env.fetch;
  const session = env.mediaSession || null;
  const Metadata = env.MediaMetadata || null;
  const baseUrl = env.baseUrl || '';
  const saver = env.saver || null;
  const clientId = /^[a-z0-9]{8,40}$/.test(String(env.clientId || '')) ? String(env.clientId)
    : 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let skipS = roundSkip(env.skipSeconds) || SKIP_S;

  const audio = env.createAudio();
  audio.preload = 'auto';
  if (audio.setAttribute) audio.setAttribute('data-ws-player-audio', '');
  if (env.host) env.host.appendChild(audio);

  /* Can this browser decode the track itself? Asked before the track is
     loaded or probed. An unknown format is played direct, as always; one the
     browser says it cannot play ('') is converted by Plex instead. */
  function needsTranscode(t) {
    const mime = mimeFor(t.container, t.codec, t.profile);
    if (!mime || typeof audio.canPlayType !== 'function') return false;
    try {
      return audio.canPlayType(mime) === '';
    } catch (e) {
      return false;
    }
  }

  const handlers = { change: new Set(), ended: new Set(), error: new Set(), warning: new Set() };

  // The book: { key, title, author, narrator, series, cover, tracks, starts,
  // durationMs, chapters }. The stream's token and URIs are kept apart from
  // it, and never leave this closure except inside an element's src.
  let book = null;
  let stream = null;
  let lastOpen = null;        // { key, opts } of the last open(), for its retry
  let openGen = 0;
  let resumedFrom = null;     // { source, device, updated_at } the open resumed from

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
  // A part being loaded once more after it would not load or decode where the
  // connection was just shown to work: { index, side }. Failing the same way
  // again, it is skipped.
  let partSuspect = null;

  let wantPlay = false;
  let loading = false;
  let speed = 1;
  let error = null;           // { code, message }
  let errorRetry = null;

  // Connection: the choice kept for the page session, what has loaded on
  // each side with the current token, and the failure ladder's progress.
  let chosen = null;
  let localOk = null;         // may the local side be used (the permission gate), once known
  let localAsk = null;        // the permission question in flight
  const proven = new Map();   // side -> index of a part that loaded there
  const tried = new Set();
  let refreshed = false;

  let watchdog = null;
  const probes = new Map();   // live probe element -> its finish(ok)
  let probeCount = 0;
  let sessionReady = false;

  // Transcoding: the Plex session the element streams from ({ index,
  // session, start }; the start carries no token), a seek on a transcoded
  // part waiting to settle, and the session requests in flight (each one's
  // way to give up, for teardown).
  let tc = null;
  let restartTimer = null;
  let asking = false;         // the part being loaded waits for its session
  // An early clean end of a transcoded stream is either Plex dropping the
  // session or the part's real audio being shorter than Plex's length for it.
  // endCheck: the check in progress (a muted element of its own, playing up
  // to the place); checkedAt ({ index, offset }): the place last checked,
  // checked once until real playback moves on.
  let endCheck = null;
  let checkedAt = null;
  const asks = new Set();
  if (typeof env.onPageHide === 'function') {
    // Leaving the page: nothing will read the stream again.
    env.onPageHide(function () { dropSession(); });
  }

  // The saves' warning: an event to show or clear, and a change so a view
  // drawn from state() follows.
  if (saver && typeof saver.onWarning === 'function') {
    saver.onWarning(function (w) {
      emit('warning', w);
      changed('save');
    });
  }

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
    if (saver) {
      // First, so this change already carries what saving it changed.
      try {
        saver.note({ reason: reason, state: state() });
      } catch (e) {
        console.error('[player] saving failed', e);
      }
    }
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
      lastSavedAt: saver ? saver.lastSavedAt : null,
      saveError: saver ? !!saver.warning : false,
      resumedFrom: resumedFrom
    };
  }

  // ---- Streams ----

  function hasSide(side) {
    return !!(stream && stream.uris && Array.isArray(stream.uris[side]) && stream.uris[side].length);
  }

  // A side the engine may load: the local one only once localAllowed() has
  // said yes, so it is never loaded where the browser would ask first.
  function usable(side) {
    return hasSide(side) && (side !== 'local' || localOk === true);
  }

  /* May the local connection be tried without a prompt? Chrome asks "access
     devices on your local network" the first time a public page loads from a
     private address, and plex.direct names resolve to one from anywhere. So
     only when that permission is already granted; 'prompt' or 'denied' (or
     no answer in time) is no. A browser that has no such permission (the
     query rejects) has no gate: yes. Asked once per page session. */
  function localAllowed() {
    if (localOk !== null) return Promise.resolve(localOk);
    if (!localAsk) {
      const perms = env.permissions;
      if (!perms || typeof perms.query !== 'function') {
        localOk = true;
        return Promise.resolve(true);
      }
      localAsk = new Promise(function (resolve) {
        let timer = null;
        function settle(ok) {
          if (timer === null) return;
          clearT(timer);
          timer = null;
          localOk = ok;
          localAsk = null;
          resolve(ok);
        }
        timer = setT(function () { settle(false); }, PROBE_MS);
        let asked;
        try {
          asked = Promise.resolve(perms.query({ name: 'local-network-access' }));
        } catch (e) {
          asked = Promise.reject(e);
        }
        asked.then(function (status) {
          const st = status && status.state;
          settle(st === 'granted' ? true : st === 'prompt' || st === 'denied' ? false : true);
        }, function () { settle(true); });
      });
    }
    return localAsk;
  }

  function otherSide(side) {
    return side === 'local' ? 'remote' : 'local';
  }

  function preferredSide() {
    if (chosen && usable(chosen)) return chosen;
    if (usable('local')) return 'local';
    return usable('remote') ? 'remote' : null;
  }

  // Built only to be handed to an element's src, never stored or logged.
  function urlFor(side, index) {
    if (!usable(side) || !book || !book.tracks[index]) return '';
    const origin = String(stream.uris[side][0]).replace(/\/+$/, '');
    return origin + book.tracks[index].part_path + '?X-Plex-Token=' + encodeURIComponent(stream.token);
  }

  function isTranscoded(index) {
    return !!(book && book.tracks[index] && book.tracks[index].transcode);
  }

  /* A transcoded part's stream from `fromMs` into it: Plex's transcoder on
     the same connection, the session's start path and query, the offset in
     seconds, then the token. Built only for an element's src, like urlFor.
     The element's time 0 is `fromMs` in the part. */
  function transcodeUrl(side, s, fromMs) {
    if (!usable(side) || !s) return '';
    const origin = String(stream.uris[side][0]).replace(/\/+$/, '');
    return origin + s.start + '&offset=' + (Math.max(0, Math.round(fromMs)) / 1000).toFixed(3) +
      '&X-Plex-Token=' + encodeURIComponent(stream.token);
  }

  /* A new Plex transcode session for a part: { session, start }, or
     { status } (0 for no answer). Plex starts a stream only for a session it
     has decided on, and the decision is made by the server with the
     listener's token. */
  function askSession(index) {
    const key = book.key;
    const track = book.tracks[index].key;
    return new Promise(function (resolve) {
      let done = false;
      let timer = null;
      function finish(v) {
        if (done) return;
        done = true;
        clearT(timer);
        asks.delete(finish);
        resolve(v);
      }
      asks.add(finish);
      timer = setT(function () { finish({ status: 0 }); }, ASK_MS);
      Promise.resolve().then(function () {
        return fetchFn('/api/player/transcode/' + encodeURIComponent(key), {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ track: track, client: clientId })
        });
      }).then(function (resp) {
        if (!resp.ok) return { status: resp.status };
        return resp.json().then(function (d) {
          const ok = d && typeof d.session === 'string' && TRANSCODE_SESSION.test(d.session) &&
            typeof d.start === 'string' && /^\/[^/]/.test(d.start) && d.start.indexOf('?') !== -1;
          return ok ? { session: d.session, start: d.start } : { status: 0 };
        });
      }).then(function (v) {
        if (done) {
          if (v && v.session) sendStop(v.session);  // too late: nobody will use it
          return;
        }
        finish(v);
      }, function () { finish({ status: 0 }); });
    });
  }

  function sendStop(sid) {
    if (typeof env.stopTranscode !== 'function') return;
    try {
      env.stopTranscode(sid);
    } catch (e) { /* best effort; Plex ends it by itself */ }
  }

  // The element has let go of the transcode session: end it.
  function dropSession() {
    if (!tc) return;
    const sid = tc.session;
    tc = null;
    sendStop(sid);
  }

  function cancelRestart() {
    if (restartTimer !== null) {
      clearT(restartTimer);
      restartTimer = null;
    }
  }

  /* Does this side answer for this part? A throwaway element loads only its
     metadata, 1.5 s at most, and is then emptied so it holds no connection.
     A transcoded part is asked through the transcoder (the file itself is
     what this browser cannot decode), with a session of its own that is
     ended after. */
  async function probe(side, index) {
    if (!usable(side) || !book || !book.tracks[index]) return false;
    const b = book;
    let sid = null;
    let base;
    if (isTranscoded(index)) {
      const got = await askSession(index);
      if (!got.session) return false;
      sid = got.session;
      if (book !== b) {
        sendStop(sid);
        return false;
      }
      base = transcodeUrl(side, got, 0);
    } else {
      base = urlFor(side, index);
    }
    const ok = await probeUrl(base);
    if (sid) sendStop(sid);
    if (ok && book === b) proven.set(side, index);
    return ok;
  }

  function probeUrl(base) {
    return new Promise(function (resolve) {
      // A URL of its own every time: a URL the element loaded before can be
      // answered from the browser's media cache with the server gone, and a
      // probe must ask the server.
      probeCount += 1;
      const url = base ? base + '&wsprobe=' + probeCount.toString(36) + Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8) : '';
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
    if (chosen && usable(chosen)) return chosen;
    if (hasSide('local') && await localAllowed()) {
      if (await probe('local', index)) return 'local';
      return usable('remote') ? 'remote' : 'local';
    }
    return usable('remote') ? 'remote' : null;
  }

  // ---- Loading a part ----

  function applyRate() {
    try {
      audio.defaultPlaybackRate = speed;
      audio.playbackRate = speed;
    } catch (e) { /* not while the element has no media */ }
  }

  /* Loads a part at an offset on a side. A transcoded part streams from a
     Plex session started at that offset (cur.base: the element's time 0 is
     that far into the part). `reuse`: a seek restarting the session this
     part already has; anything else asks for a new one. */
  function load(index, offset, side, reuse) {
    gen += 1;
    const g = gen;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    cancelRestart();
    disarm();
    asking = false;
    const transcoded = isTranscoded(index);
    cur = { index: index, side: side, base: transcoded ? offset : 0 };
    target = { index: index, offset: offset };
    playhead = { index: index, offset: offset };
    setLoading(true);
    if (!transcoded) {
      audio.src = urlFor(side, index);
      dropSession();              // once the element has let go of it
      applyRate();
      if (wantPlay) startPlay();
      return;
    }
    if (offset > 0 && offset >= durationOf(book.tracks[index]) - END_SLACK_MS) {
      // At (or within END_SLACK_MS of) the part's end: nothing to convert.
      // The part is over, once whoever loaded it has told its listeners.
      release();
      dropSession();
      Promise.resolve().then(function () {
        if (g === gen && book) partEnded(index, side);
      });
      return;
    }
    if (reuse && tc && tc.index === index) {
      startStream(tc);
      return;
    }
    // Nothing plays while Plex decides (the old stream is let go at once).
    release();
    dropSession();
    asking = true;
    askSession(index).then(function (got) {
      if (g !== gen || !book) {
        if (got.session) sendStop(got.session);
        return;
      }
      asking = false;
      if (!got.session) {
        refused(got.status);
        return;
      }
      tc = { index: index, session: got.session, start: got.start };
      startStream(tc);
    });
  }

  function startStream(s) {
    audio.src = transcodeUrl(cur.side, s, cur.base);
    applyRate();
    if (wantPlay) startPlay();
  }

  /* No transcode session for the part at the playhead. Plex refusing to
     convert it is the format message (the place held, never skipped); the
     listener's own access is the open's messages; anything else (no answer,
     busy, down) is a stream failure, up the connection ladder. */
  function refused(status) {
    if (status === 415) {
      stopWith('format', FORMAT_UNSUPPORTED, retry);
      return;
    }
    if (status === 401 || status === 403 || status === 404) {
      const err = openError({ status: status, detail: '' }, retry);
      stopWith(err.code, err.message, err.retry);
      return;
    }
    fail('network');
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
      if (target.offset > 0 && !isTranscoded(cur.index)) {
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
    // This connection answers. The failure ladder starts afresh only once it
    // has really played (timeupdate): a stream that starts and at once ends
    // or fails keeps the ladder where it was, so it cannot loop.
    chosen = cur.side;
    if (loading) {
      setLoading(false);
      changed('play');
    }
  });

  audio.addEventListener('timeupdate', function () {
    // The place is frozen in the error state: emptying the element there
    // resets its time to 0, which is not where the listener is.
    if (!book || !cur || error) return;
    if (pending) {
      if (!seekApplied || audio.seeking) return;
      pending = false;
    }
    // The part's own length, never the element's (a transcoded stream has
    // none); its time counts from where the stream started in the part.
    const d = durationOf(book.tracks[cur.index]);
    let off = Math.round(Number(audio.currentTime) * 1000);
    if (!isFinite(off) || off < 0) off = 0;
    off += cur.base;
    if (off > d) off = d;
    const moved = !playhead || playhead.index !== cur.index || playhead.offset !== off;
    playhead = { index: cur.index, offset: off };
    if (!audio.paused && off >= target.offset + PLAYED_MS) {
      // Real playback (1 s of it, not just a start): the place held after a
      // skipped part moves on, a part loaded again after failing is fine,
      // and this connection works, so the failure ladder starts afresh.
      hold = null;
      partSuspect = null;
      checkedAt = null;
      tried.clear();
      refreshed = false;
    }
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
    if (isTranscoded(i)) {
      const off = cur.base + Math.round(Number(audio.currentTime) * 1000);
      if (!(off >= durationOf(book.tracks[i]) - END_SLACK_MS)) {
        // Ended early, cleanly: Plex dropping the session (stopped, or idle
        // too long), or the real end of a part Plex thinks is longer. Only a
        // check can tell, once per place; otherwise it is a dropped stream.
        const place = playhead && playhead.index === i ? playhead.offset : off;
        if (checkedAt && checkedAt.index === i && Math.abs(checkedAt.offset - place) <= PLAYED_MS) {
          fail('network');
          return;
        }
        checkedAt = { index: i, offset: place };
        checkEnd(i, place, cur.side);
        return;
      }
    }
    partEnded(i, cur.side);
  });

  /* Is an early clean end at `place` the part's real end? A muted element of
     its own, on a new transcode session, plays from CHECK_LEAD_MS before it.
     It confirms only by playing CHECK_PLAYED_MS of real audio and then
     ending cleanly within PLAYED_MS of the place; playing CHECK_PAST_MS past
     it shows a hiccup (the listener's stream starts again at the place);
     anything else (an error, no audio, no answer in CHECK_MS) is a dropped
     stream, up the connection ladder. The listener's element stays quiet
     meanwhile and never plays anything again; nothing is saved from the
     check, and its session is ended after. */
  function checkEnd(index, place, side) {
    gen += 1;
    const g = gen;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    disarm();
    release();
    dropSession();
    setLoading(true);
    const start = Math.max(0, place - CHECK_LEAD_MS);
    const check = { el: null, session: null, timer: null, done: false };
    endCheck = check;
    function finish() {
      if (check.done) return;
      check.done = true;
      clearT(check.timer);
      if (endCheck === check) endCheck = null;
      const el = check.el;
      if (el) {
        el.ontimeupdate = null;
        el.onended = null;
        el.onerror = null;
        try {
          el.pause();
          el.removeAttribute('src');
          el.load();
        } catch (e) { /* nothing to release */ }
      }
      if (check.session) sendStop(check.session);
    }
    check.finish = finish;
    function dropped() {
      finish();
      if (g !== gen || !book) return;
      fail('network');
    }
    check.timer = setT(dropped, CHECK_MS);
    askSession(index).then(function (got) {
      if (check.done || g !== gen || !book) {
        if (got.session) sendStop(got.session);
        return;
      }
      if (!got.session) {
        dropped();
        return;
      }
      check.session = got.session;
      probeCount += 1;
      const base = transcodeUrl(side, got, start);
      if (!base) {
        dropped();
        return;
      }
      const el = env.createAudio();
      check.el = el;
      el.muted = true;
      el.preload = 'auto';
      const reached = function () {
        const t = Number(el.currentTime);
        return start + (isFinite(t) && t > 0 ? Math.round(t * 1000) : 0);
      };
      el.ontimeupdate = function () {
        if (check.done || reached() < place + CHECK_PAST_MS) return;
        // Plex has audio past the place: the listener's stream only dropped.
        finish();
        if (g !== gen || !book) return;
        load(index, place, side);
        changed('connection');
      };
      el.onended = function () {
        const at = reached();
        const confirmed = at - start >= CHECK_PLAYED_MS && Math.abs(at - place) <= PLAYED_MS;
        if (!confirmed) {
          dropped();
          return;
        }
        finish();
        if (g !== gen || !book) return;
        partEnded(index, side);
      };
      el.onerror = dropped;
      el.src = base + '&wsprobe=' + probeCount.toString(36) + Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8);
      let p = null;
      try {
        p = el.play();
      } catch (e) {
        p = null;
      }
      if (p && typeof p.catch === 'function') p.catch(function () { if (!check.done) dropped(); });
    });
  }

  function cancelCheck() {
    if (endCheck) endCheck.finish();
  }

  /* The part is over: the next one starts at 0, or the book has ended. */
  function partEnded(i, side) {
    hold = null;
    partSuspect = null;
    checkedAt = null;
    if (i + 1 < book.tracks.length) {
      load(i + 1, 0, side);
      changed('part');
      return;
    }
    playhead = { index: i, offset: durationOf(book.tracks[i]) };
    target = { index: i, offset: playhead.offset };
    wantPlay = false;
    disarm();
    if (isTranscoded(i)) {
      // Nothing more comes from this stream; its time is not the place.
      pending = true;
      seekApplied = false;
      metaLoaded = false;
      release();
    }
    dropSession();
    setLoading(false);
    sessionState();
    changed('ended');
    emit('ended', { state: state() });
  }

  audio.addEventListener('error', function () {
    const err = audio.error;
    if (!book || !cur || !err || err.code === MEDIA_ERR_ABORTED) return;
    fail(err.code === MEDIA_ERR_NETWORK ? 'network' : 'media');
  });

  // ---- Failures ----

  /* The stream failed at the playhead. kind: 'network' (the connection
     dropped or stalled) or 'media' (the part would not load or decode; a
     404, a refused token and an unreachable host look the same here).

     Only a media failure can be the part's fault, and a part is skipped only
     when it fails that way twice: once, then again when loaded afresh on a
     connection just shown to work (another part, or this one, loads its
     metadata there). Anything else goes up the connection ladder and, at its
     top, to the error state, where the place is held for Retry. */
  async function fail(kind) {
    if (failedGen === gen || !book || !cur) return;
    failedGen = gen;
    const g = gen;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    cancelRestart();
    disarm();
    const at = { index: playhead.index, offset: playhead.offset };
    const side = cur.side;
    const suspect = partSuspect;
    partSuspect = null;
    setLoading(true);

    if (kind === 'media') {
      if (suspect && suspect.index === at.index && suspect.side === side) {
        skipPart(at, side);
        return;
      }
      if (proven.has(side)) {
        const ok = await probe(side, verifyIndex(side, at.index));
        if (g !== gen) return;
        if (ok) {
          retryPart(at, side);
          return;
        }
      }
    }

    // 1. The other connection, at the same offset.
    tried.add(side);
    const other = otherSide(side);
    if (usable(other) && !tried.has(other)) {
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

    // 3. A part that would not load: if the server answers for another part
    //    (a missing first part, before anything was shown to work), this
    //    part is loaded once more, and skipped if it fails that way again.
    if (kind === 'media') {
      const s = preferredSide();
      const ok = !!s && await probe(s, verifyIndex(s, at.index));
      if (g !== gen) return;
      if (ok) {
        retryPart(at, s);
        return;
      }
    }

    stopWith('unreachable', UNREACHABLE, retry);
  }

  function retryPart(at, side) {
    load(at.index, at.offset, side);
    partSuspect = { index: at.index, side: side };
    changed('connection');
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
    if (isTranscoded(at.index)) {
      // Neither this browser nor Plex's conversion can play it: say so, and
      // hold the place (nothing the listener has not heard is passed over).
      cur = { index: at.index, side: side, base: 0 };
      stopWith('format', FORMAT_UNSUPPORTED, retry);
      return;
    }
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
    cur = { index: at.index, side: side, base: 0 };
    stopWith('part', "The rest of this book couldn't be played.", retry);
  }

  function stopWith(code, message, retryFn) {
    wantPlay = false;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    partSuspect = null;
    asking = false;
    cancelRestart();
    disarm();
    try {
      audio.pause();
    } catch (e) { /* already */ }
    release();
    dropSession();
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

  /* This listener's saved copies of the place: { web, plex }, either null.
     Fails like fetchBook, so the open fails rather than starting from 0 over
     a place it could not see. */
  async function fetchPlaces(key) {
    let clockDone = null;
    try {
      clockDone = typeof saver.clockProbe === 'function' ? saver.clockProbe() : null;
    } catch (e) { /* no clock measure */ }
    let resp;
    try {
      resp = await fetchFn('/api/player/position/' + encodeURIComponent(key), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
    } catch (e) {
      throw { status: 0, detail: '' };
    }
    if (!resp.ok) throw { status: resp.status, detail: '' };
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw { status: 0, detail: '' };
    }
    if (!data || typeof data !== 'object') throw { status: 0, detail: '' };
    // The clock first, so the local copy is weighed in the server's time.
    try {
      if (clockDone) clockDone(data.now);
    } catch (e) { /* no clock measure */ }
    return { web: data.web || null, plex: data.plex || null };
  }

  function makeBook(key, data) {
    const tracks = data.tracks.map(function (t) {
      const format = {
        container: String(t.container || ''),
        codec: String(t.codec || ''),
        profile: String(t.profile || '')
      };
      return Object.freeze({
        key: String(t.key),
        part_path: String(t.part_path || ''),
        duration_ms: durationOf(t),
        index: t.index,
        container: format.container,
        codec: format.codec,
        profile: format.profile,
        // Decided once, before the part is ever loaded or probed.
        transcode: needsTranscode(format)
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
    // The saves first, while they still know the place: its last save.
    if (saver) {
      try {
        saver.stop();
      } catch (e) {
        console.error('[player] saving failed', e);
      }
    }
    resumedFrom = null;
    gen += 1;
    wantPlay = false;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    partSuspect = null;
    asking = false;
    checkedAt = null;
    cancelRestart();
    cancelCheck();
    disarm();
    Array.from(probes.values()).forEach(function (finish) { finish(false); });
    Array.from(asks).forEach(function (finish) { finish({ status: 0 }); });
    try {
      audio.pause();
    } catch (e) { /* already */ }
    release();
    dropSession();
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
    // Nothing plays: the lock screen shows nothing (a failed open included).
    if (session) {
      try {
        session.metadata = null;
        session.playbackState = 'none';
      } catch (e) { /* not supported */ }
    }
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
    const resume = !!saver && !opts.at && opts.resume !== false;
    const placesAsked = resume ? fetchPlaces(key).then(
      function (v) { return { places: v }; },
      function (e) { return { failed: e }; }
    ) : null;
    let data;
    let places = null;
    try {
      data = await fetchBook(key, false);
      if (placesAsked) {
        const got = await placesAsked;
        if (got.failed) throw got.failed;
        places = got.places;
      }
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
    if (opts.at) {
      const b = typeof opts.at === 'object' ? toBookMs(book.tracks, opts.at.track, opts.at.offset_ms) : null;
      if (b === null) {
        const track = typeof opts.at === 'object' ? opts.at.track : opts.at;
        book = null;
        stream = null;
        setLoading(false);
        // Listeners saw 'loading': they see it end, with no book and no place.
        changed('close');
        throw new UnknownTrack(track);
      }
      startMs = b;
    }
    // Where the listener left off: the newest copy whose part the book has.
    let resumed = null;
    let lost = false;
    if (places) {
      let order = [];
      try {
        order = saver.resumeFrom(key, places) || [];
      } catch (e) {
        console.error('[player] saving failed', e);
      }
      for (const c of order) {
        const b = toBookMs(book.tracks, c.track, c.offset_ms);
        if (b !== null) {
          startMs = b;
          resumed = c;
          break;
        }
      }
      lost = order.length > 0 && !resumed;
    }
    const to = toTrackOffset(book.tracks, startMs);
    playhead = { index: to.index, offset: to.offset_ms };
    target = { index: to.index, offset: to.offset_ms };
    resumedFrom = resumed ? { source: resumed.source, device: resumed.device, updated_at: resumed.updated_at } : null;
    if (saver) {
      try {
        saver.start(key, {
          // A local copy newer than the server's goes to the server at once.
          push: !!(resumed && resumed.source === 'local'),
          savedAt: places && places.web ? places.web.updated_at : null,
          held: resumed && resumed.source === 'web' ? resumed : null
        });
      } catch (e) {
        console.error('[player] saving failed', e);
      }
    }
    installSession();
    sessionMetadata();
    changed('open');
    if (lost) emit('warning', { kind: 'resume-lost', message: RESUME_LOST });
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
    if (restartTimer !== null || asking || endCheck) {
      // A transcoded part's new stream is on its way (the element still
      // holds the old one, or none): it starts playing when it comes.
      sessionState();
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
    partSuspect = null;
    const next = { index: to.index, offset: to.offset_ms };
    if (error || !cur) {
      // Nothing loaded (an error, or still choosing): the place moves, and
      // play or retry loads it.
      playhead = next;
      target = { index: next.index, offset: next.offset };
    } else if (isTranscoded(next.index)) {
      // A transcoded stream cannot seek: Plex starts it again at the new
      // place, once, when the listener stops moving it. Until then the old
      // stream is let go (a session still being asked for is dropped), so
      // nothing it does can move the place back.
      gen += 1;
      playhead = next;
      target = { index: next.index, offset: next.offset };
      pending = true;
      seekApplied = false;
      metaLoaded = false;
      asking = false;
      cancelCheck();
      disarm();
      release();
      setLoading(true);
      cancelRestart();
      const side = cur.side;
      restartTimer = setT(function () {
        restartTimer = null;
        if (!book || !cur || error) return;
        load(target.index, target.offset, side, true);
      }, SEEK_SETTLE_MS);
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

  function setSkip(x) {
    const v = roundSkip(x);
    if (v !== null) skipS = v;
    return skipS;
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
    partSuspect = null;
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
    // From the place held after a skipped part, else the playhead.
    const from = hold || playhead;
    load(from.index, from.offset, side);
    sessionState();
    changed('retry');
    return Promise.resolve();
  }

  function close() {
    openGen += 1;
    const had = !!(book || error);
    teardown();
    lastOpen = null;
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
    setSkip: setSkip,
    retry: retry,
    close: close,
    state: state,
    on: on
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/* This browser's id for Plex's transcoder, kept so Plex sees one device per
   browser. Plex runs one transcode per id, so it is per browser, not per
   account: two devices on one account never stop each other's stream. */
const CLIENT_KEY = 'ws-player:client';
function browserClientId(win) {
  try {
    const kept = win.localStorage.getItem(CLIENT_KEY);
    if (kept && /^[a-z0-9]{8,40}$/.test(kept)) return kept;
  } catch (e) { /* no storage: one for this page */ }
  let id = '';
  try {
    const bytes = new Uint8Array(12);
    win.crypto.getRandomValues(bytes);
    id = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  } catch (e) {
    id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  }
  try {
    win.localStorage.setItem(CLIENT_KEY, id);
  } catch (e) { /* kept for this page only */ }
  return id;
}

/* Ends a transcode session: a beacon (it survives the page going away),
   else a keepalive fetch. Same-origin, no custom header. */
function sendTranscodeStop(win, sid) {
  const url = '/api/player/transcode/stop';
  const body = JSON.stringify({ session: sid });
  try {
    const nav = win.navigator;
    if (nav && typeof nav.sendBeacon === 'function' &&
        nav.sendBeacon(url, new win.Blob([body], { type: 'application/json' }))) return;
  } catch (e) { /* the fetch below */ }
  try {
    const p = win.fetch(url, {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: body
    });
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) { /* best effort; Plex ends it by itself */ }
}

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
  // Saving comes from saves.js, loaded as its own module just before this
  // one (WS.playerSaves), so each file keeps its own asset stamp.
  const saves = WS.playerSaves;
  const engine = createEngine(Object.assign({
    host: host,
    createAudio: function () { return doc.createElement('audio'); },
    fetch: win.fetch.bind(win),
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    mediaSession: nav.mediaSession || null,
    permissions: nav.permissions || null,
    MediaMetadata: win.MediaMetadata || null,
    baseUrl: win.location.href,
    clientId: browserClientId(win),
    stopTranscode: function (sid) { sendTranscodeStop(win, sid); },
    onPageHide: function (fn) { win.addEventListener('pagehide', fn); },
    saver: overrides && 'saver' in overrides ? null
      : saves && typeof saves.browserSaver === 'function' ? saves.browserSaver(win) : null
  }, overrides || {}));
  WS.player = engine;
  return engine;
}

if (typeof window !== 'undefined' && window.document) boot(window);
