/*
 * Quests Manager console runtime — webpack shim, CDP activity bridge, CSS injection.
 * Bundled into Quests Manager.txt by build-console-script.mjs
 */

const STORAGE_CDP_PORT_KEY = "questHelper_cdpPort";
const DEFAULT_CDP_PORT = 9223;
const API_VALIDATE_TIMEOUT_MS = 5000;

let _discordModules = null;

function getWpRequire() {
    try {
        if (typeof webpackChunkdiscord_app === "undefined") return null;
        const req = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
        webpackChunkdiscord_app.pop();
        return req;
    } catch (_) {
        return null;
    }
}

async function validateRestApi(api) {
    try {
        const res = await Promise.race([
            api.get({ url: "/quests/@me" }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), API_VALIDATE_TIMEOUT_MS)
            ),
        ]);
        if (!res || typeof res !== "object") return false;
        if (res.locale != null || res.ast !== undefined) return false;
        const body = res.body;
        if (typeof body === "string" && /^\s*</.test(body)) return false;
        return body != null && (
            Array.isArray(body) ||
            Array.isArray(body?.quests) ||
            typeof body === "object"
        );
    } catch (_) {
        return false;
    }
}

async function initializeDiscordModules() {
    const empty = {
        QuestsStore: null,
        RunningGameStore: null,
        ApplicationStreamingStore: null,
        ChannelStore: null,
        GuildChannelStore: null,
        FluxDispatcher: null,
        api: null,
    };

    try {
        const wpRequire = getWpRequire();
        if (!wpRequire?.c) {
            return { ok: false, missing: ["webpackChunkdiscord_app"] };
        }

        const modules = { ...empty };
        const apiCandidates = [];
        const apiSeen = new Set();

        for (const m of Object.values(wpRequire.c)) {
            try {
                const exp = m?.exports;
                if (!exp) continue;

                for (const key of Object.keys(exp)) {
                    try {
                        const val = exp[key];
                        if (!val) continue;

                        if (!modules.FluxDispatcher && val?.__proto__?.flushWaitQueue) {
                            modules.FluxDispatcher = val;
                        }

                        if (!modules.ApplicationStreamingStore && val?.__proto__?.getStreamerActiveStreamMetadata) {
                            modules.ApplicationStreamingStore = val;
                        }

                        if (!modules.RunningGameStore && typeof val?.getRunningGames === "function") {
                            try {
                                const games = val.getRunningGames();
                                if (Array.isArray(games)) {
                                    modules.RunningGameStore = val;
                                }
                            } catch (_) {}
                        }

                        if (!modules.QuestsStore && val?.__proto__?.getQuest) {
                            modules.QuestsStore = val;
                        }

                        if (!modules.ChannelStore && typeof val?.getChannel === "function" && val?.__proto__?.getChannel) {
                            modules.ChannelStore = val;
                        }

                        if (!modules.GuildChannelStore && typeof val?.getGuild === "function" && val?.__proto__?.getGuild) {
                            modules.GuildChannelStore = val;
                        }

                        if (typeof val?.get === "function" && typeof val?.post === "function") {
                            if (apiSeen.has(val)) continue;
                            apiSeen.add(val);
                            apiCandidates.push(val);
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }

        const swallowInitRejections = (e) => e.preventDefault();
        window.addEventListener("unhandledrejection", swallowInitRejections);
        try {
            for (const candidate of apiCandidates) {
                if (await validateRestApi(candidate)) {
                    modules.api = candidate;
                    break;
                }
            }
        } finally {
            window.removeEventListener("unhandledrejection", swallowInitRejections);
        }

        const required = ["QuestsStore", "api", "FluxDispatcher"];
        const missing = required.filter(name => !modules[name]);

        _discordModules = modules;
        return { ok: missing.length === 0, missing, modules };
    } catch (e) {
        return { ok: false, missing: [String(e?.message || e)] };
    }
}

function resolveStores() {
    const m = _discordModules ?? {
        QuestsStore: null,
        RunningGameStore: null,
        ApplicationStreamingStore: null,
        ChannelStore: null,
        GuildChannelStore: null,
        FluxDispatcher: null,
        api: null,
    };
    return {
        QuestsStore: m.QuestsStore,
        RunningGameStore: m.RunningGameStore,
        ApplicationStreamingStore: m.ApplicationStreamingStore,
        ChannelStore: m.ChannelStore,
        GuildChannelStore: m.GuildChannelStore,
        FluxDispatcher: m.FluxDispatcher,
        api: m.api,
    };
}

function getCdpPort() {
    try {
        const saved = localStorage.getItem(STORAGE_CDP_PORT_KEY);
        const parsed = Number.parseInt(String(saved), 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) return parsed;
    } catch (_) {}
    return DEFAULT_CDP_PORT;
}

function extractApplicationIdFromUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        const suffix = ".discordsays.com";
        if (host.endsWith(suffix) && host !== "discordsays.com") {
            const appId = host.slice(0, -suffix.length);
            if (appId) return appId;
        }
        const fromQuery = parsed.searchParams.get("application_id")
            || parsed.searchParams.get("applicationId");
        if (fromQuery) return fromQuery;
        const pathMatch = parsed.pathname.match(/\/(\d{17,20})(?:\/|$)/);
        if (pathMatch) return pathMatch[1];
    } catch (_) {}
    return null;
}

function isActivityTarget(target) {
    const url = target?.url || "";
    return url.includes("discordsays.com");
}

function targetMatchesApplication(target, applicationId) {
    if (!isActivityTarget(target)) return false;
    const url = target.url || "";
    if (extractApplicationIdFromUrl(url) === String(applicationId)) return true;
    return url.includes(String(applicationId));
}

async function fetchCdpTargets() {
    const port = getCdpPort();
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
    return await res.json();
}

async function findActivityCdpTarget(applicationId) {
    const targets = await fetchCdpTargets();
    const activityTargets = targets.filter(isActivityTarget);
    if (!activityTargets.length) return null;
    if (applicationId) {
        const matched = activityTargets.filter(t => targetMatchesApplication(t, applicationId));
        if (matched.length) return matched[matched.length - 1];
        return null;
    }
    return activityTargets[activityTargets.length - 1];
}

async function cdpEvaluateOnTarget(wsUrl, jsCode, awaitPromise = true, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch (_) {}
            fn(arg);
        };
        let ws;
        const timer = setTimeout(() => finish(reject, new Error("CDP evaluate timed out")), timeoutMs);
        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            finish(reject, new Error("CDP WebSocket failed: " + (e?.message || e)));
            return;
        }
        ws.onopen = () => {
            ws.send(JSON.stringify({
                id: 1,
                method: "Runtime.evaluate",
                params: {
                    expression: jsCode,
                    returnByValue: true,
                    awaitPromise: !!awaitPromise
                }
            }));
        };
        ws.onmessage = (ev) => {
            let json;
            try { json = JSON.parse(ev.data); } catch (_) { return; }
            if (json.id !== 1) return;
            if (json.error) {
                finish(reject, new Error(json.error.message || "CDP error"));
                return;
            }
            if (json.result?.exceptionDetails) {
                const text = json.result.exceptionDetails.text || "JavaScript exception";
                finish(reject, new Error(text));
                return;
            }
            const val = json.result?.result?.value;
            if (typeof val === "string") finish(resolve, val);
            else if (val != null) finish(resolve, JSON.stringify(val));
            else finish(resolve, null);
        };
        ws.onerror = () => finish(reject, new Error("CDP WebSocket error"));
    });
}

let _cdpReachableCache = { at: 0, value: null };

async function probeCdpReachable() {
    if (Date.now() - _cdpReachableCache.at < 8000 && _cdpReachableCache.value != null) {
        return _cdpReachableCache.value;
    }
    try {
        await fetchCdpTargets();
        _cdpReachableCache = { at: Date.now(), value: true };
        return true;
    } catch (_) {
        _cdpReachableCache = { at: Date.now(), value: false };
        return false;
    }
}

const CDP_SETUP_MESSAGE = "Launch Quest requires Discord started with --remote-debugging-port="
    + DEFAULT_CDP_PORT + " (or set localStorage questHelper_cdpPort).";

function getNative() {
    return {
        async hasActivityFrame(applicationId) {
            try {
                return !!(await findActivityCdpTarget(applicationId));
            } catch (_) {
                return false;
            }
        },
        async execInActivityFrame(applicationId, jsCode) {
            const reachable = await probeCdpReachable();
            if (!reachable) return null;
            const target = await findActivityCdpTarget(applicationId);
            if (!target?.webSocketDebuggerUrl) return null;
            return await cdpEvaluateOnTarget(target.webSocketDebuggerUrl, jsCode, true, 25000);
        }
    };
}

function injectDqmStyles(cssText) {
    const id = "dqm-styles";
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement("style");
        el.id = id;
        document.head.appendChild(el);
    }
    el.textContent = cssText;
}
