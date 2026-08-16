import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import { createProxy } from './shared/proxy-utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

// ==================== 配置常量 ====================

// 目标 URL 数组，每个链接可配置每日访问量
const TARGET_URLS = [
    //{ url: 'https://smartss.top/serve/dl.php?user=NjgxMA%3D%3D', dailyVisits: 1000 },
    { url: 'https://omg10.com/4/8839467', dailyVisits: 500 },
    // { url: 'https://example.com/page2', dailyVisits: 500 },
    // { url: 'https://example.com/page3', dailyVisits: 1000 },
];

// ==================== 资源拦截 ====================

async function setupRequestBlocker(page) {
    await page.setRequestInterception(true);

    page.on('request', (request) => {
        const blockedTypes = [
            'image',
            'stylesheet',
            'font',
            'media',
            'texttrack',
            'manifest',
            'other',
        ];

        if (blockedTypes.includes(request.resourceType())) {
            //request.abort();
        } else {
            request.continue();
        }
    });
}

// ==================== 人机验证处理 ====================

async function handleVerification(page) {

    const currentUrl = page.url();

    if (!currentUrl.includes('omg10.com/afu.php')) {
        return 'skipped';
    }

    console.log('      🔐 检测到人机验证，点击 checkbox...');

    try {
        await page.waitForSelector('input[type="checkbox"]', { timeout: 10000, visible: true });
        await page.click('input[type="checkbox"]');
        console.log('      ✅ checkbox 已点击，等待验证...');

        await page.waitForNavigation({ timeout: 30000, waitUntil: 'load' });
        console.log('      ✅ 验证通过，页面已跳转');
	await sleep(20000);
        return 'verified';
    } catch (e) {
        console.log(`      ⚠️  验证异常: ${e.message.slice(0, 60)}`);

        const newUrl = page.url();
        if (newUrl !== currentUrl && !newUrl.includes('omg10.com/afu.php')) {
            console.log('      ✅ 页面已跳转（可能已自动验证）');
            return 'verified';
        }

        return 'failed';
    }
}

// ==================== 单次访问 ====================

async function doVisit(targetUrl, proxy) {
    const browser = await launch({
        headless: isLinux,
        proxy: 'socks5://' + proxy.username + ':' + proxy.password + '@' + proxy.host + ':' + proxy.port,
        humanize: true,
        timezone: 'America/New_York',
        locale: 'en-US',
        viewport: { width: 1366, height: 768 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
        ]
    });

    let page;
    try {
        page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(30000);

        // 代理认证
        //await page.authenticate({
         //   username: proxy.username,
         //   password: proxy.password,
        //});

        //await setupRequestBlocker(page);

        try {
            await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });
        } catch (e) {
            // 忽略超时
        }

        const verifyResult = await handleVerification(page);

        await sleep(10000);

        const finalUrl = page.url();
        const finalTitle = await page.title().catch(() => 'N/A');

        return { verifyResult, finalUrl, finalTitle };
    } catch (error) {
        const finalUrl = page ? page.url().catch(() => 'N/A') : 'N/A';
        return { verifyResult: 'error', finalUrl, finalTitle: 'N/A', error: error.message };
    } finally {
        await browser.close();
    }
}

// ==================== 主流程 ====================

function calcIntervalRange(totalDailyVisits) {
    // 平均间隔 = 一天秒数 / 总目标日访问量
    const avgSec = 86400 / totalDailyVisits;
    const minMs = Math.round(avgSec * 0.6 * 1000);
    const maxMs = Math.round(avgSec * 1.4 * 1000);
    const rangeMs = maxMs - minMs;
    return { minMs, maxMs, rangeMs, avgSec };
}

async function smartssCrawler() {
    const totalDaily = TARGET_URLS.reduce((sum, t) => sum + t.dailyVisits, 0);
    const { minMs, rangeMs, avgSec } = calcIntervalRange(totalDaily);

    console.log('🚀 启动 SmartSS 爬虫');
    console.log(`📋 URL 数量: ${TARGET_URLS.length}`);
    console.log(`📊 总目标日访问量: ${totalDaily}`);
    console.log(`⏱️  平均间隔: ${avgSec.toFixed(1)}s (随机 ${(minMs / 1000).toFixed(0)}~${((minMs + rangeMs) / 1000).toFixed(0)}s)`);
    console.log('🔄 模式: 每次访问重新启动浏览器\n');

    TARGET_URLS.forEach((t, i) => {
        console.log(`   [${i}] ${t.url}  (${t.dailyVisits}/天)`);
    });
    console.log('');

    const platform = os.platform();
    console.log(`🖥️  平台: ${platform} (${isLinux ? '无头' : '窗口'})\n`);

    // 获取代理
    console.log('🔌 获取代理...');
    const { proxy, manager: proxyManager } = await createProxy({ country: 'US', protocol: 'http' });
    console.log(`   📡 代理地址: ${proxy.host}:${proxy.port}`);
    console.log(`   👤 代理账号: ${proxy.username}\n`);

    let visitCount = 0;
    const urlCounts = TARGET_URLS.map(() => 0);
    const startTime = Date.now();
    let urlIndex = 0;

    while (true) {
        visitCount++;
        const target = TARGET_URLS[urlIndex];
        urlCounts[urlIndex]++;

        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const totalRate = (visitCount / (elapsedSec / 86400)).toFixed(1);

        console.log(`\n══════════════════════════════════════════════`);
        console.log(`🔢 总第 ${visitCount} 次 | URL[${urlIndex}] 第 ${urlCounts[urlIndex]} 次`);
        console.log(`⏱️  运行 ${Math.floor(elapsedSec / 3600)}h${Math.floor(elapsedSec / 60) % 60}m | 预估总日访问: ${totalRate}`);
        console.log(`🎯 ${target.url}`);

        try {
            const { verifyResult, finalUrl, finalTitle, error } = await doVisit(target.url, proxy);
            if (error) {
                console.error(`   ❌ 异常: ${error}`);
            }
            console.log(`   📄 标题: ${finalTitle}`);
            console.log(`   🔗 最终 URL: ${finalUrl}`);
            console.log(`   🛡️  验证: ${verifyResult}`);
        } catch (error) {
            console.error(`   ❌ 异常: ${error.message}`);
            console.log(`   🔗 最终 URL: N/A`);
        }

        // 统计各 URL 访问量
        const stats = urlCounts.map((c, i) => `[${i}]:${c}`).join(' ');
        console.log(`   📊 各URL访问: ${stats}`);

        // 轮换到下一个 URL
        urlIndex = (urlIndex + 1) % TARGET_URLS.length;

        // 随机间隔
        const interval = minMs + Math.floor(Math.random() * rangeMs);
        const nextTime = new Date(Date.now() + interval).toLocaleTimeString('zh-CN', { hour12: false });
        console.log(`   ⏳ 下次: ${nextTime} (${(interval / 1000).toFixed(0)}s)`);

        await sleep(interval);
    }
}

process.on('SIGINT', async () => {
    console.log('\n👋 正在关闭...');
    process.exit(0);
});

smartssCrawler().catch((error) => {
    console.error('❌ 未捕获的错误:', error);
    process.exit(1);
});