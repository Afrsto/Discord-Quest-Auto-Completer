#!/usr/bin/env node
/**
 * Bundle Quests Manager Vencord plugin sources into:
 * - Quests Manager.txt (pasteable console script)
 * - Quests Manager.user.js (Tampermonkey userscript)
 * Also refreshes regions.snapshot.json when the network is available.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGIN = path.join(ROOT, "Quests Manager", "Vencord", "src", "userplugins", "questsManager");
const SNAPSHOT_PATH = path.join(PLUGIN, "regions.snapshot.json");
const OUT_TXT = path.join(ROOT, "Quests Manager.txt");
const OUT_USER = path.join(ROOT, "Quests Manager.user.js");
const REGIONS_URL = "https://api.discordquest.com/api/regions";

const HEADER = `// Quests Manager — paste into Discord DevTools Console (Ctrl+Shift+I)
// Requirements: Discord Desktop. Launch Quest needs: --remote-debugging-port=9223
// Optional: localStorage.setItem("questHelper_cdpPort", "9223")
// Re-paste to replace; call QuestsManager.unmount() to remove the panel.
`;

const USERSCRIPT_HEADER = `// ==UserScript==
// @name         Quests Manager
// @namespace    https://discord.gg/btRCeujadA
// @version      1.0.3
// @description  Discord Quest Auto Completer — rework by X2 Salah
// @author       X2 Salah
// @match        https://discord.com/*
// @match        https://canary.discord.com/*
// @match        https://ptb.discord.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// Mobile: video/watch quests work; Launch Quest (CDP) and play/stream need desktop Discord.
`;

const COUNTRY_ALIASES = { UK: "GB" };

function normalizeCountryCode(raw) {
    if (raw == null || raw === "") return "";
    let code = String(raw).trim().toUpperCase();
    if (COUNTRY_ALIASES[code]) code = COUNTRY_ALIASES[code];
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return code;
}

function makeRichCatalogEntry({ isGlobal, include, exclude, mode, primary }) {
    const inc = (include || []).map(normalizeCountryCode).filter(Boolean);
    const exc = (exclude || []).map(normalizeCountryCode).filter(Boolean);
    const prim = normalizeCountryCode(primary) || (mode === "include" && inc[0] ? inc[0] : "");
    return {
        isGlobal: !!isGlobal,
        include: inc,
        exclude: exc,
        mode,
        primary: prim,
        extra: mode === "include" ? Math.max(0, inc.length - 1) : 0,
        code: prim
    };
}

function parseRegionsEntry(entry) {
    if (!entry || typeof entry !== "object") {
        return makeRichCatalogEntry({
            isGlobal: false, include: [], exclude: [], mode: "unknown", primary: ""
        });
    }
    const includeRaw = Array.isArray(entry.regions?.include) ? entry.regions.include : [];
    const excludeRaw = Array.isArray(entry.regions?.exclude) ? entry.regions.exclude : [];
    const include = includeRaw.map(normalizeCountryCode).filter(Boolean);
    const exclude = excludeRaw.map(normalizeCountryCode).filter(Boolean);

    if (entry.is_global) {
        return makeRichCatalogEntry({
            isGlobal: true, include: [], exclude: [], mode: "global", primary: ""
        });
    }
    if (include.length) {
        return makeRichCatalogEntry({
            isGlobal: false, include, exclude, mode: "include", primary: include[0]
        });
    }
    if (exclude.length) {
        return makeRichCatalogEntry({
            isGlobal: false, include: [], exclude, mode: "exclude", primary: ""
        });
    }
    return makeRichCatalogEntry({
        isGlobal: false, include: [], exclude: [], mode: "unknown", primary: ""
    });
}

async function refreshRegionsSnapshot() {
    try {
        const res = await fetch(REGIONS_URL, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data?.quests) ? data.quests : [];
        const byId = {};
        for (const entry of list) {
            if (entry?.id == null) continue;
            const parsed = parseRegionsEntry(entry);
            const id = String(entry.id);
            byId[id] = parsed;
            if (entry.replacement_id != null) {
                byId[String(entry.replacement_id)] = parsed;
            }
        }
        // Merge over existing snapshot so partial live responses don't wipe history.
        let existing = {};
        if (fs.existsSync(SNAPSHOT_PATH)) {
            try {
                const prev = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
                existing = prev.byId || prev || {};
            } catch (_) {}
        }
        const merged = { ...existing, ...byId };
        const payload = { fetchedAt: Date.now(), byId: merged };
        fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(payload));
        console.log(`Updated regions.snapshot.json (${Object.keys(merged).length} quests)`);
        return merged;
    } catch (e) {
        console.warn(`Could not refresh regions snapshot: ${e.message || e}`);
        if (fs.existsSync(SNAPSHOT_PATH)) {
            const existing = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
            return existing.byId || existing || {};
        }
        return {};
    }
}

function stripTsSource(text) {
    let out = text;
    out = out.replace(/^\/\/ @ts-nocheck\s*\n/m, "");
    out = out.replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*\n/gm, "");
    out = out.replace(/^declare\s+const\s+\w+[\s\S]*?;\s*\n/gm, "");
    out = out.replace(/^type\s+\w+\s*=\s*\{[\s\S]*?\};\s*\n/gm, "");
    out = out.replace(/^export\s+(const|function|async function)\s+/gm, "$1 ");
    out = out.replace(/^export\s+\{[^}]+\};\s*\n/gm, "");
    out = out.replace(/\(globalThis as any\)/g, "globalThis");
    out = out.replace(/ as HTMLElement \| null/g, "");
    out = out.replace(/ as HTMLElement/g, "");
    return out;
}

function patchActivityQuestForConsole(text) {
    let out = stripTsSource(text);
    out = out.replace(
        /declare const VencordNative[\s\S]*?function getNative\(\) \{[\s\S]*?\n\}\n/,
        ""
    );
    out = out.replace(
        /function getNative\(\) \{[\s\S]*?VencordNative[\s\S]*?\n\}\n/,
        ""
    );
    out = out.replace(
        /^\s+hasActivityFrame\?:[\s\S]*?\};\s*\n\n/gm,
        "\n"
    );
    out = out.replace(
        /^\s+execInActivityFrame\?:[\s\S]*?\};\s*\n\n/gm,
        "\n"
    );
    out = out.replace(
        /function isNativeAvailable\(\) \{[\s\S]*?\n\}/,
        `function isNativeAvailable() {
    return true;
}`
    );
    out = out.replace(
        /async function nativeHasActivityFrame\(applicationId\) \{[\s\S]*?\n\}/,
        `async function nativeHasActivityFrame(applicationId) {
    try {
        return await getNative()?.hasActivityFrame?.(applicationId) ?? false;
    } catch (_) {
        return false;
    }
}`
    );
    out = out.replace(
        /async function execInActivityFrame\(applicationId, jsCode\) \{[\s\S]*?throwActivityFrameError\(\s*ActivityFrameErrorCode\.FRAME_NOT_READY,[\s\S]*?\);\s*\n\}/,
        `async function execInActivityFrame(applicationId, jsCode) {
    const reachable = await probeCdpReachable();
    if (!reachable) {
        throwActivityFrameError(
            ActivityFrameErrorCode.NATIVE_REQUIRED,
            CDP_SETUP_MESSAGE
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
            throw new Error("CDP activity frame execution failed: " + (e?.message || e));
        }

        if (attempt < NATIVE_EXEC_RETRIES - 1) {
            await new Promise(r => setTimeout(r, NATIVE_EXEC_RETRY_MS));
        }
    }

    if (lastError) {
        throw new Error("CDP activity frame execution failed: " + (lastError?.message || lastError));
    }

    throwActivityFrameError(
        ActivityFrameErrorCode.FRAME_NOT_READY,
        "Activity frame not ready. Ensure the activity is fully loaded and authorized in Discord."
    );
}`
    );
    return out;
}

function patchManagerForConsole(text) {
    let out = stripTsSource(text);
    out = out.replace(
        /const QuestsStoreLazy[\s\S]*?function resolveStores\(\): Stores \{[\s\S]*?\n\}/,
        "// resolveStores() provided by console-runtime.js"
    );
    out = out.replace(
        /logActivityNativeRequired: "Activity quests require a Vencord rebuild with native\.ts\. Run pnpm build and restart Discord\."/,
        'logActivityNativeRequired: "Launch Quest requires Discord with --remote-debugging-port=9223. Close Discord, add that flag to the shortcut, then restart."'
    );
    out = out.replace(
        /logActivityNativeRequired: "مهام النشاط تتطلب إعادة بناء Vencord مع native\.ts\. شغّل pnpm build وأعد تشغيل ديسكورد\."/,
        'logActivityNativeRequired: "مهمة التشغيل تتطلب تشغيل ديسكورد مع --remote-debugging-port=9223. أغلق ديسكورد، أضف العلم إلى الاختصار، ثم أعد التشغيل."'
    );
    // Import of regions.snapshot.json is stripped; drop the Vencord-only bootstrap that references it.
    out = out.replace(
        /try \{\s*const snap = regionsSnapshotFile\?\.byId \|\| regionsSnapshotFile;[\s\S]*?\} catch \(_\) \{\}\s*/,
        ""
    );
    return out;
}

async function build() {
    const byId = await refreshRegionsSnapshot();

    const runtime = fs.readFileSync(path.join(__dirname, "console-runtime.js"), "utf8");
    const bootstrap = fs.readFileSync(path.join(__dirname, "userscript-bootstrap.js"), "utf8");
    const extraCss = fs.readFileSync(path.join(__dirname, "userscript-extra.css"), "utf8");
    const activityQuest = fs.readFileSync(path.join(PLUGIN, "activityQuest.ts"), "utf8");
    const manager = fs.readFileSync(path.join(PLUGIN, "manager.ts"), "utf8");
    const styles = fs.readFileSync(path.join(PLUGIN, "styles.css"), "utf8");

    const activityJs = patchActivityQuestForConsole(activityQuest);
    const managerJs = patchManagerForConsole(manager);
    const regionsInject = `globalThis.__DQM_REGIONS_SNAPSHOT = ${JSON.stringify(byId)};\n`;

    const stylesLiteral = JSON.stringify(styles);
    const userscriptStylesLiteral = JSON.stringify(`${styles}\n${extraCss}`);

    const consoleFooter = `
(async () => {
    injectDqmStyles(${stylesLiteral});

    const { ok, missing } = await initializeDiscordModules();
    if (!ok) {
        console.error("[Quests Manager] Failed to resolve Discord modules:", missing.join(", "));
        return;
    }

    mountQuestsManager();

    globalThis.QuestsManager = {
        mount: mountQuestsManager,
        unmount: unmountQuestsManager,
        toggle: toggleQuestsManager,
        open: isQuestsManagerOpen
    };
    console.log("[Quests Manager] Loaded. Panel mounted. API: QuestsManager.mount() / .unmount() / .toggle()");
})();
`;

    const userscriptFooter = `
(async () => {
    injectDqmStyles(${userscriptStylesLiteral});

    await waitForDiscordReady();

    const ready = await ensureQuestsManagerReady();
    if (!ready) {
        injectLauncherButton();
        setupLauncherPersistence();
        return;
    }

    injectLauncherButton();
    setupLauncherPersistence();
    console.log("[Quests Manager] Loaded. Click the Quests Manager button to open.");
})();
`;

    const consoleBundle = `${HEADER}
(function() {
"use strict";
${runtime}

${regionsInject}
${activityJs}

${managerJs}

${consoleFooter}
})();
`;

    const userscriptBundle = `${USERSCRIPT_HEADER}
(function() {
"use strict";
${runtime}

${bootstrap}

${regionsInject}
${activityJs}

${managerJs}

${userscriptFooter}
})();
`;

    fs.writeFileSync(OUT_TXT, consoleBundle, "utf8");
    fs.writeFileSync(OUT_USER, userscriptBundle, "utf8");
    const kbTxt = (Buffer.byteLength(consoleBundle, "utf8") / 1024).toFixed(1);
    const kbUser = (Buffer.byteLength(userscriptBundle, "utf8") / 1024).toFixed(1);
    console.log(`Wrote ${OUT_TXT} (${kbTxt} KB)`);
    console.log(`Wrote ${OUT_USER} (${kbUser} KB)`);
}

build().catch((e) => {
    console.error(e);
    process.exit(1);
});
