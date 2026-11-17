/**
 * adsterras.js — 双班（美国 / 日本）随机访问社媒入口，返回本地空页面并点击目标链接
 *
 * 用法:
 *   node adsterras.js [--urls=./visit-links.json] [--social=./social-urls.json]
 *     [--social-jp=./social-urls-jp.json]
 *     [--visits-per-day-us=150] [--visits-per-day-jp=150]
 *     [--max-concurrency=4] [--after-click-sec=2] [--headless]
 *
 * 链接文件为 {"us": [...], "jp": [...]} 分组，两班各跑各的链接、互不交叉：
 * 美国班使用美国代理 + America/New_York + 美国作息权重；
 * 日本班使用日本代理 + Asia/Tokyo + 日本作息权重。
 * 每条链接一个独立异步循环：日访问量服从泊松分布，按本地作息加权，
 * 到点各自启动全新浏览器（随机 --fingerprint seed），全局并发上限默认 4。
 * 每轮访问用全新浏览器进程 + 独立隐私上下文 + 上下文级 SOCKS5 代理；
 * 访问前先用轻量 IP 接口确认出口 IP：若本次进程已使用过则更换端点重试；
 * 达到尝试上限仍找不到未使用过的出口 IP 时，跳过本轮访问。
 */

import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchNovProxyList } from './shared/proxy-utils.js';
import { matchesHost } from './shared/target-pac.js';
import {
    tzDayKey, nextDay, buildDayEvents,
    US_HOURLY_WEIGHTS, JP_HOURLY_WEIGHTS,
} from './shared/visit-schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = false;

const NAV_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const CLICK_DELAY_MIN_MS = 0;
const CLICK_DELAY_MAX_MS = 0;
const AFTER_CLICK_SEC = 2;
const VISITS_PER_DAY = 150;
const SCHEDULE_SLEEP_CHUNK_MS = 30000;
const MAX_CONCURRENCY = 4;
// 访问计划开关：true 按各班的本地作息计划访问，false 每条链接连续访问（改后重启生效）
const SCHEDULE_ENABLED = true;

// ==================== 代理与出口 IP ====================

const PROXY_API_URL = (region) =>
    `https://white.novproxy.com/white/api?region=${encodeURIComponent(region)}` +
    '&num=1000&time=1&format=1&type=txt';
const PROXY_LIST_REFRESH_MS = 30 * 60 * 1000;
// 端点碰撞后冷却：等它的出口 IP 轮换（time=1 约 1 分钟）
const PROXY_COOLDOWN_MS = 60 * 1000;
// 探测失败后的冷却，比碰撞短
const PROBE_ERROR_COOLDOWN_MS = 15 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const PROBE_CONCURRENCY = 3;
const MAX_PROXY_ATTEMPTS = 6;
const IP_PROBE_URLS = [
    'https://icanhazip.com/',
    'https://checkip.amazonaws.com/',
    'https://api.ipify.org/',
];
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const STATS_LOG_EVERY = 20;
// 每条链接在访问时刻前多少毫秒启动浏览器（启动实测约 2 秒）
const PREWARM_LEAD_MS = 15000;

// ==================== 日志 ====================

function tslog(msg) {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${t}] ${msg}`);
}

const tag = (shift) => shift.name.toUpperCase();

// ==================== 命令行参数 ====================

function parsePositiveInt(v, fallback) {
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseNonNegativeFloat(v, fallback) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseArgs() {
    const args = process.argv.slice(2);

    const envVisits = process.env.VISITS_PER_DAY;
    const params = {
        urlsFile: path.join(__dirname, 'visit-links.json'),
        socialFile: path.join(__dirname, 'social-urls.json'),
        socialJpFile: path.join(__dirname, 'social-urls-jp.json'),
        afterClickSec: parseNonNegativeFloat(process.env.AFTER_CLICK_SEC, AFTER_CLICK_SEC),
        visitsPerDayUs: parsePositiveInt(process.env.VISITS_PER_DAY_US,
            parsePositiveInt(envVisits, VISITS_PER_DAY)),
        visitsPerDayJp: parsePositiveInt(process.env.VISITS_PER_DAY_JP,
            parsePositiveInt(envVisits, VISITS_PER_DAY)),
        maxConcurrency: parsePositiveInt(process.env.MAX_CONCURRENCY, MAX_CONCURRENCY),
        headless: isLinux,
    };

    for (const arg of args) {
        if (arg.startsWith('--urls=')) {
            params.urlsFile = arg.slice('--urls='.length);
        } else if (arg.startsWith('--social=')) {
            params.socialFile = arg.slice('--social='.length);
        } else if (arg.startsWith('--social-jp=')) {
            params.socialJpFile = arg.slice('--social-jp='.length);
        } else if (arg.startsWith('--after-click-sec=')) {
            const v = parseFloat(arg.slice('--after-click-sec='.length));
            if (Number.isFinite(v) && v >= 0) params.afterClickSec = v;
        } else if (arg.startsWith('--visits-per-day-us=')) {
            const v = parseInt(arg.slice('--visits-per-day-us='.length), 10);
            if (Number.isInteger(v) && v > 0) params.visitsPerDayUs = v;
        } else if (arg.startsWith('--visits-per-day-jp=')) {
            const v = parseInt(arg.slice('--visits-per-day-jp='.length), 10);
            if (Number.isInteger(v) && v > 0) params.visitsPerDayJp = v;
        } else if (arg.startsWith('--visits-per-day=')) {
            const v = parseInt(arg.slice('--visits-per-day='.length), 10);
            if (Number.isInteger(v) && v > 0) {
                params.visitsPerDayUs = v;
                params.visitsPerDayJp = v;
            }
        } else if (arg.startsWith('--max-concurrency=')) {
            const v = parseInt(arg.slice('--max-concurrency='.length), 10);
            if (Number.isInteger(v) && v > 0) params.maxConcurrency = v;
        } else if (arg === '--headless') {
            params.headless = true;
        }
    }

    return params;
}

// ==================== 数据列表 ====================

function normalizeUrl(item, label, i) {
    const url = typeof item === 'string' ? item.trim() : '';
    let parsed = null;
    try {
        parsed = new URL(url);
    } catch {
        parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        throw new Error(`${label}第 ${i + 1} 项不是有效的 http(s) URL`);
    }
    return url;
}

function validateUrlArray(arr, label) {
    if (!Array.isArray(arr)) {
        throw new Error(`${label}必须是数组`);
    }
    return arr.map((item, i) => normalizeUrl(item, label, i));
}

function loadUrlList(file, label) {
    if (!fs.existsSync(file)) {
        throw new Error(`${label}文件不存在: ${file}`);
    }
    let arr;
    try {
        arr = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        throw new Error(`${label}文件不是合法 JSON: ${e.message}`);
    }
    if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error(`${label}必须是非空数组: ${file}`);
    }
    return validateUrlArray(arr, label);
}

/** 读取 {"us":[...], "jp":[...]} 分组；旧版纯数组按 us 处理 */
function loadUrlGroups(file) {
    if (!fs.existsSync(file)) {
        throw new Error(`目标链接文件不存在: ${file}`);
    }
    let data;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        throw new Error(`目标链接文件不是合法 JSON: ${e.message}`);
    }

    if (Array.isArray(data)) {
        console.log(`⚠️  目标链接文件为旧版数组格式，按 us 处理: ${file}`);
        return { us: validateUrlArray(data, '目标链接(us)'), jp: [] };
    }
    if (!data || typeof data !== 'object') {
        throw new Error(`目标链接文件必须是 {"us":[...],"jp":[...]} 或数组: ${file}`);
    }
    return {
        us: data.us === undefined ? [] : validateUrlArray(data.us, '目标链接(us)'),
        jp: data.jp === undefined ? [] : validateUrlArray(data.jp, '目标链接(jp)'),
    };
}

// ==================== 域名工具 ====================

function hostnameOf(u) {
    try {
        return new URL(u).hostname || null;
    } catch {
        return null;
    }
}

// ==================== 本地空页面 ====================

function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildHtml(targetUrl) {
    const safe = escapeHtml(targetUrl);
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title></title>
</head>
<body><a href="${safe}">${safe}</a></body>
</html>`;
}

/**
 * 主 frame 导航到社媒域名时返回本地空页面；
 * 同域名的其余请求（如 favicon.ico）一律中止；
 * 本班目标链接域名（含子域名）的请求全部放行（经该上下文的代理）；
 * 其余域名一律中止。
 */
function setupRequestHandler(page, socialHost, targetHosts, targetUrl) {
    const html = buildHtml(targetUrl);
    let served = false;

    page.setRequestInterception(true).catch(() => {});
    page.on('request', (req) => {
        const host = hostnameOf(req.url());

        if (host && host === socialHost) {
            if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
                if (!served) {
                    served = true;
                    tslog('   📄 返回本地空页面（含目标链接）');
                }
                req.respond({
                    status: 200,
                    contentType: 'text/html; charset=utf-8',
                    body: html,
                }).catch(() => {});
            } else {
                req.abort().catch(() => {});
            }
            return;
        }

        if (!host) {
            req.continue().catch(() => {});
            return;
        }
        if (matchesHost(host, targetHosts)) {
            req.continue().catch(() => {});
            return;
        }
        if (req.isNavigationRequest()) {
            tslog(`   🚫 已中止导航: ${req.url()}`);
        }
        req.abort().catch(() => {});
    });
}

// ==================== 点击目标链接 ====================

async function clickTargetLink(page) {
    let anchor;
    try {
        anchor = await page.waitForSelector('body a[href]', { timeout: DEFAULT_TIMEOUT_MS });
    } catch {
        tslog('   ⚠️ 空页面中未找到目标链接');
        return false;
    }

    const delay = CLICK_DELAY_MIN_MS + Math.random() * (CLICK_DELAY_MAX_MS - CLICK_DELAY_MIN_MS);
    tslog(`   🎯 已定位目标链接，${(delay / 1000).toFixed(1)} 秒后点击`);
    await sleep(delay);
    if (stopping) return false;

    const box = await anchor.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) {
        tslog('   ⚠️ 未获取到链接的屏幕位置，跳过点击');
        return false;
    }

    const x = Math.round(box.x + box.width * (0.2 + Math.random() * 0.6));
    const y = Math.round(box.y + box.height * (0.2 + Math.random() * 0.6));

    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
        .catch(() => null);

    try {
        await page.mouse.move(x, y, { steps: 10 });
        await sleep(100);
        await page.mouse.click(x, y, { delay: 80 });
        tslog(`   👆 已点击目标链接 (${x}, ${y})`);
    } catch (e) {
        tslog(`   ⚠️ 点击目标链接失败: ${e.message}`);
        return false;
    }

    await navPromise;

    tslog(`   🌐 点击后当前地址: ${page.url()}`);
    return true;
}

// ==================== 浏览器生命周期 ====================

const BASE_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
];

let headlessFlag = isLinux;
let stopping = false;

const activeSlots = new Set();
const activeContexts = new Set();

// 并发槽位：全局最多同时运行 slotPool.limit 个浏览器，超出的循环轮询等待
const slotPool = { limit: MAX_CONCURRENCY, active: 0 };

async function acquireSlot() {
    while (!stopping) {
        if (slotPool.active < slotPool.limit) {
            slotPool.active++;
            return true;
        }
        await sleep(200);
    }
    return false;
}

function releaseSlot() {
    slotPool.active = Math.max(0, slotPool.active - 1);
}

/**
 * 启动一个全新的浏览器进程。每次启动随机生成指纹 seed，
 * 该 seed 决定 canvas / WebGL / audio / GPU / 硬件参数等一整组指纹；
 * 时区与语言跟随班次。
 */
async function launchFreshBrowser(shift) {
    const seed = 10000 + Math.floor(Math.random() * 90000);
    const b = await launch({
        headless: headlessFlag,
        humanize: true,
        timezone: shift.tz,
        locale: shift.locale,
        args: [...BASE_ARGS, `--fingerprint=${seed}`],
    });
    tslog(`🧩 [${tag(shift)}] 浏览器已启动（seed=${seed}，时区 ${shift.tz}，本轮独立指纹）`);
    return { browser: b, seed };
}

async function closeSlot(slot) {
    if (slot && slot.browser) {
        await slot.browser.close().catch(() => {});
    }
}

async function createProxyContext(browser, proxyKey) {
    if (typeof browser.createBrowserContext !== 'function') {
        throw new Error('当前浏览器不支持 createBrowserContext');
    }
    return browser.createBrowserContext({ proxyServer: `socks5://${proxyKey}` });
}

// ==================== 代理列表（按区域隔离） ====================

const proxyPools = new Map();
const proxyCooldown = new Map();
const usedIPs = new Set();

function getProxyPool(region) {
    let pool = proxyPools.get(region);
    if (!pool) {
        pool = { endpoints: [], fetchedAt: 0, inflight: null };
        proxyPools.set(region, pool);
    }
    return pool;
}

/** 拉取/刷新某区域的代理端点列表；并发调用共享同一次请求 */
async function ensureProxyList(region, force = false) {
    const pool = getProxyPool(region);
    if (!force && pool.endpoints.length > 0 &&
        Date.now() - pool.fetchedAt < PROXY_LIST_REFRESH_MS) {
        return;
    }
    if (pool.inflight) {
        await pool.inflight;
        return;
    }

    pool.inflight = (async () => {
        try {
            const list = await fetchNovProxyList(PROXY_API_URL(region));
            pool.endpoints = list;
            pool.fetchedAt = Date.now();
            tslog(`📡 [${region}] 代理列表已缓存: ${list.length} 个端点`);
        } catch (e) {
            if (pool.endpoints.length === 0) throw e;
            tslog(`⚠️  [${region}] 代理列表刷新失败，继续使用旧列表: ${e.message}`);
        }
    })();

    try {
        await pool.inflight;
    } finally {
        pool.inflight = null;
    }
}

function pickCandidateEndpoints(region, count, tried) {
    const now = Date.now();
    const pool = getProxyPool(region).endpoints.filter(ep => {
        const key = endpointKey(ep);
        if (tried.has(key)) return false;
        const until = proxyCooldown.get(key);
        if (until && until > now) return false;
        if (until) proxyCooldown.delete(key);
        return true;
    });

    const picked = [];
    while (picked.length < count && pool.length > 0) {
        const idx = Math.floor(Math.random() * pool.length);
        picked.push(pool[idx]);
        pool.splice(idx, 1);
    }
    return picked;
}

function endpointKey(ep) {
    return `${ep.host}:${ep.port}`;
}

// ==================== 出口 IP 探测 ====================

async function probeEgressIP(page) {
    for (const url of IP_PROBE_URLS) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS });
            const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
            const ip = text.trim().split(/\s+/)[0] || '';
            if (IPV4_RE.test(ip)) return ip;
        } catch {
            // 尝试下一个探测接口
        }
    }
    return null;
}

/** 读取本轮的 canvas 指纹哈希和 WebGL 可用性，仅用于日志验证 */
async function readFingerprint(page) {
    try {
        return await page.evaluate(() => {
            const c = document.createElement('canvas');
            c.width = 300;
            c.height = 80;
            const ctx = c.getContext('2d');
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#f60';
            ctx.fillRect(125, 1, 62, 20);
            ctx.fillStyle = '#069';
            ctx.font = '11pt "Segoe UI"';
            ctx.fillText('Cwm fjordbank glyphs vext quiz, 😃', 2, 15);
            const data = c.toDataURL();
            let h = 0;
            for (let i = 0; i < data.length; i++) h = (Math.imul(31, h) + data.charCodeAt(i)) | 0;

            const glCanvas = document.createElement('canvas');
            const gl = glCanvas.getContext('webgl2') || glCanvas.getContext('webgl');
            return { fp: h, gl: gl ? 1 : 0 };
        });
    } catch {
        return { fp: null, gl: null };
    }
}

async function probeCandidate(browser, ep) {
    const key = endpointKey(ep);
    let ctx = null;
    try {
        ctx = await createProxyContext(browser, key);
        activeContexts.add(ctx);

        const page = await ctx.newPage();
        await page.setCacheEnabled(false).catch(() => {});

        const ip = await probeEgressIP(page);
        return { key, ctx, page, ip };
    } catch (e) {
        if (ctx) {
            activeContexts.delete(ctx);
            await ctx.close().catch(() => {});
        }
        return { key, ctx: null, page: null, ip: null, error: e.message };
    }
}

async function closeCandidate(c) {
    if (c && c.ctx) {
        activeContexts.delete(c.ctx);
        await c.ctx.close().catch(() => {});
    }
}

/**
 * 在尝试上限内找到一个出口 IP 未被本进程使用过的上下文。
 * 并行的候选会保留第一个命中者，其余关闭；碰撞端点冷却后重试。
 * 找不到则返回 null（调用方跳过本轮）。
 */
async function acquireUniqueProxy(browser, region) {
    const tried = new Set();
    let attempts = 0;

    while (attempts < MAX_PROXY_ATTEMPTS && !stopping) {
        const batch = pickCandidateEndpoints(
            region, Math.min(PROBE_CONCURRENCY, MAX_PROXY_ATTEMPTS - attempts), tried);
        if (batch.length === 0) return null;

        attempts += batch.length;
        for (const ep of batch) tried.add(endpointKey(ep));

        const results = await Promise.all(batch.map(ep => probeCandidate(browser, ep)));

        if (stopping) {
            await Promise.all(results.map(closeCandidate));
            return null;
        }

        let winner = null;
        for (const r of results) {
            if (!r) continue;
            if (!r.ip) {
                proxyCooldown.set(r.key, Date.now() + PROBE_ERROR_COOLDOWN_MS);
                await closeCandidate(r);
                continue;
            }
            if (usedIPs.has(r.ip)) {
                proxyCooldown.set(r.key, Date.now() + PROXY_COOLDOWN_MS);
                await closeCandidate(r);
                continue;
            }
            if (!winner) {
                winner = r;
                usedIPs.add(r.ip);
            } else {
                await closeCandidate(r);
            }
        }

        if (winner) {
            tslog(`   🌍 出口 IP: ${winner.ip} | 端点 ${winner.key}`);
            return winner;
        }
        tslog(`   🔁 本批 ${batch.length} 个端点均不可用或出口 IP 重复，继续尝试`);
    }

    return null;
}

// ==================== 统计 ====================

const shiftStats = new Map();

function finishRound(shift, skipped, seed = null) {
    let s = shiftStats.get(shift.name);
    if (!s) {
        s = { rounds: 0, skipped: 0, lastSeed: null };
        shiftStats.set(shift.name, s);
    }
    s.rounds++;
    if (skipped) s.skipped++;
    if (seed != null) s.lastSeed = seed;

    if (s.rounds % STATS_LOG_EVERY === 0) {
        tslog(`📊 [${tag(shift)}] 完成 ${s.rounds} 轮 | 跳过 ${s.skipped} 轮 | ` +
            `全局唯一 IP ${usedIPs.size} 个 | 冷却端点 ${proxyCooldown.size} 个 | ` +
            `最近 seed ${s.lastSeed ?? '-'}`);
    }
}

// ==================== 调度 ====================

function formatDay({ year, month, day }) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 队列为空时生成下一个本地日历日的访问时刻（只保留未来时刻） */
function ensureQueue(state, shift, now) {
    while (state.events.length === 0 && !stopping) {
        state.day = state.day ? nextDay(state.day) : tzDayKey(now, shift.tz);
        state.events = buildDayEvents(
            state.day.year, state.day.month, state.day.day,
            shift.visitsPerDay, shift.weights, shift.tz,
        ).filter(t => t > now);
        tslog(`📅 [${tag(shift)}] 链接 #${state.index + 1} · ${formatDay(state.day)} ` +
            `计划 ${state.events.length} 次访问`);
    }
}

/** 分段休眠，期间响应停止信号 */
async function sleepInterruptible(ms) {
    let remaining = ms;
    while (remaining > 0 && !stopping) {
        const chunk = Math.min(remaining, SCHEDULE_SLEEP_CHUNK_MS);
        await sleep(chunk);
        remaining -= chunk;
    }
}

/** 执行一次访问：新出口 IP → 本地空页 → 点击目标链接 → 真实停留（浏览器由调用方启动） */
async function visitWithSlot(state, shift, slot, params) {
    const { entry } = state;
    const linkNo = state.index + 1;
    const t = tag(shift);
    const socialUrl = shift.socials[Math.floor(Math.random() * shift.socials.length)];
    const socialHost = hostnameOf(socialUrl);
    let ctx = null;
    let skipped = false;

    try {
        const picked = await acquireUniqueProxy(slot.browser, shift.region);
        if (!picked) {
            tslog(`⏭️ [${t}] 链接 #${linkNo} 跳过本次访问：未获取到未使用过的出口 IP`);
            skipped = true;
            return;
        }

        const { key, page, ip } = picked;
        ctx = picked.ctx;

        tslog(`🔵 [${t}] 链接 #${linkNo} 开始访问 → ${entry.url}`);
        tslog(`   社媒入口: ${socialUrl} | 端点 ${key} | 出口 IP ${ip} | seed ${slot.seed}`);

        const fpInfo = await readFingerprint(page);

        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

        setupRequestHandler(page, socialHost, shift.targetHosts, entry.url);

        await page.goto(socialUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

        const clicked = await clickTargetLink(page);

        if (clicked && !stopping) {
            tslog(`   ⏳ [${t}] 目标页停留 ${params.afterClickSec} 秒`);
            await sleep(params.afterClickSec * 1000);
        }

        tslog(`✅ [${t}] 链接 #${linkNo} 本次访问结束`);
        console.log(`ROUND_SUMMARY shift=${shift.name} link=${linkNo} url=${entry.url} social=${socialUrl} ` +
            `proxy=${key} ip=${ip} seed=${slot.seed} fp=${fpInfo.fp} gl=${fpInfo.gl} ` +
            `click=${clicked ? 1 : 0}`);
    } catch (e) {
        tslog(`❌ [${t}] 链接 #${linkNo} 访问异常: ${e.message}`);
    } finally {
        if (ctx) {
            activeContexts.delete(ctx);
            await ctx.close().catch(() => {});
        }
        finishRound(shift, skipped, slot.seed);
    }
}

/**
 * 每条链接一个独立循环：等到本链接下一个访问时刻，
 * 在访问前 PREWARM_LEAD_MS 获取并发槽位并启动浏览器，到点执行访问。
 */
async function runLinkLoop(link, shift, params) {
    const state = { index: link.index, entry: { url: link.url }, events: [], day: null };

    while (!stopping) {
        ensureQueue(state, shift, Date.now());
        if (stopping) break;

        const eventTime = state.events[0];
        if (eventTime === undefined) continue;

        const beforeLead = eventTime - PREWARM_LEAD_MS - Date.now();
        if (beforeLead > 0) {
            await sleepInterruptible(beforeLead);
            if (stopping) break;
        }

        try {
            await ensureProxyList(shift.region);
        } catch (e) {
            tslog(`⚠️ [${tag(shift)}] 链接 #${state.index + 1} 获取代理列表失败: ` +
                `${e.message}，跳过本次访问`);
            state.events.shift();
            finishRound(shift, true);
            continue;
        }

        if (!await acquireSlot()) break;

        let slot = null;
        let visited = false;
        try {
            slot = await launchFreshBrowser(shift);
            activeSlots.add(slot);

            const remaining = eventTime - Date.now();
            if (remaining > 0) {
                await sleepInterruptible(remaining);
                if (stopping) break;
            }
            state.events.shift();
            visited = true;
            await visitWithSlot(state, shift, slot, params);
        } catch (e) {
            tslog(`❌ [${tag(shift)}] 链接 #${state.index + 1} 本轮异常: ${e.message}`);
            if (!visited) {
                if (state.events[0] === eventTime) state.events.shift();
                finishRound(shift, true);
            }
        } finally {
            if (slot) {
                activeSlots.delete(slot);
                await closeSlot(slot);
            }
            releaseSlot();
        }
    }
}

/** 关闭计划时的连续访问：每条链接一个循环，无额外等待，仍受并发上限约束 */
async function runLinkRoundRobin(link, shift, params) {
    const state = { index: link.index, entry: { url: link.url }, events: [], day: null };

    while (!stopping) {
        try {
            await ensureProxyList(shift.region);
        } catch (e) {
            tslog(`⚠️ [${tag(shift)}] 链接 #${state.index + 1} 获取代理列表失败: ${e.message}`);
            await sleep(1000);
            continue;
        }

        if (!await acquireSlot()) break;

        let slot = null;
        let visited = false;
        try {
            slot = await launchFreshBrowser(shift);
            activeSlots.add(slot);
            visited = true;
            await visitWithSlot(state, shift, slot, params);
        } catch (e) {
            tslog(`❌ [${tag(shift)}] 链接 #${state.index + 1} 本轮异常: ${e.message}`);
            if (!visited) finishRound(shift, true);
        } finally {
            if (slot) {
                activeSlots.delete(slot);
                await closeSlot(slot);
            }
            releaseSlot();
        }
    }
}

// ==================== 班次 ====================

function makeShift(name, region, tz, locale, weights, links, socials, visitsPerDay) {
    return {
        name, region, tz, locale, weights, socials, visitsPerDay,
        links: links.map((url, index) => ({ url, index })),
        targetHosts: [...new Set(links.map(hostnameOf).filter(Boolean))],
    };
}

// ==================== 主流程 ====================

async function run() {
    const params = parseArgs();
    const groups = loadUrlGroups(params.urlsFile);
    if (groups.us.length === 0) {
        throw new Error('美国班目标链接为空（visit-links.json 的 us 数组）');
    }

    const socialsUs = loadUrlList(params.socialFile, '社媒入口(US)');
    const socialsJp = groups.jp.length > 0
        ? loadUrlList(params.socialJpFile, '社媒入口(JP)')
        : [];

    headlessFlag = params.headless;
    slotPool.limit = params.maxConcurrency;

    const shifts = [makeShift(
        'us', 'US', 'America/New_York', 'en-US',
        US_HOURLY_WEIGHTS, groups.us, socialsUs, params.visitsPerDayUs,
    )];
    if (groups.jp.length === 0) {
        console.log('⚠️  日本班链接为空（visit-links.json 的 jp 数组），本次只运行美国班');
    } else {
        shifts.push(makeShift(
            'jp', 'JP', 'Asia/Tokyo', 'ja-JP',
            JP_HOURLY_WEIGHTS, groups.jp, socialsJp, params.visitsPerDayJp,
        ));
    }

    console.log('🚀 启动 CloakBrowser (adsterras 双班社媒点击访问器)...');
    for (const s of shifts) {
        console.log(`📋 [${tag(s)}] 目标链接 ${s.links.length} 条 | 代理 region=${s.region} | ` +
            `时区 ${s.tz} | 语言 ${s.locale} | 日均 ${s.visitsPerDay}/链接`);
    }
    console.log(`📋 链接文件: ${params.urlsFile}`);
    console.log(`📋 社媒入口(US): ${socialsUs.length} 条 | 文件: ${params.socialFile}`);
    if (shifts.length > 1) {
        console.log(`📋 社媒入口(JP): ${socialsJp.length} 条 | 文件: ${params.socialJpFile}`);
    }
    console.log(`🔀 访问计划: ${SCHEDULE_ENABLED
        ? '开启（每条链接按本班本地作息独立排程）'
        : '关闭（每条链接连续访问，忽略日均计划）'}`);
    console.log(`⏱️  点击延迟: ${CLICK_DELAY_MIN_MS / 1000}-${CLICK_DELAY_MAX_MS / 1000} 秒 | ` +
        `点击后停留: ${params.afterClickSec.toFixed(0)} 秒 | 点击率: 100%`);
    console.log(`🌍 出口策略: 每轮全新浏览器（独立 seed）+ 隐私上下文 + 出口 IP 去重`);
    console.log(`🖥️  模式: ${params.headless ? '无头' : '有窗口'} | 并发上限: ${slotPool.limit} 个浏览器`);
    console.log(`📡 代理来源: NovProxy API（按区域缓存，每 ${PROXY_LIST_REFRESH_MS / 60000} 分钟刷新）`);
    console.log(`🔥 预热: 各链接访问时刻前 ${PREWARM_LEAD_MS / 1000} 秒启动浏览器\n`);

    const init = await Promise.allSettled(shifts.map(s => ensureProxyList(s.region, true)));
    init.forEach((r, i) => {
        if (r.status === 'rejected') {
            tslog(`⚠️  [${tag(shifts[i])}] 代理列表初始化失败: ${r.reason?.message || r.reason}`);
        }
    });

    if (SCHEDULE_ENABLED) {
        await Promise.all(shifts.flatMap(s => s.links.map(link => runLinkLoop(link, s, params))));
    } else {
        await Promise.all(shifts.flatMap(s => s.links.map(link => runLinkRoundRobin(link, s, params))));
    }

    tslog('🏁 已停止，正在收尾...');
}

async function cleanup() {
    stopping = true;
    for (const c of activeContexts) {
        await c.close().catch(() => {});
    }
    activeContexts.clear();
    for (const slot of activeSlots) {
        await closeSlot(slot);
    }
    activeSlots.clear();
}

process.on('SIGINT', () => {
    tslog('👋 收到退出信号，正在关闭浏览器...');
    Promise.race([cleanup(), sleep(5000)]).finally(() => process.exit(0));
});

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    run()
        .then(() => cleanup())
        .then(() => process.exit(0))
        .catch(async (error) => {
            console.error('❌ 未捕获的错误:', error);
            await cleanup();
            process.exit(1);
        });
}