/*
 * Tampermonkey bootstrap — launcher button, Discord readiness, SPA persistence.
 * Bundled into Quests Manager.user.js by build-console-script.mjs
 */

const LAUNCHER_ID = "dqm-launcher-btn";
const DISCORD_READY_TIMEOUT_MS = 120000;
const DISCORD_READY_POLL_MS = 500;

let _modulesReady = false;
let _modulesInitPromise = null;

function waitForDiscordReady() {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            if (typeof webpackChunkdiscord_app !== "undefined") {
                resolve(true);
                return;
            }
            if (Date.now() - start >= DISCORD_READY_TIMEOUT_MS) {
                console.warn("[Quests Manager] Timed out waiting for Discord webpack. Launcher shown; click to retry.");
                resolve(false);
                return;
            }
            setTimeout(check, DISCORD_READY_POLL_MS);
        };
        check();
    });
}

async function ensureQuestsManagerReady() {
    if (_modulesReady && globalThis.QuestsManager) return true;

    if (!_modulesInitPromise) {
        _modulesInitPromise = (async () => {
            const { ok, missing } = await initializeDiscordModules();
            if (!ok) {
                console.error("[Quests Manager] Failed to resolve Discord modules:", missing.join(", "));
                _modulesInitPromise = null;
                return false;
            }
            globalThis.QuestsManager = {
                mount: mountQuestsManager,
                unmount: unmountQuestsManager,
                toggle: toggleQuestsManager,
                open: isQuestsManagerOpen
            };
            _modulesReady = true;
            return true;
        })();
    }

    return _modulesInitPromise;
}

async function onLauncherActivate(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const ready = await ensureQuestsManagerReady();
    if (!ready) return;
    globalThis.QuestsManager.toggle();
}

function injectLauncherButton() {
    if (document.getElementById(LAUNCHER_ID)) return;

    const btn = document.createElement("button");
    btn.id = LAUNCHER_ID;
    btn.type = "button";
    btn.textContent = "Quests Manager";
    btn.setAttribute("aria-label", "Quests Manager");
    btn.addEventListener("click", onLauncherActivate);

    (document.body || document.documentElement).appendChild(btn);
}

function setupLauncherPersistence() {
    const ensure = () => {
        if (!document.getElementById(LAUNCHER_ID)) injectLauncherButton();
    };

    window.addEventListener("popstate", ensure);

    const observer = new MutationObserver(() => ensure());
    const root = document.body || document.documentElement;
    if (root) {
        observer.observe(root, { childList: true, subtree: true });
    }
}
