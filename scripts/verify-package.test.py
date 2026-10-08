import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


class PackageVerification(unittest.TestCase):
    def archive(self, root, name, files, level):
        target = root / name
        with tarfile.open(target, "w:gz", compresslevel=level) as archive:
            for filename, content in files.items():
                member = tarfile.TarInfo("package/" + filename)
                member.size = len(content)
                member.mode = 0o644
                archive.addfile(member, io.BytesIO(content))
        return target

    def test_archive_encoding_does_not_hide_or_invent_content_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.archive(root, "source.tgz", {"tui.ts": b"export default plugin\n"}, 1)
            equivalent = self.archive(root, "registry.tgz", {"tui.ts": b"export default plugin\n"}, 9)
            changed = self.archive(root, "changed.tgz", {"tui.ts": b"export default different\n"}, 9)
            extra = self.archive(root, "extra.tgz", {"tui.ts": b"export default plugin\n", "extra": b"x"}, 9)
            self.assertNotEqual(source.read_bytes(), equivalent.read_bytes())
            script = Path(__file__).with_name("verify-package.py")
            for target, expected in [(equivalent, 0), (changed, 1), (extra, 1)]:
                result = subprocess.run([sys.executable, str(script), str(source), str(target)], capture_output=True)
                self.assertEqual(result.returncode, expected, result.stderr.decode())


if __name__ == "__main__":
    unittest.main()
