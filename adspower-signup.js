/**
 * adspower-signup.js — AdsPower 浏览器 + Puppeteer 注册脚本
 *
 * 通过 AdsPower Local API 启动浏览器环境，用 Puppeteer 连接，
 * 执行 Adsterra Publisher 注册流程。
 *
 * 用法：
 *   node adspower-signup.js
 *
 * 前置条件：
 *   - AdsPower 客户端已启动，Local API 已开启（端口 50325）
 *   - 已在 AdsPower 中创建至少一个浏览器环境
 *   - crawler_task 表中有 REGISTER 类型的待处理任务
 */

import puppeteer from 'puppeteer-core';
import { signupCrawler } from './signup.js';
import { getTask, updateTaskStatus, incrementRetryCount } from './shared/db.js';
import { createProxy } from './shared/proxy-utils.js';

// ==================== 配置 ====================

const ADSPOWER_API = 'http://127.0.0.1:50325';
const ADSPOWER_API_KEY = '1bf5df8fe0c39df2d1c395dd9d45250600900ced223770de';
const PROFILE_ID = ''; // 指定环境 ID，留空则使用第一个环境

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
 * 获取环境列表
 */
async function listProfiles() {
    const result = await adsPowerApi('/api/v1/user/list');
    const list = result.data?.list || [];
    return list;
}

/**
 * 启动浏览器环境
 */
async function startBrowser(profileId, proxyConfig = null) {
    const params = {};

    if (profileId) {
        params.user_id = profileId;
    } else {
        params.serial_number = '1';
    }

    // 代理配置
    if (proxyConfig) {
        const proxyType = (proxyConfig.url || '').startsWith('socks5') ? 'socks5' : 'http';
        params.proxy_type = proxyType;
        params.proxy_host = proxyConfig.host;
        params.proxy_port = String(proxyConfig.port);
        if (proxyConfig.username) {
            params.proxy_user = proxyConfig.username;
        }
        if (proxyConfig.password) {
            params.proxy_password = proxyConfig.password;
        }
        console.log(`   🔧 代理配置: ${proxyType}://${proxyConfig.host}:${proxyConfig.port}`);
    }

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

// ==================== 主流程 ====================

async function main() {
    console.log('🚀 AdsPower + Puppeteer 注册脚本\n');
    console.log('='.repeat(60));

    // ─── 1. 获取环境列表 ───
    console.log('\n📋 获取 AdsPower 环境列表...');
    let profiles;
    try {
        profiles = await listProfiles();
    } catch (err) {
        console.error('❌ 无法连接 AdsPower API，请确认：');
        console.error('   1. AdsPower 客户端已启动');
        console.error('   2. Local API 已开启（设置 → 账号设置 → 本地API）');
        console.error(`   3. API 地址正确: ${ADSPOWER_API}`);
        throw err;
    }

    if (profiles.length === 0) {
        console.log('❌ 没有找到任何环境，请先在 AdsPower 中创建环境！');
        return;
    }

    console.log(`✅ 找到 ${profiles.length} 个环境:\n`);
    profiles.forEach((p, i) => {
        console.log(`   ${i + 1}. [${p.serial_number}] ${p.name || p.user_id} (${p.group_name || '未分组'})`);
    });

    // ─── 2. 选择目标环境 ───
    let targetProfile;
    if (PROFILE_ID) {
        targetProfile = profiles.find(p => p.user_id === PROFILE_ID);
        if (!targetProfile) {
            console.log(`\n❌ 未找到 user_id="${PROFILE_ID}" 的环境`);
            return;
        }
    } else {
        targetProfile = profiles[0];
    }
    console.log(`\n🎯 使用环境: [${targetProfile.serial_number}] ${targetProfile.name || targetProfile.user_id}`);

    // ─── 3. 获取任务 ───
    console.log('\n📋 获取 REGISTER 任务...');
    const task = await getTask(['REGISTER']);
    if (!task) {
        console.log('❌ 没有待处理的 REGISTER 任务，请先在 crawler_task 表中准备数据');
        return;
    }

    // ─── 4. 获取代理 ───
    console.log('\n🔌 获取代理...');
    const { proxy, manager: proxyManager } = await createProxy();
    console.log(`   代理: ${proxy.host}:${proxy.port} (${proxy.url?.startsWith('socks5') ? 'SOCKS5' : 'HTTP'})`);

    // ─── 5. 启动 AdsPower 浏览器 ───
    console.log('\n🔧 启动 AdsPower 浏览器环境...');
    const browserData = await startBrowser(targetProfile.user_id, proxy);
    console.log(`✅ 浏览器已启动`);
    console.log(`   WebSocket: ${browserData.ws?.puppeteer || browserData.ws}`);

    // ─── 6. 等待浏览器就绪 ───
    console.log('\n⏳ 等待浏览器就绪...');
    await waitForBrowser(browserData.ws?.puppeteer || browserData.ws);

    // ─── 7. 连接 Puppeteer ───
    console.log('\n🔗 连接 Puppeteer...');
    const browser = await puppeteer.connect({
        browserWSEndpoint: browserData.ws?.puppeteer || browserData.ws,
        defaultViewport: null,
    });
    console.log('✅ Puppeteer 已连接');

    // ─── 8. 执行注册 ───
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

    // ─── 9. 处理结果 ───
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

    // ─── 10. 清理 ───
    console.log('\n🔌 断开 Puppeteer...');
    await browser.disconnect();
    console.log('✅ Puppeteer 已断开');

    await stopBrowser(targetProfile.user_id);

    if (proxyManager) {
        proxyManager.destroy();
    }

    console.log('\n🎉 脚本完成！');
}

// ─── 运行 ───
main().catch(err => {
    console.error('\n❌ 错误:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});