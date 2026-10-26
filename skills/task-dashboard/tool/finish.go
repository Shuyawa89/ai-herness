package main

import "errors"

// finish records the end of one response without completing other participants or work items.
func finish(path, id, status string, current, reason *string) (object, error) {
	if !idPattern.MatchString(id) {
		return nil, errors.New("registered agent ID required")
	}
	if status != "completed" && status != "waiting" && status != "failed" {
		return nil, errors.New("finish status must be completed, waiting, or failed")
	}
	if current != nil && !textValue(*current, false) || reason != nil && !textValue(*reason, false) {
		return nil, errors.New("invalid finish text")
	}
	var result object
	e := lockFile(path+".lock", func() error {
		d := object{}
		if e := readJSON(path, &d); e != nil {
			return e
		}
		if e := validate(d); e != nil {
			return e
		}
		agents, _ := list(d, "agents", 64)
		var coordinator object
		for _, v := range agents {
			agent := v.(map[string]any)
			if agent["id"] == id {
				coordinator = agent
				break
			}
		}
		if coordinator == nil {
			return errors.New("finish agent must already be registered")
		}
		taskStatus := status
		if status == "completed" {
			priority := map[string]int{"completed": 0, "running": 1, "waiting": 2, "failed": 3}
			for _, v := range agents {
				agent := v.(map[string]any)
				if agent["id"] == id {
					continue
				}
				if s, ok := agent["status"].(string); ok && priority[s] > priority[taskStatus] {
					taskStatus = s
				}
			}
		}
		stamp := now()
		apply := func(target object, next string) {
			previous := target["status"]
			target["status"] = next
			if next == "completed" || next == "failed" {
				if target["endedAt"] == nil {
					target["endedAt"] = stamp
				}
			} else {
				delete(target, "endedAt")
				if next == "running" && (previous == "completed" || previous == "failed") {
					target["startedAt"] = stamp
				}
			}
			delete(target, "reason")
			if reason != nil && status != "completed" {
				target["reason"] = *reason
			}
		}
		apply(coordinator, status)
		apply(d, taskStatus)
		if current != nil {
			coordinator["current"] = *current
		}
		if e := validate(d); e != nil {
			return e
		}
		if e := atomicJSON(path, d); e != nil {
			return e
		}
		result = object{"taskStatus": taskStatus, "agentStatus": status}
		return nil
	})
	return result, e
}
