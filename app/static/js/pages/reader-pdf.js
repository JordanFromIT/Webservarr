/**
 * WebServarr — eBook reader: PDF books (a helper of pages/reader.js)
 *
 * Kavita's page API reads only EPUBs, so a PDF's pages are drawn here, in the
 * browser, by PDF.js (vendored in /static/vendor/pdfjs and loaded only when a
 * PDF is opened). The file comes through the Kavita proxy in byte ranges of
 * RANGE_CHUNK, so a page costs only the parts of the file it uses, and only
 * the page on screen and its two neighbours are ever drawn and kept: a long
 * book never draws, or holds, more than three pages.
 *
 * The reader keeps doing everything else (turns, the position in Kavita, the
 * contents panel, sample mode). This file only opens the file, draws pages to
 * fit the room it is given, and lists the PDF's own outline.
 *
 * Nothing here touches the page or the network at import time (the reader's
 * JS checks import it through a data: URL).
 */

// Byte ranges of 1 MB: a few requests a book instead of PDF.js's default 64 KB
// pieces, which would cost a hundred requests for a big file.
export const RANGE_CHUNK = 1 << 20;
// A drawn page's backing store, in pixels. Phones refuse (or blank) canvases
// past about 16M; a page needs nowhere near that to be sharp.
export const MAX_BACKING_PIXELS = 8 * 1024 * 1024;
const MAX_PIXEL_RATIO = 3;

/**
 * The CSS scale a page is drawn at, from its size at scale 1 and the room it
 * has. A phone fits the page to the width (it scrolls if the page is taller);
 * anything wider fits the whole page on screen.
 */
export function fitScale(pageWidth, pageHeight, room) {
  var byWidth = room.width / pageWidth;
  if (room.phone) return byWidth;
  return Math.min(byWidth, room.height / pageHeight);
}

/**
 * Backing pixels per CSS pixel: the screen's own ratio (sharp on HiDPI), held
 * to MAX_PIXEL_RATIO and to MAX_BACKING_PIXELS for the whole page.
 */
export function backingRatio(devicePixelRatio, cssWidth, cssHeight) {
  var ratio = Math.min(Math.max(devicePixelRatio || 1, 1), MAX_PIXEL_RATIO);
  var area = cssWidth * cssHeight;
  if (area > 0 && area * ratio * ratio > MAX_BACKING_PIXELS) ratio = Math.sqrt(MAX_BACKING_PIXELS / area);
  return ratio;
}

/**
 * A finished touch as a page turn: 1 (forward, a swipe to the left), -1
 * (back) or 0. Only a quick stroke that is mostly sideways and long enough
 * counts, so scrolling a tall page or a slow drag never turns it.
 */
export function swipeTurn(dx, dy, ms) {
  if (ms > 800 || Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

/** The pages kept drawn around the one on screen. */
export function keptPages(index, pages) {
  var out = [];
  for (var i = index - 1; i <= index + 1; i++) if (i >= 0 && i < pages) out.push(i);
  return out;
}

/**
 * Open a PDF. lib is PDF.js's module; opts:
 *   url        the file (the Kavita proxy's /kavita/api/Reader/pdf)
 *   workerSrc  PDF.js's worker script (stamped, same origin)
 *   assets     the vendored folder, ending in "/" (fonts, cmaps, decoders)
 *   signal     the visit's: aborting it closes the file and stops the worker
 *   document   where the canvases are made
 * Resolves to { pages, draw(index, room), drawn(index, room), contents() }.
 * A failure to open rejects with PDF.js's own error (its status is the HTTP
 * status when the proxy refused the file).
 */
export function openPdf(lib, opts) {
  lib.GlobalWorkerOptions.workerSrc = opts.workerSrc;
  var task = lib.getDocument({
    url: opts.url,
    rangeChunkSize: RANGE_CHUNK,
    // Only what the drawn pages need, never the rest of the file behind them.
    disableAutoFetch: true,
    disableStream: true,
    // WebAssembly would need 'wasm-unsafe-eval' in the site's policy; the
    // JavaScript decoders in assets/wasm/ stand in for it.
    useWasm: false,
    wasmUrl: opts.assets + 'wasm/',
    cMapUrl: opts.assets + 'cmaps/',
    standardFontDataUrl: opts.assets + 'standard_fonts/',
    enableXfa: false
  });
  var signal = opts.signal;
  function close() { task.destroy(); }
  if (signal.aborted) close();
  else signal.addEventListener('abort', close, { once: true });
  return task.promise.then(function (doc) {
    return pdfBook(doc, opts.document);
  });
}

function roomKey(room) {
  return [Math.round(room.width), Math.round(room.height), room.phone ? 1 : 0, room.ratio].join('x');
}

/** The book on an open PDF.js document (exported for the JS checks). */
export function pdfBook(doc, ownerDocument) {
  var kept = new Map();      // page index -> { key, promise, task, canvas, done }

  function drop(index) {
    var entry = kept.get(index);
    kept.delete(index);
    if (entry.task) entry.task.cancel();
    // Gives the pixels back at once (Safari holds a dropped canvas's memory
    // for a long time). Never the page still on screen.
    if (entry.canvas && !entry.canvas.isConnected) entry.canvas.width = 0;
  }

  function render(index, room, entry) {
    return doc.getPage(index + 1).then(function (page) {
      if (kept.get(index) !== entry) throw new Error('dropped');
      var base = page.getViewport({ scale: 1 });
      var scale = fitScale(base.width, base.height, room);
      var cssWidth = Math.floor(base.width * scale);
      var cssHeight = Math.floor(base.height * scale);
      var ratio = backingRatio(room.ratio, cssWidth, cssHeight);
      var canvas = ownerDocument.createElement('canvas');
      canvas.width = Math.floor(cssWidth * ratio);
      canvas.height = Math.floor(cssHeight * ratio);
      canvas.style.width = cssWidth + 'px';
      canvas.style.height = cssHeight + 'px';
      canvas.setAttribute('aria-label', 'Page ' + (index + 1));
      canvas.setAttribute('role', 'img');
      entry.canvas = canvas;
      entry.task = page.render({ canvas: canvas, viewport: page.getViewport({ scale: scale * ratio }) });
      return entry.task.promise.then(function () {
        entry.task = null;
        entry.done = true;
        return canvas;
      });
    });
  }

  /** A drawn page (a canvas), drawing it unless it is kept for this room. */
  function draw(index, room) {
    var key = roomKey(room);
    var entry = kept.get(index);
    if (entry && entry.key === key) return entry.promise;
    if (entry) drop(index);
    entry = { key: key, promise: null, task: null, canvas: null, done: false };
    kept.set(index, entry);
    entry.promise = render(index, room, entry);
    entry.promise.then(null, function () { if (kept.get(index) === entry) kept.delete(index); });
    return entry.promise;
  }

  return {
    pages: doc.numPages,
    /** True when draw(index, room) would answer at once. */
    drawn: function (index, room) {
      var entry = kept.get(index);
      return !!entry && entry.done && entry.key === roomKey(room);
    },
    /**
     * Page index (from 0) drawn for room; every page but it and its
     * neighbours is let go, and the neighbours are drawn once it is.
     */
    draw: function (index, room) {
      var keep = keptPages(index, doc.numPages);
      Array.from(kept.keys()).forEach(function (i) { if (keep.indexOf(i) === -1) drop(i); });
      var shown = draw(index, room);
      shown.then(function () {
        keep.forEach(function (i) {
          if (i !== index && kept.has(index)) draw(i, room).then(null, function () { /* drawn again when turned to */ });
        });
      }, function () {});
      return shown;
    },
    /**
     * The PDF's own outline as the contents panel lists it: [{ title, page,
     * children }], page from 0. An entry whose place cannot be found takes
     * its first child's; with neither it is left out. None: [].
     */
    contents: function () {
      function pageOf(dest) {
        var named = typeof dest === 'string' ? doc.getDestination(dest) : Promise.resolve(dest);
        return named.then(function (explicit) {
          if (!Array.isArray(explicit) || !explicit.length) return null;
          var ref = explicit[0];
          if (typeof ref === 'number') return ref;
          return doc.getPageIndex(ref);
        }).then(null, function () { return null; });
      }
      function walk(items) {
        return Promise.all((items || []).map(function (item) {
          return Promise.all([pageOf(item.dest), walk(item.items)]).then(function (got) {
            var children = got[1];
            var page = typeof got[0] === 'number' ? got[0] : (children.length ? children[0].page : null);
            return page === null ? null : { title: item.title, page: page, children: children };
          });
        })).then(function (list) { return list.filter(Boolean); });
      }
      return doc.getOutline().then(walk, function () { return []; });
    }
  };
}
