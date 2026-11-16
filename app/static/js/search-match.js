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
 * A query with nothing left once folded (empty, or a lone accent) matches nothing.
 *
 * A page helper (data-ws-page-script): it loads once per document and only
 * defines window.WSSearch.
 */
(function () {
  'use strict';

  var FILLER = ['the', 'a', 'an', 'this', 'of', 'and', 'to', 'in', 'on'];
  var NUMBER_WORDS = ['book', 'vol', 'volume'];
  var PAIRED_WORDS = 40;
  var QUOTES = { '’': "'", '‘': "'", '“': '"', '”': '"' };
  var LETTERS = { 'ø': 'o', 'ł': 'l', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss',
                  'đ': 'd', 'þ': 'th', 'ð': 'd', 'ı': 'i' };
  var BREAK = /[^\p{L}\p{N}]+/u;
  var DIGITS = /^\p{Nd}+$/u;
  // The characters Python's unicodedata.combining() gives a nonzero class,
  // which fold() drops after NFKD (Unicode 14.0, the app's Python 3.11). Not
  // \p{Mn}: that also drops U+FE0F and some Thai, Lao and Devanagari signs.
  var COMBINING = /[\u{300}-\u{34E}\u{350}-\u{36F}\u{483}-\u{487}\u{591}-\u{5BD}\u{5BF}\u{5C1}-\u{5C2}\u{5C4}-\u{5C5}\u{5C7}\u{610}-\u{61A}\u{64B}-\u{65F}\u{670}\u{6D6}-\u{6DC}\u{6DF}-\u{6E4}\u{6E7}-\u{6E8}\u{6EA}-\u{6ED}\u{711}\u{730}-\u{74A}\u{7EB}-\u{7F3}\u{7FD}\u{816}-\u{819}\u{81B}-\u{823}\u{825}-\u{827}\u{829}-\u{82D}\u{859}-\u{85B}\u{898}-\u{89F}\u{8CA}-\u{8E1}\u{8E3}-\u{8FF}\u{93C}\u{94D}\u{951}-\u{954}\u{9BC}\u{9CD}\u{9FE}\u{A3C}\u{A4D}\u{ABC}\u{ACD}\u{B3C}\u{B4D}\u{BCD}\u{C3C}\u{C4D}\u{C55}-\u{C56}\u{CBC}\u{CCD}\u{D3B}-\u{D3C}\u{D4D}\u{DCA}\u{E38}-\u{E3A}\u{E48}-\u{E4B}\u{EB8}-\u{EBA}\u{EC8}-\u{ECB}\u{F18}-\u{F19}\u{F35}\u{F37}\u{F39}\u{F71}-\u{F72}\u{F74}\u{F7A}-\u{F7D}\u{F80}\u{F82}-\u{F84}\u{F86}-\u{F87}\u{FC6}\u{1037}\u{1039}-\u{103A}\u{108D}\u{135D}-\u{135F}\u{1714}-\u{1715}\u{1734}\u{17D2}\u{17DD}\u{18A9}\u{1939}-\u{193B}\u{1A17}-\u{1A18}\u{1A60}\u{1A75}-\u{1A7C}\u{1A7F}\u{1AB0}-\u{1ABD}\u{1ABF}-\u{1ACE}\u{1B34}\u{1B44}\u{1B6B}-\u{1B73}\u{1BAA}-\u{1BAB}\u{1BE6}\u{1BF2}-\u{1BF3}\u{1C37}\u{1CD0}-\u{1CD2}\u{1CD4}-\u{1CE0}\u{1CE2}-\u{1CE8}\u{1CED}\u{1CF4}\u{1CF8}-\u{1CF9}\u{1DC0}-\u{1DFF}\u{20D0}-\u{20DC}\u{20E1}\u{20E5}-\u{20F0}\u{2CEF}-\u{2CF1}\u{2D7F}\u{2DE0}-\u{2DFF}\u{302A}-\u{302F}\u{3099}-\u{309A}\u{A66F}\u{A674}-\u{A67D}\u{A69E}-\u{A69F}\u{A6F0}-\u{A6F1}\u{A806}\u{A82C}\u{A8C4}\u{A8E0}-\u{A8F1}\u{A92B}-\u{A92D}\u{A953}\u{A9B3}\u{A9C0}\u{AAB0}\u{AAB2}-\u{AAB4}\u{AAB7}-\u{AAB8}\u{AABE}-\u{AABF}\u{AAC1}\u{AAF6}\u{ABED}\u{FB1E}\u{FE20}-\u{FE2F}\u{101FD}\u{102E0}\u{10376}-\u{1037A}\u{10A0D}\u{10A0F}\u{10A38}-\u{10A3A}\u{10A3F}\u{10AE5}-\u{10AE6}\u{10D24}-\u{10D27}\u{10EAB}-\u{10EAC}\u{10F46}-\u{10F50}\u{10F82}-\u{10F85}\u{11046}\u{11070}\u{1107F}\u{110B9}-\u{110BA}\u{11100}-\u{11102}\u{11133}-\u{11134}\u{11173}\u{111C0}\u{111CA}\u{11235}-\u{11236}\u{112E9}-\u{112EA}\u{1133B}-\u{1133C}\u{1134D}\u{11366}-\u{1136C}\u{11370}-\u{11374}\u{11442}\u{11446}\u{1145E}\u{114C2}-\u{114C3}\u{115BF}-\u{115C0}\u{1163F}\u{116B6}-\u{116B7}\u{1172B}\u{11839}-\u{1183A}\u{1193D}-\u{1193E}\u{11943}\u{119E0}\u{11A34}\u{11A47}\u{11A99}\u{11C3F}\u{11D42}\u{11D44}-\u{11D45}\u{11D97}\u{16AF0}-\u{16AF4}\u{16B30}-\u{16B36}\u{16FF0}-\u{16FF1}\u{1BC9E}\u{1D165}-\u{1D169}\u{1D16D}-\u{1D172}\u{1D17B}-\u{1D182}\u{1D185}-\u{1D18B}\u{1D1AA}-\u{1D1AD}\u{1D242}-\u{1D244}\u{1E000}-\u{1E006}\u{1E008}-\u{1E018}\u{1E01B}-\u{1E021}\u{1E023}-\u{1E024}\u{1E026}-\u{1E02A}\u{1E130}-\u{1E136}\u{1E2AE}\u{1E2EC}-\u{1E2EF}\u{1E8D0}-\u{1E8D6}\u{1E944}-\u{1E94A}]/gu;
  // Where Python's casefold() differs from toLowerCase() on folded text:
  // final sigma, old Cyrillic letter forms, and lowercase Cherokee (folded to
  // its capitals).
  var CASEFOLD = { '\u03c2': '\u03c3', '\u1c80': '\u0432', '\u1c81': '\u0434', '\u1c82': '\u043e',
                   '\u1c83': '\u0441', '\u1c84': '\u0442', '\u1c85': '\u0442', '\u1c86': '\u044a',
                   '\u1c87': '\u0463', '\u1c88': '\ua64b' };

  function casefold(c) {
    if (CASEFOLD[c]) return CASEFOLD[c];
    var n = c.codePointAt(0);
    if (n >= 0x13f8 && n <= 0x13fd) return String.fromCodePoint(n - 8);
    if (n >= 0xab70 && n <= 0xabbf) return String.fromCodePoint(n - 0x97d0);
    return c;
  }

  /** book_catalog.fold: no accents, no case, plain quotes, spaces collapsed. */
  function fold(text) {
    var s = String(text == null ? '' : text).replace(/[\u2018\u2019\u201c\u201d]/g, function (c) { return QUOTES[c]; });
    s = s.normalize('NFKD').replace(COMBINING, '').toLowerCase();
    s = s.replace(/[\u03c2\u1c80-\u1c88\u13f8-\u13fd\uab70-\uabbf]/g, casefold);
    s = s.replace(/[\u00f8\u0142\u00e6\u0153\u00df\u0111\u00fe\u00f0\u0131]/g, function (c) { return LETTERS[c]; });
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
    // Only in a short field (a name, a title), as on the server (PAIRED_WORDS).
    for (var i = 0; i + 1 < out.length && out.length <= PAIRED_WORDS; i++) {
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
    var phrase = fold(query);
    if (!phrase) return false;               // nothing left once folded ("\u00b4" alone)
    var hay = fold(text);
    if (hay.indexOf(phrase) !== -1) return true;
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
