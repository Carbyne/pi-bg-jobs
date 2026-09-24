/**
 * Lifecycle helpers for background jobs.
 *
 * Collects the cross-cutting concerns — completion notification, timeout
 * scheduling, terminal-state marking, and cleanup (kill) — in one place.
 */

import { readFileSync, statSync as fsStatSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    EVENT,
    type Job,
    type JobStatus,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { killProcessTree, processExists } from "./spawn.ts";
import { LOG_DIR, atConcurrencyLimit, forget, renderSidebar } from "./registry.ts";
import { watchStalls } from "./monitoring.ts";
import { enqueueFinished } from "./notify.ts";
import { formatDuration, jobLabel } from "./format.ts";

// --- Background-job orchestration ----------------------------------------

export function assertJobSlot(reg: BackgroundRegistry): void {
    if (atConcurrencyLimit(reg)) {
        throw new Error(
                `Kill or wait for existing jobs before starting new ones.`
        );
    }
}

export function startBackgroundJob(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    job: Job;
    exit: Promise<number | null>;
    shouldNotify?: boolean;
    disablePromptStall?: boolean;
    disableOversizeKill?: boolean;
    onExit?: (code: number | null) => void;
}): AbortController {
    ensureCompletionPromise(args.job);
    const jobAc = createJobAbort(args.reg, args.job.id);
    const cancelStall = watchStalls({
        reg: args.reg,
        jobId: args.job.id,
        command: args.job.command,
        logPath: args.job.logPath,
        pi: args.pi,
        disablePromptStall: args.disablePromptStall,
        disableOversizeKill: args.disableOversizeKill,
        onOversize: () => terminateJobSilently(args.reg, args.job),
    });
    jobAc.signal.addEventListener("abort", cancelStall, { once: true });
    void args.exit.then((code) => {
        args.onExit?.(code);
        completeJob({
            job: args.job,
            code,
            reg: args.reg,
            pi: args.pi,
            ctx: args.ctx,
            shouldNotify: args.shouldNotify,
        });
    });
    renderSidebar(args.reg, args.ctx);
    return jobAc;
}

// --- Terminal-state marking ----------------------------------------------

export function completeJob(args: {
    job: Job;
    code: number | null | undefined;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    shouldNotify?: boolean;
}): void {
    if (args.job.status !== "running") return;
    const finished = args.job;
    abortJob(args.reg, finished.id);
    markTerminal(finished, statusFromExit(args.code), args.code ?? undefined);
    if (args.shouldNotify !== false) {
        try {
            notifyFinished({ job: finished, reg: args.reg, pi: args.pi, ctx: args.ctx });
        } catch {
            /* stale ctx after session fork/switch — notification skipped */
        }
    }
    forget(args.reg, finished);
    try {
        renderSidebar(args.reg, finished.ctx ?? args.ctx);
    } catch {
        /* stale ctx after session fork/switch — sidebar render skipped */
    }
}

export function markTerminal(
    job: Job,
    status: JobStatus,
    exitCode?: number
): void {
    if (job.status === "completed" || job.status === "failed" || job.status === "killed") {
        return;
    }
    job.status = status;
    job.exitCode = exitCode;
    delete job.proc;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
    delete job.donePromise;
}

export function statusFromExit(code: number | null | undefined): JobStatus {
    return code === 0 || code === null ? "completed" : "failed";
}

export function ensureCompletionPromise(job: Job): void {
    if (job.donePromise) return;
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

export function markKilledSilently(job: Job): void {
    markTerminal(job, "killed");
    job.outputConsumed = true;
}

export function terminateJobSilently(reg: BackgroundRegistry, job: Job): void {
    terminateJob(job);
    markKilledSilently(job);
    abortJob(reg, job.id);
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
}

export function isSignalExit(code: number | null | undefined): boolean {
    return code === 137 || code === 143;
}

// --- Per-job abort (cleanup) ---------------------------------------------

export function createJobAbort(
    reg: BackgroundRegistry,
    jobId: string
): AbortController {
    const existing = reg.jobAborts.get(jobId);
    if (existing) return existing;
    const ac = new AbortController();
    reg.jobAborts.set(jobId, ac);
    return ac;
}

export function abortJob(reg: BackgroundRegistry, jobId: string): void {
    const ac = reg.jobAborts.get(jobId);
    if (ac) {
        ac.abort();
        reg.jobAborts.delete(jobId);
    }
}

export function terminateJob(job: Job): void {
    if (job.proc && processExists(job.proc.pid)) {
        killProcessTree(job.proc.pid, "SIGTERM");
        return;
    }
    if (job.pid > 0 && processExists(job.pid)) {
        killProcessTree(job.pid, "SIGTERM");
    }
}

// --- Completion notification ---------------------------------------------

export function notifyFinished(args: {
    job: Job;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): void {
    enqueueFinished(args.reg, args.pi, args.ctx, args.job);
}

/**
 * Record a timeout decision request: prompt the agent to decide via bg_decide.
 */
export function requestJobDecision(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    job: Job;
    timeoutMs: number;
}): void {
    args.reg.pendingDecisionJobId = args.job.id;
    const label = `"${jobLabel(args.job)}"`;
    const elapsed = formatDuration(args.timeoutMs);

    args.ctx.ui.notify(`${label} still running after ${elapsed}.`, "warning");

    args.pi.sendMessage(
        {
            customType: EVENT.timeout,
            content:
                `Command ${args.job.id} still running after ${elapsed}. ` +
                `Decide with bg_decide (keep / kill / check). Output: ${args.job.logPath}`,
            display: true,
            details: {
                jobId: args.job.id,
                logPath: args.job.logPath,
                command: args.job.command,
            },
        },
        { deliverAs: "followUp", triggerTurn: true }
    );
}

// --- Helpers -------------------------------------------------------------

export function requireExistingCwd(cwd: string): void {
    try {
        fsStatSync(cwd);
    } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
}



// --- Rehydration (session restore) ---------------------------------------

/** Read a job's exit result file. Returns { exitCode, finishedAt } or null. */
function readExitResult(job: Job): { exitCode: number; finishedAt: number } | null {
    try {
        const text = readFileSync(job.logPath.replace(/\.log$/, '.result'), "utf8").trim();
        const parts = text.split(" ");
        const exitCode = parseInt(parts[0], 10);
        const finishedAt = parseInt(parts[1], 10) * 1000; // seconds -> ms
        if (isNaN(exitCode) || isNaN(finishedAt)) return null;
        return { exitCode, finishedAt };
    } catch {
        return null;
    }
}

export function reviveAndValidate(
    _reg: BackgroundRegistry,
    job: Job,
    skipPidCheck: boolean = false,
): "alive" | "completed" {
    if (job.status !== "running") return "completed";
    if (!skipPidCheck) {
        const spawnedPid = Number.parseInt(job.id.split("-")[1] ?? "", 10);
        if (spawnedPid !== process.pid || !processExists(job.pid)) {
            markTerminal(job, "failed");
            return "completed";
        }
    } else if (!processExists(job.pid)) {
        const result = readExitResult(job);
        const exitCode = result?.exitCode ?? 1;
        markTerminal(job, exitCode === 0 ? "completed" : "failed", exitCode);
        if (result) job.endedAt = result.finishedAt;
        return "completed";
    }
    return "alive";
}

export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}

export async function cleanupStaleRuntimeArtifacts(logDir: string = LOG_DIR): Promise<void> {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let names: string[];
    try {
        names = await readdir(logDir);
    } catch {
        return;
    }
    await Promise.all(
        names.map(async (name) => {
            const fullPath = pathJoin(logDir, name);
            try {
                const { mtimeMs } = await stat(fullPath);
                if (now - mtimeMs > MAX_AGE_MS) await unlink(fullPath);
            } catch {
                /* already gone */
            }
        })
    );
}

/** Monitor revived jobs for completion by polling their PIDs. */
export function monitorRevivedJobs(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
): () => void {
    const pollInterval = 3000; // check every 3s
    let active = true;

    const timer = setInterval(() => {
        if (!active) return;
        for (const [id, job] of reg.jobs.entries()) {
            if (job.status !== "running") continue;
            if (!processExists(job.pid)) {
                const result = readExitResult(job);
                completeJob({ job, code: result?.exitCode ?? 0, reg, pi, ctx });
                if (result) job.endedAt = result.finishedAt;
            }
        }
    }, pollInterval);
    (timer as NodeJS.Timeout).unref();

    return () => {
        active = false;
        clearInterval(timer);
    };
}
