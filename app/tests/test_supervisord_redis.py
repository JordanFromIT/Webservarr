"""
The embedded Redis rewrites its append-only file early (audit F8).

Sessions, with their Plex and Kavita tokens, are written to the AOF; a
signed-out or expired one only gains a later DEL there, and its tokens stay
on disk until the file is rewritten. Redis's default rewrite threshold
(64 MB) is weeks away on this traffic, so supervisord.conf sets 4 MB.

Only CI lays the repo root out at /app; in the dev container, where only
app/ is mounted, the file is not there and the test skips.
"""
import configparser
import shlex
import unittest
from pathlib import Path

CONF = Path(__file__).resolve().parents[2] / "supervisord.conf"


@unittest.skipUnless(CONF.exists(), "needs the repo root's supervisord.conf")
class RedisCommand(unittest.TestCase):
    def setUp(self):
        parser = configparser.ConfigParser(interpolation=None, inline_comment_prefixes=(";",))
        parser.read(CONF, encoding="utf-8")
        self.argv = shlex.split(parser["program:redis"]["command"])

    def option(self, name):
        i = self.argv.index(name)
        return self.argv[i + 1]

    def test_the_aof_is_rewritten_from_4mb(self):
        self.assertEqual(self.option("--auto-aof-rewrite-min-size"), "4mb")

    def test_it_still_persists_by_aof_alone(self):
        self.assertEqual((self.option("--appendonly"), self.option("--save")), ("yes", ""))
        self.assertEqual(self.option("--bind"), "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
