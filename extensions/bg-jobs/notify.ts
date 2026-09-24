/**
 * Coalesced completion notices for background jobs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EVENT, type Job, type UiContext } from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { LOG_DIR } from "./registry.ts";
import { formatDuration } from "./format.ts";

export function enqueueFinished(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    job: Job
): void {
    if (job.outputConsumed) return;
    job.endedAt ??= Date.now();
    reg.pendingFinished.push(job);
    if (reg.finishedFlushTimer) return;
    const timer = setTimeout(() => flushFinished(reg, pi, ctx), reg.coalesceMs);
    (timer as NodeJS.Timeout).unref();
    reg.finishedFlushTimer = timer;
}

export function flushFinished(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    if (reg.finishedFlushTimer) {
        clearTimeout(reg.finishedFlushTimer);
        reg.finishedFlushTimer = undefined;
    }
    const jobs = reg.pendingFinished;
    if (jobs.length === 0) return;
    reg.pendingFinished = [];

    const { content, level } = jobs.length === 1 ? formatSingle(jobs[0]) : formatBatch(jobs);

    const deliverAs = reg.notifyMode;

    try {
        ctx.ui.notify(content, level);
        pi.sendMessage(
            {
                customType: EVENT.jobFinished,
                content,
                display: true,
                details: {
                    count: jobs.length,
                    jobs: jobs.map((j) => ({
                        jobId: j.id,
                        status: j.status,
                        exitCode: j.exitCode,
                        command: j.command,
                        logPath: j.logPath,
                    })),
                },
            },
            { deliverAs, triggerTurn: reg.triggerTurn }
        );
    } catch {
        /* stale ctx after a session switch */
    }
}

export function cancelFinishedFlush(reg: BackgroundRegistry): void {
    if (reg.finishedFlushTimer) {
        clearTimeout(reg.finishedFlushTimer);
        reg.finishedFlushTimer = undefined;
    }
    reg.pendingFinished = [];
}

// --- Formatting ----------------------------------------------------------

type Notice = { content: string; level: "info" | "error" };

function formatSingle(job: Job): Notice {
    const duration = formatDuration((job.endedAt ?? Date.now()) - job.startTime);
    const label = job.name ? `"${job.name}"` : `"${job.command.slice(0, 60)}"`;
    const exitText =
        job.exitCode !== undefined && job.exitCode !== 0 ? ` (exit ${job.exitCode})` : "";
    const statusText =
        job.status === "completed"
            ? `bg_run ${label} completed in ${duration}`
            : `bg_run ${label} ${job.status} in ${duration}${exitText}`;
    const onDoneText = job.onDone ? `\n\nNext: ${job.onDone}` : "";
    return {
        content: `${statusText} · ${job.id} · output: ${job.logPath}${onDoneText}`,
        level: job.status === "completed" ? "info" : "error",
    };
}

function formatBatch(jobs: Job[]): Notice {
    const completed = jobs.filter((j) => j.status === "completed");
    const failed = jobs.filter((j) => j.status !== "completed");

    const parts: string[] = [];
    if (completed.length > 0) {
        parts.push(`${completed.length} completed (${completed.map((j) => j.id).join(", ")})`);
    }
    if (failed.length > 0) {
        const ids = failed
            .map((j) => (j.exitCode !== undefined && j.exitCode !== 0 ? `${j.id} exit ${j.exitCode}` : j.id))
            .join(", ");
        parts.push(`${failed.length} failed (${ids})`);
    }
    return {
        content: `${jobs.length} background jobs finished — ${parts.join(", ")}. Outputs in ${LOG_DIR}/`,
        level: failed.length > 0 ? "error" : "info",
    };
}
