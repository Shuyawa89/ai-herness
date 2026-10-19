package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"local/taskdashboard/assets"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type serverState struct {
	Address string `json:"address"`
	Token   string `json:"token"`
	PID     int    `json:"pid"`
}

var client = &http.Client{Timeout: 800 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}

func control(s serverState, route string) error {
	u, e := url.Parse(s.Address)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Path != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid server address")
	}
	req, e := http.NewRequest("POST", s.Address+route, nil)
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	res, e := client.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	var v object
	if res.StatusCode != 200 {
		return errors.New("server ownership verification failed")
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&v); e != nil {
		return e
	}
	if v["service"] != "task-dashboard" || v["token"] != s.Token {
		return errors.New("server identity mismatch")
	}
	return nil
}
func ownedServer(root string) (serverState, error) {
	s := serverState{}
	if e := readJSON(filepath.Join(root, "server.json"), &s); e != nil {
		return s, e
	}
	if len(s.Token) != 32 {
		return s, errors.New("invalid server identity")
	}
	return s, control(s, "/control/probe")
}
func serverCommand(root, action string, port int) error {
	if e := ensureRoot(root); e != nil {
		return e
	}
	return lockFile(filepath.Join(root, "server.lock"), func() error {
		s, e := ownedServer(root)
		switch action {
		case "status":
			if e != nil {
				return output(object{"running": false})
			}
			return output(object{"running": true, "url": s.Address, "pid": s.PID})
		case "stop":
			if e != nil {
				if _, x := os.Stat(filepath.Join(root, "server.json")); x == nil {
					return errors.New("recorded server cannot be authenticated; no process was stopped")
				}
				return output(object{"running": false})
			}
			if e = control(s, "/control/stop"); e != nil {
				return e
			}
			for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
				if control(s, "/control/probe") != nil {
					_ = os.Remove(filepath.Join(root, "server.json"))
					return output(object{"running": false})
				}
				time.Sleep(25 * time.Millisecond)
			}
			return errors.New("server shutdown timed out")
		case "start":
			if e == nil {
				return output(object{"running": true, "url": s.Address, "pid": s.PID})
			}
			if port < 1 || port > 65535 {
				return errors.New("invalid port")
			}
			probe, e := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
			if e != nil {
				return fmt.Errorf("port unavailable: %w", e)
			}
			probe.Close()
			s = serverState{Address: fmt.Sprintf("http://127.0.0.1:%d", port), Token: randomID()}
			if e = atomicJSON(filepath.Join(root, "server.json"), s); e != nil {
				return e
			}
			exe, e := os.Executable()
			if e != nil {
				return e
			}
			log, e := os.OpenFile(filepath.Join(root, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if e != nil {
				return e
			}
			defer log.Close()
			cmd := exec.Command(exe, "--root", root, "serve-internal", "owned")
			cmd.Stdout = log
			cmd.Stderr = log
			cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if e = cmd.Start(); e != nil {
				return e
			}
			s.PID = cmd.Process.Pid
			if e = atomicJSON(filepath.Join(root, "server.json"), s); e != nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				return e
			}
			for deadline := time.Now().Add(4 * time.Second); time.Now().Before(deadline); {
				if control(s, "/control/probe") == nil {
					_ = cmd.Process.Release()
					return output(object{"running": true, "url": s.Address, "pid": s.PID})
				}
				time.Sleep(25 * time.Millisecond)
			}
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			_ = os.Remove(filepath.Join(root, "server.json"))
			return errors.New("owned server failed to start; see private server.log")
		}
		return errors.New("expected start, stop, or status")
	})
}
func safeReport(root, id string) (string, error) {
	if !idPattern.MatchString(id) {
		return "", errors.New("invalid task ID")
	}
	i, e := readIndex(root)
	if e != nil {
		return "", e
	}
	found := false
	for _, r := range i.Tasks {
		if r.ID == id && r.Report == "tasks/"+id+"/progress.json" {
			found = true
		}
	}
	if !found {
		return "", os.ErrNotExist
	}
	return safeReportPath(root, id)
}
func safeReportPath(root, id string) (string, error) {
	if !idPattern.MatchString(id) {
		return "", errors.New("invalid task ID")
	}
	path := filepath.Join(root, "tasks", id, "progress.json")
	real, e := filepath.EvalSymlinks(path)
	if e != nil {
		return "", e
	}
	base, e := filepath.EvalSymlinks(root)
	if e != nil {
		return "", e
	}
	if real != filepath.Join(base, "tasks", id, "progress.json") {
		return "", errors.New("symlink reports are not served")
	}
	return path, nil
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func summaries(root string) (object, error) {
	i, e := readIndex(root)
	if e != nil {
		return nil, e
	}
	a := []any{}
	for _, ref := range i.Tasks {
		entry := object{"id": ref.ID, "title": "Unavailable task", "unavailable": true}
		path, e := safeReportPath(root, ref.ID)
		if ref.Report != "tasks/"+ref.ID+"/progress.json" {
			e = errors.New("invalid task path")
		}
		d := object{}
		if e == nil {
			e = readJSON(path, &d)
		}
		if e == nil {
			e = validate(d)
		}
		if e == nil {
			entry = object{"id": ref.ID, "title": d["title"], "status": d["status"], "startedAt": d["startedAt"], "endedAt": d["endedAt"], "workspace": d["workspace"]}
			agents, _ := list(d, "agents", 64)
			entry["agentCount"] = len(agents)
			if d["status"] != "completed" && d["status"] != "failed" && d["status"] != "waiting" {
				for _, value := range agents {
					agent := value.(map[string]any)
					if agent["status"] == "failed" {
						entry["attention"] = "failed"
						break
					}
					if agent["status"] == "waiting" {
						entry["attention"] = "waiting"
					}
				}
			}
		}
		a = append(a, entry)
	}
	return object{"tasks": a}, nil
}
func dashboardHandler(root string, s serverState, shutdown func()) http.Handler {
	expected := strings.TrimPrefix(s.Address, "http://")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		if r.Host != expected || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != s.Address) {
			http.Error(w, "Forbidden", 403)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/control/") {
			if r.Method != "POST" || r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.Token)) != 1 {
				http.Error(w, "Forbidden", 403)
				return
			}
			if r.URL.Path != "/control/probe" && r.URL.Path != "/control/stop" {
				http.NotFound(w, r)
				return
			}
			writeJSON(w, object{"service": "task-dashboard", "token": s.Token})
			if r.URL.Path == "/control/stop" {
				go shutdown()
			}
			return
		}
		if r.Method != "GET" {
			http.Error(w, "Method not allowed", 405)
			return
		}
		path := r.URL.Path
		if path == "/api/tasks" {
			d, e := summaries(root)
			if e != nil {
				http.Error(w, "Task index unavailable", 503)
				return
			}
			writeJSON(w, d)
			return
		}
		if strings.HasPrefix(path, "/tasks/") {
			p := strings.Split(path, "/")
			if len(p) != 4 || p[3] != "progress.json" {
				http.NotFound(w, r)
				return
			}
			file, e := safeReport(root, p[2])
			if e != nil {
				http.NotFound(w, r)
				return
			}
			d := object{}
			if e = readJSON(file, &d); e == nil {
				e = validate(d)
			}
			if e != nil {
				http.Error(w, "Task report unavailable", 503)
				return
			}
			writeJSON(w, d)
			return
		}
		name := strings.TrimPrefix(path, "/")
		if path == "/" {
			name = "index.html"
		}
		if strings.Contains(name, "/") || name == "" {
			http.NotFound(w, r)
			return
		}
		allowed := false
		for _, s := range []string{".html", ".mjs", ".css"} {
			if strings.HasSuffix(name, s) {
				allowed = true
			}
		}
		if !allowed {
			http.NotFound(w, r)
			return
		}
		b, e := assets.Files.ReadFile(name)
		if e != nil {
			http.NotFound(w, r)
			return
		}
		switch {
		case strings.HasSuffix(name, ".html"):
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			html := strings.Replace(string(b), `data-dashboard-mode="standalone"`, `data-dashboard-mode="shared"`, 1)
			if !strings.Contains(html, `data-dashboard-mode="shared"`) {
				html = strings.Replace(html, "<html", `<html data-dashboard-mode="shared"`, 1)
			}
			b = []byte(html)
		case strings.HasSuffix(name, ".mjs"):
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		case strings.HasSuffix(name, ".css"):
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		}
		_, _ = w.Write(b)
	})
}
func serve(root, token string) error {
	s := serverState{}
	if e := readJSON(filepath.Join(root, "server.json"), &s); e != nil {
		return e
	}
	if token != "owned" {
		return errors.New("internal identity mismatch")
	}
	u, e := url.Parse(s.Address)
	if e != nil || u.Hostname() != "127.0.0.1" {
		return errors.New("invalid listen address")
	}
	listener, e := net.Listen("tcp4", u.Host)
	if e != nil {
		return e
	}
	var once sync.Once
	server := &http.Server{ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	server.Handler = dashboardHandler(root, s, func() {
		once.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = server.Shutdown(ctx)
		})
	})
	e = server.Serve(listener)
	if e == http.ErrServerClosed {
		return nil
	}
	return e
}
