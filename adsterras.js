/**
 * visit-link.js — 随机访问美国社媒入口，返回本地空页面并点击配置的目标链接
 *
 * 用法:
 *   node visit-link.js [--urls=./visit-links.json] [--social=./social-urls.json]
 *     [--visits-per-day=300] [--after-click-sec=10] [--headless]
 *
 * 每个目标链接独立排程：日访问量服从泊松分布，按美国东部时间作息加权。
 * 每次访问随机取一个社媒入口，主文档请求被本地空页面替代；空页面里只有
 * 一个指向目标链接的可见链接，脚本用鼠标点击后经 SOCKS5 真实打开目标站点，
 * 停留指定秒数后关闭。
 */

import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import UserAgent from 'user-agents';
import { fetchNovProxy } from './shared/proxy-utils.js';
import { startTargetPac, matchesHost } from './shared/target-pac.js';
import { etDayKey, nextDay, buildDayEvents } from './shared/visit-schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = false;

const NAV_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const CLICK_DELAY_MIN_MS = 0;
const CLICK_DELAY_MAX_MS = 0;
const AFTER_CLICK_SEC = 1;
const VISITS_PER_DAY = 150;
const SCHEDULE_SLEEP_CHUNK_MS = 30000;
// 访问计划开关：true 按美国东部作息计划访问，false 多链接轮流连续访问（改后重启生效）
const SCHEDULE_ENABLED = true;

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

// ==================== 随机 UA ====================

function randomWindowsUA() {
    try {
        return new UserAgent({ platform: 'Win32' }).toString();
    } catch {
        return null;
    }
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
 * 目标链接域名（含子域名）的请求全部放行（经 PAC 走 SOCKS5）；
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

// ==================== 无痕上下文 ====================

async function createFreshContext(browser) {
    if (typeof browser.createBrowserContext === 'function') {
        return browser.createBrowserContext();
    }
    if (typeof browser.createIncognitoBrowserContext === 'function') {
        return browser.createIncognitoBrowserContext();
    }
    throw new Error('当前浏览器不支持创建无痕上下文');
}

// ==================== 浏览器 ====================

let browser = null;
let pacRef = null;
let headlessFlag = isLinux;
let targetHosts = [];
const activeContexts = new Set();
let stopping = false;

async function launchBrowser(pacUrl) {
    const b = await launch({
        headless: headlessFlag,
        humanize: true,
        timezone: 'America/New_York',
        locale: 'en-US',
        viewport: { width: 1360, height: 768 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            `--proxy-pac-url=${pacUrl}`,
        ],
    });
    browser = b;
    tslog('🧩 浏览器已就绪');
    return b;
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

/** 执行一次访问：随机社媒入口 → 本地空页 → 点击目标链接 → 真实停留 */
async function visitOnce(state, params) {
    const { entry } = state;
    const linkNo = state.index + 1;
    const socialUrl = params.socialUrls[Math.floor(Math.random() * params.socialUrls.length)];
    const socialHost = hostnameOf(socialUrl);

    let proxy;
    try {
        proxy = await fetchNovProxy();
    } catch (e) {
        tslog(`⚠️  链接 #${linkNo} 获取代理失败: ${e.message}，跳过本次访问`);
        return;
    }

    const ua = randomWindowsUA();
    const uaTag = ua ? ` | UA=${ua.split(') ').pop()}` : '';
    tslog(`🔵 链接 #${linkNo} 开始访问 → ${entry.url}`);
    tslog(`   社媒入口: ${socialUrl} | 代理 ${proxy.host}:${proxy.port}${uaTag}`);

    let context = null;
    try {
        browser = await launchBrowser(pacRef.pacUrlFor(proxy));

        context = await createFreshContext(browser);
        activeContexts.add(context);

        const page = await context.newPage();

        if (ua) await page.setUserAgent(ua).catch(() => {});
        await page.setCacheEnabled(false).catch(() => {});
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
        await page.setViewport({ width: 1366, height: 768 }).catch(() => {});

        setupRequestHandler(page, socialHost, targetHosts, entry.url);

        await page.goto(socialUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

        const clicked = await clickTargetLink(page, params);

        if (clicked && !stopping) {
            tslog(`   ⏳ 目标页停留 ${params.afterClickSec} 秒`);
            await sleep(params.afterClickSec * 1000);
        }

        tslog(`✅ 链接 #${linkNo} 本次访问结束`);
        console.log(`ROUND_SUMMARY link=${linkNo} url=${entry.url} social=${socialUrl} proxy=${proxy.host}:${proxy.port} click=${clicked ? 1 : 0}`);
    } catch (e) {
        tslog(`❌ 链接 #${linkNo} 访问异常: ${e.message}`);
    } finally {
        if (context) {
            activeContexts.delete(context);
            await context.close().catch(() => {});
        }
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
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
            await sleepInterruptible(wait);
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

    console.log('🚀 启动 CloakBrowser (visit-link 访问器)...');
    console.log(`📋 目标链接: ${entries.length} 条 | 文件: ${params.urlsFile}`);
    console.log(`📋 社媒入口: ${socialUrls.length} 条 | 文件: ${params.socialFile}`);
    console.log(`🔀 访问计划: ${SCHEDULE_ENABLED ? `开启（美国东部作息，每链接日均 ${params.visitsPerDay} 次）` : '关闭（多链接轮流连续访问，忽略日均计划）'}`);
    console.log(`⏱️  点击延迟: ${CLICK_DELAY_MIN_MS / 1000}-${CLICK_DELAY_MAX_MS / 1000} 秒 | 点击后停留: ${params.afterClickSec.toFixed(0)} 秒 | 点击率: 100%`);
    console.log(`🖥️  模式: ${params.headless ? '无头' : '有窗口'}`);
    console.log(`📡 代理来源: NovProxy API（每次访问启动浏览器前获取，仅目标域名经 SOCKS5，其余中止）\n`);

    pacRef = await startTargetPac(targetHosts);

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
    if (browser) await browser.close().catch(() => {});
    browser = null;
    if (pacRef) {
        pacRef.close();
        pacRef = null;
    }
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