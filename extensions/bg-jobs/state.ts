import type { BgJobsStatus, Job } from "./types.ts";
import { DEFAULT_LOG_DIR } from "./registry.ts";
import { FG_GUARD_NO_TIMEOUT_DEFAULT, FG_GUARD_TOO_LONG_DEFAULT } from "./guard.ts";

export class BackgroundRegistry {
    jobs = new Map<string, Job>();
    counter = 0;
    pendingDecisionJobId: string | undefined;

    /** Hook set by the extension factory; publishes status snapshots on pi.events. */
    emitStatus?: (s: BgJobsStatus) => void;
    lastStatusKey: string | undefined;

    jobAborts = new Map<string, AbortController>();

    nonInteractive = false;

    // ── Notification settings ─────────────────────────────────
    /** Delivery mode: steer = after current tool call, followUp = after agent finishes. */
    notifyMode: "steer" | "followUp" = "steer";
    /** Whether to trigger a turn on notification delivery. */
    triggerTurn: boolean = true;
    /** Coalescing window for batching completion notices (ms). 0 = instant. */
    coalesceMs: number = 400;
    /** Characters of output to show in completion notifications. */
    outputPreviewChars: number = 12_000;

    // ── Job settings ──────────────────────────────────────────
    /** Default timeout per job in seconds. null = no timeout. */
    timeout: number | null = null;
    /** Whether to hide the timeout parameter from the bg_run tool entirely. */
    disableTimeoutArg: boolean = false;
    /** Maximum number of concurrent background jobs. */
    maxConcurrent: number = 16;
    /** Directory for job log files. Defaults to the private per-uid dir in registry.ts. */
    logDir: string = DEFAULT_LOG_DIR;

    // ── Monitoring settings ───────────────────────────────────
    /** Milliseconds of no output growth before stalling warning. */
    stallThresholdMs: number = 45_000;
    /** Maximum size of a log file before rotation (bytes). */
    maxLogBytes: number = 100 * 1024 * 1024;

    // ── UI settings ───────────────────────────────────────────
    /** Whether to show the background job widget. */
    widgetEnabled: boolean = true;
    /** Whether to kill running jobs when the session quits. */
    killOnShutdown: boolean = false;
    /** Whether bg_jobs action='attach' may block waiting for job completion.
     *  Disabled by default: a blocking attach keeps the agent in an active tool
     *  call, hiding the idle state from follow-up schedulers (ralph-loop). */
    attachWait: boolean = false;

    // ── Foreground guard (see guard.ts) ────────────────────────────
    /** Block bash/powershell calls that lack an explicit timeout or exceed maxForegroundSec. */
    foregroundGuard: boolean = true;
    /** Max allowed foreground timeout, in seconds (bash `timeout` unit). */
    maxForegroundSec: number = 300;
    /** Regex sources matched against the command; a match bypasses the guard. */
    foregroundAllow: string[] = [];
    foregroundAllowRe: RegExp[] = [];
    /** Block-reason templates. Placeholders: {tool} {max} {asked}. */
    fgGuardNoTimeout: string = FG_GUARD_NO_TIMEOUT_DEFAULT;
    fgGuardTooLong: string = FG_GUARD_TOO_LONG_DEFAULT;
    guardBlocked: number = 0;

    completedCount = 0;
    failedCount = 0;
    totalStarted = 0;
    totalDurationMs = 0;
    recentTerminal: Job[] = [];

    sidebarTimer: NodeJS.Timeout | undefined;
    lastSidebarContent: string | undefined;

    pendingFinished: Job[] = [];
    finishedFlushTimer: NodeJS.Timeout | undefined;
}
