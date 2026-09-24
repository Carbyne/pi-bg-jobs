/**
 * The job registry — the single point of truth for every running or
 * recently-terminal background job. All CRUD operations live here.
 *
 * On top of the data store, this module renders the in-session sidebar
 * pill bar (`renderSidebar`) and aggregates stats (`getStats`).
 */

import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { formatDuration, jobLabel } from "./format.ts";
import {
    PREVIEW_CHARS,
    RECENT_TERMINAL_KEEP,
    type BgJobsStatus,
    type Job,
    
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { readBoundedTail } from "./output.ts";

// --- ID generation -------------------------------------------------------

export function nextJobId(reg: BackgroundRegistry): string {
    return `job-${process.pid}-${++reg.counter}`;
}

/** Dedicated log directory. Keeping logs in their own dir (not loose in a
 *  shared tmp) keeps the stale-log sweep bounded — it lists only our files. */
// Per-uid so concurrent pi sessions under different identities (e.g. a local
// vs AD account sharing a world-writable tmp) never collide on log-dir
// ownership. The name is deliberately predictable so logs survive across
// sessions, which means we must not simply trust whatever sits there: a local
// attacker could pre-create it and read, displace, or symlink-redirect our
// job output. `ensureLogDir` below creates it 0700 and validates any
// pre-existing entry before anything is written to it.
export const DEFAULT_LOG_DIR = (() => {
    const info = userInfo();
    const uid = info.uid >= 0 ? info.uid : process.uid;
    return join(tmpdir(), `pi-bg-${uid ?? "shared"}`);
})();

// Cache of the last dir verified this process, so the check costs one syscall
// comparison per session rather than one per job.
let verifiedLogDir: string | undefined;

/**
 * Ensure `dir` exists as a private (0700), uid-owned directory and return it.
 * Idempotent. Throws instead of silently writing job logs somewhere hostile.
 */
export function ensureLogDir(dir: string = DEFAULT_LOG_DIR): string {
    if (verifiedLogDir === dir) return dir;

    const ourUid = process.getuid?.();
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
        existing = lstatSync(dir);
    } catch {
        existing = undefined; // genuinely absent — safe to create below
    }

    // Note: mkdirSync's recursive:true only swallows EEXIST for directories,
    // so a planted file would surface as a bare EEXIST. Check first to report
    // the actual problem instead.
    if (existing && !existing.isDirectory()) {
        throw new Error(
            `bg-jobs: refusing to use log dir ${dir} — it exists and is not a directory. ` +
            `Set "logDir" in settings.json to a private path.`,
        );
    }
    if (existing && ourUid !== undefined && existing.uid !== ourUid) {
        throw new Error(
            `bg-jobs: refusing to use log dir ${dir} — it is owned by uid ${existing.uid}, not ${ourUid}. ` +
            `Set "logDir" in settings.json to a private path.`,
        );
    }
    if (!existing) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const st = lstatSync(dir);
    // mkdirSync's mode is masked by umask and ignored on some platforms, so
    // force the bits rather than hoping the default is private enough.
    if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);

    verifiedLogDir = dir;
    return dir;
}

export function logPathFor(jobId: string, logDir: string = DEFAULT_LOG_DIR): string {
    return `${logDir}/${jobId}.log`;
}

/** Path to the exit result file (exit code + finish time) for a job. */
export function resultPathFor(jobId: string, logDir: string = DEFAULT_LOG_DIR): string {
    return `${logDir}/${jobId}.result`;
}

/** Sibling stderr-capture path for a monitor's split output. Keeps the
 *  `.log`/`.err` naming convention in one place. */
export function errPathFor(jobId: string, logDir: string = DEFAULT_LOG_DIR): string {
    return `${logDir}/${jobId}.err`;
}

/** Default log dir (exported for format messages). */
export const LOG_DIR = DEFAULT_LOG_DIR;

/**
 * Build a fresh running Job. Centralizes the Job shape so the `stop`
 * fields (and any future additions) don't drift across the bash/bash_bg/
 * agent_bg/monitor construction sites.
 */
export function createRunningJob(args: {
    id: string;
    command: string;
    pid: number;
    logPath: string;
    toolCallId: string;
    name?: string;
    
    isBackgrounded?: boolean;
}): Job {
    return {
        id: args.id,
        name: args.name,
        command: args.command,
        pid: args.pid,
        startTime: Date.now(),
        status: "running",
        logPath: args.logPath,
        toolCallId: args.toolCallId,
        isBackgrounded: args.isBackgrounded ?? true,
        
    };
}

// --- Registry mutations --------------------------------------------------

/** Record that a job has started (lifetime counter). */
export function markStarted(reg: BackgroundRegistry): void {
    reg.totalStarted++;
}

/** Add a brand-new running job and count it as started. */
export function add(reg: BackgroundRegistry, job: Job): Job {
    reg.jobs.set(job.id, job);
    markStarted(reg);
    return job;
}

/** True once the running-job count has reached the concurrency cap. Counts with
 *  a short-circuit so it stops at the cap instead of scanning the whole map. */
export function atConcurrencyLimit(reg: BackgroundRegistry): boolean {
    let n = 0;
    for (const job of reg.jobs.values()) {
        if (job.status === "running" && ++n >= reg.maxConcurrent) return true;
    }
    return false;
}

/**
 * Remove a terminal job from the live map and update lifetime counters.
 * Returns the removed job (or undefined if it wasn't in the map).
 */
export function forget(reg: BackgroundRegistry, job: Job): Job | undefined {
    if (!reg.jobs.delete(job.id)) return undefined;
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
    if (job.status === "completed") {
        reg.completedCount++;
        reg.totalDurationMs += terminalDurationMs(job);
    } else if (job.status === "failed") {
        reg.failedCount++;
        reg.totalDurationMs += terminalDurationMs(job);
    }
    reg.recentTerminal.push(job);
    if (reg.recentTerminal.length > RECENT_TERMINAL_KEEP) {
        reg.recentTerminal.shift();
    }
    return job;
}

/** Look up a job by ID. Falls back to prepending "job-" for the common
 *  LLM-stripping case, and to recent-terminal jobs for completed ones. */
export function findJob(reg: BackgroundRegistry, jobId: string): Job | undefined {
    return (
        reg.jobs.get(jobId) ??
        reg.jobs.get(`job-${jobId}`) ??
        reg.recentTerminal.find((j) => j.id === jobId || j.id === `job-${jobId}`)
    );
}

/** Purge all terminal jobs from in-memory state and delete their log files. */
export function cleanupTerminal(reg: BackgroundRegistry): {
    purged: number;
    bytesReclaimed: number;
} {
    let purged = 0;
    let bytes = 0;
    const deletedLogs = new Set<string>();
    const deleteOnce = (logPath: string): number => {
        if (deletedLogs.has(logPath)) return 0;
        deletedLogs.add(logPath);
        return deleteLogFile(logPath);
    };

    const idsToRemove: string[] = [];
    for (const [id, job] of reg.jobs.entries()) {
        if (job.status !== "running") {
            idsToRemove.push(id);
            bytes += deleteOnce(job.logPath);
            purged++;
        }
    }
    for (const id of idsToRemove) {
        reg.jobs.delete(id);
    }
    // recent-terminal 링도 종료된 잡이므로 로그 파일까지 함께 정리.
    for (const job of reg.recentTerminal) {
        bytes += deleteOnce(job.logPath);
        purged++;
    }
    reg.recentTerminal.length = 0;
    return { purged, bytesReclaimed: bytes };
}

function deleteLogFile(logPath: string): number {
    try {
        const { size } = statSync(logPath);
        unlinkSync(logPath);
        return size;
    } catch {
        return 0;
    }
}

// ─── Sidebar rendering ───────────────────────────────────────────────────

/**
 * Render the pill-bar status widget and aggregate status-bar text, and keep a
 * 1 Hz ticker running while any job is alive so the durations stay live (the
 * widget isn't redrawn on a timer otherwise). Re-renders only when the content
 * actually changes. Call after any state change that affects running jobs.
 */
export function computeStatus(reg: BackgroundRegistry): BgJobsStatus {
    const runningJobs = Array.from(reg.jobs.values()).filter(
        (j) => j.status === "running"
    );
    return {
        running: runningJobs.length,
        oldestStartTime: runningJobs.length
            ? Math.min(...runningJobs.map((j) => j.startTime))
            : undefined,
        jobs: runningJobs.map((j) => ({
            id: j.id,
            name: j.name,
            command: j.command,
            startTime: j.startTime,
        })),
    };
}

export function renderSidebar(reg: BackgroundRegistry, ctx: UiContext): void {
    // Publish a live status snapshot to other extensions (pi.events bus) on
    // every change of the running-job set. Done before the widgetEnabled
    // early-return so status flows even with the widget off.
    const status = computeStatus(reg);
    const statusKey = status.jobs.map((j) => j.id).sort().join(",");
    if (statusKey !== reg.lastStatusKey) {
        reg.lastStatusKey = statusKey;
        try {
            reg.emitStatus?.(status);
        } catch {
            /* listener errors must never break job rendering */
        }
    }

    if (!reg.widgetEnabled) return;
    const pills: string[] = [];
    let runningCount = 0;

    for (const job of reg.jobs.values()) {
        if (job.status !== "running") continue;
        runningCount++;
        const duration = formatDuration(Date.now() - job.startTime);
        const glyph = "▶";
        pills.push(
            `${glyph} ${jobLabel(job)}: ${job.command.slice(0, PREVIEW_CHARS.sidebar)} (${duration})`
        );
    }

    if (pills.length === 0) {
        stopSidebarTicker(reg);
        if (reg.lastSidebarContent !== undefined) {
            reg.lastSidebarContent = undefined;
            ctx.ui.setWidget("background-jobs", undefined, { placement: "belowEditor" });
            ctx.ui.setStatus("background-jobs", undefined);
        }
        return;
    }

    const parts = [`${runningCount} running`];
    if (reg.completedCount > 0) parts.push(`${reg.completedCount} done`);
    if (reg.failedCount > 0) parts.push(`${reg.failedCount} failed`);
    const statusText = `▶ ${parts.join(", ")}`;
    const key = `${pills.join("\n")}|${statusText}`;

    if (key !== reg.lastSidebarContent) {
        reg.lastSidebarContent = key;
        ctx.ui.setWidget("background-jobs", pills, { placement: "belowEditor" });
        ctx.ui.setStatus("background-jobs", ctx.ui.theme.fg("accent", statusText));
    }

    ensureSidebarTicker(reg, ctx);
}

/** Start the live-duration ticker if not already running. */
function ensureSidebarTicker(reg: BackgroundRegistry, ctx: UiContext): void {
    if (reg.sidebarTimer) return;
    const t = setInterval(() => {
        try {
            renderSidebar(reg, ctx);
        } catch {
            // The captured ctx went stale (session reload/fork/switch) — stop
            // ticking rather than throw an uncaught exception in the interval.
            stopSidebarTicker(reg);
        }
    }, 1000);
    t.unref();
    reg.sidebarTimer = t;
}

/** Stop the live-duration ticker (no running jobs, or on shutdown). */
export function stopSidebarTicker(reg: BackgroundRegistry): void {
    if (reg.sidebarTimer) {
        clearInterval(reg.sidebarTimer);
        reg.sidebarTimer = undefined;
    }
}

// ─── 통계 ───────────────────────────────────────────────────────────────────────────────────

export interface JobStats {
    totalStarted: number;
    running: number;
    completed: number;
    failed: number;
    killed: number;
    recentTerminal: number;
    averageDurationMs: number;
    totalDurationMs: number;
}

export function getStats(reg: BackgroundRegistry): JobStats {
    let running = 0;
    let killed = 0;
    for (const job of reg.jobs.values()) {
        if (job.status === "running") running++;
        else if (job.status === "killed") killed++;
    }
    const terminalCount = reg.completedCount + reg.failedCount;
    return {
        totalStarted: reg.totalStarted,
        running,
        completed: reg.completedCount,
        failed: reg.failedCount,
        killed,
        recentTerminal: reg.recentTerminal.length,
        averageDurationMs:
            terminalCount > 0
                ? Math.round(reg.totalDurationMs / terminalCount)
                : 0,
        totalDurationMs: reg.totalDurationMs,
    };
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────────────────

function terminalDurationMs(job: Job): number {
    return Date.now() - job.startTime;
}

// ─── 상태 헬퍼 (툴·단축키에서 사용) ───────────────────────────────────────────────────────

/** True when the job is currently in the running state. */
export function isRunning(job: Job): boolean {
    return job.status === "running";
}

/** Read only the tail of a job's log file — O(maxChars) even for large files. */
export function readLogTail(job: Job, maxChars: number): string {
    return readBoundedTail(job.logPath, maxChars);
}
