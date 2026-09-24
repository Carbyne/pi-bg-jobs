/**
 * `bg_decide` tool — decide what to do with a timed-out background job.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import { findJob, readLogTail, renderSidebar } from "../registry.ts";
import { terminateJobSilently } from "../lifecycle.ts";
import { jobLabel, textBlock } from "../format.ts";

export function registerBgDecideTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry,
    _disableTimeout: boolean
): void {
    if (_disableTimeout) return;
    pi.registerTool({
        name: "bg_decide",
        label: "Job Decision",
        description: "Decide whether to keep, kill, or check a timed-out background job. Called when bg_run exceeds its timeout.",
        promptSnippet: "Decide what to do with a timed-out background job",
        promptGuidelines: [
            "Use bg_decide with decision 'keep' to let the job continue running.",
            "Use bg_decide with decision 'kill' to terminate the job.",
            "Use bg_decide with decision 'check' to inspect current output before deciding.",
        ],
        parameters: Type.Object({
            jobId: Type.String({ description: "Job ID to decide on" }),
            decision: StringEnum(["keep", "kill", "check"] as const, {
                description: "keep = continue, kill = terminate, check = inspect output",
            }),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as { jobId: string; decision: "keep" | "kill" | "check" };
            const job = findJob(reg, p.jobId);
            if (!job) {
                reg.pendingDecisionJobId = undefined;
                return {
                    content: [textBlock(`Job ${p.jobId} not found.`)],
                    details: undefined,
                };
            }

            switch (p.decision) {
                case "kill": {
                    terminateJobSilently(reg, job);
                    renderSidebar(reg, ctx);
                    return {
                        content: [textBlock(`Killed ${jobLabel(job)}.`)],
                        details: undefined,
                    };
                }
                case "keep": {
                    reg.pendingDecisionJobId = undefined;
                    return {
                        content: [textBlock(
                            `Keeping ${jobLabel(job)} running. Use bg_jobs to check on it later.`
                        )],
                        details: undefined,
                    };
                }
                case "check": {
                    const out = readLogTail(job, reg.outputPreviewChars);
                    return {
                        content: [textBlock(`Output of ${jobLabel(job)}:\n${out}`)],
                        details: undefined,
                    };
                }
            }
        },
    });
}
