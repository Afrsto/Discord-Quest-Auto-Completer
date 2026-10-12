// @ts-nocheck
/*
 * Buy 3-day Nitro Credit with Discord Orbs (Shop Orbs Exclusives).
 */

export const NITRO_3DAY_SKU_ID = "1333912750274904064";
export const NITRO_3DAY_ORB_PRICE = 1400;
export const STORAGE_PURCHASE_TOKEN_KEY = "questHelper_purchaseToken";

/** Fractional / Orbs credit redemptions (not bare QUEST_REWARD=10, not full PREMIUM=2). */
const NITRO_CREDIT_ENTITLEMENT_TYPES = new Set([
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

function skuLabel(item) {
    return String(
        item?.sku?.name?.default
        || item?.sku?.name
        || item?.sku?.slug
        || ""
    );
}

function isQuestNitroCredit(item) {
    if (Number(item?.type) !== 10) return false;
    if (skuProductLine(item) === SKU_PRODUCT_LINE_FRACTIONAL_PREMIUM) return true;
    const label = skuLabel(item);
    if (/nitro/i.test(label) && /credit/i.test(label)) return true;
    if (/nitro/i.test(label) && /\d+\s*-?\s*day/i.test(label)) return true;
    return false;
}

function isNitroCreditEntitlement(item) {
    if (!item || typeof item !== "object") return false;
    if (item.deleted === true || item.consumed === true) return false;
    const type = Number(item.type);
    if (type === 2) return false;
    if (skuProductLine(item) === 1) return false;
    if (skuProductLine(item) === SKU_PRODUCT_LINE_FRACTIONAL_PREMIUM) return true;
    if (entitlementSkuId(item) === NITRO_3DAY_SKU_ID) return true;
    if (NITRO_CREDIT_ENTITLEMENT_TYPES.has(type)) return true;
    if (isQuestNitroCredit(item)) return true;
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

    const label = skuLabel(item);
    const m = label.match(/(\d+)\s*-?\s*day/i);
    if (m) return Math.max(1, Number(m[1])) * MS_PER_DAY;

    // Current Orbs Nitro Credit SKU is always 3 days when metadata is missing.
    if (Number(item?.type) === 12) return 3 * MS_PER_DAY;
    return 0;
}

/** UTC calendar days from today to a future instant (Discord "End In X Days"). */
function utcCalendarDaysUntil(targetMs, now = Date.now()) {
    if (!targetMs || targetMs <= now) return 0;
    const a = new Date(now);
    const b = new Date(targetMs);
    const aUtc = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
    const bUtc = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
    return Math.max(0, Math.round((bUtc - aUtc) / MS_PER_DAY));
}

/**
 * Discord Nitro Home "Credits End In X Days":
 * max(active ends_at remaining) + sum(banked credit durations), as calendar days.
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
    const days = utcCalendarDaysUntil(now + totalMs, now);
    return days > 0 ? days : null;
}

async function fetchAllEntitlements(apiGet) {
    const all = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
        let url = "/users/@me/entitlements?exclude_ended=true&with_sku=true&limit=100";
        if (after) url += `&after=${encodeURIComponent(after)}`;
        const entRes = await apiGet({ url });
        const entBody = entRes?.body;
        const entitlements = Array.isArray(entBody)
            ? entBody
            : (Array.isArray(entBody?.entitlements) ? entBody.entitlements : []);
        if (!entitlements.length) break;
        all.push(...entitlements);
        if (entitlements.length < 100) break;
        const lastId = entitlements[entitlements.length - 1]?.id;
        if (!lastId || String(lastId) === String(after)) break;
        after = lastId;
    }
    return all;
}

export async function fetchNitroDaysRemaining(apiGet) {
    let bags = [];
    try {
        const entitlements = await fetchAllEntitlements(apiGet);
        bags = entitlements.filter(isNitroCreditEntitlement);
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
