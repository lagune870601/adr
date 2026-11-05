/**
 * adsterraad.js — 打开固定入口，返回本地空页面并注入 Adsterra 广告脚本
 *
 * 用法:
 *   node adsterraad.js
 *
 * 最简版本：默认有窗口启动浏览器，导航到固定入口地址时由请求拦截直接
 * 返回本地空页面（含广告脚本），其余请求一律直连放行。
 * 页面加载后保持窗口不关闭，手动关闭浏览器后脚本退出。
 */

import { launch } from 'cloakbrowser/puppeteer';

const ENTRY_URL = 'http://av.sh99y.com';
const NAV_TIMEOUT_MS = 60000;

const AD_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script>
  atOptions = {
    'key' : '2ca2cea932d0da388343ce66040275f3',
    'format' : 'iframe',
    'height' : 60,
    'width' : 468,
    'params' : {}
  };
</script>
<script src="https://biomanos.org/22/2ca2cea932d0da388343ce66040275f3"></script>
</head>
<body>helloworld</body>
</html>`;

function tslog(msg) {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${t}] ${msg}`);
}

function hostnameOf(u) {
    try {
        return new URL(u).hostname || null;
    } catch {
        return null;
    }
}

/**
 * 主 frame 导航到入口域名时返回本地空页面；
 * 其余请求（含入口域名的其他请求）一律直连放行。
 */
function setupRequestHandler(page) {
    const entryHost = hostnameOf(ENTRY_URL);
    let served = false;

    page.setRequestInterception(true).catch(() => {});
    page.on('request', (req) => {
        const host = hostnameOf(req.url());
        if (host && host === entryHost &&
            req.isNavigationRequest() && req.frame() === page.mainFrame()) {
            if (!served) {
                served = true;
                tslog('📄 返回本地空页面（helloworld + 广告脚本）');
            }
            req.respond({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: AD_HTML,
            }).catch(() => {});
            return;
        }
        req.continue().catch(() => {});
    });
}

async function run() {
    tslog('🚀 启动 CloakBrowser (adsterra 广告展示)...');
    tslog(`🌐 入口: ${ENTRY_URL}`);

    const browser = await launch({ headless: false });

    // 浏览器被手动关闭时结束等待
    const closed = new Promise((resolve) => browser.once('disconnected', resolve));

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    setupRequestHandler(page);

    await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    tslog('✅ 页面已加载，保持窗口打开；手动关闭浏览器后脚本退出');

    await closed;
    tslog('👋 浏览器已关闭，退出');
}

process.on('SIGINT', () => {
    tslog('👋 收到退出信号');
    process.exit(0);
});

run().catch((error) => {
    console.error('❌ 未捕获的错误:', error);
    process.exit(1);
});