/**
 * bg-jobs — background task extension for the pi agent.
 *
 * Registers three tools:
 *   - bg_run     — start a command in the background (faithful mirror of stock bash)
 *   - bg_jobs    — list, inspect, kill, attach to background jobs
 *   - bg_decide  — decide what to do with a timed-out background job
 *
 * Also registers keyboard shortcuts and slash commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BackgroundRegistry } from "./state.ts";
import {
    cleanupStaleRuntimeArtifacts,
    detectNonInteractive,
    monitorRevivedJobs,
    reviveAndValidate,
    startBackgroundJob,
    terminateJobSilently,
} from "./lifecycle.ts";
import { forget as forgetJob, renderSidebar, stopSidebarTicker, computeStatus, add, createRunningJob, nextJobId, atConcurrencyLimit } from "./registry.ts";
import { cancelFinishedFlush, enqueueFinished } from "./notify.ts";
import {
    EVENT,
    PERSISTED_STATE_SCHEMA_VERSION,
    type AdoptJobRequest,
    type Job,
    type UiContext,
} from "./types.ts";
import { registerBgRunTool } from "./tools/bg-run.ts";
import { registerBgJobsTool } from "./tools/jobs.ts";
import { registerBgDecideTool } from "./tools/bg-decide.ts";
import { registerForegroundGuard, parseDurationSeconds, compileAllow } from "./guard.ts";
import { registerShortcuts } from "./shortcuts.ts";
import { registerCommands } from "./commands.ts";

/** Read bgJobs settings from pi settings files directly (ctx.settings not exposed to extensions). */
function loadBgJobsSettings(cwd: string): Record<string, unknown> {
    const merge = (a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b });
    const read = (path: string): Record<string, unknown> => {
        try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
    };
    const globalSettings = read(join(getAgentDir(), "settings.json"));
    const projectSettings = read(join(cwd, CONFIG_DIR_NAME, "settings.json"));
    const merged = merge(globalSettings, projectSettings);
    return (merged.bgJobs ?? {}) as Record<string, unknown>;
}

interface PersistedState {
    schemaVersion?: number;
    jobs?: Array<[string, Omit<Job, "proc" | "donePromise" | "resolveDone">]>;
    jobCounter?: number;
}

/** Extension entry point. */
export default function (pi: ExtensionAPI): void {
    const reg = new BackgroundRegistry();

    // Publish live job status on the shared event bus for other extensions
    // (e.g. ralph-loop) — see registry.ts renderSidebar().
    reg.emitStatus = (status) => {
        try {
            pi.events.emit("bg-jobs:status", status);
        } catch {
            /* bus unavailable */
        }
    };

    // On-demand snapshot: peers that subscribe to "bg-jobs:status" after a
    // reload/revive may have missed change events; emit current status on
    // request. Subscriptions are tracked per extension instance and torn
    // down on dispose, so re-registration across reloads is clean.
    pi.events.on("bg-jobs:status-request", () => {
        reg.emitStatus?.(computeStatus(reg));
    });

    // Mirror the sudo-grant extension's state (see spawn.ts ttyPreserve).
    try {
        pi.events.on("sudo-grant:state", (s: unknown) => {
            const st = s as { active?: boolean; shimDir?: string } | undefined;
            reg.sudoGrantActive = st?.active === true;
            reg.sudoShimDir = typeof st?.shimDir === "string" ? st.shimDir : undefined;
        });
    } catch {
        /* bus unavailable */
    }

    // ── External-job adoption (pi-subagent background mode, etc.) ────
    // A peer extension that spawns its own long-lived child can hand it to
    // bg-jobs for lifecycle management: it appears in bg_jobs list/kill, the
    // sidebar, and the "bg-jobs:status" snapshot (so ralph-loop waits on it).
    // The adopter owns spawning and the log file; we only track + signal.
    let lastUiCtx: UiContext | undefined;
    pi.events.on(EVENT.adopt, (raw: unknown) => {
        const req = raw as AdoptJobRequest | undefined;
        if (!req || typeof req.command !== "string" || !req.logPath || !req.exit) {
            req?.reply?.({ ok: false, error: "invalid adopt request" });
            return;
        }
        if (!lastUiCtx) {
            req?.reply?.({ ok: false, error: "bg-jobs session not started" });
            return;
        }
        if (atConcurrencyLimit(reg)) {
            req?.reply?.({ ok: false, error: "concurrency limit reached" });
            return;
        }
        try {
            const id = nextJobId(reg);
            const job = createRunningJob({
                id,
                command: req.command,
                pid: req.pid,
                logPath: req.logPath,
                toolCallId: "external",
                name: req.name,
            });
            if (req.proc) job.proc = req.proc;
            add(reg, job);
            startBackgroundJob({
                reg,
                pi,
                ctx: lastUiCtx,
                job,
                exit: req.exit,
                shouldNotify: req.silent !== true,
                disablePromptStall: req.disablePromptStall,
                onExit: req.onExit,
            });
            req.reply?.({ ok: true, id });
        } catch (err) {
            req.reply?.({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    });

    // ── Tool registration (deferred to session_start for settings) ──
    registerBgJobsTool(pi, reg);

    // ── Shortcuts / commands ──────────────────────────────────────
    registerShortcuts(pi, reg);
    registerCommands(pi, reg);
    registerForegroundGuard(pi, reg);

    // ── Session start ─────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        lastUiCtx = ctx as unknown as UiContext;
        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );

        // Subscribe to live sudo-grant state, then request the current
        // snapshot (events emitted before this subscription would be missed).
        try {
            pi.events.emit("sudo-grant:state-request", undefined);
        } catch {
            /* bus unavailable */
        }

        // Load user settings (ctx.settings not exposed to extensions — read files directly)
        const s = loadBgJobsSettings(ctx.cwd);
        if (s?.notifyMode === "steer" || s?.notifyMode === "followUp") reg.notifyMode = s.notifyMode as string;
        if (typeof s?.triggerTurn === "boolean") reg.triggerTurn = s.triggerTurn as boolean;
        if (typeof s?.timeout === "number" && (s.timeout as number) > 0) reg.timeout = s.timeout as number;
        else if (s?.timeout === null || s?.timeout === 0) reg.timeout = null;
        if (typeof s?.maxConcurrent === "number" && (s.maxConcurrent as number) > 0) reg.maxConcurrent = s.maxConcurrent as number;
        if (typeof s?.widgetEnabled === "boolean") reg.widgetEnabled = s.widgetEnabled as boolean;
        if (typeof s?.coalesceMs === "number" && (s.coalesceMs as number) >= 0) reg.coalesceMs = s.coalesceMs as number;
        if (typeof s?.outputPreviewChars === "number" && (s.outputPreviewChars as number) > 0) reg.outputPreviewChars = s.outputPreviewChars as number;
        if (typeof s?.logDir === "string" && (s.logDir as string).length > 0) reg.logDir = s.logDir as string;
        if (typeof s?.stallThresholdMs === "number" && (s.stallThresholdMs as number) > 0) reg.stallThresholdMs = s.stallThresholdMs as number;
        if (typeof s?.maxLogBytes === "number" && (s.maxLogBytes as number) > 0) reg.maxLogBytes = s.maxLogBytes as number;
        if (typeof s?.killOnShutdown === "boolean") reg.killOnShutdown = s.killOnShutdown as boolean;
        if (typeof s?.attachWait === "boolean") reg.attachWait = s.attachWait as boolean;
        if (typeof s?.foregroundGuard === "boolean") reg.foregroundGuard = s.foregroundGuard as boolean;
        if (s?.maxForeground !== undefined) {
            try { reg.maxForegroundSec = parseDurationSeconds(s.maxForeground); }
            catch (err) { ctx.ui.notify(String(err), "error"); }
        } else if (typeof s?.maxForegroundSec === "number" && s.maxForegroundSec >= 0) {
            reg.maxForegroundSec = Math.floor(s.maxForegroundSec);
        }
        if (Array.isArray(s?.foregroundAllow)) {
            reg.foregroundAllow = (s.foregroundAllow as unknown[]).filter((r): r is string => typeof r === "string");
            reg.foregroundAllowRe = compileAllow(reg.foregroundAllow);
        }
        if (typeof s?.fgGuardNoTimeout === "string") reg.fgGuardNoTimeout = s.fgGuardNoTimeout as string;
        if (typeof s?.fgGuardTooLong === "string") reg.fgGuardTooLong = s.fgGuardTooLong as string;
        if (typeof s?.blockSleepWhileBusy === "boolean") reg.fgGuardBlockSleepWhileBusy = s.blockSleepWhileBusy as boolean;
        if (s?.sleepMatch === "prefix" || s?.sleepMatch === "anywhere") reg.fgGuardSleepMatch = s.sleepMatch;
        if (typeof s?.sleepRejection === "string") reg.fgGuardSleepRejection = s.sleepRejection as string;
        if (typeof s?.disableTimeoutArg === "boolean") reg.disableTimeoutArg = s.disableTimeoutArg as boolean;
        if (reg.disableTimeoutArg) reg.timeout = null; // no timeout when arg is disabled

        // Register tools now that settings are loaded
        registerBgRunTool(pi, reg, reg.disableTimeoutArg);
        registerBgDecideTool(pi, reg, reg.disableTimeoutArg);

        // Restore serialized background job state.
        const entries = ctx.sessionManager.getEntries();
        const stateEntries = entries.filter(
            (e) =>
                e.type === "custom" &&
                (e as { customType?: string }).customType === EVENT.state
        ) as Array<{ type: "custom"; customType: string; data: unknown }>;

        const latest = [...stateEntries]
            .reverse()
            .map((e) => e.data as PersistedState)
            .find((d) => d.schemaVersion === PERSISTED_STATE_SCHEMA_VERSION);

        if (latest) {
            const isReload = entries.length > 0;
            if (latest.jobs) {
                for (const [id, job] of latest.jobs) {
                    const wasRunning = job.status === "running";
                    reviveAndValidate(reg, job, isReload);
                    reg.jobs.set(id, job);
                    // Notify about jobs that completed while pi was closed
                    if (wasRunning && job.status !== "running") {
                        enqueueFinished(reg, pi, ctx, job);
                    }
                }
                // Restart widget ticker for revived running jobs
                renderSidebar(reg, ctx);

                // Monitor revived jobs for completion
                if (reg.jobs.size > 0) {
                    const cancelMon = monitorRevivedJobs(reg, pi, ctx);
                    pi.on('session_shutdown', () => cancelMon());
                }
            }
            if (typeof latest.jobCounter === "number") {
                reg.counter = Math.max(reg.counter, latest.jobCounter);
            }
        }

        void cleanupStaleRuntimeArtifacts(reg.logDir);
    });

    // ── Session shutdown ──────────────────────────────────────────
    pi.on("session_shutdown", async (event, _ctx) => {
        stopSidebarTicker(reg);
        cancelFinishedFlush(reg);

        if (reg.killOnShutdown) {
            for (const job of reg.jobs.values()) {
                if (job.status === "running") {
                    terminateJobSilently(reg, job);
                }
            }
        }

        pi.appendEntry(EVENT.state, {
            schemaVersion: PERSISTED_STATE_SCHEMA_VERSION,
            jobs: Array.from(reg.jobs.entries()).map(([id, job]) => [
                id,
                {
                    ...job,
                    proc: undefined,
                    donePromise: undefined,
                    resolveDone: undefined,
                },
            ]),
            jobCounter: reg.counter,
        });
    });
}
