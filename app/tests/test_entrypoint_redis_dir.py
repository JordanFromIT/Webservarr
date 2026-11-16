"""
The root entrypoint never follows a link planted at the Redis folder (audit F5).

docker-entrypoint.sh runs as root over /app/data, which appuser owns, so
appuser can replace /app/data/redis with a symlink. Following it (chown and
chmod dereference by default) would hand any file or folder to appuser at
the next start. The script now removes a link there before creating the
folder, chowns with -h and tries chmod as appuser first.

The script runs here on a scratch copy of its folders (the /app paths are
rewritten to a temporary directory, and the final exec runs `true`). Only
CI lays the repo root out at /app; in the dev container, where only app/ is
mounted, the script is not there and the test skips.
"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "docker-entrypoint.sh"


@unittest.skipUnless(SCRIPT.exists() and shutil.which("sh"), "needs the repo root's docker-entrypoint.sh")
class RedisDirSymlink(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ws-entrypoint-"))
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / "data").mkdir()
        (self.tmp / "uploads").mkdir()
        self.script = self.tmp / "entrypoint.sh"
        text = SCRIPT.read_text(encoding="utf-8")
        text = text.replace("/app/app/static/uploads", str(self.tmp / "uploads"))
        text = text.replace("/app/data", str(self.tmp / "data"))
        self.assertNotIn("/app/", text)
        self.script.write_text(text, encoding="utf-8")

    def run_script(self):
        return subprocess.run(["sh", str(self.script), "true"], capture_output=True, text=True, timeout=30)

    def test_a_planted_link_is_removed_and_its_target_untouched(self):
        target = self.tmp / "supervisord.conf"
        target.write_text("[supervisord]\n", encoding="utf-8")
        target.chmod(0o644)
        redis_dir = self.tmp / "data" / "redis"
        redis_dir.symlink_to(target)

        done = self.run_script()

        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
        self.assertEqual(target.read_text(encoding="utf-8"), "[supervisord]\n")
        self.assertFalse(redis_dir.is_symlink())
        self.assertTrue(redis_dir.is_dir())
        self.assertEqual(stat.S_IMODE(redis_dir.stat().st_mode), 0o700)
        self.assertIn("was a symlink", done.stderr)

    def test_a_link_to_a_folder_is_not_followed_either(self):
        target = self.tmp / "etc"
        target.mkdir()
        target.chmod(0o755)
        redis_dir = self.tmp / "data" / "redis"
        redis_dir.symlink_to(target)

        done = self.run_script()

        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)
        self.assertFalse(redis_dir.is_symlink())
        self.assertEqual(stat.S_IMODE(redis_dir.stat().st_mode), 0o700)

    def test_a_real_folder_is_kept_and_tightened(self):
        redis_dir = self.tmp / "data" / "redis"
        redis_dir.mkdir(mode=0o755)
        (redis_dir / "appendonly.aof").write_text("x", encoding="utf-8")
        os.chmod(redis_dir, 0o755)

        done = self.run_script()

        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(stat.S_IMODE(redis_dir.stat().st_mode), 0o700)
        self.assertTrue((redis_dir / "appendonly.aof").exists())
        self.assertNotIn("was a symlink", done.stderr)


if __name__ == "__main__":
    unittest.main()
