package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Workspace describes observed Git facts, independently of reported agent state.
type Workspace struct {
	Cwd          string `json:"cwd"`
	RepoRoot     string `json:"repoRoot,omitempty"`
	Branch       string `json:"branch,omitempty"`
	Commit       string `json:"commit,omitempty"`
	CheckoutKind string `json:"checkoutKind"`
	ObservedAt   string `json:"observedAt"`
}

func inspectWorkspace(directory string) Workspace {
	w := Workspace{Cwd: directory, CheckoutKind: "unavailable", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return w
	}
	w.Cwd = filepath.Clean(absolute)
	info, err := os.Stat(w.Cwd)
	if err != nil || !info.IsDir() {
		return w
	}
	if real, err := filepath.EvalSymlinks(w.Cwd); err == nil {
		w.Cwd = real
	}
	git, err := exec.LookPath("git")
	if err != nil {
		return w
	}
	run := func(arguments ...string) (string, string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, git, append([]string{"-C", w.Cwd}, arguments...)...)
		for _, value := range os.Environ() {
			// Caller Git overrides must not redirect another agent's workspace.
			if !strings.HasPrefix(value, "GIT_") && !strings.HasPrefix(value, "LC_ALL=") {
				cmd.Env = append(cmd.Env, value)
			}
		}
		cmd.Env = append(cmd.Env, "LC_ALL=C")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		return strings.TrimSpace(string(out)), stderr.String(), err
	}
	paths, stderr, err := run("rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir")
	if err != nil {
		if strings.Contains(stderr, "fatal: not a git repository (or any of the parent directories): .git") || strings.Contains(stderr, "fatal: not a git repository (or any parent up to mount point") {
			hasGitBoundary := false
			for directory := w.Cwd; ; directory = filepath.Dir(directory) {
				if _, e := os.Lstat(filepath.Join(directory, ".git")); e == nil || !os.IsNotExist(e) {
					hasGitBoundary = true
					break
				}
				if filepath.Dir(directory) == directory {
					break
				}
			}
			if !hasGitBoundary {
				w.CheckoutKind = "not-git"
			}
		}
		return w
	}
	parts := strings.Split(paths, "\n")
	if len(parts) != 3 {
		return w
	}
	w.RepoRoot, w.CheckoutKind = parts[0], "primary"
	gitDir, commonDir := filepath.Clean(parts[1]), filepath.Clean(parts[2])
	if resolved, err := filepath.EvalSymlinks(gitDir); err == nil {
		gitDir = resolved
	}
	if resolved, err := filepath.EvalSymlinks(commonDir); err == nil {
		commonDir = resolved
	}
	if gitDir != commonDir {
		w.CheckoutKind = "worktree"
	}
	w.Branch, _, _ = run("symbolic-ref", "--quiet", "--short", "HEAD")
	w.Commit, _, _ = run("rev-parse", "--short", "HEAD")
	return w
}
