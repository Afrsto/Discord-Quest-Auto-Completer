// @ts-nocheck
/*
 * In-plugin updater — checks GitHub releases and applies src.zip without re-running the .bat
 */

import {
    GITHUB_RELEASES_API,
    GITHUB_RELEASES_PAGE,
    PLUGIN_VERSION,
    PLUGIN_VERSION_LABEL,
    isNewerVersion
} from "./version";

declare const VencordNative: {
    pluginHelpers?: Record<string, {
        applyPluginUpdateFromUrl?: (zipUrl: string) => Promise<{ ok: boolean; message: string; version?: string }>;
        getPluginInstallPath?: () => Promise<string | null>;
        rebuildVencord?: () => Promise<{ ok: boolean; message: string }>;
    }>;
};

export type ReleaseInfo = {
    tag_name: string;
    name?: string;
    html_url?: string;
    published_at?: string;
    srcZipUrl?: string | null;
};

export type UpdateCheckResult = {
    ok: boolean;
    current: string;
    latest: string | null;
    hasUpdate: boolean;
    release: ReleaseInfo | null;
    error?: string;
};

function getNative() {
    return typeof VencordNative !== "undefined"
        ? VencordNative.pluginHelpers?.["Quests Manager"]
        : null;
}

export function getPluginVersionLabel() {
    return PLUGIN_VERSION_LABEL;
}

export function getPluginVersion() {
    return PLUGIN_VERSION;
}

export function getReleasesPageUrl() {
    return GITHUB_RELEASES_PAGE;
}

export async function checkForPluginUpdate(): Promise<UpdateCheckResult> {
    try {
        const res = await fetch(GITHUB_RELEASES_API, {
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "Quests-Manager-Updater"
            }
        });
        if (!res.ok) {
            return {
                ok: false,
                current: PLUGIN_VERSION,
                latest: null,
                hasUpdate: false,
                release: null,
                error: `GitHub API returned ${res.status}`
            };
        }
        const data = await res.json();
        const tag = String(data.tag_name || "");
        const assets = Array.isArray(data.assets) ? data.assets : [];
        const srcAsset = assets.find(a => a?.name === "src.zip");
        const release: ReleaseInfo = {
            tag_name: tag,
            name: data.name,
            html_url: data.html_url,
            published_at: data.published_at,
            srcZipUrl: srcAsset?.browser_download_url || null
        };
        return {
            ok: true,
            current: PLUGIN_VERSION,
            latest: tag,
            hasUpdate: isNewerVersion(tag, PLUGIN_VERSION),
            release
        };
    } catch (e) {
        return {
            ok: false,
            current: PLUGIN_VERSION,
            latest: null,
            hasUpdate: false,
            release: null,
            error: e instanceof Error ? e.message : String(e)
        };
    }
}

export async function applyPluginUpdate(srcZipUrl: string): Promise<{ ok: boolean; message: string }> {
    const native = getNative();
    if (!native?.applyPluginUpdateFromUrl) {
        return {
            ok: false,
            message: "Native updater unavailable. Rebuild Vencord from source with native.ts, then restart Discord."
        };
    }
    try {
        const result = await native.applyPluginUpdateFromUrl(srcZipUrl);
        return {
            ok: !!result?.ok,
            message: result?.message || (result?.ok ? "Update applied." : "Update failed.")
        };
    } catch (e) {
        return {
            ok: false,
            message: e instanceof Error ? e.message : String(e)
        };
    }
}
