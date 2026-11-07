/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 X2 Salah and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";

import { toggleQuestsManager, unmountQuestsManager } from "./manager";
import { PLUGIN_VERSION_LABEL } from "./version";

const LAUNCHER_ATTR = "data-dqm-launcher";
const CHROME_SELECTOR = '[data-window-chrome="true"]';

let fallbackObserver: MutationObserver | null = null;
let fallbackFrame = 0;

function openQuestsManager() {
    try {
        toggleQuestsManager();
    } catch {
        /* panel errors must not break the title bar */
    }
}

function createFallbackButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(LAUNCHER_ATTR, "fallback");
    button.textContent = "Quests Manager";
    button.style.cssText = [
        "margin-inline-end:8px",
        "background:#5865F2",
        "color:#fff",
        "border:none",
        "border-radius:3px",
        "padding:2px 8px",
        "font:600 12px/16px 'gg sans','Segoe UI',sans-serif",
        "cursor:pointer",
        "flex:0 0 auto",
        "align-self:center",
        "height:24px"
    ].join(";");
    button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        openQuestsManager();
    });
    return button;
}

/** Keep one launcher on each window chrome. Prefer the patched React button. */
function syncFallbackButtons() {
    const chromes = document.querySelectorAll(CHROME_SELECTOR);
    for (const chrome of chromes) {
        const patched = chrome.querySelector(`[${LAUNCHER_ATTR}="patched"]`);
        const fallback = chrome.querySelector(`[${LAUNCHER_ATTR}="fallback"]`);
        if (patched) {
            fallback?.remove();
            continue;
        }
        if (fallback) continue;

        const trailing = chrome.lastElementChild;
        if (!trailing) continue;
        trailing.prepend(createFallbackButton());
    }
}

function scheduleFallbackSync() {
    if (fallbackFrame) return;
    fallbackFrame = requestAnimationFrame(() => {
        fallbackFrame = 0;
        try {
            syncFallbackButtons();
        } catch {
            /* ignore DOM races */
        }
    });
}

function startFallbackButton() {
    stopFallbackButton();
    scheduleFallbackSync();
    fallbackObserver = new MutationObserver(scheduleFallbackSync);
    fallbackObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function stopFallbackButton() {
    fallbackObserver?.disconnect();
    fallbackObserver = null;
    if (fallbackFrame) {
        cancelAnimationFrame(fallbackFrame);
        fallbackFrame = 0;
    }
    document.querySelectorAll(`[${LAUNCHER_ATTR}="fallback"]`).forEach(node => node.remove());
}

export default definePlugin({
    name: "Quests Manager",
    description: `Discord Quest Auto Completer (${PLUGIN_VERSION_LABEL})`,
    authors: [{
        name: "X2 Salah",
        id: 0n
    }],

    patches: [
        {
            // Title-bar module. ".PlatformTypes.WEB" was removed from Discord build 667580.
            find: "refresh-title-bar-small",
            replacement: {
                match: /(\((\i)\)\{)(let\{leading)/,
                replace: "$1try{var __dqm=$2?.trailing?.props?.children;Array.isArray(__dqm)&&__dqm.unshift($self.renderQuestsManagerButton())}catch(_){}$3"
            }
        }
    ],

    start() {
        startFallbackButton();
    },

    stop() {
        stopFallbackButton();
        unmountQuestsManager();
    },

    renderQuestsManagerButton() {
        return (
            <ErrorBoundary noop>
                <Button
                    variant="primary"
                    size="small"
                    data-dqm-launcher="patched"
                    onClick={() => openQuestsManager()}
                    style={{ marginInlineEnd: 8 }}
                >
                    Quests Manager
                </Button>
            </ErrorBoundary>
        );
    }
});
