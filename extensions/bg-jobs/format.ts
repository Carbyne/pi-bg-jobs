/**
 * Formatting helpers — duration strings, status pills, output tails.
 */

import type { Job } from "./types.ts";
import { PREVIEW_CHARS } from "./types.ts";

/** The standard short label for a job: its name, or its id when unnamed. */
export function jobLabel(job: Job): string {
    return job.name ?? job.id;
}

/** "1m23s" / "45s" / "0s" — short human-readable duration. */
export function formatDuration(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

/** Human-readable status pill, including duration for running jobs. */
export function statusLabel(job: Job, duration?: string): string {
    const dur = duration ?? formatDuration(Date.now() - job.startTime);
    switch (job.status) {
        case "running":
            if (job.kind === "monitor") return `◉ monitor (${dur})`;
            return job.isBackgrounded ? `▶ bg (${dur})` : `▶ fg (${dur})`;
        case "completed":
            return "✓ completed";
        case "failed":
            return "✗ failed";
        case "killed":
            return "✗ killed";
    }
}

/** "job-123-5: ls -la (last 80 chars)" — single line for `jobs list`. */
export function formatJobLine(job: Job): string {
    const head = job.name ? `${job.name} (${job.id})` : job.id;
    const duration =
        job.status === "running"
            ? ` (${formatDuration(Date.now() - job.startTime)})`
            : "";
    return `${head}: ${job.command.slice(0, PREVIEW_CHARS.line)} - ${statusLabel(job)}${duration}`;
}

/** Truncate a tail with a consistent "showing last N chars" marker. */
export function truncateTail(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return `...[truncated, showing last ${maxChars} chars]\n${content.slice(-maxChars)}`;
}

/** Text content block builder — shared across all tools. */
export function textBlock(s: string): { type: "text"; text: string } {
    return { type: "text" as const, text: s };
}
