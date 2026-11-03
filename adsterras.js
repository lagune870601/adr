/**
 * adsterras.js — 随机访问美国社媒入口，返回本地空页面并点击配置的目标链接
 *
 * 用法:
 *   node adsterras.js [--urls=./visit-links.json] [--social=./social-urls.json]
 *     [--visits-per-day=150] [--after-click-sec=2] [--headless]
 *
 * 每个目标链接独立排程：日访问量服从泊松分布，按美国东部时间作息加权。
 * 每轮访问使用全新的浏览器进程（随机 --fingerprint seed），保证轮与轮之间
 * 指纹不可关联；轮内新建隐私上下文，并通过 createBrowserContext({ proxyServer })
 * 为该上下文指定代理。访问前先用轻量 IP 接口确认出口 IP：若本次进程已使用过
 * 则更换端点重试；达到尝试上限仍找不到未使用过的出口 IP 时，跳过本轮访问。
 * 下一轮浏览器在访问时刻前预热，启动开销落在轮间空档里。
 */

import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchNovProxyList } from './shared/proxy-utils.js';
import { matchesHost } from './shared/target-pac.js';
import { etDayKey, nextDay, buildDayEvents } from './shared/visit-schedule.js';

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
// 访问计划开关：true 按美国东部作息计划访问，false 多链接轮流连续访问（改后重启生效）
const SCHEDULE_ENABLED = true;

// ==================== 代理与出口 IP ====================

const PROXY_API_URL = 'https://white.novproxy.com/white/api?region=US&num=1000&time=1&format=1&type=txt';
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
// 下一轮浏览器在访问时刻前多少毫秒启动（启动实测约 2 秒）
const PREWARM_LEAD_MS = 15000;

// ==================== 日志 ====================

function tslog(msg) {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${t}] ${msg}`);
}

// ==================== 命令行参数 ====================

function parseArgs() {
    const args = process.argv.slice(2);

    const envAfterClick = parseFloat(process.env.AFTER_CLICK_SEC);
    const envVisits = parseInt(process.env.VISITS_PER_DAY, 10);

    const params = {
        urlsFile: path.join(__dirname, 'visit-links.json'),
        socialFile: path.join(__dirname, 'social-urls.json'),
        afterClickSec: Number.isFinite(envAfterClick) && envAfterClick >= 0 ? envAfterClick : AFTER_CLICK_SEC,
        visitsPerDay: Number.isInteger(envVisits) && envVisits > 0 ? envVisits : VISITS_PER_DAY,
        headless: isLinux,
    };

    for (const arg of args) {
        if (arg.startsWith('--urls=')) {
            params.urlsFile = arg.slice('--urls='.length);
        } else if (arg.startsWith('--social=')) {
            params.socialFile = arg.slice('--social='.length);
        } else if (arg.startsWith('--after-click-sec=')) {
            const v = parseFloat(arg.slice('--after-click-sec='.length));
            if (Number.isFinite(v) && v >= 0) params.afterClickSec = v;
        } else if (arg.startsWith('--visits-per-day=')) {
            const v = parseInt(arg.slice('--visits-per-day='.length), 10);
            if (Number.isInteger(v) && v > 0) params.visitsPerDay = v;
        } else if (arg === '--headless') {
            params.headless = true;
        }
    }

    return params;
}

// ==================== 数据列表 ====================

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
    return arr.map((item, i) => {
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
    });
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
 * 目标链接域名（含子域名）的请求全部放行（经该上下文的代理）；
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

async function clickTargetLink(page, params) {
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
let targetHosts = [];
const activeContexts = new Set();
let stopping = false;

let prewarmedSlot = null;
let prewarmPromise = null;
let activeSlot = null;

let proxyEndpoints = [];
let proxyListFetchedAt = 0;
const usedIPs = new Set();
const proxyCooldown = new Map();
const stats = { rounds: 0, skipped: 0, lastSeed: null };

function endpointKey(ep) {
    return `${ep.host}:${ep.port}`;
}

/**
 * 启动一个全新的浏览器进程。每次启动随机生成指纹 seed，
 * 该 seed 决定 canvas / WebGL / audio / GPU / 硬件参数等一整组指纹。
 */
async function launchFreshBrowser() {
    const seed = 10000 + Math.floor(Math.random() * 90000);
    const b = await launch({
        headless: headlessFlag,
        humanize: true,
        timezone: 'America/New_York',
        locale: 'en-US',
        args: [...BASE_ARGS, `--fingerprint=${seed}`],
    });
    tslog(`🧩 浏览器已启动（seed=${seed}，本轮独立指纹）`);
    return { browser: b, seed };
}

async function closeSlot(slot) {
    if (slot && slot.browser) {
        await slot.browser.close().catch(() => {});
    }
}

/** 在下一访问时刻前启动下一轮浏览器，把启动耗时藏在轮间空档 */
function startPrewarm() {
    if (stopping || prewarmedSlot || prewarmPromise) return;
    prewarmPromise = launchFreshBrowser()
        .then(async (slot) => {
            if (stopping) {
                await closeSlot(slot);
                return;
            }
            prewarmedSlot = slot;
        })
        .catch((e) => {
            tslog(`⚠️  预启动浏览器失败: ${e.message}`);
        })
        .finally(() => {
            prewarmPromise = null;
        });
}

/** 取本轮浏览器：优先使用预热好的，否则现场启动 */
async function takeBrowser() {
    if (prewarmPromise) await prewarmPromise.catch(() => {});
    const slot = prewarmedSlot;
    prewarmedSlot = null;

    if (slot) {
        if (slot.browser.isConnected()) return slot;
        await closeSlot(slot);
    }
    return launchFreshBrowser();
}

async function closePrewarmed() {
    if (prewarmPromise) await prewarmPromise.catch(() => {});
    const slot = prewarmedSlot;
    prewarmedSlot = null;
    if (slot) await closeSlot(slot);
}

async function createProxyContext(browser, proxyKey) {
    if (typeof browser.createBrowserContext !== 'function') {
        throw new Error('当前浏览器不支持 createBrowserContext');
    }
    return browser.createBrowserContext({ proxyServer: `socks5://${proxyKey}` });
}

// ==================== 代理列表 ====================

async function ensureProxyList(force = false) {
    if (!force && proxyEndpoints.length > 0 &&
        Date.now() - proxyListFetchedAt < PROXY_LIST_REFRESH_MS) {
        return;
    }
    try {
        const list = await fetchNovProxyList(PROXY_API_URL);
        proxyEndpoints = list;
        proxyListFetchedAt = Date.now();
        tslog(`📡 代理列表已缓存: ${list.length} 个端点`);
    } catch (e) {
        if (proxyEndpoints.length === 0) throw e;
        tslog(`⚠️  代理列表刷新失败，继续使用旧列表: ${e.message}`);
    }
}

function pickCandidateEndpoints(count, tried) {
    const now = Date.now();
    const pool = proxyEndpoints.filter(ep => {
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
async function acquireUniqueProxy(browser) {
    const tried = new Set();
    let attempts = 0;

    while (attempts < MAX_PROXY_ATTEMPTS && !stopping) {
        const batch = pickCandidateEndpoints(
            Math.min(PROBE_CONCURRENCY, MAX_PROXY_ATTEMPTS - attempts), tried);
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

// ==================== 调度循环 ====================

function formatDay({ year, month, day }) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 队列为空时生成下一个美国东部日历日的访问时刻（只保留未来时刻） */
function ensureQueue(state, params, now) {
    while (state.events.length === 0) {
        state.day = state.day ? nextDay(state.day) : etDayKey(now);
        state.events = buildDayEvents(state.day.year, state.day.month, state.day.day, params.visitsPerDay)
            .filter(t => t > now);
        tslog(`📅 链接 #${state.index + 1} · ${formatDay(state.day)} 计划 ${state.events.length} 次访问`);
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

function finishRound(skipped) {
    stats.rounds++;
    if (skipped) stats.skipped++;
    if (stats.rounds % STATS_LOG_EVERY === 0) {
        tslog(`📊 统计: 完成 ${stats.rounds} 轮 | 跳过 ${stats.skipped} 轮 | ` +
            `已用唯一 IP ${usedIPs.size} 个 | 冷却端点 ${proxyCooldown.size} 个 | ` +
            `最近 seed ${stats.lastSeed ?? '-'}`);
    }
}

/** 执行一次访问：新浏览器 → 新出口 IP → 本地空页 → 点击目标链接 → 真实停留 */
async function visitOnce(state, params) {
    const { entry } = state;
    const linkNo = state.index + 1;
    const socialUrl = params.socialUrls[Math.floor(Math.random() * params.socialUrls.length)];
    const socialHost = hostnameOf(socialUrl);

    try {
        await ensureProxyList();
    } catch (e) {
        tslog(`⚠️  链接 #${linkNo} 获取代理列表失败: ${e.message}，跳过本次访问`);
        finishRound(true);
        return;
    }

    let slot;
    try {
        slot = await takeBrowser();
    } catch (e) {
        tslog(`⚠️  链接 #${linkNo} 启动浏览器失败: ${e.message}，跳过本次访问`);
        finishRound(true);
        return;
    }
    activeSlot = slot;
    stats.lastSeed = slot.seed;

    const picked = await acquireUniqueProxy(slot.browser);
    if (!picked) {
        tslog(`⏭️ 链接 #${linkNo} 跳过本次访问：未获取到未使用过的出口 IP`);
        activeSlot = null;
        await closeSlot(slot);
        finishRound(true);
        return;
    }

    const { key, ctx, page, ip } = picked;
    tslog(`🔵 链接 #${linkNo} 开始访问 → ${entry.url}`);
    tslog(`   社媒入口: ${socialUrl} | 端点 ${key} | 出口 IP ${ip} | seed ${slot.seed}`);

    try {
        const fpInfo = await readFingerprint(page);

        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

        setupRequestHandler(page, socialHost, targetHosts, entry.url);

        await page.goto(socialUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

        const clicked = await clickTargetLink(page, params);

        if (clicked && !stopping) {
            tslog(`   ⏳ 目标页停留 ${params.afterClickSec} 秒`);
            await sleep(params.afterClickSec * 1000);
        }

        tslog(`✅ 链接 #${linkNo} 本次访问结束`);
        console.log(`ROUND_SUMMARY link=${linkNo} url=${entry.url} social=${socialUrl} ` +
            `proxy=${key} ip=${ip} seed=${slot.seed} fp=${fpInfo.fp} gl=${fpInfo.gl} ` +
            `click=${clicked ? 1 : 0}`);
    } catch (e) {
        tslog(`❌ 链接 #${linkNo} 访问异常: ${e.message}`);
    } finally {
        activeContexts.delete(ctx);
        await ctx.close().catch(() => {});
        activeSlot = null;
        await closeSlot(slot);
        finishRound(false);
    }
}

/** 每个链接独立排程，每次取最早到期的访问执行 */
async function scheduleLoop(entries, params) {
    const states = entries.map((entry, index) => ({ index, entry, events: [], day: null }));

    while (!stopping) {
        const now = Date.now();
        for (const s of states) ensureQueue(s, params, now);

        states.sort((a, b) => a.events[0] - b.events[0]);
        const next = states[0];
        const wait = next.events[0] - Date.now();

        if (wait > 0) {
            if (wait > PREWARM_LEAD_MS) {
                await sleepInterruptible(wait - PREWARM_LEAD_MS);
                if (stopping) break;
            }
            startPrewarm();
            const remaining = next.events[0] - Date.now();
            if (remaining > 0) await sleepInterruptible(remaining);
            continue;
        }

        next.events.shift();
        await visitOnce(next, params);
    }
}

/** 关闭计划时的直接轮询：按 1→2→…→N 顺序连续访问，无额外等待 */
async function roundRobinLoop(entries, params) {
    const states = entries.map((entry, index) => ({ index, entry }));
    let cursor = 0;

    while (!stopping) {
        const state = states[cursor];
        cursor = (cursor + 1) % states.length;
        await visitOnce(state, params);
    }
}

// ==================== 主流程 ====================

async function run() {
    const params = parseArgs();
    const targets = loadUrlList(params.urlsFile, '目标链接');
    const socialUrls = loadUrlList(params.socialFile, '社媒入口');
    const entries = targets.map(url => ({ url }));
    params.socialUrls = socialUrls;
    headlessFlag = params.headless;
    targetHosts = [...new Set(targets.map(hostnameOf).filter(Boolean))];

    console.log('🚀 启动 CloakBrowser (adsterras 社媒点击访问器)...');
    console.log(`📋 目标链接: ${entries.length} 条 | 文件: ${params.urlsFile}`);
    console.log(`📋 社媒入口: ${socialUrls.length} 条 | 文件: ${params.socialFile}`);
    console.log(`🔀 访问计划: ${SCHEDULE_ENABLED ? `开启（美国东部作息，每链接日均 ${params.visitsPerDay} 次）` : '关闭（多链接轮流连续访问，忽略日均计划）'}`);
    console.log(`⏱️  点击延迟: ${CLICK_DELAY_MIN_MS / 1000}-${CLICK_DELAY_MAX_MS / 1000} 秒 | 点击后停留: ${params.afterClickSec.toFixed(0)} 秒 | 点击率: 100%`);
    console.log('🌍 出口策略: 每轮全新浏览器（独立 seed）+ 隐私上下文 + 出口 IP 去重（重复则跳过本次访问）');
    console.log(`🖥️  模式: ${params.headless ? '无头' : '有窗口'}`);
    console.log(`📡 代理来源: NovProxy API（启动缓存端点，每 ${PROXY_LIST_REFRESH_MS / 60000} 分钟刷新）`);
    console.log(`🔥 预热: 访问时刻前 ${PREWARM_LEAD_MS / 1000} 秒启动下一轮浏览器\n`);

    await ensureProxyList(true);

    if (SCHEDULE_ENABLED) {
        await scheduleLoop(entries, params);
    } else {
        await roundRobinLoop(entries, params);
    }

    tslog('🏁 已停止，正在收尾...');
}

async function cleanup() {
    stopping = true;
    for (const c of activeContexts) {
        await c.close().catch(() => {});
    }
    activeContexts.clear();
    if (activeSlot) {
        const slot = activeSlot;
        activeSlot = null;
        await closeSlot(slot);
    }
    await closePrewarmed();
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