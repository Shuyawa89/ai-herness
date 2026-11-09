package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

type object = map[string]any

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var states = map[string]bool{"pending": true, "running": true, "waiting": true, "failed": true, "completed": true, "unknown": true}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func randomID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func lockFile(path string, fn func() error) error {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); e != nil {
		return e
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}
func atomicJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	b = append(b, '\n')
	f, e := os.CreateTemp(filepath.Dir(path), ".dashboard-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
func readJSON(path string, out any) error {
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	if len(b) > 4<<20 {
		return errors.New("report exceeds size limit")
	}
	return json.Unmarshal(b, out)
}
func textValue(v any, required bool) bool {
	s, ok := v.(string)
	return ok && len([]rune(s)) <= 2000 && (!required || strings.TrimSpace(s) != "")
}
func dateOK(v any) bool {
	if v == nil {
		return true
	}
	switch x := v.(type) {
	case string:
		_, e := time.Parse(time.RFC3339Nano, x)
		return e == nil
	case float64:
		return x >= -8640000000000000 && x <= 8640000000000000
	}
	return false
}
func stateOK(o object) bool {
	if s := o["status"]; s != nil {
		v, ok := s.(string)
		if !ok || !states[v] {
			return false
		}
	}
	return dateOK(o["startedAt"]) && dateOK(o["endedAt"])
}
func list(o object, k string, max int) ([]any, bool) {
	v, exists := o[k]
	if !exists {
		return []any{}, true
	}
	a, ok := v.([]any)
	return a, ok && len(a) <= max
}
func workspaceOK(v any) bool {
	if v == nil {
		return true
	}
	if w, ok := v.(Workspace); ok {
		b, _ := json.Marshal(w)
		var converted object
		if json.Unmarshal(b, &converted) != nil {
			return false
		}
		v = converted
	}
	w, ok := v.(map[string]any)
	if !ok {
		return false
	}
	cwd, ok := w["cwd"].(string)
	if !ok || strings.TrimSpace(cwd) == "" || len([]rune(cwd)) > 8192 {
		return false
	}
	kind, ok := w["checkoutKind"].(string)
	if !ok || (kind != "primary" && kind != "worktree" && kind != "not-git" && kind != "unavailable") {
		return false
	}
	for _, k := range []string{"repoRoot", "branch", "commit"} {
		if value := w[k]; value != nil {
			text, ok := value.(string)
			limit := 2000
			if k == "repoRoot" {
				limit = 8192
			}
			if !ok || len([]rune(text)) > limit {
				return false
			}
		}
	}
	return dateOK(w["observedAt"])
}
func validate(d object) error {
	bad := errors.New("invalid progress data or report")
	if !stateOK(d) || !textValue(d["title"], true) || !workspaceOK(d["workspace"]) {
		return bad
	}
	for _, k := range []string{"id", "summary", "reason"} {
		if d[k] != nil && !textValue(d[k], false) {
			return bad
		}
	}
	p, ok := list(d, "phases", 32)
	if !ok {
		return bad
	}
	a, ok := list(d, "agents", 64)
	if !ok {
		return bad
	}
	events, ok := list(d, "events", 500)
	if !ok {
		return bad
	}
	if v := d["phase"]; v != nil {
		n, ok := v.(float64)
		if !ok || n != float64(int(n)) || n < 0 || int(n) >= max(1, len(p)) {
			return bad
		}
	}
	count := 0
	var item func(any, int) bool
	item = func(v any, depth int) bool {
		o, ok := v.(map[string]any)
		count++
		if !ok || depth >= 8 || count > 500 || !stateOK(o) || !textValue(o["name"], true) || !workspaceOK(o["workspace"]) {
			return false
		}
		children, ok := list(o, "children", 500)
		if !ok {
			return false
		}
		for _, c := range children {
			if !item(c, depth+1) {
				return false
			}
		}
		return true
	}
	for _, v := range p {
		o, ok := v.(map[string]any)
		if !ok || !textValue(o["name"], true) {
			return bad
		}
		items, ok := o["items"].([]any)
		if !ok {
			return bad
		}
		for _, v := range items {
			if !item(v, 0) {
				return bad
			}
		}
	}
	ids := map[string]bool{}
	for _, v := range a {
		o, ok := v.(map[string]any)
		if !ok || !stateOK(o) || !textValue(o["name"], true) || !workspaceOK(o["workspace"]) {
			return bad
		}
		id, ok := o["id"].(string)
		if !ok || !idPattern.MatchString(id) || ids[id] {
			return bad
		}
		ids[id] = true
		for _, k := range []string{"role", "model", "current", "reason"} {
			if o[k] != nil && !textValue(o[k], false) {
				return bad
			}
		}
		if v := o["parentId"]; v != nil {
			s, ok := v.(string)
			if !ok || !idPattern.MatchString(s) {
				return bad
			}
		}
		if v := o["launchMethod"]; v != nil && v != "session" && v != "command" && v != "subagent" {
			return bad
		}
	}
	for _, v := range events {
		o, ok := v.(map[string]any)
		if !ok || !textValue(o["title"], true) || !dateOK(o["at"]) {
			return bad
		}
		if o["detail"] != nil && !textValue(o["detail"], false) {
			return bad
		}
		if v := o["agentId"]; v != nil {
			s, ok := v.(string)
			if !ok || !idPattern.MatchString(s) {
				return bad
			}
		}
		if v := o["kind"]; v != nil && v != "progress" && v != "milestone" && v != "warning" && v != "error" && v != "tool" {
			return bad
		}
	}
	return nil
}
func lifecycle(o, patch object) {
	previous := o["status"]
	for k, v := range patch {
		o[k] = v
	}
	switch patch["status"] {
	case "running":
		if previous == "completed" || previous == "failed" {
			o["startedAt"] = now()
			delete(o, "endedAt")
		} else if o["startedAt"] == nil {
			o["startedAt"] = now()
		}
	case "completed", "failed":
		if o["endedAt"] == nil {
			o["endedAt"] = now()
		}
	}
}

type taskRef struct {
	ID     string `json:"id"`
	Report string `json:"report"`
}
type taskIndex struct {
	Tasks []taskRef `json:"tasks"`
}

func ensureRoot(root string) error {
	if e := os.MkdirAll(filepath.Join(root, "tasks"), 0700); e != nil {
		return e
	}
	return os.Chmod(root, 0700)
}
func readIndex(root string) (taskIndex, error) {
	i := taskIndex{Tasks: []taskRef{}}
	e := readJSON(filepath.Join(root, "tasks.json"), &i)
	if os.IsNotExist(e) {
		return i, nil
	}
	return i, e
}
func register(root, title, cwd, file string) (object, error) {
	if !textValue(title, true) {
		return nil, errors.New("title required")
	}
	if cwd != "" && !filepath.IsAbs(cwd) {
		return nil, errors.New("cwd must be absolute")
	}
	if e := ensureRoot(root); e != nil {
		return nil, e
	}
	var result object
	e := lockFile(filepath.Join(root, "tasks.json.lock"), func() error {
		i, e := readIndex(root)
		if e != nil {
			return e
		}
		d := object{"title": title, "status": "running", "startedAt": now(), "agents": []any{}, "phases": []any{}, "events": []any{}}
		if file != "" {
			d = object{}
			if e = readJSON(file, &d); e != nil {
				return e
			}
			if d == nil {
				return errors.New("import must be a progress object")
			}
			d["title"] = title
		}
		if cwd != "" {
			d["workspace"] = inspectWorkspace(cwd)
		}
		id := randomID()
		d["id"] = id
		if e = validate(d); e != nil {
			return e
		}
		dir := filepath.Join(root, "tasks", id)
		if e = os.Mkdir(dir, 0700); e != nil {
			return e
		}
		path := filepath.Join(dir, "progress.json")
		if e = atomicJSON(path, d); e != nil {
			return e
		}
		i.Tasks = append(i.Tasks, taskRef{id, "tasks/" + id + "/progress.json"})
		if e = atomicJSON(filepath.Join(root, "tasks.json"), i); e != nil {
			return e
		}
		result = object{"id": id, "path": path}
		return nil
	})
	return result, e
}
func update(path, kind, id string, patch object, event, cwd string) error {
	if cwd != "" && !filepath.IsAbs(cwd) {
		return errors.New("cwd must be absolute")
	}
	return lockFile(path+".lock", func() error {
		d := object{}
		if e := readJSON(path, &d); e != nil {
			return e
		}
		if e := validate(d); e != nil {
			return e
		}
		target := d
		if kind == "agent" {
			if !idPattern.MatchString(id) {
				return errors.New("invalid agent ID")
			}
			a, _ := list(d, "agents", 64)
			target = nil
			for _, v := range a {
				o := v.(map[string]any)
				if o["id"] == id {
					target = o
					break
				}
			}
			if target == nil {
				target = object{"id": id}
				a = append(a, target)
			}
			d["agents"] = a
		} else if kind == "task" {
			allowed := map[string]bool{"title": true, "summary": true, "id": true, "status": true, "reason": true, "phase": true, "phases": true}
			for k := range patch {
				if !allowed[k] {
					return fmt.Errorf("unsupported task field %s", k)
				}
			}
		} else {
			return errors.New("expected agent or task")
		}
		lifecycle(target, patch)
		if cwd != "" {
			target["workspace"] = inspectWorkspace(cwd)
		}
		if event != "" {
			a, _ := list(d, "events", 500)
			a = append(a, object{"agentId": id, "at": now(), "title": event, "kind": "progress"})
			if len(a) > 500 {
				a = a[len(a)-500:]
			}
			d["events"] = a
		}
		if e := validate(d); e != nil {
			return e
		}
		return atomicJSON(path, d)
	})
}
