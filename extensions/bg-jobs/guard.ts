/**
 * Foreground tool-call guard.
 *
 * A blocking bash call (no timeout, or a huge one) freezes the whole
 * session: no agent_settled → no follow-up schedulers (ralph-loop), no
 * bg-jobs completion notices, no steering. Rather than clamping (the agent
 * pays the full wait for a doomed command), we BLOCK non-compliant calls up
 * front so the agent immediately reroutes to bg_run:
 *
 *   1. bash/powershell without an explicit `timeout`  -> blocked
 *   2. `timeout` above maxForegroundSec               -> blocked
 *   3. command matching an allowlist regex            -> allowed (skips 1-2)
 *
 * Settings (settings.json → "bgJobs"):
 *   foregroundGuard: true | false
 *   maxForeground: "5m" (number = seconds; ms/s/m/h units allowed)
 *   foregroundAllow: [ "<regex>", ... ]
 *   fgGuardNoTimeout / fgGuardTooLong: block-reason templates
 *       (placeholders: {tool} {max} {asked})
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";

// Tools whose calls can block the agent turn, with a `timeout` (seconds) param.
const FOREGROUND_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** Parse duration to seconds: plain number = seconds; units ms/s/m/h allowed. */
export function parseDurationSeconds(v: unknown): number {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string") {
        const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
        if (m) {
            const n = Number(m[1]);
            const mul = ({ ms: 0.001, s: 1, m: 60, h: 3600 } as const)[
                (m[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h"
            ];
            return Math.floor(n * mul);
        }
    }
    throw new Error(`bg-jobs: invalid duration ${JSON.stringify(v)} (use seconds or 500ms/60s/10m/1h)`);
}

export function compileAllow(patterns: string[]): RegExp[] {
    const out: RegExp[] = [];
    for (const p of patterns) {
        try {
            out.push(new RegExp(p));
        } catch {
            // Invalid patterns are skipped rather than breaking the guard.
        }
    }
    return out;
}

export function fmtDurSec(sec: number): string {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60 ? `${sec % 60}s` : ""}`;
    return `${Math.floor(sec / 3600)}h${sec % 3600 ? `${Math.floor((sec % 3600) / 60)}m` : ""}`;
}

/** Default block-reason templates (overridable via bgJobs settings). */
export const FG_GUARD_NO_TIMEOUT_DEFAULT =
    "bg-jobs foreground guard: {tool} requires an explicit 'timeout' in seconds (max {max}). Quick command → small timeout. Longer than {max} → run it with bg_run instead: it returns immediately, you keep working, and you're notified automatically when it finishes.";
export const FG_GUARD_TOO_LONG_DEFAULT =
    "bg-jobs foreground guard: foreground {tool} is capped at {max} (you asked for {asked}). Blocking waits freeze the session (no settle → no bg-jobs notices, no steering). Use bg_run for this command instead.";
export const FG_GUARD_SLEEP_DEFAULT =
    "bg-jobs foreground guard: foreground `sleep` is illegal while background jobs are running. Job completion is NOTED to you automatically (exit code, duration, log path) \u2014 polling with sleep freezes the session (no settle \u2192 no notices, no steering) and buys nothing. Non-blocking peek: bg_jobs action='output'. Need a real delayed action? Schedule it: bg_run 'sleep N && <the thing you were about to do>'. Waiting on a specific job? bg_jobs action='attach' snapshots its live output.";

/** Fill {tool} {max} {asked} placeholders in a block-reason template. */
function renderReason(tpl: string | undefined, fallback: string, tool: string, maxSec: number, askedSec?: number): string {
    const t = typeof tpl === "string" && tpl.length > 0 ? tpl : fallback;
    return t
        .split("{tool}").join(tool)
        .split("{max}").join(fmtDurSec(maxSec))
        .split("{asked}").join(askedSec !== undefined ? fmtDurSec(askedSec) : "");
}

/** prefix: command starts with the sleep binary (absolute path allowed).
 *  anywhere: a `sleep` word token appears anywhere (paths ending in /sleep too). */
const SLEEP_PREFIX_RE = /^\s*(?:time\s+|sudo\s+|nohup\s+|env\s+)*(?:[\w./+-]*\/)?sleep(?:\s|$)/i;
const SLEEP_ANYWHERE_RE = /(?:^|[\s;|&(`'"$])(?:[\w./+-]*\/)?sleep(?:\s|$|[;|&)'"])/i;

function hasRunningJobs(reg: BackgroundRegistry): boolean {
    for (const job of reg.jobs.values()) if (job.status === "running") return true;
    return false;
}

export function registerForegroundGuard(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("tool_call", async (event) => {
        if (!FOREGROUND_TOOLS.has(event.toolName)) return undefined;

        let command: string | undefined;
        let timeout: number | undefined;
        if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
            command = event.input.command;
            timeout = event.input.timeout;
        } else {
            return undefined;
        }

        const cmd = command ?? "";
        if (reg.foregroundAllowRe.some((re) => re.test(cmd))) return undefined;

        // Sleep-while-busy: independent of the timeout guard (foregroundGuard)
        // — it enforces the completion-notification contract, not the
        // blocking-wait policy, and stays active even when that policy is off.
        if (reg.fgGuardBlockSleepWhileBusy && hasRunningJobs(reg)) {
            const re = reg.fgGuardSleepMatch === "anywhere" ? SLEEP_ANYWHERE_RE : SLEEP_PREFIX_RE;
            if (re.test(cmd)) {
                reg.guardBlocked++;
                return {
                    block: true,
                    reason: renderReason(reg.fgGuardSleepRejection, FG_GUARD_SLEEP_DEFAULT, event.toolName, reg.maxForegroundSec),
                };
            }
        }

        if (!reg.foregroundGuard) return undefined;

        if (timeout === undefined || timeout === null || timeout <= 0) {
            reg.guardBlocked++;
            return {
                block: true,
                reason: renderReason(reg.fgGuardNoTimeout, FG_GUARD_NO_TIMEOUT_DEFAULT, event.toolName, reg.maxForegroundSec),
            };
        }
        if (timeout > reg.maxForegroundSec) {
            reg.guardBlocked++;
            return {
                block: true,
                reason: renderReason(reg.fgGuardTooLong, FG_GUARD_TOO_LONG_DEFAULT, event.toolName, reg.maxForegroundSec, timeout),
            };
        }
        return undefined;
    });
}
