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
const MS_PER_HOUR = 3600000;

/** Discord client application that owns fractional / Orbs Nitro credits. */
const DISCORD_APPLICATION_ID = "521842831262875670";

/** Shop Orbs exclusives: 1 hour, 1 day, 3 day. Not a paid or gifted subscription. */
const FRACTIONAL_SKU_MS = {
    "1271583180566036480": MS_PER_HOUR,
    "1298745361602449479": MS_PER_DAY,
    "1333912750274904064": 3 * MS_PER_DAY,
};

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
    if (FRACTIONAL_SKU_MS[entitlementSkuId(item)]) return true;
    if (NITRO_CREDIT_ENTITLEMENT_TYPES.has(type)) return true;
    if (isQuestNitroCredit(item)) return true;
    return false;
}

/** Banked credit duration in ms (unused inventory: no active ends_at yet). */
function bankedCreditDurationMs(item) {
    const skuMs = FRACTIONAL_SKU_MS[entitlementSkuId(item)];
    if (skuMs) return skuMs;

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

    // Orbs Nitro Credit (type 12 + known SKU / fractional line) is 3 days when metadata is missing.
    if (
        Number(item?.type) === 12
        && (
            entitlementSkuId(item) === NITRO_3DAY_SKU_ID
            || skuProductLine(item) === SKU_PRODUCT_LINE_FRACTIONAL_PREMIUM
        )
    ) {
        return 3 * MS_PER_DAY;
    }
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

function isPaidOrGiftSubscription(item) {
    const type = Number(item?.type);
    if (type === 2) return true;
    if (skuProductLine(item) === 1) return true;
    return false;
}

/**
 * Nitro Home "Credits End In N Days":
 * the latest active fractional endsAt, plus unused 1-hour / 1-day / 3-day units.
 * Paid and gifted Nitro subscriptions are ignored.
 */
function daysFromCreditEntitlements(records, now = Date.now()) {
    const credits = [];
    const seen = new Set();
    for (const item of records || []) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        if (item.deleted === true || isPaidOrGiftSubscription(item)) continue;
        const id = String(item.id || "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        credits.push(item);
    }
    if (!credits.length) return null;

    const active = credits
        .map(item => ({ item, end: endMsFrom(item) }))
        .filter(entry => entry.end > now)
        .sort((a, b) => b.end - a.end)[0] || null;

    let extraMs = 0;
    for (const item of credits) {
        if (item.consumed === true) continue;
        if (endMsFrom(item) > now) continue;
        if (active && String(item.id || "") && String(item.id) === String(active.item.id || "")) continue;
        extraMs += bankedCreditDurationMs(item);
    }

    const totalEnd = active ? active.end + extraMs : (extraMs > 0 ? now + extraMs : 0);
    if (!totalEnd || totalEnd <= now) return null;
    const days = utcCalendarDaysUntil(totalEnd, now);
    return days > 0 ? days : 1;
}

/**
 * Discord Nitro Home "Credits End In X Days" for Orbs / fractional credits only.
 */
export function computeNitroDaysRemaining(sources, now = Date.now()) {
    const list = (Array.isArray(sources) ? sources : []).filter(isNitroCreditEntitlement);
    if (!list.length) return null;
    return daysFromCreditEntitlements(list, now);
}

/** Parse "Credits End In N Days" from Nitro Home DOM if already visible (no navigation). */
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

function endMsFrom(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return 0;
    const direct = parseEndMs(
        obj.ends_at
        || obj.endsAt
        || obj.current_period_end
        || obj.currentPeriodEnd
        || obj.expires_at
        || obj.expiresAt
        || obj.entitlement?.ends_at
        || obj.entitlement?.endsAt
        || obj.entitlement?.expires_at
        || obj.entitlement?.expiresAt
    );
    if (direct) return direct;
    const start = parseEndMs(obj.starts_at || obj.startsAt || obj.entitlement?.starts_at || obj.entitlement?.startsAt);
    const duration = bankedCreditDurationMs(obj.entitlement || obj);
    if (start && duration) return start + duration;
    return 0;
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

    // Orbs Nitro Credit units default to 3 days when metadata is missing.
    if (entitlementSkuId(ent) === NITRO_3DAY_SKU_ID || Number(ent?.type) === 12) {
        return 3 * MS_PER_DAY;
    }
    return 0;
}

function collectStoreEntitlements(store) {
    const out = [];
    try {
        const raw = typeof store.get === "function" ? store.get() : null;
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === "object") {
            for (const v of Object.values(raw)) {
                if (v && typeof v === "object") out.push(v);
            }
        }
    } catch (_) {}
    return out;
}

function fractionalPremiumList(store) {
    let raw = null;
    try {
        raw = store.getFractionalPremium({ includeEnded: false, excludeReverseTrial: true });
    } catch (_) {
        try { raw = store.getFractionalPremium(); } catch (_) {}
    }
    if (Array.isArray(raw)) return raw.filter(item => item && typeof item === "object");
    if (raw && typeof raw === "object") return [raw];
    return [];
}

/** Mirror Nitro Home via Discord EntitlementStore. getFractionalPremium() returns an array. */
export function computeNitroDaysFromEntitlementStore(store, now = Date.now()) {
    if (!store || typeof store.getFractionalPremium !== "function") return null;

    const records = [];
    try {
        for (const item of fractionalPremiumList(store)) {
            if (!isPaidOrGiftSubscription(item)) records.push(item);
        }
    } catch (_) {}

    try {
        const units = store.getUnactivatedFractionalPremiumUnits?.() ?? [];
        const list = Array.isArray(units) ? units : [];
        for (const unit of list) {
            const ent = unit?.entitlement && typeof unit.entitlement === "object" ? unit.entitlement : unit;
            if (!isPaidOrGiftSubscription(ent)) records.push(ent);
        }
    } catch (_) {}

    const fromFractional = daysFromCreditEntitlements(records, now);
    if (fromFractional != null) return fromFractional;

    const fromGet = computeNitroDaysRemaining(collectStoreEntitlements(store), now);
    return fromGet != null ? fromGet : null;
}

let fractionalWarmupAt = 0;

function warmEntitlementFetches(actions, EntitlementStore) {
    const names = [
        "fetchUserEntitlements",
        "fetchEntitlementsForUser",
        "fetchAllEntitlements",
        "fetchApplicationEntitlements",
        "fetchEntitlementsForApplication",
    ];
    for (const src of [actions, EntitlementStore]) {
        if (!src || (typeof src !== "object" && typeof src !== "function")) continue;
        for (const key of names) {
            let fn;
            try { fn = src[key]; } catch (_) { continue; }
            if (typeof fn !== "function") continue;
            const attempts = [
                () => fn.call(src),
                () => fn.call(src, DISCORD_APPLICATION_ID),
                () => fn.call(src, { applicationId: DISCORD_APPLICATION_ID, entitlementType: 11 }),
            ];
            for (const run of attempts) {
                try {
                    const result = run();
                    if (result && typeof result.then === "function") result.catch(() => {});
                } catch (_) {}
            }
        }
    }
}

export async function ensureEntitlementsLoaded(FluxDispatcher, EntitlementStore, EntitlementActions = null, fresh = false) {
    if (!EntitlementStore) return;
    if (!fresh && Date.now() - fractionalWarmupAt < 8000) return;
    fractionalWarmupAt = Date.now();

    try { warmEntitlementFetches(EntitlementActions, EntitlementStore); } catch (_) {}
    if (FluxDispatcher?.dispatch) {
        try { FluxDispatcher.dispatch({ type: "ENTITLEMENTS_FETCH_FOR_USER" }); } catch (_) {}
    }

    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
        try {
            if (fractionalPremiumList(EntitlementStore).length) return;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 100));
    }
}

function entitlementListFromBody(body) {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.entitlements)) return body.entitlements;
    if (Array.isArray(body?.user_entitlements)) return body.user_entitlements;
    return [];
}

let lastNitroDebug = "";
export function getLastNitroDebug() {
    return lastNitroDebug;
}

async function fetchOrbCreditEntitlements(apiGet) {
    const skuIds = Object.keys(FRACTIONAL_SKU_MS).join(",");
    // exclude_consumed defaults to true on the user-application route, which drops
    // the credit that is already running. Ask for those records explicitly.
    const urls = [
        `/users/@me/applications/${DISCORD_APPLICATION_ID}/entitlements?exclude_consumed=false&sku_ids=${skuIds}`,
        `/users/@me/applications/${DISCORD_APPLICATION_ID}/entitlements?exclude_consumed=false`,
        `/users/@me/entitlements?with_sku=true&exclude_ended=true&entitlement_type=11`,
        `/users/@me/entitlements?with_sku=true&exclude_ended=true&entitlement_type=12`,
        `/users/@me/entitlements?with_sku=true&exclude_ended=false&entitlement_type=11`,
        `/users/@me/entitlements?with_sku=true&exclude_ended=false&entitlement_type=12`,
    ];
    const merged = [];
    const notes = [];
    for (const url of urls) {
        const label = url.includes("/applications/") ? "app" : `type${url.match(/entitlement_type=(\d+)/)?.[1] || "?"}`;
        const ended = url.includes("exclude_ended=false") ? "-all" : "";
        try {
            const res = await apiGet({ url });
            const list = entitlementListFromBody(res?.body ?? res);
            merged.push(...list);
            notes.push(`${label}${ended}:${list.length}`);
        } catch (e) {
            const status = e?.status || e?.body?.code || "err";
            notes.push(`${label}${ended}:${status}`);
        }
    }
    return { list: merged, notes };
}

let nitroDaysCache = { at: 0, days: null, known: false };

/**
 * Orbs Nitro credit days, without opening Nitro Home.
 * Paid and gifted subscriptions are not counted.
 * 1) EntitlementStore fractional credits
 * 2) REST fractional / known Orbs SKUs
 * 3) Nitro Home text only if that page is already open
 */
export async function fetchNitroDaysRemaining(apiGet, {
    EntitlementStore = null,
    FluxDispatcher = null,
    EntitlementActions = null,
    fresh = false
} = {}) {
    if (!fresh && nitroDaysCache.known) {
        const ttl = nitroDaysCache.days == null ? 4000 : 15000;
        if (Date.now() - nitroDaysCache.at < ttl) return nitroDaysCache.days;
    }

    let days = null;

    if (EntitlementStore) {
        await ensureEntitlementsLoaded(FluxDispatcher, EntitlementStore, EntitlementActions, fresh);
        days = computeNitroDaysFromEntitlementStore(EntitlementStore);
    }

    let notes = [];
    let matched = [];
    if (days == null && typeof apiGet === "function") {
        try {
            const fetched = await fetchOrbCreditEntitlements(apiGet);
            notes = fetched.notes;
            matched = fetched.list.filter(isOrbCreditRecord);
            days = daysFromCreditEntitlements(matched);
        } catch (e) {
            notes.push(String(e?.status || e?.message || "fetch-failed"));
        }
    }

    if (days == null) {
        days = parseNitroCreditsDaysFromDom();
    }

    if (days == null) {
        const sample = matched.slice(0, 3).map(item => {
            const sku = entitlementSkuId(item);
            return `t${Number(item?.type) || 0}/${sku ? sku.slice(-4) : "nosku"}/e${endMsFrom(item) ? 1 : 0}/c${item?.consumed ? 1 : 0}`;
        }).join(",");
        let storeCount = 0;
        try { storeCount = EntitlementStore ? fractionalPremiumList(EntitlementStore).length : 0; } catch (_) {}
        lastNitroDebug = `Nitro credits unavailable (${notes.join(" ") || "no-request"}; match ${sample || "none"}; store ${storeCount})`;
    } else {
        lastNitroDebug = "";
    }

    nitroDaysCache = { at: Date.now(), days, known: true };
    return days;
}

function isOrbCreditRecord(item) {
    if (!item || typeof item !== "object" || item.deleted === true) return false;
    if (isPaidOrGiftSubscription(item)) return false;
    if (isNitroCreditEntitlement(item)) return true;
    const type = Number(item.type);
    if (type === 11 || type === 12) return true;
    if (FRACTIONAL_SKU_MS[entitlementSkuId(item)]) return true;
    return skuProductLine(item) === SKU_PRODUCT_LINE_FRACTIONAL_PREMIUM;
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
