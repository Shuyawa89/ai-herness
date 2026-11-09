"""Regression tests for the optional shared-file reporting helper."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "skills/task-dashboard/scripts/update_progress.py"


class ReportingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "progress.json"
        self.path.write_text(json.dumps({"title": "Concurrent task", "phase": 0,
                                         "phases": [{"name": "Build", "items": []}],
                                         "agents": [{"id": "parent", "name": "Parent"}]}))

    def update(self, *args, success=True):
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.path), *args],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return json.loads(self.path.read_text())

    def test_parallel_children_and_task_updates_preserve_every_participant(self):
        calls = [("agent", f"child-{i}", "--name", f"Child {i}", "--parent-id", "parent",
                  "--status", "running", "--event", f"Started {i}") for i in range(20)]
        calls.append(("task", "--patch", '{"summary":"Parent is waiting","status":"running"}'))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda args: self.update(*args), calls))
        data = json.loads(self.path.read_text())
        self.assertEqual(len(data["agents"]), 21)
        self.assertEqual(len(data["events"]), 20)
        self.assertEqual(data["summary"], "Parent is waiting")
        self.assertEqual(data["phases"][0]["name"], "Build")
        self.assertTrue(all(agent.get("startedAt") for agent in data["agents"][1:]))

    def test_concurrent_partial_reports_preserve_existing_and_late_nested_agents(self):
        self.update("agent", "parent", "--status", "running", "--current", "Delegating")
        self.update("agent", "child", "--name", "Child", "--status", "running",
                    "--parent-id", "parent")
        calls = [("agent", "child", "--current", "Verifying output"),
                 ("agent", "child", "--model", "Example model"),
                 ("agent", "late-child", "--name", "Nested child", "--parent-id", "child",
                  "--status", "running")]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda args: self.update(*args), calls))
        data = json.loads(self.path.read_text())
        agents = {agent["id"]: agent for agent in data["agents"]}
        self.assertEqual(agents["child"]["current"], "Verifying output")
        self.assertEqual(agents["child"]["model"], "Example model")
        self.assertEqual(agents["late-child"]["parentId"], "child")
        self.assertEqual(agents["parent"]["current"], "Delegating")

    def test_partial_updates_and_terminal_timestamp_freeze(self):
        data = self.update("agent", "child", "--name", "Child", "--model", "Example model",
                           "--status", "pending")
        self.assertNotIn("startedAt", data["agents"][-1])
        data = self.update("agent", "child", "--status", "running", "--current", "Building")
        started = data["agents"][-1]["startedAt"]
        data = self.update("agent", "child", "--status", "completed", "--event", "Build complete")
        ended = data["agents"][-1]["endedAt"]
        data = self.update("agent", "child", "--status", "completed", "--current", "Delivered")
        self.assertEqual(data["agents"][-1]["startedAt"], started)
        self.assertEqual(data["agents"][-1]["endedAt"], ended)
        self.assertEqual(data["agents"][-1]["model"], "Example model")
        self.assertEqual(data["events"][0]["agentId"], "child")
        data = self.update("agent", "child", "--status", "running")
        self.assertNotIn("endedAt", data["agents"][-1])
        self.assertNotEqual(data["agents"][-1]["startedAt"], started)

    def test_task_lifecycle_and_plan_patch_do_not_replace_agents(self):
        data = self.update("task", "--patch", '{"status":"running"}')
        started = data["startedAt"]
        data = self.update("task", "--patch", '{"status":"completed"}')
        ended = data["endedAt"]
        data = self.update("task", "--patch", '{"status":"completed","summary":"Done"}')
        self.assertEqual((data["startedAt"], data["endedAt"]), (started, ended))
        self.assertEqual(data["agents"][0]["name"], "Parent")

    def test_bad_updates_leave_original_bytes_unchanged(self):
        cases = [("agent", "bad id", "--name", "Bad"),
                 ("agent", "missing-name", "--status", "running"),
                 ("task", "--patch", '{"agents":[]}'),
                 ("task", "--patch", '{"phase":5}'),
                 ("task", "--patch", '{"phases":[{"name":"Bad","items":[{}]}]}'),
                 ("task", "--patch", '{"summary":1}'),
                 ("task", "--patch", '{"summary":NaN}')]
        before = self.path.read_bytes()
        for args in cases:
            self.update(*args, success=False)
            self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_existing_data_is_not_silently_replaced(self):
        for bad in ({"title": "Task", "agents": [{"id": "x", "name": "X"}] * 2},
                    {"title": "Task", "startedAt": "yesterday"},
                    {"title": "Task", "events": [{}]}):
            self.path.write_text(json.dumps(bad))
            before = self.path.read_bytes()
            self.update("task", "--patch", '{"status":"running"}', success=False)
            self.assertEqual(self.path.read_bytes(), before)

    def test_events_are_bounded(self):
        data = json.loads(self.path.read_text())
        data["events"] = [{"title": str(i)} for i in range(500)]
        self.path.write_text(json.dumps(data))
        data = self.update("agent", "parent", "--event", "New report")
        self.assertEqual(len(data["events"]), 500)
        self.assertEqual(data["events"][0]["title"], "1")
        self.assertEqual(data["events"][-1]["title"], "New report")


if __name__ == "__main__":
    unittest.main()
