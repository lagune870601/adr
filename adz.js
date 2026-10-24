/**
 * adz.js — 连续循环访问地址列表中的页面（域名守卫版）
 *
 * 基于 redirect-visitor.js，差异如下:
 *   1. 单轮停留时长默认 10 秒（命令 --dwell-sec 可调），不再长时间停留
 *   2. 跨域名守卫：跳转链接的 hostname 与初始地址 hostname 不一致时，
 *      立即关闭当前隐私上下文并开始下一轮（严格 hostname 相等）
 *   3. 移除人机验证表单处理
 *
 * 保留特性:
 *   1. 复用 open-account.js 的代理（shared/proxy-utils.js 的 createProxy）
 *   2. 省流量模式：不加载 image / stylesheet / font / media 等资源
 *   3. 每轮全新无痕上下文（零缓存、零 cookie）
 *   4. 从 urls.json 随机取址，且不与上一轮重复
 *   5. 打印每次重定向跳转地址
 *
 * 用法:
 *   node adz.js
 *     --urls=./urls.json     地址列表文件（默认 ./urls.json）
 *     --dwell-sec=<n>        单轮停留秒数（默认 10）
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
const isLinux = os.platform() === 'linux';

// ==================== 配置常量 ====================

const BLOCKED_RESOURCE_TYPES = [
    'image',
    'stylesheet',
    'font',
    'media',
    'texttrack',
    'manifest',
];

const NAV_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_REFRESH_RETRIES = 5;       // 出错时刷新当前页的最大重试次数
const DWELL_POLL_STEP_MS = 500;      // 停留期间轮询"是否跨域名跳走"的步长

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
        dwellSec: 10,
        rounds: 0,
        headless: isLinux,
    };

    for (const arg of args) {
        if (arg.startsWith('--urls=')) {
            params.urlsFile = arg.slice('--urls='.length);
        } else if (arg.startsWith('--dwell-sec=')) {
            const v = parseFloat(arg.slice('--dwell-sec='.length));
            if (Number.isFinite(v) && v > 0) params.dwellSec = v;
        } else if (arg.startsWith('--rounds=')) {
            params.rounds = parseInt(arg.slice('--rounds='.length), 10);
        } else if (arg === '--headless') {
            params.headless = true;
        }
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

// ==================== 域名工具 ====================

/** 取 URL 的 hostname（已自动小写）；非法 URL 返回 null */
function hostnameOf(u) {
    try {
        return new URL(u).hostname || null;
    } catch {
        return null;
    }
}

// ==================== 请求拦截：省流量 + 跳转日志 + 跨域名守卫 ====================

/**
 * 统一的请求处理器（必须是唯一监听 request 的处理器）：
 *   - document（主 frame）：作为导航跳转链的一环，打印跳转地址；
 *     跳转域名与初始域名严格不一致时，abort 该请求以立即中止导航并置 domainMismatch。
 *   - 其余资源：省流量拦截（不加载 image/stylesheet/font/media 等）。
 *
 * 为什么必须合并：puppeteer 中同一个请求只能被 continue/abort 一次，
 * 若省流量拦截先 continue 了 document 请求，后续守卫就再也无法 abort。
 *
 * 关键点：HTTP 3xx 的每一跳都会重新发起一次 document 请求，
 * 但 framenavigated 只在最终文档提交时触发一次，会漏掉中间跳。
 * 因此监听主 frame 的 document 请求，才能拿到完整跳转链
 * （HTTP 3xx、JS location 跳转、meta refresh 都覆盖）。
 */
function setupRequestHandler(page, roundState) {
    page.setRequestInterception(true).catch(() => {});
    page.on('request', (req) => {
        const type = req.resourceType();

        if (type === 'document' && req.frame() === page.mainFrame()) {
            const u = req.url();
            if (u && u !== 'about:blank' && !u.startsWith('chrome-error://')) {
                roundState.hops += 1;
                roundState.redirects = roundState.hops - 1;

                // 第 1 个 document 请求即初始访问地址，已在"开始访问"行打印，避免重复
                if (roundState.hops > 1) {
                    // 打印前：比对跳转域名与初始域名
                    const host = hostnameOf(u);
                    if (host && roundState.initialHost && host !== roundState.initialHost) {
                        if (!roundState.domainMismatch) {
                            roundState.domainMismatch = true;
                            tslog(`   ⛔ 跨域名跳转（${host} ≠ ${roundState.initialHost}），中止导航并关闭隐私页`);
                        }
                        req.abort().catch(() => {});
                        return;
                    }
                    tslog(`   ↪️  跳转 ${roundState.redirects} → ${u}`);
                }
            }
            req.continue().catch(() => {});
            return;
        }

        if (BLOCKED_RESOURCE_TYPES.includes(type)) {
            req.abort().catch(() => {});
        } else {
            req.continue().catch(() => {});
        }
    });
}

/** 页面是否处于加载失败状态（错误页 / 空白页） */
function isErrorPage(page) {
    const u = page.url();
    return !u || u === 'about:blank' || u.startsWith('chrome-error://');
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
 *
 * 若本轮已因跨域名被守卫中止（roundState.domainMismatch），立即返回失败，
 * 不再重试——否则会在已关闭/已中止的导航上反复刷新。
 * @returns {Promise<boolean>} 是否最终加载成功
 */
async function navigateWithRetry(page, url, roundState) {
    for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
        if (roundState.domainMismatch) return false;
        try {
            if (attempt === 0) {
                await tryLoad(page, url);
            } else {
                let cur = '';
                try { cur = page.url(); } catch { cur = ''; }
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
            if (roundState.domainMismatch) return false;
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

    console.log('🚀 启动 CloakBrowser (adz 访问器)...');
    console.log(`📋 地址列表: ${urls.length} 条 | 文件: ${params.urlsFile}`);
    console.log(`⏱️  单轮停留: ${params.dwellSec.toFixed(0)} 秒`);
    console.log(`🔁 循环轮数: ${params.rounds === 0 ? '无限' : params.rounds}`);
    console.log(`🛡️  跨域名守卫: 开启（严格 hostname 相等）`);
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
            initialHost: hostnameOf(url),
            hops: 0,
            redirects: 0,
            domainMismatch: false,
            loadFailed: false,
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

            await setupRequestHandler(page, roundState);

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
            const dwellEnd = startTime + params.dwellSec * 1000;

            // 导航（含出错刷新重试；跨域名被守卫中止时不记为加载失败）
            roundState.loadFailed = !(await navigateWithRetry(page, url, roundState)) && !roundState.domainMismatch;

            // 停留期间轮询：跨域名跳走则立即退出，否则停留满 dwellSec
            while (!stopping && !roundState.domainMismatch && Date.now() < dwellEnd) {
                await sleep(DWELL_POLL_STEP_MS);
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            const domainTag = roundState.domainMismatch ? 'changed' : 'same';
            tslog(`✅ 轮次 #${round} 结束（停留 ${elapsed}s）| 跳转 ${roundState.redirects} 次 | 加载 ${roundState.loadFailed ? '失败' : '成功'} | 域名 ${roundState.domainMismatch ? '跨域' : '一致'}`);
            console.log(`ROUND_SUMMARY round=${round} redirects=${roundState.redirects} error=${roundState.loadFailed ? 'yes' : 'no'} domain=${domainTag}`);

        } catch (e) {
            tslog(`❌ 轮次 #${round} 异常: ${e.message}`);
        } finally {
            activeContexts.delete(context);
            await context.close().catch(() => {});
        }
    }

    tslog('🏁 所有轮次已完成，正在收尾...');
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