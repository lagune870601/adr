/**
 * adoperator.js — 多路并发循环访问地址列表中的页面（域名守卫版）
 *
 * 模型: 单浏览器 + N 个并发隐私上下文，每路无限循环访问。
 *
 * 特性:
 *   1. --concurrency 路并发，每路一个隐私上下文，各自无限循环
 *   2. 地址按取模分区隔离：第 i 路只访问 idx % concurrency === i 的子集
 *      （启动前校验 urls.length >= concurrency，不足直接报错）
 *   3. 不拦截跨域跳转：完整打印跳转链，不中止导航
 *   4. 每轮全新无痕上下文（零缓存、零 cookie），访问完即关闭
 *   5. 不拦截资源：正常加载 image / stylesheet / font / media / script 等
 *   6. 路内随机取址，且不与本路上一轮重复
 *   7. 浏览器进程崩溃自动重启，各路自动恢复
 *   8. 打印每次重定向跳转地址
 *   9. 各路启动错峰 2 秒（第 i 路等待 i*2 秒），避免启动瞬时并发峰值
 *  10. 每轮随机生成 Windows 桌面 UA（user-agents 包），覆盖浏览器固定 UA
 *  11. 每轮关闭隐私上下文后，固定等待 5 秒再进入下一轮
 *  12. --test 测试模式：固定单路单轮，隐私窗口保持打开供人工操作，关闭窗口后自动退出
 *
 * 用法:
 *   node adoperator.js
 *     --urls=./urls.json     地址列表文件（默认 ./urls.json）
 *     --concurrency=<n>      并发路数（默认 5，要求 <= urls 条数）
 *     --dwell-sec=<n>        单轮停留秒数（默认 20）
 *     --headless             强制无头模式
 *     --test                 测试模式（固定单路单轮，隐私窗口不自动关闭）
 *
 *   也可用环境变量（优先级低于命令行参数）: CONCURRENCY / DWELL_SEC
 */

import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import UserAgent from 'user-agents';
import { createProxy } from './shared/proxy-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = false;

// ==================== 配置常量 ====================

const NAV_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_REFRESH_RETRIES = 5;       // 出错时刷新当前页的最大重试次数
const DWELL_POLL_STEP_MS = 500;      // 停留期间的轮询步长
const DEFAULT_CONCURRENCY = 1;       // 默认并发路数
const BROWSER_RETRY_DELAY_MS = 2000; // 浏览器不可用时的等待间隔
const STAGGER_STEP_MS = 2000;        // 各路启动错峰步长（第 i 路等待 i * 该值）
const ROUND_WAIT_MS = 5000;          // 每轮关闭上下文后，进入下一轮前的固定等待

// ==================== 日志 ====================

function tslog(msg) {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${t}] ${msg}`);
}

// ==================== 命令行参数 ====================

function parseArgs() {
    const args = process.argv.slice(2);

    // 环境变量作为中间优先级（命令行参数 > 环境变量 > 代码默认值）
    const envDwell = parseFloat(process.env.DWELL_SEC);
    const envConc = parseInt(process.env.CONCURRENCY, 10);

    const params = {
        urlsFile: path.join(__dirname, 'urls.json'),
        dwellSec: Number.isFinite(envDwell) && envDwell > 0 ? envDwell : 20,
        concurrency: Number.isInteger(envConc) && envConc > 0 ? envConc : DEFAULT_CONCURRENCY,
        headless: isLinux,
        test: false,
    };

    for (const arg of args) {
        if (arg.startsWith('--urls=')) {
            params.urlsFile = arg.slice('--urls='.length);
        } else if (arg.startsWith('--dwell-sec=')) {
            const v = parseFloat(arg.slice('--dwell-sec='.length));
            if (Number.isFinite(v) && v > 0) params.dwellSec = v;
        } else if (arg.startsWith('--concurrency=')) {
            const v = parseInt(arg.slice('--concurrency='.length), 10);
            if (Number.isInteger(v) && v > 0) params.concurrency = v;
        } else if (arg === '--headless') {
            params.headless = true;
        } else if (arg === '--test') {
            params.test = true;
        }
    }

    // 测试模式固定单路、必须有窗口供人工操作
    if (params.test) {
        params.concurrency = 1;
        params.headless = false;
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
 * 在（子集）列表内随机取址，且下标不与上一次相同。
 * 子集只有 1 条时只能沿用。
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

/** 按取模把整表拆分为 concurrency 个子集，第 i 路取 idx % concurrency === i */
function partitionUrls(urls, concurrency) {
    const subsets = [];
    for (let i = 0; i < concurrency; i++) {
        subsets.push(urls.filter((_, idx) => idx % concurrency === i));
    }
    return subsets;
}

// ==================== 随机 UA ====================

/** 随机生成一个 Windows 桌面 UA 字符串（每轮调用一次，结果各不相同） */
function randomWindowsUA() {
    try {
        return new UserAgent({ platform: 'Win32' }).toString();
    } catch {
        return null;
    }
}

// ==================== 请求观察：打印跳转日志（不拦截） ====================

/**
 * 仅观察主 frame 的 document 请求并打印跳转地址，所有请求一律放行。
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
                    roundState.log(`   ↪️  跳转 ${roundState.redirects} → ${u}`);
                }
            }
        }

        req.continue().catch(() => {});
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
 * @returns {Promise<boolean>} 是否最终加载成功
 */
async function navigateWithRetry(page, url, roundState) {
    for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
        try {
            if (attempt === 0) {
                await tryLoad(page, url);
            } else {
                let cur = '';
                try { cur = page.url(); } catch { cur = ''; }
                const recoverable = cur && cur !== 'about:blank' && !cur.startsWith('chrome-error://');
                if (recoverable) {
                    roundState.log(`   🔁 加载失败，刷新当前页 第 ${attempt} 次`);
                    await tryReload(page);
                } else {
                    roundState.log(`   🔁 加载失败，重新访问初始地址 第 ${attempt} 次`);
                    await tryLoad(page, url);
                }
            }
            return true;
        } catch (e) {
            if (attempt === MAX_REFRESH_RETRIES) {
                roundState.log(`   ❌ 重试 ${MAX_REFRESH_RETRIES} 次仍失败: ${e.message.slice(0, 60)}`);
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

// ==================== 测试模式：等待人工关闭窗口 ====================

/** 等待页面/隐私上下文被人工关闭；事件不触发时用轮询兜底 */
function waitForContextClosed(page, context) {
    return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = () => {
            if (done) return;
            done = true;
            if (timer) clearInterval(timer);
            resolve();
        };
        try { page.once('close', finish); } catch { /* ignore */ }
        try { context.once('closed', finish); } catch { /* ignore */ }
        timer = setInterval(() => {
            try {
                const pageClosed = typeof page.isClosed === 'function' && page.isClosed();
                const ctxClosed = typeof context.isClosed === 'function' && context.isClosed();
                if (pageClosed || ctxClosed) finish();
            } catch {
                finish();
            }
        }, 1000);
    });
}

// ==================== 浏览器生命周期（崩溃自愈）====================

let browser = null;
let launchPromise = null;
let proxyManager = null;
let proxyRef = null;
let headlessFlag = isLinux;
const activeContexts = new Set();
let stopping = false;

/**
 * 确保有一个可用的浏览器；进程崩溃/断开后自动重建。
 * 并发调用共享同一次 launch，避免多路同时重建。
 * @returns {Promise<object|null>} 可用浏览器，重建失败返回 null
 */
async function ensureBrowser() {
    if (browser && browser.isConnected()) return browser;

    if (!launchPromise) {
        launchPromise = (async () => {
            try {
                const b = await launch({
                    headless: headlessFlag,
                    proxy: proxyRef.url,
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
                b.on('disconnected', () => {
                    if (browser === b) {
                        browser = null;
                        tslog('⚠️  浏览器已断开，将在下一轮自动重建');
                    }
                });
                browser = b;
                tslog('🧩 浏览器已就绪');
                return b;
            } catch (e) {
                tslog(`❌ 浏览器启动失败: ${e.message.slice(0, 80)}`);
                return null;
            } finally {
                launchPromise = null;
            }
        })();
    }
    return launchPromise;
}

// ==================== 单路工作循环 ====================

async function workerLoop(workerIndex, subset, params) {
    const tag = `[W${workerIndex + 1}]`;
    const wlog = (m) => tslog(`${tag} ${m}`);
    let lastIndex = -1;
    let round = 0;

    // 启动错峰：第 i 路等待 i*2 秒，避免所有路在同一瞬间并发建上下文/导航
    if (workerIndex > 0) {
        await sleep(workerIndex * STAGGER_STEP_MS);
        if (stopping) return;
    }

    while (!stopping) {
        const { index, url } = pickUrl(subset, lastIndex);
        lastIndex = index;
        round += 1;

        const roundState = {
            log: wlog,
            hops: 0,
            redirects: 0,
            loadFailed: false,
        };

        const br = await ensureBrowser();
        if (!br) {
            await sleep(BROWSER_RETRY_DELAY_MS);
            continue;
        }
        if (stopping) break;

        // 每轮随机 Windows UA，用于覆盖浏览器固定 UA
        const ua = randomWindowsUA();
        const uaTag = ua ? ` | UA=${ua.split(') ').pop()}` : '';
        wlog(`🔵 轮次 #${round} 开始访问 → ${url}${uaTag}`);

        let context = null;
        let page = null;
        try {
            context = await createFreshContext(br);
            activeContexts.add(context);

            page = await context.newPage();
            if (ua) await page.setUserAgent(ua).catch(() => {});
            await page.authenticate({ username: proxyRef.username, password: proxyRef.password });
            await page.setCacheEnabled(false).catch(() => {});
            page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
            page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
            await page.setViewport({ width: 1366, height: 768 }).catch(() => {});

            setupRequestHandler(page, roundState);

            // 关闭意外弹出的新标签/窗口，只在原标签工作
            context.on('targetcreated', async (target) => {
                if (target.type() !== 'page') return;
                try {
                    const tpage = await target.page();
                    if (tpage && tpage !== page) {
                        wlog('   🪟 关闭意外弹窗/新标签');
                        await tpage.close().catch(() => {});
                    }
                } catch { /* ignore */ }
            });

            const startTime = Date.now();
            const dwellEnd = startTime + params.dwellSec * 1000;

            // 导航（含出错刷新重试）
            roundState.loadFailed = !(await navigateWithRetry(page, url, roundState));

            // 停留满 dwellSec
            while (!stopping && Date.now() < dwellEnd) {
                await sleep(DWELL_POLL_STEP_MS);
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            wlog(`✅ 轮次 #${round} 结束（停留 ${elapsed}s）| 跳转 ${roundState.redirects} 次 | 加载 ${roundState.loadFailed ? '失败' : '成功'}`);
            console.log(`ROUND_SUMMARY worker=${workerIndex + 1} round=${round} redirects=${roundState.redirects} error=${roundState.loadFailed ? 'yes' : 'no'} domain=off`);

        } catch (e) {
            wlog(`❌ 轮次 #${round} 异常: ${e.message}`);
        } finally {
            // 测试模式保留隐私窗口，供人工操作
            if (context && !params.test) {
                activeContexts.delete(context);
                await context.close().catch(() => {});
            }
        }

        // 测试模式：等待人工关闭窗口后结束
        if (params.test) {
            if (context && page) {
                wlog('🧪 测试模式：窗口保持打开，请人工操作；关闭窗口后程序退出');
                await waitForContextClosed(page, context);
                wlog('🧪 测试窗口已关闭，测试结束');
            }
            return;
        }

        // 每轮在上下文关闭后固定等待，避免连续发起下一轮
        if (!stopping) {
            wlog(`⏳ 等待 ${ROUND_WAIT_MS / 1000} 秒后进入下一轮`);
            await sleep(ROUND_WAIT_MS);
        }
    }
}

// ==================== 主流程 ====================

async function run() {
    const params = parseArgs();
    const urls = loadUrls(params.urlsFile);

    if (urls.length < params.concurrency) {
        throw new Error(
            `地址列表不足: ${params.urlsFile} 仅 ${urls.length} 条，但并发数为 ${params.concurrency}；` +
            `要求 urls.length >= concurrency`
        );
    }

    headlessFlag = params.headless;

    console.log('🚀 启动 CloakBrowser (adz 访问器 · 并发版)...');
    console.log(`📋 地址列表: ${urls.length} 条 | 文件: ${params.urlsFile}`);
    console.log(`🧵 并发路数: ${params.concurrency}`);
    console.log(`⏱️  单轮停留: ${params.dwellSec.toFixed(0)} 秒`);
    console.log('🛡️  跨域/资源拦截: 关闭（全部放行）');
    console.log(`🖥️  模式: ${params.headless ? '无头' : '有窗口'}`);
    if (params.test) {
        console.log('🧪 测试模式: 单路单轮，隐私窗口保持打开，关闭窗口后自动退出（--concurrency/--headless 已忽略）');
    }
    console.log('');

    // 代理（与 open-account.js 一致）
    const { proxy, manager } = await createProxy({ country: 'US', protocol: 'http' });
    proxyManager = manager;
    proxyRef = proxy;
    console.log(`📡 代理地址: ${proxy.host}:${proxy.port}（${params.concurrency} 路共用）\n`);

    await ensureBrowser();

    const subsets = partitionUrls(urls, params.concurrency);
    subsets.forEach((s, i) => console.log(`   [W${i + 1}] 子集 ${s.length} 条`));
    console.log('');

    const workers = subsets.map((subset, i) => workerLoop(i, subset, params));
    await Promise.all(workers);

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
    if (proxyManager) proxyManager.destroy();
}

process.on('SIGINT', () => {
    tslog('👋 收到退出信号，正在关闭浏览器...');
    // 有界收尾：最多等 5 秒。某个 context/browser 的 close 可能卡住，
    // 不能让 finally 里的 process.exit 永远等不到。
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