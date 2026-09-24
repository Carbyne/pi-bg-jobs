/**
 * Keyboard shortcut registration.
 *
 *   - Ctrl+Shift+J / Shift+Down: open the background task manager
 *   - Ctrl+Shift+X: kill the most recent running job
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import { renderSidebar } from "./registry.ts";
import { jobLabel } from "./format.ts";
import { openBgListPanel } from "./ui.ts";

export function registerShortcuts(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerShortcut("ctrl+shift+j", {
        description: "Open background task manager",
        handler: async (ctx) => openBgListPanel(reg, ctx),
    });

    pi.registerShortcut("shift+down", {
        description: "Open background task manager",
        handler: async (ctx) => openBgListPanel(reg, ctx),
    });

    pi.registerShortcut("ctrl+shift+x", {
        description: "Kill the most recent running background job",
        handler: async (ctx) => handleCtrlX(reg, ctx),
    });
}

async function handleCtrlX(
    reg: BackgroundRegistry,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>>[0]
): Promise<void> {
    const running = Array.from(reg.jobs.values())
        .filter((j) => j.status === "running")
        .sort((a, b) => b.startTime - a.startTime);

    if (running.length === 0) {
        ctx.ui.notify("No running tasks to kill", "warning");
        return;
    }

    const target = running[0];
    terminateJobSilently(reg, target);
    renderSidebar(reg, ctx);
    ctx.ui.notify(`Killed ${jobLabel(target)}`, "info");
}
