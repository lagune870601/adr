/**
 * mondiad.js — 多路并发循环访问，返回本地空页面并加载 Mondiad 广告脚本
 *
 * 用法:
 *   node mondiad.js --concurrency=1 [--urls=./mondiad-urls.json]
 *     [--ad-timeout-sec=30] [--after-click-sec=2] [--click-rate=0.2] [--headless]
 */

import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import UserAgent from 'user-agents';
import { createProxy } from './shared/proxy-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = true;

const NAV_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 1;
const STAGGER_STEP_MS = 10000;
const ROUND_WAIT_MS = 300000;
const AD_POLL_STEP_MS = 500;
const CLICK_DELAY_MIN_MS = 1000;
const CLICK_DELAY_MAX_MS = 3000;
const AFTER_CLICK_SEC = 10;
const AD_TIMEOUT_SEC = 60;
// 检测到广告后的点击概率，控制在 20% 左右，避免每次曝光都产生点击
const CLICK_PROBABILITY = 1;

// 省流：图片与广告上报（beacon/fetch/xhr）必须放行，否则广告不展示或点击不上报
const BLOCKED_RESOURCE_TYPES = ['stylesheet', 'font', 'media', 'texttrack', 'manifest'];

/** 仅放行主机名包含 mnd 的域名（含子域名，大小写不敏感） */
function isMndHost(host) {
    return !!host && host.toLowerCase().includes('mnd');
}

// ==================== 日志 ====================

function tslog(msg) {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${t}] ${msg}`);
}

// ==================== 命令行参数 ====================

function parseArgs() {
    const args = process.argv.slice(2);

    const envAdTimeout = parseFloat(process.env.AD_TIMEOUT_SEC);
    const envAfterClick = parseFloat(process.env.AFTER_CLICK_SEC);
    const envClickRate = parseFloat(process.env.CLICK_RATE);
    const envConc = parseInt(process.env.CONCURRENCY, 10);

    const params = {
        urlsFile: path.join(__dirname, 'mondiad-urls.json'),
        adTimeoutSec: Number.isFinite(envAdTimeout) && envAdTimeout > 0 ? envAdTimeout : AD_TIMEOUT_SEC,
        afterClickSec: Number.isFinite(envAfterClick) && envAfterClick >= 0 ? envAfterClick : AFTER_CLICK_SEC,
        clickProbability: Number.isFinite(envClickRate) && envClickRate >= 0 && envClickRate <= 1 ? envClickRate : CLICK_PROBABILITY,
        concurrency: Number.isInteger(envConc) && envConc > 0 ? envConc : DEFAULT_CONCURRENCY,
        headless: isLinux,
    };

    for (const arg of args) {
        if (arg.startsWith('--urls=')) {
            params.urlsFile = arg.slice('--urls='.length);
        } else if (arg.startsWith('--ad-timeout-sec=')) {
            const v = parseFloat(arg.slice('--ad-timeout-sec='.length));
            if (Number.isFinite(v) && v > 0) params.adTimeoutSec = v;
        } else if (arg.startsWith('--after-click-sec=')) {
            const v = parseFloat(arg.slice('--after-click-sec='.length));
            if (Number.isFinite(v) && v >= 0) params.afterClickSec = v;
        } else if (arg.startsWith('--click-rate=')) {
            const v = parseFloat(arg.slice('--click-rate='.length));
            if (Number.isFinite(v) && v >= 0 && v <= 1) params.clickProbability = v;
        } else if (arg.startsWith('--concurrency=')) {
            const v = parseInt(arg.slice('--concurrency='.length), 10);
            if (Number.isInteger(v) && v > 0) params.concurrency = v;
        } else if (arg === '--headless') {
            params.headless = true;
        }
    }

    return params;
}

// ==================== 数据列表 ====================

function loadEntries(file) {
    if (!fs.existsSync(file)) {
        throw new Error(`数据列表文件不存在: ${file}`);
    }
    const raw = fs.readFileSync(file, 'utf-8');
    let arr;
    try {
        arr = JSON.parse(raw);
    } catch (e) {
        throw new Error(`数据列表文件不是合法 JSON: ${e.message}`);
    }
    if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error('数据列表必须是非空数组');
    }
    return arr.map((item, i) => {
        if (!item || typeof item !== 'object') {
            throw new Error(`第 ${i + 1} 项不是对象`);
        }
        const url = typeof item.url === 'string' ? item.url.trim() : '';
        const script = typeof item.script === 'string' ? item.script.trim() : '';
        if (!url) {
            throw new Error(`第 ${i + 1} 项缺少有效 url`);
        }
        return { url, script };
    });
}

/** 在（子集）列表内随机取址，且下标不与上一次相同 */
function pickEntry(entries, lastIndex) {
    if (entries.length === 1) {
        return { index: 0, entry: entries[0] };
    }
    let idx;
    do {
        idx = Math.floor(Math.random() * entries.length);
    } while (idx === lastIndex);
    return { index: idx, entry: entries[idx] };
}

/** 按取模把整表拆分为 concurrency 个子集，第 i 路取 idx % concurrency === i */
function partitionEntries(entries, concurrency) {
    const subsets = [];
    for (let i = 0; i < concurrency; i++) {
        subsets.push(entries.filter((_, idx) => idx % concurrency === i));
    }
    return subsets;
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

function buildHtml(script) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${script}
</head>
<body>helloworld</body>
</html>`;
}

/**
 * 主 frame 导航到配置域名时，直接返回本地空页面；
 * 同域名的其余请求（如 favicon.ico）一律中止，避免经代理发出；
 * 其余请求中，省流类型照拦，只有主机名包含 mnd 的域名才放行，
 * 其余域名（含 data:/blob: 等无主机名请求）全部中止。
 */
function setupRequestHandler(page, entry, roundState) {
    const initialHost = hostnameOf(entry.url);
    const html = buildHtml(entry.script);

    page.setRequestInterception(true).catch(() => {});
    page.on('request', (req) => {
        const host = hostnameOf(req.url());
        if (host && host === initialHost) {
            if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
                if (!roundState.served) {
                    roundState.served = true;
                    roundState.log('   📄 返回本地空页面（helloworld + 广告脚本）');
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

        const type = req.resourceType();
        if (BLOCKED_RESOURCE_TYPES.includes(type)) {
            req.abort().catch(() => {});
            return;
        }
        if (!isMndHost(host)) {
            req.abort().catch(() => {});
            return;
        }
        req.continue().catch(() => {});
    });
}

// ==================== 广告检测与点击 ====================

/** 在主页面中查找已加载完成且已滑入视口的广告 iframe，返回其视口包围盒 */
async function findAdRect(page) {
    return page.evaluate(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const frames = Array.from(document.querySelectorAll('iframe'));
        for (const f of frames) {
            if ((f.getAttribute('srcdoc') || '').trim() === 'blank page') continue;

            const rect = f.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            const style = window.getComputedStyle(f);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            // 广告滑入前位于屏幕外（left:110%），必须完全进入视口才可点击
            if (rect.left < 0 || rect.top < 0 || rect.right > vw || rect.bottom > vh) continue;

            let doc;
            try {
                doc = f.contentDocument;
            } catch {
                continue;
            }
            if (!doc || !doc.body || !doc.body.innerHTML.trim()) continue;
            if (doc.readyState !== 'complete') continue;

            return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        }
        return null;
    });
}

function randomPointInRect(rect) {
    return {
        x: Math.round(rect.x + rect.width * (0.2 + Math.random() * 0.6)),
        y: Math.round(rect.y + rect.height * (0.2 + Math.random() * 0.6)),
    };
}

/** 轮询等待广告加载，命中后按配置概率决定是否点击；未命中或未抽中直接返回 */
async function detectAndClickAd(page, params, wlog) {
    const deadline = Date.now() + params.adTimeoutSec * 1000;
    let rect = null;

    while (!stopping && Date.now() < deadline) {
        try {
            rect = await findAdRect(page);
        } catch {
            rect = null;
        }
        if (rect) break;
        await sleep(AD_POLL_STEP_MS);
    }

    if (!rect) {
        wlog(`   ⚠️ ${params.adTimeoutSec} 秒内未检测到广告，跳过点击`);
        return false;
    }

    if (Math.random() >= params.clickProbability) {
        wlog(`   🎲 广告已加载，本次不点击（点击率 ${(params.clickProbability * 100).toFixed(0)}%）`);
        return false;
    }

    const delay = CLICK_DELAY_MIN_MS + Math.random() * (CLICK_DELAY_MAX_MS - CLICK_DELAY_MIN_MS);
    wlog(`   🎯 广告已加载，${(delay / 1000).toFixed(1)} 秒后点击`);
    await sleep(delay);
    if (stopping) return false;

    // 延迟期间广告可能仍在滑入/移动，点击前重新取一次实时坐标
    let clickRect = null;
    try {
        clickRect = await findAdRect(page);
    } catch {
        clickRect = null;
    }
    if (!clickRect) {
        wlog('   ⚠️ 点击前广告不在视口内，跳过点击');
        return false;
    }

    const { x, y } = randomPointInRect(clickRect);
    try {
        await page.mouse.move(x, y, { steps: 10 });
        await sleep(100);
        await page.mouse.click(x, y, { delay: 80 });
        wlog(`   👆 已点击广告 (${x}, ${y})`);
    } catch (e) {
        wlog(`   ⚠️ 点击广告失败: ${e.message}`);
        return false;
    }

    wlog(`   ⏳ 点击后停留 ${params.afterClickSec} 秒`);
    await sleep(params.afterClickSec * 1000);
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
let proxyRef = null;
let proxyManager = null;
let headlessFlag = isLinux;
const activeContexts = new Set();
let stopping = false;

async function launchBrowser() {
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
        tslog('⚠️  浏览器已断开');
    });
    browser = b;
    tslog('🧩 浏览器已就绪');
    return b;
}

// ==================== 弹窗防护 ====================

/**
 * 广告点击会通过 window.open / target=_blank 打开新页面；
 * 新页面是独立 target，page 级请求拦截管不到，会直接经代理加载完整页面。
 * 因此要在页面及所有子 frame 中禁用这些弹窗入口（脚本创建 iframe 时同样生效）。
 */
function installPopupGuard(page) {
    return page.evaluateOnNewDocument(() => {
        window.open = () => null;

        document.addEventListener('click', (e) => {
            const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
            const anchor = path.find((node) => (
                node instanceof Element &&
                (node.tagName === 'A' || node.tagName === 'AREA') &&
                node.hasAttribute('target')
            ));
            if (anchor) e.preventDefault();
        }, true);

        document.addEventListener('submit', (e) => {
            if (e.target instanceof HTMLFormElement && e.target.hasAttribute('target')) {
                e.preventDefault();
            }
        }, true);
    });
}

// ==================== 单路工作循环 ====================

async function workerLoop(workerIndex, subset, params) {
    const tag = `[W${workerIndex + 1}]`;
    const wlog = (m) => tslog(`${tag} ${m}`);
    let lastIndex = -1;
    let round = 0;

    if (workerIndex > 0) {
        await sleep(workerIndex * STAGGER_STEP_MS);
        if (stopping) return;
    }

    while (!stopping) {
        const { index, entry } = pickEntry(subset, lastIndex);
        lastIndex = index;
        round += 1;

        if (!browser || !browser.isConnected()) {
            wlog('❌ 浏览器已断开，退出');
            stopping = true;
            process.exit(1);
        }

        const ua = randomWindowsUA();
        const uaTag = ua ? ` | UA=${ua.split(') ').pop()}` : '';
        wlog(`🔵 轮次 #${round} 开始访问 → ${entry.url}${uaTag}`);

        let context = null;
        let closeExtraPage = null;
        try {
            context = await createFreshContext(browser);
            activeContexts.add(context);

            const page = await context.newPage();

            // 兜底：万一仍产生新页面（如非标准弹窗路径），立即关闭，尽量少发请求
            closeExtraPage = (target) => {
                let isExtraPage;
                try {
                    isExtraPage = target.type() === 'page' && target.browserContext() === context;
                } catch {
                    return;
                }
                if (!isExtraPage) return;
                target.page()
                    .then((extra) => (extra && extra !== page ? extra.close() : null))
                    .catch(() => {});
            };
            browser.on('targetcreated', closeExtraPage);

            if (ua) await page.setUserAgent(ua).catch(() => {});
            await page.authenticate({ username: proxyRef.username, password: proxyRef.password });
            await page.setCacheEnabled(false).catch(() => {});
            page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
            page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
            await page.setViewport({ width: 1366, height: 768 }).catch(() => {});
            await installPopupGuard(page);

            setupRequestHandler(page, entry, { log: wlog, served: false });

            await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

            await detectAndClickAd(page, params, wlog);

            wlog(`✅ 轮次 #${round} 结束`);
            console.log(`ROUND_SUMMARY worker=${workerIndex + 1} round=${round} url=${entry.url}`);
        } catch (e) {
            wlog(`❌ 轮次 #${round} 异常: ${e.message}`);
        } finally {
            if (closeExtraPage) {
                browser?.off('targetcreated', closeExtraPage);
                closeExtraPage = null;
            }
            if (context) {
                activeContexts.delete(context);
                await context.close().catch(() => {});
            }
        }

        if (!stopping) {
            wlog(`⏳ 等待 ${ROUND_WAIT_MS / 1000} 秒后进入下一轮`);
            await sleep(ROUND_WAIT_MS);
        }
    }
}

// ==================== 主流程 ====================

async function run() {
    const params = parseArgs();
    const entries = loadEntries(params.urlsFile);

    if (entries.length < params.concurrency) {
        throw new Error(
            `数据列表不足: ${params.urlsFile} 仅 ${entries.length} 条，但并发数为 ${params.concurrency}；` +
            `要求 entries.length >= concurrency`
        );
    }

    headlessFlag = params.headless;

    console.log('🚀 启动 CloakBrowser (mondiad 访问器 · 并发版)...');
    console.log(`📋 数据列表: ${entries.length} 条 | 文件: ${params.urlsFile}`);
    console.log(`🧵 并发路数: ${params.concurrency}`);
    console.log(`⏱️  广告等待: ${params.adTimeoutSec.toFixed(0)} 秒 | 点击后停留: ${params.afterClickSec.toFixed(0)} 秒 | 点击率: ${(params.clickProbability * 100).toFixed(0)}%`);
    console.log(`🖥️  模式: ${params.headless ? '无头' : '有窗口'}\n`);

    const { proxy, manager } = await createProxy({ country: 'US', protocol: 'http' });
    proxyManager = manager;
    proxyRef = proxy;
    console.log(`📡 代理地址: ${proxy.host}:${proxy.port}（${params.concurrency} 路共用）\n`);

    await launchBrowser();

    const subsets = partitionEntries(entries, params.concurrency);
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