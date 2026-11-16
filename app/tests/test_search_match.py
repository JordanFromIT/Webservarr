"""
Search matching (app/services/search_match.py) and the searches that use it.

The matcher is held to the shared cases in search_match_vectors.json, which
app/tests/js/search_match.mjs holds the browser's copy (search-match.js, the
Requests page's "Find a title") to. Books search is then run end to end
over a slice of a real library (public book data) with a corpus of real
queries: the whole title, misspellings, words out of order, a half-typed last
word, an author or narrator only, a series and a number, apostrophes and
hyphens, and queries that must find nothing. The wiki search uses the same
matcher, with its snippet on the word that matched.
"""
import json
import unittest
from pathlib import Path

try:
    from app.services import search_match
    from app.tests import helpers
    from app.tests.test_books_api import A, BooksBase, make_book
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    BooksBase = unittest.TestCase  # type: ignore[misc,assignment]  # keeps the class below importable

TESTS = Path(__file__).resolve().parent
VECTORS = json.loads((TESTS / "search_match_vectors.json").read_text(encoding="utf-8"))["cases"]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Matcher(unittest.TestCase):
    def test_the_shared_cases(self):
        for case in VECTORS:
            with self.subTest(query=case["query"], text=case["text"]):
                found = search_match.Query(case["query"]).match([(0, case["text"])])
                self.assertEqual(found is not None, case["match"])

    def test_the_tiers(self):
        def tier(q, text):
            return search_match.Query(q).match([(0, text)]).tier
        self.assertEqual(tier("inevitable ruin", "This Inevitable Ruin"), search_match.TIER_PHRASE)
        self.assertEqual(tier("ruin inevitable", "This Inevitable Ruin"), search_match.TIER_WORDS)
        self.assertEqual(tier("ruin inev", "This Inevitable Ruin"), search_match.TIER_PREFIX)
        self.assertEqual(tier("inevitible ruin", "This Inevitable Ruin"), search_match.TIER_TYPO)
        self.assertEqual(tier("ruin inevt", "This Inevitable Ruin"), search_match.TIER_TYPO)
        self.assertEqual(tier("leguin", "Le Guin"), search_match.TIER_WORDS)

    def test_words_match_across_fields_and_report_the_best_field(self):
        found = search_match.Query("dinniman ruin").match([(0, "This Inevitable Ruin"), (2, "Matt Dinniman")])
        self.assertEqual((found.tier, found.group, found.words), (search_match.TIER_WORDS, 0, ("dinniman", "ruin")))
        self.assertIsNone(search_match.Query("dinniman carl").match([(0, "This Inevitable Ruin"), (2, "Matt Dinniman")]))

    def test_extra_words_count_as_words_but_not_as_phrase_text(self):
        q = search_match.Query("dcc 7")
        self.assertIsNotNone(q.match([(1, "Dungeon Crawler Carl")], [(1, "dcc"), (1, "7")]))
        self.assertIsNone(q.match([(1, "Dungeon Crawler Carl")], [(1, "dcc"), (1, "8")]))

    def test_a_word_typed_twice_is_looked_for_once(self):
        self.assertEqual(search_match.Query("ruin ruin inev ruin").terms, ["inev", "ruin"])
        self.assertEqual(search_match.Query("ruin inev inev").terms, ["ruin", "inev"])   # the last stays last

    def test_nothing_left_once_folded_matches_nothing(self):
        for q in ("\u00b4", "\u00a8", "\u0301", ""):
            with self.subTest(q=q):
                self.assertIsNone(search_match.Query(q).match([(0, "Anything at all")]))

    def test_edit_distance(self):
        self.assertEqual(search_match.edit_distance("dnue", "dune", 1), 1)          # a swap is one edit
        self.assertEqual(search_match.edit_distance("dinnimen", "dinniman", 2), 1)
        self.assertEqual(search_match.edit_distance("inevitible", "inevitable", 2), 1)
        self.assertEqual(search_match.edit_distance("kitten", "sitting", 5), 3)
        self.assertEqual(search_match.edit_distance("abcdefgh", "zzzzzzzz", 2), 3)   # gave up past the limit
        self.assertEqual(search_match.edit_distance("ab", "abcdef", 1), 2)

    def test_initials(self):
        self.assertEqual(search_match.initials("Dungeon Crawler Carl"), ["dcc"])
        self.assertEqual(search_match.initials("The Wheel of Time"), ["twot", "wot"])
        self.assertEqual(search_match.initials("A Song of Ice and Fire"), ["asoiaf"])
        self.assertEqual(search_match.initials("Dune"), [])
        self.assertEqual(search_match.initials(""), [])


# A slice of a real library (public book data): (id, title, sort title, author, series, number, narrators).
LIBRARY = [
    (34, 'Dungeon Crawler Carl', None, 'Matt Dinniman', 'Dungeon Crawler Carl', None, ('Jeff Hays',)),
    (32, 'Dungeon Crawler Carl: A LitRPG/Gamelit Adventure', None, 'Matt Dinniman', 'Dungeon Crawler Carl', 1.0, ()),
    (14, "Carl's Doomsday Scenario", None, 'Matt Dinniman', 'Dungeon Crawler Carl', 2.0, ('Jeff Hays',)),
    (13, "The Dungeon Anarchist's Cookbook", "Dungeon Anarchist's Cookbook - Read by Jeff Hays", 'Matt Dinniman', 'Dungeon Crawler Carl', 3.0, ('Jeff Hays',)),
    (12, 'The Gate of the Feral Gods', 'Gate of the Feral Gods - Read by Jeff Hays', 'Matt Dinniman', 'Dungeon Crawler Carl', 4.0, ('Jeff Hays',)),
    (11, "The Butcher's Masquerade", "Butcher's Masquerade - Read by Jeff Hays", 'Matt Dinniman', 'Dungeon Crawler Carl', 5.0, ('Jeff Hays',)),
    (10, 'The Eye of the Bedlam Bride', 'Dungeon Crawler Carl 6 - The Eye of the Bedlam Bride', 'Matt Dinniman', 'Dungeon Crawler Carl', 6.0, ('Jeff Hays',)),
    (677, 'This Inevitable Ruin', None, 'Matt Dinniman', 'Dungeon Crawler Carl', 7.0, ('Jeff Hays',)),
    (678, 'A Parade of Horribles', 'Parade of Horribles - Read by Jeff Hays', 'Matt Dinniman', 'Dungeon Crawler Carl', 8.0, ('Jeff Hays',)),
    (44, 'Throne of Glass', None, 'Sarah J. Maas', '', None, ()),
    (8, 'Queen of Shadows', None, 'Sarah J. Maas', 'Throne of Glass', 4.0, ('Elizabeth Evans',)),
    (46, 'Empire of Storms', None, 'Sarah J. Maas', 'Throne of Glass', 5.0, ('Elizabeth Evans',)),
    (42, 'Tower of Dawn', None, 'Sarah J. Maas', 'Throne of Glass', 6.0, ('Elizabeth Evans',)),
    (47, 'Kingdom of Ash', None, 'Sarah J. Maas', 'Throne of Glass', 7.0, ('Elizabeth Evans',)),
    (31, 'House of Flame and Shadow', None, 'Sarah J. Maas', 'Crescent City', 3.0, ('Elizabeth Evans',)),
    (20, "Harry Potter and the Philosopher's Stone", None, 'J.K. Rowling', 'Harry Potter', None, ('Stephen Fry',)),
    (7, "Harry Potter and the Sorcerer's Stone", None, 'J.K. Rowling', 'Harry Potter', 1.0, ('Jim Dale', 'Full Cast')),
    (3, 'Harry Potter and the Chamber of Secrets', None, 'J.K. Rowling', 'Harry Potter', 2.0, ('Jim Dale', 'Full Cast', 'Stephen Fry')),
    (2, 'Harry Potter and the Prisoner of Azkaban', None, 'J.K. Rowling', 'Harry Potter', 3.0, ('Jim Dale', 'Full Cast', 'Stephen Fry')),
    (4, 'Harry Potter and the Goblet of Fire', None, 'J.K. Rowling', 'Harry Potter', 4.0, ('Jim Dale', 'Full Cast', 'Stephen Fry')),
    (5, 'Harry Potter and the Order of the Phoenix', None, 'J.K. Rowling', 'Harry Potter', 5.0, ('Jim Dale', 'Stephen Fry', 'Full Cast')),
    (6, 'Harry Potter and the Half-Blood Prince', None, 'J.K. Rowling', 'Harry Potter', 6.0, ('Full Cast', 'Jim Dale', 'Stephen Fry')),
    (1, 'Harry Potter and the Deathly Hallows', None, 'J.K. Rowling', 'Harry Potter', 7.0, ('Full Cast', 'Jim Dale', 'Stephen Fry')),
    (75, 'Harry Potter 02 - Harry Potter and the Chamber of Secrets', None, 'J. K. Rowling', 'Harry Potter', 2.0, ()),
    (446, 'A Crown of Swords', 'Crown of Swords - Read by Kate Reading', 'Robert Jordan', 'The Wheel of Time', None, ('Kate Reading',)),
    (402, 'A Memory of Light', 'Memory of Light - Read by Michael Kramer', 'Robert Jordan', 'The Wheel of Time', None, ('Michael Kramer',)),
    (451, 'Knife of Dreams', None, 'Robert Jordan', 'The Wheel of Time', None, ('Kate Reading',)),
    (473, 'New Spring: The Novel', None, 'Robert Jordan', 'The Wheel of Time', 0.0, ()),
    (425, 'Path of Daggers', None, 'Robert Jordan', 'The Wheel of Time', None, ('Michael Kramer',)),
    (474, 'The Gathering Storm', 'Gathering Storm - Read by Michael Kramer', 'Robert Jordan', 'The Wheel of Time', None, ('Michael Kramer',)),
    (397, 'The Eye of the World', 'Eye of the World - Read by Michael Kramer', 'Robert Jordan', 'The Wheel of Time', 1.0, ('Michael Kramer',)),
    (407, 'The Great Hunt', 'Great Hunt - Read by Kate Reading', 'Robert Jordan', 'The Wheel of Time', 2.0, ('Kate Reading',)),
    (405, 'The Dragon Reborn', 'Dragon Reborn - Read by Kate Reading', 'Robert Jordan', 'The Wheel of Time', 3.0, ('Kate Reading',)),
    (400, 'Lord of Chaos', None, 'Robert Jordan', 'The Wheel of Time', 6.0, ('Kate Reading',)),
    (524, 'The Shadow Rising', 'Shadow Rising - Read by Rosamund Pike', 'Robert Jordan', 'The Wheel of Time', 8.0, ('Rosamund Pike',)),
    (711, 'The path of daggers', None, 'Robert Jordan', 'The Wheel of Time', 8.0, ()),
    (490, "Winter's Heart", None, 'Robert Jordan', 'The Wheel of Time', 9.0, ()),
    (435, 'Crossroads of Twilight', None, 'Robert Jordan', 'The Wheel of Time', 10.0, ('Kate Reading',)),
    (492, 'Towers of Midnight', None, 'Robert Jordan', 'The Wheel of Time', 13.0, ('Kate Reading',)),
    (501, 'A Memory of Light', None, 'Brandon Sanderson', 'The Wheel of Time', 14.0, ()),
    (315, 'The Fellowship of the Ring', 'Fellowship of the Ring - Read by Rob Inglis', 'J.R.R. Tolkien', 'The Lord of the Rings', None, ('Rob Inglis',)),
    (326, 'The Hobbit', 'Hobbit - Read by Andy Serkis', 'J.R.R. Tolkien', 'The Lord of the Rings', 0.0, ('Andy Serkis',)),
    (321, 'The Return of the King', 'Return of the King - Read by Rob Inglis', 'J.R.R. Tolkien', 'The Lord of the Rings', None, ('Rob Inglis',)),
    (310, 'The Two Towers', 'Two Towers - Read by Rob Inglis', 'J.R.R. Tolkien', 'The Lord of the Rings', None, ('Rob Inglis',)),
    (15, 'A Game of Thrones', 'Game of Thrones - Read by Roy Dotrice', 'George R.R. Martin', 'A Song of Ice and Fire', 1.0, ('Roy Dotrice',)),
    (16, 'A Clash of Kings', 'Clash of Kings - Read by Roy Dotrice', 'George R.R. Martin', 'A Song of Ice and Fire', 2.0, ('Roy Dotrice',)),
    (17, 'A Storm of Swords', 'Storm of Swords - Read by Roy Dotrice', 'George R.R. Martin', 'A Song of Ice and Fire', 3.0, ('Roy Dotrice',)),
    (18, 'A Feast for Crows', 'Feast for Crows - Read by Roy Dotrice', 'George R.R. Martin', 'A Song of Ice and Fire', 4.0, ('Roy Dotrice',)),
    (19, 'A Dance with Dragons', 'Dance with Dragons - Read by Roy Dotrice', 'George R.R. Martin', 'A Song of Ice and Fire', 5.0, ('Roy Dotrice',)),
    (374, 'Dune', None, 'Frank Herbert', '', 1.0, ()),
    (385, 'Dune Messiah - Full Cast', None, 'Frank Herbert', 'Dune', 2.0, ()),
    (389, 'Children Of Dune', None, 'Frank Herbert', 'Dune', 3.0, ()),
    (390, 'God Emperor of Dune - Full Cast', None, 'Frank Herbert', 'Dune', 4.0, ()),
    (365, 'Heretics Of Dune', None, 'Frank Herbert', 'Dune', 5.0, ()),
    (380, 'Chapterhouse Dune - Full Cast', None, 'Frank Herbert', 'Dune', 6.0, ()),
    (360, 'Children of Dune - Scott Brick + Simon Vance', None, 'Frank Herbert', '', None, ()),
    (364, 'Heretics of Dune - Frank Herbert', None, 'Frank Herbert', '', None, ()),
    (684, 'The Light Fantastic - Full Cast', 'Light Fantastic - Full Cast', 'Terry Pratchett', 'Discworld', 2.0, ()),
    (648, 'Equal Rites - Full Cast', None, 'Terry Pratchett', 'Discworld', 3.0, ()),
    (709, 'Wyrd Sisters', None, 'Terry Pratchett', 'Discworld', 6.0, ()),
    (394, 'Pyramids', None, 'Terry Pratchett', 'Discworld', 7.0, ()),
    (379, 'Guards! Guards!', None, 'Terry Pratchett', 'Discworld', 8.0, ()),
    (525, 'Eric', None, 'Terry Pratchett', 'Discworld', 9.0, ()),
    (443, 'Lords and Ladies', None, 'Terry Pratchett', 'Discworld', 14.0, ()),
    (442, 'Lords and Ladies - Nigel Planer', None, 'Terry Pratchett', '', None, ()),
    (504, 'The Last Continent', None, 'Terry Pratchett', 'Discworld', 22.0, ()),
    (503, 'The Last Continent - Nigel Planer', 'Last Continent - Nigel Planer', 'Terry Pratchett', '', None, ()),
    (514, "The Shepherd's Crown", None, 'Terry Pratchett', 'Discworld', 41.0, ()),
    (513, "The Shepherd's Crown - Stephen Briggs", "Shepherd's Crown - Stephen Briggs", 'Terry Pratchett', '', None, ()),
    (683, 'The Colour of Magic - Full Cast', 'Colour of Magic - Full Cast', 'Terry Pratchett', '', None, ()),
    (624, 'Mort - Full Cast', None, 'Terry Pratchett', '', None, ()),
    (100, 'Tales from Earthsea', None, 'Ursula K. Le Guin', 'The Earthsea Quartet', None, ('Jenny Sterlin',)),
    (104, 'A Wizard of Earthsea', 'Wizard of Earthsea - Read by Rob Inglis', 'Ursula K. Le Guin', 'The Earthsea Quartet', 1.0, ('Rob Inglis',)),
    (99, 'The Tombs of Atuan', 'Tombs of Atuan - Read by Rob Inglis', 'Ursula K. Le Guin', 'The Earthsea Quartet', 2.0, ('Rob Inglis',)),
    (117, 'The Farthest Shore', 'Farthest Shore - Read by Rob Inglis', 'Ursula K. Le Guin', 'The Earthsea Quartet', 3.0, ('Rob Inglis',)),
    (91, 'Tehanu', None, 'Ursula K. Le Guin', 'The Earthsea Quartet', 4.0, ('Jenny Sterlin',)),
    (111, 'The Other Wind', 'Other Wind - Read by Samuel Roukin', 'Ursula K. Le Guin', 'The Earthsea Quartet', 6.0, ('Samuel Roukin',)),
    (439, 'The Hunger Games', 'Hunger Games', 'Suzanne Collins', '', None, ()),
    (453, 'Catching Fire', None, 'Suzanne Collins', 'The Hunger Games', None, ('Tatiana Maslany',)),
    (607, 'The Ballad of Songbirds and Snakes', None, 'Suzanne Collins', 'The Hunger Games', 0.0, ()),
    (606, 'Hunger Games 02 - Catching Fire', None, 'Suzanne Collins', 'The Hunger Games', 2.0, ()),
    (515, 'Mockingjay', None, 'Suzanne Collins', 'The Hunger Games', 3.0, ('Tatiana Maslany',)),
    (448, 'The Ballad of Songbirds and Snakes - Santino Fontana', 'Ballad of Songbirds and Snakes - Santino Fontana', 'Suzanne Collins', '', None, ()),
    (610, 'Sunrise on the Reaping', None, 'Suzanne Collins', '', None, ()),
    (427, 'Sunrise on the Reaping - Jefferson White', None, 'Suzanne Collins', '', None, ()),
    (325, 'The Lion, the Witch and the Wardrobe', None, 'C. S. Lewis', 'The Chronicles of Narnia (Chronological Order)', 2.0, ()),
    (370, 'The Voyage of the Dawn Treader', None, 'C. S. Lewis', 'The Chronicles of Narnia (Publication Order)', 3.0, ()),
    (371, "The Magician's Nephew", None, 'C. S. Lewis', 'The Chronicles of Narnia (Publication Order)', 6.0, ()),
    (376, 'The Last Battle', None, 'C. S. Lewis', 'The Chronicles of Narnia (Publication Order)', 7.0, ()),
    (332, 'The Lion, The Witch and The Wardrobe - GraphicAudio', 'Lion, The Witch and The Wardrobe - GraphicAudio', 'C.S. Lewis', '', None, ()),
    (644, 'Prince Caspian - Rupert Degas', None, 'C.S. Lewis', '', None, ()),
    (667, 'The Horse and His Boy - Rupert Degas', 'Horse and His Boy - Rupert Degas', 'C.S. Lewis', '', None, ()),
    (690, 'The Last Battle - Rupert Degas', 'Last Battle - Rupert Degas', 'C.S. Lewis', '', None, ()),
    (662, "The Magician's Nephew - Rupert Degas", "Magician's Nephew - Rupert Degas", 'C.S. Lewis', '', None, ()),
    (689, 'The Silver Chair - Rupert Degas', 'Silver Chair - Rupert Degas', 'C.S. Lewis', '', None, ()),
    (687, 'The Voyage of the Dawn Treader - Rupert Degas', 'Voyage of the Dawn Treader - Rupert Degas', 'C.S. Lewis', '', None, ()),
    (278, 'The Case-Book of Sherlock Holmes', 'Case-Book of Sherlock Holmes', 'Arthur Doyle', '', None, ()),
    (757, 'The Case-Book of Sherlock Holmes', None, 'Sir Arthur Conan Doyle', 'Sherlock Holmes', 9.0, ()),
    (508, 'The Return of Sherlock Holmes - Arthur Conan Doyle + David Timson', 'Return of Sherlock Holmes - Arthur Conan Doyle + David Timson', 'Arthur Doyle', '', None, ()),
    (329, 'The Hound of the Baskervilles - Arthur Conan Doyle + David Case', 'Hound of the Baskervilles - Arthur Conan Doyle + David Case', 'Arthur Doyle', '', None, ()),
    (605, 'The Sign of Four - Patrick Tull', 'Sign of Four - Patrick Tull', 'Arthur Doyle', '', None, ()),
    (336, 'The Valley of Fear - John Bolen', 'Valley of Fear - John Bolen', 'Arthur Doyle', '', None, ()),
    (318, 'A Study in Scarlet - Laurie Anne Walden', 'Study in Scarlet - Laurie Anne Walden', 'Arthur Doyle', '', None, ()),
    (53, "The Hitchhiker's Guide to the Galaxy", "Hitchhiker's Guide to the Galaxy - Read by Douglas Adams", 'Douglas Adams', '', None, ('Douglas Adams',)),
    (64, "The Ultimate Hitchhiker\\'s Guide to the Galaxy - PDFDrive.com", None, 'Douglas Adams', '', None, ()),
    (601, 'Slaughterhouse-Five', None, 'Kurt Vonnegut', '', None, ()),
    (257, 'Brave New World', None, 'Aldous Huxley', '', 1.0, ('Michael York',)),
    (567, 'Fahrenheit 451', None, 'Ray Bradbury', '', None, ()),
    (185, 'Fahrenheit 451 A Novel (Audible Audio) - Penn Badgley', None, 'Ray Bradbury', '', None, ()),
    (123, '1984', None, 'George Orwell', '', None, ()),
    (134, 'Nineteen Eighty-Four', None, 'George Orwell', '', None, ()),
    (157, 'Animal Farm', None, 'George Orwell', '', None, ('Ralph Cosham',)),
    (116, "Alice's Adventures in Wonderland", None, 'Lewis Carroll', '', None, ()),
    (138, 'Charlotte’s Web', None, 'E.B. White', '', None, ()),
    (130, "A Room of One's Own", "Room of One's Own - Read by Natalie Dormer", 'Virginia Woolf', '', None, ('Natalie Dormer',)),
    (702, 'A Room of One’s Own', None, '1882-1941', '', None, ()),
    (66, "One Flew Over the Cuckoo's Nest", None, 'Ken Kesey', '', None, ('John C. Reilly',)),
    (581, 'Les Misérables', None, 'Victor Hugo', '', None, ()),
    (589, 'Les Misérables - GraphicAudio', 'Les Miserables - GraphicAudio', 'Victor Hugo', '', None, ()),
    (22, 'Quicksilver (The Fae & Alchemy Series Book 1)', None, 'Callie Hart', 'Fae & Alchemy', 1.0, ()),
    (52, "Ender's Game - Harlan Ellison + Stefan Rudnicki", None, 'Orson Card', '', None, ()),
    (636, "Ender's Game", None, 'Orson Scott Card', "Ender's Saga", 1.0, ()),
    (72, 'Rule of Two', None, 'Drew Karpyshyn', '', None, ()),
    (40, 'Rule of Two - Jonathan Davis', None, 'Drew Karpyshyn', '', None, ()),
    (35, 'Dynasty of Evil', None, 'Drew Karpyshyn', 'Star Wars: Darth Bane Trilogy - Legends', None, ('Jonathan Davis',)),
    (71, 'Path of Destruction', None, 'Drew Karpyshyn', 'Star Wars: Darth Bane Trilogy - Legends', None, ('Jonathan Davis',)),
    (62, 'Snow Crash', None, 'Neal Stephenson', '', None, ('Jonathan Davis',)),
    (49, 'Jurassic Park', None, 'Michael Crichton', 'Jurassic Park', None, ('Scott Brick',)),
    (74, 'The Lost World', 'Lost World - Read by Scott Brick', 'Michael Crichton', 'Jurassic Park', 2.0, ('Scott Brick',)),
]

# Real queries and what Books search must answer: a list is the exact answer in
# order; ("first", id) the top hit; ("top", ids) the first len(ids) hits, in order.
DCC = [11, 14, 13, 34, 10, 32, 12, 678, 677]   # Dungeon Crawler Carl, by sort title
CORPUS = [
    # The report that started this: the series' book 7 is "This Inevitable Ruin".
    ("the inevitable ruin", [677]),
    ("This Inevitable Ruin", [677]),
    ("inevitable", [677]),
    ("inevitible ruin", [677]),
    ("inevitable ruins", [677]),
    ("ruin inevitable", [677]),
    ("inev", [677]),
    ("inevt", [677]),                                # a slip in the half-typed last word
    ("dinniman ruin", [677]),
    ("inevitable ruin dinniman", [677]),
    ("ruin", ("first", 677)),
    # Authors and narrators, spelled right and wrong.
    ("matt dinniman", DCC),
    ("dinnimen", DCC),
    ("jeff hays", [11, 14, 13, 34, 10, 12, 678, 677]),
    ("jim dale", ("top", [3, 1, 4, 6, 5, 2, 7])),
    ("rob inglis", [117, 315, 321, 99, 310, 104]),
    ("tolkein", [315, 326, 321, 310]),
    ("pratchett guards", [379]),
    ("huxley brave", [257]),
    ("leguin", [117, 111, 100, 91, 99, 104]),       # "Le Guin" typed without the space
    # Series and numbers.
    ("dungeon crawler carl 7", [677]),
    ("dungeon crawler carl book 7", [677]),
    ("#7 dungeon crawler carl", [677]),
    ("dcc 7", [677]),
    ("harry potter 3", [2]),
    ("harry potter 1", [7]),
    ("wheel of time 14", [501]),
    ("wot 2", [407]),
    ("asoiaf 3", [17]),
    ("lotr", [315, 326, 321, 310]),
    ("chronicles of narnia 7", [376]),
    ("the hunger games 2", [606]),
    # Titles: misspelt, partial, out of order, punctuation.
    ("throne of glas", [44, 46, 47, 8, 42]),
    ("throne of glass", [44, 46, 47, 8, 42]),
    ("game thrones", [15]),
    ("a game of thrones", [15]),
    ("prisoner azkaban", [2]),
    ("half blood prince", [6]),
    ("hary poter", ("top", [75, 3, 1, 4, 6, 5])),
    ("sherlok holmes", [278, 508, 757]),
    ("wizzard earthsea", [104]),
    ("sunrise reaping", [610, 427]),
    ("carl's doomsday", [14]),
    ("carls doomsday", [14]),
    ("doomsday carl", [14]),
    ("hitchhikers guide", [53, 64]),
    ("slaughterhouse five", [601]),
    ("slaughterhousefive", [601]),
    ("les miserables", [581, 589]),
    ("fahrenheit 451", [567, 185]),
    ("dune messiah", [385]),
    ("the hobbit", [326]),
    # Nothing that is not there.
    ("dune 7", []),
    ("harry potter 9", []),
    ("zzzz", []),
    ("inex", []),                                    # under 5 letters a half word must be exact
]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class BooksSearchCorpus(BooksBase):
    def setUp(self):
        super().setUp()
        from app.models import Book, BookAudioEdition
        self.db.query(BookAudioEdition).delete()
        self.db.query(Book).delete()
        self.db.commit()
        for id_, title, sort_title, author, series, number, narrators in LIBRARY:
            make_book(self.db, id_, title, author, series, number, chapter=10000 + id_, sort_title=sort_title,
                      editions=[(f"{id_}:{i}", n) for i, n in enumerate(narrators)])
        self.as_user(A)

    def found(self, q):
        return [i["id"] for i in self.ok("/api/books/search", q=q, limit=60)["items"]]

    def test_the_corpus(self):
        self.assertGreaterEqual(len(CORPUS), 30)
        for q, want in CORPUS:
            with self.subTest(q=q):
                got = self.found(q)
                if isinstance(want, list):
                    self.assertEqual(got, want)
                elif want[0] == "first":
                    self.assertEqual(got[:1], [want[1]])
                else:
                    self.assertEqual(got[:len(want[1])], want[1])

    def test_whole_query_matches_still_come_first(self):
        # "carl" inside a title or series (as search always matched) before a word only near it.
        self.assertEqual(self.found("carl")[:4], [14, 34, 32, 318])
        # "ruin" in a title first, then the slips ("Le Guin" is one letter off).
        self.assertEqual(self.found("ruin"), [677, 117, 111, 100, 91, 99, 104])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class WikiSearch(unittest.TestCase):
    def setUp(self):
        from unittest import mock
        from app.models import WikiPage

        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        for slug, title, summary, content in (
            ("getting-started", "Getting Started", "Your first steps.", "Sign in with your account, then pick a library."),
            ("requests", "Requesting a Film", "How to ask for something new.", "Open Requests and search for the title."),
            ("audiobooks", "Listening to Audiobooks", "", "The player remembers your place on every device."),
        ):
            db.add(WikiPage(title=title, slug=slug, summary=summary, content=content, content_html="<p>x</p>",
                            published=True, author_name="Admin"))
        db.commit()
        db.close()
        patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(helpers.reset_overrides)
        self.client = helpers.api_client(self.Session, helpers.ADMIN, headers=helpers.SAME_ORIGIN)

    def search(self, q):
        r = self.client.get("/api/wiki/pages", params={"q": q})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_whole_term_hits_rank_title_then_summary_then_body(self):
        self.assertEqual([(p["slug"], p["matched_in"]) for p in self.search("request")],
                         [("requests", "title")])
        self.assertEqual([(p["slug"], p["matched_in"]) for p in self.search("the")],
                         [("getting-started", "body"), ("audiobooks", "body"), ("requests", "body")])

    def test_misspelt_and_reordered_words_are_found(self):
        for q in ("audiobok", "listening audiobooks", "audiobooks listen", "requesting film", "flim request"):
            with self.subTest(q=q):
                self.assertEqual(len(self.search(q)), 1)
        self.assertEqual(self.search("zzzz"), [])

    def test_the_snippet_highlights_the_word_that_matched(self):
        [page] = self.search("rememberz place")
        self.assertEqual(page["matched_in"], "body")
        hit = page["snippet"][page["match_offset"]:page["match_offset"] + page["match_length"]]
        self.assertEqual(hit, "remembers")

    def test_a_long_query_is_refused_like_books(self):
        self.assertEqual(len(self.search("x" * 100)), 0)
        self.assertEqual(self.client.get("/api/wiki/pages", params={"q": "x" * 101}).status_code, 422)

    def test_a_query_of_repeated_words_stays_fast(self):
        import time
        from app.models import WikiPage
        db = self.Session()
        words = " ".join(f"word{i} lorem{i % 97} ipsum{i % 89}" for i in range(4000))
        for n in range(20):
            db.add(WikiPage(title=f"Long {n}", slug=f"long-{n}", content=words, content_html="<p>x</p>",
                            published=True, author_name="Admin"))
        db.commit()
        db.close()
        start = time.perf_counter()
        self.assertEqual(self.search(("zqxwvkpj " * 11).strip()), [])
        self.assertLess(time.perf_counter() - start, 2.0)

    def test_an_accent_alone_finds_nothing(self):
        for q in ("\u00b4", "\u00a8", "\u0301"):
            with self.subTest(q=q):
                self.assertEqual(self.search(q), [])

    def test_no_term_lists_every_page(self):
        self.assertEqual(len(self.search("")), 3)


if __name__ == "__main__":
    unittest.main()
