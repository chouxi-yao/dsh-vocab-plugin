// dsh-vocab-plugin / host half — 词场 Vocab 第二轮
//
// 碎片化取词调度层（简化间隔规则，暂不上 FSRS）：
//
//   1. 双词库隔离：CET4 / CET6 各自一份完整词表（data/cet4.json、data/cet6.json，
//      由 scripts/build-wordbooks.mjs 从 原始资料/ 只读派生）。复习状态按
//      `(deckId, wordId)` 独立存储。
//   2. 到期规则（自评时）：
//        3 会了  → dueAt = now + 3 天
//        2 模糊  → dueAt = now + 1 天
//        1 忘了  → dueAt = 明天 00:00，并允许当天在本轮队列里立即重试
//   3. 取词（无限流）：到期词（dueAt <= now，按逾期最久优先）**全部**入队，不再有
//      15 张硬上限；队列见底时客户端调 POST /next 继续追加。到期池低于 3 个时从
//      NEW 池随机补 1-3 个，补出来的词立刻转 LEARNING，不再回到随机池。
//   4. 冷却：同一个词 24h 内最多出现 1 次（"忘了"的当天重试除外）；单日出现
//      上限 3 次，到顶后今天不再弹。
//   5. 全部状态（dueAt / status / 当日出现次数）落盘
//      `$DSH_HOME/dsh-vocab/reviews.json`，重启不丢。
//
// 调试口子（方便验证队列逻辑，不用改系统时间）：
//   POST /dsh-vocab-plugin/api/debug/due    {deck?, count?}  让已学词立刻到期
//   POST /dsh-vocab-plugin/api/debug/learn  {deck?, count?}  把 NEW 词直接标成已学到期
//   POST /dsh-vocab-plugin/api/debug/age    {deck?, days?, count?}  把到期时间往前拨 N 天（模拟跨天）
//   POST /dsh-vocab-plugin/api/debug/reset  {deck?}          清空该词库复习状态
//   GET  /dsh-vocab-plugin/api/debug/stats                   各状态计数
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const name = 'dsh-vocab-plugin';
export const inject = ['webServer'];
// ── 常量 ──────────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;
/** 首批取词的"软"目标：只是首次打开时的手感，不再有硬上限。 */
const QUEUE_TARGET = 15;
/** 到期池低于这个数就从 NEW 池补新词（无限流的水位线）。 */
const LOW_WATER = 3;
const NEW_MIN = 1;
const NEW_MAX = 3;
const DAILY_CAP = 3;
const COOLDOWN_MS = DAY_MS;
const INTERVAL = { 2: DAY_MS, 3: 3 * DAY_MS };
/** 跨天连续答对到 3 次就"收服"（KNOWN），永久移出复习队列。 */
const KNOWN_STREAK = 3;
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');
const STORE_DIR = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'dsh-vocab');
const STORE_FILE = join(STORE_DIR, 'reviews.json');
// No trailing slash: the host matches registered prefixes verbatim.
const API_PREFIX = '/dsh-vocab-plugin/api';
// ── 运行时状态 ─────────────────────────────────────────────────────────────
const decks = { cet4: new Map(), cet6: new Map() };
const store = { version: 2, activeDeck: 'cet4', words: {} };
let saveTimer;
let saving;
const keyOf = (deck, id) => `${deck}|${id}`;
function localDay(ms) {
    const date = new Date(ms);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
function startOfTomorrow(ms) {
    const date = new Date(ms);
    date.setHours(24, 0, 0, 0);
    return date.getTime();
}
function freshState(status, dueAt) {
    return {
        status,
        dueAt,
        shownAt: 0,
        shownDay: '',
        shownToday: 0,
        seen: 0,
        grades: [0, 0, 0],
        lastGrade: 0,
        lastGradeDay: '',
        consecutiveCorrect: 0,
    };
}
function stateOf(deck, id) {
    const key = keyOf(deck, id);
    const existing = store.words[key];
    if (existing !== undefined)
        return existing;
    const created = freshState('NEW', 0);
    store.words[key] = created;
    return created;
}
/** 今日已到上限、或 24h 内已经出现过（"忘了"的当天重试除外）时不可入队。 */
function eligible(state, now) {
    const today = localDay(now);
    if (state.shownDay === today && state.shownToday >= DAILY_CAP)
        return false;
    if (state.shownAt > 0 && now - state.shownAt < COOLDOWN_MS) {
        // 当天按过"忘了"→ 允许当天立即重试
        const retriedToday = state.lastGrade === 1 && state.shownDay === today;
        return retriedToday;
    }
    return true;
}
function dueWords(deck, now) {
    const out = [];
    for (const word of decks[deck].values()) {
        const state = store.words[keyOf(deck, word.id)];
        // NEW 还没学；KNOWN 已收服——两者都永不进复习队列
        if (state === undefined || state.status === 'NEW' || state.status === 'KNOWN')
            continue;
        if (state.dueAt > now)
            continue;
        if (!eligible(state, now))
            continue;
        out.push({ word, state });
    }
    // 逾期最久的排最前
    out.sort((a, b) => a.state.dueAt - b.state.dueAt);
    return out;
}
function newWords(deck) {
    const out = [];
    for (const word of decks[deck].values()) {
        const state = store.words[keyOf(deck, word.id)];
        if (state === undefined || state.status === 'NEW')
            out.push(word);
    }
    return out;
}
function pickRandom(pool, count) {
    const copy = pool.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.max(0, Math.min(count, copy.length)));
}
function cardOf(deck, word, state, now, source) {
    return {
        k: keyOf(deck, word.id),
        w: word.w,
        y: word.y,
        p: word.p,
        ipa: word.ipa,
        ex: word.ex,
        deck,
        status: state.status,
        dueAt: state.dueAt,
        overdueMs: source === 'due' ? now - state.dueAt : 0,
        source,
        consecutiveCorrect: state.consecutiveCorrect,
    };
}
/** 到点了但被 24h 冷却或单日 3 次上限挡住的词数。 */
function coolingCount(deck, now) {
    let count = 0;
    for (const word of decks[deck].values()) {
        const state = store.words[keyOf(deck, word.id)];
        if (state === undefined || state.status === 'NEW')
            continue;
        if (state.dueAt > now)
            continue;
        if (eligible(state, now))
            continue;
        count += 1;
    }
    return count;
}
/**
 * 无限流取词：到期词**全给**（不再卡 15 张上限）；到期池低于 `LOW_WATER` 时
 * 按原规则补 1-3 个 NEW 词。`limit` 只约束"到期词"这一侧，新词永远按 1-3 张补，
 * 避免一次把新词池抽干。`exclude` 用来避开客户端手上还没背完的卡。
 */
function buildQueue(deck, limit = Number.POSITIVE_INFINITY, exclude = new Set()) {
    const now = Date.now();
    const dueAll = dueWords(deck, now);
    const due = exclude.size === 0 ? dueAll : dueAll.filter(({ word }) => !exclude.has(keyOf(deck, word.id)));
    const take = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), due.length)) : due.length;
    const cards = due.slice(0, take).map(({ word, state }) => cardOf(deck, word, state, now, 'due'));
    let addedNew = 0;
    if (due.length < LOW_WATER) {
        const pool = newWords(deck).filter((word) => !exclude.has(keyOf(deck, word.id)));
        const want = Math.min(pool.length, NEW_MIN + Math.floor(Math.random() * (NEW_MAX - NEW_MIN + 1)));
        for (const word of pickRandom(pool, want)) {
            // 抽出来的新词立刻转 LEARNING，之后不再进随机池
            const state = freshState('LEARNING', now);
            store.words[keyOf(deck, word.id)] = state;
            cards.push(cardOf(deck, word, state, now, 'new'));
            addedNew += 1;
        }
        if (addedNew > 0)
            scheduleSave();
    }
    const fresh = newWords(deck).length;
    const cooling = cards.length === 0 ? coolingCount(deck, now) : 0;
    let reason = null;
    if (cards.length === 0) {
        if (fresh === 0 && cooling === 0)
            reason = 'exhausted';
        else if (fresh === 0)
            reason = 'cooling';
        else
            reason = 'no-due';
    }
    return {
        deck,
        cards,
        dueCount: due.length,
        newCount: addedNew,
        empty: cards.length === 0,
        reason,
        pool: { due: due.length, fresh, cooling },
        now,
    };
}
function applyGrade(deck, id, grade) {
    const now = Date.now();
    const today = localDay(now);
    const state = stateOf(deck, id);
    // 已收服的词是终态：即使客户端残留了一张旧卡，也不能把它打回复习状态
    if (state.status === 'KNOWN')
        return { state, retry: false, known: true, crossDay: false };
    // 跨天判定：这一次复习**之前**，词的到期日已经是更早的一天。
    // 新词（dueAt = 今天）和"忘了"后的当天重试（dueAt = 明天）都不算跨天。
    const scheduledDay = state.dueAt > 0 ? localDay(state.dueAt) : today;
    const crossDay = scheduledDay < today && state.lastGradeDay !== today;
    state.seen += 1;
    state.grades[grade - 1] += 1;
    state.lastGrade = grade;
    state.lastGradeDay = today;
    if (grade === 3) {
        // 只有跨天的"会了"才计入连续答对
        if (crossDay)
            state.consecutiveCorrect += 1;
    }
    else if (grade === 1) {
        // 忘了：无论是不是跨天，连续记录清零
        state.consecutiveCorrect = 0;
    }
    // grade 2（模糊）：保持不变
    const known = state.consecutiveCorrect >= KNOWN_STREAK && grade === 3;
    if (known) {
        // 收服：永久移出复习队列
        state.status = 'KNOWN';
        state.dueAt = Number.MAX_SAFE_INTEGER;
    }
    else {
        state.status = 'REVIEW';
        state.dueAt = grade === 1 ? startOfTomorrow(now) : now + INTERVAL[grade];
    }
    const retry = !known && grade === 1 && state.shownToday < DAILY_CAP;
    scheduleSave();
    return { state, retry, known, crossDay };
}
function scheduleSave() {
    if (saveTimer !== undefined)
        clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        void flush();
    }, 120);
}
async function flush() {
    if (saving !== undefined)
        return saving;
    saving = (async () => {
        try {
            await mkdir(STORE_DIR, { recursive: true });
            const payload = `${JSON.stringify(store, null, 2)}\n`;
            const tmp = `${STORE_FILE}.${process.pid}.tmp`;
            await writeFile(tmp, payload, 'utf8');
            await rename(tmp, STORE_FILE);
        }
        catch (error) {
            console.error('[dsh-vocab-plugin] cannot persist reviews:', error);
        }
        finally {
            saving = undefined;
        }
    })();
    return saving;
}
// ── 加载 ──────────────────────────────────────────────────────────────────
async function readJsonFile(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
async function loadDecks() {
    for (const deck of ['cet4', 'cet6']) {
        const parsed = await readJsonFile(join(DATA_DIR, `${deck}.json`));
        const map = decks[deck];
        map.clear();
        for (const word of parsed?.words ?? [])
            map.set(word.id, word);
    }
}
function migrate(raw) {
    if (typeof raw !== 'object' || raw === null)
        return;
    const record = raw;
    if (record.version === 2 && typeof record.words === 'object' && record.words !== null) {
        const incoming = record.words;
        for (const [key, value] of Object.entries(incoming)) {
            if (typeof value !== 'object' || value === null)
                continue;
            const state = value;
            store.words[key] = {
                ...freshState(state.status ?? 'REVIEW', state.dueAt ?? Date.now()),
                ...state,
                grades: Array.isArray(state.grades) ? state.grades : [0, 0, 0],
            };
        }
        if (record.activeDeck === 'cet6' || record.activeDeck === 'cet4')
            store.activeDeck = record.activeDeck;
        return;
    }
    // 第一轮的扁平格式 { "<deck>|<id>": { last, seen, c1, c2, c3 } }
    const now = Date.now();
    for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'object' || value === null)
            continue;
        const old = value;
        store.words[key] = {
            ...freshState('REVIEW', now),
            seen: typeof old.seen === 'number' ? old.seen : 0,
            grades: [old.c1 ?? 0, old.c2 ?? 0, old.c3 ?? 0],
        };
    }
    scheduleSave();
}
async function loadStore() {
    migrate(await readJsonFile(STORE_FILE));
}
// ── HTTP ──────────────────────────────────────────────────────────────────
function sendJson(res, status, body) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(buf.length),
        'cache-control': 'no-store',
    });
    res.end(buf);
}
async function readJson(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}
function asDeck(value) {
    return value === 'cet4' || value === 'cet6' ? value : undefined;
}
function deckSummary(deck, now) {
    let learning = 0;
    let review = 0;
    let known = 0;
    let due = 0;
    for (const word of decks[deck].values()) {
        const state = store.words[keyOf(deck, word.id)];
        if (state === undefined || state.status === 'NEW')
            continue;
        if (state.status === 'KNOWN') {
            known += 1;
            continue;
        }
        if (state.status === 'LEARNING')
            learning += 1;
        else
            review += 1;
        if (state.dueAt <= now && eligible(state, now))
            due += 1;
    }
    const total = decks[deck].size;
    return {
        id: deck,
        label: deck === 'cet4' ? 'CET4' : 'CET6',
        total,
        learned: learning + review + known,
        learning,
        review,
        known,
        due,
        fresh: total - learning - review - known,
        // 界面上的"待学"= 还没收服的词：收服一个就 -1，重置后回到 total
        remaining: total - known,
    };
}
async function handleApi(req, res, route, url) {
    const now = Date.now();
    // ── 词库概览 / 切换 ────────────────────────────────────────────────────
    if (route === 'decks' && req.method === 'GET') {
        return sendJson(res, 200, {
            active: store.activeDeck,
            decks: [deckSummary('cet4', now), deckSummary('cet6', now)],
        });
    }
    if (route === 'deck' && req.method === 'POST') {
        let body;
        try {
            body = await readJson(req);
        }
        catch {
            return sendJson(res, 400, { error: 'invalid-json' });
        }
        const deck = asDeck(body.deck);
        if (deck === undefined)
            return sendJson(res, 400, { error: 'deck must be cet4 or cet6' });
        store.activeDeck = deck;
        scheduleSave();
        return sendJson(res, 200, {
            ok: true,
            active: deck,
            decks: [deckSummary('cet4', now), deckSummary('cet6', now)],
        });
    }
    // ── 取词队列（无限流：默认把到期词全给，不再卡 15 张） ────────────────
    if (route === 'queue' && req.method === 'GET') {
        const deck = asDeck(url.searchParams.get('deck')) ?? store.activeDeck;
        const size = Number.parseInt(url.searchParams.get('size') ?? '', 10);
        const limit = Number.isFinite(size) ? Math.max(1, size) : Number.POSITIVE_INFINITY;
        const queue = buildQueue(deck, limit);
        return sendJson(res, 200, {
            ...queue,
            decks: [deckSummary('cet4', now), deckSummary('cet6', now)],
        });
    }
    // ── 追加一张（队列见底时客户端调用，无限流的核心） ────────────────────
    if (route === 'next' && req.method === 'POST') {
        let body;
        try {
            body = await readJson(req);
        }
        catch {
            return sendJson(res, 400, { error: 'invalid-json' });
        }
        const deck = asDeck(body.deck) ?? store.activeDeck;
        const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.filter((item) => typeof item === 'string') : []);
        const wantRaw = Number(body.want);
        const want = Number.isFinite(wantRaw) ? Math.max(1, Math.min(Math.trunc(wantRaw), 10)) : 1;
        const queue = buildQueue(deck, want, exclude);
        return sendJson(res, 200, {
            ...queue,
            decks: [deckSummary('cet4', now), deckSummary('cet6', now)],
        });
    }
    // ── 卡片被展示（计冷却与当日次数） ────────────────────────────────────
    if (route === 'seen' && req.method === 'POST') {
        let body;
        try {
            body = await readJson(req);
        }
        catch {
            return sendJson(res, 400, { error: 'invalid-json' });
        }
        const key = typeof body.key === 'string' ? body.key : '';
        const [deckPart, id] = key.split('|');
        const deck = asDeck(deckPart);
        if (deck === undefined || !id || !decks[deck].has(id)) {
            return sendJson(res, 404, { error: 'unknown-card' });
        }
        const state = stateOf(deck, id);
        const today = localDay(now);
        if (state.shownDay !== today) {
            state.shownDay = today;
            state.shownToday = 0;
        }
        state.shownToday += 1;
        state.shownAt = now;
        scheduleSave();
        return sendJson(res, 200, {
            ok: true,
            key,
            shownToday: state.shownToday,
            dailyCap: DAILY_CAP,
            suppressed: state.shownToday >= DAILY_CAP,
        });
    }
    // ── 自评 ──────────────────────────────────────────────────────────────
    if (route === 'grade' && req.method === 'POST') {
        let body;
        try {
            body = await readJson(req);
        }
        catch {
            return sendJson(res, 400, { error: 'invalid-json' });
        }
        const key = typeof body.key === 'string' ? body.key : '';
        const [deckPart, id] = key.split('|');
        const deck = asDeck(deckPart);
        if (deck === undefined || !id || !decks[deck].has(id)) {
            return sendJson(res, 404, { error: 'unknown-card' });
        }
        const grade = Number(body.grade);
        if (grade !== 1 && grade !== 2 && grade !== 3) {
            return sendJson(res, 400, { error: 'grade must be 1, 2 or 3' });
        }
        // 注意：stateOf 返回的是引用，applyGrade 会原地改写，所以先把跨天判定需要的值拷出来
        // （诊断值只随响应返回，不再打日志）
        const snapshot = stateOf(deck, id);
        const dueAtBefore = snapshot.dueAt;
        const lastGradeDayBefore = snapshot.lastGradeDay;
        const scheduledDay = dueAtBefore > 0 ? localDay(dueAtBefore) : localDay(now);
        const today = localDay(now);
        const { state, retry, known, crossDay } = applyGrade(deck, id, grade);
        return sendJson(res, 200, {
            ok: true,
            key,
            retry,
            known,
            crossDay,
            debug: { scheduledDay, today, dueAtBefore, lastGradeDayBefore: lastGradeDayBefore || '' },
            status: state.status,
            consecutiveCorrect: state.consecutiveCorrect,
            dueAt: state.dueAt,
            dueInMs: state.dueAt - now,
            shownToday: state.shownToday,
            decks: [deckSummary('cet4', now), deckSummary('cet6', now)],
        });
    }
    // ── 调试：不用改系统时间也能验证队列 ──────────────────────────────────
    if (route.startsWith('debug/') && req.method !== 'GET') {
        let body = {};
        try {
            body = await readJson(req);
        }
        catch {
            return sendJson(res, 400, { error: 'invalid-json' });
        }
        const deck = asDeck(body.deck) ?? store.activeDeck;
        const requested = Number.parseInt(String(body.count ?? ''), 10);
        const count = Number.isFinite(requested) ? requested : Number.POSITIVE_INFINITY;
        if (route === 'debug/due') {
            const touched = [];
            for (const word of decks[deck].values()) {
                if (touched.length >= count)
                    break;
                const state = store.words[keyOf(deck, word.id)];
                if (state === undefined || state.status === 'NEW' || state.status === 'KNOWN')
                    continue;
                state.dueAt = now;
                state.shownAt = 0;
                state.shownDay = '';
                state.shownToday = 0;
                touched.push(keyOf(deck, word.id));
            }
            scheduleSave();
            return sendJson(res, 200, { ok: true, deck, forced: touched.length, keys: touched });
        }
        // 把已学词的到期时间整体往前拨 N 天，用来模拟"明天再来"，方便验证跨天/收服
        if (route === 'debug/age') {
            const daysRaw = Number(body.days);
            const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 1;
            // 只拨 body.key 指定的那一个词：验证跨天时屏幕上的卡不能换
            if (typeof body.key === 'string' && body.key.length > 0) {
                const [keyDeckPart, keyId] = body.key.split('|');
                const onlyDeck = asDeck(keyDeckPart) ?? deck;
                const state = keyId ? store.words[keyOf(onlyDeck, keyId)] : undefined;
                if (state === undefined)
                    return sendJson(res, 404, { error: 'unknown-card', key: body.key });
                if (state.status === 'KNOWN')
                    return sendJson(res, 200, { ok: true, deck: onlyDeck, days, aged: 0, keys: [], note: 'already-known' });
                state.dueAt = now - days * DAY_MS;
                state.shownAt = 0;
                state.shownDay = '';
                state.shownToday = 0;
                if (state.lastGradeDay) {
                    const [y, m, d] = state.lastGradeDay.split('-').map(Number);
                    if (y && m && d)
                        state.lastGradeDay = localDay(new Date(y, m - 1, d).getTime() - days * DAY_MS);
                }
                scheduleSave();
                return sendJson(res, 200, { ok: true, deck: onlyDeck, days, aged: 1, keys: [body.key] });
            }
            const touched = [];
            for (const word of decks[deck].values()) {
                if (touched.length >= count)
                    break;
                const state = store.words[keyOf(deck, word.id)];
                if (state === undefined || state.status === 'NEW' || state.status === 'KNOWN')
                    continue;
                state.dueAt = now - days * DAY_MS;
                state.shownAt = 0;
                state.shownDay = '';
                state.shownToday = 0;
                // 时间旅行要一起拨：否则 lastGradeDay 还是"今天"，跨天判定不成立
                if (state.lastGradeDay) {
                    const [y, m, d] = state.lastGradeDay.split('-').map(Number);
                    if (y && m && d)
                        state.lastGradeDay = localDay(new Date(y, m - 1, d).getTime() - days * DAY_MS);
                }
                touched.push(keyOf(deck, word.id));
            }
            scheduleSave();
            return sendJson(res, 200, { ok: true, deck, days, aged: touched.length, keys: touched });
        }
        if (route === 'debug/learn') {
            const pool = newWords(deck);
            const touched = [];
            for (const word of pickRandom(pool, Number.isFinite(count) ? count : 10)) {
                store.words[keyOf(deck, word.id)] = freshState('REVIEW', now);
                touched.push(keyOf(deck, word.id));
            }
            scheduleSave();
            return sendJson(res, 200, { ok: true, deck, learned: touched.length, keys: touched });
        }
        if (route === 'debug/reset') {
            let removed = 0;
            for (const word of decks[deck].values()) {
                const key = keyOf(deck, word.id);
                if (store.words[key] !== undefined) {
                    delete store.words[key];
                    removed += 1;
                }
            }
            scheduleSave();
            return sendJson(res, 200, { ok: true, deck, removed });
        }
    }
    if (route === 'debug/stats' && req.method === 'GET') {
        const stats = {};
        for (const deck of ['cet4', 'cet6']) {
            let learning = 0;
            let review = 0;
            let newCount = 0;
            let known = 0;
            let due = 0;
            let suppressedToday = 0;
            const today = localDay(now);
            for (const word of decks[deck].values()) {
                const state = store.words[keyOf(deck, word.id)];
                if (state === undefined || state.status === 'NEW') {
                    newCount += 1;
                    continue;
                }
                if (state.status === 'KNOWN') {
                    known += 1;
                    continue;
                }
                if (state.status === 'LEARNING')
                    learning += 1;
                else
                    review += 1;
                if (state.dueAt <= now && eligible(state, now))
                    due += 1;
                if (state.shownDay === today && state.shownToday >= DAILY_CAP)
                    suppressedToday += 1;
            }
            stats[deck] = { total: decks[deck].size, new: newCount, learning, review, known, due, suppressedToday };
        }
        return sendJson(res, 200, {
            ok: true,
            active: store.activeDeck,
            today: localDay(now),
            now,
            store: STORE_FILE,
            data: DATA_DIR,
            decks: stats,
        });
    }
    if (route === 'state' && req.method === 'GET') {
        return sendJson(res, 200, {
            ok: true,
            active: store.activeDeck,
            decks: [deckSummary('cet4', now), deckSummary('cet6', now)],
            lowWater: LOW_WATER,
            knownStreak: KNOWN_STREAK,
            batchHint: QUEUE_TARGET,
            dailyCap: DAILY_CAP,
            cooldownHours: COOLDOWN_MS / 3_600_000,
            store: STORE_FILE,
            data: DATA_DIR,
        });
    }
    return sendJson(res, 404, { error: 'not-found', route });
}
// ── Plugin ────────────────────────────────────────────────────────────────
export function apply(ctx) {
    void (async () => {
        await loadDecks();
        await loadStore();
    })();
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
            const url = new URL(req.url ?? API_PREFIX, 'http://localhost');
            const route = url.pathname
                .slice(API_PREFIX.length)
                .replace(/^\/+/, '')
                .replace(/\/+$/, '');
            try {
                await handleApi(req, res, route, url);
            }
            catch (error) {
                console.error('[dsh-vocab-plugin] api failed:', error);
                if (!res.headersSent)
                    sendJson(res, 500, { error: 'internal' });
                else
                    res.end();
            }
        },
    }), 'dsh-vocab-plugin: api routes');
    // Persist anything still buffered when the plugin unloads.
    ctx.effect(() => () => {
        if (saveTimer !== undefined)
            clearTimeout(saveTimer);
        saveTimer = undefined;
        void flush();
    }, 'dsh-vocab-plugin: flush reviews');
}
