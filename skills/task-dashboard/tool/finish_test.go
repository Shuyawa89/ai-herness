package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func finishFixture(t *testing.T) (string, object) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "progress.json")
	d := object{"title": "Task", "status": "running", "reason": "Old warning", "startedAt": "2026-10-26T01:00:00Z", "phases": []any{object{"name": "Implementation", "items": []any{object{"name": "Unfinished", "status": "pending"}}}}, "agents": []any{object{"id": "coordinator", "name": "Coordinator", "status": "running", "reason": "Old warning", "startedAt": "2026-10-26T01:00:00Z"}, object{"id": "child", "name": "Child", "parentId": "coordinator", "status": "completed"}}}
	if e := atomicJSON(path, d); e != nil {
		t.Fatal(e)
	}
	return path, d
}
func readFinish(t *testing.T, path string) object {
	t.Helper()
	d := object{}
	if e := readJSON(path, &d); e != nil {
		t.Fatal(e)
	}
	return d
}
func finishAgent(d object, index int) object { return d["agents"].([]any)[index].(map[string]any) }
func TestFinishCompletesOnlyCoordinatorAndPreservesPlan(t *testing.T) {
	path, before := finishFixture(t)
	current := "Result reported"
	result, e := finish(path, "coordinator", "completed", &current, nil)
	if e != nil {
		t.Fatal(e)
	}
	d := readFinish(t, path)
	if result["taskStatus"] != "completed" || result["agentStatus"] != "completed" || d["status"] != "completed" || finishAgent(d, 0)["status"] != "completed" {
		t.Fatalf("states %#v %#v", result, d)
	}
	if d["endedAt"] == nil || finishAgent(d, 0)["endedAt"] == nil || d["reason"] != nil || finishAgent(d, 0)["reason"] != nil || finishAgent(d, 0)["current"] != current {
		t.Fatal("missing finish state")
	}
	if !reflect.DeepEqual(d["phases"], before["phases"]) || !reflect.DeepEqual(finishAgent(d, 1), finishAgent(before, 1)) {
		t.Fatal("changed plan or child")
	}
	if _, e = finish(path, "coordinator", "completed", nil, nil); e != nil {
		t.Fatal(e)
	}
	again := readFinish(t, path)
	if again["endedAt"] != d["endedAt"] || finishAgent(again, 0)["endedAt"] != finishAgent(d, 0)["endedAt"] {
		t.Fatal("repeated finish extended elapsed time")
	}
	for _, kind := range []string{"task", "agent"} {
		id := ""
		if kind == "agent" {
			id = "coordinator"
		}
		if e = update(path, kind, id, object{"status": "running"}, "", ""); e != nil {
			t.Fatal(e)
		}
	}
	restarted := readFinish(t, path)
	if restarted["endedAt"] != nil || finishAgent(restarted, 0)["endedAt"] != nil || restarted["startedAt"] == d["startedAt"] {
		t.Fatal("restart did not resume lifecycle")
	}
}
func TestFinishPreservesOtherParticipantStates(t *testing.T) {
	for _, state := range []string{"running", "waiting", "failed", "pending", "unknown"} {
		t.Run(state, func(t *testing.T) {
			path, _ := finishFixture(t)
			if e := update(path, "agent", "child", object{"status": state}, "", ""); e != nil {
				t.Fatal(e)
			}
			before := readFinish(t, path)
			result, e := finish(path, "coordinator", "completed", nil, nil)
			if e != nil {
				t.Fatal(e)
			}
			d := readFinish(t, path)
			expected := state
			if state == "pending" || state == "unknown" {
				expected = "completed"
			}
			if result["taskStatus"] != expected || d["status"] != expected || finishAgent(d, 0)["status"] != "completed" {
				t.Fatalf("wrong effective status %#v", result)
			}
			if !reflect.DeepEqual(finishAgent(d, 1), finishAgent(before, 1)) {
				t.Fatal("child mutated")
			}
			if (expected == "running" || expected == "waiting") && d["endedAt"] != nil {
				t.Fatal("ongoing task has end")
			}
		})
	}
}
func TestFinishWaitingFailedAndUnknownTimes(t *testing.T) {
	for _, state := range []string{"waiting", "failed"} {
		t.Run(state, func(t *testing.T) {
			path, _ := finishFixture(t)
			d := readFinish(t, path)
			delete(d, "startedAt")
			delete(finishAgent(d, 0), "startedAt")
			atomicJSON(path, d)
			reason := "Needs input"
			result, e := finish(path, "coordinator", state, nil, &reason)
			if e != nil {
				t.Fatal(e)
			}
			d = readFinish(t, path)
			if result["taskStatus"] != state || d["reason"] != reason || finishAgent(d, 0)["reason"] != reason || d["startedAt"] != nil || finishAgent(d, 0)["startedAt"] != nil {
				t.Fatal("state/reason/time mismatch")
			}
			if (d["endedAt"] != nil) != (state == "failed") || (finishAgent(d, 0)["endedAt"] != nil) != (state == "failed") {
				t.Fatal("end time mismatch")
			}
		})
	}
}
func TestFinishInvalidCLIAndUnknownAgentLeaveBytesUntouched(t *testing.T) {
	path, _ := finishFixture(t)
	before, _ := os.ReadFile(path)
	for _, args := range [][]string{{"finish"}, {"finish", path}, {"finish", path, "--agent", "missing"}, {"finish", path, "--agent", "coordinator", "--status", "running"}, {"finish", path, "--agent", "coordinator", "extra"}, {"finish", path, "--agent", "coordinator", "--unknown"}} {
		if e := run(args); e == nil {
			t.Fatalf("invalid accepted %v", args)
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatalf("invalid mutated file %v", args)
		}
	}
}
func TestFinishConcurrentReportsArePreserved(t *testing.T) {
	path, _ := finishFixture(t)
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if e := update(path, "agent", fmt.Sprintf("worker%d", i), object{"name": "Worker", "status": "running"}, "", ""); e != nil {
				t.Error(e)
			}
		}(i)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		if _, e := finish(path, "coordinator", "completed", nil, nil); e != nil {
			t.Error(e)
		}
	}()
	wg.Wait()
	d := readFinish(t, path)
	if len(d["agents"].([]any)) != 26 || finishAgent(d, 0)["status"] != "completed" {
		t.Fatal("lost participant write")
	}
}

func TestFinishCLIUsesExplicitAgentAndDefaultCompletion(t *testing.T) {
	path, _ := finishFixture(t)
	if e := update(path, "agent", "coordinator", object{"current": "Keep this summary"}, "", ""); e != nil {
		t.Fatal(e)
	}
	if e := run([]string{"finish", path, "--agent", "coordinator"}); e != nil {
		t.Fatal(e)
	}
	d := readFinish(t, path)
	if d["status"] != "completed" || finishAgent(d, 0)["current"] != "Keep this summary" {
		t.Fatal("CLI default/preserved summary")
	}
	reason := "Approval required"
	if _, e := finish(path, "coordinator", "waiting", nil, &reason); e != nil {
		t.Fatal(e)
	}
	d = readFinish(t, path)
	if d["endedAt"] != nil || finishAgent(d, 0)["endedAt"] != nil {
		t.Fatal("waiting reused a previous end")
	}
}
func TestFinishOtherParticipantPriority(t *testing.T) {
	path, _ := finishFixture(t)
	for i, state := range []string{"running", "waiting", "failed", "running"} {
		if e := update(path, "agent", fmt.Sprintf("other%d", i), object{"name": "Other", "status": state}, "", ""); e != nil {
			t.Fatal(e)
		}
	}
	result, e := finish(path, "coordinator", "completed", nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	if result["taskStatus"] != "failed" {
		t.Fatalf("lost attention priority %#v", result)
	}
}
