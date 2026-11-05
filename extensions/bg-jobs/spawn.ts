// src/spawn.ts
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureLogDir } from "./registry.ts";

// Mirror of pi-sudo-grant's setpgid-without-setsid wrapper: the child joins
// its own process group (so killProcessTree(-pid) keeps working) WITHOUT
// calling setsid(), thereby retaining the controlling tty — which is what
// makes sudo's tty-keyed credential cache reachable from bg jobs while a
// grant is active. Node's `detached` bundles setpgid+setsid, hence python.
const PYTHON_WRAPPER_SCRIPT = [
    "import os, sys",
    "os.setpgid(0, 0)",
    "os.execvp(sys.argv[1], sys.argv[1:])",
].join("\n")

let pythonProbe: string | null | undefined
function findPython(): string | null {
    if (pythonProbe !== undefined) return pythonProbe
    for (const candidate of ["python3", "python"]) {
        try {
            const p = spawnSync(candidate, ["-c", "pass"], { stdio: "ignore", timeout: 5000 })
            if (!p.error && p.status === 0) return (pythonProbe = candidate)
        } catch {
            /* next */
        }
    }
    return (pythonProbe = null)
}

export interface SpawnResult {
    pid: number;
    logPath: string;
    /** Path to write exit result on completion. */
    resultPath?: string;
    exit: Promise<number | null>;
}

/**
 * Wrap a bash command so it writes exit code and timestamp to a result file
 * on completion. This allows the extension to recover exit info after reload.
 */
function wrapWithResultCapture(command: string, resultPath?: string): string {
    if (!resultPath) return command;
    return `trap 'echo "$? $(date +%s)" > "${resultPath}"' EXIT; ${command};`;
}

/**
 * Spawn a child with stdout+stderr written directly to a file descriptor — the
 * Claude Code pattern: the kernel writes output to disk with zero JS in the
 * data path. Progress is read back by polling the file tail separately.
 *
 * Pass `command` to run `bash -c <command>`, or `file`/`fileArgs` to exec a
 * binary directly (e.g. agent_bg launching `pi -p`). The child is detached so
 * the whole process group can be signalled.
 */
export function spawnWithFileOutput(args: {
    command?: string;
    file?: string;
    fileArgs?: string[];
    cwd: string;
    logPath: string;
    /** Path to write exit result on completion. */
    resultPath?: string;
    /** When set, stderr is written here instead of merged into logPath. Used by
     *  the monitor tool so stdout is a clean event stream and stderr is captured
     *  separately (readable, but never emitted as an event). */
    errPath?: string;
    /** When set (active sudo grant), spawn through the setpgid-without-setsid
     *  python wrapper so the child keeps pi's controlling tty and can use
     *  sudo's tty-keyed credential cache. POSIX only; falls back silently. */
    ttyPreserve?: boolean;
    /** Directory holding the `sudo -n` shim to prepend to PATH (fail-fast
     *  instead of tty-prompting) while ttyPreserve is active. */
    sudoShimDir?: string;
    signal?: AbortSignal;
}): SpawnResult {
    // Creates the dir 0700 (or validates an existing one) before we open any
    // file in it; job logs contain arbitrary command output, so this must not
    // be a plain mkdir of a predictable path.
    ensureLogDir(dirname(args.logPath));
    const outFd = openSync(args.logPath, "w", 0o600);
    let errFd: number;
    try {
        errFd = args.errPath ? openSync(args.errPath, "w", 0o600) : outFd;
    } catch (err) {
        closeSync(outFd);
        throw err;
    }

    const [baseBin, baseArgs]: [string, string[]] = args.file
        ? [args.file, args.fileArgs ?? []]
        : ["bash", ["-c", wrapWithResultCapture(args.command ?? "", args.resultPath)]];

    // ttyPreserve: run the real command through the python setpgid wrapper.
    let bin = baseBin
    let binArgs = baseArgs
    let detached = true
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (args.ttyPreserve && process.platform !== "win32") {
        const py = findPython()
        if (py) {
            bin = py
            binArgs = ["-c", PYTHON_WRAPPER_SCRIPT, baseBin, ...baseArgs]
            detached = false // wrapper does setpgid itself; detached would setsid
        }
        // py === null → stay on the plain detached path (no tty, sudo fails
        // fast as before). Never block the job on a missing python3.
        if (args.sudoShimDir) {
            env.PATH = `${args.sudoShimDir}:${env.PATH ?? "/usr/bin:/bin"}`
        }
    }

    let proc;
    try {
        proc = spawn(bin, binArgs, {
            stdio: ["ignore", outFd, errFd],
            cwd: args.cwd,
            detached,
            env,
        });
    } finally {
        closeSync(outFd);
        if (errFd !== outFd) closeSync(errFd);
    }

    // Build the exit promise and attach the 'error' listener BEFORE any throw,
    // so an asynchronous spawn failure (ENOENT / EMFILE / EAGAIN) can never
    // surface as an uncaught exception that takes pi down.
    const exit = new Promise<number | null>((resolve) => {
        proc.on("close", (code) => resolve(code));
        proc.on("error", () => resolve(1));
    });

    if (!proc.pid) {
        try { unlinkSync(args.logPath); } catch { /* best-effort */ }
        if (args.errPath) {
            try { unlinkSync(args.errPath); } catch { /* best-effort */ }
        }
        throw new Error("Failed to spawn process");
    }
    const pid = proc.pid;

    // Kill the process group on abort. Most callers manage abort themselves and
    // do not pass a signal; this is offered for direct/background spawns.
    const onAbort = () => killProcessTree(pid);
    if (args.signal) {
        if (args.signal.aborted) onAbort();
        else args.signal.addEventListener("abort", onAbort, { once: true });
    }
    void exit.finally(() => args.signal?.removeEventListener("abort", onAbort));

    proc.unref();

    return { pid, logPath: args.logPath, exit };
}

/**
 * Kill an entire process group via negative PID signal.
 * Falls back to direct PID kill if group kill fails.
 */
export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Cheap liveness probe via signal 0. */
export function processExists(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}
