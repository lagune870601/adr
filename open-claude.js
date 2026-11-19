import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

// ==================== 配置常量 ====================

const LOGIN_URL = 'https://claude.ai/login';
const TARGET_URL = 'https://claude.ai/new';

const DEFAULT_ACCOUNT = 'rustic-meadow@md.qjwdzj.com';

const PROXY = {
    url: 'socks5://chenchao:chenchao@104.233.202.50:17893',
    host: '104.233.202.50',
    port: 17893,
    username: 'chenchao',
    password: 'chenchao',
};

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
 * Chrome 扩展格式的 cookie 数组 → Puppeteer setCookie 格式
 *
 * session cookie（无 expirationDate）不设置 expires，Puppeteer 会按会话 cookie 处理。
 */
function convertCookies(rawCookies) {
    const sameSiteMapping = {
        no_restriction: 'None',
        lax: 'Lax',
        strict: 'Strict',
        unspecified: 'Lax',
    };

    return rawCookies.map(c => {
        const cookie = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            httpOnly: c.httpOnly || false,
            secure: c.secure || false,
        };

        if (c.expirationDate) {
            cookie.expires = c.expirationDate;
        }

        if (c.sameSite) {
            cookie.sameSite = sameSiteMapping[c.sameSite] || 'Lax';
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
            'SELECT account, cookies FROM claude_account WHERE account = ?',
            [account]
        );

        if (rows.length === 0) {
            console.warn(`⚠️  未找到账号 "${account}" 的记录`);
            return null;
        }

        const record = rows[0];
        console.log(`✅ 找到账号: ${record.account}`);

        const rawCookies = typeof record.cookies === 'string'
            ? JSON.parse(record.cookies)
            : (record.cookies || []);

        console.log(`🍪 原始 cookie 数量: ${rawCookies.length}`);

        const cookies = convertCookies(rawCookies);
        console.log(`🍪 转换后 cookie 数量: ${cookies.length}`);

        return cookies;
    } finally {
        await connection.end();
    }
}

// ==================== 主流程 ====================

async function openClaude() {
    const params = parseArgs();
    console.log('🚀 启动 CloakBrowser (Claude)...');
    console.log(`👤 目标账号: ${params.account}\n`);

    let browser;

    try {
        // 步骤 1: 查询数据库获取 cookies
        console.log('📦 步骤 1: 从数据库获取 cookies...');
        const cookies = await getAccountCookies(params.account);

        if (!cookies || cookies.length === 0) {
            console.warn('⚠️  没有可用的 cookies，将尝试无 cookie 访问');
        }

        const platform = os.platform();
        console.log(`🖥️  当前平台: ${platform} (${isLinux ? '无头模式' : '窗口模式'})`);

        console.log('\n🌐 步骤 2: 启动 CloakBrowser...');
        browser = await launch({
            headless: isLinux,
            proxy: PROXY.url,
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
            ],
        });

        console.log('📖 创建新页面...');
        const page = await browser.newPage();

        await page.authenticate({
            username: PROXY.username,
            password: PROXY.password,
        });
        console.log('   ✅ 代理认证已设置');

        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(30000);

        await page.setViewport({ width: 1366, height: 768 });

        // 步骤 3: 访问 login 页面建立 domain
        console.log(`\n🌐 步骤 3: 访问 ${LOGIN_URL} 建立 domain...`);
        try {
            await page.goto(LOGIN_URL, {
                waitUntil: 'load',
                timeout: 120000,
            });
        } catch (e) {
            console.log('⚠️  页面加载超时，检查当前页面状态...');
            console.log(`   当前 URL: ${page.url()}`);
        }

        await sleep(3000);
        console.log('✅ Domain 已建立');

        // 步骤 4: 写入 cookies
        if (cookies && cookies.length > 0) {
            console.log(`\n🍪 步骤 4: 写入 ${cookies.length} 个 cookies...`);
            await page.setCookie(...cookies);
            const applied = await page.cookies();
            console.log(`✅ Cookies 写入完成，当前域 cookie 数量: ${applied.length}`);
        } else {
            console.log('\n🍪 步骤 4: 跳过（无可用 cookies）');
        }

        // 步骤 5: 跳转到新对话页面
        console.log(`\n🌐 步骤 5: 跳转 ${TARGET_URL} ...`);
        try {
            await page.goto(TARGET_URL, {
                waitUntil: 'load',
                timeout: 120000,
            });
        } catch (e) {
            console.log('⚠️  页面加载超时，检查当前页面状态...');
            console.log(`   当前 URL: ${page.url()}`);
        }

        await sleep(3000);

        const title = await page.title();
        const finalUrl = page.url();
        console.log('\n📄 页面信息:');
        console.log(`   标题: ${title}`);
        console.log(`   URL: ${finalUrl}`);

        if (finalUrl.includes('/login')) {
            console.error('\n❌ Cookies 已失效，被重定向回登录页');
        } else {
            console.log('\n✅ 已进入 claude.ai 新对话页面');
        }

        console.log('\n🕐 浏览器保持打开状态，按 Ctrl+C 退出...');

        await new Promise(() => {});

    } catch (error) {
        console.error('❌ 发生错误:', error.message);
        console.error(error.stack);

        if (browser) {
            await browser.close();
        }

        process.exit(1);
    }
}

process.on('SIGINT', () => {
    console.log('\n👋 正在关闭浏览器...');
    process.exit(0);
});

openClaude().catch((error) => {
    console.error('❌ 未捕获的错误:', error);
    process.exit(1);
});