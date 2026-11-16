"""
Matching what someone typed into a search box against an item's text: the
one set of rules behind every search over WebServarr's own data (Books, the
wiki). The Requests page's "Find a title" filter runs the same rules in the
browser (app/static/js/search-match.js); search_match_vectors.json holds
both to the same cases.

A query matches an item in one of four ways, best first (Match.tier):

  0. the whole query, folded (book_catalog.fold), is inside one field: what
     search always did, so a query that worked before ranks as it did;
  1. every significant word of the query is a word of the item, in any order
     and across fields ("dinniman ruin" is an author word and a title word);
  2. as 1, the last word only the start of one (search as you type);
  3. as 1 or 2, with a spelling slip or two in a word.

Words are the folded text split at anything that is not a letter or a digit,
apostrophes dropped first ("Carl's" is "carls") and "&" read as "and". Filler
words ("the", "of", ...) are left out of a query that has other words, so
"the inevitable ruin" finds "This Inevitable Ruin". A slip is one edit
(a letter added, dropped, changed, or two swapped) in a word of 4 to 7
letters, two in a word of 8 or more; shorter words and numbers must be exact.
"""
import re
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

from app.services.book_catalog import fold

FILLER = frozenset({"the", "a", "an", "this", "of", "and", "to", "in", "on"})
# Read as part of the number after them: "book 7" is "7".
NUMBER_WORDS = frozenset({"book", "vol", "volume"})

TIER_PHRASE, TIER_WORDS, TIER_PREFIX, TIER_TYPO = 0, 1, 2, 3
_EXACT, _PREFIX, _TYPO = 0, 1, 2

_APOSTROPHES = re.compile(r"['`‘’]")
_BREAK = re.compile(r"[\W_]+")


class Match(NamedTuple):
    """How an item matched; `rank` sorts best first. `group` is the field
    group the caller gave (lower is more important), `start` 0 when the match
    begins its field. `words` are the item's words that matched."""
    tier: int
    group: int
    edits: int
    start: int
    words: Tuple[str, ...] = ()

    @property
    def rank(self) -> Tuple[int, int, int, int]:
        return (self.tier, self.group, self.edits, self.start)


def _plain(folded: str) -> str:
    return _APOSTROPHES.sub("", folded.replace("&", " and "))


def _split(text: str) -> List[str]:
    return [w for w in _BREAK.split(text) if w]


def words(text) -> List[str]:
    """The words of `text` as a query reads them."""
    return _split(_plain(fold(text)))


def _item_words(folded: str) -> List[str]:
    """The words of an item's folded field, plus the joined forms a reader may
    type: "Half-Blood" also as "halfblood", "J. R. R." also as "jrr"."""
    out: List[str] = []
    for chunk in _plain(folded).split():
        parts = _split(chunk)
        out.extend(parts)
        if len(parts) > 1:
            out.append("".join(parts))
    letters: List[str] = []
    for w in out + [""]:
        if len(w) == 1 and w.isalpha():
            letters.append(w)
            continue
        if len(letters) > 1:
            out.append("".join(letters))
        letters = []
    return out


def initials(text) -> List[str]:
    """A name's initials, with and without a leading "the": "The Wheel of
    Time" gives "twot" and "wot". None for a one-word name."""
    ws = [w for w in words(text) if w.isalpha()]
    if len(ws) < 2:
        return []
    found = ["".join(w[0] for w in ws)]
    if ws[0] == "the" and len(ws) > 2:
        found.append("".join(w[0] for w in ws[1:]))
    return found


def _slips_allowed(word: str) -> int:
    if any(ch.isdigit() for ch in word) or len(word) < 4:
        return 0
    return 1 if len(word) <= 7 else 2


def edit_distance(a: str, b: str, limit: int) -> int:
    """Edits between `a` and `b` (Damerau-Levenshtein, optimal string
    alignment: a swap of two neighbours is one edit), or limit + 1 as soon as
    it must be more than `limit`."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2: List[int] = []
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > limit:
            return limit + 1
        prev2, prev = prev, cur
    return prev[-1]


def _one_edit(a: str, b: str) -> bool:
    """Whether two different words are exactly one edit apart: the common
    case (a word of 4 to 7 letters), without the full table."""
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diff) == 1 or (len(diff) == 2 and diff[1] == diff[0] + 1
                                  and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]])
    if abs(len(a) - len(b)) != 1:
        return False
    short, long_ = (a, b) if len(a) < len(b) else (b, a)
    i = 0
    while i < len(short) and short[i] == long_[i]:
        i += 1
    return short[i:] == long_[i + 1:]


class Query:
    """One search, parsed once and matched against many items. Holds memos of
    folded text and word comparisons, so make one per search, never one to
    keep."""

    def __init__(self, text) -> None:
        self.phrase = fold(text)
        typed = words(text)
        kept = [w for i, w in enumerate(typed)
                if not (w in NUMBER_WORDS and i + 1 < len(typed) and typed[i + 1].isdigit())]
        significant = [w for w in kept if w not in FILLER]
        self.terms: List[str] = significant or kept
        # The last word may be half typed, unless it was a filler left out.
        self._prefix_last = bool(self.terms) and bool(kept) and kept[-1] == self.terms[-1] \
            and not self.terms[-1].isdigit()
        self._slips = [_slips_allowed(t) for t in self.terms]
        self._letters = [frozenset(t) for t in self.terms]
        self._memo: List[Dict[str, Optional[Tuple[int, int]]]] = [{} for _ in self.terms]
        # Authors, series and narrators repeat across a library: fold each once.
        self._folded: Dict[str, str] = {}
        self._words: Dict[str, List[str]] = {}

    def _fold(self, text: str) -> str:
        found = self._folded.get(text)
        if found is None:
            found = self._folded[text] = fold(text)
        return found

    def _item_words(self, folded: str) -> List[str]:
        found = self._words.get(folded)
        if found is None:
            found = self._words[folded] = _item_words(folded)
        return found

    def _compare(self, i: int, word: str) -> Optional[Tuple[int, int]]:
        """(kind, edits) for query term `i` against an item word, or None."""
        memo = self._memo[i]
        if word in memo:
            return memo[word]
        term = self.terms[i]
        found: Optional[Tuple[int, int]] = None
        if term == word:
            found = (_EXACT, 0)
        elif self._prefix_last and i == len(self.terms) - 1 and word.startswith(term):
            found = (_PREFIX, 0)
        elif self._slips[i] == 1:
            if _one_edit(term, word):
                found = (_TYPO, 1)
        elif self._slips[i]:
            limit = self._slips[i]
            # Each edit brings in or takes out at most two different letters:
            # a cheap way to pass over most words before the table.
            if len(self._letters[i].symmetric_difference(word)) <= 2 * limit:
                edits = edit_distance(term, word, limit)
                if edits <= limit:
                    found = (_TYPO, edits)
        memo[word] = found
        return found

    def match(self, fields: Sequence[Tuple[int, str]],
              extra_words: Sequence[Tuple[int, str]] = ()) -> Optional[Match]:
        """How the item with these (group, text) fields matches, or None.
        `extra_words` are (group, word) pairs that count as words of the item
        but not as text to find the phrase in (a series' number, initials)."""
        folded = [(group, self._fold(text or "")) for group, text in fields]
        hits = [(group, 0 if text.startswith(self.phrase) else 1)
                for group, text in folded if self.phrase in text]
        if hits:
            group, start = min(hits)
            return Match(TIER_PHRASE, group, 0, start)
        if not self.terms:
            return None
        item = [(group, pos, w) for group, text in folded for pos, w in enumerate(self._item_words(text))]
        item += [(group, 1, w) for group, w in extra_words]
        best: List[Tuple[int, int, int, int, str]] = []
        for i in range(len(self.terms)):
            top = None
            for group, pos, w in item:
                found = self._compare(i, w)
                if found is not None:
                    candidate = (found[0], found[1], group, 0 if pos == 0 else 1, w)
                    if top is None or candidate < top:
                        top = candidate
            if top is None:
                return None
            best.append(top)
        tier = TIER_WORDS + max(kind for kind, *_ in best)
        return Match(tier, min(b[2] for b in best), sum(b[1] for b in best), best[0][3],
                     tuple(b[4] for b in best))
