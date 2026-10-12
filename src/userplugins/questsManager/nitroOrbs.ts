// @ts-nocheck
/*
 * Buy 3-day Nitro Credit with Discord Orbs (Shop Orbs Exclusives).
 */

export const NITRO_3DAY_SKU_ID = "1333912750274904064";
export const NITRO_3DAY_ORB_PRICE = 1400;
export const STORAGE_PURCHASE_TOKEN_KEY = "questHelper_purchaseToken";

/** Nitro Credit entitlements only (not full PREMIUM_SUBSCRIPTION type 2). */
const NITRO_CREDIT_ENTITLEMENT_TYPES = new Set([11, 12]);

function newUuid() {
    try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
    } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === "x" ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function getOrCreatePurchaseToken() {
    try {
        let token = localStorage.getItem(STORAGE_PURCHASE_TOKEN_KEY);
        if (!token || token.length < 8) {
            token = newUuid();
            localStorage.setItem(STORAGE_PURCHASE_TOKEN_KEY, token);
        }
        return token;
    } catch (_) {
        return newUuid();
    }
}

function parseEndMs(raw) {
    if (raw == null || raw === "") return 0;
    if (typeof raw === "number" && Number.isFinite(raw)) {
        // Unix seconds vs milliseconds
        return raw < 1e12 ? raw * 1000 : raw;
    }
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function daysFromEndMs(endMs, now) {
    if (!endMs || endMs <= now) return 0;
    return Math.max(1, Math.ceil((endMs - now) / 86400000));
}

/** Remaining Nitro Credit days from credit entitlements. Empty → null (UI shows —). */
export function computeNitroDaysRemaining(sources, now = Date.now()) {
    const list = Array.isArray(sources) ? sources : [];
    if (!list.length) return null;

    let bestEnd = 0;
    let extraDays = 0;

    for (const item of list) {
        if (!item || typeof item !== "object") continue;

        const endRaw = item.current_period_end
            || item.currentPeriodEnd
            || item.ends_at
            || item.endsAt
            || item.trial_ends_at
            || item.trialEndsAt
            || item.expires_at
            || item.expiresAt;
        const end = parseEndMs(endRaw);
        if (end > bestEnd) bestEnd = end;

        const days = item.remaining_days ?? item.remainingDays;
        if (days != null && Number.isFinite(Number(days))) {
            extraDays = Math.max(extraDays, Math.ceil(Number(days)));
        }
        const secs = item.remaining_seconds ?? item.remainingSeconds;
        if (secs != null && Number.isFinite(Number(secs))) {
            extraDays = Math.max(extraDays, Math.ceil(Number(secs) / 86400));
        }
    }

    const fromPeriod = daysFromEndMs(bestEnd, now);
    const total = Math.max(fromPeriod, extraDays);
    return total > 0 ? total : null;
}

export async function fetchNitroDaysRemaining(apiGet) {
    const bags = [];

    try {
        const entRes = await apiGet({ url: "/users/@me/entitlements?exclude_ended=true" });
        const entBody = entRes?.body;
        const entitlements = Array.isArray(entBody)
            ? entBody
            : (Array.isArray(entBody?.entitlements) ? entBody.entitlements : []);
        for (const e of entitlements) {
            if (NITRO_CREDIT_ENTITLEMENT_TYPES.has(Number(e?.type))) {
                bags.push(e);
            }
        }
    } catch (_) {}

    // Do not merge billing subscriptions — that is Premium period, not Credits.
    return computeNitroDaysRemaining(bags);
}

/**
 * Redeem 3-Day Nitro Credit with Orbs via virtual-currency SKU redeem.
 * @returns {{ ok: boolean, error?: string, code?: number, body?: any }}
 */
export async function purchaseThreeDayNitroCredit(apiPost, {
    skuId = NITRO_3DAY_SKU_ID
} = {}) {
    const checkoutSessionId = newUuid();
    try {
        const res = await apiPost({
            url: `/virtual-currency/skus/${skuId}/redeem`,
            body: {
                checkout_session_id: checkoutSessionId
            }
        });
        const body = res?.body;
        const code = body?.code ?? res?.status;
        if (code === 100056 || body?.code === 100056) {
            return {
                ok: false,
                code: 100056,
                error: "purchase_auth_required",
                body
            };
        }
        if (res?.ok === false || (typeof res?.status === "number" && res.status >= 400)) {
            const detail = body?.errors
                ? JSON.stringify(body.errors)
                : (body?.message || `HTTP ${res.status}`);
            return {
                ok: false,
                code: body?.code ?? res.status,
                error: detail,
                body
            };
        }
        return { ok: true, body };
    } catch (e) {
        const msg = e?.body?.message || e?.message || String(e);
        const code = e?.body?.code ?? e?.code;
        const errors = e?.body?.errors;
        if (code === 100056 || /authorize|payment client|email/i.test(msg)) {
            return { ok: false, code: 100056, error: "purchase_auth_required", body: e?.body };
        }
        return {
            ok: false,
            code,
            error: errors ? `${msg} ${JSON.stringify(errors)}` : msg,
            body: e?.body
        };
    }
}
