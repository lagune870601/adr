/**
 * adspower-signup.js — AdsPower 浏览器 + Puppeteer 注册脚本
 *
 * 通过 AdsPower Local API 创建新浏览器环境（带固定代理），用 Puppeteer 连接，
 * 执行 Adsterra Publisher 注册流程，完成后自动删除环境。
 *
 * 用法：
 *   node adspower-signup.js
 *
 * 前置条件：
 *   - AdsPower 客户端已启动，Local API 已开启（端口 50325）
 *   - crawler_task 表中有 REGISTER 类型的待处理任务
 */

import puppeteer from 'puppeteer-core';
import { signupCrawler } from './signup.js';
import { getTask, updateTaskStatus, incrementRetryCount } from './shared/db.js';

// ==================== 配置 ====================

const ADSPOWER_API = 'http://127.0.0.1:50325';
const ADSPOWER_API_KEY = '258899d8b81372ad12e39984490b7bfe00a391492100749c';
const ADSPOWER_PROFILE_ID = 'k1jbobt6'; // 固定环境，常驻复用

// 固定代理配置（SOCKS5）
const FIXED_PROXY_HOST = '104.233.202.50';
const FIXED_PROXY_PORT = 17893;
const FIXED_PROXY_TYPE = 'socks5';
const FIXED_PROXY_USER = 'chenchao';
const FIXED_PROXY_PASSWORD = 'chenchao';

// 循环与重连配置
const TASK_INTERVAL_BASE_MS = 10 * 60 * 1000;   // 任务间隔基数 10 分钟
const TASK_INTERVAL_JITTER_MS = 5 * 60 * 1000;  // 随机抖动 0~5 分钟
const POLL_INTERVAL = 10000;                    // 无任务时轮询间隔
const RECONNECT_MAX_FAILURES = 5;               // 连续重连失败次数上限
const RECONNECT_BASE_DELAY_MS = 10000;          // 重连指数退避基数

// ==================== 工具函数 ====================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 调用 AdsPower Local API（使用 Bearer Token 认证）
 */
async function adsPowerApi(path, params = {}) {
    const url = new URL(path, ADSPOWER_API);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, String(v));
        }
    });

    console.log(`📡 API: ${path}${url.search.toString()}`);

    const resp = await fetch(url.toString(), {
        headers: {
            Authorization: `Bearer ${ADSPOWER_API_KEY}`,
        },
    });
    const data = await resp.json();

    if (data.code !== 0) {
        throw new Error(`AdsPower API 错误 (code=${data.code}): ${data.msg || JSON.stringify(data)}`);
    }

    return data;
}

/**
 * 调用 AdsPower Local API（POST 请求）
 */
async function adsPowerApiPost(path, body = {}) {
    const url = new URL(path, ADSPOWER_API);
    console.log(`📡 API POST: ${path}`);

    const resp = await fetch(url.toString(), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ADSPOWER_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const data = await resp.json();

    if (data.code !== 0) {
        throw new Error(`AdsPower API 错误 (code=${data.code}): ${data.msg || JSON.stringify(data)}`);
    }

    return data;
}

/**
 * 获取默认分组 ID（取第一个分组，没有则自动创建）
 */
async function getDefaultGroupId() {
    const result = await adsPowerApi('/api/v1/group/list');
    const groups = result.data?.list || [];

    if (groups.length > 0) {
        const groupId = groups[0].group_id;
        console.log(`   📂 使用分组: ${groups[0].group_name} (group_id=${groupId})`);
        return groupId;
    }

    // 没有分组 → 自动创建一个
    console.log('   📂 没有分组，自动创建默认分组...');
    const createResult = await adsPowerApiPost('/api/v1/group/create', {
        group_name: 'Default',
    });
    const newGroupId = createResult.data?.group_id;
    console.log(`   ✅ 默认分组已创建: group_id=${newGroupId}`);
    return newGroupId;
}

/**
 * 创建新的浏览器环境（带固定代理配置）
 * @param {string} name - 环境名称
 * @param {object} proxyConfig - 代理配置 { host, port, type }
 * @returns {Promise<string>} 新环境的 user_id
 */
async function createProfile(name, proxyConfig = {}) {
    const groupId = await getDefaultGroupId();

    const body = {
        name: name,
        group_id: groupId,
        user_proxy_config: {
            proxy_soft: 'other',
            proxy_type: proxyConfig.type || 'socks5',
            proxy_host: proxyConfig.host || FIXED_PROXY_HOST,
            proxy_port: String(proxyConfig.port || FIXED_PROXY_PORT),
            proxy_user: proxyConfig.username || FIXED_PROXY_USER,
            proxy_password: proxyConfig.password || FIXED_PROXY_PASSWORD,
        },
        fingerprint_config: {
            random_ua: {
                ua_system_version: ['Windows'],  // 操作系统
            },
        },
    };

    console.log(`   🔧 代理配置: ${body.user_proxy_config.proxy_type}://${body.user_proxy_config.proxy_host}:${body.user_proxy_config.proxy_port}`);

    const result = await adsPowerApiPost('/api/v2/browser-profile/create', body);
    const userId = result.data?.profile_id || result.data?.id || result.data?.user_id;
    console.log(`✅ 环境已创建: user_id=${userId}`);
    return userId;
}

/**
 * 删除浏览器环境
 * @param {string} userId - 环境的 user_id
 */
async function deleteProfile(userId) {
    try {
        const result = await adsPowerApiPost('/api/v2/browser-profile/delete', {
            profile_ids: [userId],
        });
        console.log(`✅ 环境已删除: user_id=${userId}`);
        return result;
    } catch (e) {
        console.warn(`⚠️  删除环境失败: ${e.message}`);
    }
}

/**
 * 启动浏览器环境
 */
async function startBrowser(profileId) {
    const params = { user_id: profileId };

    const result = await adsPowerApi('/api/v1/browser/start', params);
    return result.data;
}

/**
 * 停止浏览器环境
 */
async function stopBrowser(profileId) {
    try {
        const params = {};
        if (profileId) params.user_id = profileId;
        await adsPowerApi('/api/v1/browser/stop', params);
        console.log('✅ 浏览器环境已关闭');
    } catch (e) {
        console.warn('⚠️  关闭浏览器失败:', e.message);
    }
}

/**
 * 等待浏览器调试端口就绪
 */
async function waitForBrowser(wsEndpoint, maxWaitMs = 30000) {
    // 从 ws endpoint 提取 http URL
    const httpUrl = wsEndpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '');
    const versionUrl = `${httpUrl}/json/version`;

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const resp = await fetch(versionUrl);
            const data = await resp.json();
            console.log(`✅ 浏览器就绪 (${Math.round((Date.now() - start) / 1000)}s)`);
            console.log(`   Browser: ${data.Browser}`);
            return data;
        } catch (e) {
            await sleep(500);
        }
    }
    throw new Error('浏览器启动超时');
}

// ==================== 浏览器连接（常驻复用） ====================

let browser = null;
let reconnectFailures = 0;

/**
 * 解析 AdsPower 环境的 WebSocket 地址：
 * 已打开则复用（browser/active），否则启动（browser/start）
 */
async function resolveAdsPowerWs() {
    try {
        const active = await adsPowerApi('/api/v1/browser/active', { user_id: ADSPOWER_PROFILE_ID });
        const ws = active.data?.ws?.puppeteer;
        if (active.data?.status === 'Active' && ws) {
            console.log(`   ♻️ 复用已打开的环境: ${ADSPOWER_PROFILE_ID}`);
            return ws;
        }
    } catch (e) {
        console.log(`   ℹ️ 查询活动状态失败，尝试启动: ${e.message}`);
    }

    const started = await adsPowerApi('/api/v1/browser/start', { user_id: ADSPOWER_PROFILE_ID });
    const ws = started.data?.ws?.puppeteer;
    if (!ws) throw new Error('AdsPower 未返回 Puppeteer WebSocket 地址');
    console.log(`   ▶️ 已启动环境: ${ADSPOWER_PROFILE_ID}`);
    return ws;
}

async function connectOnce(forceRestart = false) {
    let wsEndpoint;
    if (forceRestart) {
        wsEndpoint = await restartProfile();
    } else {
        wsEndpoint = await resolveAdsPowerWs();
    }
    await waitForBrowser(wsEndpoint);

    const b = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null,
        protocolTimeout: 180000,
    });

    b.on('disconnected', () => {
        if (browser === b) {
            browser = null;
            console.warn('⚠️ AdsPower 浏览器连接已断开');
        }
    });

    await setupBandwidthSaving(b);
    return b;
}

/**
 * 停掉再启动 AdsPower 环境。已打开的会话可能残留失效的代理凭据，
 * 表现为 ws 连得上但所有导航都是 ERR_SOCKS_CONNECTION_FAILED
 */
async function restartProfile() {
    console.log('   🔄 重启 AdsPower 环境（清理失效的代理会话）...');
    try {
        await adsPowerApi('/api/v1/browser/stop', { user_id: ADSPOWER_PROFILE_ID });
    } catch (e) {
        console.log(`   ℹ️ 停止环境: ${e.message}`);
    }
    await sleep(3000);
    const started = await adsPowerApi('/api/v1/browser/start', { user_id: ADSPOWER_PROFILE_ID });
    const ws = started.data?.ws?.puppeteer;
    if (!ws) throw new Error('重启 AdsPower 环境后未返回 WebSocket 地址');
    console.log('   ✅ AdsPower 环境已重启');
    return ws;
}

/**
 * 用极小请求确认浏览器出口网络可用（代理失效时 ws 仍可连接）
 * 注意：gstatic/google 的 generate_204 经此 SOCKS5 代理会被 Chrome 报
 * net::ERR_ABORTED，换成一个返回 200 的极简端点
 */
async function checkBrowserNetwork(b) {
    let page;
    try {
        page = await b.newPage();
        const res = await page.goto('https://api.ipify.org/?format=json', {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
        });
        return !!res && res.status() === 200;
    } catch (e) {
        console.warn(`   ⚠️ 网络自检失败: ${e.message}`);
        return false;
    } finally {
        await page?.close().catch(() => {});
    }
}

/**
 * 确保浏览器处于已连接状态；断线时按指数退避重连，
 * 连续失败 RECONNECT_MAX_FAILURES 次后抛出致命错误
 */
async function ensureBrowser() {
    if (browser && browser.isConnected()) {
        if (await checkBrowserNetwork(browser)) return browser;
        console.warn('⚠️ 浏览器已连接但出口网络不通，强制重启环境');
        try {
            browser.disconnect();
        } catch {
            // 已断开
        }
        browser = null;
        // 至少走到“强制重启环境”的分支
        reconnectFailures = Math.max(reconnectFailures, 2);
    }

    while (true) {
        try {
            const forceRestart = reconnectFailures >= 2;
            console.log(`\n🔗 连接 AdsPower 浏览器...${forceRestart ? '（强制重启环境）' : ''}`);
            browser = await connectOnce(forceRestart);
            if (!(await checkBrowserNetwork(browser))) {
                throw new Error('网络自检失败（代理不可用）');
            }
            reconnectFailures = 0;
            console.log('✅ Puppeteer 已连接');
            return browser;
        } catch (e) {
            reconnectFailures++;
            console.error(`💥 连接失败（连续 ${reconnectFailures}/${RECONNECT_MAX_FAILURES}）: ${e.message}`);
            if (reconnectFailures >= RECONNECT_MAX_FAILURES) {
                const fatal = new Error(`连续 ${RECONNECT_MAX_FAILURES} 次连接 AdsPower 失败，退出进程`);
                // 用独立标记，避免与 mysql2 连接错误的 err.fatal 冲突
                fatal.adspowerFatal = true;
                throw fatal;
            }
            const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectFailures - 1);
            console.log(`⏳ ${Math.round(delay / 1000)}s 后重连...`);
            await sleep(delay);
        }
    }
}

// ==================== 省流（节省代理流量） ====================

// 直接按资源类型拦截
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

// 第三方统计/分析域名（按域名后缀匹配）
const TRACKER_HOST_PATTERNS = [
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'facebook.net',
    'hotjar.com',
    'hotjar.io',
    'clarity.ms',
    'mc.yandex.ru',
    'segment.com',
    'segment.io',
    'mixpanel.com',
    'sentry.io',
    'amplitude.com',
    'posthog.com',
    'statcounter.com',
];

const bandwidthStats = {
    byType: Object.create(null),
    byTracker: Object.create(null),
};

/**
 * 判断请求是否命中第三方统计域名，命中返回域名，否则返回 null
 */
function matchedTrackerHost(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        const hit = TRACKER_HOST_PATTERNS.find(p => host === p || host.endsWith(`.${p}`));
        if (hit) return host;
        // Facebook Pixel 走 www.facebook.com/tr
        if (host === 'facebook.com' || host.endsWith('.facebook.com')) {
            if (u.pathname.startsWith('/tr')) return host;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 对 browser 下所有页面（含之后新建的页面）开启请求拦截，实现省流
 */
async function setupBandwidthSaving(browser) {
    const attached = new WeakSet();

    const attach = async (page) => {
        if (!page || attached.has(page)) return;
        attached.add(page);

        const onRequest = (req) => {
            try {
                const url = req.url();
                if (!/^https?:/i.test(url)) {
                    return req.continue();
                }

                // Cloudflare 挑战资源一律放行，避免影响 Turnstile 校验
                try {
                    const host = new URL(url).hostname.toLowerCase();
                    if (host === 'cloudflare.com' || host.endsWith('.cloudflare.com')) {
                        return req.continue();
                    }
                } catch {
                    // URL 解析失败则走后续规则
                }

                const trackerHost = matchedTrackerHost(url);
                if (trackerHost) {
                    bandwidthStats.byTracker[trackerHost] = (bandwidthStats.byTracker[trackerHost] || 0) + 1;
                    return req.abort('blockedbyclient');
                }

                const type = req.resourceType();
                if (BLOCKED_RESOURCE_TYPES.has(type)) {
                    bandwidthStats.byType[type] = (bandwidthStats.byType[type] || 0) + 1;
                    return req.abort('blockedbyclient');
                }

                return req.continue();
            } catch {
                // 请求可能已被处理或页面已关闭
            }
        };

        // 必须先注册 handler 再开启拦截：反过来会让进行中的请求无人处理而报
        // net::ERR_ABORTED / Navigation timeout
        page.on('request', onRequest);
        try {
            await page.setRequestInterception(true);
        } catch {
            page.off('request', onRequest);
        }
    };

    // 覆盖之后新开的页面（signup.js 内部会多次 newPage）
    browser.on('targetcreated', async (target) => {
        if (target.type() !== 'page') return;
        try {
            await attach(await target.page());
        } catch {
            // target 已销毁
        }
    });

    // 覆盖当前已存在的页面
    for (const page of await browser.pages()) {
        await attach(page);
    }

    console.log('🧊 省流模式已开启：拦截 图片/媒体/字体 + 第三方统计域名');
}

function logBandwidthStats() {
    const byType = Object.entries(bandwidthStats.byType);
    const byTracker = Object.entries(bandwidthStats.byTracker);
    const total = [...byType, ...byTracker].reduce((sum, [, n]) => sum + n, 0);

    if (total === 0) {
        console.log('🧊 省流汇总：本轮未拦截到请求');
        return;
    }

    console.log(`\n🧊 省流汇总：共拦截 ${total} 个请求`);
    if (byType.length) {
        console.log(`   按类型: ${byType.map(([k, n]) => `${k}=${n}`).join(', ')}`);
    }
    if (byTracker.length) {
        console.log(`   第三方统计: ${byTracker.map(([k, n]) => `${k}=${n}`).join(', ')}`);
    }
}

function resetBandwidthStats() {
    for (const key of Object.keys(bandwidthStats.byType)) delete bandwidthStats.byType[key];
    for (const key of Object.keys(bandwidthStats.byTracker)) delete bandwidthStats.byTracker[key];
}

// ==================== 主流程 ====================

const proxy = {
    url: `${FIXED_PROXY_TYPE}://${FIXED_PROXY_USER}:${FIXED_PROXY_PASSWORD}@${FIXED_PROXY_HOST}:${FIXED_PROXY_PORT}`,
    host: FIXED_PROXY_HOST,
    port: FIXED_PROXY_PORT,
    username: FIXED_PROXY_USER,
    password: FIXED_PROXY_PASSWORD,
};

let lastTaskStartedAt = 0;
let currentTask = null;
let shuttingDown = false;

/**
 * 两条任务之间保持 10~15 分钟随机间隔
 */
async function waitForTaskInterval() {
    if (!lastTaskStartedAt) return;
    const interval = TASK_INTERVAL_BASE_MS + Math.floor(Math.random() * (TASK_INTERVAL_JITTER_MS + 1));
    const waitMs = lastTaskStartedAt + interval - Date.now();
    if (waitMs <= 0) return;
    console.log(`⏲️ 距上次任务开始不足 ${Math.round(interval / 60000)} 分钟，等待 ${Math.ceil(waitMs / 1000)}s...`);
    await sleep(waitMs);
}

async function executeTask(task) {
    console.log(`\n========== 处理任务 #${task.id} ==========`);
    console.log(`   用户名: ${task.username}, 邮箱: ${task.email}`);

    await updateTaskStatus(task.id, 'processing');
    currentTask = task;
    lastTaskStartedAt = Date.now();
    resetBandwidthStats();

    let result;
    try {
        result = await signupCrawler(task, proxy, browser);
    } catch (err) {
        console.error('💥 注册流程异常:', err.message);
        result = { success: false, retryable: true, error: err.message };
    }

    console.log(`\n========== 任务 #${task.id} 结果 ==========`);
    try {
        if (result.success) {
            console.log('✅ 任务执行成功');
            await updateTaskStatus(task.id, 'completed');
        } else if (result.retryable) {
            console.log(`🔄 任务需重试: ${result.error}`);
            await incrementRetryCount(task.id);
            await updateTaskStatus(task.id, 'retry');
        } else {
            console.log(`❌ 任务失败: ${result.error}`);
            await updateTaskStatus(task.id, 'failed');
        }
    } finally {
        currentTask = null;
        logBandwidthStats();
    }
}

async function mainLoop() {
    console.log('🚀 AdsPower + Puppeteer 注册调度器\n');
    console.log('='.repeat(60));

    while (!shuttingDown) {
        try {
            await ensureBrowser();

            console.log('\n📋 获取 REGISTER 任务...');
            const task = await getTask(['REGISTER']);
            if (!task) {
                await sleep(POLL_INTERVAL);
                continue;
            }

            await waitForTaskInterval();
            if (shuttingDown) break;
            await executeTask(task);
        } catch (e) {
            if (e.adspowerFatal) throw e;
            console.error('💥 主调度器异常:', e.message);
            console.log(`⏳ ${POLL_INTERVAL / 1000}s 后重试...`);
            await sleep(POLL_INTERVAL);
        }
    }
}

async function shutdown(signal) {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`\n\n👋 收到 ${signal}，正在关闭调度器...`);

    if (currentTask) {
        try {
            await updateTaskStatus(currentTask.id, 'pending');
            console.log(`   ↩️ 任务 #${currentTask.id} 已回滚为 pending`);
        } catch (e) {
            console.error(`   ⚠️  回滚任务 #${currentTask.id} 失败: ${e.message}`);
        }
    }

    try {
        if (browser) browser.disconnect();
        console.log('   🔌 Puppeteer 已断开（AdsPower 浏览器保持运行）');
    } catch (e) {
        console.error(`   ⚠️  断开失败: ${e.message}`);
    }

    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── 运行 ───
mainLoop().catch(err => {
    console.error('\n❌ 错误:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});