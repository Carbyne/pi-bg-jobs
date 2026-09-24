/**
 * `bg_jobs` tool — manage background jobs.
 *
 * Actions:
 *   - list: show all jobs (running + recently terminal)
 *   - output: read a job's log tail (non-blocking peek)
 *   - kill: terminate a job
 *   - attach: follow a job's live output and wait for it to finish
 *   - search: regex-search all job output
 *   - cleanup: purge terminal jobs
 *   - stats: aggregate metrics
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    PREVIEW_CHARS,
    type UiContext,
} from "../types.ts";
import { processExists } from "../spawn.ts";
import {
    cleanupTerminal,
    findJob,
    getStats,
    readLogTail,
    renderSidebar,
} from "../registry.ts";
import { formatDuration, formatJobLine, jobLabel, textBlock } from "../format.ts";
import { streamLog } from "../output.ts";
import { searchLogs } from "../log-search.ts";
import {
    ensureCompletionPromise,
    markTerminal,
    terminateJobSilently,
} from "../lifecycle.ts";

/** `bg_jobs` tool registration. */
export function registerBgJobsTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerTool({
        name: "bg_jobs",
        label: "Background Jobs",
        description:
            "Manage background jobs: list, output, kill, attach, search, cleanup, and stats.",
        promptSnippet: "Inspect and manage background jobs",
        promptGuidelines: [
            "list: show all jobs (running + recent terminal)",
            "output: show the log tail for one job — use for a quick non-blocking peek, not polling.",
            "kill: terminate a job",
            "attach: snapshot a job's live output. By default it does NOT block waiting for completion (you are notified automatically when a job finishes); blocking wait is only enabled when bgJobs.attachWait is true in settings.json.",
            "search: regex-search all job output",
            "cleanup: purge terminal jobs",
            "stats: show aggregate metrics",
        ],
        parameters: Type.Object({
            action: StringEnum(
                [
                    "list",
                    "output",
                    "kill",
                    "attach",
                    "search",
                    "cleanup",
                    "stats",
                ] as const,
                { description: "Action to perform" }
            ),
            jobId: Type.Optional(Type.String({ description: "Job ID" })),
            pattern: Type.Optional(
                Type.String({ description: "Regex pattern for search" })
            ),
            wait: Type.Optional(
                Type.Boolean({
                    description: "Whether attach should wait for completion. Only honored when bgJobs.attachWait is enabled in settings; otherwise attach returns immediately.",
                })
            ),
        }),

        async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<undefined>> {
            const p = params as {
                action: "list" | "output" | "kill" | "attach" | "search" | "cleanup" | "stats";
                jobId?: string;
                pattern?: string;
                wait?: boolean;
            };
            switch (p.action) {
                case "list":
                    return listAction(reg);
                case "output":
                    return await outputAction(reg, p.jobId!);
                case "kill":
                    return await killAction(reg, p.jobId!, ctx);
                case "attach":
                    return await attachAction(reg, p.jobId!, p.wait ?? true, signal, onUpdate, ctx);
                case "search":
                    return await searchAction(reg, p.pattern ?? "");
                case "cleanup":
                    return cleanupAction(reg, ctx);
                case "stats":
                    return statsAction(reg);
            }
        },
    });
}

// ─── list: 모든 잡 나열 ──────────────────────────────────────────────────────────────────────

function listAction(reg: BackgroundRegistry): AgentToolResult<undefined> {
    const running = Array.from(reg.jobs.values()).filter(
        (j) => j.status === "running"
    );
    const recent = reg.recentTerminal.slice(-5).reverse();
    const lines = [
        ...running.map((j) => formatJobLine(j)),
        ...recent.map((j) => formatJobLine(j)),
    ];
    return {
        content: [
            textBlock(
                lines.length > 0
                    ? `Background Jobs:\n${lines.join("\n")}`
                    : "No background jobs"
            ),
        ],
        details: undefined,
    };
}

// ─── output: 특정 잡의 출력 꼬리 읽기 ────────────────────────────────────────────────────────

async function outputAction(
    reg: BackgroundRegistry,
    jobId: string
): Promise<AgentToolResult<undefined>> {
    const job = findJob(reg, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const out = readLogTail(job, reg.outputPreviewChars).trimEnd();
    const label = jobLabel(job);
    return {
        content: [
            textBlock(
                out
                    ? `Output for ${label} (${job.status})\n${out}`
                    : `No output yet for ${label} (${job.status}). Log: ${job.logPath}`
            ),
        ],
        details: undefined,
    };
}

// ─── kill: 특정 잡 종료 ─────────────────────────────────────────────────────────────────────────────

async function killAction(
    reg: BackgroundRegistry,
    jobId: string,
    ctx: UiContext
): Promise<AgentToolResult<undefined>> {
    const job = findJob(reg, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.status !== "running") {
        throw new Error(`Job is not running: ${job.id}`);
    }
    terminateJobSilently(reg, job);
    renderSidebar(reg, ctx);
    const isWsMonitor = job.kind === "monitor" && job.pid <= 0;
    return {
        content: [
            textBlock(
                isWsMonitor
                    ? `Closed monitor ${jobLabel(job)}`
                    : `Sent SIGTERM to ${jobLabel(job)} (process group)`
            ),
        ],
        details: undefined,
    };
}

// ─── attach: 완료까지 대기 후 출력 ─────────────────────────────────────────────────────────────────

async function attachAction(
    reg: BackgroundRegistry,
    jobId: string,
    waitForCompletion: boolean,
    signal: AbortSignal | undefined,
    onUpdate: ((u: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void) | undefined,
    ctx: UiContext
): Promise<AgentToolResult<undefined>> {
    const job = findJob(reg, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const label = jobLabel(job);

    const skipWait =
        reg.pendingDecisionJobId === job.id && job.status === "running";
    const effectiveWait = waitForCompletion && reg.attachWait;

    // Blocking wait disabled (default): return an immediate snapshot instead.
    // Do NOT consume the job's completion notice — bg-jobs will wake the
    // agent itself when the job finishes.
    if (job.status === "running" && !effectiveWait && !skipWait) {
        return {
            content: [
                textBlock(
                    `${label} is still running. Live-output wait is disabled (bgJobs.attachWait setting); ` +
                        `you will be notified automatically when it finishes. Use bg_jobs action='output' for a log peek.`
                ),
            ],
            details: undefined,
        };
    }

    // Suppress the separate completion notice so the attach result is the
    // single notification. Set immediately (before any await) so even a
    // pre-completed job's .then() callback sees it. Reset on abort (if still
    // running) and after delivering the result.
    job.outputConsumed = true;

    if (job.status === "running" && effectiveWait && !skipWait) {
        ensureCompletionPromise(job);

        // Bail early if the OS process already died.
        if (job.pid > 0 && !processExists(job.pid)) {
            markTerminal(job, "failed");
        }

        onUpdate?.({
            content: [
                textBlock(`Following ${label} live output — waiting for it to finish…`),
            ],
            details: undefined,
        });

        // Stream the live log tail while we wait, so "attach" shows progress
        // instead of sitting silent.
        const poller = streamLog(job.logPath, onUpdate);
        let onAbort: (() => void) | undefined;
        try {
            if (signal && !signal.aborted) {
                const abortPromise = new Promise<void>((resolve) => {
                    onAbort = resolve;
                    signal.addEventListener("abort", onAbort, { once: true });
                });
                await Promise.race([job.donePromise, abortPromise]);
            } else {
                await job.donePromise;
            }
        } finally {
            poller.stop();
            if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        }

        if (job.status === "running") {
            // Aborted before completion — we never reported the finish, so let
            // the job's own completion notice fire later.
            job.outputConsumed = false;
            return {
                content: [
                    textBlock(
                        `Stopped following ${label} — it's still running in the background. Use jobs output to check on it.`
                    ),
                ],
                details: undefined,
            };
        }
    }

    const message = `${label} finished. Status: ${job.status}`;
    job.outputConsumed = false; // delivered — allow future notifications
    ctx.ui.notify(message, job.status === "failed" ? "error" : "info");
    return {
        content: [textBlock(`${message}. Use jobs output for the full log.`)],
        details: undefined,
    };
}

// ─── search (v0.2 신규) ─────────────────────────────────────────────

const SEARCH_DISPLAY_LIMIT_PER_JOB = 20;

async function searchAction(
    reg: BackgroundRegistry,
    pattern: string
): Promise<AgentToolResult<undefined>> {
    if (!pattern) throw new Error("search action requires a pattern");

    let re: RegExp;
    try {
        re = new RegExp(pattern);
    } catch (err) {
        throw new Error(`Invalid regex: ${(err as Error).message}`);
    }

    const result = await searchLogs({
        jobs: [...Array.from(reg.jobs.values()), ...reg.recentTerminal],
        pattern: re,
        maxHitsPerJob: SEARCH_DISPLAY_LIMIT_PER_JOB,
        maxLineChars: PREVIEW_CHARS.line,
    });

    if (result.totalHits === 0) {
        return {
            content: [textBlock(`No matches for /${pattern}/ in any job log.`)],
            details: undefined,
        };
    }

    const blocks = result.groups.map((group) => {
        const headLabel = group.name ? `${group.name} (${group.jobId})` : group.jobId;
        const body = group.hits
            .map((h) => `  ${h.path}:${h.line}: ${h.text}`)
            .join("\n");
        const more = group.count > group.hits.length
            ? `\n  ... and ${group.count - group.hits.length} more`
            : "";
        return `${headLabel} (${group.count} matches)\n${body}${more}`;
    });

    return {
        content: [
            textBlock(
                `Found ${result.totalHits} matches for /${pattern}/ across ${result.groups.length} job(s):\n\n${blocks.join("\n\n")}`
            ),
        ],
        details: undefined,
    };
}

// ─── cleanup (v0.2 신규) ────────────────────────────────────────────

function cleanupAction(
    reg: BackgroundRegistry,
    ctx: UiContext
): AgentToolResult<undefined> {
    const { purged, bytesReclaimed } = cleanupTerminal(reg);
    renderSidebar(reg, ctx);
    const kb = Math.round(bytesReclaimed / 1024);
    return {
        content: [
            textBlock(
                `Cleaned up ${purged} terminal job(s). Reclaimed ${kb} KiB of disk.`
            ),
        ],
        details: undefined,
    };
}

// ─── stats (v0.2 신규) ──────────────────────────────────────────────

function statsAction(reg: BackgroundRegistry): AgentToolResult<undefined> {
    const s = getStats(reg);
    const lines = [
        `Total started:   ${s.totalStarted}`,
        `Currently running: ${s.running}`,
        `Completed:        ${s.completed}`,
        `Failed:           ${s.failed}`,
        `Killed:           ${s.killed}`,
        `Recent terminal:  ${s.recentTerminal}`,
        `Average duration: ${formatDuration(s.averageDurationMs)}`,
        `Total CPU time:   ${formatDuration(s.totalDurationMs)}`,
    ];
    return {
        content: [textBlock("Background Jobs Stats:\n" + lines.join("\n"))],
        details: undefined,
    };
}
