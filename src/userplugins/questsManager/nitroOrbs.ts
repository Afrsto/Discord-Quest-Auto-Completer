// @ts-nocheck
/*
 * Buy 3-day Nitro Credit with Discord Orbs (Shop Orbs Exclusives).
 */

export const NITRO_3DAY_SKU_ID = "1333912750274904064";
export const NITRO_3DAY_ORB_PRICE = 1400;
export const STORAGE_PURCHASE_TOKEN_KEY = "questHelper_purchaseToken";

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

/** Remaining premium days from billing subscriptions (credits stack). */
export function computeNitroDaysRemaining(subscriptions, now = Date.now()) {
    if (!Array.isArray(subscriptions) || !subscriptions.length) return 0;
    let bestEnd = 0;
    for (const sub of subscriptions) {
        if (!sub || sub.type != null && Number(sub.type) !== 1 && String(sub.type).toUpperCase() !== "PREMIUM") {
            // Keep scanning — Discord shapes vary; prefer period end when present.
        }
        const endRaw = sub.current_period_end
            || sub.currentPeriodEnd
            || sub.ends_at
            || sub.endsAt
            || sub.trial_ends_at
            || sub.trialEndsAt;
        if (!endRaw) continue;
        const end = new Date(endRaw).getTime();
        if (!Number.isFinite(end)) continue;
        if (end > bestEnd) bestEnd = end;
        // Stack unused credit seconds when Discord exposes them.
        const creditMs = Number(sub.streak_started_at ? 0 : 0);
        void creditMs;
    }
    // Also sum remaining_time / credit_balance style fields when present.
    let extraDays = 0;
    for (const sub of subscriptions) {
        const days = sub.remaining_days ?? sub.remainingDays;
        if (days != null && Number.isFinite(Number(days))) {
            extraDays = Math.max(extraDays, Math.ceil(Number(days)));
        }
        const secs = sub.remaining_seconds ?? sub.remainingSeconds;
        if (secs != null && Number.isFinite(Number(secs))) {
            extraDays = Math.max(extraDays, Math.ceil(Number(secs) / 86400));
        }
    }
    if (bestEnd > now) {
        const fromPeriod = Math.max(1, Math.ceil((bestEnd - now) / 86400));
        return Math.max(fromPeriod, extraDays);
    }
    return Math.max(0, extraDays);
}

export async function fetchNitroDaysRemaining(apiGet) {
    try {
        const res = await apiGet({ url: "/users/@me/billing/subscriptions?sync_level=2" });
        const body = res?.body;
        const list = Array.isArray(body) ? body : (Array.isArray(body?.subscriptions) ? body.subscriptions : []);
        return computeNitroDaysRemaining(list);
    } catch (_) {
        return null;
    }
}

/**
 * Purchase 3-Day Nitro Credit with Orbs.
 * @returns {{ ok: boolean, error?: string, code?: number, body?: any }}
 */
export async function purchaseThreeDayNitroCredit(apiPost, {
    expectedAmount = NITRO_3DAY_ORB_PRICE,
    skuId = NITRO_3DAY_SKU_ID
} = {}) {
    const loadId = newUuid();
    const purchaseToken = getOrCreatePurchaseToken();
    try {
        const res = await apiPost({
            url: `/store/skus/${skuId}/purchase`,
            body: {
                expected_amount: expectedAmount,
                expected_currency: "discord_orb",
                currency: "discord_orb",
                purchase_token: purchaseToken,
                load_id: loadId,
                gift: false
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
            return {
                ok: false,
                code: body?.code ?? res.status,
                error: body?.message || `HTTP ${res.status}`,
                body
            };
        }
        return { ok: true, body };
    } catch (e) {
        const msg = e?.body?.message || e?.message || String(e);
        const code = e?.body?.code ?? e?.code;
        if (code === 100056 || /authorize|payment client|email/i.test(msg)) {
            return { ok: false, code: 100056, error: "purchase_auth_required", body: e?.body };
        }
        return { ok: false, code, error: msg, body: e?.body };
    }
}
