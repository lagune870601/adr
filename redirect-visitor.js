/**
 * redirect-visitor.js — 无限循环访问地址列表中的页面
 *
 * 特性:
 *   1. 复用 open-account.js 的代理（shared/proxy-utils.js 的 createProxy）
 *   2. 省流量模式：不加载 image / stylesheet / font / media 等资源
 *   3. 每轮全新无痕上下文（零缓存、零 cookie）
 *   4. 从 urls.json 随机取址，且不与上一轮重复
 *   5. 从访问开始计时，停留 4~6 分钟（随机）后关闭浏览器上下文
 *   6. 打印每次重定向跳转地址
 *   7. 自动完成概率出现的"Prove you are not a robot"表单
 *
 * 用法:
 *   node redirect-visitor.js
 *     --urls=./urls.json     地址列表文件（默认 ./urls.json）
 *     --dwell-sec=<n>        单轮停留秒数（默认 240~360 随机）
 *     --rounds=<n>           循环轮数（默认 0 = 无限）
 *     --headless             强制无头模式
 */

import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProxy } from './shared/proxy-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// const isLinux = os.platform() === 'linux';
const isLinux = true;

// ==================== 配置常量 ====================

const BLOCKED_RESOURCE_TYPES = [
    'image',
    'stylesheet',
    'font',
    'media',
    'texttrack',
    'manifest',
    'script'
];

const NAV_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_REFRESH_RETRIES = 5;       // 出错时刷新当前页的最大重试次数
const FORM_POLL_INTERVAL_MS = 1000;  // 停留期间检测验证表单的轮询间隔
const MIN_POLL_MS = 3000;            // 导航耗时超过停留时长时，仍保留的最短检测窗口
const ROOT_CHECKBOX_SELECTOR = '#root input[type="checkbox"]';
const CHECKBOX_SELECTOR = 'input[type="checkbox"]';
const CONTINUE_SELECTOR = '#goBtn';

// ==================== 日志 ====================

function tslog(msg) {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${t}] ${msg}`);
}

// ==================== 命令行参数 ====================

function parseArgs() {
    const args = process.argv.slice(2);
    const params = {
        urlsFile: path.join(__dirname, 'urls.json'),
        dwellSec: null,
        rounds: 0,
        headless: isLinux,
    };

    for (const arg of args) {
        if (arg.startsWith('--urls=')) {
            params.urlsFile = arg.slice('--urls='.length);
        } else if (arg.startsWith('--dwell-sec=')) {
            params.dwellSec = parseFloat(arg.slice('--dwell-sec='.length));
        } else if (arg.startsWith('--rounds=')) {
            params.rounds = parseInt(arg.slice('--rounds='.length), 10);
        } else if (arg === '--headless') {
            params.headless = true;
        }
    }

    // 停留时长：默认 4~6 分钟随机
    if (params.dwellSec == null || !Number.isFinite(params.dwellSec) || params.dwellSec <= 0) {
        params.dwellSec = 240 + Math.random() * 120;
    }

    return params;
}

// ==================== 地址列表 ====================

function loadUrls(file) {
    if (!fs.existsSync(file)) {
        throw new Error(`地址列表文件不存在: ${file}`);
    }
    const raw = fs.readFileSync(file, 'utf-8');
    let arr;
    try {
        arr = JSON.parse(raw);
    } catch (e) {
        throw new Error(`地址列表文件不是合法 JSON: ${e.message}`);
    }
    if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error('地址列表必须是非空数组');
    }
    const urls = arr.map(u => String(u).trim()).filter(Boolean);
    if (urls.length === 0) {
        throw new Error('地址列表中没有有效地址');
    }
    return urls;
}

/**
 * 随机取址，且下标不与上一轮相同。
 * 列表只有 1 条时只能沿用。
 */
function pickUrl(urls, lastIndex) {
    if (urls.length === 1) {
        return { index: 0, url: urls[0] };
    }
    let idx;
    do {
        idx = Math.floor(Math.random() * urls.length);
    } while (idx === lastIndex);
    return { index: idx, url: urls[idx] };
}

// ==================== 省流量拦截 ====================

async function setupRequestBlocker(page) {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        if (BLOCKED_RESOURCE_TYPES.includes(request.resourceType())) {
            request.abort().catch(() => {});
        } else {
            request.continue().catch(() => {});
        }
    });
}

// ==================== 重定向日志 ====================

/**
 * 打印每一次重定向跳转地址。
 *
 * 关键点：HTTP 3xx 的每一跳都会重新发起一次 document 请求，
 * 但 framenavigated 只在最终文档提交时触发一次，会漏掉中间跳。
 * 因此监听主 frame 的 document 请求，才能拿到完整跳转链
 * （HTTP 3xx、JS location 跳转、meta refresh 都覆盖）。
 */
function attachRedirectLogger(page, roundState) {
    page.on('request', (req) => {
        if (req.resourceType() !== 'document') return;
        if (req.frame() !== page.mainFrame()) return;

        const u = req.url();
        if (!u || u === 'about:blank' || u.startsWith('chrome-error://')) return;

        roundState.hops += 1;
        // 第 1 个 document 请求即初始访问地址，已在"开始访问"行打印，避免重复
        if (roundState.hops === 1) return;

        roundState.redirects = roundState.hops - 1;
        tslog(`   ↪️  跳转 ${roundState.redirects} → ${u}`);
    });
}

/** 页面是否处于加载失败状态（错误页 / 空白页） */
function isErrorPage(page) {
    const u = page.url();
    return !u || u === 'about:blank' || u.startsWith('chrome-error://');
}

// ==================== 验证表单 ====================

export async function detectForm(page) {
    // 主判断：存在 #root 下的 checkbox（页面 JS 动态注入，随机 id）
    try {
        if (await page.$(ROOT_CHECKBOX_SELECTOR)) return true;
    } catch { /* 导航中，忽略 */ }

    // 兜底：出现"机器人验证"文案，且存在 checkbox 或 Continue 按钮
    try {
        return await page.evaluate(() => {
            const text = document.body?.innerText || '';
            const robot = /prove you are not a robot|not a robot|verify you are human/i.test(text);
            return robot && !!document.querySelector('input[type="checkbox"], #goBtn');
        });
    } catch {
        return false;
    }
}

/** 轮询等待 #countdown 出现"倒计时/已跳转"文案 */
async function waitCountdown(page, seconds) {
    for (let w = 0; w < seconds; w++) {
        await sleep(1000);
        const started = await page.evaluate(() => {
            const cd = document.querySelector('#countdown');
            return !!(cd && /redirect|passed/i.test(cd.textContent || ''));
        }).catch(() => false);
        if (started) return true;
    }
    return false;
}

/**
 * 表单交互。该验证页存在两种变体，脚本统一处理：
 *
 *   变体 A（无按钮）: 勾选 checkbox 后页面自身开始倒计时并跳转
 *   变体 B（有 #goBtn）: 勾选 checkbox → 点击 Continue 才开始倒计时跳转
 *
 * 变体 B 的页面 JS 有三重机器人判断，必须全部满足才会跳转：
 *   1. checkbox 处于勾选状态
 *   2. 点击按钮距页面加载需 >= 800ms
 *   3. 必须先有真实的 pointerdown（鼠标/触摸）交互
 * 因此所有点击都必须用真实鼠标事件（elementHandle.click / mouse.click），
 * 不能用 JS 程序化 click，否则 touched 标记不会置位。
 *
 * @returns {Promise<{checked: boolean, continued: boolean, redirected: boolean}>}
 */
export async function handleForm(page) {
    const result = { checked: false, continued: false, redirected: false };

    // ---- 1. 找到 checkbox（优先 #root 内，其次任意 checkbox；页面 JS 会动态注入，需等待）----
    let cb = null;
    for (let i = 0; i < 10 && !cb; i++) {
        cb = await page.$(ROOT_CHECKBOX_SELECTOR).catch(() => null)
            || await page.$(CHECKBOX_SELECTOR).catch(() => null);
        if (!cb) await sleep(500);
    }
    if (!cb) {
        tslog('   ⚠️  未找到 checkbox 元素');
        return result;
    }

    // ---- 2. 勾选 checkbox（真实鼠标点击，最多 3 次；先读状态避免重复点击取消勾选）----
    for (let i = 0; i < 3 && !result.checked; i++) {
        if (await cb.evaluate(el => el.checked).catch(() => false)) {
            result.checked = true;
            break;
        }
        try {
            await cb.click({ delay: 40 });
        } catch {
            const box = await cb.boundingBox().catch(() => null);
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
        await sleep(300);
        result.checked = await cb.evaluate(el => el.checked).catch(() => false);
    }
    tslog(`   ☑️  checkbox 勾选: ${result.checked ? '成功' : '失败'}`);
    if (!result.checked) return result;

    // ---- 3. 等过变体 B 的"加载后 800ms 内点击无效"防机器人判断 ----
    await sleep(1200);

    // ---- 4. 若存在 Continue 按钮则点击（变体 B）；变体 A 勾选后已自动开始倒计时 ----
    const hasButton = !!(await page.$(CONTINUE_SELECTOR).catch(() => null));
    if (hasButton) {
        for (let i = 0; i < 3 && !result.redirected; i++) {
            const btn = await page.$(CONTINUE_SELECTOR).catch(() => null);
            if (!btn) break;
            try {
                await btn.click({ delay: 40 });
            } catch {
                const box = await btn.boundingBox().catch(() => null);
                if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            }
            result.continued = true;
            if (await waitCountdown(page, 8)) { result.redirected = true; break; }
        }
    } else {
        // 变体 A：无按钮，勾选即触发
        result.continued = true;
        result.redirected = await waitCountdown(page, 8);
    }
    tslog(`   ▶️  Continue 点击: ${result.continued ? '成功' : '失败'}（倒计时/跳转 ${result.redirected ? '已启动' : '未启动'}）`);

    return result;
}

// ==================== 导航（出错刷新当前页重试）====================

async function tryLoad(page, navUrl) {
    await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // goto 成功不代表页面可用：错误页（如 chrome-error://chromewebdata/）也会正常返回
    if (isErrorPage(page)) {
        throw new Error(`页面加载失败 (${page.url()})`);
    }
}

async function tryReload(page) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    if (isErrorPage(page)) {
        throw new Error(`刷新后仍是错误页 (${page.url()})`);
    }
}

/**
 * 访问地址；出错时优先刷新当前页（问题可能出在重定向后的页面），
 * 当前页已是错误/空白页则重新访问初始地址。最多尝试 MAX_REFRESH_RETRIES 次。
 * @returns {Promise<boolean>} 是否最终加载成功
 */
async function navigateWithRetry(page, url) {
    for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
        try {
            if (attempt === 0) {
                await tryLoad(page, url);
            } else {
                const cur = page.url();
                const recoverable = cur && cur !== 'about:blank' && !cur.startsWith('chrome-error://');
                if (recoverable) {
                    tslog(`   🔁 加载失败，刷新当前页 第 ${attempt} 次`);
                    await tryReload(page);
                } else {
                    tslog(`   🔁 加载失败，重新访问初始地址 第 ${attempt} 次`);
                    await tryLoad(page, url);
                }
            }
            return true;
        } catch (e) {
            if (attempt === MAX_REFRESH_RETRIES) {
                tslog(`   ❌ 重试 ${MAX_REFRESH_RETRIES} 次仍失败: ${e.message.slice(0, 60)}`);
                return false;
            }
            await sleep(1000);
        }
    }
    return false;
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

// ==================== 主流程 ====================

let browser = null;
let proxyManager = null;
const activeContexts = new Set();
let stopping = false;

async function run() {
    const params = parseArgs();
    const urls = loadUrls(params.urlsFile);

    console.log('🚀 启动 CloakBrowser (redirect 访问器)...');
    console.log(`📋 地址列表: ${urls.length} 条 | 文件: ${params.urlsFile}`);
    console.log(`⏱️  单轮停留: ${params.dwellSec.toFixed(0)} 秒`);
    console.log(`🔁 循环轮数: ${params.rounds === 0 ? '无限' : params.rounds}`);
    console.log(`🖥️  模式: ${params.headless ? '无头' : '有窗口'}\n`);

    // 代理（与 open-account.js 一致）
    const { proxy, manager } = await createProxy({ country: 'US', protocol: 'http' });
    proxyManager = manager;
    console.log(`📡 代理地址: ${proxy.host}:${proxy.port}\n`);

    // 浏览器只启动一次，后续每轮复用
    browser = await launch({
        headless: params.headless,
        proxy: proxy.url,
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
        ],
    });

    let lastIndex = -1;
    let round = 0;

    while (!stopping) {
        if (params.rounds > 0 && round >= params.rounds) break;
        round += 1;

        const { index, url } = pickUrl(urls, lastIndex);
        lastIndex = index;

        const roundState = {
            initialUrl: url,
            hops: 0,
            redirects: 0,
            loadFailed: false,
            formAppeared: false,
            checked: null,     // true/false/null(未出现表单)
            continued: null,
            formDone: null,    // 倒计时/跳转是否启动
        };

        tslog(`🔵 轮次 #${round} 开始访问 → ${url}`);

        const context = await createFreshContext(browser);
        activeContexts.add(context);

        try {
            const page = await context.newPage();
            await page.authenticate({ username: proxy.username, password: proxy.password });
            await page.setCacheEnabled(false).catch(() => {});
            page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
            page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
            await page.setViewport({ width: 1366, height: 768 }).catch(() => {});

            await setupRequestBlocker(page);
            attachRedirectLogger(page, roundState);

            // 关闭意外弹出的新标签/窗口，只在原标签工作
            context.on('targetcreated', async (target) => {
                if (target.type() !== 'page') return;
                try {
                    const tpage = await target.page();
                    if (tpage && tpage !== page) {
                        tslog('   🪟 关闭意外弹窗/新标签');
                        await tpage.close().catch(() => {});
                    }
                } catch { /* ignore */ }
            });

            const startTime = Date.now();
            const dwellMs = params.dwellSec * 1000;

            // 导航（含出错刷新重试）
            roundState.loadFailed = !(await navigateWithRetry(page, url));

            // 停留期间轮询检测验证表单（每轮最多处理一次）
            // 注意：导航耗时可能超过停留时长，此时仍保留一个最短检测窗口，
            // 否则表单会被完全漏掉（早期 bug）。
            const dwellEnd = startTime + dwellMs;
            const pollEnd = Math.max(dwellEnd, Date.now() + MIN_POLL_MS);
            let formHandled = false;
            while (!stopping && Date.now() < pollEnd) {
                if (!formHandled) {
                    if (await detectForm(page)) {
                        roundState.formAppeared = true;
                        tslog('   🔐 检测到验证表单');
                        const r = await handleForm(page);
                        roundState.checked = r.checked;
                        roundState.continued = r.continued;
                        roundState.formDone = r.redirected;
                        formHandled = true;
                    }
                }
                await sleep(FORM_POLL_INTERVAL_MS);
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            tslog(`✅ 轮次 #${round} 结束（停留 ${elapsed}s）| 跳转 ${roundState.redirects} 次 | 加载 ${roundState.loadFailed ? '失败' : '成功'} | 表单 ${roundState.formAppeared ? '出现' : '未出现'}`);
            console.log(`ROUND_SUMMARY round=${round} redirects=${roundState.redirects} error=${roundState.loadFailed ? 'yes' : 'no'} form=${roundState.formAppeared ? 'yes' : 'no'} checked=${fmtFlag(roundState.checked)} continued=${fmtFlag(roundState.continued)} done=${fmtFlag(roundState.formDone)}`);

        } catch (e) {
            tslog(`❌ 轮次 #${round} 异常: ${e.message}`);
        } finally {
            activeContexts.delete(context);
            await context.close().catch(() => {});
        }
    }

    tslog('🏁 所有轮次已完成，正在收尾...');
}

function fmtFlag(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    return '-';
}

async function cleanup() {
    for (const c of activeContexts) {
        await c.close().catch(() => {});
    }
    activeContexts.clear();
    if (browser) await browser.close().catch(() => {});
    if (proxyManager) proxyManager.destroy();
}

process.on('SIGINT', async () => {
    tslog('👋 收到退出信号，正在关闭浏览器...');
    stopping = true;
    try {
        await cleanup();
    } finally {
        process.exit(0);
    }
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