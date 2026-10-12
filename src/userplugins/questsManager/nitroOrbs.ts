// @ts-nocheck
/*
 * Buy 3-day Nitro Credit with Discord Orbs (Shop Orbs Exclusives).
 */

export const NITRO_3DAY_SKU_ID = "1333912750274904064";
export const NITRO_3DAY_ORB_PRICE = 1400;
export const STORAGE_PURCHASE_TOKEN_KEY = "questHelper_purchaseToken";

/** Entitlement types that can represent Nitro Credits (not full PREMIUM_SUBSCRIPTION=2). */
const NITRO_CREDIT_ENTITLEMENT_TYPES = new Set([
    10, // QUEST_REWARD
    11, // FRACTIONAL_REDEMPTION
    12, // VIRTUAL_CURRENCY_REDEMPTION
]);

/** SKU product_line FRACTIONAL_PREMIUM — Discord Nitro Credit line. */
const SKU_PRODUCT_LINE_FRACTIONAL_PREMIUM = 11;
const PLAN_INTERVAL_MONTH = 1;
const PLAN_INTERVAL_YEAR = 2;
const PLAN_INTERVAL_DAY = 3;
const MS_PER_DAY = 86400000;

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
        return raw < 1e12 ? raw * 1000 : raw;
    }
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function entitlementSkuId(item) {
    return String(
        item?.sku_id
        || item?.skuId
        || item?.sku?.id
        || item?.subscription_plan?.sku_id
        || ""
    );
}

function skuProductLine(item) {
    const line = item?.sku?.product_line ?? item?.sku?.productLine ?? item?.product_line;
    return line == null ? null : Number(line);
}

function isNitroCreditEntitlement(item) {
    if (!item || typeof item !== "object") return false;
    if (item.deleted === true || item.consumed === true) return false;
    const type = Number(item.type);
    if (type === 2) return false;
    if (skuProductLine(item) === 1) return false;
    if (NITRO_CREDIT_ENTITLEMENT_TYPES.has(type)) return true;
    if (skuProductLine(item) === SKU_PRODUCT_LINE_FRACTIONAL_PREMIUM) return true;
    if (entitlementSkuId(item) === NITRO_3DAY_SKU_ID) return true;
    return false;
}

/** Banked credit duration in ms (unused inventory: no active ends_at yet). */
function bankedCreditDurationMs(item) {
    const plan = item?.subscription_plan || item?.subscriptionPlan || item?.sku?.subscription_plan;
    if (plan && Number.isFinite(Number(plan.interval_count ?? plan.intervalCount))) {
        const count = Math.max(0, Number(plan.interval_count ?? plan.intervalCount));
        const interval = Number(plan.interval);
        if (interval === PLAN_INTERVAL_DAY) return count * MS_PER_DAY;
        if (interval === PLAN_INTERVAL_MONTH) return count * 30 * MS_PER_DAY;
        if (interval === PLAN_INTERVAL_YEAR) return count * 365 * MS_PER_DAY;
    }

    if (entitlementSkuId(item) === NITRO_3DAY_SKU_ID) return 3 * MS_PER_DAY;

    const label = String(
        item?.sku?.name?.default
        || item?.sku?.name
        || item?.sku?.slug
        || ""
    );
    const m = label.match(/(\d+)\s*-?\s*day/i);
    if (m) return Math.max(1, Number(m[1])) * MS_PER_DAY;

    const type = Number(item?.type);
    if (type === 11 || type === 12 || skuProductLine(item) === SKU_PRODUCT_LINE_FRACTIONAL_PREMIUM) {
        return 3 * MS_PER_DAY;
    }
    return 0;
}

/**
 * Discord Nitro Home "Credits End In X Days":
 * max(active ends_at remaining) + sum(banked credit durations).
 */
export function computeNitroDaysRemaining(sources, now = Date.now()) {
    const list = (Array.isArray(sources) ? sources : []).filter(isNitroCreditEntitlement);
    if (!list.length) return null;

    let activeMs = 0;
    let bankedMs = 0;

    for (const item of list) {
        const end = parseEndMs(
            item.ends_at
            || item.endsAt
            || item.current_period_end
            || item.currentPeriodEnd
            || item.expires_at
            || item.expiresAt
        );
        if (end > now) {
            activeMs = Math.max(activeMs, end - now);
            continue;
        }
        bankedMs += bankedCreditDurationMs(item);
    }

    const totalMs = activeMs + bankedMs;
    if (totalMs <= 0) return null;
    return Math.max(1, Math.ceil(totalMs / MS_PER_DAY));
}

export async function fetchNitroDaysRemaining(apiGet) {
    const bags = [];
    try {
        const entRes = await apiGet({
            url: "/users/@me/entitlements?exclude_ended=true&with_sku=true"
        });
        const entBody = entRes?.body;
        const entitlements = Array.isArray(entBody)
            ? entBody
            : (Array.isArray(entBody?.entitlements) ? entBody.entitlements : []);
        for (const e of entitlements) {
            if (isNitroCreditEntitlement(e)) bags.push(e);
        }
    } catch (_) {}

    // Do not merge billing/subscriptions — that is paid Premium period, not Credits.
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
