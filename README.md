# pi-bg-jobs

Run long shell commands in the background from [pi](https://github.com/badlogic/pi-mono)
without blocking the agent, and get woken up automatically when they finish.

The problem this solves: a training run, build, or test suite takes 20 minutes. With a
plain `bash` call the agent sits inside the tool call the whole time — no interaction,
no context budget for anything else, and it looks idle. With `bg_run` the command returns
immediately, the agent keeps working (or stops and waits), and a completion notification
arrives on its own.

## Features

- **Non-blocking launch** — `bg_run` returns a job id immediately
- **Automatic completion notification** — no polling, no sleep loops. The agent is woken
  when the job exits, with exit code, duration, and log path
- **Streaming-friendly inspection** — `bg_jobs` for `list` / `output` / `attach` / `search` /
  `stats` / `cleanup`, plus `bg_decide` for timed-out jobs
- **Foreground guard** — blocks `bash` calls that have no timeout or one that is too long,
  nudging long work into the background instead
- **Output capture to disk** — full stdout/stderr saved per job, searchable with a regex
  across every job ever run this session
- **Interactive manager** — `/bg-list` TUI panel to inspect, kill, and attach
- **Crash recovery** — jobs survive a pi restart; the registry revives still-running ones
- **`onDone` continuation** — attach a prompt to a job so the agent is told what to do next
  the moment it completes
- **Resource limits** — max concurrency, per-job timeout, log rotation by size

## Requirements

- [pi](https://github.com/badlogic/pi-mono) ≥ 0.84
- Linux or macOS. Jobs are launched through `bash -c` with a POSIX `trap … EXIT` result
  capture, detached process groups, and `SIGTERM`/`SIGKILL` — **Windows is not supported.**
- `bash` on `PATH`

## Installation

```bash
pi install git:github.com/Carbyne/pi-bg-jobs
```

Try it without installing:

```bash
pi -e git:github.com/Carbyne/pi-bg-jobs
```

Start `pi` and the tools are registered.

## Tools

| Tool | Purpose |
|------|---------|
| `bg_run` | Launch a command in the background. Args: `command`, optional `name`, `timeout` (seconds), `onDone` (prompt injected on completion) |
| `bg_jobs` | Inspect and manage jobs. Actions: `list`, `output`, `kill`, `attach`, `search`, `cleanup`, `stats` |
| `bg_decide` | Resolve a timed-out job: `keep`, `kill`, or `check` |

## Commands & shortcuts

| Binding | Action |
|---------|--------|
| `/bg-list` | Open the interactive background task manager |
| `/fg-guard on\|off\|status` | Toggle the foreground guard |
| `ctrl+shift+j` / `shift+down` | Open background task manager |
| `ctrl+shift+x` | Kill the most recent running job |

## Usage

```
> bg_run command="npm run build" name="build" onDone="If the build failed, read the log and tell me why."
```

You'll be automatically notified when it completes — there is no need to poll. For a quick
non-blocking peek while it runs:

```
> bg_jobs action="output" jobId="job-1234-1"
```

`attach` gives a live snapshot and also returns immediately; completion notifications are
automatic either way.

## Configuration

Set a `bgJobs` object in `~/.pi/agent/settings.json` (or a project's `.pi/settings.json`):

```json
{
  "bgJobs": {
    "notifyMode": "steer",
    "triggerTurn": true,
    "coalesceMs": 400,
    "outputPreviewChars": 12000,
    "maxConcurrent": 16,
    "timeout": null,
    "killOnShutdown": false,
    "widgetEnabled": true,
    "attachWait": false,
    "foregroundGuard": true,
    "maxForegroundSec": 300,
    "foregroundAllow": [],
    "logDir": null,
    "stallThresholdMs": 45000,
    "maxLogBytes": 104857600
  }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `notifyMode` | `"steer"` | Deliver the completion notice after the current tool call (`steer`) or after the agent finishes (`followUp`) |
| `triggerTurn` | `true` | Whether a delivered notice starts a new agent turn |
| `coalesceMs` | `400` | Window for batching several completion notices into one |
| `outputPreviewChars` | `12000` | Characters of output included in the notice |
| `maxConcurrent` | `16` | Concurrent background jobs allowed |
| `timeout` | `null` | Default per-job timeout in seconds (`null` = none) |
| `disableTimeoutArg` | `false` | Hide the `timeout` argument from `bg_run` entirely |
| `killOnShutdown` | `false` | Kill running jobs when pi quits |
| `widgetEnabled` | `true` | Show the status widget |
| `attachWait` | `false` | Allow `bg_jobs action="attach"` to block. Left off because a blocking attach keeps the agent inside a tool call, which hides the idle state from follow-up schedulers such as `pi-ralph-loop` |
| `foregroundGuard` | `true` | Require `bash` calls to carry a bounded timeout |
| `maxForegroundSec` | `300` | Maximum allowed foreground timeout |
| `foregroundAllow` | `[]` | Regex sources matched against the command; a match bypasses the guard |
| `logDir` | *auto* | Override where job logs live (see below) |
| `stallThresholdMs` | `45000` | Silence before a job is flagged as possibly stalled |
| `maxLogBytes` | `104857600` | Rotate a job log past this size |

## Where logs live, and permissions

Job output is written to a private per-user directory:

```
$TMPDIR/pi-bg-<uid>/          # created 0700, validated on use
    job-<pid>-<n>.log         # stdout+stderr, created 0600
    job-<pid>-<n>.result      # exit code + finish time
    job-<pid>-<n>.err         # split stderr, when a monitor uses it
```

The name is predictable so logs survive across sessions, which means the directory is
never trusted blindly: it is created `0700`, and an existing entry is validated as a real
directory owned by your uid — and repaired to `0700` — before anything is written. If it
is owned by someone else, or is not a directory, `bg_run` refuses rather than writing job
output somewhere hostile. Set `bgJobs.logDir` to override the location.

Logs can contain secrets (tokens in command lines, credentials in build output). They are
`0600` inside a `0700` directory, and are only swept after 24 days.

## Event bus contracts

bg-jobs is the job registry the rest of the fleet coordinates through — all coupling is
soft over `pi.events` (no peer loaded → these are inert no-ops):

| Event | Direction | Consumers | Purpose |
|-------|-----------|-----------|---------|
| `bg-jobs:status` | **emitted** (on every running-set change, plus on request) | [pi-ralph-loop](https://github.com/Carbyne/pi-ralph-loop) pauses follow-ups while jobs run and fires stuck-checks; [pi-agent-steer](https://github.com/Carbyne/pi-agent-steer) gates `a` / `/idlequeue` / the idle-with-bg prompt | `{running, oldestStartTime?, jobs[{id, name?, command, startTime}]}` |
| `bg-jobs:status-request` | **answers** (re-emits current snapshot) | same | Peers subscribing *after* a reload/revive missed change events; mirrors the ralph pattern |
| `bg-jobs:adopt` | **accepts** | [pi-subagent](https://github.com/Carbyne/pi-subagent) background runs | Registers an externally-spawned child as a managed job: sidebar pills, `bg_jobs list/output/kill`, status broadcasts, stall/oversize watch, exit bookkeeping. Payload: `{command, name, pid, logPath, exit, proc?, silent?, disablePromptStall?, onExit?, reply?}` — `reply({ok, id})` is synchronous so the adopter can detect “bg-jobs not loaded” and fall back internally |
| `sudo-grant:state` | **consumed** | — (emitted by [pi-sudo-grant](https://github.com/Carbyne/pi-sudo-grant)) | While a sudo grant is active, `bg_run` spawns keep pi's controlling tty (setpgid-without-setsid wrapper) + the fail-fast `sudo -n` PATH shim, so `sudo` works inside background jobs. Revoked/no-grant/no-python3 → spawns are exactly as before. Subagent children are never covered (sudo is main-agent-only by contract) |
| `sudo-grant:state-request` | **emitted** (on session start) | — | Snapshot sync after reload, same pattern as above |

## Development

```bash
pi install /absolute/path/to/pi-bg-jobs   # local checkout
pi -e ./pi-bg-jobs                        # or one run only
```

`npm run typecheck` requires `npm install` first (dev dependencies are not installed by
`pi install`). Note that the typecheck script and `tsconfig.json` have not been exercised
against every file — treat new errors as findings, not as proof of a broken build.

## License

MIT — see [LICENSE](LICENSE).
