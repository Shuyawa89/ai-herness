package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func output(v any) error { return json.NewEncoder(os.Stdout).Encode(v) }
func flags(name string) *flag.FlagSet {
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	f.SetOutput(io.Discard)
	return f
}
func run(args []string) error {
	home, e := os.UserHomeDir()
	if e != nil {
		return e
	}
	f := flags("task-dashboard")
	root := f.String("root", filepath.Join(home, ".local", "state", "task-dashboard"), "")
	if e = f.Parse(args); e != nil {
		return e
	}
	args = f.Args()
	if len(args) == 0 {
		return errors.New("expected register, update, or server")
	}
	*root, e = filepath.Abs(*root)
	if e != nil {
		return e
	}
	switch args[0] {
	case "register":
		f := flags("register")
		title := f.String("title", "", "")
		cwd := f.String("cwd", "", "")
		file := f.String("file", "", "")
		if e = f.Parse(args[1:]); e != nil {
			return e
		}
		if f.NArg() != 0 {
			return errors.New("unexpected register arguments")
		}
		v, e := register(*root, *title, *cwd, *file)
		if e != nil {
			return e
		}
		if s, e := ownedServer(*root); e == nil {
			v["url"] = s.Address + "/?task=" + v["id"].(string)
		}
		return output(v)
	case "update":
		if len(args) < 3 {
			return errors.New("expected update FILE agent ID or task")
		}
		path, kind := args[1], args[2]
		rest := args[3:]
		id := ""
		if kind == "agent" {
			if len(rest) == 0 {
				return errors.New("agent ID required")
			}
			id = rest[0]
			rest = rest[1:]
		}
		f := flags("update")
		mapping := map[string]string{"name": "name", "status": "status", "current": "current", "reason": "reason", "parent-id": "parentId", "launch-method": "launchMethod", "model": "model", "role": "role"}
		fields := map[string]*string{}
		for name, key := range mapping {
			fields[key] = f.String(name, "", "")
		}
		raw := f.String("patch", "", "")
		event := f.String("event", "", "")
		cwd := f.String("cwd", "", "")
		if e = f.Parse(rest); e != nil {
			return e
		}
		if f.NArg() != 0 {
			return errors.New("unexpected update arguments")
		}
		patch := object{}
		if kind == "task" {
			if *raw == "" {
				return errors.New("task patch required")
			}
			if e = json.Unmarshal([]byte(*raw), &patch); e != nil {
				return e
			}
			if patch == nil {
				return errors.New("patch must be an object")
			}
		} else {
			f.Visit(func(v *flag.Flag) {
				if key, ok := mapping[v.Name]; ok {
					patch[key] = *fields[key]
				}
			})
		}
		return update(path, kind, id, patch, *event, *cwd)
	case "server":
		if len(args) < 2 {
			return errors.New("expected server start, stop, or status")
		}
		f := flags("server")
		port := f.Int("port", 19437, "")
		if e = f.Parse(args[2:]); e != nil {
			return e
		}
		if f.NArg() != 0 {
			return errors.New("unexpected server arguments")
		}
		return serverCommand(*root, args[1], *port)
	case "serve-internal":
		if len(args) != 2 {
			return errors.New("internal invocation")
		}
		return serve(*root, args[1])
	}
	return errors.New("unknown command")
}
func main() {
	if e := run(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, "task-dashboard:", e)
		os.Exit(1)
	}
}
