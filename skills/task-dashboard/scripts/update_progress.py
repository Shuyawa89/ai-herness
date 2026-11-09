#!/usr/bin/env python3
"""Merge small reports into progress.json; Python stdlib, macOS/Linux (fcntl).

All concurrent writers must use this helper and its persistent .lock file.
This updates a file only: it does not launch agents or monitor processes.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile

STATUSES = {"pending", "running", "waiting", "failed", "completed", "unknown"}
TERMINAL = {"failed", "completed"}
TASK_FIELDS = {"title", "summary", "id", "status", "reason", "phase", "phases"}


def require(condition):
    if not condition:
        raise ValueError("Invalid progress data or report")


def text(value, required=False):
    require(isinstance(value, str) and len(value) <= 2000 and (not required or bool(value.strip())))


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", value) is not None)


def validate_date(value):
    if value is None:
        return
    if type(value) in (int, float):
        require(math.isfinite(value) and abs(value) <= 8640000000000000)
    else:
        require(isinstance(value, str))
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.tzinfo is not None)


def validate_state(value):
    require(isinstance(value, dict))
    for key in ("status",):
        require(value.get(key) is None or value[key] in STATUSES)
    for key in ("startedAt", "endedAt"):
        validate_date(value.get(key))


def validate(data):
    validate_state(data)
    text(data.get("title"), required=True)
    for key in ("id", "summary", "reason"):
        if data.get(key) is not None:
            text(data[key])
    phases, agents, events = (data.get(key, []) for key in ("phases", "agents", "events"))
    for collection, limit in ((phases, 32), (agents, 64), (events, 500)):
        require(isinstance(collection, list) and len(collection) <= limit)
    phase = data.get("phase", 0)
    require(type(phase) is int and 0 <= phase < max(1, len(phases)))
    item_count = 0

    def item(value, depth=0):
        nonlocal item_count
        item_count += 1
        require(depth < 8 and item_count <= 500)
        validate_state(value)
        text(value.get("name"), required=True)
        children = value.get("children", [])
        require(isinstance(children, list))
        for child in children:
            item(child, depth + 1)

    for entry in phases:
        require(isinstance(entry, dict))
        text(entry.get("name"), required=True)
        require(isinstance(entry.get("items"), list))
        for work in entry["items"]:
            item(work)
    ids = set()
    for agent in agents:
        validate_state(agent)
        identifier(agent.get("id"))
        require(agent["id"] not in ids)
        ids.add(agent["id"])
        text(agent.get("name"), required=True)
        for key in ("role", "model", "current", "reason"):
            if agent.get(key) is not None:
                text(agent[key])
        if agent.get("parentId") is not None:
            identifier(agent["parentId"])
        require(agent.get("launchMethod") is None or agent["launchMethod"] in {"session", "command", "subagent"})
    for event in events:
        require(isinstance(event, dict))
        text(event.get("title"), required=True)
        validate_date(event.get("at"))
        if event.get("agentId") is not None:
            identifier(event["agentId"])
        if event.get("detail") is not None:
            text(event["detail"])
        require(event.get("kind", "progress") in {"progress", "milestone", "warning", "error", "tool"})


def reject_constant(_):
    raise ValueError("Non-finite JSON number")


def load_json(value):
    return json.loads(value, parse_constant=reject_constant)


def lifecycle(target, patch, now):
    previous = target.get("status")
    target.update(patch)
    status = patch.get("status")
    if status == "running":
        if previous in TERMINAL:
            target["startedAt"] = now
            target.pop("endedAt", None)
        elif target.get("startedAt") is None:
            target["startedAt"] = now
    elif status in TERMINAL and target.get("endedAt") is None:
        target["endedAt"] = now


def update(path, args):
    # Lock a stable sibling, since replacing progress.json changes its inode.
    with path.with_name(path.name + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = load_json(path.read_text(encoding="utf-8"))
        validate(data)
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if args.command == "task":
            patch = load_json(args.patch)
            require(isinstance(patch, dict) and patch.keys() <= TASK_FIELDS)
            lifecycle(data, patch, now)
        else:
            identifier(args.agent_id)
            agents = data.setdefault("agents", [])
            target = next((agent for agent in agents if agent["id"] == args.agent_id), None)
            if target is None:
                target = {"id": args.agent_id}
                agents.append(target)
            patch = {key: value for key, value in {
                "name": args.name, "status": args.status, "current": args.current,
                "reason": args.reason, "parentId": args.parent_id,
                "launchMethod": args.launch_method, "model": args.model, "role": args.role,
            }.items() if value is not None}
            lifecycle(target, patch, now)
            if args.event is not None:
                text(args.event, required=True)
                data["events"] = (data.get("events", []) + [
                    {"agentId": args.agent_id, "at": now, "title": args.event, "kind": "progress"}
                ])[-500:]
        validate(data)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                             prefix=".progress-", delete=False) as handle:
                temporary = handle.name
                json.dump(data, handle, ensure_ascii=False, indent=2, allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    agent = commands.add_parser("agent", help="Merge one participant report")
    agent.add_argument("agent_id")
    for flag in ("name", "status", "current", "reason", "parent-id", "launch-method", "model", "role", "event"):
        agent.add_argument("--" + flag)
    task = commands.add_parser("task", help="Merge task/plan fields, preserving participants")
    task.add_argument("--patch", required=True, help="JSON object containing task/plan fields")
    args = parser.parse_args()
    try:
        update(args.file, args)
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as error:
        # Keep report contents out of error output; they may contain task text.
        print(f"Progress update failed ({type(error).__name__}); original file preserved.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
