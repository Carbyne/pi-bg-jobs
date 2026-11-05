# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0

### Added

- **Sudo-capable background jobs while a grant is active.** pi-bg-jobs mirrors
  pi-sudo-grant over the event bus (`sudo-grant:state` / `state-request`): when
  the user holds an active sudo grant, `bg_run` spawns go through the
  setpgid-without-setsid python wrapper (the same trick pi-sudo-grant uses for
  the bash tool) so the job keeps pi's controlling tty — sudo's credential
  cache is tty-keyed. The granted PATH's `sudo -n` fail-fast shim is prepended,
  so a stale/missing cache produces an immediate `sudo: a password is required`
  in the job log instead of a terminal prompt. Without an active grant (or
  without python3), jobs spawn exactly as before (detached, no tty). This is
  deliberately NOT propagated to subagent children — sudo remains
  main-agent-only (see pi-subagent 0.4.7 / pi-sudo-grant 0.1.1).

## 0.2.0

### Added

- **External job adoption** — peer extensions can hand a self-spawned child process to
  bg-jobs over the `pi.events` bus (`"bg-jobs:adopt"`). Adopted jobs get the full
  lifecycle: sidebar pills, `bg_jobs list/output/kill`, the `bg-jobs:status` snapshot
  (so `pi-ralph-loop` waits on them), stall/oversize machinery, and exit bookkeeping.
  Used by `pi-subagent` background mode. Payload: `{ command, name, pid, logPath, exit,
  proc?, silent, disablePromptStall, onExit, reply }` — `reply({ok, id})` is called
  synchronously; callers degrade gracefully when no bg-jobs instance is listening.

## 0.1.0

### Added

- `bg_run` — launch shell commands in the background; returns a job id immediately
- `bg_jobs` — `list`, `output`, `kill`, `attach`, `search`, `cleanup`, `stats`
- `bg_decide` — resolve a timed-out job with `keep`, `kill`, or `check`
- `/bg-list` interactive task manager, plus `/fg-guard on|off|status`
- Shortcuts: `ctrl+shift+j` and `shift+down` (manager), `ctrl+shift+x` (kill newest running job)
- Foreground guard requiring bounded timeouts on plain `bash` calls, with a regex allowlist
- Automatic completion notification with configurable delivery (`steer` / `followUp`),
  coalescing window, and an `onDone` continuation prompt
- Per-job stdout/stderr capture to disk with regex search across all session jobs
- Job revival across `/reload` and process restart; 24h stale-artifact sweep
- Private per-user log directory under `os.tmpdir()`, created `0700` and validated (real
  directory, owned by the current uid) before use, with job logs written `0600`
