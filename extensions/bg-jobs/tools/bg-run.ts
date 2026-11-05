/**
 * `bg_run` tool — start a bash command in the background immediately.
 *
 * Faithful mirror of stock pi bash (via createBashToolDefinition), with added
 * background spawning and job lifecycle management. Unlike a bash override,
 * this is a separate tool so it can coexist with any other bash override.
 */

import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createBashToolDefinition,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    type UiContext,
} from "../types.ts";
import { spawnWithFileOutput, killProcessTree, processExists } from "../spawn.ts";
import { streamLog } from "../output.ts";
import {
    add,
    createRunningJob,
    nextJobId,
    logPathFor, resultPathFor,
    readLogTail,
} from "../registry.ts";
import {
    assertJobSlot,
    isSignalExit,
    requestJobDecision,
    requireExistingCwd,
    startBackgroundJob,
} from "../lifecycle.ts";
import { textBlock, jobLabel } from "../format.ts";

type BashCtx = UiContext & { cwd: string };

export function buildBgRunSchema(disableTimeout: boolean) {
    if (disableTimeout) {
        return Type.Object({
            command: Type.String({ description: "Shell command to run in background" }),
            name: Type.Optional(Type.String({ description: "Human-readable label shown in status widget" })),
            onDone: Type.Optional(Type.String({ description: "Prompt appended to the completion notification — tells the agent what to do when this job finishes" })),
        });
    }
    return Type.Object({
        command: Type.String({ description: "Shell command to run in background" }),
        name: Type.Optional(Type.String({ description: "Human-readable label shown in status widget" })),
        timeout: Type.Optional(Type.Number({ description: "Auto-kill after N seconds" })),
        onDone: Type.Optional(Type.String({ description: "Prompt appended to the completion notification — tells the agent what to do when this job finishes" })),
    });
}

export function registerBgRunTool(pi: ExtensionAPI, reg: BackgroundRegistry, disableTimeout: boolean): void {
    pi.registerTool({
        name: "bg_run",
        label: "Background Run",
        description: disableTimeout
            ? [
                "Run a shell command in the background. This is a faithful mirror of the bash tool — same command execution, same output handling, same error reporting.",
                "Unlike bash, bg_run returns immediately. You will be automatically notified when the command completes — no polling needed. Use bg_jobs to check status, read output, or kill running jobs.",
                "When the command finishes, you'll be automatically notified with the exit code, duration, and log path.",
            ].join("\n\n")
            : [
                "Run a shell command in the background. This is a faithful mirror of the bash tool — same command execution, same output handling, same error reporting.",
                "Unlike bash, bg_run returns immediately. You will be automatically notified when the command completes — no polling needed. Use bg_jobs to check status, read output, or kill running jobs.",
                "When the command finishes, you'll be automatically notified with the exit code, duration, and log path.",
                "If `timeout` is provided and the command exceeds it, you'll be prompted to decide: keep running, kill, or check output first (use bg_decide).",
            ].join("\n\n"),
        promptSnippet: "Run shell commands in background with automatic completion notification",
        promptGuidelines: [
            "Use bg_run for any command expected to run longer than a few seconds — training, building, testing, experiments.",
            "IMPORTANT: You will be automatically woken up when the job completes. Do NOT poll, sleep, or wait-loop to check on it. Launch the job and move on to other work.",
            "Use bg_jobs action='output' for a non-blocking peek at job output if you want a quick check.",
            "Use bg_jobs action='attach' for a live-output snapshot; it returns immediately and does not block. You will be notified when the job completes.",
            ...(disableTimeout ? [] : ["Use bg_decide when a timed-out job needs a keep/kill/check decision."]),
        ],
        parameters: buildBgRunSchema(disableTimeout),

        async execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx
        ): Promise<AgentToolResult<BashToolDetails | undefined>> {
            const p = params as {
                command: string;
                name?: string;
                timeout?: number;
                onDone?: string;
            };
            const bashCtx = ctx as BashCtx;

            if (!p.command?.trim()) throw new Error("Command is empty.");
            requireExistingCwd(bashCtx.cwd);

            assertJobSlot(reg);

            const id = nextJobId(reg);
            const logPath = logPathFor(id, reg.logDir);
            const spawned = spawnWithFileOutput({
                resultPath: resultPathFor(id, reg.logDir),
                command: p.command,
                cwd: bashCtx.cwd,
                logPath,
                // Active sudo grant → keep the controlling tty so `sudo` in
                // the command hits the tty-keyed credential cache (mirrors
                // the bash tool while granted); fail-fast shim via PATH.
                ttyPreserve: reg.sudoGrantActive,
                sudoShimDir: reg.sudoShimDir,
            });

            const job = createRunningJob({
                id,
                name: p.name,
                command: p.command,
                pid: spawned.pid,
                logPath,
                toolCallId,
            });
            job.onDone = p.onDone || undefined;
            add(reg, job);

            const jobAc = startBackgroundJob({
                reg, pi, ctx: bashCtx, job, exit: spawned.exit,
                shouldNotify: true,
            });

            // Apply default timeout from settings if not specified.
            const effectiveTimeout = p.timeout ?? reg.timeout;

            // Optional timeout — route into the decision flow.
            if (effectiveTimeout && !reg.nonInteractive) {
                const timer = setTimeout(() => {
                    if (job.status !== "running") return;
                    requestJobDecision({ reg, pi, ctx: bashCtx, job, timeoutMs: effectiveTimeout * 1000 });
                }, effectiveTimeout * 1000);
                (timer as NodeJS.Timeout).unref();
                jobAc.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
            }

return {
                content: [textBlock(
                    `$ ${p.command}${p.name ? `  # ${p.name}` : ""}\nCommand running in background — ID: ${id}\nOutput: ${logPath}` +
                    (p.onDone ? `\nOn completion: ${p.onDone}` : "")
                )],
                details: undefined,
            };
        },
    });
}
