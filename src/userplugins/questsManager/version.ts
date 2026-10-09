/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 X2 Salah and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PLUGIN_VERSION = "1.0.2";
export const PLUGIN_VERSION_LABEL = `v${PLUGIN_VERSION}`;

export const GITHUB_OWNER = "Afrsto";
export const GITHUB_REPO = "Discord-Quest-Auto-Completer";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES_PAGE = `${GITHUB_REPO_URL}/releases`;

/** Normalize tags like "v1.0.0", "1.0.0", or legacy "v1" into comparable semver parts. */
export function parseSemver(version: string): [number, number, number] {
    const cleaned = String(version || "").replace(/^v/i, "").split("-")[0].trim();
    if (!cleaned) return [0, 0, 0];
    // Legacy single-number tags (e.g. "v1") → 1.0.0
    if (/^\d+$/.test(cleaned)) {
        return [Number(cleaned) || 0, 0, 0];
    }
    const parts = cleaned.split(".").map(p => Number.parseInt(p, 10) || 0);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** Compare semver strings. Returns -1 / 0 / 1. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
    const [a0, a1, a2] = parseSemver(a);
    const [b0, b1, b2] = parseSemver(b);
    if (a0 !== b0) return a0 < b0 ? -1 : 1;
    if (a1 !== b1) return a1 < b1 ? -1 : 1;
    if (a2 !== b2) return a2 < b2 ? -1 : 1;
    return 0;
}

export function isNewerVersion(latest: string, current: string = PLUGIN_VERSION): boolean {
    return compareSemver(latest, current) > 0;
}
