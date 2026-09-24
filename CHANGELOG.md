# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
