/*
 * Search matching in the browser: the rules of app/services/search_match.py
 * (Books and wiki search) for a filter over rows the page already holds, so
 * "Find a title" on Requests forgives what Books search forgives. The two are
 * held to the same cases (app/tests/search_match_vectors.json).
 *
 * matches(query, text): the whole query, folded (no case, no accents), inside
 * the text; or every significant word of the query a word of the text, in any
 * order, the last word perhaps only begun, a word of 4 to 7 letters with one
 * slip (a letter added, dropped, changed or two swapped), 8 or more with two;
 * a half-typed last word of 5 letters or more may slip against as much of a
 * word as was typed. Two neighbouring words also count run together ("leguin").
 * Filler words ("the", "of", ...) are left out of a query that has others.
 * An empty query matches everything.
 *
 * A page helper (data-ws-page-script): it loads once per document and only
 * defines window.WSSearch.
 */
(function () {
  'use strict';

  var FILLER = ['the', 'a', 'an', 'this', 'of', 'and', 'to', 'in', 'on'];
  var NUMBER_WORDS = ['book', 'vol', 'volume'];
  var QUOTES = { '’': "'", '‘': "'", '“': '"', '”': '"' };
  var LETTERS = { 'ø': 'o', 'ł': 'l', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss',
                  'đ': 'd', 'þ': 'th', 'ð': 'd', 'ı': 'i' };
  var BREAK = /[^\p{L}\p{N}]+/u;
  var DIGITS = /^\p{Nd}+$/u;

  /** book_catalog.fold: no accents, no case, plain quotes, spaces collapsed. */
  function fold(text) {
    var s = String(text == null ? '' : text).replace(/[‘’“”]/g, function (c) { return QUOTES[c]; });
    s = s.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
    s = s.replace(/[øłæœßđþðı]/g, function (c) { return LETTERS[c]; });
    return s.split(/\s+/).filter(Boolean).join(' ');
  }

  function plain(folded) { return folded.replace(/&/g, ' and ').replace(/['`‘’]/g, ''); }
  function split(text) { return text.split(BREAK).filter(Boolean); }
  function words(text) { return split(plain(fold(text))); }
  function len(word) { return Array.from(word).length; }

  /* The text's words plus the joined forms a reader may type: "Half-Blood"
     also as "halfblood", "J. R. R." also as "jrr", and two neighbouring words
     run together, "Le Guin" also as "leguin" (not with a filler word). */
  function itemWords(folded) {
    var out = [];
    var joined = [];
    plain(folded).split(/\s+/).forEach(function (chunk) {
      var parts = split(chunk);
      out.push.apply(out, parts);
      if (parts.length > 1) joined.push(parts.join(''));
    });
    var letters = [];
    out.concat(['']).forEach(function (w) {
      if (len(w) === 1 && /^\p{L}$/u.test(w)) { letters.push(w); return; }
      if (letters.length > 1) joined.push(letters.join(''));
      letters = [];
    });
    for (var i = 0; i + 1 < out.length; i++) {
      if (FILLER.indexOf(out[i]) === -1 && FILLER.indexOf(out[i + 1]) === -1) joined.push(out[i] + out[i + 1]);
    }
    return out.concat(joined);
  }

  function slipsAllowed(word) {
    if (/\p{Nd}/u.test(word) || len(word) < 4) return 0;
    return len(word) <= 7 ? 1 : 2;
  }

  /* Damerau-Levenshtein (optimal string alignment), or limit + 1 as soon as
     it must be more than `limit`. */
  function editDistance(a, b, limit) {
    a = Array.from(a);
    b = Array.from(b);
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    var prev2 = [];
    var prev = [];
    for (var j = 0; j <= b.length; j++) prev.push(j);
    for (var i = 1; i <= a.length; i++) {
      var cur = [i];
      var low = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur.push(v);
        if (v < low) low = v;
      }
      if (low > limit) return limit + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  function matches(query, text) {
    var hay = fold(text);
    if (hay.indexOf(fold(query)) !== -1) return true;
    var typed = words(query);
    var kept = typed.filter(function (w, i) {
      return !(NUMBER_WORDS.indexOf(w) !== -1 && i + 1 < typed.length && DIGITS.test(typed[i + 1]));
    });
    var significant = kept.filter(function (w) { return FILLER.indexOf(w) === -1; });
    var terms = significant.length ? significant : kept;
    if (!terms.length) return false;
    var last = terms[terms.length - 1];
    var prefixLast = kept[kept.length - 1] === last && !DIGITS.test(last);
    var item = itemWords(hay);
    return terms.every(function (term, i) {
      var limit = slipsAllowed(term);
      var half = prefixLast && i === terms.length - 1;
      var typed = len(term);
      return item.some(function (w) {
        if (w === term) return true;
        if (half && w.indexOf(term) === 0) return true;
        if (limit > 0 && editDistance(term, w, limit) <= limit) return true;
        // A half-typed word of 5 letters or more may slip too, against as
        // much of the item word as was typed: "inevt" is "inevi".
        if (half && typed >= 5 && len(w) > typed) {
          return editDistance(term, Array.from(w).slice(0, typed).join(''), limit) <= limit;
        }
        return false;
      });
    });
  }

  window.WSSearch = { matches: matches };
})();
