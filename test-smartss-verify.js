/**
 * 测试脚本：反复访问直到触发 omg10.com 人机验证页面
 * 验证通过后自动退出
 *
 * 用法: node test-smartss-verify.js
 */

import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const CLASH_PROXY = 'socks5://127.0.0.1:7891';
const TARGET_URL = 'https://omg10.com/4/8839467';

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
            request.abort();
        } else {
            request.continue();
        }
    });
}

/**
 * 等待 20 秒后判断页面是否跳转到 omg10.com/afu.php 验证页面
 * 如果是则点击 checkbox 完成验证
 * @returns {string} 'verified' | 'skipped' | 'failed'
 */
async function handleVerification(page) {
    console.log('   ⏳ 等待 20 秒，等待页面跳转...');
    await sleep(20000);

    const currentUrl = page.url();
    console.log(`   🔗 当前 URL: ${currentUrl}`);

    if (!currentUrl.includes('omg10.com/afu.php')) {
        console.log('   ⚡ 未跳转到验证页面，跳过');
        return 'skipped';
    }

    console.log('   🔐 检测到人机验证页面！');
    console.log('   🖱️  点击 checkbox...');

    try {
        await page.waitForSelector('input[type="checkbox"]', { timeout: 10000, visible: true });
        await page.click('input[type="checkbox"]');
        console.log('   ✅ checkbox 已点击，等待验证结果...');

        // 等待页面跳转（验证通过后会自动提交表单并跳转）
        await page.waitForNavigation({ timeout: 30000, waitUntil: 'load' });
        console.log('   ✅ 验证通过，页面已跳转！');

        return 'verified';
    } catch (e) {
        console.log(`   ⚠️  等待跳转超时: ${e.message.slice(0, 80)}`);

        const newUrl = page.url();
        if (newUrl !== currentUrl && !newUrl.includes('omg10.com/afu.php')) {
            console.log('   ✅ 页面已跳转（可能已自动验证）');
            return 'verified';
        }

        return 'failed';
    }
}

async function doVisit() {
    const browser = await launch({
        headless: isLinux,
        proxy: CLASH_PROXY,
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

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(30000);

        await setupRequestBlocker(page);

        console.log(`🎯 访问: ${TARGET_URL}`);
        try {
            await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60000 });
        } catch (e) {
            // 忽略超时
        }

        const verifyResult = await handleVerification(page);

        if (verifyResult === 'verified' || verifyResult === 'skipped') {
            await sleep(10000);
            const finalUrl = page.url();
            const finalTitle = await page.title().catch(() => 'N/A');
            console.log(`   📄 最终: ${finalTitle}`);
            console.log(`   🔗 最终 URL: ${finalUrl}`);
        }

        return { verifyResult, finalUrl: page.url() };
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('🧪 SmartSS 人机验证测试');
    console.log(`🎯 目标: ${TARGET_URL}`);
    console.log(`🔌 代理: ${CLASH_PROXY}`);
    console.log('🔄 策略: 反复访问直到触发 omg10.com 验证页面\n');

    let attempt = 0;
    const startTime = Date.now();

    while (true) {
        attempt++;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n════════════════════════════════════════════`);
        console.log(`🔢 第 ${attempt} 次尝试 (已耗时 ${elapsed}s)`);

        try {
            const { verifyResult, finalUrl } = await doVisit();

            if (verifyResult === 'verified') {
                console.log('\n========================================');
                console.log('🎉 测试成功！人机验证已通过');
                console.log(`   最终 URL: ${finalUrl}`);
                console.log(`   总尝试次数: ${attempt}`);
                console.log(`   总耗时: ${elapsed}s`);
                console.log('========================================');
                process.exit(0);
            }

            console.log('   ⚡ 未触发验证页面，继续重试...');
        } catch (error) {
            console.error(`   ❌ 异常: ${error.message}`);
        }

        // 短暂等待后重试
        await sleep(2000);
    }
}

process.on('SIGINT', () => {
    console.log('\n👋 测试中断');
    process.exit(0);
});

main().catch((error) => {
    console.error('❌ 未捕获的错误:', error);
    process.exit(1);
});