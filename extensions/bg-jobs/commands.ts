/**
 * Slash command registration.
 *
 *   - /bg-list: Open the interactive background task manager
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { openBgListPanel } from "./ui.ts";
import { fmtDurSec } from "./guard.ts";

export function registerCommands(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerCommand("bg-list", {
        description: "Open the interactive background task manager",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await openBgListPanel(reg, ctx);
        },
    });

    pi.registerCommand("fg-guard", {
        description: "Foreground tool-call guard: /fg-guard on | off | status",
        handler: async (args, ctx: ExtensionCommandContext) => {
            const sub = (args ?? "").trim().toLowerCase();
            if (sub === "on") {
                reg.foregroundGuard = true;
                ctx.ui.notify(
                    `fg-guard enabled (max foreground ${fmtDurSec(reg.maxForegroundSec)}, ${reg.foregroundAllow.length} allowlist pattern(s))`,
                    "info"
                );
                return;
            }
            if (sub === "off") {
                reg.foregroundGuard = false;
                ctx.ui.notify("fg-guard disabled for this session", "info");
                return;
            }
            ctx.ui.notify(
                `fg-guard: ${reg.foregroundGuard ? "ENABLED" : "disabled"} — max foreground ${fmtDurSec(reg.maxForegroundSec)}, ` +
                    `blocked this session: ${reg.guardBlocked}, allowlist: ${reg.foregroundAllow.length ? reg.foregroundAllow.join(" | ") : "(none)"}, ` +
                    `sleep-while-busy: ${reg.fgGuardBlockSleepWhileBusy ? reg.fgGuardSleepMatch : "off"}`,
                "info"
            );
        },
    });
}
