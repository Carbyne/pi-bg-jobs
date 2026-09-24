// src/output.ts
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { FOREGROUND_TAIL_BYTES } from "./types.ts";

/**
 * Read the tail of a log file, bounded by maxChars. Only the last maxChars
 * bytes are read (O(maxChars), not O(fileSize)). Opens once and fstats the
 * descriptor — no separate path-stat, so no stat-then-read race.
 */
export function readBoundedTail(logPath: string, maxChars: number): string {
    let fd: number;
    try {
        fd = openSync(logPath, "r");
    } catch {
        return "(no output yet)";
    }
    try {
        const { size } = fstatSync(fd);
        if (size === 0) return "(no output yet)";
        const toRead = Math.min(size, maxChars);
        const buf = Buffer.alloc(toRead);
        readSync(fd, buf, 0, toRead, Math.max(0, size - toRead));
        const body = buf.toString("utf-8");
        return size > maxChars
            ? `...[truncated, showing last ${maxChars} chars]\n${body}`
            : body;
    } catch {
        return "(no output yet)";
    } finally {
        closeSync(fd);
    }
}

/**
 * Poll a log file tail at `intervalMs` (default 1000ms). Calls `onUpdate`
 * only when content changes. Returns a handle with `stop()`.
 *
 * This is the Claude Code pattern: the file is written to by the child
 * process via file descriptor. We poll the tail for progress display.
 */
export function pollFileTail(
    logPath: string,
    onUpdate: (text: string) => void,
    intervalMs = 1_000
): { stop: () => void } {
    let lastSize = 0;
    let lastContent = "";
    let stopped = false;

    const timer = setTimeout(function tick() {
        if (stopped) return;
        try {
            const { size } = statSync(logPath);
            if (size === lastSize) {
                timer.refresh();
                return;
            }
            lastSize = size;
            const fd = openSync(logPath, "r");
            try {
                const readStart = Math.max(0, size - FOREGROUND_TAIL_BYTES);
                const toRead = Math.min(size, FOREGROUND_TAIL_BYTES);
                const buf = Buffer.alloc(toRead);
                readSync(fd, buf, 0, toRead, readStart);
                const content = buf.toString("utf-8", 0, toRead);
                if (content && content !== lastContent) {
                    lastContent = content;
                    onUpdate(content);
                }
            } finally {
                closeSync(fd);
            }
        } catch {
            // File not yet created or locked — retry next tick.
        }
        if (!stopped) timer.refresh();
    }, intervalMs);
    (timer as NodeJS.Timeout).unref();

    return {
        stop() {
            stopped = true;
            clearTimeout(timer);
        },
    };
}

/** A tool's streaming-update callback (text-only partial results). */
export type ToolTextUpdate = (update: {
    content: { type: "text"; text: string }[];
    details: undefined;
}) => void;

/**
 * Stream a log file's live tail into a tool's onUpdate callback — the shared
 * "show live output while a job runs" mechanic used by bash, agent_bg, and the
 * jobs attach action. Returns the poller's stop handle.
 */
export function streamLog(
    logPath: string,
    onUpdate: ToolTextUpdate | undefined
): { stop: () => void } {
    return pollFileTail(logPath, (text) => {
        onUpdate?.({ content: [{ type: "text", text }], details: undefined });
    });
}
