/**
 * adspower-demo.js — 启动浏览器 + Puppeteer 连接 Demo
 *
 * 通过命令行启动浏览器，开启远程调试端口，使用 Puppeteer 连接并操控浏览器。
 *
 * 功能：
 * 1. 启动 Chrome/Chromium 浏览器（带远程调试端口）
 * 2. 使用 Puppeteer 连接浏览器
 * 3. 查看当前浏览器环境信息（指纹、UA、时区等）
 * 4. 打开 ifconfig.me 查看出口 IP
 *
 * 用法：
 *   node adspower-demo.js
 *
 * 说明：
 *   SunBrowser.exe（AdsPower 内核）在当前 Windows 版本（build 26200）上存在兼容性问题
 *   （异常 0xc000000d），脚本会自动回退到系统 Chrome 或 AdsPower 内核目录中的 Chromium 引擎。
 */

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

// ==================== 配置 ====================

const DEBUG_PORT = 9222;
const AUTO_CLOSE_SEC = 30; // 浏览器保持打开秒数，0 = 不自动关闭

// ==================== 工具函数 ====================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 查找可用的浏览器可执行文件路径
 * 优先级：Chrome > SunBrowser > 其他 Chromium
 */
function findBrowser() {
    // 候选路径列表
    const candidates = [
        // 系统 Chrome
        join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        // AdsPower SunBrowser（可能因兼容性问题无法启动）
        join(process.env.APPDATA, 'adspower_global', 'cwd_global', 'chrome_148', 'SunBrowser.exe'),
        // Edge
        join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    throw new Error('未找到可用的浏览器！请安装 Chrome 或 Edge');
}

/**
 * 等待浏览器调试端口就绪
 */
async function waitForBrowser(url, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const resp = await fetch(url);
            const data = await resp.json();
            console.log(`✅ 浏览器已就绪 (${Math.round((Date.now() - start) / 1000)}s)`);
            return data;
        } catch (e) {
            await sleep(500);
        }
    }
    throw new Error('浏览器启动超时');
}

// ==================== 主流程 ====================

async function main() {
    console.log('🚀 浏览器 + Puppeteer Demo\n');
    console.log('='.repeat(60));

    // ─── 1. 查找浏览器 ───
    const browserPath = findBrowser();
    const isSunBrowser = browserPath.toLowerCase().includes('sunbrowser');
    console.log(`\n📁 浏览器路径: ${browserPath}`);
    if (isSunBrowser) {
        console.log('   ⚠️  SunBrowser 在当前 Windows 版本上可能存在兼容性问题');
    }

    // ─── 2. 创建临时用户数据目录 ───
    const userDataDir = join(tmpdir(), `browser-demo-${randomBytes(4).toString('hex')}`);
    fs.mkdirSync(userDataDir, { recursive: true });
    console.log(`📂 用户数据目录: ${userDataDir}`);

    // ─── 3. 启动浏览器 ───
    console.log(`\n🔧 启动浏览器 (调试端口: ${DEBUG_PORT})...`);

    const browserProcess = spawn(browserPath, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        '--disable-background-mode',
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        'about:blank',
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });

    // 收集浏览器输出用于调试
    let browserStderr = '';
    browserProcess.stderr?.on('data', (d) => { browserStderr += d.toString(); });

    browserProcess.on('error', (err) => {
        console.error('❌ 启动浏览器失败:', err.message);
    });

    browserProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            console.log(`   浏览器进程退出 (code=${code})`);
            if (browserStderr) console.log(`   stderr: ${browserStderr.slice(0, 300)}`);
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    });

    const debugUrl = `http://127.0.0.1:${DEBUG_PORT}`;

    let browser;
    try {
        // ─── 4. 等待浏览器就绪 ───
        console.log('⏳ 等待浏览器启动...');
        const browserInfo = await waitForBrowser(`${debugUrl}/json/version`);
        console.log(`   浏览器: ${browserInfo.Browser}`);
        console.log(`   用户代理: ${browserInfo['User-Agent']?.slice(0, 80)}...`);

        // ─── 5. 连接 Puppeteer ───
        console.log('\n🔗 连接 Puppeteer...');
        browser = await puppeteer.connect({
            browserURL: debugUrl,
            defaultViewport: null,
        });
        console.log('✅ Puppeteer 已连接');

        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        console.log(`   当前已有 ${pages.length} 个页面`);

        // ─── 6. 查看浏览器环境信息 ───
        console.log('\n📊 浏览器环境信息:');
        console.log('='.repeat(60));

        const envInfo = await page.evaluate(() => {
            return {
                userAgent: navigator.userAgent,
                language: navigator.language,
                languages: JSON.stringify(navigator.languages),
                platform: navigator.platform,
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: navigator.deviceMemory || 'N/A',
                screenResolution: `${window.screen.width}x${window.screen.height}`,
                colorDepth: window.screen.colorDepth,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                webdriver: navigator.webdriver,
                cookieEnabled: navigator.cookieEnabled,
                doNotTrack: navigator.doNotTrack,
                vendor: navigator.vendor,
                productSub: navigator.productSub,
                maxTouchPoints: navigator.maxTouchPoints,
                pdfViewerEnabled: navigator.pdfViewerEnabled,
            };
        });

        Object.entries(envInfo).forEach(([key, value]) => {
            console.log(`   ${key.padEnd(20)}: ${value}`);
        });

        // ─── 7. 打开 ifconfig.me ───
        console.log('\n🌐 打开 ifconfig.me 查看出口 IP...');
        console.log('='.repeat(60));

        await page.goto('https://ifconfig.me', {
            waitUntil: 'networkidle0',
            timeout: 30000,
        });

        console.log(`   当前 URL: ${page.url()}`);
        const pageTitle = await page.title();
        console.log(`   页面标题: ${pageTitle}`);

        const ipText = await page.evaluate(() => {
            return document.body?.innerText?.trim() || '无法获取';
        });

        console.log(`   出口 IP  : ${ipText}`);
        console.log('='.repeat(60));

        // ─── 8. 保持浏览器打开 ───
        if (AUTO_CLOSE_SEC > 0) {
            console.log(`\n⏳ 浏览器保持打开 ${AUTO_CLOSE_SEC} 秒，按 Ctrl+C 可提前退出...\n`);
            await sleep(AUTO_CLOSE_SEC * 1000);
        } else {
            console.log('\n⏳ 浏览器保持打开状态，按 Ctrl+C 退出...\n');
            await new Promise(() => {});
        }

    } finally {
        // ─── 9. 清理 ───
        console.log('\n🔌 断开 Puppeteer 连接...');
        if (browser) {
            await browser.disconnect().catch(() => {});
            console.log('✅ Puppeteer 已断开');
        }

        if (browserProcess.exitCode === null) {
            console.log('🛑 关闭浏览器...');
            browserProcess.kill();
        }
        console.log('✅ 浏览器已关闭');

        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }

    console.log('\n🎉 Demo 完成！');
}

// ─── 运行 ───
main().catch(err => {
    console.error('\n❌ 错误:', err.message);
    process.exit(1);
});