import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

// ==================== 配置常量 ====================

const LOGIN_URL = 'https://claude.ai/login';
const TARGET_URL = 'https://claude.ai/new';

const PROXY = {
    url: 'socks5://chenchao:chenchao@104.233.202.50:17893',
    host: '104.233.202.50',
    port: 17893,
    username: 'chenchao',
    password: 'chenchao',
};

// Chrome 扩展格式的 cookie（从浏览器导出，登录 claude.ai 的账号）
const RAW_COOKIES = [
    {
        domain: '.claude.ai',
        expirationDate: 1801964847.351691,
        hostOnly: false,
        httpOnly: false,
        name: '_fbp',
        path: '/',
        sameSite: 'no_restriction',
        secure: true,
        session: false,
        storeId: '0',
        value: 'fb.1.1794188849642.73833429619725980',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1825744636.233221,
        hostOnly: false,
        httpOnly: false,
        name: 'ajs_anonymous_id',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: 'claudeai.v1.0f628fb0-9a24-4c74-9748-b8e6827fdb18',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1825744637.175016,
        hostOnly: false,
        httpOnly: false,
        name: 'CH-prefers-color-scheme',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: 'light',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1828748867.932851,
        hostOnly: false,
        httpOnly: false,
        name: '__ssid',
        path: '/',
        sameSite: 'unspecified',
        secure: false,
        session: false,
        storeId: '0',
        value: '42fc1665-e329-4718-9b10-92720edb8a63',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1796608160.422847,
        hostOnly: false,
        httpOnly: true,
        name: 'sessionKey',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: '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',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1796608160.422943,
        hostOnly: false,
        httpOnly: false,
        name: 'sessionKeyLC',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: '1794188952062',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1825744637.173097,
        hostOnly: false,
        httpOnly: false,
        name: 'lastActiveOrg',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: '333d80e8-6092-47ed-8a20-ac98acce9b8e',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1796780994.983694,
        hostOnly: false,
        httpOnly: true,
        name: 'routingHint',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: 'sk-ant-rh-eyJ0eXAiOiAiSldUIiwgImFsZyI6ICJFUzI1NiIsICJraWQiOiAiN0MxcWFPRnhqdWxaUjRFQnNuNk1UeUZGNWdDV2JHbFpNVDR2RklrRFFpbyJ9.eyJzdWIiOiAiM2FmMDkwZjUtNzY5OC00MWFkLTlhNWEtNzk0NjNkZDJmOTI0IiwgInYiOiAyLCAiaXNfdmVyaWZpZWQiOiB0cnVlLCAiaGFzX21lbWJlcnNoaXAiOiB0cnVlLCAib25ib2FyZGluZ19jb21wbGV0ZSI6IHRydWUsICJhZ2VfdmVyaWZpZWQiOiB0cnVlLCAicGVuZGluZ19pbnZpdGUiOiBmYWxzZSwgInBob25lX3ZlcmlmaWVkIjogZmFsc2UsICJuYW1lIjogInJ1c3RpYy1tZWFkb3ciLCAibG9jYWxlIjogImVuLVVTIiwgImZsYWdzIjogWyJlZGdlX2RlZmF1bHRfcm91dGUiXSwgImlhdCI6IDE3OTQxODg5OTcsICJpc3MiOiAiY2xhdWRlLWFpLXJvdXRpbmcifQ.ThKfGIpV69IueFTURaB8imMaVH99432q11syXWCotrrIFGQtzgSzayfbNAz6anWj4fi7Jizuu8fFDSRuZHWVtQ',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1801965000,
        hostOnly: false,
        httpOnly: false,
        name: '_gcl_au',
        path: '/',
        sameSite: 'unspecified',
        secure: false,
        session: false,
        storeId: '0',
        value: '1.1.610061934.1794189000.-.-.1794189000.1637687392.1794189000.1794189000',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1825744638.887147,
        hostOnly: false,
        httpOnly: false,
        name: 'user-sidebar-visible-on-load',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: 'true',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1796608160.422391,
        hostOnly: false,
        httpOnly: true,
        name: 'sessionKeyV3',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: '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',
    },
    {
        domain: '.claude.ai',
        expirationDate: 1796608160.422584,
        hostOnly: false,
        httpOnly: false,
        name: 'sessionKeyV3LC',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: '1794210563498',
    },
    {
        domain: '.claude.ai',
        hostOnly: false,
        httpOnly: true,
        name: '_cfuvid',
        path: '/',
        sameSite: 'no_restriction',
        secure: true,
        session: true,
        storeId: '0',
        value: 'kLLu5iwjxN6cf0MObwgtNheP57Srbs4URD4YGnGJRFk-1794212243.2941716-1.0.1.1-iqUngQ.Y.fowvd.5oBaQl0sbY54c.xChCJ.xi6TDwVs',
    },
    {
        domain: 'claude.ai',
        hostOnly: true,
        httpOnly: true,
        name: 'ion-vk',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: true,
        storeId: '0',
        value: '997fd45e-6953-4ef3-8548-e84f33c1be9e',
    },
    {
        domain: 'claude.ai',
        expirationDate: 1820128634.172828,
        hostOnly: true,
        httpOnly: false,
        name: 'anthropic-device-id',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: '7eb87991-b95e-4272-8d54-884c1e43b900',
    },
    {
        domain: 'claude.ai',
        expirationDate: 1794251834.173038,
        hostOnly: true,
        httpOnly: false,
        name: 'activitySessionId',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: 'dc50cfe7-bbdd-4f55-883a-8efc1ec1dcd2',
    },
    {
        domain: 'claude.ai',
        expirationDate: 1809740876,
        hostOnly: true,
        httpOnly: false,
        name: 'g_state',
        path: '/',
        sameSite: 'unspecified',
        secure: false,
        session: false,
        storeId: '0',
        value: '{"i_l":0,"i_ll":1794188876938,"i_b":"4Vp5fljGLGOygO3HYuwKoD+ns9Pg5SpRStBX47F2K+U","i_e":{"enable_itp_optimization":24},"i_et":1794188876938}',
    },
    {
        domain: 'claude.ai',
        expirationDate: 1796800636.948255,
        hostOnly: true,
        httpOnly: false,
        name: 'artifact-app-viewer',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: '0',
        value: '1',
    },
    {
        domain: 'claude.ai',
        expirationDate: 1825748255.148,
        hostOnly: true,
        httpOnly: false,
        name: '_dd_s_v2',
        path: '/',
        sameSite: 'strict',
        secure: true,
        session: false,
        storeId: '0',
        value: 'aid=2779ab5e-4d1c-41fc-a970-afe8234b7936&id=006747ca-d4c4-4cc8-b2ba-a7cfcd7fca26&created=1794208228300&expire=1794213155148&c=0',
    },
];

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

// ==================== 主流程 ====================

async function openClaude() {
    console.log('🚀 启动 CloakBrowser (Claude)...');

    let browser;

    try {
        const cookies = convertCookies(RAW_COOKIES);
        console.log(`🍪 待写入 cookie 数量: ${cookies.length}`);

        const platform = os.platform();
        console.log(`🖥️  当前平台: ${platform} (${isLinux ? '无头模式' : '窗口模式'})`);

        console.log('\n🌐 启动 CloakBrowser...');
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

        // 步骤 1: 访问 login 页面建立 domain
        console.log(`\n🌐 访问 ${LOGIN_URL} 建立 domain...`);
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

        // 步骤 2: 写入 cookies
        console.log(`\n🍪 写入 ${cookies.length} 个 cookies...`);
        await page.setCookie(...cookies);
        const applied = await page.cookies();
        console.log(`✅ Cookies 写入完成，当前域 cookie 数量: ${applied.length}`);

        // 步骤 3: 跳转到新对话页面
        console.log(`\n🌐 跳转 ${TARGET_URL} ...`);
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