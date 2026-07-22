import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { ResidentProxyManager } from './proxy.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

// ==================== 配置常量 ====================

const PROXY_API_KEY = '629a2e2ce2532c8c4ad034fbc4f3c8a5';

const DB_CONFIG = {
    host: '166.0.19.103',
    port: 13307,
    user: 'root',
    password: 'root',
    database: 'ad',
};

const DEFAULT_ACCOUNT = 'gav.bull@totococo.fr.nf';

const TARGET_URL = 'https://beta.publishers.adsterra.com/websites';
const LOGIN_URL = 'https://beta.publishers.adsterra.com/login';

// ==================== 命令行参数解析 ====================

function parseArgs() {
    const args = process.argv.slice(2);
    const params = { account: DEFAULT_ACCOUNT };

    for (const arg of args) {
        if (arg.startsWith('--account=')) {
            params.account = arg.slice('--account='.length);
        }
    }

    return params;
}

// ==================== Cookie 格式转换 ====================

/**
 * 将 Chrome 扩展格式的 cookie 数组转换为 Puppeteer setCookie 格式
 *
 * Chrome 扩展格式包含 hostOnly / storeId / expirationDate / session 等字段，
 * Puppeteer 需要: name, value, domain, path, expires, httpOnly, secure, sameSite
 */
function convertCookies(rawCookies) {
    return rawCookies
        .filter(c => {
            // 过滤掉 session cookie（没有过期时间），Puppeteer 设置它们会报错
            if (c.session === true) {
                return false;
            }
            return true;
        })
        .map(c => {
            const cookie = {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                httpOnly: c.httpOnly || false,
                secure: c.secure || false,
            };

            // expirationDate 是 Unix 时间戳（秒），Puppeteer 的 expires 也是 Unix 秒
            if (c.expirationDate) {
                cookie.expires = c.expirationDate;
            }

            // sameSite: 映射 Chrome 扩展值 → Puppeteer 枚举值
            if (c.sameSite) {
                const mapping = {
                    'no_restriction': 'None',
                    'lax': 'Lax',
                    'strict': 'Strict',
                    'unspecified': 'Lax',  // 默认用 Lax
                };
                cookie.sameSite = mapping[c.sameSite] || 'Lax';
            }

            return cookie;
        });
}

// ==================== 数据库查询 ====================

async function getAccountCookies(account) {
    console.log(`🔍 查询账号: ${account}`);
    const connection = await mysql.createConnection(DB_CONFIG);

    try {
        const [rows] = await connection.execute(
            'SELECT account, cookie FROM adsterra_account WHERE account = ?',
            [account]
        );

        if (rows.length === 0) {
            console.warn(`⚠️  未找到账号 "${account}" 的记录`);
            return null;
        }

        const record = rows[0];
        console.log(`✅ 找到账号: ${record.account}`);

        const rawCookies = typeof record.cookie === 'string'
            ? JSON.parse(record.cookie)
            : record.cookie;

        console.log(`🍪 原始 cookie 数量: ${rawCookies.length}`);

        const cookies = convertCookies(rawCookies);
        console.log(`🍪 转换后 cookie 数量: ${cookies.length}`);

        return cookies;
    } finally {
        await connection.end();
    }
}

// ==================== 主流程 ====================

async function accountCrawler() {
    const params = parseArgs();
    console.log('🚀 启动 CloakBrowser (Account 爬虫)...');
    console.log(`👤 目标账号: ${params.account}\n`);

    let browser;
    let proxyManager;

    try {
        // 步骤 1: 查询数据库获取 cookies
        console.log('📦 步骤 1: 从数据库获取 cookies...');
        const cookies = await getAccountCookies(params.account);

        if (!cookies || cookies.length === 0) {
            console.warn('⚠️  没有可用的 cookies，将尝试无 cookie 访问');
        }

        // 步骤 2: 获取代理
        const platform = os.platform();
        console.log(`\n🖥️  当前平台: ${platform} (${isLinux ? '无头模式' : '窗口模式'})`);

        console.log('🔌 步骤 2: 获取代理...');
        proxyManager = new ResidentProxyManager({
            apiKey: PROXY_API_KEY,
            country: 'US',
            rotationInterval: 30 * 60 * 1000,
            protocol: 'http',
            verbose: true,
        });

        proxyManager.on('proxy:ready', (proxy) => {
            console.log(`   ✅ 代理就绪: ${proxy.host}:${proxy.port}`);
        });

        proxyManager.on('error', ({ error }) => {
            console.warn(`   ⚠️  代理错误: ${error.message}`);
        });

        await proxyManager.start();
        const proxy = await proxyManager.getProxy();
        console.log(`   📡 代理地址: ${proxy.host}:${proxy.port}`);
        console.log(`   👤 代理账号: ${proxy.username}`);

        // 步骤 3: 启动 CloakBrowser
        console.log('\n🌐 步骤 3: 启动 CloakBrowser...');
        browser = await launch({
            headless: isLinux,
            proxy: 'http://' + proxy.username + ':' + proxy.password + '@' + proxy.host + ':' + proxy.port,
            humanize: true,
            timezone: 'America/New_York',
            locale: 'en-US',
            viewport: { width: 1360, height: 768 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
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
        await page.setViewport({ width: 1366, height: 768 });

        // 步骤 4: 访问 login 页面建立 domain
        console.log(`\n🌐 步骤 4: 访问 ${LOGIN_URL} 建立 domain...`);
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

        // 步骤 5: 设置 cookies
        if (cookies && cookies.length > 0) {
            console.log(`\n🍪 步骤 5: 设置 ${cookies.length} 个 cookies...`);
            await page.setCookie(...cookies);
            console.log('✅ Cookies 设置完成');
        } else {
            console.log('\n🍪 步骤 5: 跳过（无可用 cookies）');
        }

        // 步骤 6: 访问目标页面
        console.log(`\n🌐 步骤 6: 访问 ${TARGET_URL} ...`);
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

        // 步骤 7: 打印页面信息
        const title = await page.title();
        const finalUrl = page.url();
        console.log('\n📄 页面信息:');
        console.log(`   标题: ${title}`);
        console.log(`   URL: ${finalUrl}`);

        console.log('\n========================================\n');
        console.log('✅ Account 爬虫执行完成！');
        console.log(`🔗 最终页面地址：${finalUrl}`);
        console.log('\n🕐 浏览器保持打开状态，按 Ctrl+C 退出...');

        // 保持进程运行
        await new Promise(() => {});

    } catch (error) {
        console.error('❌ 发生错误:', error.message);
        console.error(error.stack);

        if (browser) {
            await browser.close();
        }
        if (proxyManager) {
            proxyManager.destroy();
        }

        process.exit(1);
    }
}

// 处理进程退出
process.on('SIGINT', async () => {
    console.log('\n👋 正在关闭浏览器...');
    process.exit(0);
});

// 启动爬虫
accountCrawler().catch((error) => {
    console.error('❌ 未捕获的错误:', error);
    process.exit(1);
});