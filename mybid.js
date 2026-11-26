/**
 * mybid.js — 按美国东部时间作息调度访问，返回本地空页面并加载 mBidadm 广告脚本
 *
 * 用法:
 *   node mybid.js [--urls=./mybid-urls.json]
 *     [--visits-per-day=300] [--ad-timeout-sec=60] [--after-click-sec=10]
 *     [--click-rate=1] [--headless]
 *
 * 简化版：保留指纹、排程、点击三项能力，不再对广告请求做域名白名单。
 * 每个页面独立排程：日访问量服从泊松分布（默认 300），按美国东部时间的
 * 小时权重分配（凌晨稀少、晚间最高）。页面可配置多个广告 script，每个广告
 * 按弹窗位置（左右各半 × 上中下三等分共 6 区）检测；每次访问对每个广告
 * 独立掷 1% 决定是否点击，命中时点击最先出现且完整可见的那个，否则等任一
 * 广告出现后停留 5~10 秒。
 * 每轮访问使用全新的浏览器进程（随机 --fingerprint seed），保证轮与轮之间
 * 指纹不可关联；轮内新建隐私上下文，并通过 createBrowserContext({ proxyServer })
 * 指定本地 mitmproxy socks5（默认 socks5://127.0.0.1:18008，可用 SOCKS_PROXY 覆盖，
 * 加载 botAnti3.py 改写请求头）。每次访问前向 IP 分配服务（ALLOCATOR_URL）领取一个
 * 唯一 IP，再发引导请求把 botAnti3.py 的全局伪装 IP 固定为该地址。
 * 浏览器带 --ignore-certificate-errors 以信任 mitmproxy 的 TLS 拦截证书。
 * 下一轮浏览器在访问时刻前预热，启动开销落在轮间空档里。
 */

import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { etParts, etDayKey, nextDay, buildDayEvents } from './shared/visit-schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_HEADLESS = process.env.HEADLESS === '1';

const NAV_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const AD_POLL_STEP_MS = 500;
const CLICK_DELAY_MIN_MS = 1000;
const CLICK_DELAY_MAX_MS = 3000;
const AFTER_CLICK_SEC = 10;
const AD_TIMEOUT_SEC = 60;
// 访问计划开关：true 按美国东部作息计划访问，false 多链接轮流连续访问（改后重启生效）
// 本地测试临时关闭，测完恢复 true
const SCHEDULE_ENABLED = true;
// 每个广告在每次访问中独立以 CLICK_PROBABILITY 决定是否点击；一次访问最多点 1 个
const CLICK_PROBABILITY = 0.01;
const VISITS_PER_DAY = 3000;
// 非点击访问：最多等任一配置位置出现广告 10 秒，出现后随机停留 5~10 秒；始终不出现则直接结束
const NON_CLICK_AD_WAIT_SEC = 10;
const NON_CLICK_DWELL_MIN_MS = 5000;
const NON_CLICK_DWELL_MAX_MS = 10000;
// 广告弹窗可占据的 6 个位置：横向左右 × 纵向上中下
const AD_POSITIONS = [
    'top-left', 'top-right',
    'center-left', 'center-right',
    'bottom-left', 'bottom-right',
];
const SCHEDULE_SLEEP_CHUNK_MS = 30000;

// ==================== 代理与 IP 分配 ====================

const LOCAL_PROXY = process.env.SOCKS_PROXY || 'socks5://127.0.0.1:18008';
const ALLOCATOR_URL = (process.env.ALLOCATOR_URL || 'http://127.0.0.1:18010').replace(/\/+$/, '');
const ALLOCATOR_TOKEN = process.env.ALLOCATOR_TOKEN || '';
const ALLOCATOR_TIMEOUT_MS = 5000;
const ALLOCATOR_RETRIES = 2;
// 引导请求：把伪装 IP 作为 URL 参数，让 botAnti3.py 写入全局 self.ip。
// 容器内默认指向本地 dummy 服务（bootstrap.mitm.local 在 /etc/hosts 指向 127.0.0.1），
// 避免依赖外部 httpbin.org；本地开发可覆盖为 http://httpbin.org。
const BOOTSTRAP_BASE = (process.env.BOOTSTRAP_BASE || 'http://httpbin.org').replace(/\/+$/, '');
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

    const envAdTimeout = parseFloat(process.env.AD_TIMEOUT_SEC);
    const envAfterClick = parseFloat(process.env.AFTER_CLICK_SEC);
    const envClickRate = parseFloat(process.env.CLICK_RATE);
    const envVisits = parseInt(process.env.VISITS_PER_DAY, 10);

    const params = {
        urlsFile: path.join(__dirname, 'mybid-urls.json'),
        adTimeoutSec: Number.isFinite(envAdTimeout) && envAdTimeout > 0 ? envAdTimeout : AD_TIMEOUT_SEC,
        afterClickSec: Number.isFinite(envAfterClick) && envAfterClick >= 0 ? envAfterClick : AFTER_CLICK_SEC,
        clickProbability: Number.isFinite(envClickRate) && envClickRate >= 0 && envClickRate <= 1 ? envClickRate : CLICK_PROBABILITY,
        visitsPerDay: Number.isInteger(envVisits) && envVisits > 0 ? envVisits : VISITS_PER_DAY,
        headless: DEFAULT_HEADLESS,
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
        if (!url) {
            throw new Error(`第 ${i + 1} 项缺少有效 url`);
        }
        if (!Array.isArray(item.ads) || item.ads.length === 0) {
            throw new Error(`第 ${i + 1} 项缺少非空 ads 数组`);
        }
        const ads = item.ads.map((ad, j) => {
            if (!ad || typeof ad !== 'object') {
                throw new Error(`第 ${i + 1} 项第 ${j + 1} 个广告不是对象`);
            }
            const script = typeof ad.script === 'string' ? ad.script.trim() : '';
            const position = typeof ad.position === 'string' ? ad.position.trim() : '';
            if (!script) {
                throw new Error(`第 ${i + 1} 项第 ${j + 1} 个广告缺少有效 script`);
            }
            if (!AD_POSITIONS.includes(position)) {
                throw new Error(`第 ${i + 1} 项第 ${j + 1} 个广告 position 非法: ` +
                    `${position || '(空)'}，可选值: ${AD_POSITIONS.join(', ')}`);
            }
            const clickRate = ad.clickRate;
            if (clickRate !== undefined &&
                (typeof clickRate !== 'number' || !Number.isFinite(clickRate) ||
                    clickRate < 0 || clickRate > 1)) {
                throw new Error(`第 ${i + 1} 项第 ${j + 1} 个广告 clickRate 非法: ` +
                    `${clickRate}（需 0~1 的数字）`);
            }
            return { script, position, clickRate };
        });
        const dup = ads.map((ad) => ad.position).filter((p, k, all) => all.indexOf(p) !== k);
        if (dup.length > 0) {
            console.warn(`⚠️ 第 ${i + 1} 项存在重复位置: ${[...new Set(dup)].join(', ')}` +
                '（几何无法区分，按同区任一广告处理）');
        }
        return { url, ads };
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

function buildHtml(ads) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${ads.map((ad) => ad.script).join('\n')}
</head>
<body>helloworld</body>
</html>`;
}

/**
 * 主 frame 导航到配置域名时，直接返回本地空页面（含全部广告脚本），
 * 其余请求一律放行，不做域名白名单。
 */
function setupRequestHandler(page, entry, roundState) {
    const initialHost = hostnameOf(entry.url);
    const html = buildHtml(entry.ads);

    page.setRequestInterception(true).catch(() => {});
    page.on('request', (req) => {
        const host = hostnameOf(req.url());
        if (host && host === initialHost &&
            req.isNavigationRequest() && req.frame() === page.mainFrame()) {
            if (!roundState.served) {
                roundState.served = true;
                roundState.log('   📄 返回本地空页面（helloworld + 广告脚本）');
            }
            req.respond({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: html,
            }).catch(() => {});
            return;
        }
        req.continue().catch(() => {});
    });
}

// ==================== 广告检测与点击 ====================

/** 按中心点把视口内矩形归入 6 个位置之一：横向左右各半，纵向三等分 */
function positionForRect(rect, vw, vh) {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const side = cx < vw / 2 ? 'left' : 'right';
    const band = cy < vh / 3 ? 'top' : cy < (vh * 2) / 3 ? 'center' : 'bottom';
    return `${band}-${side}`;
}

/**
 * 收集主页面中已加载完成、且完整进入视口的广告 iframe，按中心点归入 6 个位置。
 * 同一位置只保留 DOM 顺序第一个。会递归进入同源子 iframe——部分广告脚本把
 * 弹窗 iframe 嵌在一个覆盖全屏的容器 iframe 内，只看顶层会漏掉。
 */
async function findVisibleAds(page) {
    const { vw, vh, rects } = await page.evaluate(() => {
        const out = [];
        const walk = (doc, offsetX, offsetY, depth) => {
            if (depth > 5) return;
            let frames;
            try {
                frames = doc.querySelectorAll('iframe');
            } catch {
                return;
            }
            for (const f of frames) {
                const rect = f.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;

                let style;
                try {
                    style = doc.defaultView.getComputedStyle(f);
                } catch {
                    continue;
                }
                if (style.display === 'none' || style.visibility === 'hidden') continue;

                let childDoc;
                try {
                    childDoc = f.contentDocument;
                } catch {
                    continue;
                }
                if (!childDoc) continue;

                const abs = {
                    x: offsetX + rect.left,
                    y: offsetY + rect.top,
                    width: rect.width,
                    height: rect.height,
                };
                const bodyReady = childDoc.body &&
                    childDoc.body.innerHTML.trim() && childDoc.readyState === 'complete';
                // 必须完整进入视口才可点击
                if (bodyReady &&
                    abs.x >= 0 && abs.y >= 0 &&
                    abs.x + abs.width <= window.innerWidth &&
                    abs.y + abs.height <= window.innerHeight) {
                    out.push(abs);
                }
                try {
                    walk(childDoc, abs.x, abs.y, depth + 1);
                } catch {
                    // 访问子文档失败（跨域/已销毁），跳过
                }
            }
        };
        walk(document, 0, 0, 0);
        return { vw: window.innerWidth, vh: window.innerHeight, rects: out };
    });

    const seen = new Set();
    const ads = [];
    for (const rect of rects) {
        const position = positionForRect(rect, vw, vh);
        if (seen.has(position)) continue;
        seen.add(position);
        ads.push({ position, rect });
    }
    return ads;
}

function randomPointInRect(rect) {
    return {
        x: Math.round(rect.x + rect.width * (0.2 + Math.random() * 0.6)),
        y: Math.round(rect.y + rect.height * (0.2 + Math.random() * 0.6)),
    };
}

/** 轮询等待给定位置中第一个完整可见的广告，返回 {position, rect}；超时或停止时返回 null */
async function waitForAdInPositions(page, positions, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (!stopping && Date.now() < deadline) {
        try {
            const visible = await findVisibleAds(page);
            const hit = visible.find((ad) => positions.has(ad.position));
            if (hit) return hit;
        } catch {
            // 单次读取失败（页面未就绪/已关闭）不致命，继续轮询
        }
        await sleep(AD_POLL_STEP_MS);
    }
    return null;
}

/** 点击并观察 2.5 秒，报告是否触发新标签或主页面跳转 */
async function clickAndObserve(page, x, y, position, wlog) {
    let ctx = null;
    try {
        ctx = page.browserContext();
    } catch {
        ctx = null;
    }
    const newTargets = [];
    const onTarget = (target) => {
        try {
            if (target.type() === 'page') newTargets.push(target);
        } catch {
            // target 可能已失效
        }
    };
    if (ctx && typeof ctx.on === 'function') ctx.on('targetcreated', onTarget);

    const urlBefore = page.url();
    try {
        await page.mouse.move(x, y, { steps: 10 });
        await sleep(100);
        await page.mouse.click(x, y, { delay: 80 });
        wlog(`   👆 已点击广告 [${position}] (${x}, ${y})`);
    } finally {
        await sleep(2500);
        if (ctx && typeof ctx.off === 'function') ctx.off('targetcreated', onTarget);
    }

    for (const target of newTargets) {
        let url = '';
        try {
            const p = await target.page();
            url = p ? p.url() : target.url();
        } catch {
            url = '';
        }
        wlog(`   🪟 点击后新开标签: ${url || '(未知)'}`);
    }
    const urlAfter = page.url();
    if (urlAfter !== urlBefore) {
        wlog(`   🪟 点击后主页面跳转到: ${urlAfter}`);
    }
    if (newTargets.length === 0 && urlAfter === urlBefore) {
        wlog('   🪟 点击后未检测到跳转或新标签');
    }
}

/** 诊断用：打印所有 iframe 的几何与加载状态，并截图保存 */
async function dumpIframes(page, wlog) {
    let frames;
    try {
        frames = await page.evaluate(() => {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const out = [];
            const walk = (doc, offsetX, offsetY, depth, prefix) => {
                if (depth > 5) return;
                let list;
                try {
                    list = doc.querySelectorAll('iframe');
                } catch {
                    return;
                }
                list.forEach((f, i) => {
                    const r = f.getBoundingClientRect();
                    const left = offsetX + r.left;
                    const top = offsetY + r.top;
                    let s = null;
                    try {
                        s = doc.defaultView.getComputedStyle(f);
                    } catch {
                        // ignore
                    }
                    let docState = 'null';
                    let childDoc = null;
                    try {
                        childDoc = f.contentDocument;
                        if (childDoc) {
                            docState = `${childDoc.readyState}/` +
                                `${childDoc.body ? childDoc.body.innerHTML.trim().length : 0}`;
                        }
                    } catch {
                        docState = 'blocked';
                    }
                    const label = `${prefix}${i + 1}`;
                    out.push({
                        label,
                        depth,
                        src: (f.getAttribute('src') || f.getAttribute('srcdoc') || '(none)').slice(0, 120),
                        x: Math.round(left), y: Math.round(top),
                        w: Math.round(r.width), h: Math.round(r.height),
                        fullyVisible: left >= 0 && top >= 0 &&
                            left + r.width <= vw && top + r.height <= vh,
                        display: s ? s.display : '?',
                        visibility: s ? s.visibility : '?',
                        opacity: s ? s.opacity : '?',
                        docState,
                    });
                    if (childDoc && childDoc.documentElement) {
                        try {
                            walk(childDoc, left, top, depth + 1, `${label}.`);
                        } catch {
                            // 子文档不可遍历
                        }
                    }
                });
            };
            walk(document, 0, 0, 0, '');
            return out;
        });
    } catch (e) {
        wlog(`   🔍 iframe 诊断失败: ${e.message}`);
        return;
    }
    wlog(`   🔍 页面 iframe 共 ${frames.length} 个（含嵌套）`);
    for (const f of frames) {
        const indent = '   '.repeat(f.depth);
        wlog(`      ${indent}#${f.label} ${f.x},${f.y} ${f.w}x${f.h} fully=${f.fullyVisible} ` +
            `display=${f.display} visibility=${f.visibility} opacity=${f.opacity} ` +
            `doc=${f.docState} src=${f.src}`);
    }
    // try {
    //     const dir = path.join(__dirname, 'logs');
    //     fs.mkdirSync(dir, { recursive: true });
    //     const shot = path.join(dir, `timeout-${Date.now()}.png`);
    //     await page.screenshot({ path: shot });
    //     wlog(`   📸 已截图: ${shot}`);
    // } catch (e) {
    //     wlog(`   ⚠️ 截图失败: ${e.message}`);
    // }
}

/** 轮询等待命中位置的广告出现，命中后点击；超时或未进入视口则跳过。返回点击的位置或 null */
async function waitForAdAndClick(page, flagged, params, wlog) {
    const hit = await waitForAdInPositions(page, flagged, params.adTimeoutSec);
    if (!hit) {
        wlog(`   ⚠️ ${params.adTimeoutSec} 秒内未检测到命中位置的广告，跳过点击`);
        try {
            const visible = await findVisibleAds(page);
            wlog(`   🔍 当前完整可见的广告位置: ` +
                `${visible.length > 0 ? visible.map((ad) => ad.position).join(', ') : '无'}`);
        } catch {
            // 页面可能已关闭，忽略诊断失败
        }
        await dumpIframes(page, wlog);
        return null;
    }

    const delay = CLICK_DELAY_MIN_MS + Math.random() * (CLICK_DELAY_MAX_MS - CLICK_DELAY_MIN_MS);
    wlog(`   🎯 [${hit.position}] 广告已加载，${(delay / 1000).toFixed(1)} 秒后点击`);
    await sleep(delay);
    if (stopping) return null;

    // 延迟期间广告可能仍在移动，点击前重新取一次同位置的实时坐标
    let clickRect = null;
    try {
        const fresh = await findVisibleAds(page);
        const same = fresh.find((ad) => ad.position === hit.position);
        clickRect = same ? same.rect : null;
    } catch {
        clickRect = null;
    }
    if (!clickRect) {
        wlog('   ⚠️ 点击前广告不在视口内，跳过点击');
        return null;
    }

    const { x, y } = randomPointInRect(clickRect);
    try {
        await clickAndObserve(page, x, y, hit.position, wlog);
    } catch (e) {
        wlog(`   ⚠️ 点击广告失败: ${e.message}`);
        return null;
    }

    wlog(`   ⏳ 点击后停留 ${params.afterClickSec} 秒`);
    await sleep(params.afterClickSec * 1000);
    return hit.position;
}

/** 非点击访问：等任一配置位置的广告出现后随机停留 5~10 秒，模拟真实曝光会话 */
async function dwellAfterAd(page, positions, wlog) {
    const hit = await waitForAdInPositions(page, positions, NON_CLICK_AD_WAIT_SEC);
    if (!hit) {
        wlog(`   ⚠️ ${NON_CLICK_AD_WAIT_SEC} 秒内未检测到广告，跳过停留`);
        return;
    }

    const dwellMs = NON_CLICK_DWELL_MIN_MS +
        Math.random() * (NON_CLICK_DWELL_MAX_MS - NON_CLICK_DWELL_MIN_MS);
    wlog(`   🙈 [${hit.position}] 广告已出现，停留 ${(dwellMs / 1000).toFixed(1)} 秒`);

    let remaining = dwellMs;
    while (remaining > 0 && !stopping) {
        const chunk = Math.min(remaining, 500);
        await sleep(chunk);
        remaining -= chunk;
    }
}

// ==================== 浏览器生命周期 ====================

const BASE_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--ignore-certificate-errors',
];

// 本地诊断用：VIEWPORT=1920x1080 固定视口尺寸；未设置时沿用真实窗口尺寸
function parseViewport(raw) {
    const m = /^(\d+)x(\d+)$/i.exec((raw || '').trim());
    if (!m) return null;
    const width = parseInt(m[1], 10);
    const height = parseInt(m[2], 10);
    return width > 0 && height > 0 ? { width, height } : null;
}
const LAUNCH_VIEWPORT = parseViewport(process.env.VIEWPORT);

let headlessFlag = DEFAULT_HEADLESS;
const activeContexts = new Set();
let stopping = false;

let prewarmedSlot = null;
let prewarmPromise = null;
let activeSlot = null;

const stats = { rounds: 0, skipped: 0, lastSeed: null, clicksByPos: {} };

/**
 * 启动一个全新的浏览器进程。每次启动随机生成指纹 seed，
 * 该 seed 决定 canvas / WebGL / audio / GPU / 硬件参数等一整组指纹。
 */
async function launchFreshBrowser() {
    const seed = 10000 + Math.floor(Math.random() * 90000);
    const extraArgs = [];
    const launchOptions = {};
    if (LAUNCH_VIEWPORT) {
        extraArgs.push(`--window-size=${LAUNCH_VIEWPORT.width},${LAUNCH_VIEWPORT.height}`);
        launchOptions.defaultViewport = LAUNCH_VIEWPORT;
    }
    const b = await launch({
        headless: headlessFlag,
        humanize: true,
        timezone: 'America/New_York',
        locale: 'en-US',
        args: [...BASE_ARGS, ...extraArgs, `--fingerprint=${seed}`],
        ...(LAUNCH_VIEWPORT ? { launchOptions } : {}),
    });
    tslog(`🧩 浏览器已启动（seed=${seed}，本轮独立指纹` +
        `${LAUNCH_VIEWPORT ? `，视口 ${LAUNCH_VIEWPORT.width}x${LAUNCH_VIEWPORT.height}` : ''}）`);
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

async function createProxyContext(browser) {
    if (typeof browser.createBrowserContext !== 'function') {
        throw new Error('当前浏览器不支持 createBrowserContext');
    }
    return browser.createBrowserContext({ proxyServer: LOCAL_PROXY });
}

/**
 * 向分配服务领取一个已预留（15 天内不会再次下发）的 IP。
 * 403/503 这类明确失败不重试；网络错误和超时最多重试 ALLOCATOR_RETRIES 次。
 */
async function allocateIp() {
    let lastErr;
    for (let attempt = 0; attempt <= ALLOCATOR_RETRIES; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), ALLOCATOR_TIMEOUT_MS);
        try {
            const headers = {};
            if (ALLOCATOR_TOKEN) headers['x-allocator-token'] = ALLOCATOR_TOKEN;
            const res = await fetch(`${ALLOCATOR_URL}/allocate`, { method: 'POST', headers, signal: ac.signal });
            if (res.status === 503) {
                const body = await res.json().catch(() => ({}));
                const err = new Error(body.error || 'no_available_ip');
                err.fatal = true;
                throw err;
            }
            if (!res.ok) {
                throw new Error(`分配服务 HTTP ${res.status}`);
            }
            const data = await res.json();
            if (!data || typeof data.ip !== 'string' || !data.ip) {
                throw new Error('分配服务返回格式异常');
            }
            return data;
        } catch (e) {
            lastErr = e;
            if (e.fatal) break;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr || new Error('分配 IP 失败');
}

/**
 * 用临时页发一次引导请求，让 botAnti3.py 把全局伪装 IP 设为分配的地址。
 * 用独立页面而不是主页面，避免给广告页带上 httpbin.org 的 Referer。
 */
async function sendBootstrapRequest(ctx, ip) {
    const url = `${BOOTSTRAP_BASE}/replaceproxy.html?ip=${encodeURIComponent(ip)}`;
    const page = await ctx.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } finally {
        await page.close().catch(() => {});
    }
}

// ==================== 指纹 ====================

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
            return {
                fp: h,
                gl: gl ? 1 : 0,
                ua: navigator.userAgent,
                uaMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
                platform: navigator.platform,
                screen: `${screen.width}x${screen.height} dpr=${window.devicePixelRatio}`,
                viewport: `${window.innerWidth}x${window.innerHeight}`,
            };
        });
    } catch {
        return { fp: null, gl: null };
    }
}

// ==================== 调度循环 ====================

function formatDay({ year, month, day }) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 美国东部时间的日期+时刻，如 2026-10-31 22:15:03 ET */
function formatEtDateTime(ms) {
    const { year, month, day, hour, minute, second } = etParts(ms);
    const pad = (v) => String(v).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)} ET`;
}

function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
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
            `最近 seed ${stats.lastSeed ?? '-'}`);
        const posRate = Object.entries(stats.clicksByPos)
            .map(([pos, clicks]) =>
                `${pos} ${clicks}/${stats.rounds} (${((clicks / stats.rounds) * 100).toFixed(1)}%)`)
            .join(' | ');
        if (posRate) tslog(`📊 位置点击率: ${posRate}`);
    }
}

/** 执行一次访问；每个广告独立掷 1% 决定是否点击，命中则点第一个出现的，否则停留 5~10 秒 */
async function visitOnce(state, params, icon = '🔵') {
    const { entry } = state;
    const linkNo = state.index + 1;
    const configured = new Set(entry.ads.map((ad) => ad.position));
    const flagged = new Set(
        entry.ads
            .filter((ad) => Math.random() < (ad.clickRate ?? params.clickProbability))
            .map((ad) => ad.position),
    );

    let allocation;
    try {
        allocation = await allocateIp();
    } catch (e) {
        tslog(`⏭️ 链接 #${linkNo} 跳过本次访问：IP 分配失败（${e.message}）`);
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

    let ctx;
    let skipped = false;
    try {
        ctx = await createProxyContext(slot.browser);
        activeContexts.add(ctx);

        const page = await ctx.newPage();
        await page.setCacheEnabled(false).catch(() => {});

        tslog(`${icon} 链接 #${linkNo} 开始访问 → ${entry.url}`);
        tslog(`   本地代理 ${LOCAL_PROXY} | seed ${slot.seed} | 分配 IP ${allocation.ip} (id=${allocation.id})`);

        let bootstrapOk = false;
        for (let attempt = 1; attempt <= 2 && !bootstrapOk; attempt++) {
            try {
                await sendBootstrapRequest(ctx, allocation.ip);
                bootstrapOk = true;
            } catch (e) {
                tslog(`   ⚠️ 引导请求失败（第 ${attempt} 次）: ${e.message}`);
            }
        }
        if (!bootstrapOk) {
            tslog(`⏭️ 链接 #${linkNo} 跳过本次访问：伪装 IP 引导失败`);
            skipped = true;
            return;
        }
        tslog(`   🎭 伪装 IP 已设为 ${allocation.ip}`);

        const fpInfo = await readFingerprint(page);
        tslog(`   🖥️ UA ${fpInfo.ua}`);
        tslog(`   🖥️ mobile=${fpInfo.uaMobile} platform=${fpInfo.platform} ` +
            `screen=${fpInfo.screen} viewport=${fpInfo.viewport}`);

        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

        setupRequestHandler(page, entry, { log: tslog, served: false });

        await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

        let clickedPosition = null;
        if (flagged.size > 0) {
            clickedPosition = await waitForAdAndClick(page, flagged, params, tslog);
            if (clickedPosition) {
                stats.clicksByPos[clickedPosition] = (stats.clicksByPos[clickedPosition] || 0) + 1;
            }
        } else if (!stopping) {
            await dwellAfterAd(page, configured, tslog);
        }

        tslog(`✅ 链接 #${linkNo} 本次访问结束`);
        console.log(`ROUND_SUMMARY link=${linkNo} url=${entry.url} ` +
            `proxy=${LOCAL_PROXY} ip=${allocation.ip} ip_id=${allocation.id} ` +
            `seed=${slot.seed} fp=${fpInfo.fp} gl=${fpInfo.gl} ` +
            `click=${clickedPosition ? 1 : 0} clicked_pos=${clickedPosition || '-'}`);
    } catch (e) {
        tslog(`❌ 链接 #${linkNo} 访问异常: ${e.message}`);
    } finally {
        if (ctx) {
            activeContexts.delete(ctx);
            await ctx.close().catch(() => {});
        }
        activeSlot = null;
        await closeSlot(slot);
        finishRound(skipped);
    }
}

/** 补齐队列并返回最早到期的访问 */
function nextDue(states, params) {
    const now = Date.now();
    for (const s of states) ensureQueue(s, params, now);
    states.sort((a, b) => a.events[0] - b.events[0]);
    return { state: states[0], due: states[0].events[0], now };
}

/** 每个链接独立排程，每次取最早到期的访问执行 */
async function scheduleLoop(entries, params) {
    const states = entries.map((entry, index) => ({ index, entry, events: [], day: null }));

    while (!stopping) {
        const { state: next, due, now } = nextDue(states, params);
        const wait = due - now;

        if (wait > 0) {
            if (wait > PREWARM_LEAD_MS) {
                await sleepInterruptible(wait - PREWARM_LEAD_MS);
                if (stopping) break;
            }
            startPrewarm();
            const remaining = due - Date.now();
            if (remaining > 0) await sleepInterruptible(remaining);
            continue;
        }

        next.events.shift();
        await visitOnce(next, params);

        if (stopping) break;

        const upcoming = nextDue(states, params);
        tslog(`⏭️ 下一轮: 链接 #${upcoming.state.index + 1} → ${upcoming.state.entry.url} | ${formatEtDateTime(upcoming.due)}（约 ${formatDuration(upcoming.due - Date.now())}后）`);
    }
}

/** 关闭计划时的直接轮询：按 1→2→…→N 顺序连续访问，无额外等待 */
async function roundRobinLoop(entries, params) {
    const states = entries.map((entry, index) => ({ index, entry }));
    let cursor = 0;

    while (!stopping) {
        const state = states[cursor];
        cursor = (cursor + 1) % states.length;
        await visitOnce(state, params, '🔁');
    }
}

// ==================== 主流程 ====================

async function run() {
    const params = parseArgs();
    const entries = loadEntries(params.urlsFile);
    headlessFlag = params.headless;
    for (const ad of entries.flatMap((e) => e.ads)) {
        stats.clicksByPos[ad.position] = stats.clicksByPos[ad.position] || 0;
    }

    console.log('🚀 启动 CloakBrowser (mBidadm 访问器)...');
    console.log(`📋 数据列表: ${entries.length} 条 | 文件: ${params.urlsFile}`);
    console.log(`🎯 广告配置: 每页 ${entries.map((e) => e.ads.length).join('/')} 个 | 位置点击率 ` +
        entries.flatMap((e) => e.ads)
            .map((ad) => `${ad.position} ${((ad.clickRate ?? params.clickProbability) * 100).toFixed(0)}%`)
            .join(' | '));
    console.log(`🔀 访问计划: ${SCHEDULE_ENABLED ? `开启（美国东部作息，每链接日均 ${params.visitsPerDay} 次）` : '关闭（多链接轮流连续访问，忽略日均计划）'}`);
    console.log(`⏱️  广告等待: ${params.adTimeoutSec.toFixed(0)} 秒 | 点击后停留: ${params.afterClickSec.toFixed(0)} 秒 | 每广告点击率: ${(params.clickProbability * 100).toFixed(0)}% | 非点击停留: ${NON_CLICK_DWELL_MIN_MS / 1000}~${NON_CLICK_DWELL_MAX_MS / 1000} 秒（广告出现后）`);
    console.log('🌍 出口策略: 每次访问从分配服务领取新 IP + 全新浏览器（独立 seed）+ 隐私上下文 + 本地 mitmproxy socks5');
    console.log(`🖥️  模式: ${params.headless ? '无头' : '有窗口'}`);
    console.log(`📡 本地代理: ${LOCAL_PROXY}（mitmproxy + botAnti3.py）`);
    console.log(`🎯 IP 分配服务: ${ALLOCATOR_URL}`);
    console.log(`🔥 预热: 访问时刻前 ${PREWARM_LEAD_MS / 1000} 秒启动下一轮浏览器\n`);

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