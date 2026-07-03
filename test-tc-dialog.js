/**
 * test-tc-dialog.js — 测试 T&C 弹窗处理
 *
 * 用法: node test-tc-dialog.js
 * 测试邮箱: rapp.cuse@traodoinick.com
 */

import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import { createProxy } from './shared/proxy-utils.js';
import { getAccountByEmail } from './shared/db.js';
import { openAccountPage } from './shared/open-account-utils.js';

const EMAIL = 'rapp.cuse@traodoinick.com';
const isLinux = os.platform() === 'linux';

async function main() {
    console.log('🧪 T&C 弹窗处理测试');
    console.log(`📧 邮箱: ${EMAIL}\n`);

    let proxyManager, browser;
    try {
        // 1. 获取代理
        const { proxy, manager } = await createProxy();
        proxyManager = manager;

        // 2. 获取 cookies
        console.log('📦 获取账号 cookies...');
        const accountData = await getAccountByEmail(EMAIL);
        if (!accountData) {
            console.error('❌ 未找到账号记录');
            process.exit(1);
        }
        const cookies = accountData.cookies;
        console.log(`   🍪 ${cookies.length} 条 cookie\n`);

        // 3. 启动浏览器
        browser = await launch({
            headless: isLinux,
            proxy: 'http://' + proxy.username + ':' + proxy.password + '@' + proxy.host + ':' + proxy.port,
            humanize: true,
            timezone: 'America/New_York',
            locale: 'en-US',
            viewport: { width: 1920, height: 1080 },
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-accelerated-2d-canvas', '--disable-gpu']
        });

        // 4. 调用 openAccountPage（含 T&C 弹窗处理）
        const page = await openAccountPage(browser, proxy, cookies);

        // 5. 验证弹窗是否已关闭
        const tcCheck = await page.evaluate(() => {
            const bodyText = document.body?.innerText || '';
            const hasTC = bodyText.includes('Updates to Terms') &&
                          bodyText.includes('Privacy Policy');
            // 检查 MUI Dialog 是否还存在
            const dialogs = document.querySelectorAll('[role="dialog"]');
            let tcDialogVisible = false;
            for (const d of dialogs) {
                const text = (d.textContent || '').trim();
                if (text.includes('Updates to Terms') && d.offsetParent !== null) {
                    tcDialogVisible = true;
                    break;
                }
            }
            return { hasTC, tcDialogVisible, url: window.location.href, title: document.title };
        });

        console.log(`\n📊 验证结果:`);
        console.log(`   URL: ${tcCheck.url}`);
        console.log(`   标题: ${tcCheck.title}`);
        console.log(`   T&C 弹窗可见: ${tcCheck.tcDialogVisible}`);

        if (!tcCheck.tcDialogVisible) {
            console.log('\n🎉 T&C 弹窗处理测试通过！');
        } else {
            console.log('\n❌ T&C 弹窗仍然可见');
            await page.screenshot({ path: 'debug-tc-still-visible.png', fullPage: false });
            console.log('   📸 截图: debug-tc-still-visible.png');
            process.exit(1);
        }

        await browser.close();
    } catch (e) {
        console.error('💥 异常:', e.message);
        if (e.stack) console.error(e.stack);
        if (browser) await browser.close().catch(() => {});
        process.exit(1);
    } finally {
        if (proxyManager) proxyManager.destroy();
    }
}

main();