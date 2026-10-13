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
const NITRO_HOME_PATH = "/store";
const NITRO_BADGE_WAIT_MS = 2500;
const NITRO_BADGE_POLL_MS = 100;

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

function currentRoutePath() {
    return window.location.pathname + window.location.search + window.location.hash;
}

function getWpRequire() {
    try {
        if (typeof webpackChunkdiscord_app === "undefined") return null;
        const req = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
        webpackChunkdiscord_app.pop();
        return req;
    } catch (_) {
        return null;
    }
}

function findDiscordRouter() {
    const wpRequire = getWpRequire();
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
}

async function navigateToPath(targetPath) {
    if (currentRoutePath() === targetPath) return true;

    const router = findDiscordRouter();
    if (router) {
        for (const method of ["transitionTo", "replaceWith", "navigate"]) {
            if (typeof router[method] === "function") {
                try {
                    await Promise.resolve(router[method](targetPath));
                    await new Promise(r => setTimeout(r, 500));
                    if (currentRoutePath() === targetPath) return true;
                } catch (_) {}
            }
        }
    }

    try {
        window.history.pushState({}, "", targetPath);
        window.dispatchEvent(new PopStateEvent("popstate"));
        await new Promise(r => setTimeout(r, 500));
        return currentRoutePath() === targetPath;
    } catch (_) {
        return false;
    }
}

export async function navigateToNitroHome() {
    return navigateToPath(NITRO_HOME_PATH);
}

export async function restoreRoute(savedPath) {
    if (!savedPath || currentRoutePath() === savedPath) return true;
    return navigateToPath(savedPath);
}

/** Parse "Credits End In N Days" from Nitro Home DOM (EN + loose i18n). */
export function parseNitroCreditsDaysFromDom(root = document) {
    const doc = root?.documentElement ? root : document;
    const chunks = [];

    try {
        const bodyText = doc.body?.innerText || "";
        if (bodyText) chunks.push(bodyText);
    } catch (_) {}

    try {
        const nodes = doc.querySelectorAll?.("span, div, p, h1, h2, h3, h4, strong, [class*='badge'], [class*='pill']");
        if (nodes?.length) {
            for (const node of nodes) {
                const t = node.textContent?.trim();
                if (t && t.length < 120) chunks.push(t);
            }
        }
    } catch (_) {}

    const patterns = [
        /(?:nitro\s+)?credits?\s+end\s+in\s+(\d+)\s+days?/i,
        /(\d+)\s+days?\s+(?:left|remaining)?\s*(?:on|of|for)?\s*(?:nitro\s+)?credits?/i,
        /(?:credit|رصيد).*?(\d+)\s*(?:days?|يوم|أيام)/i,
        /(\d+)\s*(?:days?|يوم|أيام).*?(?:credit|رصيد)/i,
    ];

    for (const text of chunks) {
        for (const re of patterns) {
            const m = text.match(re);
            if (m) {
                const days = Number.parseInt(m[1], 10);
                if (Number.isFinite(days) && days >= 0) return days;
            }
        }
    }
    return null;
}

export function waitForNitroCreditsBadge(timeoutMs = NITRO_BADGE_WAIT_MS) {
    return new Promise(resolve => {
        const started = Date.now();
        const check = () => {
            const days = parseNitroCreditsDaysFromDom();
            if (days != null) {
                cleanup();
                resolve(days);
                return;
            }
            if (Date.now() - started >= timeoutMs) {
                cleanup();
                resolve(null);
                return;
            }
            timer = setTimeout(check, NITRO_BADGE_POLL_MS);
        };

        let observer = null;
        let timer = null;
        const cleanup = () => {
            if (observer) {
                try { observer.disconnect(); } catch (_) {}
                observer = null;
            }
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };

        try {
            observer = new MutationObserver(check);
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        } catch (_) {}

        check();
    });
}

function unactivatedUnitDurationMs(unit) {
    if (!unit || typeof unit !== "object") return 0;
    const ent = unit.entitlement || unit;
    const fromEnt = bankedCreditDurationMs(ent);
    if (fromEnt > 0) return fromEnt;

    if (Number.isFinite(Number(unit.duration_ms))) return Math.max(0, Number(unit.duration_ms));
    if (Number.isFinite(Number(unit.durationMs))) return Math.max(0, Number(unit.durationMs));
    if (Number.isFinite(Number(unit.duration_seconds))) return Math.max(0, Number(unit.duration_seconds) * 1000);
    if (Number.isFinite(Number(unit.durationSeconds))) return Math.max(0, Number(unit.durationSeconds) * 1000);

    const plan = unit.subscription_plan || unit.subscriptionPlan;
    if (plan && Number.isFinite(Number(plan.interval_count ?? plan.intervalCount))) {
        const count = Math.max(0, Number(plan.interval_count ?? plan.intervalCount));
        const interval = Number(plan.interval);
        if (interval === PLAN_INTERVAL_DAY) return count * MS_PER_DAY;
        if (interval === PLAN_INTERVAL_MONTH) return count * 30 * MS_PER_DAY;
        if (interval === PLAN_INTERVAL_YEAR) return count * 365 * MS_PER_DAY;
    }

    return 3 * MS_PER_DAY;
}

/** Mirror Nitro Home via Discord EntitlementStore (same client data source). */
export function computeNitroDaysFromEntitlementStore(store, now = Date.now()) {
    if (!store || typeof store.getFractionalPremium !== "function") return null;

    let activeMs = 0;
    try {
        const active = store.getFractionalPremium();
        if (active) {
            const end = parseEndMs(
                active.ends_at
                || active.endsAt
                || active.current_period_end
                || active.currentPeriodEnd
                || active.expires_at
                || active.expiresAt
            );
            if (end > now) activeMs = end - now;
        }
    } catch (_) {}

    let bankedMs = 0;
    try {
        const units = store.getUnactivatedFractionalPremiumUnits?.() ?? [];
        const list = Array.isArray(units) ? units : [];
        for (const unit of list) bankedMs += unactivatedUnitDurationMs(unit);
    } catch (_) {}

    const totalMs = activeMs + bankedMs;
    if (totalMs <= 0) return null;
    const days = utcCalendarDaysUntil(now + totalMs, now);
    return days > 0 ? days : null;
}

export async function ensureEntitlementsLoaded(FluxDispatcher, EntitlementStore) {
    if (!EntitlementStore) return;

    if (EntitlementStore.fetchedAllEntitlements === true) return;

    try {
        if (typeof EntitlementStore.fetchAllEntitlements === "function") {
            await Promise.resolve(EntitlementStore.fetchAllEntitlements());
        } else if (typeof EntitlementStore.fetchEntitlementsForUser === "function") {
            await Promise.resolve(EntitlementStore.fetchEntitlementsForUser());
        } else if (FluxDispatcher?.dispatch) {
            FluxDispatcher.dispatch({ type: "ENTITLEMENTS_FETCH_FOR_USER" });
        }
    } catch (_) {}

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        if (EntitlementStore.fetchedAllEntitlements === true) return;
        if (typeof EntitlementStore.getFractionalPremium === "function") {
            try {
                const active = EntitlementStore.getFractionalPremium();
                const units = EntitlementStore.getUnactivatedFractionalPremiumUnits?.() ?? [];
                if (active || (Array.isArray(units) && units.length)) return;
            } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 100));
    }
}

async function fetchNitroDaysFromNitroHome() {
    const savedPath = currentRoutePath();
    const alreadyOnStore = savedPath.startsWith(NITRO_HOME_PATH);

    if (!alreadyOnStore) {
        const ok = await navigateToNitroHome();
        if (!ok) return null;
    }

    let days = parseNitroCreditsDaysFromDom();
    if (days == null) days = await waitForNitroCreditsBadge();

    if (!alreadyOnStore) await restoreRoute(savedPath);
    return days;
}

export async function fetchNitroDaysRemaining(_apiGet, {
    EntitlementStore = null,
    FluxDispatcher = null,
    navigateForBadge = true
} = {}) {
    const fromDomNow = parseNitroCreditsDaysFromDom();
    if (fromDomNow != null) return fromDomNow;

    if (navigateForBadge) {
        try {
            const fromNav = await fetchNitroDaysFromNitroHome();
            if (fromNav != null) return fromNav;
        } catch (_) {}
    }

    if (EntitlementStore) {
        await ensureEntitlementsLoaded(FluxDispatcher, EntitlementStore);
        const fromStore = computeNitroDaysFromEntitlementStore(EntitlementStore);
        if (fromStore != null) return fromStore;
    }

    return null;
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
