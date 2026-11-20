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
const ADSPOWER_API_KEY = 'ba609fbb951882c021f08fd7338054270090581adbbd2d62';

// 固定代理配置（SOCKS5）
const FIXED_PROXY_HOST = '104.233.202.50';
const FIXED_PROXY_PORT = 17893;
const FIXED_PROXY_TYPE = 'socks5';

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
            proxy_user: proxyConfig.username || '',
            proxy_password: proxyConfig.password || '',
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

// ==================== 省流（节省代理流量） ====================

// 直接按资源类型拦截
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

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

        try {
            await page.setRequestInterception(true);
        } catch {
            return; // 页面可能正在关闭
        }

        page.on('request', (req) => {
            try {
                const url = req.url();
                if (!/^https?:/i.test(url)) {
                    return req.continue();
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
        });
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

    console.log('🧊 省流模式已开启：拦截 图片/媒体/字体/CSS + 第三方统计域名');
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

// ==================== 主流程 ====================

async function main() {
    console.log('🚀 AdsPower + Puppeteer 注册脚本\n');
    console.log('='.repeat(60));

    // ─── 1. 获取任务 ───
    console.log('\n📋 获取 REGISTER 任务...');
    const task = await getTask(['REGISTER']);
    if (!task) {
        console.log('❌ 没有待处理的 REGISTER 任务，请先在 crawler_task 表中准备数据');
        return;
    }

    // ─── 2. 创建新环境（带固定代理） ───
    // TODO: 临时使用固定环境 106 测试，测试完恢复 createProfile
    console.log('\n🔧 使用固定环境 106...');
    const userId = 'k1j6mm6r'; // 临时：serial_number=105
    console.log(`🎯 使用环境: user_id=${userId}`);

    // 构造代理对象（供 signupCrawler 的 page.authenticate 使用）
    const proxy = {
        url: `${FIXED_PROXY_TYPE}://${FIXED_PROXY_HOST}:${FIXED_PROXY_PORT}`,
        host: FIXED_PROXY_HOST,
        port: FIXED_PROXY_PORT,
        username: '',
        password: '',
    };

    // ─── 3. 启动 AdsPower 浏览器 ───
    console.log('\n🔧 启动 AdsPower 浏览器环境...');
    const browserData = await startBrowser(userId);
    console.log(`✅ 浏览器已启动`);
    console.log(`   WebSocket: ${browserData.ws?.puppeteer || browserData.ws}`);

    // ─── 4. 等待浏览器就绪 ───
    console.log('\n⏳ 等待浏览器就绪...');
    await waitForBrowser(browserData.ws?.puppeteer || browserData.ws);

    // ─── 5. 连接 Puppeteer ───
    console.log('\n🔗 连接 Puppeteer...');
    const browser = await puppeteer.connect({
        browserWSEndpoint: browserData.ws?.puppeteer || browserData.ws,
        defaultViewport: null,
    });
    console.log('✅ Puppeteer 已连接');

    // ─── 5.5 开启省流拦截 ───
    console.log('\n🧊 开启省流拦截...');
    await setupBandwidthSaving(browser);

    // ─── 6. 执行注册 ───
    console.log('\n▶️  开始执行注册流程...\n');
    console.log('='.repeat(60));

    await updateTaskStatus(task.id, 'processing');

    let result;
    try {
        result = await signupCrawler(task, proxy, browser);
    } catch (err) {
        console.error('💥 注册流程异常:', err.message);
        result = { success: false, retryable: true, error: err.message };
    }

    // ─── 7. 处理结果 ───
    console.log(`\n========== 任务 #${task.id} 结果 ==========`);
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

    // ─── 8. 清理 ───
    console.log('\n🔌 断开 Puppeteer...');
    await browser.disconnect();
    console.log('✅ Puppeteer 已断开');

    await stopBrowser(userId);

    // 删除环境（暂时注释，后续手动清理）
    // await deleteProfile(userId);

    logBandwidthStats();

    console.log('\n🎉 脚本完成！');
}

// ─── 运行 ───
main().catch(err => {
    console.error('\n❌ 错误:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});