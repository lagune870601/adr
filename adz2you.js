import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { createProxy } from './shared/proxy-utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

// ==================== 配置常量 ====================

const DB_CONFIG = {
    host: '166.0.19.103',
    port: 13307,
    user: 'root',
    password: 'root',
    database: 'ad',
};

const DEFAULT_ACCOUNT = 'robertmiller123@mickaben.biz.st';

const TARGET_URL = 'https://smartss.top/serve/dl.php?user=NjgxMA%3D%3D';
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

// ==================== 随机等待工具 ====================

/** 生成 [0, maxMs] 之间的随机毫秒数 */
function randomDelay(maxMs = 30000) {
    return Math.floor(Math.random() * maxMs);
}

/** 随机等待 [0, maxMs] 毫秒 */
async function randomSleep(maxMs = 30000) {
    const ms = randomDelay(maxMs);
    console.log(`   ⏳ 随机等待 ${(ms / 1000).toFixed(1)} 秒...`);
    await sleep(ms);
}

// ==================== 主流程 ====================

async function accountCrawler() {
    const params = parseArgs();
    console.log('🚀 启动 Adz2You 循环爬虫...');
    console.log(`👤 目标地址: ${TARGET_URL}\n`);

    let round = 0;

    while (true) {
        round++;
        console.log(`\n${'='.repeat(40)}`);
        console.log(`   🔄 第 ${round} 轮访问`);
        console.log(`${'='.repeat(40)}`);

        let browser;
        let proxyManager;

        try {
            // 步骤 1: 获取代理
            console.log('🔌 步骤 1: 获取代理...');
            const { proxy, manager: proxyManager } = await createProxy({ country: 'US', protocol: 'http' });
            console.log(`   📡 代理地址: ${proxy.host}:${proxy.port}`);
            console.log(`   👤 代理账号: ${proxy.username}`);

            // 步骤 2: 启动 CloakBrowser
            console.log('\n🌐 步骤 2: 启动 CloakBrowser...');
            browser = await launch({
                headless: true,
                proxy: proxy.url,
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

            // 步骤 3: 访问目标 URL
            console.log(`\n🌐 步骤 3: 访问 ${TARGET_URL}`);
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

            console.log('✅ 页面加载完成！');

            // 随机等待 0~30 秒（页面停留时间）
            await randomSleep(30000);

            // 打印页面信息
            const title = await page.title();
            const finalUrl = page.url();
            console.log('\n📄 页面信息:');
            console.log(`   标题: ${title}`);
            console.log(`   URL: ${finalUrl}`);

            console.log('\n✅ 本轮访问完成，关闭浏览器...');

        } catch (error) {
            console.error('❌ 本轮发生错误:', error.message);
            console.error(error.stack);
        } finally {
            // 关闭浏览器
            if (browser) {
                await browser.close().catch(() => {});
                console.log('   ✅ 浏览器已关闭');
            }
            if (proxyManager) {
                proxyManager.destroy().catch(() => {});
                console.log('   ✅ 代理已释放');
            }
        }

        // 随机间隔 0~30 秒后进入下一轮
        console.log(`\n⏳ 等待随机间隔后开始下一轮...`);
        await randomSleep(30000);
    }
}

// 处理进程退出
process.on('SIGINT', async () => {
    console.log('\n👋 正在退出循环爬虫...');
    process.exit(0);
});

// 启动爬虫
accountCrawler().catch((error) => {
    console.error('❌ 未捕获的错误:', error);
    process.exit(1);
});