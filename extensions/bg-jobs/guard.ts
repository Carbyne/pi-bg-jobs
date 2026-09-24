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

/** Fill {tool} {max} {asked} placeholders in a block-reason template. */
function renderReason(tpl: string | undefined, fallback: string, tool: string, maxSec: number, askedSec?: number): string {
    const t = typeof tpl === "string" && tpl.length > 0 ? tpl : fallback;
    return t
        .split("{tool}").join(tool)
        .split("{max}").join(fmtDurSec(maxSec))
        .split("{asked}").join(askedSec !== undefined ? fmtDurSec(askedSec) : "");
}

export function registerForegroundGuard(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("tool_call", async (event) => {
        if (!reg.foregroundGuard || !FOREGROUND_TOOLS.has(event.toolName)) return undefined;

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
