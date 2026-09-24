/**
 * Type definitions and shared constants for the bg-jobs extension.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const PERSISTED_STATE_SCHEMA_VERSION = 1;

// --- Configuration constants ---
export const STALL_TAIL_BYTES = 1024;
export const FOREGROUND_TAIL_BYTES = 4096;
export const RECENT_TERMINAL_KEEP = 20;

export const PREVIEW_CHARS = {
    sidebar: 25,
    taskList: 40,
    detail: 50,
    line: 80,
} as const;

// --- Domain types ---
export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface Job {
    id: string;
    name?: string;
    command: string;
    pid: number;
    startTime: number;
    status: JobStatus;
    exitCode?: number;
    logPath: string;
    proc?: ChildProcess;
    toolCallId: string;
    donePromise?: Promise<void>;
    resolveDone?: () => void;
    outputConsumed?: boolean;
    isBackgrounded: boolean;
    /** Optional prompt appended to the completion notification. */
    onDone?: string;
    /** Wall-clock finish time, stamped when queued for a completion notice. */
    endedAt?: number;
}

// --- Event types ---
export const EVENT = {
    state: "bg-jobs-state",
    stall: "bg-stall",
    timeout: "bg-timeout",
    jobFinished: "bg-job-finished",
    status: "bg-jobs:status",
} as const;

/** Live job-status snapshot published on the shared pi.events bus. */
export interface RunningJobInfo {
    id: string;
    name?: string;
    command: string;
    startTime: number;
}

export interface BgJobsStatus {
    running: number;
    /** Start time of the oldest running job (for age checks). */
    oldestStartTime?: number;
    jobs: RunningJobInfo[];
}

export type EventName = (typeof EVENT)[keyof typeof EVENT];

// --- UI context ---
export interface UiContext {
    ui: {
        notify(message: string, level?: "info" | "warning" | "error"): void;
        setWidget(
            name: string,
            content: string[] | undefined,
            options?: { placement?: "aboveEditor" | "belowEditor" }
        ): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
        select(title: string, options: string[]): Promise<string | undefined>;
        editor(title: string, content: string): Promise<string | undefined>;
    };
}

export type ToolResult = AgentToolResult<unknown>;
