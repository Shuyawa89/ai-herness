"""Snapshot cleanup must stay within the exact deck's generated sheets."""
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("snapshot", SCRIPTS / "snapshot.py")
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotCleanup(unittest.TestCase):
    def test_cleanup_matches_literal_stem_and_generated_sheet_number(self):
        with tempfile.TemporaryDirectory() as directory:
            deck = Path(directory) / "report[1].html"
            deck.write_text("<html></html>", encoding="utf8")
            generated = deck.with_name("report[1]_sheet-1.png")
            retained = [deck.with_name(name) for name in (
                "report1_sheet-1.png", "report[1]_sheet-notes.png",
                "report[1]_sheet-2.png.backup", "report[1]_page-1.png",
            )]
            for path in [generated, *retained]:
                path.write_bytes(b"fixture")
            stop_before_render = subprocess.CalledProcessError(1, "fixture-browser")
            with patch.object(sys, "argv", ["snapshot.py", str(deck)]), \
                    patch.object(snapshot, "chrome", return_value="fixture-browser"), \
                    patch.object(snapshot.subprocess, "run", side_effect=stop_before_render):
                with self.assertRaises(subprocess.CalledProcessError):
                    snapshot.main()
            self.assertFalse(generated.exists())
            for path in retained:
                self.assertTrue(path.exists(), path.name)
