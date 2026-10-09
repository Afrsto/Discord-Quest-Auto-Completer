/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 X2 Salah and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "child_process";
import { createWriteStream, existsSync, mkdirSync, promises as fsp, readdirSync, rmSync } from "fs";
import { homedir } from "os";
import path from "path";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import { app, BrowserWindow, IpcMainInvokeEvent, WebFrameMain, webFrameMain } from "electron";
import https from "https";
import http from "http";

const PLUGIN_NAME = "Quests Manager";
const execFileAsync = promisify(execFile);

function quoteCmdArg(arg: string): string {
    if (!/[ \t"&<>|^]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '\\"')}"`;
}

/** Run a process in a way that works under Electron on Windows (avoids spawn EINVAL on .cmd). */
async function runCommand(
    command: string,
    args: string[],
    cwd: string,
    maxBuffer = 20 * 1024 * 1024
): Promise<{ stdout: string; stderr: string }> {
    const opts = {
        cwd,
        windowsHide: true,
        maxBuffer,
        env: process.env
    } as const;

    if (process.platform === "win32") {
        const cmdline = [command, ...args].map(quoteCmdArg).join(" ");
        return execFileAsync(
            process.env.ComSpec || "cmd.exe",
            ["/d", "/s", "/c", cmdline],
            opts
        );
    }

    return execFileAsync(command, args, opts);
}

interface FrameRef {
    processId: number;
    routingId: number;
    applicationId: string | null;
}

const activityFrames: FrameRef[] = [];

function extractApplicationId(url: string): string | null {
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
    } catch {
        return null;
    }

    return null;
}

function isActivityUrl(url: string): boolean {
    return url.includes("discordsays.com");
}

function frameMatchesApplicationId(frame: WebFrameMain, applicationId: string): boolean {
    const url = frame.url;
    if (!isActivityUrl(url)) return false;
    if (extractApplicationId(url) === applicationId) return true;
    return url.includes(applicationId);
}

function registerActivityFrame(frame: WebFrameMain): void {
    const url = frame.url;
    if (!isActivityUrl(url)) return;

    const { routingId, processId } = frame;
    const existing = activityFrames.find(
        ref => ref.processId === processId && ref.routingId === routingId
    );
    if (existing) {
        existing.applicationId = extractApplicationId(url);
        return;
    }

    cleanUpActivityFrames();
    activityFrames.push({
        processId,
        routingId,
        applicationId: extractApplicationId(url)
    });
}

function cleanUpActivityFrames(): WebFrameMain[] {
    const liveFrames: WebFrameMain[] = [];

    for (let i = activityFrames.length - 1; i >= 0; i--) {
        const { processId, routingId } = activityFrames[i];
        const frame = webFrameMain.fromId(processId, routingId);
        if (!frame) {
            activityFrames.splice(i, 1);
            continue;
        }
        liveFrames.push(frame);
    }

    return liveFrames;
}

function collectActivityFramesFromWindow(win: BrowserWindow): WebFrameMain[] {
    const found: WebFrameMain[] = [];

    try {
        for (const frame of win.webContents.mainFrame.framesInSubtree) {
            if (isActivityUrl(frame.url)) {
                registerActivityFrame(frame);
                found.push(frame);
            }
        }
    } catch (error) {
        console.error(`[${PLUGIN_NAME}] Failed to scan frames in window:`, error);
    }

    return found;
}

function scanAllWindowsForActivityFrames(): WebFrameMain[] {
    const found: WebFrameMain[] = [];

    for (const win of BrowserWindow.getAllWindows()) {
        found.push(...collectActivityFramesFromWindow(win));
    }

    return found;
}

const SDK_PROBE_JS = "!!(window.discordSDK && window.discordSDK.commands && typeof window.discordSDK.commands.questStartTimer === \"function\")";

function frameHasDiscordSdk(frame: WebFrameMain): boolean {
    try {
        return frame.executeJavaScript(SDK_PROBE_JS, true) === true;
    } catch {
        return false;
    }
}

function collectMatchingFrames(applicationId: string): WebFrameMain[] {
    const trimmedAppId = applicationId?.trim() || "";

    scanAllWindowsForActivityFrames();
    const frames = cleanUpActivityFrames();

    const matched: WebFrameMain[] = [];
    const seen = new Set<string>();

    const addFrame = (frame: WebFrameMain | null) => {
        if (!frame) return;
        const key = `${frame.processId}:${frame.routingId}`;
        if (seen.has(key)) return;
        seen.add(key);
        matched.push(frame);
    };

    if (trimmedAppId) {
        for (let i = activityFrames.length - 1; i >= 0; i--) {
            const ref = activityFrames[i];
            if (ref.applicationId === trimmedAppId) {
                addFrame(webFrameMain.fromId(ref.processId, ref.routingId));
            }
        }

        for (const frame of frames) {
            if (frameMatchesApplicationId(frame, trimmedAppId)) {
                addFrame(frame);
            }
        }
    } else {
        for (const frame of frames) addFrame(frame);
    }

    return matched;
}

function findMatchingFrame(applicationId: string): WebFrameMain | null {
    const matching = collectMatchingFrames(applicationId);
    if (matching.length === 0) return null;

    for (let i = matching.length - 1; i >= 0; i--) {
        if (frameHasDiscordSdk(matching[i])) return matching[i];
    }

    return matching[matching.length - 1];
}

function attachWindowListeners(win: BrowserWindow): void {
    collectActivityFramesFromWindow(win);

    win.webContents.on("did-frame-navigate", (_, __, ___, ____, _____, frameProcessId, frameRoutingId) => {
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
        if (frame) registerActivityFrame(frame);
    });

    win.webContents.on("did-frame-navigate-in-page", (_, __, ___, frameProcessId, frameRoutingId) => {
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
        if (frame) registerActivityFrame(frame);
    });

    win.webContents.on("frame-created", (_, { frame }) => {
        const onFrameReady = () => registerActivityFrame(frame);

        frame?.once("dom-ready", onFrameReady);
    });
}

for (const win of BrowserWindow.getAllWindows()) {
    attachWindowListeners(win);
}

app.on("browser-window-created", (_, win) => {
    attachWindowListeners(win);
});

export async function hasActivityFrame(_: IpcMainInvokeEvent, applicationId: string): Promise<boolean> {
    return findMatchingFrame(applicationId) != null;
}

export async function execInActivityFrame(
    _: IpcMainInvokeEvent,
    applicationId: string,
    jsCode: string
): Promise<string | null> {
    const frame = findMatchingFrame(applicationId);
    if (!frame) return null;

    try {
        const result = await frame.executeJavaScript(jsCode, true);
        if (result === undefined || result === null) return "null";
        return typeof result === "string" ? result : JSON.stringify(result);
    } catch (error) {
        console.error(`[${PLUGIN_NAME}] Failed to execute JS in activity frame:`, error);
        throw error;
    }
}

function resolveVencordRoot(): string | null {
    const candidates = [
        path.join(homedir(), "Documents", "Vencord"),
        path.join(homedir(), "Documents", "vencord")
    ];
    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, "package.json")) && existsSync(path.join(candidate, "src"))) {
            return candidate;
        }
    }
    // Fallback: Documents/Vencord_* random install folders from the bat
    try {
        const docs = path.join(homedir(), "Documents");
        if (!existsSync(docs)) return null;
        for (const name of readdirSync(docs)) {
            if (!/^Vencord/i.test(name)) continue;
            const candidate = path.join(docs, name);
            if (existsSync(path.join(candidate, "package.json")) && existsSync(path.join(candidate, "src"))) {
                return candidate;
            }
        }
    } catch {
        /* ignore */
    }
    return null;
}

function resolvePluginDir(venRoot: string): string {
    return path.join(venRoot, "src", "userplugins", "questsManager");
}

export async function getPluginInstallPath(_: IpcMainInvokeEvent): Promise<string | null> {
    const root = resolveVencordRoot();
    if (!root) return null;
    return resolvePluginDir(root);
}

function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const get = (target: string, redirects = 0) => {
            if (redirects > 8) {
                reject(new Error("Too many redirects while downloading update"));
                return;
            }
            const lib = target.startsWith("https:") ? https : http;
            const req = lib.get(target, {
                headers: { "User-Agent": "Quests-Manager-Updater", Accept: "*/*" }
            }, res => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    get(res.headers.location, redirects + 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Download failed with HTTP ${res.statusCode}`));
                    return;
                }
                const out = createWriteStream(dest);
                pipeline(res, out).then(resolve).catch(reject);
            });
            req.on("error", reject);
        };
        get(url);
    });
}

async function findPluginRootInExtract(extractDir: string): Promise<string | null> {
    const candidates = [
        path.join(extractDir, "src", "userplugins", "questsManager"),
        path.join(extractDir, "userplugins", "questsManager"),
        path.join(extractDir, "questsManager")
    ];
    for (const c of candidates) {
        if (existsSync(path.join(c, "index.tsx")) || existsSync(path.join(c, "index.ts"))) {
            return c;
        }
    }
    // One nested folder (zip root)
    try {
        const entries = await fsp.readdir(extractDir, { withFileTypes: true });
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const nested = path.join(extractDir, ent.name);
            for (const c of [
                path.join(nested, "src", "userplugins", "questsManager"),
                path.join(nested, "userplugins", "questsManager"),
                path.join(nested, "questsManager")
            ]) {
                if (existsSync(path.join(c, "index.tsx")) || existsSync(path.join(c, "index.ts"))) {
                    return c;
                }
            }
        }
    } catch {
        /* ignore */
    }
    return null;
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
        const from = path.join(src, ent.name);
        const to = path.join(dest, ent.name);
        if (ent.isDirectory()) {
            await copyDirRecursive(from, to);
        } else {
            await fsp.copyFile(from, to);
        }
    }
}

export async function rebuildVencord(_: IpcMainInvokeEvent): Promise<{ ok: boolean; message: string }> {
    const root = resolveVencordRoot();
    if (!root) {
        return { ok: false, message: "Vencord source folder not found under Documents." };
    }

    const attempts: Array<{ command: string; args: string[] }> = process.platform === "win32"
        ? [
            { command: "pnpm.cmd", args: ["build"] },
            { command: "pnpm", args: ["build"] },
            { command: "npx.cmd", args: ["--yes", "pnpm", "build"] }
        ]
        : [
            { command: "pnpm", args: ["build"] },
            { command: "npx", args: ["--yes", "pnpm", "build"] }
        ];

    let lastDetail = "";
    for (const attempt of attempts) {
        try {
            await runCommand(attempt.command, attempt.args, root);
            return { ok: true, message: "Vencord rebuild complete." };
        } catch (error: any) {
            lastDetail = error?.stderr || error?.message || String(error);
            console.error(`[${PLUGIN_NAME}] ${attempt.command} build failed:`, lastDetail);
        }
    }

    return {
        ok: false,
        message: `pnpm build failed: ${String(lastDetail).slice(0, 400)}. You can run pnpm build in ${root} manually, then restart Discord.`
    };
}

export async function applyPluginUpdateFromUrl(
    _: IpcMainInvokeEvent,
    zipUrl: string
): Promise<{ ok: boolean; message: string }> {
    const root = resolveVencordRoot();
    if (!root) {
        return {
            ok: false,
            message: "Vencord source not found. Run Quests Manager.bat once to install, then try Update again."
        };
    }

    const pluginDir = resolvePluginDir(root);
    const tmpRoot = path.join(root, "_dqm_update");
    const zipPath = path.join(tmpRoot, "src.zip");
    const extractDir = path.join(tmpRoot, "extract");

    try {
        if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
        mkdirSync(extractDir, { recursive: true });

        await downloadFile(String(zipUrl), zipPath);

        if (process.platform === "win32") {
            await runCommand(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-ExecutionPolicy", "Bypass",
                    "-Command",
                    `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
                ],
                root,
                10 * 1024 * 1024
            );
        } else {
            await runCommand("unzip", ["-o", zipPath, "-d", extractDir], root, 10 * 1024 * 1024);
        }

        const sourcePlugin = await findPluginRootInExtract(extractDir);
        if (!sourcePlugin) {
            return { ok: false, message: "src.zip did not contain questsManager plugin sources." };
        }

        mkdirSync(path.dirname(pluginDir), { recursive: true });
        if (existsSync(pluginDir)) {
            rmSync(pluginDir, { recursive: true, force: true });
        }
        await copyDirRecursive(sourcePlugin, pluginDir);

        const rebuild = await rebuildVencord(_);
        if (!rebuild.ok) {
            return {
                ok: false,
                message: `Plugin files updated, but rebuild failed: ${rebuild.message}`
            };
        }

        return {
            ok: true,
            message: "Update installed. Fully restart Discord to load the new version."
        };
    } catch (error: any) {
        console.error(`[${PLUGIN_NAME}] Update failed:`, error);
        return {
            ok: false,
            message: error?.message ? String(error.message) : String(error)
        };
    } finally {
        try {
            if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /* ignore cleanup errors */
        }
    }
}
