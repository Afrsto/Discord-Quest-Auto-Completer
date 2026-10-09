// @ts-nocheck
/*
 * Launch Quest / Activity quest completion — ported from Discord Quest Helper
 */

const DEFAULT_CHECKPOINT_MIN_SECS = 60;
const DEFAULT_CHECKPOINT_MAX_SECS = 120;
const CHECKPOINT_MIN_LIMIT = 30;
const CHECKPOINT_MAX_LIMIT = 600;
export const STORAGE_ACTIVITY_CHECKPOINT_MIN_KEY = "questHelper_activityCheckpointMin";
export const STORAGE_ACTIVITY_CHECKPOINT_MAX_KEY = "questHelper_activityCheckpointMax";

/** @deprecated Use getActivityCheckpointAvgSecs() */
export const ACTIVITY_CHECKPOINT_INTERVAL_SECS = DEFAULT_CHECKPOINT_MIN_SECS;
const IFRAME_WAIT_MS = 90000;
const HEARTBEAT_INTERVAL_MS = 20000;
const NATIVE_EXEC_RETRIES = 5;
const NATIVE_EXEC_RETRY_MS = 500;
const INIT_RETRY_ATTEMPTS = 18;
const INIT_RETRY_DELAY_MS = 5000;
const TIMER_RETRY_ATTEMPTS = 6;
const TIMER_RETRY_DELAY_MS = 5000;
const CHECKPOINT_WAIT_FEEDBACK_MS = 30000;
const SERVER_PROGRESS_POLL_MS = 2000;
const SERVER_PROGRESS_POLL_MAX_MS = 10000;

export const ActivityFrameErrorCode = {
    NATIVE_REQUIRED: "NATIVE_REQUIRED",
    FRAME_NOT_READY: "FRAME_NOT_READY"
};

function clampCheckpointSecs(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

export function getActivityCheckpointSettings() {
    let minSecs = DEFAULT_CHECKPOINT_MIN_SECS;
    let maxSecs = DEFAULT_CHECKPOINT_MAX_SECS;
    try {
        const savedMin = localStorage.getItem(STORAGE_ACTIVITY_CHECKPOINT_MIN_KEY);
        const savedMax = localStorage.getItem(STORAGE_ACTIVITY_CHECKPOINT_MAX_KEY);
        if (savedMin != null) {
            minSecs = clampCheckpointSecs(savedMin, DEFAULT_CHECKPOINT_MIN_SECS, CHECKPOINT_MIN_LIMIT, CHECKPOINT_MAX_LIMIT);
        }
        if (savedMax != null) {
            maxSecs = clampCheckpointSecs(savedMax, DEFAULT_CHECKPOINT_MAX_SECS, CHECKPOINT_MIN_LIMIT, CHECKPOINT_MAX_LIMIT);
        }
    } catch (_) {}
    if (maxSecs < minSecs) maxSecs = minSecs;
    return { minSecs, maxSecs };
}

export function setActivityCheckpointSettings(minSecs, maxSecs) {
    let min = clampCheckpointSecs(minSecs, DEFAULT_CHECKPOINT_MIN_SECS, CHECKPOINT_MIN_LIMIT, CHECKPOINT_MAX_LIMIT);
    let max = clampCheckpointSecs(maxSecs, DEFAULT_CHECKPOINT_MAX_SECS, CHECKPOINT_MIN_LIMIT, CHECKPOINT_MAX_LIMIT);
    if (max < min) max = min;
    try {
        localStorage.setItem(STORAGE_ACTIVITY_CHECKPOINT_MIN_KEY, String(min));
        localStorage.setItem(STORAGE_ACTIVITY_CHECKPOINT_MAX_KEY, String(max));
    } catch (_) {}
    return { minSecs: min, maxSecs: max };
}

export function getActivityCheckpointAvgSecs() {
    const { minSecs, maxSecs } = getActivityCheckpointSettings();
    return (minSecs + maxSecs) / 2;
}

export function readActivityCheckpointProgress(quest, taskName) {
    if (!quest) return 0;
    const progress = quest.userStatus?.progress;
    if (taskName && progress?.[taskName]?.value != null) {
        return Math.floor(progress[taskName].value);
    }
    const first = Object.values(progress ?? {})[0];
    return Math.floor(first?.value ?? 0);
}

export function getFreshQuest(questId, QuestsStore) {
    return QuestsStore?.getQuest?.(questId) ?? QuestsStore?.quests?.get(questId);
}

export function resolveCompletedCheckpoints(questId, taskName, checkpointCount, QuestsStore) {
    const quest = getFreshQuest(questId, QuestsStore);
    const raw = readActivityCheckpointProgress(quest, taskName);
    return Math.min(checkpointCount, Math.max(0, raw));
}

function pickStatusField(status, camel, snake) {
    if (!status || typeof status !== "object") return null;
    return status[camel] ?? status[snake] ?? null;
}

export function normalizeQuestUserStatus(quest) {
    if (!quest) return null;
    const raw = quest.userStatus ?? quest.user_status;
    if (!raw) return quest;
    return {
        ...quest,
        userStatus: {
            ...raw,
            progress: raw.progress ?? {},
            completedAt: pickStatusField(raw, "completedAt", "completed_at"),
            claimedAt: pickStatusField(raw, "claimedAt", "claimed_at"),
            enrolledAt: pickStatusField(raw, "enrolledAt", "enrolled_at")
        }
    };
}

export function getQuestExpiresAt(quest) {
    const cfg = quest?.config;
    return cfg?.expiresAt ?? cfg?.expires_at ?? null;
}

export function isQuestExpired(quest, now = Date.now()) {
    const expires = getQuestExpiresAt(quest);
    if (!expires) return false;
    const ts = new Date(expires).getTime();
    return Number.isFinite(ts) && ts <= now;
}

export function getQuestCompletionFlags(quest) {
    const normalized = normalizeQuestUserStatus(quest);
    const status = normalized?.userStatus;
    const completedAt = status?.completedAt ?? null;
    const claimedAt = status?.claimedAt ?? null;
    const enrolledAt = status?.enrolledAt ?? null;
    return {
        enrolledAt,
        completedAt,
        claimedAt,
        isEnrolled: !!enrolledAt,
        isCompleted: !!completedAt,
        isClaimed: !!claimedAt,
        isClaimable: !!completedAt && !claimedAt
    };
}

export async function fetchQuestProgressFromApi(questId, apiGet) {
    if (!apiGet) return 0;
    try {
        const res = await apiGet({ url: "/quests/@me" });
        const body = res?.body;
        const quests = Array.isArray(body)
            ? body
            : Array.isArray(body?.quests)
                ? body.quests
                : [];
        const found = quests.find(q => q.id === questId);
        if (!found) return 0;
        const normalized = normalizeQuestUserStatus(found);
        return readActivityCheckpointProgress(normalized, null);
    } catch (_) {
        return 0;
    }
}

export async function fetchBestProgressForGroup(questIds, apiGet) {
    if (!apiGet || !questIds?.length) return 0;
    let best = 0;
    for (const id of questIds) {
        best = Math.max(best, await fetchQuestProgressFromApi(id, apiGet));
    }
    return best;
}

export function resolveGroupCompletedCheckpoints(questIds, taskName, checkpointCount, QuestsStore) {
    let best = 0;
    for (const id of questIds) {
        best = Math.max(best, resolveCompletedCheckpoints(id, taskName, checkpointCount, QuestsStore));
    }
    return Math.min(checkpointCount, best);
}

export async function resolveCompletedCheckpointsAsync(
    questId, taskName, checkpointCount, QuestsStore, apiGet, extraQuestIds = []
) {
    const ids = [...new Set([questId, ...(extraQuestIds ?? [])])];
    let best = resolveGroupCompletedCheckpoints(ids, taskName, checkpointCount, QuestsStore);
    if (apiGet) {
        const apiCount = await fetchBestProgressForGroup(ids, apiGet);
        best = Math.max(best, Math.min(checkpointCount, apiCount));
    }
    return best;
}

declare const VencordNative: {
    pluginHelpers?: Record<string, {
        execInActivityFrame?: (applicationId: string, jsCode: string) => Promise<string | null>;
        hasActivityFrame?: (applicationId: string) => Promise<boolean>;
    }>;
};

function getNative() {
    return typeof VencordNative !== "undefined"
        ? VencordNative.pluginHelpers?.["Quests Manager"]
        : null;
}

const JS_ACTIVITY_HELPERS = `
    const DQH_SDK_WAIT_TIMEOUT_MS = 12000;
    const DQH_SDK_READY_TIMEOUT_MS = 5000;
    const DQH_COMMAND_TIMEOUT_MS = 5000;
    const DQH_QUEST_START_TIMER_TIMEOUT_MS = 10000;

    function withTimeout(promise, timeoutMs, label) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(label + " timed out after " + timeoutMs + "ms"));
            }, timeoutMs);
            Promise.resolve(promise).then(
                value => { clearTimeout(timer); resolve(value); },
                error => { clearTimeout(timer); reject(error); }
            );
        });
    }

    function sanitizeScalar(value) {
        return String(value).replace(/\\b\\d{17,19}\\b/g, "[ID]");
    }

    function describeError(error) {
        if (error && typeof error === "object") {
            const details = {};
            for (const key of ["name", "message", "code", "type", "status", "statusCode", "reason"]) {
                if (error[key] !== undefined) {
                    details[key] = typeof error[key] === "string" ? sanitizeScalar(error[key]) : error[key];
                }
            }
            if (Object.keys(details).length > 0) return JSON.stringify(details);
        }
        return sanitizeScalar(error);
    }

    function commandNames(sdk) {
        try {
            return Object.keys(sdk?.commands || {})
                .filter(key => typeof sdk.commands[key] === "function")
                .sort();
        } catch (_) { return []; }
    }

    function isKnownBenignQuestStartTimerError(value) {
        return !!value
            && typeof value === "object"
            && value.code === 4002
            && String(value.message || "").includes("Quest not found");
    }
`;

export function getTaskConfig(quest) {
    const cfg = quest?.config;
    if (!cfg) return null;
    return cfg.taskConfig
        ?? cfg.taskConfigV2
        ?? cfg.task_config
        ?? cfg.task_config_v2
        ?? null;
}

export function getActivityTaskEntry(quest) {
    const tasks = getTaskConfig(quest)?.tasks;
    if (!tasks) return null;
    for (const [key, task] of Object.entries(tasks)) {
        const type = String(task?.type || key || "").toUpperCase();
        if (
            type === "ACHIEVEMENT_IN_ACTIVITY"
            || type === "PLAY_ACTIVITY"
            || type.includes("ACHIEVEMENT")
            || (type.includes("ACTIVITY") && type.includes("PLAY"))
        ) {
            return { key, task, type: task?.type || key };
        }
    }
    return null;
}

export function isPlayActivityTask(taskName, taskConfig) {
    if (taskName === "PLAY_ACTIVITY") return true;
    const task = taskConfig?.tasks?.[taskName];
    return (task?.type || taskName) === "PLAY_ACTIVITY";
}

export function isAchievementActivityTask(taskName, taskConfig) {
    if (taskName === "ACHIEVEMENT_IN_ACTIVITY") return true;
    const task = taskConfig?.tasks?.[taskName];
    const type = String(task?.type || taskName || "").toUpperCase();
    return type === "ACHIEVEMENT_IN_ACTIVITY" || type.includes("ACHIEVEMENT");
}

export function isLaunchQuestTask(taskName, taskConfig) {
    return isAchievementActivityTask(taskName, taskConfig) || isPlayActivityTask(taskName, taskConfig);
}

export function isBatchRunnableActivity(taskName, taskConfig) {
    return isPlayActivityTask(taskName, taskConfig);
}

export function resolveQuestApplicationId(quest, taskName = null, taskConfig = null) {
    const config = quest?.config;
    const directId = config?.application?.id;
    if (directId) return String(directId);

    const tasks = (taskConfig ?? getTaskConfig(quest))?.tasks;
    if (tasks) {
        const keys = taskName ? [taskName] : Object.keys(tasks);
        for (const key of keys) {
            const task = tasks[key];
            if (!task) continue;
            const fromApplications = task.applications?.[0]?.id;
            if (fromApplications) return String(fromApplications);
        }
    }

    const activityEntry = getActivityTaskEntry(quest);
    const fromActivityTask = activityEntry?.task?.applications?.[0]?.id;
    if (fromActivityTask) return String(fromActivityTask);

    return "";
}

function buildInitActivityQuestJs(questId, allowedQuestIds = []) {
    const safeQuestId = JSON.stringify(String(questId));
    const allowed = [...new Set([String(questId), ...allowedQuestIds.map(String)])];
    const safeAllowed = JSON.stringify(allowed);
    return `
(async () => {
    const requestedQuestId = ${safeQuestId};
    const allowedQuestIds = ${safeAllowed};
    const allowedSet = new Set(allowedQuestIds.map(String));
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    ${JS_ACTIVITY_HELPERS}

    async function waitForSdk() {
        const startedAt = Date.now();
        let lastState = "window.discordSDK missing";
        while (Date.now() - startedAt < DQH_SDK_WAIT_TIMEOUT_MS) {
            const sdk = window.discordSDK;
            if (sdk && sdk.commands) {
                const commands = commandNames(sdk);
                if (typeof sdk.commands.questStartTimer === "function") {
                    return { sdk, commands, waitedMs: Date.now() - startedAt };
                }
                lastState = "questStartTimer missing; commands=[" + commands.join(", ") + "]";
            } else if (sdk) {
                lastState = "window.discordSDK present but commands missing";
            }
            await sleep(250);
        }
        throw new Error("Discord SDK not ready: " + lastState);
    }

    try {
        let sdkState;
        try { sdkState = await waitForSdk(); }
        catch (e) { return JSON.stringify({ success: false, error: describeError(e) }); }

        const sdk = sdkState.sdk;
        const commands = sdkState.commands;
        const waitedMs = sdkState.waitedMs;

        if (typeof sdk.ready === "function") {
            try {
                await withTimeout(sdk.ready(), DQH_SDK_READY_TIMEOUT_MS, "discordSDK.ready");
            } catch (e) {
                return JSON.stringify({ success: false, error: "discordSDK.ready failed: " + describeError(e), commands, waitedMs });
            }
        }

        try {
            if (typeof sdk.commands.setActivity === "function") {
                await withTimeout(sdk.commands.setActivity({
                    activity: { state: "Playing", details: "Completing Quest" }
                }), DQH_COMMAND_TIMEOUT_MS, "setActivity");
            }
        } catch (_) {}

        let questInfoBefore = null;
        if (typeof sdk.commands.getQuest === "function") {
            try {
                questInfoBefore = await withTimeout(sdk.commands.getQuest(), DQH_COMMAND_TIMEOUT_MS, "getQuest");
            } catch (_) {}
        }

        const boundQuestId = String(questInfoBefore?.quest_id || "");
        let effectiveQuestId = requestedQuestId;
        if (boundQuestId && allowedSet.has(boundQuestId)) {
            effectiveQuestId = boundQuestId;
        }

        let enrollmentStatusBefore = null;
        if (typeof sdk.commands.getQuestEnrollmentStatus === "function") {
            try {
                enrollmentStatusBefore = await withTimeout(
                    sdk.commands.getQuestEnrollmentStatus({ quest_id: effectiveQuestId }),
                    DQH_COMMAND_TIMEOUT_MS,
                    "getQuestEnrollmentStatus"
                );
            } catch (_) {}
        }

        const questInfoBeforeMatches = boundQuestId !== "" && allowedSet.has(boundQuestId);
        const enrollmentStatusBeforeMatches = String(enrollmentStatusBefore?.quest_id || "") === String(effectiveQuestId);
        const enrollmentStatusBeforeEnrolled = enrollmentStatusBeforeMatches && enrollmentStatusBefore?.is_enrolled === true;
        const hasRetryableQuestContext = questInfoBeforeMatches || enrollmentStatusBeforeEnrolled;

        let startTimerResult = null;
        let startTimerError = null;
        try {
            startTimerResult = await withTimeout(
                sdk.commands.questStartTimer({ quest_id: effectiveQuestId }),
                DQH_QUEST_START_TIMER_TIMEOUT_MS,
                "questStartTimer"
            );
        } catch (e) {
            startTimerError = describeError(e);
            if (isKnownBenignQuestStartTimerError(e) && hasRetryableQuestContext) {
                return JSON.stringify({
                    success: false,
                    errorCode: "QUEST_PENDING",
                    error: "questStartTimer failed: " + startTimerError,
                    effectiveQuestId,
                    boundQuestId,
                    commands,
                    waitedMs
                });
            }
            return JSON.stringify({
                success: false,
                error: "questStartTimer failed: " + startTimerError,
                effectiveQuestId,
                boundQuestId,
                commands,
                waitedMs
            });
        }

        if (startTimerResult && typeof startTimerResult === "object" && startTimerResult.success === false) {
            startTimerError = describeError(startTimerResult);
            if (isKnownBenignQuestStartTimerError(startTimerResult) && hasRetryableQuestContext) {
                return JSON.stringify({
                    success: false,
                    errorCode: "QUEST_PENDING",
                    error: "questStartTimer returned failure: " + startTimerError,
                    effectiveQuestId,
                    boundQuestId,
                    commands,
                    waitedMs
                });
            }
            return JSON.stringify({
                success: false,
                error: "questStartTimer returned failure: " + startTimerError,
                effectiveQuestId,
                boundQuestId,
                commands,
                waitedMs
            });
        }

        return JSON.stringify({
            success: true,
            waitedMs,
            effectiveQuestId,
            boundQuestId,
            startTimerError: null,
            startTimerIgnored: false
        });
    } catch (e) {
        return JSON.stringify({ success: false, error: describeError(e) });
    }
})()
`;
}

function buildQuestStartTimerOnlyJs(questId) {
    const safeQuestId = JSON.stringify(questId);
    return `
(async () => {
    const questId = ${safeQuestId};
    ${JS_ACTIVITY_HELPERS}
    try {
        const sdk = window.discordSDK;
        if (!sdk?.commands?.questStartTimer) {
            return JSON.stringify({ success: false, error: "questStartTimer unavailable" });
        }
        const result = await withTimeout(
            sdk.commands.questStartTimer({ quest_id: questId }),
            DQH_QUEST_START_TIMER_TIMEOUT_MS,
            "questStartTimer"
        );
        if (result && typeof result === "object" && result.success === false) {
            return JSON.stringify({ success: false, error: describeError(result) });
        }
        return JSON.stringify({ success: true });
    } catch (e) {
        return JSON.stringify({ success: false, error: describeError(e) });
    }
})()
`;
}

function buildClickActivityStartJs() {
    return `(function() {
        try {
            const buttons = Array.from(document.querySelectorAll("button, [role=\\"button\\"], a"));
            const start = buttons.find(b => /^\\s*start\\s*$/i.test((b.textContent || b.innerText || "").trim()));
            if (start) {
                start.click();
                return JSON.stringify({ success: true, clicked: true });
            }
            return JSON.stringify({ success: true, clicked: false });
        } catch (e) {
            return JSON.stringify({ success: false, error: String(e) });
        }
    })()`;
}

function buildDispatchMessageEventJs(eventType, payloadJson) {
    const safeType = JSON.stringify(eventType);
    const safePayload = payloadJson ?? "null";
    return `JSON.stringify((function() { try {
        var payload = ${safePayload};
        var evt = new MessageEvent("message", { data: { type: ${safeType}, payload: payload }, origin: window.location.origin });
        window.dispatchEvent(evt);
        return { success: true, dispatched: ${safeType}, payload: payload };
    } catch(e) { return { success: false, error: String(e) }; } })())`;
}

function buildCheckActivityQuestStatusJs(questId) {
    const safeQuestId = JSON.stringify(questId);
    return `
(async () => {
    const questId = ${safeQuestId};
    ${JS_ACTIVITY_HELPERS}
    try {
        const sdk = window.discordSDK;
        if (!sdk || !sdk.commands) {
            return JSON.stringify({ success: false, error: "Discord SDK not found" });
        }
        if (typeof sdk.commands.getQuest === "function") {
            try {
                const quest = await withTimeout(sdk.commands.getQuest(), DQH_COMMAND_TIMEOUT_MS, "getQuest");
                const questIdMatches = String(quest?.quest_id || "") === String(questId);
                if (questIdMatches) {
                    return JSON.stringify({
                        success: true,
                        completedAt: quest.completed_at,
                        completed: !!quest.completed_at,
                        questIdMatches
                    });
                }
            } catch (_) {}
        }
        if (typeof sdk.commands.getQuestEnrollmentStatus === "function") {
            const enrollmentStatus = await sdk.commands.getQuestEnrollmentStatus({ quest_id: questId });
            const enrollmentQuestIdMatches = String(enrollmentStatus?.quest_id || "") === String(questId);
            return JSON.stringify({
                success: enrollmentQuestIdMatches,
                completed: false,
                completedAt: null,
                cannotVerifyCompletion: true,
                enrollmentQuestIdMatches,
                enrolled: enrollmentStatus?.is_enrolled === true
            });
        }
        return JSON.stringify({ success: false, error: "No SDK command available to verify activity quest completion" });
    } catch (e) {
        return JSON.stringify({ success: false, error: describeError(e) });
    }
})()
`;
}

function parseFrameResult(raw) {
    if (raw == null) return null;
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { return { success: false, error: String(raw) }; }
}

export function findActivityIframe(applicationId) {
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
        const src = iframe.src || iframe.getAttribute("src") || "";
        if (!src.includes("discordsays.com")) continue;
        if (applicationId && !src.includes(applicationId)) continue;
        return iframe;
    }
    return null;
}

function throwActivityFrameError(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function isNativeAvailable() {
    const native = getNative();
    return !!(native?.execInActivityFrame && native?.hasActivityFrame);
}

async function nativeHasActivityFrame(applicationId) {
    try {
        return await getNative()?.hasActivityFrame?.(applicationId) ?? false;
    } catch {
        return false;
    }
}

export async function execInActivityFrame(applicationId, jsCode) {
    if (!isNativeAvailable()) {
        throwActivityFrameError(
            ActivityFrameErrorCode.NATIVE_REQUIRED,
            "Activity quests require a Vencord rebuild with native.ts. Run pnpm build and restart Discord."
        );
    }

    const native = getNative();
    let lastError = null;

    for (let attempt = 0; attempt < NATIVE_EXEC_RETRIES; attempt++) {
        try {
            const raw = await native.execInActivityFrame(applicationId, jsCode);
            if (raw != null) return parseFrameResult(raw);
        } catch (e) {
            lastError = e;
            throw new Error("Native activity frame execution failed: " + (e?.message || e));
        }

        if (attempt < NATIVE_EXEC_RETRIES - 1) {
            await new Promise(r => setTimeout(r, NATIVE_EXEC_RETRY_MS));
        }
    }

    if (lastError) {
        throw new Error("Native activity frame execution failed: " + (lastError?.message || lastError));
    }

    throwActivityFrameError(
        ActivityFrameErrorCode.FRAME_NOT_READY,
        "Activity frame not ready. Ensure the activity is fully loaded and authorized in Discord."
    );
}

export async function hasMatchingActivityFrame(applicationId) {
    if (!applicationId?.trim()) return false;
    if (!isNativeAvailable()) return false;
    return nativeHasActivityFrame(applicationId);
}

export async function launchQuestInDiscord(quest, log, t) {
    const questName = quest.config.messages?.questName || quest.id;
    await navigateToQuestPage(quest.id);
    await new Promise(r => setTimeout(r, 1500));
    if (clickLaunchQuestButton()) {
        log.success(`[${questName}] ${t("logLaunchFound")}`);
        return true;
    }
    log.warn(`[${questName}] ${t("logLaunchNotFound")}`);
    return false;
}

export async function waitForActivityIframe(applicationId, timeoutMs = IFRAME_WAIT_MS, isActive = () => true, opts = {}) {
    if (!isNativeAvailable()) return null;

    const { log, t, questName } = opts;
    let domLogged = false;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (!isActive()) return null;

        if (!domLogged && findActivityIframe(applicationId)) {
            domLogged = true;
            if (log && t && questName) {
                log.info(`[${questName}] ${t("logActivityDomFound")}`);
            }
        }

        if (await nativeHasActivityFrame(applicationId)) return true;
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

function formatActivityFrameError(error, t) {
    if (error?.code === ActivityFrameErrorCode.NATIVE_REQUIRED) {
        return t("logActivityNativeRequired");
    }
    if (error?.code === ActivityFrameErrorCode.FRAME_NOT_READY) {
        return t("logActivityFrameNotReady");
    }
    return error?.message || "unknown";
}

export async function navigateToQuestPage(questId) {
    const targetPath = `/quest-home#${encodeURIComponent(questId)}`;
    const currentFull = () => window.location.pathname + window.location.search + window.location.hash;

    if (currentFull() === targetPath) return true;

    let wpRequire = null;
    try {
        if (typeof webpackChunkdiscord_app !== "undefined") {
            wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
            webpackChunkdiscord_app.pop();
        }
    } catch (_) {}

    const findRouter = () => {
        if (!wpRequire?.c) return null;
        const seen = new Set();
        const inspect = value => {
            if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return null;
            seen.add(value);
            if (typeof value.transitionTo === "function" && (
                typeof value.replaceWith === "function" || typeof value.navigate === "function"
            )) return value;
            if (value.router?.transitionTo) return value.router;
            return null;
        };
        for (const m of Object.values(wpRequire.c)) {
            try {
                const exp = m?.exports;
                if (!exp) continue;
                const direct = inspect(exp);
                if (direct) return direct;
                for (const key of Object.keys(exp)) {
                    const result = inspect(exp[key]);
                    if (result) return result;
                }
            } catch (_) {}
        }
        return null;
    };

    const router = findRouter();
    if (router) {
        for (const method of ["transitionTo", "replaceWith", "navigate"]) {
            if (typeof router[method] === "function") {
                try {
                    await Promise.resolve(router[method](targetPath));
                    await new Promise(r => setTimeout(r, 500));
                    if (currentFull() === targetPath) return true;
                } catch (_) {}
            }
        }
    }

    try {
        window.history.pushState({}, "", targetPath);
        window.dispatchEvent(new PopStateEvent("popstate"));
        await new Promise(r => setTimeout(r, 500));
        return currentFull() === targetPath;
    } catch (_) {
        return false;
    }
}

function isPluginButton(btn) {
    return !!btn.closest("#dqm-gui, #dqm-mini-icon")
        || btn.classList.contains("dqm-action-launch");
}

export function clickLaunchQuestButton() {
    const launchText = /launch\s*quest|start\s*quest|ouvrir\s*la\s*qu[eê]te|quest\s*starten|iniciar\s*misi[oó]n|iniciar\s*quest|퀘е?ст|запустить/i;

    const allClickable = Array.from(document.querySelectorAll(
        "button, a[role='button'], div[role='button'], [data-mana-component='button']"
    )).filter(el => !isPluginButton(el));

    const byAria = allClickable.find(el => {
        const label = (el.getAttribute("aria-label") || "").trim();
        return /launch\s*quest/i.test(label) || /start\s*quest/i.test(label);
    });
    if (byAria) {
        byAria.click();
        return true;
    }

    const byText = allClickable.find(el => launchText.test((el.innerText || el.textContent || "").trim()));
    if (byText) {
        byText.click();
        return true;
    }

    // Fallback: any element with launch-quest-ish data attributes used by Discord quest-home
    const byAttr = document.querySelector(
        "[aria-label*='Launch Quest' i], [aria-label*='Start Quest' i]"
    );
    if (byAttr && !isPluginButton(byAttr)) {
        byAttr.click();
        return true;
    }

    return false;
}

export function generateCheckpointTimes(checkpointCount, minSecs, maxSecs) {
    const settings = getActivityCheckpointSettings();
    const min = minSecs ?? settings.minSecs;
    const max = maxSecs ?? settings.maxSecs;
    const safeMin = Math.min(min, max);
    const safeMax = Math.max(min, max);
    const times = [];
    for (let i = 0; i < checkpointCount; i++) {
        times.push(Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin);
    }
    return times;
}

export function showActivityLaunchDialog(t, onNavigate, onConfirm, onCancel) {
    const existing = document.getElementById("dqm-activity-launch-dialog");
    existing?.remove();

    const overlay = document.createElement("div");
    overlay.id = "dqm-activity-launch-dialog";
    overlay.className = "dqm-modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "dqm-modal";

    const title = document.createElement("h3");
    title.className = "dqm-modal-title";
    title.textContent = t("activityLaunchTitle");

    const desc = document.createElement("p");
    desc.className = "dqm-modal-desc";
    desc.textContent = t("activityLaunchDesc");

    const steps = document.createElement("ol");
    steps.className = "dqm-modal-steps";
    for (const key of ["activityLaunchStep1", "activityLaunchStep2", "activityLaunchStep3", "activityLaunchStep4", "activityLaunchStep5"]) {
        const li = document.createElement("li");
        li.textContent = t(key);
        steps.appendChild(li);
    }

    const errorEl = document.createElement("div");
    errorEl.className = "dqm-modal-error";
    errorEl.hidden = true;

    const footer = document.createElement("div");
    footer.className = "dqm-modal-footer";

    const close = () => overlay.remove();

    const navBtn = document.createElement("button");
    navBtn.className = "dqm-btn dqm-btn-gray";
    navBtn.textContent = t("activityLaunchNavigate");
    navBtn.onclick = async () => {
        navBtn.disabled = true;
        try {
            await onNavigate();
        } catch (e) {
            errorEl.textContent = t("activityLaunchNavigateError");
            errorEl.hidden = false;
        } finally {
            navBtn.disabled = false;
        }
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "dqm-btn dqm-btn-gray";
    cancelBtn.textContent = t("activityLaunchCancel");
    cancelBtn.onclick = () => { close(); onCancel?.(); };

    const startBtn = document.createElement("button");
    startBtn.className = "dqm-btn dqm-btn-blurple";
    startBtn.textContent = t("activityLaunchStart");
    startBtn.onclick = () => { close(); onConfirm?.(); };

    footer.append(navBtn, cancelBtn, startBtn);
    dialog.append(title, desc, steps, errorEl, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    return { close, setError: (msg) => { errorEl.textContent = msg; errorEl.hidden = !msg; } };
}

export function promptActivityLaunch(quest, t, onNavigateToQuest) {
    return new Promise((resolve, reject) => {
        showActivityLaunchDialog(
            t,
            async () => {
                if (onNavigateToQuest) {
                    await onNavigateToQuest(quest);
                    return;
                }
                const ok = await navigateToQuestPage(quest.id);
                if (!ok) throw new Error("navigation failed");
            },
            () => resolve(true),
            () => reject(new Error("cancelled"))
        );
    });
}

function formatInitResultError(initResult, t) {
    if (initResult?.errorCode === "WRONG_ACTIVITY" || initResult?.questInfoMismatched) {
        return t("logActivityWrongApp");
    }
    if (initResult?.errorCode === "AUTH_PENDING" || initResult?.errorCode === "QUEST_PENDING") {
        return t("logActivityAuthPending");
    }
    return initResult?.error || "unknown";
}

function isSdkNotReadyError(initResult) {
    const err = String(initResult?.error || "");
    return /Discord SDK not ready|window\.discordSDK missing|questStartTimer missing/i.test(err);
}

function isQuestNotReadyError(initResult) {
    if (initResult?.errorCode === "QUEST_PENDING") return true;
    const err = String(initResult?.error || "");
    return /Quest not found|"code":\s*4002/i.test(err);
}

function isInitRetryableError(initResult) {
    if (!initResult || initResult.success) return false;
    if (initResult.errorCode === "WRONG_ACTIVITY" || initResult.questInfoMismatched) return false;
    if (initResult.errorCode === "AUTH_PENDING" || initResult.errorCode === "QUEST_PENDING") return true;
    if (isSdkNotReadyError(initResult)) return true;
    if (isQuestNotReadyError(initResult)) return true;
    const err = String(initResult.error || "");
    return /not authenticated|invalid scope|"code":\s*4006/i.test(err);
}

async function initActivityWithRetry(applicationId, questId, taskState, sleep, log, t, questName, allowedQuestIds = []) {
    let initResult;
    let authPendingLogged = false;
    let lastRetryReason = null;

    for (let attempt = 1; attempt <= INIT_RETRY_ATTEMPTS; attempt++) {
        if (!taskState.active) return null;

        if (attempt === 1) {
            log.info(`[${questName}] ${t("logActivityInit")}`);
        } else if (lastRetryReason === "sdk") {
            log.info(`[${questName}] ${t("logActivitySdkWaiting")
                .replace("{n}", String(attempt))
                .replace("{max}", String(INIT_RETRY_ATTEMPTS))}`);
        } else {
            log.info(`[${questName}] ${t("logActivityInitRetry")
                .replace("{n}", String(attempt))
                .replace("{max}", String(INIT_RETRY_ATTEMPTS))}`);
        }

        try {
            await execInActivityFrame(applicationId, buildClickActivityStartJs());
        } catch (_) {}

        try {
            initResult = parseFrameResult(
                await execInActivityFrame(applicationId, buildInitActivityQuestJs(questId, allowedQuestIds))
            );
        } catch (e) {
            log.error(`[${questName}] ${t("logActivityInitFailed")}${formatActivityFrameError(e, t)}`);
            return null;
        }

        if (initResult?.success) return initResult;

        if (!isInitRetryableError(initResult)) {
            log.error(`[${questName}] ${t("logActivityInitFailed")}${formatInitResultError(initResult, t)}`);
            return null;
        }

        if (isSdkNotReadyError(initResult)) {
            lastRetryReason = "sdk";
        } else {
            lastRetryReason = "auth";
            if (!authPendingLogged) {
                log.warn(`[${questName}] ${t("logActivityAuthPending")}`);
                authPendingLogged = true;
            }
        }

        if (attempt >= INIT_RETRY_ATTEMPTS) {
            log.error(`[${questName}] ${t("logActivityInitFailed")}${formatInitResultError(initResult, t)}`);
            return null;
        }

        await sleep(INIT_RETRY_DELAY_MS);
    }

    return null;
}

function getServerCheckpointProgress(questId, taskName, checkpointCount, QuestsStore) {
    return resolveCompletedCheckpoints(questId, taskName, checkpointCount, QuestsStore);
}

async function pollServerCheckpointProgress(questId, taskName, checkpointCount, previousProgress, QuestsStore, sleep) {
    const deadline = Date.now() + SERVER_PROGRESS_POLL_MAX_MS;
    while (Date.now() < deadline) {
        await sleep(SERVER_PROGRESS_POLL_MS);
        const current = getServerCheckpointProgress(questId, taskName, checkpointCount, QuestsStore);
        if (current > previousProgress) return current;
    }
    return getServerCheckpointProgress(questId, taskName, checkpointCount, QuestsStore);
}

async function retryQuestStartTimer(applicationId, questId, sleep, log, t, questName) {
    for (let attempt = 1; attempt <= TIMER_RETRY_ATTEMPTS; attempt++) {
        log.info(`[${questName}] ${t("logActivityTimerRetry")
            .replace("{n}", String(attempt))
            .replace("{max}", String(TIMER_RETRY_ATTEMPTS))}`);
        try {
            const result = parseFrameResult(
                await execInActivityFrame(applicationId, buildQuestStartTimerOnlyJs(questId))
            );
            if (result?.success) {
                log.info(`[${questName}] questStartTimer succeeded on retry.`);
                return true;
            }
        } catch (_) {}
        if (attempt < TIMER_RETRY_ATTEMPTS) await sleep(TIMER_RETRY_DELAY_MS);
    }
    return false;
}

function estimateRemainingCheckpointSecs(checkpointTimes, fromIndex, waitElapsedSecs) {
    let total = Math.max(0, checkpointTimes[fromIndex] - waitElapsedSecs);
    for (let i = fromIndex + 1; i < checkpointTimes.length; i++) {
        total += checkpointTimes[i];
    }
    return total;
}

export function createActivityExecutors(deps) {
    const { apiPost, apiGet, sleep, log, t, updateQuestProgress, QuestsStore, FluxDispatcher } = deps;

    return {
        async playActivity(quest, taskState, taskName, secondsNeeded, secondsDone) {
            const questName = quest.config.messages?.questName || quest.id;
            const applicationId = resolveQuestApplicationId(quest, taskName);
            if (!applicationId) {
                log.error(`[${questName}] ${t("logActivityMissingAppId")}`);
                return false;
            }

            let done = secondsDone;
            while (taskState.active) {
                try {
                    const terminal = done >= secondsNeeded;
                    const body = terminal
                        ? { terminal: true }
                        : { application_id: applicationId, terminal: false };

                    const res = await apiPost({
                        url: `/quests/${quest.id}/heartbeat`,
                        body
                    });

                    const progress = Number(res.body?.progress?.PLAY_ACTIVITY?.value ?? 0);
                    if (Number.isFinite(progress)) done = progress;

                    log.running(`[${questName}] ${t("logActivity")}: ${Math.floor(done)}/${secondsNeeded}s`);
                    updateQuestProgress(quest.id, done, secondsNeeded);

                    if (res.body?.completed_at || done >= secondsNeeded) {
                        if (!terminal && taskState.active) {
                            await apiPost({
                                url: `/quests/${quest.id}/heartbeat`,
                                body: { terminal: true }
                            });
                        }
                        break;
                    }

                    await sleep(HEARTBEAT_INTERVAL_MS);
                } catch (e) {
                    log.error(`${t("logAPIError")}${e?.message || e}`);
                    throw e;
                }
            }
            return taskState.active;
        },

        async achievementActivity(quest, taskState, taskName, checkpointCount, initialCompletedCheckpoints, duplicateQuestIds = []) {
            const questName = quest.config.messages?.questName || quest.id;
            const applicationId = resolveQuestApplicationId(quest, taskName);
            let questId = quest.id;
            let completedCheckpoints = initialCompletedCheckpoints;
            const groupQuestIds = [...new Set([questId, ...(duplicateQuestIds ?? [])].map(String))];

            const remaining = Math.max(0, checkpointCount - completedCheckpoints);
            if (remaining === 0) {
                log.warn(`[${questName}] ${t("logActivityCheckpointsDone")}`);
                return true;
            }

            if (!applicationId) {
                log.error(`[${questName}] ${t("logActivityMissingAppId")}`);
                return false;
            }

            if (!isNativeAvailable()) {
                log.error(`[${questName}] ${t("logActivityNativeRequired")}`);
                return false;
            }

            log.info(`[${questName}] ${t("logWaitingForActivity")}${applicationId}`);
            const iframeReady = await waitForActivityIframe(
                applicationId,
                IFRAME_WAIT_MS,
                () => taskState.active,
                { log, t, questName }
            );
            if (!iframeReady) {
                log.error(`[${questName}] ${t("logActivityFrameNotReady")} (${applicationId}) ${t("logActivityWaitHint")}`);
                return false;
            }

            const initResult = await initActivityWithRetry(
                applicationId, questId, taskState, sleep, log, t, questName, groupQuestIds
            );
            if (!initResult) return false;

            const effectiveFromInit = initResult.effectiveQuestId || initResult.boundQuestId;
            if (effectiveFromInit && groupQuestIds.includes(String(effectiveFromInit))) {
                questId = String(effectiveFromInit);
            }

            if (initResult.startTimerIgnored) {
                log.warn(`[${questName}] ${t("logActivityStartTimerIgnored")}${initResult.startTimerError || ""}`);
                const timerOk = await retryQuestStartTimer(applicationId, questId, sleep, log, t, questName);
                if (!timerOk) {
                    log.error(`[${questName}] ${t("logActivityTimerRequired")}`);
                    return false;
                }
            }

            const freshCompleted = await resolveCompletedCheckpointsAsync(
                questId, taskName, checkpointCount, QuestsStore, apiGet, groupQuestIds
            );
            if (freshCompleted > completedCheckpoints) {
                completedCheckpoints = freshCompleted;
                log.info(`[${questName}] ${t("logActivityResumeCheckpoints")
                    .replace("{done}", String(completedCheckpoints))
                    .replace("{total}", String(checkpointCount))}`);
                updateQuestProgress(quest.id, completedCheckpoints, checkpointCount);
            }

            const remainingAfterInit = Math.max(0, checkpointCount - completedCheckpoints);
            if (remainingAfterInit === 0) {
                log.warn(`[${questName}] ${t("logActivityCheckpointsDone")}`);
                return true;
            }

            const { minSecs, maxSecs } = getActivityCheckpointSettings();
            const allTimes = generateCheckpointTimes(checkpointCount, minSecs, maxSecs);
            const checkpointTimes = allTimes.slice(completedCheckpoints);
            const totalPlanSecs = checkpointTimes.reduce((sum, secs) => sum + secs, 0);
            log.info(`[${questName}] ${t("logActivityCheckpointPlan")
                .replace("{count}", String(checkpointTimes.length))
                .replace("{min}", String(minSecs))
                .replace("{max}", String(maxSecs))
                .replace("{mins}", String(Math.ceil(totalPlanSecs / 60)))}`);

            updateQuestProgress(quest.id, completedCheckpoints, checkpointCount, {
                etaSecs: totalPlanSecs
            });

            let serverProgress = await resolveCompletedCheckpointsAsync(
                questId, taskName, checkpointCount, QuestsStore, apiGet, groupQuestIds
            );
            const progressAtStart = serverProgress;
            let stalledDispatches = 0;

            const onHeartbeat = (data) => {
                if (!taskState.active) return;
                const eventQuestId = data?.questId ?? data?.quest?.id ?? data?.quest_id;
                if (eventQuestId && !groupQuestIds.some(id => String(id) === String(eventQuestId))) return;
                const us = data?.userStatus ?? data?.user_status;
                if (!us?.progress) return;
                const vals = Object.values(us.progress);
                const val = vals[0]?.value;
                if (val == null) return;
                const progress = Math.min(checkpointCount, Math.max(0, Math.floor(val)));
                serverProgress = Math.max(serverProgress, progress);
                updateQuestProgress(quest.id, serverProgress, checkpointCount);
            };
            if (FluxDispatcher?.subscribe) {
                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
                taskState.addUnsub(() => {
                    try { FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat); } catch (_) {}
                });
            }

            for (let i = 0; i < checkpointTimes.length; i++) {
                if (!taskState.active) return false;

                const checkpointNum = completedCheckpoints + i + 1;
                const isLast = checkpointNum >= checkpointCount;
                const waitSecs = checkpointTimes[i];

                log.info(`[${questName}] ${t("logCheckpointWait")}${checkpointNum}/${checkpointCount} (${waitSecs}s)`);

                const waitStart = Date.now();
                let lastFeedbackAt = waitStart;
                while (Date.now() - waitStart < waitSecs * 1000) {
                    if (!taskState.active) return false;

                    const elapsedSecs = Math.floor((Date.now() - waitStart) / 1000);
                    const remainingSecs = Math.max(0, waitSecs - elapsedSecs);
                    const etaSecs = estimateRemainingCheckpointSecs(checkpointTimes, i, elapsedSecs);

                    if (Date.now() - lastFeedbackAt >= CHECKPOINT_WAIT_FEEDBACK_MS) {
                        lastFeedbackAt = Date.now();
                        log.info(`[${questName}] ${t("logCheckpointWaitRemaining")
                            .replace("{n}", String(checkpointNum))
                            .replace("{total}", String(checkpointCount))
                            .replace("{secs}", String(remainingSecs))}`);
                        updateQuestProgress(
                            quest.id,
                            Math.max(completedCheckpoints, serverProgress),
                            checkpointCount,
                            { etaSecs }
                        );
                    }

                    await sleep(1000);
                }

                if (!taskState.active) return false;

                log.running(`[${questName}] ${t("logCheckpoint")}${checkpointNum}/${checkpointCount}`);

                let dispatchResult;
                try {
                    if (isLast) {
                        const completedPayload = JSON.stringify({ quest_id: questId, completed: true });
                        const completedJs = buildDispatchMessageEventJs("quest-completed", completedPayload);
                        dispatchResult = parseFrameResult(await execInActivityFrame(applicationId, completedJs));
                    } else {
                        const progressJs = buildDispatchMessageEventJs("quest-progress", String(checkpointNum));
                        dispatchResult = parseFrameResult(await execInActivityFrame(applicationId, progressJs));
                    }
                } catch (e) {
                    log.error(`[${questName}] ${t("logActivityInitFailed")}${formatActivityFrameError(e, t)}`);
                    return false;
                }

                if (dispatchResult?.success) {
                    log.info(`[${questName}] ${t("logActivityDispatchOk")}`);
                } else {
                    log.warn(`[${questName}] ${t("logActivityDispatchFailed")}${dispatchResult?.error || "unknown"}`);
                }

                const progressBeforePoll = serverProgress;
                let polledProgress = progressBeforePoll;
                for (const id of groupQuestIds) {
                    polledProgress = Math.max(
                        polledProgress,
                        await pollServerCheckpointProgress(
                            id, taskName, checkpointCount, polledProgress, QuestsStore, sleep
                        )
                    );
                }
                const apiPolled = await fetchBestProgressForGroup(groupQuestIds, apiGet);
                const confirmedProgress = Math.max(polledProgress, apiPolled);
                if (dispatchResult?.success) {
                    const displayProgress = Math.max(serverProgress, confirmedProgress);
                    serverProgress = displayProgress;
                    updateQuestProgress(quest.id, displayProgress, checkpointCount);
                    if (confirmedProgress > progressBeforePoll) {
                        stalledDispatches = 0;
                        log.info(`[${questName}] ${t("logActivityServerProgress")
                            .replace("{n}", String(confirmedProgress))
                            .replace("{total}", String(checkpointCount))}`);
                    } else {
                        stalledDispatches += 1;
                        log.warn(`[${questName}] ${t("logActivityServerProgressPending")}`);
                        if (stalledDispatches >= 2 && confirmedProgress <= progressAtStart) {
                            log.error(`[${questName}] ${t("logActivityProgressStalled")}`);
                            return false;
                        }
                    }
                }
            }

            if (serverProgress >= checkpointCount) {
                updateQuestProgress(quest.id, checkpointCount, checkpointCount);
                return true;
            }

            log.info(`[${questName}] ${t("logActivityVerify")}`);
            for (let attempt = 0; attempt < 6; attempt++) {
                if (!taskState.active) return false;

                let status;
                try {
                    status = parseFrameResult(
                        await execInActivityFrame(applicationId, buildCheckActivityQuestStatusJs(questId))
                    );
                } catch (e) {
                    log.error(`[${questName}] ${t("logActivityInitFailed")}${formatActivityFrameError(e, t)}`);
                    return false;
                }
                if (status?.completed) {
                    updateQuestProgress(quest.id, checkpointCount, checkpointCount);
                    return true;
                }

                for (const id of groupQuestIds) {
                    const live = QuestsStore.quests.get(id);
                    if (live?.userStatus?.completedAt) {
                        updateQuestProgress(quest.id, checkpointCount, checkpointCount);
                        return true;
                    }
                }

                const liveProgress = await resolveCompletedCheckpointsAsync(
                    questId, taskName, checkpointCount, QuestsStore, apiGet, groupQuestIds
                );
                if (liveProgress >= checkpointCount) {
                    updateQuestProgress(quest.id, checkpointCount, checkpointCount);
                    return true;
                }

                await sleep(2000);
            }

            log.warn(`[${questName}] ${t("logActivityVerifyPending")}`);
            log.error(`[${questName}] ${t("logActivityVerifyFailed")}`);
            return false;
        }
    };
}
