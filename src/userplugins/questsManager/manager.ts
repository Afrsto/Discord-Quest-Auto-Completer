// @ts-nocheck
/*
 * Quests Manager — ported from console script for Vencord
 */

import { findByPropsLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher as FluxDispatcherCommon, RestAPI } from "@webpack/common";

import {
    createActivityExecutors,
    getActivityCheckpointAvgSecs,
    getQuestCompletionFlags,
    getTaskConfig as getSharedTaskConfig,
    isAchievementActivityTask,
    isLaunchQuestTask,
    isQuestExpired,
    normalizeQuestUserStatus,
    promptActivityLaunch,
    hasMatchingActivityFrame,
    launchQuestInDiscord,
    readActivityCheckpointProgress,
    resolveCompletedCheckpointsAsync,
    resolveQuestApplicationId
} from "./activityQuest";
import regionsSnapshotFile from "./regions.snapshot.json";
import {
    applyPluginUpdate,
    checkForPluginUpdate,
    getPluginVersionLabel,
    getReleasesPageUrl
} from "./updater";
import { PLUGIN_VERSION_LABEL } from "./version";

declare const DiscordNative: any;

try {
    const snap = regionsSnapshotFile?.byId || regionsSnapshotFile;
    if (snap && typeof snap === "object") {
        (globalThis as any).__DQM_REGIONS_SNAPSHOT = snap;
    }
} catch (_) {}

const QuestsStoreLazy = findByPropsLazy("getQuest");
const RunningGameStoreLazy = findStoreLazy("RunningGameStore");
const ApplicationStreamingStoreLazy = findStoreLazy("ApplicationStreamingStore");
const ChannelStoreLazy = findStoreLazy("ChannelStore");
const GuildChannelStoreLazy = findStoreLazy("GuildChannelStore");

type Stores = {
    QuestsStore: any;
    RunningGameStore: any;
    ApplicationStreamingStore: any;
    ChannelStore: any;
    GuildChannelStore: any;
    FluxDispatcher: any;
    api: any;
};

function resolveStores(): Stores {
    return {
        QuestsStore: QuestsStoreLazy,
        RunningGameStore: RunningGameStoreLazy,
        ApplicationStreamingStore: ApplicationStreamingStoreLazy,
        ChannelStore: ChannelStoreLazy,
        GuildChannelStore: GuildChannelStoreLazy,
        FluxDispatcher: FluxDispatcherCommon,
        api: RestAPI,
    };
}

let mounted = false;
let panelHidden = false;

export function isQuestsManagerOpen() {
    return mounted && !panelHidden && !!document.getElementById("dqm-gui");
}

export function toggleQuestsManager() {
    if (isQuestsManagerOpen()) {
        hidePanel();
        return;
    }
    if (mounted && panelHidden) {
        showPanel();
        return;
    }
    mountQuestsManager();
}

export function unmountQuestsManager() {
    if (typeof (globalThis as any).__DQM_UNMOUNT === "function") {
        try { (globalThis as any).__DQM_UNMOUNT(); } catch (_) {}
    }
    mounted = false;
    panelHidden = false;
}

function hidePanel() {
    const g = document.getElementById("dqm-gui") as HTMLElement | null;
    const mini = document.getElementById("dqm-mini-icon") as HTMLElement | null;
    if (g) g.style.display = "none";
    if (mini) mini.style.display = "none";
    panelHidden = true;
}

function showPanel() {
    const g = document.getElementById("dqm-gui") as HTMLElement | null;
    const mini = document.getElementById("dqm-mini-icon") as HTMLElement | null;
    if (g) {
        g.style.display = "flex";
        if (mini) mini.style.display = "none";
        panelHidden = false;
        return;
    }
    mountQuestsManager();
}

export function mountQuestsManager() {
    if (mounted && document.getElementById("dqm-gui")) {
        showPanel();
        return;
    }

    if (typeof (globalThis as any).__DQM_UNMOUNT === "function") {
        try { (globalThis as any).__DQM_UNMOUNT(); } catch (_) {}
    }

    const stores = resolveStores();

    let ApplicationStreamingStore = stores.ApplicationStreamingStore;
    let RunningGameStore = stores.RunningGameStore;
    let QuestsStore = stores.QuestsStore;
    let ChannelStore = stores.ChannelStore;
    let GuildChannelStore = stores.GuildChannelStore;
    let FluxDispatcher = stores.FluxDispatcher;
    let api = stores.api;

    const missing = [];
    if (!QuestsStore) missing.push("QuestsStore");
    if (!api) missing.push("API");
    if (!FluxDispatcher) missing.push("FluxDispatcher");
    if (!RunningGameStore) missing.push("RunningGameStore (desktop play)");
    if (!ApplicationStreamingStore) missing.push("ApplicationStreamingStore (stream)");
    if (!ChannelStore) missing.push("ChannelStore (stream)");
    if (!GuildChannelStore) missing.push("GuildChannelStore (stream)");

    const LOG_CAP = 200;
    const API_RETRIES = 3;
    const API_RETRY_BASE_MS = 600;
    const supportedTasks = new Set([
        "WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP",
        "PLAY_ACTIVITY", "ACHIEVEMENT_IN_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"
    ]);
    const isApp = typeof DiscordNative !== "undefined";

    let currentFilter = "incomplete";
    let currentCountryFilter = "all";
    let currentLang = "en";
    let batchStopRequested = false;
    let batchRunning = false;


    let gui = null;
    let logBox = null;
    let listContainer = null;
    let emptyStateEl = null;
    let miniIcon = null;
    let batchStrip = null;
    let stopAllBtn = null;


    const dqmTasks = new Map();
    const questRuntime = new Map();
    const cardByQuestId = new Map();
    const orbsCache = new Map();
    const activeCleanups = new Set();
    let gameDetectHold = null;
    let userOrbsBalance = null;
    const claimsInFlight = new Set();
    const acceptsInFlight = new Set();
    const launchesInFlight = new Set();

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));


    const showFatalPanel = (lines) => {
        document.getElementById("dqm-gui")?.remove();
        document.getElementById("dqm-gui-slynxe")?.remove();
        const el = document.createElement("div");
        el.id = "dqm-gui";
        el.style.cssText = "position:fixed;top:80px;right:24px;z-index:999999;width:420px;padding:20px;border-radius:14px;background:#1e1f22;color:#f2f3f5;font-family:gg sans,Helvetica,Arial,sans-serif;border:1px solid #5865F2;box-shadow:0 12px 40px rgba(0,0,0,.55);";
        el.innerHTML = `<div style="font-weight:700;font-size:16px;margin-bottom:8px;">Quests Manager</div>`;
        const p = document.createElement("div");
        p.style.cssText = "font-size:13px;color:#b5bac1;line-height:1.5;white-space:pre-wrap;";
        p.textContent = lines.join("\n");
        el.appendChild(p);
        const close = document.createElement("button");
        close.textContent = "Close";
        close.style.cssText = "margin-top:14px;background:#5865F2;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-weight:600;";
        close.onclick = () => el.remove();
        el.appendChild(close);
        document.body.appendChild(el);
    };

    if (!QuestsStore || !api) {
        showFatalPanel([
            "Critical Discord modules not found.",
            "Missing: " + missing.filter(m => m === "QuestsStore" || m === "API").join(", "),
            "Discord may have updated. Reopen Discord and try again."
        ]);
        return;
    }


    const i18n = {
        en: {
            title: "Quests Manager",
            btnComplete: "Complete All",
            btnStopAll: "Stop All",
            btnRefresh: "Refresh",
            btnCopy: "Copy logs",
            btnLang: "عربي",
            btnMinimize: "Minimize",
            btnClose: "Close",
            tabIncomplete: "Incomplete",
            tabClaimable: "Claimable",
            tabComplete: "Completed",
            logReady: "Ready. Rework by X2 Salah.",
            logReadyServer: "Discord Server: https://discord.gg/btRCeujadA",
            statusNotEnrolled: "Not enrolled",
            statusInProgress: "In progress",
            statusCompleted: "Completed (Claim)",
            statusClaimable: "Ready to claim",
            statusClaimed: "Claimed",
            btnCheckUpdate: "Check update",
            btnApplyUpdate: "Update now",
            updateChecking: "Checking for updates…",
            updateLatest: "Up to date",
            updateAvailable: "Update available: {tag}",
            updateApplying: "Installing update…",
            updateDone: "Update installed. Restart Discord to finish.",
            updateFailed: "Update failed: ",
            updateCheckFailed: "Update check failed: ",
            statusRunning: "Running",
            statusStopped: "Stopped",
            statusError: "Error",
            btnClaim: "Claim reward",
            btnStart: "Start",
            btnStop: "Stop",
            btnOpenDiscord: "Open in Discord",
            btnActivate: "Activate",
            btnActivating: "Activating...",
            logActivateClick: "Activating quest...",
            logActivateSuccess: "Quest activated.",
            logActivateFailed: "Activation failed: ",
            logAlreadyRunning: "Quest already being processed.",
            logCompleted: "Completed!",
            logAPIError: "API error: ",
            logNoQuests: "No incomplete quests to execute.",
            logBatchStart: "Starting automatic execution for ",
            logBatchEnd: " quest(s)…",
            logAllDone: "All quests processed.",
            logExecStart: "Starting execution (type: ",
            logExecImpossible: "Impossible: use Discord Desktop app.",
            logSpoofGame: "Spoofed game: ",
            logSpoofWait: ". Wait ",
            logSpoofMinutes: " more minutes.",
            logSpoofStream: "Spoofed stream for ",
            logSpoofStreamNote: ". Stream any window in VC for ",
            logSpoofVCNote: " more minutes. Need at least 1 other person in VC.",
            logTaskNotSupported: "Task type not supported: ",
            logError: "Error: ",
            logVideo: "Video",
            logGame: "Game",
            logActivity: "Activity",
            logStream: "Stream",
            logCopySuccess: "Logs copied to clipboard!",
            logCopyError: "Failed to copy logs.",
            logNoData: "No local data found.",
            logNoCategory: "No quests in this category.",
            logRefresh: "Refreshed.",
            logUnknownError: "Unknown error.",
            logStackTrace: "Stack: ",
            progressLabel: "Progress",
            progressLabelCheckpoints: "checkpoints",
            logNotEnrolled: "Quest not enrolled. Skipping.",
            logLaunchClick: "Opening quest page in Discord…",
            logLaunchFound: "Discord Launch Quest button clicked.",
            logLaunchNotFound: "Discord Launch Quest button not found on quest page.",
            logClaimClick: "Attempting to claim reward…",
            logClaimFound: "Reward claimed successfully.",
            logClaimNotFound: "Could not claim reward automatically.",
            logClaimMarked: "Reward confirmed.",
            logClaimPending: "Claim submitted — waiting for Discord to confirm…",
            logClaimManual: "Claim failed. Please claim manually in the Quests tab.",
            logClaimAlready: "Reward already claimed.",
            logClaimNotReady: "Quest not completed yet.",
            logStopped: "Stopped.",
            logStopAll: "Stop All requested — finishing current cleanup…",
            logStopGameHold: "Play Game paused in Quests Manager. If the real game is still open on your PC, Discord may keep adding progress — close the game to fully pause.",
            logBatchSummary: "Batch summary — ok: ",
            logBatchSkipped: ", skipped: ",
            logBatchFailed: ", failed: ",
            logNoVoice: "No voice channel found.",
            labelType: "Type",
            labelOrbs: "Orbs",
            labelStatus: "Status",
            labelEnds: "Ends",
            labelCountry: "Country",
            countryGlobal: "Global",
            countryDetecting: "Detecting…",
            countryUnknown: "Unknown",
            countryExcept: "Global −{codes}",
            countrySourceCatalog: "Source: catalog",
            countrySourceInferred: "Source: inferred (VPN/IP)",
            countrySourceOverride: "Source: manual override",
            countrySourceUnknown: "Source: unknown",
            countryFilterAll: "All countries",
            countryFilterGlobal: "Global",
            countryFilterUnknown: "Unknown",
            labelCountryFilter: "Filter by country",
            labelYourLocation: "Location",
            labelEta: "ETA",
            statQuests: "Quests",
            statOrbs: "Orbs",
            statRunning: "Running",
            batchPreparing: "Preparing…",
            batchProgress: "Quest {i} of {n}",
            batchCurrent: "Current: ",
            batchOverall: "Overall",
            typeVideo: "Video",
            typePlay: "Play Game",
            typeStream: "Stream",
            typeLaunch: "Launch Quest",
            typeOther: "Other",
            warnPartialModules: "Some optional modules missing (desktop/stream/activity may be limited).",
            activityLaunchTitle: "Launch Activity Quest",
            activityLaunchDesc: "This quest requires launching a Discord Activity. Follow these steps:",
            activityLaunchStep1: "Navigate to the quest page in Discord",
            activityLaunchStep2: "Click 'Launch Quest' in Discord to open the Activity",
            activityLaunchStep3: "Complete any authorization prompts in Discord",
            activityLaunchStep4: "Return here and click 'Start Quest' to begin checkpoints",
            activityLaunchStep5: "If the activity shows a START button, click it inside the activity window",
            activityLaunchStart: "Start Quest",
            activityLaunchCancel: "Cancel",
            activityLaunchNavigate: "Open Quest in Discord",
            activityLaunchNavigateError: "Could not navigate to the quest page in Discord.",
            logCheckpoint: "Checkpoint ",
            logCheckpointWait: "Waiting for checkpoint ",
            logWaitingForActivity: "Waiting for activity iframe…",
            logActivityNotFound: "Activity not found. Click Launch Quest in Discord and authorize the activity.",
            logActivityInit: "Initializing activity SDK…",
            logActivityInitFailed: "Activity SDK init failed: ",
            logActivityVerify: "Verifying quest completion…",
            logActivityVerifyPending: "Checkpoints submitted — waiting for Discord to confirm completion.",
            logActivityVerifyFailed: "Discord never confirmed completion. Progress stayed unchanged — not marking as completed.",
            logActivityCheckpointsDone: "All checkpoints already submitted.",
            logActivityMissingAppId: "Activity quest is missing an application ID.",
            logActivityLaunchFirst: "Launching quest in Discord…",
            logActivityNativeRequired: "Activity quests require a Vencord rebuild with native.ts. Run pnpm build and restart Discord.",
            logActivityFrameNotReady: "Activity frame not ready. Ensure the activity is fully loaded and authorized in Discord.",
            logActivityWrongApp: "Wrong activity is open. Close other activities and launch this quest's activity first.",
            logActivityAuthPending: "Activity not authorized yet. Complete Discord authorization prompts, then click Start again.",
            logActivityInitRetry: "Waiting for activity authorization… (attempt {n}/{max})",
            logActivitySdkWaiting: "Waiting for activity SDK… (attempt {n}/{max})",
            logActivityStartTimerIgnored: "questStartTimer was skipped but quest context is valid; continuing with checkpoints. ",
            logActivityTimerRequired: "questStartTimer never succeeded. Aborting — Discord will not accept checkpoints without an active quest timer.",
            logActivityLaunching: "Launching quest in Discord…",
            logActivityDomFound: "Activity iframe visible in Discord — waiting for native frame access…",
            logActivityWaitHint: "If this times out, click Open in Discord, complete Launch Quest + authorization, then try Start again.",
            logActivityCheckpointPlan: "{count} checkpoints × {min}–{max}s ≈ {mins} min total",
            logCheckpointWaitRemaining: "Checkpoint {n}/{total} — {secs}s remaining",
            logActivityDispatchOk: "Checkpoint event dispatched successfully.",
            logActivityDispatchFailed: "Checkpoint event dispatch failed: ",
            logActivityServerProgress: "Discord confirmed checkpoint progress: {n}/{total}",
            logActivityServerProgressPending: "Checkpoint dispatched but Discord progress unchanged — quest timer may not be active.",
            logActivityProgressStalled: "Discord progress still unchanged after multiple checkpoints. Aborting to avoid a false completion.",
            logActivityResumeCheckpoints: "Resuming from checkpoint {done}/{total}",
            logActivityTimerRetry: "Retrying questStartTimer… (attempt {n}/{max})",
            settingsCheckpointMin: "Checkpoint min",
            settingsCheckpointMax: "Checkpoint max",
            settingsCheckpointUnit: "s",
            settingsCheckpointHint: "Activity quest wait between checkpoints (30–600s). Applies on next Start.",
            labelMergedListings: "{n} listings merged"
        },
        ar: {
            title: "مدير المهام",
            btnComplete: "إكمال الكل",
            btnStopAll: "إيقاف الكل",
            btnRefresh: "تحديث",
            btnCopy: "نسخ السجلات",
            btnLang: "English",
            btnMinimize: "تصغير",
            btnClose: "إغلاق",
            tabIncomplete: "غير مكتملة",
            tabClaimable: "قابلة للاستلام",
            tabComplete: "مكتملة",
            logReady: "جاهز. إعادة تصميم بواسطة X2 Salah.",
            logReadyServer: "سيرفر ديسكورد: https://discord.gg/btRCeujadA",
            statusNotEnrolled: "لم يتم الالتحاق",
            statusInProgress: "قيد التنفيذ",
            statusCompleted: "مكتملة (استلام)",
            statusClaimable: "جاهزة للاستلام",
            statusClaimed: "تم الاستلام",
            btnCheckUpdate: "تحقق من التحديث",
            btnApplyUpdate: "حدّث الآن",
            updateChecking: "جارٍ التحقق من التحديثات…",
            updateLatest: "أنت على أحدث إصدار",
            updateAvailable: "يتوفر تحديث: {tag}",
            updateApplying: "جارٍ تثبيت التحديث…",
            updateDone: "تم التثبيت. أعد تشغيل ديسكورد للإكمال.",
            updateFailed: "فشل التحديث: ",
            updateCheckFailed: "فشل التحقق من التحديث: ",
            statusRunning: "قيد التشغيل",
            statusStopped: "متوقفة",
            statusError: "خطأ",
            btnClaim: "استلام المكافأة",
            btnStart: "بدء",
            btnStop: "إيقاف",
            btnOpenDiscord: "فتح في ديسكورد",
            btnActivate: "تفعيل",
            btnActivating: "جاري التفعيل...",
            logActivateClick: "جاري تفعيل المهمة...",
            logActivateSuccess: "تم تفعيل المهمة.",
            logActivateFailed: "فشل التفعيل: ",
            logAlreadyRunning: "المهمة قيد المعالجة بالفعل.",
            logCompleted: "مكتملة!",
            logAPIError: "خطأ في API: ",
            logNoQuests: "لا توجد مهام غير مكتملة.",
            logBatchStart: "بدء التنفيذ لـ ",
            logBatchEnd: " مهمة(مهام)…",
            logAllDone: "تمت معالجة جميع المهام.",
            logExecStart: "بدء التنفيذ (النوع: ",
            logExecImpossible: "غير ممكن: استخدم تطبيق ديسكورد المكتبي.",
            logSpoofGame: "تم محاكاة اللعبة: ",
            logSpoofWait: ". انتظر ",
            logSpoofMinutes: " دقائق إضافية.",
            logSpoofStream: "تم محاكاة البث لـ ",
            logSpoofStreamNote: ". قم ببث أي نافذة في غرفة صوتية لمدة ",
            logSpoofVCNote: " دقائق إضافية. تحتاج شخص واحد آخر على الأقل.",
            logTaskNotSupported: "نوع المهمة غير مدعوم: ",
            logError: "خطأ: ",
            logVideo: "فيديو",
            logGame: "لعبة",
            logActivity: "نشاط",
            logStream: "بث",
            logCopySuccess: "تم نسخ السجلات!",
            logCopyError: "فشل النسخ.",
            logNoData: "لا توجد بيانات.",
            logNoCategory: "لا توجد مهام في هذه الفئة.",
            logRefresh: "تم التحديث.",
            logUnknownError: "خطأ غير معروف.",
            logStackTrace: "تتبع المكدس: ",
            progressLabel: "التقدم",
            progressLabelCheckpoints: "نقاط تفتيش",
            logNotEnrolled: "المهمة غير مسجلة. تخطي.",
            logLaunchClick: "جاري فتح صفحة المهمة في ديسكورد…",
            logLaunchFound: "تم النقر على زر تشغيل المهمة في ديسكورد.",
            logLaunchNotFound: "لم يتم العثور على زر تشغيل المهمة في صفحة المهمة.",
            logClaimClick: "محاولة استلام المكافأة…",
            logClaimFound: "تم استلام المكافأة بنجاح.",
            logClaimNotFound: "تعذر استلام المكافأة تلقائيًا.",
            logClaimMarked: "تم تأكيد المكافأة.",
            logClaimPending: "تم إرسال الاستلام — بانتظار تأكيد ديسكورد…",
            logClaimManual: "فشل الاستلام. يرجى الاستلام يدويًا من تبويب المهام.",
            logClaimAlready: "تم استلام المكافأة مسبقًا.",
            logClaimNotReady: "المهمة غير مكتملة بعد.",
            logStopped: "تم الإيقاف.",
            logStopAll: "تم طلب إيقاف الكل — جاري التنظيف…",
            logStopGameHold: "تم إيقاف اللعب في مدير المهام. إذا كانت اللعبة لا تزال مفتوحة على جهازك، قد يستمر ديسكورد في التقدم — أغلق اللعبة للإيقاف الكامل.",
            logBatchSummary: "ملخص الدفعة — نجح: ",
            logBatchSkipped: "، تخطي: ",
            logBatchFailed: "، فشل: ",
            logNoVoice: "لم يتم العثور على قناة صوتية.",
            labelType: "النوع",
            labelOrbs: "الأورب",
            labelStatus: "الحالة",
            labelEnds: "ينتهي",
            labelCountry: "الدولة",
            countryGlobal: "عام",
            countryDetecting: "جاري الاكتشاف…",
            countryUnknown: "غير معروف",
            countryExcept: "عام −{codes}",
            countrySourceCatalog: "المصدر: الكتالوج",
            countrySourceInferred: "المصدر: استنتاج (VPN/IP)",
            countrySourceOverride: "المصدر: تجاوز يدوي",
            countrySourceUnknown: "المصدر: غير معروف",
            countryFilterAll: "كل الدول",
            countryFilterGlobal: "عام",
            countryFilterUnknown: "غير معروف",
            labelCountryFilter: "تصفية حسب الدولة",
            labelYourLocation: "موقعك",
            labelEta: "الوقت المتبقي",
            statQuests: "المهام",
            statOrbs: "الأورب",
            statRunning: "قيد التشغيل",
            batchPreparing: "جاري التحضير…",
            batchProgress: "مهمة {i} من {n}",
            batchCurrent: "الحالية: ",
            batchOverall: "الإجمالي",
            typeVideo: "فيديو",
            typePlay: "لعب",
            typeStream: "بث",
            typeLaunch: "تشغيل مهمة",
            typeOther: "أخرى",
            warnPartialModules: "بعض الوحدات الاختيارية غير موجودة (قد يُقيَّد اللعب/البث/النشاط).",
            activityLaunchTitle: "تشغيل مهمة النشاط",
            activityLaunchDesc: "تتطلب هذه المهمة تشغيل نشاط ديسكورد. اتبع الخطوات التالية:",
            activityLaunchStep1: "انتقل إلى صفحة المهمة في ديسكورد",
            activityLaunchStep2: "انقر على 'تشغيل المهمة' في ديسكورد لفتح النشاط",
            activityLaunchStep3: "أكمل أي مطالبات تفويض في ديسكورد",
            activityLaunchStep4: "عد هنا وانقر على 'بدء المهمة' لبدء نقاط التفتيش",
            activityLaunchStep5: "إذا ظهر زر START داخل النشاط، انقر عليه في نافذة النشاط",
            activityLaunchStart: "بدء المهمة",
            activityLaunchCancel: "إلغاء",
            activityLaunchNavigate: "فتح المهمة في ديسكورد",
            activityLaunchNavigateError: "تعذر الانتقال إلى صفحة المهمة في ديسكورد.",
            logCheckpoint: "نقطة تفتيش ",
            logCheckpointWait: "انتظار نقطة التفتيش ",
            logWaitingForActivity: "بانتظار إطار النشاط…",
            logActivityNotFound: "لم يتم العثور على النشاط. انقر على تشغيل المهمة في ديسكورد وقم بالتفويض.",
            logActivityInit: "جاري تهيئة SDK للنشاط…",
            logActivityInitFailed: "فشل تهيئة SDK للنشاط: ",
            logActivityVerify: "جاري التحقق من إكمال المهمة…",
            logActivityVerifyPending: "تم إرسال نقاط التفتيش — بانتظار تأكيد ديسكورد.",
            logActivityVerifyFailed: "لم يؤكد ديسكورد الإكمال. بقي التقدم دون تغيير — لن يتم اعتبار المهمة مكتملة.",
            logActivityCheckpointsDone: "تم إرسال جميع نقاط التفتيش مسبقًا.",
            logActivityMissingAppId: "مهمة النشاط تفتقد معرف التطبيق.",
            logActivityLaunchFirst: "جاري تشغيل المهمة في ديسكورد…",
            logActivityNativeRequired: "مهام النشاط تتطلب إعادة بناء Vencord مع native.ts. شغّل pnpm build وأعد تشغيل ديسكورد.",
            logActivityFrameNotReady: "إطار النشاط غير جاهز. تأكد من تحميل النشاط بالكامل والتفويض في ديسكورد.",
            logActivityWrongApp: "نشاط خاطئ مفتوح. أغلق الأنشطة الأخرى وشغّل نشاط هذه المهمة أولاً.",
            logActivityAuthPending: "النشاط غير مُصرَّح به بعد. أكمل مطالبات التفويض في ديسكورد، ثم انقر على ابدأ مرة أخرى.",
            logActivityInitRetry: "بانتظار تفويض النشاط… (محاولة {n}/{max})",
            logActivitySdkWaiting: "بانتظار SDK للنشاط… (محاولة {n}/{max})",
            logActivityStartTimerIgnored: "تم تخطي questStartTimer لكن سياق المهمة صالح؛ متابعة نقاط التفتيش. ",
            logActivityTimerRequired: "فشل questStartTimer. تم الإيقاف — لن يقبل ديسكورد نقاط التفتيش بدون مؤقت مهمة نشط.",
            logActivityLaunching: "جاري تشغيل المهمة في ديسكورد…",
            logActivityDomFound: "إطار النشاط ظاهر في ديسكورد — بانتظار الوصول الأصلي للإطار…",
            logActivityWaitHint: "إذا انتهت المهلة، انقر على فتح في ديسكورد، أكمل تشغيل المهمة والتفويض، ثم حاول البدء مرة أخرى.",
            logActivityCheckpointPlan: "{count} نقاط تفتيش × {min}–{max}ث ≈ {mins} دقيقة إجمالاً",
            logCheckpointWaitRemaining: "نقطة التفتيش {n}/{total} — متبقي {secs}ث",
            logActivityDispatchOk: "تم إرسال حدث نقطة التفتيش بنجاح.",
            logActivityDispatchFailed: "فشل إرسال حدث نقطة التفتيش: ",
            logActivityServerProgress: "أكد ديسكورد تقدم نقطة التفتيش: {n}/{total}",
            logActivityServerProgressPending: "تم إرسال نقطة التفتيش لكن تقدم ديسكورد لم يتغير — قد لا يكون مؤقت المهمة نشطاً.",
            logActivityProgressStalled: "تقدم ديسكورد ما زال دون تغيير بعد عدة نقاط تفتيش. تم الإيقاف لتجنب إكمال خاطئ.",
            logActivityResumeCheckpoints: "استئناف من نقطة التفتيش {done}/{total}",
            logActivityTimerRetry: "إعادة محاولة questStartTimer… (محاولة {n}/{max})",
            settingsCheckpointMin: "الحد الأدنى للنقطة",
            settingsCheckpointMax: "الحد الأقصى للنقطة",
            settingsCheckpointUnit: "ث",
            settingsCheckpointHint: "انتظار مهام النشاط بين نقاط التفتيش (30–600ث). يُطبَّق عند البدء التالي.",
            labelMergedListings: "تم دمج {n} قوائم"
        }
    };

    const t = (key) => i18n[currentLang][key] || i18n.en[key] || key;
    const timeLocale = () => (currentLang === "ar" ? "ar" : "en-GB");

    const STORAGE_COUNTRY_OVERRIDES_KEY = "questHelper_questCountryOverrides";
    const STORAGE_INFERRED_COUNTRIES_KEY = "questHelper_inferredCountries";
    const STORAGE_LAST_IP_COUNTRY_KEY = "questHelper_lastIpCountry";
    const STORAGE_QUEST_REGIONS_KEY = "questHelper_questRegions";
    const STORAGE_VPN_BASELINE_KEY = "questHelper_vpnCountryBaseline";
    const STORAGE_POISONED_AUTO_KEY = "questHelper_questCountries";
    const IP_COUNTRY_TTL_MS = 5 * 60 * 1000;
    const REGIONS_TTL_MS = 6 * 60 * 60 * 1000;
    const REGIONS_URL = "https://api.discordquest.com/api/regions";
    const COUNTRY_GLOBAL = "";
    const COUNTRY_ALIASES = { UK: "GB" };

    // Wipe legacy IP auto-stamps that wrongly labeled every quest as the VPN country.
    try { localStorage.removeItem(STORAGE_POISONED_AUTO_KEY); } catch (_) {}

    const COUNTRY_OPTIONS = [
        { code: "US", name: "United States" },
        { code: "GB", name: "United Kingdom" },
        { code: "CA", name: "Canada" },
        { code: "AU", name: "Australia" },
        { code: "DE", name: "Germany" },
        { code: "FR", name: "France" },
        { code: "NL", name: "Netherlands" },
        { code: "BE", name: "Belgium" },
        { code: "IE", name: "Ireland" },
        { code: "ES", name: "Spain" },
        { code: "IT", name: "Italy" },
        { code: "PT", name: "Portugal" },
        { code: "PL", name: "Poland" },
        { code: "SE", name: "Sweden" },
        { code: "NO", name: "Norway" },
        { code: "DK", name: "Denmark" },
        { code: "FI", name: "Finland" },
        { code: "CH", name: "Switzerland" },
        { code: "AT", name: "Austria" },
        { code: "CZ", name: "Czechia" },
        { code: "RO", name: "Romania" },
        { code: "HU", name: "Hungary" },
        { code: "GR", name: "Greece" },
        { code: "TR", name: "Turkey" },
        { code: "UA", name: "Ukraine" },
        { code: "RU", name: "Russia" },
        { code: "BR", name: "Brazil" },
        { code: "MX", name: "Mexico" },
        { code: "AR", name: "Argentina" },
        { code: "CL", name: "Chile" },
        { code: "CO", name: "Colombia" },
        { code: "JP", name: "Japan" },
        { code: "KR", name: "South Korea" },
        { code: "CN", name: "China" },
        { code: "TW", name: "Taiwan" },
        { code: "HK", name: "Hong Kong" },
        { code: "SG", name: "Singapore" },
        { code: "MY", name: "Malaysia" },
        { code: "TH", name: "Thailand" },
        { code: "VN", name: "Vietnam" },
        { code: "PH", name: "Philippines" },
        { code: "ID", name: "Indonesia" },
        { code: "IN", name: "India" },
        { code: "PK", name: "Pakistan" },
        { code: "BD", name: "Bangladesh" },
        { code: "AE", name: "United Arab Emirates" },
        { code: "SA", name: "Saudi Arabia" },
        { code: "QA", name: "Qatar" },
        { code: "KW", name: "Kuwait" },
        { code: "BH", name: "Bahrain" },
        { code: "OM", name: "Oman" },
        { code: "EG", name: "Egypt" },
        { code: "ZA", name: "South Africa" },
        { code: "NG", name: "Nigeria" },
        { code: "IL", name: "Israel" },
        { code: "NZ", name: "New Zealand" },
    ];

    const COUNTRY_NAME_BY_CODE = Object.fromEntries(COUNTRY_OPTIONS.map(c => [c.code, c.name]));

    const flagEmojiFromCode = (code) => {
        if (!code || code.length !== 2) return "🌐";
        const upper = code.toUpperCase();
        const a = upper.charCodeAt(0);
        const b = upper.charCodeAt(1);
        if (a < 65 || a > 90 || b < 65 || b > 90) return "🌐";
        return String.fromCodePoint(0x1F1E6 + (a - 65), 0x1F1E6 + (b - 65));
    };

    const normalizeCountryCode = (raw) => {
        if (raw == null || raw === "") return COUNTRY_GLOBAL;
        let code = String(raw).trim().toUpperCase();
        if (COUNTRY_ALIASES[code]) code = COUNTRY_ALIASES[code];
        if (code.length !== 2) return COUNTRY_GLOBAL;
        const a = code.charCodeAt(0);
        const b = code.charCodeAt(1);
        if (a < 65 || a > 90 || b < 65 || b > 90) return COUNTRY_GLOBAL;
        return code;
    };

    const countryDisplayName = (code) => {
        const normalized = normalizeCountryCode(code);
        if (!normalized) return t("countryGlobal");
        return COUNTRY_NAME_BY_CODE[normalized] || normalized;
    };

    const makeRichCatalogEntry = ({ isGlobal, include, exclude, mode, primary }) => {
        const inc = (include || []).map(normalizeCountryCode).filter(Boolean);
        const exc = (exclude || []).map(normalizeCountryCode).filter(Boolean);
        const prim = normalizeCountryCode(primary) || (mode === "include" && inc[0] ? inc[0] : COUNTRY_GLOBAL);
        return {
            isGlobal: !!isGlobal,
            include: inc,
            exclude: exc,
            mode,
            primary: prim,
            extra: mode === "include" ? Math.max(0, inc.length - 1) : 0,
            code: prim
        };
    };

    const coerceCatalogEntry = (raw) => {
        if (!raw || typeof raw !== "object") return null;
        if (Array.isArray(raw.include) || Array.isArray(raw.exclude) || raw.mode) {
            const include = (Array.isArray(raw.include) ? raw.include : []).map(normalizeCountryCode).filter(Boolean);
            const exclude = (Array.isArray(raw.exclude) ? raw.exclude : []).map(normalizeCountryCode).filter(Boolean);
            let mode = raw.mode;
            if (mode !== "global" && mode !== "include" && mode !== "exclude" && mode !== "unknown") {
                if (raw.isGlobal || raw.is_global) mode = "global";
                else if (include.length) mode = "include";
                else if (exclude.length) mode = "exclude";
                else mode = "unknown";
            }
            const primary = mode === "include"
                ? (normalizeCountryCode(raw.primary || raw.code) || include[0] || COUNTRY_GLOBAL)
                : COUNTRY_GLOBAL;
            return makeRichCatalogEntry({
                isGlobal: mode === "global" || !!raw.isGlobal || !!raw.is_global,
                include,
                exclude,
                mode,
                primary
            });
        }
        // Legacy { code, extra }
        const code = normalizeCountryCode(raw.code);
        if (code) {
            return makeRichCatalogEntry({
                isGlobal: false,
                include: [code],
                exclude: [],
                mode: "include",
                primary: code
            });
        }
        return makeRichCatalogEntry({
            isGlobal: true,
            include: [],
            exclude: [],
            mode: "global",
            primary: COUNTRY_GLOBAL
        });
    };

    const coerceRegionsMap = (map) => {
        if (!map || typeof map !== "object") return {};
        const out = {};
        for (const [id, entry] of Object.entries(map)) {
            const coerced = coerceCatalogEntry(entry);
            if (coerced) out[String(id)] = coerced;
        }
        return out;
    };

    let countryOverridesCache = null;
    let inferredCountriesCache = null;
    let ipCountryPromise = null;
    let ipCountryMemory = null;
    let regionsMemory = null;
    let regionsPromise = null;
    let regionsCatalogSettled = false;
    let currentIpCountry = null;
    let vpnInferenceCountry = null;
    let vpnBaselineIds = new Set();
    const countryResolveInFlight = new Set();

    const loadJsonMap = (key) => {
        try {
            const raw = localStorage.getItem(key);
            const parsed = raw ? JSON.parse(raw) : {};
            return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
        } catch (_) {
            return {};
        }
    };

    const loadCountryOverrides = () => {
        if (countryOverridesCache) return countryOverridesCache;
        countryOverridesCache = loadJsonMap(STORAGE_COUNTRY_OVERRIDES_KEY);
        return countryOverridesCache;
    };

    const saveCountryOverrides = () => {
        try {
            localStorage.setItem(STORAGE_COUNTRY_OVERRIDES_KEY, JSON.stringify(loadCountryOverrides()));
        } catch (_) {}
    };

    const getCountryOverride = (questId) => {
        const map = loadCountryOverrides();
        const id = String(questId);
        if (!Object.prototype.hasOwnProperty.call(map, id)) return null;
        return normalizeCountryCode(map[id]);
    };

    const setCountryOverride = (questId, code) => {
        const map = loadCountryOverrides();
        const id = String(questId);
        map[id] = normalizeCountryCode(code);
        saveCountryOverrides();
        return map[id];
    };

    const loadInferredCountries = () => {
        if (inferredCountriesCache) return inferredCountriesCache;
        inferredCountriesCache = loadJsonMap(STORAGE_INFERRED_COUNTRIES_KEY);
        return inferredCountriesCache;
    };

    const saveInferredCountries = () => {
        try {
            localStorage.setItem(STORAGE_INFERRED_COUNTRIES_KEY, JSON.stringify(loadInferredCountries()));
        } catch (_) {}
    };

    const getInferredCountry = (questId) => {
        const map = loadInferredCountries();
        const id = String(questId);
        if (!Object.prototype.hasOwnProperty.call(map, id)) return null;
        const code = normalizeCountryCode(map[id]);
        if (!code) {
            delete map[id];
            saveInferredCountries();
            return null;
        }
        return code;
    };

    const setInferredCountry = (questId, code) => {
        const normalized = normalizeCountryCode(code);
        if (!normalized) return null;
        const map = loadInferredCountries();
        map[String(questId)] = normalized;
        saveInferredCountries();
        return normalized;
    };

    const clearInferredCountry = (questId) => {
        const map = loadInferredCountries();
        const id = String(questId);
        if (!Object.prototype.hasOwnProperty.call(map, id)) return;
        delete map[id];
        saveInferredCountries();
    };

    const getEmbeddedRegionsSnapshot = () => {
        try {
            const snap = (globalThis).__DQM_REGIONS_SNAPSHOT;
            if (snap && typeof snap === "object" && !Array.isArray(snap)) return coerceRegionsMap(snap);
        } catch (_) {}
        return {};
    };

    const parseRegionsEntry = (entry) => {
        if (!entry || typeof entry !== "object") {
            return makeRichCatalogEntry({
                isGlobal: false, include: [], exclude: [], mode: "unknown", primary: COUNTRY_GLOBAL
            });
        }
        const includeRaw = Array.isArray(entry.regions?.include) ? entry.regions.include : [];
        const excludeRaw = Array.isArray(entry.regions?.exclude) ? entry.regions.exclude : [];
        const include = includeRaw.map(normalizeCountryCode).filter(Boolean);
        const exclude = excludeRaw.map(normalizeCountryCode).filter(Boolean);

        if (entry.is_global) {
            return makeRichCatalogEntry({
                isGlobal: true, include: [], exclude: [], mode: "global", primary: COUNTRY_GLOBAL
            });
        }
        if (include.length) {
            return makeRichCatalogEntry({
                isGlobal: false, include, exclude, mode: "include", primary: include[0]
            });
        }
        if (exclude.length) {
            return makeRichCatalogEntry({
                isGlobal: false, include: [], exclude, mode: "exclude", primary: COUNTRY_GLOBAL
            });
        }
        return makeRichCatalogEntry({
            isGlobal: false, include: [], exclude: [], mode: "unknown", primary: COUNTRY_GLOBAL
        });
    };

    const regionsMapHasEntries = (map) => !!(map && typeof map === "object" && Object.keys(map).length > 0);

    const mergeRegionsMaps = (...maps) => {
        const out = {};
        for (const map of maps) {
            if (!map || typeof map !== "object") continue;
            for (const [id, entry] of Object.entries(map)) {
                const coerced = coerceCatalogEntry(entry);
                if (coerced) out[String(id)] = coerced;
            }
        }
        return out;
    };

    const collectCatalogCountryCodes = (map) => {
        const codes = new Set();
        if (!map) return codes;
        for (const entry of Object.values(map)) {
            const coerced = coerceCatalogEntry(entry);
            if (!coerced) continue;
            for (const c of coerced.include) codes.add(c);
            for (const c of coerced.exclude) codes.add(c);
        }
        return codes;
    };

    const readCachedRegions = ({ allowStale = false } = {}) => {
        if (regionsMemory && regionsMapHasEntries(regionsMemory.map)) {
            if (allowStale || (Date.now() - regionsMemory.fetchedAt) < REGIONS_TTL_MS) {
                return regionsMemory.map;
            }
        }
        try {
            const raw = localStorage.getItem(STORAGE_QUEST_REGIONS_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed?.fetchedAt || !parsed?.byId || typeof parsed.byId !== "object") return null;
            const age = Date.now() - Number(parsed.fetchedAt);
            if (!allowStale && age >= REGIONS_TTL_MS) return null;
            if (!regionsMapHasEntries(parsed.byId)) return null;
            const map = coerceRegionsMap(parsed.byId);
            regionsMemory = { map, fetchedAt: Number(parsed.fetchedAt) };
            return regionsMemory.map;
        } catch (_) {
            return null;
        }
    };

    const writeCachedRegions = (byId) => {
        if (!regionsMapHasEntries(byId)) return;
        const map = coerceRegionsMap(byId);
        regionsMemory = { map, fetchedAt: Date.now() };
        try {
            localStorage.setItem(STORAGE_QUEST_REGIONS_KEY, JSON.stringify({
                fetchedAt: regionsMemory.fetchedAt,
                byId: map
            }));
        } catch (_) {}
    };

    const ensureRegionsCatalog = async ({ force = false } = {}) => {
        if (!force) {
            const cached = readCachedRegions();
            if (cached) {
                regionsCatalogSettled = true;
                return cached;
            }
        }
        if (regionsPromise) return regionsPromise;

        regionsPromise = (async () => {
            const base = mergeRegionsMaps(
                getEmbeddedRegionsSnapshot(),
                readCachedRegions({ allowStale: true }) || {}
            );

            try {
                const res = await fetch(REGIONS_URL, { cache: "no-store" });
                if (res.ok) {
                    const data = await res.json();
                    const list = Array.isArray(data?.quests) ? data.quests : [];
                    const live = {};
                    for (const entry of list) {
                        if (entry?.id == null) continue;
                        const parsed = parseRegionsEntry(entry);
                        const id = String(entry.id);
                        live[id] = parsed;
                        if (entry.replacement_id != null) {
                            live[String(entry.replacement_id)] = parsed;
                        }
                    }
                    if (regionsMapHasEntries(live)) {
                        const merged = mergeRegionsMaps(base, live);
                        writeCachedRegions(merged);
                        return merged;
                    }
                }
            } catch (_) {}

            if (regionsMapHasEntries(base)) {
                writeCachedRegions(base);
                return base;
            }
            return {};
        })().finally(() => {
            regionsCatalogSettled = true;
            regionsPromise = null;
        });

        return regionsPromise;
    };

    const getCatalogCountry = (questId) => {
        let map = readCachedRegions({ allowStale: true });
        if (!map) {
            const snap = getEmbeddedRegionsSnapshot();
            if (regionsMapHasEntries(snap)) {
                regionsMemory = { map: snap, fetchedAt: Date.now() };
                map = snap;
            }
        }
        if (!map) return undefined;
        const id = String(questId);
        if (!Object.prototype.hasOwnProperty.call(map, id)) return undefined;
        return coerceCatalogEntry(map[id]) || undefined;
    };

    const pickCatalogPrimary = (catalog) => {
        if (!catalog || catalog.mode !== "include" || !catalog.include?.length) return COUNTRY_GLOBAL;
        const ip = currentIpCountry || vpnInferenceCountry;
        if (ip && catalog.include.includes(ip)) return ip;
        return catalog.include[0];
    };

    const bustIpCountryCache = () => {
        ipCountryMemory = null;
        ipCountryPromise = null;
        try { localStorage.removeItem(STORAGE_LAST_IP_COUNTRY_KEY); } catch (_) {}
    };

    const readCachedIpCountry = () => {
        if (ipCountryMemory && (Date.now() - ipCountryMemory.fetchedAt) < IP_COUNTRY_TTL_MS) {
            return ipCountryMemory.code;
        }
        try {
            const raw = localStorage.getItem(STORAGE_LAST_IP_COUNTRY_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed?.code || !parsed?.fetchedAt) return null;
            if ((Date.now() - Number(parsed.fetchedAt)) >= IP_COUNTRY_TTL_MS) return null;
            const code = normalizeCountryCode(parsed.code);
            if (!code) return null;
            ipCountryMemory = { code, fetchedAt: Number(parsed.fetchedAt) };
            return code;
        } catch (_) {
            return null;
        }
    };

    const writeCachedIpCountry = (code) => {
        const normalized = normalizeCountryCode(code);
        if (!normalized) return;
        ipCountryMemory = { code: normalized, fetchedAt: Date.now() };
        try {
            localStorage.setItem(STORAGE_LAST_IP_COUNTRY_KEY, JSON.stringify(ipCountryMemory));
        } catch (_) {}
    };

    const extractApiCountryCode = (res) => {
        const body = res?.body ?? res;
        return normalizeCountryCode(body?.country_code ?? body?.countryCode ?? body?.country);
    };

    const loadVpnBaseline = () => {
        try {
            const raw = localStorage.getItem(STORAGE_VPN_BASELINE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed?.country || !Array.isArray(parsed?.questIds)) return null;
            return {
                country: normalizeCountryCode(parsed.country),
                questIds: new Set(parsed.questIds.map(String))
            };
        } catch (_) {
            return null;
        }
    };

    const saveVpnBaseline = (country, questIds) => {
        const code = normalizeCountryCode(country);
        if (!code) return;
        vpnInferenceCountry = code;
        vpnBaselineIds = new Set([...questIds].map(String));
        try {
            localStorage.setItem(STORAGE_VPN_BASELINE_KEY, JSON.stringify({
                country: code,
                questIds: [...vpnBaselineIds]
            }));
        } catch (_) {}
    };

    const collectCurrentQuestIds = () => {
        try {
            return new Set([...QuestsStore.quests.values()].map(q => String(q.id)));
        } catch (_) {
            return new Set();
        }
    };

    const updateLocationChip = (code) => {
        const chip = document.getElementById("dqm-stat-location");
        const label = document.querySelector(".dqm-chip-location-label");
        if (label) label.textContent = t("labelYourLocation");
        if (!chip) return;
        const normalized = normalizeCountryCode(code);
        if (!normalized) {
            chip.textContent = "—";
            return;
        }
        chip.textContent = `${flagEmojiFromCode(normalized)} ${normalized}`;
        chip.title = countryDisplayName(normalized);
    };

    const onIpCountryResolved = (code, { forceBaseline = false } = {}) => {
        const normalized = normalizeCountryCode(code);
        if (!normalized) {
            updateLocationChip(null);
            return;
        }
        const prev = currentIpCountry || loadVpnBaseline()?.country || null;
        currentIpCountry = normalized;
        updateLocationChip(normalized);

        if (!prev) {
            saveVpnBaseline(normalized, collectCurrentQuestIds());
            return;
        }
        if (prev !== normalized || forceBaseline) {
            if (prev !== normalized) {
                // VPN country changed — only brand-new quests after this point infer as the new country.
                saveVpnBaseline(normalized, collectCurrentQuestIds());
            }
        }
    };

    const fetchIpCountry = async ({ force = false } = {}) => {
        if (force) bustIpCountryCache();
        else {
            const cached = readCachedIpCountry();
            if (cached) {
                onIpCountryResolved(cached);
                return cached;
            }
        }
        if (ipCountryPromise) return ipCountryPromise;

        ipCountryPromise = (async () => {
            try {
                try {
                    const res = await apiGet({ url: "/users/@me/billing/country-code" });
                    const code = extractApiCountryCode(res);
                    if (code) {
                        writeCachedIpCountry(code);
                        onIpCountryResolved(code);
                        return code;
                    }
                } catch (_) {}
                try {
                    const res = await apiGet({ url: "/auth/location-metadata" });
                    const code = extractApiCountryCode(res);
                    if (code) {
                        writeCachedIpCountry(code);
                        onIpCountryResolved(code);
                        return code;
                    }
                } catch (_) {}
                updateLocationChip(currentIpCountry);
                return null;
            } finally {
                ipCountryPromise = null;
            }
        })();

        return ipCountryPromise;
    };

    // Restore VPN baseline from storage for inference across reloads.
    (() => {
        const baseline = loadVpnBaseline();
        if (baseline?.country) {
            vpnInferenceCountry = baseline.country;
            vpnBaselineIds = baseline.questIds;
            currentIpCountry = baseline.country;
        }
    })();

    const countrySourceLabel = (source) => {
        if (source === "override") return t("countrySourceOverride");
        if (source === "catalog") return t("countrySourceCatalog");
        if (source === "inferred") return t("countrySourceInferred");
        return t("countrySourceUnknown");
    };

    const resolveQuestCountrySync = (questId) => {
        const id = String(questId);
        const override = getCountryOverride(id);
        if (override !== null) {
            return {
                source: "override",
                code: override,
                extra: 0,
                status: "ready",
                mode: override ? "include" : "global",
                include: override ? [override] : [],
                exclude: []
            };
        }

        const catalog = getCatalogCountry(id);
        if (catalog !== undefined && catalog.mode !== "unknown") {
            if (catalog.mode === "include" && catalog.include.length) {
                clearInferredCountry(id);
            }
            const primary = pickCatalogPrimary(catalog);
            return {
                source: "catalog",
                code: primary,
                extra: catalog.mode === "include" ? Math.max(0, catalog.include.length - 1) : 0,
                status: "ready",
                mode: catalog.mode,
                include: catalog.include.slice(),
                exclude: catalog.exclude.slice()
            };
        }

        const inferred = getInferredCountry(id);
        if (inferred !== null) {
            return {
                source: "inferred",
                code: inferred,
                extra: 0,
                status: "ready",
                mode: "include",
                include: [inferred],
                exclude: []
            };
        }
        if (vpnInferenceCountry && !vpnBaselineIds.has(id)) {
            const stamped = setInferredCountry(id, vpnInferenceCountry);
            if (stamped) {
                return {
                    source: "inferred",
                    code: stamped,
                    extra: 0,
                    status: "ready",
                    mode: "include",
                    include: [stamped],
                    exclude: []
                };
            }
        }

        if (!regionsCatalogSettled && catalog === undefined) {
            return {
                source: "unknown",
                code: COUNTRY_GLOBAL,
                extra: 0,
                status: "detecting",
                mode: "unknown",
                include: [],
                exclude: []
            };
        }

        return {
            source: "unknown",
            code: COUNTRY_GLOBAL,
            extra: 0,
            status: "unknown",
            mode: "unknown",
            include: [],
            exclude: []
        };
    };

    const resolveQuestCountry = async (questId) => {
        await ensureRegionsCatalog();
        return resolveQuestCountrySync(questId);
    };

    const countryFilterKey = (resolved) => {
        if (!resolved) return "unknown";
        if (resolved.status === "detecting") return "unknown";
        if (resolved.status === "unknown") return "unknown";
        if (resolved.mode === "exclude" || resolved.mode === "global") return "global";
        const code = normalizeCountryCode(resolved.code);
        if (!code) return "global";
        return code;
    };

    const getAllCountrySelectOptions = () => {
        const codes = new Set(COUNTRY_OPTIONS.map(c => c.code));
        const map = readCachedRegions({ allowStale: true }) || getEmbeddedRegionsSnapshot();
        for (const c of collectCatalogCountryCodes(map)) codes.add(c);
        const named = COUNTRY_OPTIONS.slice();
        const namedSet = new Set(named.map(c => c.code));
        for (const code of [...codes].sort()) {
            if (!namedSet.has(code)) named.push({ code, name: code });
        }
        return named;
    };

    const fillCountrySelect = (select) => {
        if (!select) return;
        const prev = select.value;
        select.innerHTML = "";
        const globalOpt = document.createElement("option");
        globalOpt.value = COUNTRY_GLOBAL;
        globalOpt.textContent = `🌐 ${t("countryGlobal")}`;
        select.appendChild(globalOpt);
        for (const { code, name } of getAllCountrySelectOptions()) {
            const opt = document.createElement("option");
            opt.value = code;
            opt.textContent = `${flagEmojiFromCode(code)} ${name}`;
            select.appendChild(opt);
        }
        select.dataset.filled = "1";
        if (prev != null) select.value = prev;
    };

    const refreshCountrySelectLabels = (select) => {
        if (!select) return;
        const globalOpt = select.querySelector(`option[value="${COUNTRY_GLOBAL}"]`);
        if (globalOpt) globalOpt.textContent = `🌐 ${t("countryGlobal")}`;
    };

    const formatExcludeLabel = (exclude) => {
        const codes = (exclude || []).map(normalizeCountryCode).filter(Boolean);
        if (!codes.length) return t("countryGlobal");
        return t("countryExcept").replace("{codes}", codes.join(" −"));
    };

    const codesTitleList = (codes) => (codes || [])
        .map(normalizeCountryCode)
        .filter(Boolean)
        .map(c => `${flagEmojiFromCode(c)} ${countryDisplayName(c)}`)
        .join(", ");

    const applyCountryToCard = (card, resolved) => {
        const flagEl = card.querySelector(".dqm-country-flag");
        const labelEl = card.querySelector(".dqm-country-label");
        const extraEl = card.querySelector(".dqm-country-extra");
        const select = card.querySelector(".dqm-country-select");
        const status = resolved?.status || "ready";
        const mode = resolved?.mode || (normalizeCountryCode(resolved?.code) ? "include" : "global");
        const code = normalizeCountryCode(resolved?.code);
        const include = Array.isArray(resolved?.include) ? resolved.include : (code ? [code] : []);
        const exclude = Array.isArray(resolved?.exclude) ? resolved.exclude : [];
        const extra = Number(resolved?.extra) || Math.max(0, include.length - 1);
        const detecting = status === "detecting";
        const unknown = status === "unknown";
        const sourceTip = countrySourceLabel(resolved?.source);

        let labelText = t("countryUnknown");
        let flagText = "🌐";
        let tip = sourceTip;

        if (detecting) {
            labelText = t("countryDetecting");
            flagText = "…";
            tip = t("countryDetecting");
        } else if (unknown) {
            labelText = t("countryUnknown");
            flagText = "🌐";
            tip = sourceTip;
        } else if (mode === "exclude") {
            labelText = formatExcludeLabel(exclude);
            flagText = "🌐";
            tip = `${sourceTip}\n${labelText}`;
        } else if (mode === "global" || !code) {
            labelText = t("countryGlobal");
            flagText = "🌐";
            tip = sourceTip;
        } else {
            labelText = countryDisplayName(code);
            flagText = flagEmojiFromCode(code);
            tip = include.length > 1
                ? `${sourceTip}\n${codesTitleList(include)}`
                : `${sourceTip}\n${countryDisplayName(code)}`;
        }

        if (flagEl) {
            flagEl.textContent = flagText;
            flagEl.title = tip;
        }
        if (labelEl) {
            labelEl.textContent = labelText;
            labelEl.title = tip;
        }
        if (extraEl) {
            if (!detecting && !unknown && mode === "include" && extra > 0) {
                extraEl.textContent = `+${extra}`;
                extraEl.title = codesTitleList(include);
            } else {
                extraEl.textContent = "";
                extraEl.title = "";
            }
        }
        if (select) {
            fillCountrySelect(select);
            refreshCountrySelectLabels(select);
            select.disabled = detecting;
            select.title = tip;
            if (!detecting && mode === "include" && code) select.value = code;
            else if (!detecting) select.value = COUNTRY_GLOBAL;
        }
    };

    const refreshCountryFilterOptions = () => {
        const select = document.getElementById("dqm-country-filter");
        if (!select) return;
        const prev = currentCountryFilter || select.value || "all";
        select.innerHTML = "";

        const addOpt = (value, text) => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = text;
            select.appendChild(opt);
        };

        addOpt("all", t("countryFilterAll"));
        addOpt("global", `🌐 ${t("countryFilterGlobal")}`);
        addOpt("unknown", t("countryFilterUnknown"));

        const codes = new Set(COUNTRY_OPTIONS.map(c => c.code));
        const map = readCachedRegions({ allowStale: true }) || getEmbeddedRegionsSnapshot();
        for (const c of collectCatalogCountryCodes(map)) codes.add(c);
        for (const code of [...codes].sort()) {
            addOpt(code, `${flagEmojiFromCode(code)} ${countryDisplayName(code)}`);
        }

        select.value = [...select.options].some(o => o.value === prev) ? prev : "all";
        currentCountryFilter = select.value;
        select.setAttribute("aria-label", t("labelCountryFilter"));
        select.title = t("labelCountryFilter");
    };


    const getTaskConfig = (quest) => getSharedTaskConfig(quest);

    const resolveTaskType = (quest, taskName, taskConfig = null) => {
        const cfg = taskConfig ?? getTaskConfig(quest);
        const task = taskName ? cfg?.tasks?.[taskName] : null;
        return String(task?.type || taskName || "").toUpperCase();
    };

    const resolveTaskName = (quest) => {
        const taskConfig = getTaskConfig(quest);
        if (!taskConfig?.tasks) return null;
        const keys = Object.keys(taskConfig.tasks);

        for (const key of keys) {
            if (supportedTasks.has(key)) return key;
        }
        for (const key of keys) {
            const type = resolveTaskType(quest, key, taskConfig);
            if (supportedTasks.has(type)) return key;
            if (
                type === "ACHIEVEMENT_IN_ACTIVITY"
                || type === "PLAY_ACTIVITY"
                || type.includes("ACHIEVEMENT")
                || (type.includes("ACTIVITY") && !type.includes("WATCH"))
            ) {
                return key;
            }
        }
        for (const key of keys) {
            const task = taskConfig.tasks[key];
            if (task?.applications?.length || task?.application_id || task?.applicationId) {
                return key;
            }
        }
        return keys[0] || null;
    };

    const getQuestTypeDetails = (quest) => {
        const taskName = resolveTaskName(quest);
        const taskConfig = getTaskConfig(quest);
        const resolvedType = resolveTaskType(quest, taskName, taskConfig);
        let type = "Other";
        let label = t("typeOther");

        if (taskName) {
            if (resolvedType === "WATCH_VIDEO" || resolvedType === "WATCH_VIDEO_ON_MOBILE" || resolvedType.includes("VIDEO")) {
                type = "Video"; label = "📺 " + t("typeVideo");
            } else if (resolvedType === "PLAY_ON_DESKTOP" || (resolvedType.includes("PLAY") && resolvedType.includes("DESKTOP"))) {
                type = "Play Game"; label = "🎮 " + t("typePlay");
            } else if (resolvedType === "STREAM_ON_DESKTOP" || resolvedType.includes("STREAM")) {
                type = "Stream"; label = "📡 " + t("typeStream");
            } else if (
                isLaunchQuestTask(taskName, taskConfig)
                || resolvedType === "PLAY_ACTIVITY"
                || resolvedType === "ACHIEVEMENT_IN_ACTIVITY"
                || resolvedType.includes("ACHIEVEMENT")
                || resolvedType.includes("ACTIVITY")
            ) {
                type = "Launch Quest"; label = "🚀 " + t("typeLaunch");
            }
        }

        if (type === "Other") {
            const app = quest.config?.application;
            const hasApp = !!(app?.id || app?.name || resolveQuestApplicationId(quest));
            const cta = String(
                quest.config?.messages?.ctaButton
                ?? quest.config?.messages?.cta_button
                ?? ""
            ).toLowerCase();
            const qName = String(
                quest.config?.messages?.questName
                ?? quest.config?.messages?.quest_name
                ?? ""
            ).toLowerCase();
            const isLaunchCta = cta.includes("launch") || qName.includes("launch") || cta.includes("activity");
            if (hasApp || isLaunchCta) {
                type = "Launch Quest"; label = "🚀 " + t("typeLaunch");
            }
        }
        return { type, label, taskName };
    };

    const getAllStoreQuests = () => {
        const raw = QuestsStore?.quests;
        if (!raw) return [];
        const values = typeof raw.values === "function" ? [...raw.values()] : Object.values(raw);
        return values.map(q => normalizeQuestUserStatus(q)).filter(Boolean);
    };

    const isLaunchQuestType = (quest) => {
        const details = getQuestTypeDetails(quest);
        if (details.type === "Launch Quest") return true;
        const taskName = resolveTaskName(quest);
        return isLaunchQuestTask(taskName, getTaskConfig(quest));
    };

    const getQuestDedupeKey = (quest) => {
        const appId = quest.config?.application?.id || resolveQuestApplicationId(quest) || "";
        const taskName = resolveTaskName(quest) || "";
        const taskType = resolveTaskType(quest, taskName);
        if (isLaunchQuestType(quest)) {
            const id = quest.id || "";
            if (!appId) return `launch|noid|${id}|${taskName}|${taskType}`;
            return `launch|${appId}|${taskType || taskName}`;
        }
        const name = (quest.config?.messages?.questName || quest.config?.messages?.quest_name || "").trim().toLowerCase();
        return `${appId}|${name}|${taskName}`;
    };

    const getQuestDuplicateGroup = (quest, allQuests = null) => {
        if (!isLaunchQuestType(quest)) return [quest];
        const quests = allQuests ?? getAllStoreQuests();
        const key = getQuestDedupeKey(quest);
        return quests.filter(q => isLaunchQuestType(q) && getQuestDedupeKey(q) === key);
    };

    const getSingleQuestProgress = (quest) => {
        const taskName = resolveTaskName(quest);
        const taskConfig = getTaskConfig(quest);
        let total = 1;
        let progress = 0;
        if (taskName && taskConfig?.tasks?.[taskName]) {
            total = taskConfig.tasks[taskName].target || 1;
            if (isAchievementActivityTask(taskName, taskConfig)) {
                progress = readActivityCheckpointProgress(quest, taskName);
            } else {
                progress = quest.userStatus?.progress?.[taskName]?.value ?? 0;
            }
        }
        if (quest.userStatus?.completedAt || quest.userStatus?.claimedAt) progress = total;
        return { taskName, progress, total };
    };

    const getQuestProgressRatio = (quest) => {
        const { progress, total } = getSingleQuestProgress(quest);
        return total > 0 ? progress / total : 0;
    };

    const pickCanonicalQuest = (duplicates) => {
        if (!duplicates?.length) return null;
        if (duplicates.length === 1) return duplicates[0];
        return duplicates.slice().sort((a, b) => {
            const aRunning = dqmTasks.has(a.id) ? 1 : 0;
            const bRunning = dqmTasks.has(b.id) ? 1 : 0;
            if (bRunning !== aRunning) return bRunning - aRunning;

            const aEnrolled = a.userStatus?.enrolledAt ? 1 : 0;
            const bEnrolled = b.userStatus?.enrolledAt ? 1 : 0;
            if (bEnrolled !== aEnrolled) return bEnrolled - aEnrolled;

            const aProg = getQuestProgressRatio(a);
            const bProg = getQuestProgressRatio(b);
            if (bProg !== aProg) return bProg - aProg;

            const aExp = new Date(a.config.expiresAt).getTime();
            const bExp = new Date(b.config.expiresAt).getTime();
            if (aExp !== bExp) return aExp - bExp;

            return String(a.id).localeCompare(String(b.id));
        })[0];
    };

    const getCanonicalQuest = (quest, allQuests = null) => {
        return pickCanonicalQuest(getQuestDuplicateGroup(quest, allQuests)) ?? quest;
    };

    const dedupeQuests = (quests) => {
        const otherQuests = [];
        const launchGroups = new Map();
        for (const quest of quests) {
            if (!isLaunchQuestType(quest)) {
                otherQuests.push(quest);
                continue;
            }
            const key = getQuestDedupeKey(quest);
            if (!launchGroups.has(key)) launchGroups.set(key, []);
            launchGroups.get(key).push(quest);
        }
        const result = [...otherQuests];
        for (const group of launchGroups.values()) {
            const canonical = pickCanonicalQuest(group);
            if (canonical) result.push(canonical);
        }
        return result;
    };

    const getDuplicateGroupQuestIds = (quest) => {
        return getQuestDuplicateGroup(quest).map(q => q.id);
    };

    const isDuplicateGroupRunning = (quest) => {
        return getQuestDuplicateGroup(quest).some(q => dqmTasks.has(q.id));
    };

    const getGroupRuntime = (quest) => {
        const group = getQuestDuplicateGroup(quest);
        for (const q of group) {
            if (dqmTasks.has(q.id)) {
                return questRuntime.get(q.id) ?? ensureRuntime(getCanonicalQuest(quest));
            }
        }
        return ensureRuntime(getCanonicalQuest(quest));
    };

    const getQuestProgress = (quest) => {
        const group = getQuestDuplicateGroup(quest);
        let best = { taskName: null, progress: 0, total: 1 };
        for (const q of group) {
            const p = getSingleQuestProgress(q);
            if (p.progress > best.progress) best = p;
        }
        return best;
    };

    const isCheckpointQuest = (quest) => {
        const taskName = resolveTaskName(quest);
        return isAchievementActivityTask(taskName, getTaskConfig(quest));
    };

    const formatProgressText = (quest, progress, total) => {
        if (isCheckpointQuest(quest)) {
            return `${t("progressLabel")}: ${Math.floor(progress)} / ${total} ${t("progressLabelCheckpoints")}`;
        }
        return `${t("progressLabel")}: ${Math.floor(progress)} / ${total}s`;
    };

    const getProgressEtaMinutes = (quest, progress, total, etaSecsOverride) => {
        if (etaSecsOverride != null) {
            return Math.max(1, Math.ceil(etaSecsOverride / 60));
        }
        if (isCheckpointQuest(quest)) {
            const remCheckpoints = Math.max(0, total - progress);
            return Math.ceil((remCheckpoints * getActivityCheckpointAvgSecs()) / 60);
        }
        const rem = Math.max(0, total - progress);
        return Math.ceil(rem / 60);
    };

    const getDisplayProgress = (quest, rt) => {
        const effectiveRt = rt ?? getGroupRuntime(quest);
        const { progress: serverProgress, total } = getQuestProgress(quest);
        if (effectiveRt?.running || isDuplicateGroupRunning(quest)) {
            return {
                progress: Math.max(effectiveRt.progress ?? 0, serverProgress),
                total: effectiveRt.target || total
            };
        }
        return { progress: serverProgress, total };
    };

    const isExpired = (quest) => isQuestExpired(quest);

    const getQuestBucket = (quest) => {
        const flags = getQuestCompletionFlags(quest);
        if (flags.isClaimed) return "complete";
        if (flags.isClaimable) return "claimable";
        return "incomplete";
    };

    const matchesFilter = (quest) => {
        if (isExpired(quest)) return false;
        const bucket = getQuestBucket(quest);
        if (currentFilter === "incomplete" && bucket !== "incomplete") return false;
        if (currentFilter === "claimable" && bucket !== "claimable") return false;
        if (currentFilter === "complete" && bucket !== "complete") return false;
        if (currentCountryFilter && currentCountryFilter !== "all") {
            const key = countryFilterKey(resolveQuestCountrySync(quest.id));
            if (key !== currentCountryFilter) return false;
        }
        return true;
    };

    const isRunnableQuest = (quest) => {
        const flags = getQuestCompletionFlags(quest);
        if (!flags.isEnrolled) return false;
        if (flags.isCompleted || flags.isClaimed) return false;
        if (isExpired(quest)) return false;
        return !!resolveTaskName(quest) || isLaunchQuestType(quest);
    };

    const isBatchRunnableQuest = (quest) => {
        if (!isRunnableQuest(quest)) return false;
        const taskName = resolveTaskName(quest);
        const taskConfig = getTaskConfig(quest);
        if (isAchievementActivityTask(taskName, taskConfig)) return false;
        return true;
    };

    const extractOrbs = (text) => {
        if (!text || typeof text !== "string") return null;
        let m = text.match(/(\d+)\s*Orbs?/i);
        if (m) return parseInt(m[1], 10);
        m = text.match(/\b(200|700|1000)\b/);
        if (m) return parseInt(m[1], 10);
        return null;
    };

    const computeQuestOrbs = (quest) => {
        const rewardsConfig = quest.config?.rewardsConfig?.rewards;
        if (Array.isArray(rewardsConfig)) {
            for (const r of rewardsConfig) {
                if (r?.type === 4) {
                    const qty = r.orb_quantity ?? r.messages?.orb_quantity;
                    const num = parseInt(qty, 10);
                    if (!isNaN(num) && num > 0) return num;
                }
            }
        }
        if (quest.config.messages) {
            const msg = quest.config.messages;
            const val = extractOrbs(msg.rewardName) || extractOrbs(msg.questName) ||
                extractOrbs(msg.description) || extractOrbs(msg.ctaButton);
            if (val) return val;
        }
        if (quest.config.rewards) {
            const rewards = Array.isArray(quest.config.rewards) ? quest.config.rewards : [quest.config.rewards];
            for (const r of rewards) {
                const num = parseInt(r.amount, 10);
                if (!isNaN(num) && num > 0) return num;
                if (r.messages) {
                    const val = extractOrbs(r.messages.name);
                    if (val) return val;
                }
            }
        }
        const str = JSON.stringify(quest.config);
        const m = str.match(/(\d+)\s*Orbs?/i) || str.match(/\b(200|700|1000)\b/);
        if (m) {
            const num = parseInt(m[1] || m[0], 10);
            if (!isNaN(num) && num > 0) return num;
        }
        return null;
    };

    const getQuestOrbs = (quest, { bustCache = false } = {}) => {
        if (bustCache) orbsCache.delete(quest.id);
        if (orbsCache.has(quest.id)) return orbsCache.get(quest.id);
        const value = computeQuestOrbs(quest);
        orbsCache.set(quest.id, value);
        return value;
    };

    const ensureRuntime = (quest) => {
        let rt = questRuntime.get(quest.id);
        if (!rt) {
            rt = {
                id: quest.id,
                name: quest.config.messages?.questName || "Unknown",
                type: "Other",
                status: "idle",
                progress: 0,
                target: 1,
                running: false,
                stopped: false,
                completed: false,
                claimed: false,
                error: null
            };
            questRuntime.set(quest.id, rt);
        }
        const details = getQuestTypeDetails(quest);
        const { progress: serverProgress, total } = getQuestProgress(quest);
        rt.name = quest.config.messages?.questName || rt.name;
        rt.type = details.type;
        rt.target = total;
        if (rt.running) {
            rt.progress = Math.max(rt.progress ?? 0, serverProgress);
        } else {
            rt.progress = serverProgress;
        }
        const flags = getQuestCompletionFlags(quest);
        rt.completed = flags.isCompleted;
        rt.claimed = flags.isClaimed;
        rt.running = dqmTasks.has(quest.id);
        if (rt.running) rt.status = "running";
        else if (rt.error) rt.status = "error";
        else if (rt.stopped && !rt.completed) rt.status = "stopped";
        else if (rt.claimed) rt.status = "claimed";
        else if (rt.completed) rt.status = "claimable";
        else if (!flags.isEnrolled) rt.status = "not-enrolled";
        else rt.status = "enrolled";
        return rt;
    };


    const errMsg = (e) => {
        if (!e) return "Unknown";
        if (typeof e === "string") return e;
        if (e.body?.message) return String(e.body.message);
        if (e.message) return String(e.message).slice(0, 200);
        return "Request failed";
    };

    const apiRequest = async (method, opts, retries = API_RETRIES) => {
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                if (method === "get") return await api.get(opts);
                return await api.post(opts);
            } catch (e) {
                lastErr = e;
                const status = e?.status || e?.body?.code;
                const retryable = !status || status >= 500 || status === 429 || status === 0;
                if (!retryable || attempt === retries) break;
                await sleep(API_RETRY_BASE_MS * Math.pow(2, attempt));
            }
        }
        throw lastErr;
    };

    const apiGet = (opts) => apiRequest("get", opts);
    const apiPost = (opts) => apiRequest("post", opts);


    const addLog = (level, text) => {
        const msg = typeof text === "string" ? text : String(text);
        if (!logBox) {
            console.log(`[DQM][${level}]`, msg);
            return;
        }
        const line = document.createElement("div");
        line.className = "dqm-log-line dqm-log--" + level.toLowerCase();
        const time = document.createElement("span");
        time.className = "dqm-log-time";
        time.textContent = `[${new Date().toLocaleTimeString(timeLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}]`;
        const lvl = document.createElement("span");
        lvl.className = "dqm-log-level";
        lvl.textContent = level.padEnd(8, " ");
        const body = document.createElement("span");
        body.className = "dqm-log-msg";
        body.textContent = msg;
        line.appendChild(time);
        line.appendChild(document.createTextNode(" "));
        line.appendChild(lvl);
        line.appendChild(document.createTextNode(" "));
        line.appendChild(body);
        logBox.appendChild(line);
        while (logBox.children.length > LOG_CAP) logBox.removeChild(logBox.firstChild);
        logBox.scrollTop = logBox.scrollHeight;
    };

    const log = {
        info: (m) => addLog("INFO", m),
        success: (m) => addLog("SUCCESS", m),
        warn: (m) => addLog("WARNING", m),
        error: (m) => addLog("ERROR", m),
        debug: (m) => addLog("DEBUG", m),
        running: (m) => addLog("RUNNING", m)
    };


    const progressBarColorVar = (percent, claimed) => {
        if (claimed) return "var(--dqm-success)";
        if (percent < 30) return "var(--dqm-warning)";
        if (percent < 70) return "var(--dqm-orbs)";
        return "var(--dqm-success)";
    };

    const updateQuestProgress = (questId, progress, total, options = {}) => {
        const { etaSecs } = options;
        const quest = QuestsStore.quests.get(questId);
        const displayQuest = quest ? getCanonicalQuest(quest) : null;
        const cardId = displayQuest?.id ?? questId;
        const card = cardByQuestId.get(cardId);
        const rt = questRuntime.get(questId) ?? (displayQuest ? questRuntime.get(displayQuest.id) : null);
        if (rt) {
            rt.progress = progress;
            rt.target = total;
        }
        if (!card) return;
        const percent = Math.min(100, Math.round((progress / Math.max(total, 1)) * 100));
        const bar = card.querySelector(".quest-progress-bar");
        const progressText = card.querySelector(".quest-progress-text");
        const percentEl = card.querySelector(".quest-progress-percent");
        const etaEl = card.querySelector(".dqm-eta");
        if (bar) {
            bar.style.width = percent + "%";
            bar.style.background = progressBarColorVar(percent, false);
        }
        if (progressText && displayQuest) {
            progressText.textContent = formatProgressText(displayQuest, progress, total);
        } else if (progressText) {
            progressText.textContent = `${t("progressLabel")}: ${Math.floor(progress)} / ${total}s`;
        }
        if (percentEl) percentEl.textContent = `${percent}%`;
        if (etaEl) {
            const mins = displayQuest
                ? getProgressEtaMinutes(displayQuest, progress, total, etaSecs)
                : Math.ceil(Math.max(0, (etaSecs ?? total - progress)) / 60);
            etaEl.textContent = mins > 0 ? `${t("labelEta")}: ~${mins}m` : "";
        }
        updateRunningStats();
        updateMiniRunning();
    };

    const setCardStatusClass = (card, status) => {
        card.classList.remove(
            "dqm-card--idle", "dqm-card--not-enrolled", "dqm-card--enrolled",
            "dqm-card--running", "dqm-card--completed", "dqm-card--claimable", "dqm-card--claimed",
            "dqm-card--error", "dqm-card--stopped"
        );
        card.classList.add("dqm-card--" + status);
    };

    const statusColorFor = (status) => {
        const map = {
            "not-enrolled": "var(--dqm-warning)",
            enrolled: "var(--dqm-accent)",
            running: "var(--dqm-success)",
            completed: "var(--dqm-info)",
            claimable: "var(--dqm-info)",
            claimed: "var(--dqm-success)",
            error: "var(--dqm-danger)",
            stopped: "var(--dqm-text-muted)",
            idle: "var(--dqm-text-muted)"
        };
        return map[status] || "var(--dqm-text-muted)";
    };

    const statusLabelFor = (status) => {
        const map = {
            "not-enrolled": t("statusNotEnrolled"),
            enrolled: t("statusInProgress"),
            running: t("statusRunning"),
            completed: t("statusCompleted"),
            claimable: t("statusClaimable"),
            claimed: t("statusClaimed"),
            error: t("statusError"),
            stopped: t("statusStopped"),
            idle: t("statusInProgress")
        };
        return map[status] || status;
    };

    const patchCardStatus = (questId) => {
        const quest = QuestsStore.quests.get(questId);
        if (!quest) return;
        const canonical = getCanonicalQuest(quest);
        const card = cardByQuestId.get(canonical.id);
        if (!card) return;
        const rt = getGroupRuntime(canonical);
        setCardStatusClass(card, rt.status);
        const statusEl = card.querySelector(".dqm-status");
        if (statusEl) {
            statusEl.textContent = statusLabelFor(rt.status);
            statusEl.style.color = statusColorFor(rt.status);
        }
        buildCardActions(card, canonical, rt);
        updateRunningStats();
        updateMiniRunning();
    };


    const dispatchGamesClear = (fakeGame) => {
        if (!FluxDispatcher) return;
        try {
            FluxDispatcher.dispatch({
                type: "RUNNING_GAMES_CHANGE",
                removed: fakeGame?.id != null ? [fakeGame] : [],
                added: [],
                games: []
            });
        } catch (_) {}
    };

    const holdGameDetectEmpty = (realGetRunningGames, realGetGameForPID, fakeGame) => {
        if (!RunningGameStore) return;
        RunningGameStore.getRunningGames = () => [];
        RunningGameStore.getGameForPID = () => null;
        dispatchGamesClear(fakeGame);
        if (!gameDetectHold) {
            gameDetectHold = {
                realGetRunningGames,
                realGetGameForPID,
                fakeGame: fakeGame || null,
                reclearTimer: null
            };
        } else {
            gameDetectHold.fakeGame = fakeGame || gameDetectHold.fakeGame;
            if (!gameDetectHold.realGetRunningGames) gameDetectHold.realGetRunningGames = realGetRunningGames;
            if (!gameDetectHold.realGetGameForPID) gameDetectHold.realGetGameForPID = realGetGameForPID;
        }
        if (gameDetectHold.reclearTimer) clearTimeout(gameDetectHold.reclearTimer);
        gameDetectHold.reclearTimer = setTimeout(() => {
            if (!gameDetectHold || !RunningGameStore) return;
            RunningGameStore.getRunningGames = () => [];
            RunningGameStore.getGameForPID = () => null;
            dispatchGamesClear(gameDetectHold.fakeGame);
        }, 1000);
    };

    const releaseGameDetectHold = () => {
        if (!gameDetectHold) return;
        if (gameDetectHold.reclearTimer) clearTimeout(gameDetectHold.reclearTimer);
        const { realGetRunningGames, realGetGameForPID } = gameDetectHold;
        gameDetectHold = null;
        if (!RunningGameStore) return;
        if (typeof realGetRunningGames === "function") {
            RunningGameStore.getRunningGames = realGetRunningGames;
        }
        if (typeof realGetGameForPID === "function") {
            RunningGameStore.getGameForPID = realGetGameForPID;
        }
        let games = [];
        try {
            games = typeof realGetRunningGames === "function"
                ? (realGetRunningGames.call(RunningGameStore) || [])
                : [];
        } catch (_) {
            games = [];
        }
        if (FluxDispatcher) {
            try {
                FluxDispatcher.dispatch({
                    type: "RUNNING_GAMES_CHANGE",
                    removed: [],
                    added: [],
                    games
                });
            } catch (_) {}
        }
    };

    const createTaskState = (questId) => {
        const state = {
            active: true,
            exitMode: null,
            intervals: [],
            timeouts: [],
            restores: [],
            unsubs: []
        };
        state.trackInterval = (id) => { state.intervals.push(id); return id; };
        state.trackTimeout = (id) => { state.timeouts.push(id); return id; };
        state.addRestore = (fn) => state.restores.push(fn);
        state.addUnsub = (fn) => state.unsubs.push(fn);
        state.cleanup = () => {
            state.active = false;
            state.intervals.forEach(clearInterval);
            state.timeouts.forEach(clearTimeout);
            state.intervals.length = 0;
            state.timeouts.length = 0;
            state.unsubs.forEach(fn => { try { fn(); } catch (_) {} });
            state.unsubs.length = 0;
            state.restores.forEach(fn => { try { fn(); } catch (_) {} });
            state.restores.length = 0;
            activeCleanups.delete(state.cleanup);
        };
        activeCleanups.add(state.cleanup);
        dqmTasks.set(questId, state);
        return state;
    };

    const finishTask = (questId, { stopped = false, error = null, success = false } = {}) => {
        const state = dqmTasks.get(questId);
        if (state) {
            if (stopped) state.exitMode = "stop";
            else if (success) state.exitMode = "success";
            else state.exitMode = "error";
            state.cleanup();
            dqmTasks.delete(questId);
        }
        const quest = QuestsStore.quests.get(questId);
        if (quest) {
            const rt = ensureRuntime(quest);
            rt.running = false;
            if (error) { rt.error = error; rt.status = "error"; }
            else if (stopped) { rt.stopped = true; rt.status = "stopped"; }
            else if (success) { rt.stopped = false; rt.error = null; }
        }
        patchCardStatus(questId);
    };

    const stopQuest = (questId) => {
        const quest = QuestsStore.quests.get(questId);
        const runningId = quest
            ? getQuestDuplicateGroup(quest).find(q => dqmTasks.has(q.id))?.id ?? questId
            : questId;
        const state = dqmTasks.get(runningId);
        if (!state) return;
        state.active = false;
        finishTask(runningId, { stopped: true });
        log.warn(`[${questRuntime.get(runningId)?.name || runningId}] ${t("logStopped")}`);
        log.warn(t("logStopGameHold"));
    };

    const stopAllQuests = () => {
        batchStopRequested = true;
        log.warn(t("logStopAll"));
        for (const id of [...dqmTasks.keys()]) stopQuest(id);
        updateBatchStrip(null);
        updateStopAllVisibility();
        scheduleRender();
    };


    const Executors = {
        async video(quest, taskState, taskName, secondsNeeded, secondsDone) {
            const questName = quest.config.messages.questName;
                const maxFuture = 10, speed = 7, interval = 1;
                const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
                let completed = false;
            let done = secondsDone;

                while (taskState.active) {
                    const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
                const diff = maxAllowed - done;
                const timestamp = Math.min(secondsNeeded, done + speed + (Math.random() * 0.5));
                if (diff >= speed && timestamp > done) {
                    try {
                        const res = await apiPost({
                                url: `/quests/${quest.id}/video-progress`,
                                body: { timestamp }
                            });
                        completed = !!res.body?.completed_at;
                        done = Math.min(secondsNeeded, timestamp);
                        log.running(`[${questName}] ${t("logVideo")}: ${Math.floor(done)}/${secondsNeeded}s`);
                        updateQuestProgress(quest.id, done, secondsNeeded);
                        } catch (e) {
                        log.error(`${t("logAPIError")}${errMsg(e)}`);
                        throw e;
                        }
                    }
                    if (timestamp >= secondsNeeded) break;
                    await sleep(interval * 1000);
                }

                if (taskState.active && !completed) {
                    try {
                    await apiPost({
                            url: `/quests/${quest.id}/video-progress`,
                            body: { timestamp: secondsNeeded }
                        });
                    } catch (e) {
                    log.error(`${t("logAPIError")}${errMsg(e)}`);
                }
            }
            return taskState.active;
        },

        async desktopGame(quest, taskState, taskName, secondsNeeded, secondsDone) {
            const questName = quest.config.messages.questName;
            if (!isApp || !RunningGameStore || !FluxDispatcher) {
                log.error(`[${questName}] ${t("logExecImpossible")}`);
                return false;
                }

                let applicationId = quest.config.application?.id;
                let applicationName = quest.config.application?.name;
                let appData = null;
                let exeName = null;

                if (applicationId) {
                    try {
                    const res = await apiGet({ url: `/applications/public?application_ids=${applicationId}` });
                    appData = res.body?.[0];
                        if (appData) {
                        exeName = appData.executables?.find(x => x.os === "win32")?.name?.replace(">", "") ??
                            appData.name.replace(/[\/\\:*?"<>|]/g, "");
                        }
                    } catch (e) {
                    log.warn(`${t("logAPIError")}${errMsg(e)}`);
                    }
                }

                if (!appData || !exeName) {
                    let fullText = "";
                    if (quest.config.messages) {
                        for (const key in quest.config.messages) {
                        if (typeof quest.config.messages[key] === "string") fullText += " " + quest.config.messages[key];
                        }
                    }
                    fullText = fullText.toLowerCase();
                const guessedName = applicationName || questName || "";
                    if (fullText.includes("roblox") || guessedName.toLowerCase().includes("roblox")) {
                    appData = { name: "Roblox" }; exeName = "RobloxPlayerBeta.exe";
                    } else if (fullText.includes("eve online") || (fullText.includes("eve") && fullText.includes("online")) || guessedName.toLowerCase().includes("eve")) {
                    appData = { name: "EVE Online" }; exeName = "eve.exe";
                    } else if (fullText.includes("shift at midnight") || guessedName.toLowerCase().includes("shift at midnight")) {
                    appData = { name: "Shift At Midnight" }; exeName = "ShiftAtMidnight.exe";
                    } else {
                        appData = { name: guessedName };
                        exeName = guessedName.replace(/[\/\\:*?"<>|]/g, "") + ".exe";
                    }
                }

                const pid = Math.floor(Math.random() * 30000) + 1000;
                const fakeGame = {
                    cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                    exeName,
                    exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                    hidden: false,
                    isLauncher: false,
                    name: appData.name,
                pid,
                    pidPath: [pid],
                    processName: appData.name,
                start: Date.now()
                };
            fakeGame.id = applicationId || pid;

            const realGetRunningGames = gameDetectHold?.realGetRunningGames || RunningGameStore.getRunningGames;
            const realGetGameForPID = gameDetectHold?.realGetGameForPID || RunningGameStore.getGameForPID;
            if (gameDetectHold?.reclearTimer) {
                clearTimeout(gameDetectHold.reclearTimer);
                gameDetectHold.reclearTimer = null;
            }
            gameDetectHold = null;

            taskState.addRestore(() => {
                if (taskState.exitMode === "success") {
                    RunningGameStore.getRunningGames = realGetRunningGames;
                    RunningGameStore.getGameForPID = realGetGameForPID;
                    let games = [];
                    try {
                        games = typeof realGetRunningGames === "function"
                            ? (realGetRunningGames.call(RunningGameStore) || [])
                            : [];
                    } catch (_) {
                        games = [];
                    }
                    try {
                        FluxDispatcher.dispatch({
                            type: "RUNNING_GAMES_CHANGE",
                            removed: fakeGame.id != null ? [fakeGame] : [],
                            added: [],
                            games
                        });
                    } catch (_) {}
                    releaseGameDetectHold();
                } else {
                    try {
                        const terminalPayload = { application_id: applicationId || undefined, pid, terminal: true };
                        if (!terminalPayload.application_id) delete terminalPayload.application_id;
                        apiPost({ url: `/quests/${quest.id}/heartbeat`, body: terminalPayload }).catch(() => {});
                    } catch (_) {}
                    holdGameDetectEmpty(realGetRunningGames, realGetGameForPID, fakeGame);
                }
            });

            const spoofGame = () => {
                if (!taskState.active) return;
                RunningGameStore.getRunningGames = () => [fakeGame];
                RunningGameStore.getGameForPID = (p) => (p === pid ? fakeGame : null);
                FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [], added: [fakeGame], games: [fakeGame] });
            };
            spoofGame();
            taskState.trackInterval(setInterval(spoofGame, 5000));

            let completed = false;
            let done = secondsDone;
            const waitTime = Math.ceil((secondsNeeded - done) / 60);
            log.info(`[${questName}] ${t("logSpoofGame")}${appData.name}${t("logSpoofWait")}${waitTime}${t("logSpoofMinutes")}`);
            updateQuestProgress(quest.id, done, secondsNeeded);

            while (taskState.active && !completed) {
                try {
                    const heartbeatPayload = { application_id: applicationId || undefined, pid, terminal: false };
                    if (!heartbeatPayload.application_id) delete heartbeatPayload.application_id;

                    const res = await apiPost({ url: `/quests/${quest.id}/heartbeat`, body: heartbeatPayload });
                    if (!taskState.active) break;

                    const progress = res.body?.progress?.[taskName]?.value ?? 0;
                    if (res.body?.completed_at) {
                        completed = true;
                        done = secondsNeeded;
                        log.running(`[${questName}] ${t("logGame")}: ${Math.floor(done)}/${secondsNeeded}s`);
                        updateQuestProgress(quest.id, done, secondsNeeded);
                        break;
                    }
                    if (progress > done) {
                        done = progress;
                        log.running(`[${questName}] ${t("logGame")}: ${Math.floor(done)}/${secondsNeeded}s`);
                        updateQuestProgress(quest.id, done, secondsNeeded);
                    }
                    if (done >= secondsNeeded) {
                        if (!taskState.active) break;
                        await apiPost({ url: `/quests/${quest.id}/heartbeat`, body: { ...heartbeatPayload, terminal: true } });
                        if (!taskState.active) break;
                        completed = true;
                        break;
                    }
                    await sleep(20 * 1000);
                } catch (e) {
                    log.error(`${t("logAPIError")}${errMsg(e)}`);
                    throw e;
                }
            }
            return taskState.active && completed;
        },

        async stream(quest, taskState, taskName, secondsNeeded, secondsDone) {
            const questName = quest.config.messages.questName;
            if (!isApp || !ApplicationStreamingStore || !FluxDispatcher) {
                log.error(`[${questName}] ${t("logExecImpossible")}`);
                return false;
            }

            const applicationId = quest.config.application?.id;
            const applicationName = quest.config.application?.name || questName;
                const pid = Math.floor(Math.random() * 30000) + 1000;
                const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
                ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
                id: applicationId, pid, sourceName: null
            });
            taskState.addRestore(() => {
                ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
            });

            return await new Promise((resolve) => {
                let settled = false;
                const settle = (value) => {
                    if (settled) return;
                    settled = true;
                    resolve(value);
                };

                const onHeartbeat = (data) => {
                    try {
                        if (!taskState.active) return;
                        const progress = quest.config.configVersion === 1
                            ? data.userStatus.streamProgressSeconds
                            : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);
                        log.running(`[${questName}] ${t("logStream")}: ${Math.floor(progress)}/${secondsNeeded}s`);
                        updateQuestProgress(quest.id, progress, secondsNeeded);
                        if (progress >= secondsNeeded) {
                            taskState.active = false;
                            settle(true);
                        }
                    } catch (e) {
                        log.error(`${t("logError")}${errMsg(e)}`);
                        taskState.active = false;
                        settle(false);
                    }
                };
                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
                taskState.addUnsub(() => {
                    try { FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat); } catch (_) {}
                });

                const waitTime = Math.ceil((secondsNeeded - secondsDone) / 60);
                log.info(`[${questName}] ${t("logSpoofStream")}${applicationName}${t("logSpoofStreamNote")}${waitTime}${t("logSpoofVCNote")}`);
                updateQuestProgress(quest.id, secondsDone, secondsNeeded);

                const poll = setInterval(() => {
                    if (!taskState.active) settle(false);
                }, 1000);
                taskState.trackInterval(poll);
            });
        },

    };

    const activityExecutors = createActivityExecutors({
        apiPost,
        apiGet,
        sleep,
        log,
        t,
        updateQuestProgress,
        QuestsStore,
        FluxDispatcher
    });

    Object.assign(Executors, {
        playActivity: activityExecutors.playActivity,
        achievementActivity: activityExecutors.achievementActivity
    });

    const refreshQuestsFromApi = async () => {
        try {
            const res = await apiGet({ url: "/quests/@me" });
            const body = res?.body;
            const quests = Array.isArray(body)
                ? body
                : Array.isArray(body?.quests)
                    ? body.quests
                    : [];
            for (const q of quests) {
                const live = QuestsStore.quests.get(q.id);
                if (!live) continue;
                const normalized = normalizeQuestUserStatus(q);
                if (!normalized?.userStatus) continue;
                live.userStatus = {
                    ...live.userStatus,
                    ...normalized.userStatus,
                    progress: normalized.userStatus.progress ?? live.userStatus?.progress
                };
            }
        } catch (_) {}
    };

    const runAchievementActivityQuest = async (quest, taskState, taskName, taskConfig) => {
        const canonical = getCanonicalQuest(quest);
        const duplicateIds = getDuplicateGroupQuestIds(canonical);
        const questName = canonical.config.messages?.questName || canonical.id;
        const checkpointCount = taskConfig.tasks[taskName]?.target || 3;
        const completedCheckpoints = await resolveCompletedCheckpointsAsync(
            canonical.id, taskName, checkpointCount, QuestsStore, apiGet, duplicateIds
        );
        const applicationId = resolveQuestApplicationId(canonical, taskName, taskConfig);

        if (!applicationId) {
            log.error(`[${questName}] ${t("logActivityMissingAppId")}`);
            taskState.active = false;
            return false;
        }

        updateQuestProgress(canonical.id, completedCheckpoints, checkpointCount);
        if (completedCheckpoints > 0) {
            log.info(`[${questName}] ${t("logActivityResumeCheckpoints")
                .replace("{done}", String(completedCheckpoints))
                .replace("{total}", String(checkpointCount))}`);
        }

        try {
            await promptActivityLaunch(canonical, t, (q) => launchQuestInDiscord(q, log, t));
        } catch (_) {
            taskState.active = false;
            return false;
        }

        if (!(await hasMatchingActivityFrame(applicationId))) {
            log.info(`[${questName}] ${t("logActivityLaunching")}`);
            await launchQuestInDiscord(canonical, log, t);
        }

        return activityExecutors.achievementActivity(
            canonical,
            taskState,
            taskName,
            checkpointCount,
            completedCheckpoints,
            duplicateIds
        );
    };

    const executeQuest = async (quest, onComplete) => {
        const canonical = getCanonicalQuest(quest);
        const questId = canonical.id;
        const live = QuestsStore.quests.get(questId) || canonical;
        const questName = live.config.messages?.questName || "Quest";
        const taskConfig = getTaskConfig(live);
        const taskName = resolveTaskName(live);

        if (!taskName) {
            log.warn(`[${questName}] ${t("logTaskNotSupported")}${Object.keys(taskConfig?.tasks || {}).join(", ")}`);
            if (onComplete) onComplete({ ok: false, skipped: true });
            return;
        }
        if (!live.userStatus?.enrolledAt) {
            log.warn(`[${questName}] ${t("logNotEnrolled")}`);
            if (onComplete) onComplete({ ok: false, skipped: true });
            return;
        }
        if (isExpired(live)) {
            log.warn(`[${questName}] expired`);
            if (onComplete) onComplete({ ok: false, skipped: true });
            return;
        }
        if (dqmTasks.has(questId) || isDuplicateGroupRunning(canonical)) {
            log.warn(`[${questName}] ${t("logAlreadyRunning")}`);
            if (onComplete) onComplete({ ok: false, skipped: true });
            return;
        }
        if (batchStopRequested) {
            if (onComplete) onComplete({ ok: false, skipped: true });
            return;
        }

        const secondsNeeded = taskConfig.tasks[taskName]?.target || 0;
        let secondsDone = live.userStatus?.progress?.[taskName]?.value ?? 0;
        const taskState = createTaskState(questId);
        const rt = ensureRuntime(live);
        rt.running = true;
        rt.stopped = false;
        rt.error = null;
        rt.status = "running";
        patchCardStatus(questId);
        updateStopAllVisibility();

        log.info(`[${questName}] ${t("logExecStart")}${taskName})`);

        let ok = false;
        try {
            if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
                ok = await Executors.video(live, taskState, taskName, secondsNeeded, secondsDone);
            } else if (taskName === "PLAY_ON_DESKTOP") {
                ok = await Executors.desktopGame(live, taskState, taskName, secondsNeeded, secondsDone);
            } else if (taskName === "STREAM_ON_DESKTOP") {
                ok = await Executors.stream(live, taskState, taskName, secondsNeeded, secondsDone);
            } else if (taskName === "PLAY_ACTIVITY") {
                ok = await Executors.playActivity(live, taskState, taskName, secondsNeeded, secondsDone);
            } else if (isAchievementActivityTask(taskName, taskConfig)) {
                ok = await runAchievementActivityQuest(live, taskState, taskName, taskConfig);
            } else {
                log.warn(`[${questName}] ${t("logTaskNotSupported")}${taskName}`);
            }

            if (ok) {
                log.success(`[${questName}] ${t("logCompleted")}`);
                finishTask(questId, { success: true });
            } else if (!dqmTasks.has(questId) || !taskState.active) {
                if (dqmTasks.has(questId)) finishTask(questId, { stopped: true });
                else patchCardStatus(questId);
            } else {
                finishTask(questId, { error: "incomplete" });
            }
        } catch (e) {
            log.error(`${t("logUnknownError")}${errMsg(e)}`);
            finishTask(questId, { error: errMsg(e) });
            ok = false;
        }

        scheduleRender();
        updateStopAllVisibility();
        if (onComplete) onComplete({ ok });
    };


    const patchQuestEnrollment = (questId, enrolledAt) => {
        const quest = QuestsStore.quests.get(questId);
        if (!quest) return;
        quest.userStatus = {
            ...(quest.userStatus || {}),
            enrolledAt,
            completedAt: quest.userStatus?.completedAt ?? null,
            claimedAt: quest.userStatus?.claimedAt ?? null,
            progress: quest.userStatus?.progress || {}
        };
        patchCardStatus(questId);
    };

    const acceptQuest = async (quest) => {
        const canonical = getCanonicalQuest(quest);
        const questId = canonical.id;
        const name = canonical.config.messages?.questName || questId;
        const live = QuestsStore.quests.get(questId) || canonical;

        if (acceptsInFlight.has(questId)) return;
        if (getQuestDuplicateGroup(canonical).some(q => q.userStatus?.enrolledAt)) return;
        if (isExpired(live)) return;

        acceptsInFlight.add(questId);
        scheduleRender();
        log.info(`[${name}] ${t("logActivateClick")}`);

        try {
            try {
                await apiPost({
                    url: `/quests/${questId}/enroll`,
                    body: {
                        location: 11,
                        is_targeted: false,
                        metadata_raw: null
                    }
                });
            } catch (_) {
                await apiPost({
                    url: `/quests/${questId}/enroll`,
                    body: { location: 11 }
                });
            }

            patchQuestEnrollment(questId, new Date().toISOString());
            log.success(`[${name}] ${t("logActivateSuccess")}`);
            scheduleRender();
        } catch (e) {
            log.error(`[${name}] ${t("logActivateFailed")}${errMsg(e)}`);
        } finally {
            acceptsInFlight.delete(questId);
            scheduleRender();
        }
    };

    const claimQuest = async (quest) => {
        const questId = quest.id;
        const name = quest.config.messages?.questName || questId;
        const live = QuestsStore.quests.get(questId) || quest;

        if (live.userStatus?.claimedAt) {
            log.warn(`[${name}] ${t("logClaimAlready")}`);
            return;
        }
        if (!live.userStatus?.completedAt) {
            log.warn(`[${name}] ${t("logClaimNotReady")}`);
            return;
        }
        if (claimsInFlight.has(questId)) {
            log.warn(`[${name}] ${t("logAlreadyRunning")}`);
            return;
        }

        claimsInFlight.add(questId);
        log.info(`[${name}] ${t("logClaimClick")}`);

        try {
            await apiPost({
                url: `/quests/${questId}/claim-reward`,
                body: {
                    platform: 0,
                    location: 11,
                    is_targeted: false,
                    metadata_raw: null
                }
            });

            const deadline = Date.now() + 5000;
            let confirmed = false;
            while (Date.now() < deadline) {
                const updated = QuestsStore.quests.get(questId);
                if (updated?.userStatus?.claimedAt) {
                    confirmed = true;
                    break;
                }
                await sleep(250);
            }

            if (confirmed) {
                log.success(`[${name}] ${t("logClaimMarked")}`);
            } else {
                log.warn(`[${name}] ${t("logClaimPending")}`);
            }
            await fetchUserOrbsBalance();
            scheduleRender({ bustOrbs: true });
        } catch (e) {
            log.error(`[${name}] ${t("logAPIError")}${errMsg(e)}`);
            log.warn(`[${name}] ${t("logClaimManual")}`);
        } finally {
            claimsInFlight.delete(questId);
        }
    };

    const launchQuestUi = (quest) => {
        const questId = quest.id;
        const name = quest.config.messages?.questName || questId;
        if (launchesInFlight.has(questId)) return;

        launchesInFlight.add(questId);
        log.info(`[${name}] ${t("logLaunchClick")}`);
        launchQuestInDiscord(quest, log, t).finally(() => {
            launchesInFlight.delete(questId);
        });
    };


    const updateBatchStrip = (info) => {
        if (!batchStrip) return;
        if (!info) {
            batchStrip.hidden = true;
            batchStrip.textContent = "";
            return;
        }
        batchStrip.hidden = false;
        if (info.preparing) {
            batchStrip.textContent = t("batchPreparing");
            return;
        }
        const line1 = t("batchProgress").replace("{i}", info.i).replace("{n}", info.n);
        const line2 = t("batchCurrent") + (info.name || "");
        const pct = info.overall != null ? ` — ${t("batchOverall")}: ${info.overall}%` : "";
        batchStrip.textContent = `${line1} · ${line2}${pct}`;
    };

    const updateStopAllVisibility = () => {
        if (!stopAllBtn) return;
        const show = batchRunning || dqmTasks.size > 0;
        stopAllBtn.hidden = !show;
        stopAllBtn.disabled = !show;
    };

    const runAllQuests = async () => {
        if (batchRunning) return;
        batchStopRequested = false;
        batchRunning = true;
        updateStopAllVisibility();
        updateBatchStrip({ preparing: true });

        const quests = dedupeQuests([...QuestsStore.quests.values()]).filter(isBatchRunnableQuest);
        if (quests.length === 0) {
            log.warn(t("logNoQuests"));
            batchRunning = false;
            updateBatchStrip(null);
            updateStopAllVisibility();
            return;
        }

        log.info(t("logBatchStart") + quests.length + t("logBatchEnd"));
        let ok = 0, skipped = 0, failed = 0;

        for (let i = 0; i < quests.length; i++) {
            if (batchStopRequested) break;
            const quest = quests[i];
            const name = quest.config.messages?.questName || quest.id;
            const overall = Math.round((i / quests.length) * 100);
            updateBatchStrip({ i: i + 1, n: quests.length, name, overall });

            const result = await new Promise(resolve => executeQuest(quest, resolve));
            if (!result || result.skipped) skipped++;
            else if (result.ok) ok++;
            else failed++;
        }

        updateBatchStrip({
            i: quests.length,
            n: quests.length,
            name: "—",
            overall: batchStopRequested ? Math.round((ok / quests.length) * 100) : 100
        });
        log.success(t("logBatchSummary") + ok + t("logBatchSkipped") + skipped + t("logBatchFailed") + failed);
        log.info(t("logAllDone"));
        batchRunning = false;
        batchStopRequested = false;
        setTimeout(() => updateBatchStrip(null), 2500);
        updateStopAllVisibility();
        scheduleRender();
    };


    let renderQueued = false;
    let renderOpts = {};
    const scheduleRender = (opts = {}) => {
        Object.assign(renderOpts, opts);
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            const o = renderOpts;
            renderOpts = {};
            renderQuests(o);
        });
    };

    const sumQuestOrbsForFilter = (filter) => {
        let total = 0;
        for (const q of dedupeQuests(getAllStoreQuests().filter(quest => !isExpired(quest)))) {
            if (getQuestBucket(q) !== filter) continue;
            const v = getQuestOrbs(q);
            if (v != null) total += v;
        }
        return total;
    };

    const countQuestsForFilter = (filter) => {
        let count = 0;
        for (const q of dedupeQuests(getAllStoreQuests().filter(quest => !isExpired(quest)))) {
            if (getQuestBucket(q) === filter) count++;
        }
        return count;
    };

    const countTotalQuests = () => {
        return dedupeQuests(getAllStoreQuests().filter(q => !isExpired(q))).length;
    };

    const updateTabStats = () => {
        const pairs = [
            ["incomplete", "dqm-tab-quests-incomplete", "dqm-tab-orbs-incomplete"],
            ["claimable", "dqm-tab-quests-claimable", "dqm-tab-orbs-claimable"],
            ["complete", "dqm-tab-quests-complete", "dqm-tab-orbs-complete"]
        ];
        for (const [filter, qId, oId] of pairs) {
            const qEl = document.getElementById(qId);
            const oEl = document.getElementById(oId);
            if (qEl) qEl.textContent = String(countQuestsForFilter(filter));
            if (oEl) oEl.textContent = String(sumQuestOrbsForFilter(filter));
        }
    };

    const fetchUserOrbsBalance = async () => {
        try {
            const res = await apiGet({ url: "/users/@me/virtual-currency/balance" });
            const body = res?.body;
            if (typeof body === "string" && /^\s*</.test(body)) {
                log.debug("Orbs balance: invalid API response");
                return;
            }
            const bal = body?.balance ?? body?.virtual_currency_balance ?? 0;
            userOrbsBalance = typeof bal === "number" ? bal : (parseInt(bal, 10) || 0);
        } catch (e) {
            const msg = errMsg(e);
            log.debug(msg.includes("[object Object]")
                ? "Orbs balance: Discord API module mismatch"
                : `Orbs balance: ${msg}`);
        }
        updateRunningStats();
    };

    const updateRunningStats = () => {
        const qEl = document.getElementById("dqm-stat-quests");
        const oEl = document.getElementById("dqm-stat-orbs");
        const rEl = document.getElementById("dqm-stat-running");
        if (!listContainer) return;
        if (qEl) qEl.textContent = String(countTotalQuests());
        if (oEl) oEl.textContent = userOrbsBalance != null ? String(userOrbsBalance) : "—";
        if (rEl) rEl.textContent = String(dqmTasks.size);
        updateTabStats();
    };

    const updateMiniRunning = () => {
        if (!miniIcon) return;
        miniIcon.classList.toggle("dqm-mini--running", dqmTasks.size > 0);
    };

    const updateEmptyState = (visible, key) => {
        if (!listContainer) return;
        if (!emptyStateEl) {
            emptyStateEl = document.createElement("div");
            emptyStateEl.className = "dqm-empty";
        }
        if (visible) {
            emptyStateEl.textContent = t(key);
            if (!emptyStateEl.parentNode) listContainer.appendChild(emptyStateEl);
        } else if (emptyStateEl.parentNode) emptyStateEl.remove();
    };

    const buildCardActions = (card, quest, rt) => {
        const actions = card.querySelector(".actions");
        if (!actions) return;
        actions.textContent = "";
        const canonical = getCanonicalQuest(quest);
        const group = getQuestDuplicateGroup(canonical);
        const enrolled = group.some(q => q.userStatus?.enrolledAt);
        const completed = group.some(q => q.userStatus?.completedAt);
        const claimed = group.some(q => q.userStatus?.claimedAt);
        const running = isDuplicateGroupRunning(canonical);
        const details = getQuestTypeDetails(canonical);

        const addBtn = (cls, label, onClick, aria, disabled = false) => {
            const b = document.createElement("button");
            b.className = "dqm-action-btn " + cls;
            b.textContent = label;
            b.setAttribute("aria-label", aria || label);
            b.disabled = disabled;
            if (onClick) b.onclick = onClick;
            actions.appendChild(b);
        };

        if (!enrolled && !completed && !claimed && !isExpired(canonical)) {
            if (acceptsInFlight.has(canonical.id)) {
                addBtn("dqm-action-activate", t("btnActivating"), null, null, true);
            } else {
                addBtn("dqm-action-activate", t("btnActivate"), () => acceptQuest(canonical));
            }
        }

        if (enrolled && !completed && !claimed) {
            if (running) {
                addBtn("dqm-action-stop", t("btnStop"), () => stopQuest(canonical.id));
            } else if (isRunnableQuest(canonical)) {
                addBtn("dqm-action-start", t("btnStart"), () => executeQuest(canonical));
            }
            if (details.type === "Launch Quest" && isAchievementActivityTask(details.taskName, getTaskConfig(canonical))) {
                addBtn("dqm-action-launch", t("btnOpenDiscord"), () => launchQuestUi(canonical));
            }
        }
        if (completed && !claimed) {
            const claimTarget = group.find(q => q.userStatus?.completedAt && !q.userStatus?.claimedAt) ?? canonical;
            addBtn("dqm-action-claim", t("btnClaim"), () => claimQuest(claimTarget));
        }
    };

    const createQuestCard = (quest) => {
        const card = document.createElement("div");
        card.className = "dqm-card";
        card.id = `quest-card-${quest.id}`;
        card.dataset.questId = quest.id;

        const nameEl = document.createElement("div");
        nameEl.className = "dqm-card-name";

        const meta = document.createElement("div");
        meta.className = "dqm-card-meta";

        const makeItem = (labelClass, valueClass) => {
            const row = document.createElement("div");
            row.className = "dqm-meta-item";
            const b = document.createElement("b");
            b.className = labelClass;
            const v = document.createElement("span");
            v.className = valueClass;
            row.appendChild(b);
            row.appendChild(v);
            return row;
        };

        meta.appendChild(makeItem("dqm-lbl-type", "dqm-type-badge"));
        meta.appendChild(makeItem("dqm-lbl-orbs", "dqm-orbs-val"));
        meta.appendChild(makeItem("dqm-lbl-status", "dqm-status"));
        meta.appendChild(makeItem("dqm-lbl-ends", "dqm-ends-val"));

        const countryRow = document.createElement("div");
        countryRow.className = "dqm-meta-item dqm-meta-country";
        const countryLbl = document.createElement("b");
        countryLbl.className = "dqm-lbl-country";
        const countryVal = document.createElement("span");
        countryVal.className = "dqm-country-val";
        const countryFlag = document.createElement("span");
        countryFlag.className = "dqm-country-flag";
        countryFlag.setAttribute("aria-hidden", "true");
        const countryLabel = document.createElement("span");
        countryLabel.className = "dqm-country-label";
        const countryExtra = document.createElement("span");
        countryExtra.className = "dqm-country-extra";
        const countrySelect = document.createElement("select");
        countrySelect.className = "dqm-country-select";
        countrySelect.setAttribute("aria-label", "Country");
        countrySelect.title = "Override country";
        countryVal.appendChild(countryFlag);
        countryVal.appendChild(countryLabel);
        countryVal.appendChild(countryExtra);
        countryVal.appendChild(countrySelect);
        countryRow.appendChild(countryLbl);
        countryRow.appendChild(countryVal);
        meta.appendChild(countryRow);

        countrySelect.addEventListener("change", () => {
            const questId = card.dataset.questId;
            if (!questId) return;
            const next = setCountryOverride(questId, countrySelect.value);
            applyCountryToCard(card, { source: "override", code: next, extra: 0, status: "ready" });
        });
        countrySelect.addEventListener("click", (e) => e.stopPropagation());
        countrySelect.addEventListener("mousedown", (e) => e.stopPropagation());

        const progressWrap = document.createElement("div");
        progressWrap.className = "dqm-progress-wrap";
        const labels = document.createElement("div");
        labels.className = "dqm-progress-labels";
        const progressText = document.createElement("span");
        progressText.className = "quest-progress-text";
        const percentEl = document.createElement("span");
        percentEl.className = "quest-progress-percent";
        labels.appendChild(progressText);
        labels.appendChild(percentEl);
        const track = document.createElement("div");
        track.className = "dqm-progress-track";
        const bar = document.createElement("div");
        bar.className = "quest-progress-bar";
        track.appendChild(bar);
        const eta = document.createElement("div");
        eta.className = "dqm-eta";
        progressWrap.appendChild(labels);
        progressWrap.appendChild(track);
        progressWrap.appendChild(eta);

        const actions = document.createElement("div");
        actions.className = "actions";

        card.appendChild(nameEl);
        card.appendChild(meta);
        card.appendChild(progressWrap);
        card.appendChild(actions);
        updateQuestCard(card, quest);
        return card;
    };

    const updateQuestCard = (card, quest) => {
        const canonical = getCanonicalQuest(quest);
        const rt = getGroupRuntime(canonical);
        const details = getQuestTypeDetails(canonical);
        const { progress, total } = getDisplayProgress(canonical, rt);
        const percent = Math.min(100, Math.round((progress / Math.max(total, 1)) * 100));
            const orbsValue = getQuestOrbs(canonical);
        const expiresAt = new Date(canonical.config.expiresAt).toLocaleDateString(timeLocale());
        const dupCount = isLaunchQuestType(canonical) ? getQuestDuplicateGroup(canonical).length : 1;

        setCardStatusClass(card, rt.status);

        const nameEl = card.querySelector(".dqm-card-name");
        if (nameEl) {
            nameEl.textContent = dupCount > 1
                ? `${rt.name} · ${t("labelMergedListings").replace("{n}", String(dupCount))}`
                : rt.name;
        }

        const setLbl = (sel, text) => {
            const el = card.querySelector(sel);
            if (el) el.textContent = text + ":";
        };
        setLbl(".dqm-lbl-type", t("labelType"));
        setLbl(".dqm-lbl-orbs", t("labelOrbs"));
        setLbl(".dqm-lbl-status", t("labelStatus"));
        setLbl(".dqm-lbl-ends", t("labelEnds"));
        setLbl(".dqm-lbl-country", t("labelCountry"));

        const typeBadge = card.querySelector(".dqm-type-badge");
        if (typeBadge) typeBadge.textContent = details.label;
        const orbsVal = card.querySelector(".dqm-orbs-val");
        if (orbsVal) orbsVal.textContent = orbsValue != null ? String(orbsValue) : "—";
        const statusEl = card.querySelector(".dqm-status");
        if (statusEl) {
            statusEl.textContent = statusLabelFor(rt.status);
            statusEl.style.color = statusColorFor(rt.status);
        }
        const endsVal = card.querySelector(".dqm-ends-val");
        if (endsVal) endsVal.textContent = expiresAt;

        const countrySelect = card.querySelector(".dqm-country-select");
        if (countrySelect) countrySelect.setAttribute("aria-label", t("labelCountry"));

        const syncCountryUi = (resolved) => {
            applyCountryToCard(card, resolved);
        };

        const syncResolved = resolveQuestCountrySync(canonical.id);
        if (syncResolved.status === "ready") {
            countryResolveInFlight.delete(canonical.id);
            syncCountryUi(syncResolved);
        } else if (countryResolveInFlight.has(canonical.id)) {
            syncCountryUi(syncResolved);
        } else {
            syncCountryUi(syncResolved);
            countryResolveInFlight.add(canonical.id);
            resolveQuestCountry(canonical.id).then((resolved) => {
                countryResolveInFlight.delete(canonical.id);
                if (cardByQuestId.get(canonical.id) !== card) return;
                syncCountryUi(resolved);
                refreshCountryFilterOptions();
            });
        }

        const progressText = card.querySelector(".quest-progress-text");
        if (progressText) progressText.textContent = formatProgressText(canonical, progress, total);
        const percentEl = card.querySelector(".quest-progress-percent");
        if (percentEl) percentEl.textContent = `${percent}%`;
        const bar = card.querySelector(".quest-progress-bar");
        if (bar) {
            bar.style.width = percent + "%";
            bar.style.background = progressBarColorVar(percent, rt.claimed);
        }
        const etaEl = card.querySelector(".dqm-eta");
        if (etaEl) {
            const mins = getProgressEtaMinutes(canonical, progress, total);
            etaEl.textContent = (rt.running || progress < total)
                ? `${t("labelEta")}: ~${mins}m`
                : "";
        }

        buildCardActions(card, canonical, rt);
    };

    const renderQuests = ({ bustOrbs = false } = {}) => {
        if (!listContainer) return;
        if (bustOrbs) orbsCache.clear();

        const allQuests = dedupeQuests([...QuestsStore.quests.values()]);
        const visible = allQuests.filter(matchesFilter);
        const visibleIds = new Set(visible.map(q => q.id));

        for (const [id, card] of cardByQuestId) {
            if (!visibleIds.has(id)) {
                card.remove();
                cardByQuestId.delete(id);
            }
        }

        if (allQuests.length === 0) {
            for (const [, card] of cardByQuestId) card.remove();
            cardByQuestId.clear();
            updateEmptyState(true, "logNoData");
            updateRunningStats();
            return;
        }

        const frag = document.createDocumentFragment();
        let appendedNew = false;
        for (const quest of visible) {
            let card = cardByQuestId.get(quest.id);
            if (!card) {
                card = createQuestCard(quest);
                cardByQuestId.set(quest.id, card);
                frag.appendChild(card);
                appendedNew = true;
            } else {
                updateQuestCard(card, quest);
            }
        }
        if (appendedNew) listContainer.appendChild(frag);
        updateEmptyState(visible.length === 0, "logNoCategory");
        updateRunningStats();
        updateMiniRunning();
        updateStopAllVisibility();
    };

    const applyDir = () => {
        if (!gui) return;
        gui.dir = currentLang === "ar" ? "rtl" : "ltr";
        gui.lang = currentLang === "ar" ? "ar" : "en";
    };

    const updateUITexts = () => {
        applyDir();
        const map = {
            "dqm-title": t("title"),
            "dqm-run-all": t("btnComplete"),
            "dqm-stop-all": t("btnStopAll"),
            "dqm-refresh": t("btnRefresh"),
            "dqm-copy-logs": t("btnCopy"),
            "dqm-lang-toggle": t("btnLang")
        };
        for (const [id, text] of Object.entries(map)) {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        }
        const min = document.getElementById("dqm-minimize");
        const close = document.getElementById("dqm-close");
        if (min) { min.setAttribute("aria-label", t("btnMinimize")); min.title = t("btnMinimize"); }
        if (close) { close.setAttribute("aria-label", t("btnClose")); close.title = t("btnClose"); }

        const tabLabels = {
            incomplete: t("tabIncomplete"),
            claimable: t("tabClaimable"),
            complete: t("tabComplete")
        };
        gui.querySelectorAll(".tab-btn").forEach(btn => {
            const filter = btn.getAttribute("data-filter");
            const label = btn.querySelector(".tab-label");
            if (label && tabLabels[filter]) label.textContent = tabLabels[filter];
        });

        const countryFilterLbl = gui.querySelector(".dqm-country-filter-label");
        if (countryFilterLbl) countryFilterLbl.textContent = t("labelCountryFilter");

        const sub = document.getElementById("dqm-subtitle");
        if (sub) sub.textContent = `${t("statQuests")} · ${t("statOrbs")} · ${PLUGIN_VERSION_LABEL}`;

        const versionEl = document.getElementById("dqm-version");
        if (versionEl) versionEl.textContent = getPluginVersionLabel();

        const checkBtn = document.getElementById("dqm-check-update");
        if (checkBtn) checkBtn.textContent = t("btnCheckUpdate");
        const applyBtn = document.getElementById("dqm-apply-update");
        if (applyBtn) applyBtn.textContent = t("btnApplyUpdate");

        document.querySelector(".dqm-chip-quests-label") && (document.querySelector(".dqm-chip-quests-label").textContent = t("statQuests"));
        document.querySelector(".dqm-chip-orbs-label") && (document.querySelector(".dqm-chip-orbs-label").textContent = t("statOrbs"));
        document.querySelector(".dqm-chip-run-label") && (document.querySelector(".dqm-chip-run-label").textContent = t("statRunning"));
        updateLocationChip(currentIpCountry);
        refreshCountryFilterOptions();

        gui.querySelectorAll(".dqm-tab-quests-label").forEach(el => { el.textContent = t("statQuests"); });
        gui.querySelectorAll(".dqm-tab-orbs-label").forEach(el => { el.textContent = t("statOrbs"); });

        scheduleRender();
    };

    const clampGuiToViewport = () => {
        if (!gui) return;
        const rect = gui.getBoundingClientRect();
        const maxL = Math.max(8, window.innerWidth - rect.width - 8);
        const maxT = Math.max(8, window.innerHeight - Math.min(rect.height, window.innerHeight - 8) - 8);
        let left = rect.left;
        let top = rect.top;
        left = Math.min(Math.max(8, left), maxL);
        top = Math.min(Math.max(8, top), maxT);
        gui.style.left = left + "px";
        gui.style.top = top + "px";
        gui.style.right = "auto";
    };


    const onViewportResize = () => clampGuiToViewport();

    const cleanupAll = () => {
        batchStopRequested = true;
        window.removeEventListener("resize", onViewportResize);
        for (const fn of [...activeCleanups]) {
            try { fn(); } catch (_) {}
        }
        activeCleanups.clear();
        dqmTasks.forEach((task) => {
            try { task.active = false; task.cleanup?.(); } catch (_) {}
        });
        dqmTasks.clear();
        releaseGameDetectHold();
        cardByQuestId.clear();
        orbsCache.clear();
        questRuntime.clear();
        claimsInFlight.clear();
        acceptsInFlight.clear();
        launchesInFlight.clear();
        userOrbsBalance = null;
        gui?.remove();
        miniIcon?.remove();
        document.getElementById("dqm-gui")?.remove();
        document.getElementById("dqm-gui-slynxe")?.remove();
        document.getElementById("dqm-mini-icon")?.remove();
        gui = null;
        logBox = null;
        listContainer = null;
        miniIcon = null;
    };


    document.getElementById("dqm-gui")?.remove();
    document.getElementById("dqm-gui-slynxe")?.remove();
    document.getElementById("dqm-mini-icon")?.remove();
    gui = document.createElement("div");
    gui.id = "dqm-gui";
    gui.setAttribute("role", "dialog");
    gui.setAttribute("aria-label", "Quests Manager");
    applyDir();

    gui.innerHTML = `
        <div id="dqm-header" class="dqm-header">
            <div class="dqm-header-top">
                <div class="dqm-brand">
                    <div class="dqm-brand-mark" aria-hidden="true">🎮</div>
                    <div class="dqm-brand-text">
                        <span id="dqm-title"></span>
                        <span id="dqm-subtitle" class="dqm-subtitle"></span>
                </div>
                    </div>
                <div class="dqm-win-btns">
                    <button id="dqm-minimize" class="dqm-btn-icon" type="button">─</button>
                    <button id="dqm-close" class="dqm-btn-icon dqm-close" type="button">✕</button>
                    </div>
                </div>
            <div class="dqm-stats">
                <span class="dqm-chip"><span class="dqm-chip-quests-label"></span> <strong id="dqm-stat-quests">0</strong></span>
                <span class="dqm-chip dqm-chip--orbs"><span class="dqm-chip-orbs-label"></span> <strong id="dqm-stat-orbs">0</strong></span>
                <span class="dqm-chip dqm-chip--run"><span class="dqm-chip-run-label"></span> <strong id="dqm-stat-running">0</strong></span>
                <span class="dqm-chip dqm-chip--location"><span class="dqm-chip-location-label"></span> <strong id="dqm-stat-location">—</strong></span>
                <span class="dqm-chip dqm-chip--version" title="Plugin version"><strong id="dqm-version">${PLUGIN_VERSION_LABEL}</strong></span>
            </div>
            <div class="dqm-toolbar">
                <button id="dqm-run-all" class="dqm-btn dqm-btn-green" type="button"></button>
                <button id="dqm-stop-all" class="dqm-btn dqm-btn-danger" type="button" hidden></button>
                <button id="dqm-refresh" class="dqm-btn dqm-btn-gray" type="button"></button>
                <button id="dqm-copy-logs" class="dqm-btn dqm-btn-gray" type="button"></button>
                <button id="dqm-lang-toggle" class="dqm-btn dqm-btn-blurple" type="button"></button>
            </div>
            <div class="dqm-update-bar">
                <span id="dqm-update-status" class="dqm-update-status"></span>
                <button id="dqm-check-update" class="dqm-btn dqm-btn-gray dqm-btn-sm" type="button"></button>
                <button id="dqm-apply-update" class="dqm-btn dqm-btn-blurple dqm-btn-sm" type="button" hidden></button>
            </div>
        </div>
        <div id="dqm-batch" class="dqm-batch" hidden></div>
        <div class="dqm-tabs">
            <div class="tab-col">
                <div class="dqm-tab-stats">
                    <span class="dqm-chip dqm-chip--sm">
                        <span class="dqm-tab-quests-label"></span> <strong id="dqm-tab-quests-incomplete">0</strong>
                    </span>
                    <span class="dqm-chip dqm-chip--sm dqm-chip--orbs">
                        <span class="dqm-tab-orbs-label"></span> <strong id="dqm-tab-orbs-incomplete">0</strong>
                    </span>
                </div>
                <button class="tab-btn active" data-filter="incomplete" type="button">
                    <span class="tab-label"></span>
                </button>
            </div>
            <div class="tab-col">
                <div class="dqm-tab-stats">
                    <span class="dqm-chip dqm-chip--sm">
                        <span class="dqm-tab-quests-label"></span> <strong id="dqm-tab-quests-claimable">0</strong>
                    </span>
                    <span class="dqm-chip dqm-chip--sm dqm-chip--orbs">
                        <span class="dqm-tab-orbs-label"></span> <strong id="dqm-tab-orbs-claimable">0</strong>
                    </span>
                </div>
                <button class="tab-btn" data-filter="claimable" type="button">
                    <span class="tab-label"></span>
                </button>
            </div>
            <div class="tab-col">
                <div class="dqm-tab-stats">
                    <span class="dqm-chip dqm-chip--sm">
                        <span class="dqm-tab-quests-label"></span> <strong id="dqm-tab-quests-complete">0</strong>
                    </span>
                    <span class="dqm-chip dqm-chip--sm dqm-chip--orbs">
                        <span class="dqm-tab-orbs-label"></span> <strong id="dqm-tab-orbs-complete">0</strong>
                    </span>
                </div>
                <button class="tab-btn" data-filter="complete" type="button">
                    <span class="tab-label"></span>
                </button>
            </div>
            <div class="dqm-country-filter-wrap">
                <label class="dqm-country-filter-label" for="dqm-country-filter"></label>
                <select id="dqm-country-filter" class="dqm-country-filter" aria-label="Filter by country"></select>
            </div>
        </div>
        <div id="dqm-list"></div>
        <div id="dqm-logs" aria-live="polite"></div>
    `;
    document.body.appendChild(gui);
    logBox = gui.querySelector("#dqm-logs");
    listContainer = gui.querySelector("#dqm-list");
    batchStrip = gui.querySelector("#dqm-batch");
    stopAllBtn = gui.querySelector("#dqm-stop-all");

    updateUITexts();
    log.info(t("logReady"));
    log.info(t("logReadyServer"));
    if (missing.length > 2) log.warn(t("warnPartialModules") + " " + missing.join(", "));

    miniIcon = document.createElement("div");
    miniIcon.id = "dqm-mini-icon";
    miniIcon.textContent = "🎮";
    miniIcon.setAttribute("role", "button");
    miniIcon.setAttribute("aria-label", t("title"));
    document.body.appendChild(miniIcon);


    gui.querySelector("#dqm-close").onclick = () => hidePanel();
    gui.querySelector("#dqm-minimize").onclick = () => {
        gui.style.display = "none";
        miniIcon.style.display = 'flex';
        const r = gui.getBoundingClientRect();
        miniIcon.style.right = '525px';
        miniIcon.style.top = '5px';
        miniIcon.style.left = 'auto';
    };
    gui.querySelector("#dqm-refresh").onclick = async () => {
        await Promise.all([
            refreshQuestsFromApi(),
            ensureRegionsCatalog({ force: true }),
            fetchIpCountry({ force: true })
        ]);
        refreshCountryFilterOptions();
        scheduleRender({ bustOrbs: true });
        await fetchUserOrbsBalance();
        log.info(t("logRefresh"));
    };
    gui.querySelector("#dqm-run-all").onclick = () => runAllQuests();
    stopAllBtn.onclick = () => stopAllQuests();
    gui.querySelector("#dqm-copy-logs").onclick = async () => {
        try {
            await navigator.clipboard.writeText(logBox.innerText || "");
            log.success(t("logCopySuccess"));
        } catch (e) {
            log.error(t("logCopyError"));
        }
    };
    gui.querySelector("#dqm-lang-toggle").onclick = () => {
        currentLang = currentLang === "en" ? "ar" : "en";
        updateUITexts();
    };

    let pendingUpdateZipUrl = null;
    const setUpdateStatus = (text, kind = "") => {
        const el = document.getElementById("dqm-update-status");
        if (!el) return;
        el.textContent = text || "";
        el.classList.remove("dqm-update--ok", "dqm-update--warn", "dqm-update--err");
        if (kind) el.classList.add(`dqm-update--${kind}`);
    };
    const setApplyVisible = (visible) => {
        const btn = document.getElementById("dqm-apply-update");
        if (btn) btn.hidden = !visible;
    };

    const runUpdateCheck = async ({ silent = false } = {}) => {
        if (!silent) setUpdateStatus(t("updateChecking"));
        setApplyVisible(false);
        pendingUpdateZipUrl = null;
        const result = await checkForPluginUpdate();
        if (!result.ok) {
            setUpdateStatus(t("updateCheckFailed") + (result.error || ""), "err");
            return result;
        }
        if (result.hasUpdate && result.release?.srcZipUrl) {
            pendingUpdateZipUrl = result.release.srcZipUrl;
            setUpdateStatus(
                t("updateAvailable").replace("{tag}", result.latest || ""),
                "warn"
            );
            setApplyVisible(true);
        } else if (result.hasUpdate && !result.release?.srcZipUrl) {
            setUpdateStatus(
                t("updateAvailable").replace("{tag}", result.latest || "") + ` — ${getReleasesPageUrl()}`,
                "warn"
            );
        } else {
            setUpdateStatus(t("updateLatest") + ` (${PLUGIN_VERSION_LABEL})`, "ok");
        }
        return result;
    };

    gui.querySelector("#dqm-check-update").onclick = () => { runUpdateCheck(); };
    gui.querySelector("#dqm-apply-update").onclick = async () => {
        if (!pendingUpdateZipUrl) {
            await runUpdateCheck();
            if (!pendingUpdateZipUrl) return;
        }
        setUpdateStatus(t("updateApplying"), "warn");
        setApplyVisible(false);
        const applied = await applyPluginUpdate(pendingUpdateZipUrl);
        if (applied.ok) {
            setUpdateStatus(t("updateDone"), "ok");
            log.success(applied.message || t("updateDone"));
        } else {
            setUpdateStatus(t("updateFailed") + applied.message, "err");
            log.error(t("updateFailed") + applied.message);
            setApplyVisible(true);
        }
    };

    gui.querySelectorAll(".tab-btn").forEach(btn => {
        btn.onclick = (e) => {
            gui.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            e.currentTarget.classList.add("active");
            currentFilter = e.currentTarget.getAttribute("data-filter");
            scheduleRender();
        };
    });
    const countryFilterEl = gui.querySelector("#dqm-country-filter");
    if (countryFilterEl) {
        countryFilterEl.onchange = () => {
            currentCountryFilter = countryFilterEl.value || "all";
            scheduleRender();
        };
    }


    const header = gui.querySelector("#dqm-header");
    let dragging = false, sx, sy, sl, st;
    header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return;
        dragging = true;
        header.style.cursor = "grabbing";
        sx = e.clientX; sy = e.clientY;
        const rect = gui.getBoundingClientRect();
        sl = rect.left; st = rect.top;
        gui.style.right = "auto";
        gui.style.left = sl + "px";
        document.addEventListener("mousemove", onDrag);
        document.addEventListener("mouseup", onDragEnd);
        e.preventDefault();
    });
    const onDrag = (e) => {
        if (!dragging) return;
        gui.style.left = (sl + e.clientX - sx) + "px";
        gui.style.top = (st + e.clientY - sy) + "px";
    };
    const onDragEnd = () => {
        dragging = false;
        header.style.cursor = "grab";
        document.removeEventListener("mousemove", onDrag);
        document.removeEventListener("mouseup", onDragEnd);
        clampGuiToViewport();
    };


    let miniDrag = false, mSx, mSy, mSl, mSt, miniMoved = false;
    miniIcon.addEventListener("mousedown", (e) => {
        miniDrag = true; miniMoved = false;
        mSx = e.clientX; mSy = e.clientY;
        const rect = miniIcon.getBoundingClientRect();
        mSl = rect.left; mSt = rect.top;
        miniIcon.style.right = "auto";
        miniIcon.style.left = mSl + "px";
        document.addEventListener("mousemove", onMiniMove);
        document.addEventListener("mouseup", onMiniUp);
        e.preventDefault();
    });
    const onMiniMove = (e) => {
        if (!miniDrag) return;
        miniMoved = true;
        miniIcon.style.left = (mSl + e.clientX - mSx) + "px";
        miniIcon.style.top = (mSt + e.clientY - mSy) + "px";
    };
    const onMiniUp = () => {
        miniDrag = false;
        document.removeEventListener("mousemove", onMiniMove);
        document.removeEventListener("mouseup", onMiniUp);
        if (!miniMoved) {
            miniIcon.style.display = "none";
            gui.style.display = "flex";
            panelHidden = false;
            clampGuiToViewport();
        }
    };

    window.addEventListener("resize", onViewportResize);

    const onQuestsStoreChange = () => {
        scheduleRender();
        fetchUserOrbsBalance();
    };
    if (QuestsStore?.addChangeListener) {
        QuestsStore.addChangeListener(onQuestsStoreChange);
        activeCleanups.add(() => {
            try { QuestsStore.removeChangeListener(onQuestsStoreChange); } catch (_) {}
        });
    }

    fetchUserOrbsBalance();
    ensureRegionsCatalog().then(() => {
        refreshCountryFilterOptions();
        scheduleRender();
    }).catch(() => {});
    fetchIpCountry().catch(() => {});
    refreshQuestsFromApi().then(() => renderQuests());
    runUpdateCheck({ silent: true }).catch(() => {});
    mounted = true;
    panelHidden = false;
    (globalThis as any).__DQM_UNMOUNT = () => {
        cleanupAll();
        mounted = false;
        panelHidden = false;
        (globalThis as any).__DQM_UNMOUNT = null;
    };
}
