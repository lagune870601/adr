import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const TARGET_URL = 'https://beta.publishers.adsterra.com/websites';
const LOGIN_URL = 'https://beta.publishers.adsterra.com/login';

/**
 * Account 爬虫 — 使用已有 cookies 登录 Adsterra 账号
 *
 * @param {object} task - 任务信息 { id, account, email, ... }
 * @param {object} proxy - 代理信息 { host, port, username, password }
 * @param {Array} cookies - Puppeteer 格式的 cookie 数组（由 main.js 从 adsterra_account 查询并转换）
 * @returns {{ success: boolean, retryable?: boolean, error?: string }}
 */
export async function accountCrawler(task, proxy, cookies) {
    console.log('🚀 启动 CloakBrowser (Account 爬虫)...');
    console.log(`👤 目标账号: ${task.email}\n`);

    let browser;

    try {
        // 步骤 1: 启动 CloakBrowser
        browser = await launch({
            headless: isLinux,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                `--proxy-server=${proxy.host}:${proxy.port}`,
            ]
        });

        console.log('📖 创建新页面...');
        const page = await browser.newPage();

        // 代理认证
        await page.authenticate({
            username: proxy.username,
            password: proxy.password,
        });
        console.log('   ✅ 代理认证已设置');

        // 设置默认超时
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(30000);

        // 设置视口大小
        await page.setViewport({ width: 1920, height: 1080 });

        // 步骤 2: 访问 login 页面建立 domain
        console.log(`\n🌐 步骤 1: 访问 ${LOGIN_URL} 建立 domain...`);
        try {
            await page.goto(LOGIN_URL, {
                waitUntil: 'load',
                timeout: 120000
            });
        } catch (e) {
            console.log('⚠️  页面加载超时，检查当前页面状态...');
            const currentUrl = page.url();
            console.log(`   当前 URL: ${currentUrl}`);
        }

        await sleep(3000);
        console.log('✅ Domain 已建立');

        // 步骤 3: 设置 cookies
        if (cookies && cookies.length > 0) {
            console.log(`\n🍪 步骤 2: 设置 ${cookies.length} 个 cookies...`);
            await page.setCookie(...cookies);
            console.log('✅ Cookies 设置完成');
        } else {
            console.log('\n🍪 步骤 2: 跳过（无可用 cookies）');
        }

        // 步骤 4: 访问目标页面
        console.log(`\n🌐 步骤 3: 访问 ${TARGET_URL} ...`);
        try {
            await page.goto(TARGET_URL, {
                waitUntil: 'load',
                timeout: 120000
            });
        } catch (e) {
            console.log('⚠️  页面加载超时，检查当前页面状态...');
            const currentUrl = page.url();
            console.log(`   当前 URL: ${currentUrl}`);
        }

        await sleep(3000);
        console.log('✅ 页面加载完成！');

        // 步骤 5: 打印页面信息
        const title = await page.title();
        const finalUrl = page.url();
        console.log('\n📄 页面信息:');
        console.log(`   标题: ${title}`);
        console.log(`   URL: ${finalUrl}`);

        console.log('\n========================================\n');
        console.log('✅ Account 爬虫执行完成！');
        console.log(`🔗 最终页面地址：${finalUrl}`);

        await browser.close();
        return { success: true };

    } catch (error) {
        console.error('❌ 发生错误:', error.message);
        console.error(error.stack);

        if (browser) {
            await browser.close();
        }

        return { success: false, retryable: false, error: error.message };
    }
}