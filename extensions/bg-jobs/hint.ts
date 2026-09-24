/**
 * Live "(ctrl+b to run in background)" hint shown below the editor while a
 * foreground bash command is running — mirrors Claude Code's BackgroundHint,
 * which appears once a command has run past the quick-completion window.
 */

import type { UiContext } from "./types.ts";

const HINT_KEY = "bg-hint";

/**
 * Ref-count of foreground commands currently showing the hint. The widget is a
 * single shared key, but bash commands run in parallel — so we only render it on
 * the 0→1 transition and clear it on the last 1→0, keeping the hint up as long
 * as any foreground command is still running. Each caller must pair exactly one
 * showBackgroundHint() with one clearBackgroundHint().
 */
let activeHints = 0;

/**
 * The key to press to background, as shown in the hint. Inside a tmux session
 * `ctrl+b` is tmux's prefix key, so it must be pressed twice — Claude Code
 * shows the same "(twice)" note.
 */
function backgroundHintLabel(): string {
    return process.env.TMUX
        ? "ctrl+b ctrl+b (twice) to run in background"
        : "ctrl+b to run in background";
}

/** Show the background hint below the editor (idempotent across parallel commands). */
export function showBackgroundHint(ctx: UiContext): void {
    activeHints++;
    if (activeHints === 1) {
        ctx.ui.setWidget(HINT_KEY, [`(${backgroundHintLabel()})`], {
            placement: "belowEditor",
        });
    }
}

/** Release one hint; clears the widget only when the last command is done. */
export function clearBackgroundHint(ctx: UiContext): void {
    if (activeHints === 0) return;
    activeHints--;
    if (activeHints === 0) {
        ctx.ui.setWidget(HINT_KEY, undefined);
    }
}
