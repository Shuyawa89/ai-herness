package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func mustRegister(t *testing.T, root string) object {
	t.Helper()
	v, e := register(root, "Same title", "", "")
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func TestConcurrentRegistrationAndReports(t *testing.T) {
	root := t.TempDir()
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := register(root, "Same title", "", ""); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	index, e := readIndex(root)
	if e != nil || len(index.Tasks) != 12 {
		t.Fatalf("index: %v %v", index, e)
	}
	path := filepath.Join(root, index.Tasks[0].Report)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if e := update(path, "agent", fmt.Sprint("agent", i), object{"name": "Worker", "status": "running"}, "started", ""); e != nil {
				t.Error(e)
			}
		}(i)
	}
	wg.Wait()
	d := object{}
	if e := readJSON(path, &d); e != nil {
		t.Fatal(e)
	}
	agents, _ := list(d, "agents", 64)
	events, _ := list(d, "events", 500)
	if len(agents) != 24 || len(events) != 24 {
		t.Fatalf("lost writes: %d %d", len(agents), len(events))
	}
	if e := update(path, "agent", "agent0", object{"status": "completed"}, "", ""); e != nil {
		t.Fatal(e)
	}
	readJSON(path, &d)
	a := d["agents"].([]any)
	for _, v := range a {
		o := v.(map[string]any)
		if o["id"] == "agent0" && (o["startedAt"] == nil || o["endedAt"] == nil) {
			t.Fatal("missing lifecycle dates")
		}
	}
	before, _ := os.ReadFile(path)
	if e := update(path, "agent", "agent0", object{"status": "bad"}, "", ""); e == nil {
		t.Fatal("invalid accepted")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("invalid update changed file")
	}
}
func gitRun(t *testing.T, args ...string) string {
	t.Helper()
	c := exec.Command("git", args...)
	c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
	b, e := c.CombinedOutput()
	if e != nil {
		t.Fatalf("git %v: %s %v", args, b, e)
	}
	return strings.TrimSpace(string(b))
}
func TestWorkspace(t *testing.T) {
	root := filepath.Join(t.TempDir(), "space repository")
	os.Mkdir(root, 0700)
	root, _ = filepath.EvalSymlinks(root)
	gitRun(t, "init", root)
	gitRun(t, "-C", root, "checkout", "-b", "feature/example")
	gitRun(t, "-C", root, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "test")
	nested := filepath.Join(root, "nested")
	os.Mkdir(nested, 0700)
	t.Setenv("GIT_DIR", "/does/not/exist")
	w := inspectWorkspace(nested)
	if w.CheckoutKind != "primary" || w.Branch != "feature/example" || w.RepoRoot != root {
		t.Fatalf("primary %#v", w)
	}
	os.Unsetenv("GIT_DIR")
	linked := filepath.Join(t.TempDir(), "linked tree")
	gitRun(t, "-C", root, "worktree", "add", "--detach", linked)
	w = inspectWorkspace(linked)
	if w.CheckoutKind != "worktree" || w.Branch != "" || w.Commit == "" {
		t.Fatalf("linked detached %#v", w)
	}
	if inspectWorkspace(t.TempDir()).CheckoutKind != "not-git" {
		t.Fatal("not git")
	}
	if inspectWorkspace(filepath.Join(root, "missing")).CheckoutKind != "unavailable" {
		t.Fatal("missing path")
	}
	t.Setenv("PATH", t.TempDir())
	if inspectWorkspace(root).CheckoutKind != "unavailable" {
		t.Fatal("missing git")
	}
}
func TestHTTPIsolation(t *testing.T) {
	root := t.TempDir()
	v := mustRegister(t, root)
	other := mustRegister(t, root)
	os.WriteFile(other["path"].(string), []byte("broken"), 0600)
	s := serverState{Address: "http://127.0.0.1:8790", Token: randomID()}
	h := dashboardHandler(root, s, func() {})
	request := func(method, path, host, origin, auth string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:8790"+path, nil)
		r.Host = host
		r.Header.Set("Origin", origin)
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, p := range []string{"/server.json", "/server.log", "/tasks.json", "/../server.json", "/tasks/../../server.json", "/progress.example.json", "/embed.go"} {
		if request("GET", p, "127.0.0.1:8790", "", "").Code != 404 {
			t.Errorf("public private path %s", p)
		}
	}
	if request("GET", "/", "evil.example", "", "").Code != 403 || request("GET", "/", "127.0.0.1:8790", "http://evil.example", "").Code != 403 {
		t.Fatal("foreign origin or host")
	}
	if request("POST", "/control/stop", "127.0.0.1:8790", "", "").Code != 403 {
		t.Fatal("unauth stop")
	}
	if request("POST", "/control/probe", "127.0.0.1:8790", "http://127.0.0.1:8790", "Bearer "+s.Token).Code != 403 {
		t.Fatal("browser stop")
	}
	res := request("GET", "/api/tasks", "127.0.0.1:8790", "", "")
	var summary struct {
		Tasks []object `json:"tasks"`
	}
	json.Unmarshal(res.Body.Bytes(), &summary)
	if len(summary.Tasks) != 2 || summary.Tasks[0]["unavailable"] != nil || summary.Tasks[1]["unavailable"] != true {
		t.Fatalf("isolation %s", res.Body.String())
	}
	if !strings.Contains(request("GET", "/", "127.0.0.1:8790", "", "").Body.String(), `data-dashboard-mode="shared"`) {
		t.Fatal("missing shared marker")
	}
	path := v["path"].(string)
	os.Remove(path)
	outside := filepath.Join(t.TempDir(), "private.json")
	os.WriteFile(outside, []byte(`{"title":"private"}`), 0600)
	os.Symlink(outside, path)
	if request("GET", "/tasks/"+v["id"].(string)+"/progress.json", "127.0.0.1:8790", "", "").Code != 404 {
		t.Fatal("symlink escape")
	}
}
func TestDetachedLifecycle(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "task-dashboard")
	build := exec.Command("go", "build", "-o", bin, ".")
	if b, e := build.CombinedOutput(); e != nil {
		t.Fatalf("build %s %v", b, e)
	}
	root := t.TempDir()
	v := mustRegister(t, root)
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	cli := func(args ...string) ([]byte, error) {
		return exec.Command(bin, append([]string{"--root", root}, args...)...).CombinedOutput()
	}
	defer cli("server", "stop")
	if b, e := cli("server", "start", "--port", fmt.Sprint(port)); e != nil {
		t.Fatalf("start %s %v", b, e)
	}
	time.Sleep(100 * time.Millisecond)
	s, e := ownedServer(root)
	if e != nil {
		t.Fatalf("CLI exit killed server %v", e)
	}
	res, e := http.Get(s.Address + "/api/tasks")
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if b, e := cli("server", "stop"); e != nil {
		t.Fatalf("stop %s %v", b, e)
	}
	if _, e = ownedServer(root); e == nil {
		t.Fatal("still running")
	}
	if e = update(v["path"].(string), "task", "", object{"summary": "updated while stopped"}, "", ""); e != nil {
		t.Fatal(e)
	}
	if b, e := cli("server", "start", "--port", fmt.Sprint(port)); e != nil {
		t.Fatalf("restart %s %v", b, e)
	}
	if _, e = os.Stat(v["path"].(string)); e != nil {
		t.Fatal("lost report")
	}
	for _, name := range []string{"server.json", "server.log"} {
		info, e := os.Stat(filepath.Join(root, name))
		if e != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("permissions %s %v", name, e)
		}
	}
	if b, e := cli("server", "stop"); e != nil {
		t.Fatalf("stop %s %v", b, e)
	}
	conflict, e := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if e != nil {
		t.Fatal(e)
	}
	defer conflict.Close()
	if _, e = cli("server", "start", "--port", fmt.Sprint(port)); e == nil {
		t.Fatal("accepted unrelated occupied port")
	}
}

func TestReportWorkspaceAndLifecycle(t *testing.T) {
	root := t.TempDir()
	v := mustRegister(t, root)
	path := v["path"].(string)
	cwd := t.TempDir()
	if e := update(path, "agent", "worker", object{"name": "Worker", "status": "running"}, "", cwd); e != nil {
		t.Fatal(e)
	}
	d := object{}
	readJSON(path, &d)
	agent := d["agents"].([]any)[0].(map[string]any)
	first := agent["startedAt"]
	workspace := agent["workspace"]
	if e := update(path, "agent", "worker", object{"current": "next step"}, "", ""); e != nil {
		t.Fatal(e)
	}
	readJSON(path, &d)
	agent = d["agents"].([]any)[0].(map[string]any)
	a, _ := json.Marshal(workspace)
	b, _ := json.Marshal(agent["workspace"])
	if string(a) != string(b) || agent["startedAt"] != first {
		t.Fatal("partial report lost workspace or start")
	}
	if e := update(path, "agent", "worker", object{"status": "completed"}, "", ""); e != nil {
		t.Fatal(e)
	}
	time.Sleep(time.Millisecond)
	if e := update(path, "agent", "worker", object{"status": "running"}, "", ""); e != nil {
		t.Fatal(e)
	}
	readJSON(path, &d)
	agent = d["agents"].([]any)[0].(map[string]any)
	if agent["endedAt"] != nil || agent["startedAt"] == first {
		t.Fatal("restart lifecycle")
	}
	if e := update(path, "task", "", object{"summary": "plan changed"}, "", cwd); e != nil {
		t.Fatal(e)
	}
	readJSON(path, &d)
	if len(d["agents"].([]any)) != 1 || d["workspace"] == nil {
		t.Fatal("task report lost participants")
	}
}

func TestWorkspaceValidationAndSummaryAttention(t *testing.T) {
	root := t.TempDir()
	first := mustRegister(t, root)
	second := mustRegister(t, root)
	if e := update(first["path"].(string), "agent", "waiting", object{"name": "waiting", "status": "waiting"}, "", ""); e != nil {
		t.Fatal(e)
	}
	if e := update(first["path"].(string), "agent", "failed", object{"name": "failed", "status": "failed"}, "", ""); e != nil {
		t.Fatal(e)
	}
	d := object{}
	readJSON(second["path"].(string), &d)
	d["workspace"] = object{"cwd": "/tmp", "checkoutKind": "wrong"}
	atomicJSON(second["path"].(string), d)
	result, e := summaries(root)
	if e != nil {
		t.Fatal(e)
	}
	entries := result["tasks"].([]any)
	if entries[0].(map[string]any)["attention"] != "failed" || entries[1].(map[string]any)["unavailable"] != true {
		t.Fatalf("bad isolation/attention %#v", entries)
	}
	if _, e := register(root, "bad import", "", second["path"].(string)); e == nil {
		t.Fatal("bad workspace imported")
	}
	for _, v := range []any{true, object{"cwd": "", "checkoutKind": "primary"}, object{"cwd": "/tmp", "checkoutKind": "primary", "branch": 5}, object{"cwd": "/tmp", "checkoutKind": "primary", "observedAt": "invalid"}} {
		d["workspace"] = v
		if validate(d) == nil {
			t.Fatalf("bad workspace accepted %#v", v)
		}
	}
	delete(d, "workspace")
	d["agents"] = []any{object{"id": "worker", "name": "worker", "workspace": true}}
	if validate(d) == nil {
		t.Fatal("invalid agent workspace accepted")
	}
}
func TestCorruptGitIsUnavailable(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, ".git"), 0700)
	os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("broken"), 0600)
	if got := inspectWorkspace(root); got.CheckoutKind != "unavailable" {
		t.Fatalf("corrupt repo classified %#v", got)
	}
}
func TestConcurrentCLIProcesses(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "task-dashboard")
	if b, e := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); e != nil {
		t.Fatalf("build %s %v", b, e)
	}
	root := t.TempDir()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if b, e := exec.Command(bin, "--root", root, "register", "--title", "Concurrent").CombinedOutput(); e != nil {
				t.Errorf("register %s %v", b, e)
			}
		}()
	}
	wg.Wait()
	index, e := readIndex(root)
	if e != nil || len(index.Tasks) != 8 {
		t.Fatalf("lost process registration %v %v", index, e)
	}
	path := filepath.Join(root, index.Tasks[0].Report)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if b, e := exec.Command(bin, "update", path, "agent", fmt.Sprint("worker", i), "--name", "Worker", "--status", "running").CombinedOutput(); e != nil {
				t.Errorf("update %s %v", b, e)
			}
		}(i)
	}
	wg.Wait()
	d := object{}
	if e := readJSON(path, &d); e != nil {
		t.Fatal(e)
	}
	if len(d["agents"].([]any)) != 12 {
		t.Fatal("lost process update")
	}
}

func TestImportPreservesUnknownLifecycle(t *testing.T) {
	for _, source := range []object{{"title": "Legacy"}, {"title": "Legacy complete", "status": "completed"}} {
		root := t.TempDir()
		file := filepath.Join(t.TempDir(), "legacy.json")
		if e := atomicJSON(file, source); e != nil {
			t.Fatal(e)
		}
		registered, e := register(root, "Imported", "", file)
		if e != nil {
			t.Fatal(e)
		}
		d := object{}
		if e := readJSON(registered["path"].(string), &d); e != nil {
			t.Fatal(e)
		}
		if d["startedAt"] != nil || d["endedAt"] != nil || d["status"] != source["status"] {
			t.Fatalf("fabricated legacy lifecycle %#v", d)
		}
	}
	root := t.TempDir()
	v := mustRegister(t, root)
	d := object{}
	readJSON(v["path"].(string), &d)
	if d["status"] != "running" || d["startedAt"] == nil {
		t.Fatal("new task missing lifecycle")
	}
}

func TestNullImportRejectedWithoutIndexMutation(t *testing.T) {
	root := t.TempDir()
	mustRegister(t, root)
	before, e := os.ReadFile(filepath.Join(root, "tasks.json"))
	if e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(t.TempDir(), "null.json")
	if e := os.WriteFile(file, []byte("null"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := register(root, "Invalid", "", file); e == nil {
		t.Fatal("null import accepted")
	}
	after, e := os.ReadFile(filepath.Join(root, "tasks.json"))
	if e != nil {
		t.Fatal(e)
	}
	if string(before) != string(after) {
		t.Fatal("null import mutated index")
	}
}
