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

const TARGET_URL = 'https://omg10.com/4/8839467';
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

// ==================== 人机验证处理 ====================

/**
 * 检测页面是否包含 AdEx 人机验证的 checkbox
 *
 * 不依赖随机类名，通过结构查找:
 *   1. 查找 input[type="checkbox"] 元素
 *   2. 或页面包含 "Verify you are human" 文本
 *   3. 验证页的 URL 通常包含 afu.php
 */
async function detectVerifyCheckbox(page) {
    // 检查 URL
    const url = page.url();
    if (url.includes('afu.php')) {
        return true;
    }

    // 检查页面内容
    try {
        const hasText = await page.evaluate(() =>
            document.body?.innerText?.includes('Verify you are human') ?? false
        );
        if (hasText) return true;
    } catch { /* ignore */ }

    return false;
}

/**
 * 尝试点击页面上的验证 checkbox（不依赖随机类名）
 *
 * 策略:
 *   1. 直接点击 input[type="checkbox"] 的坐标
 *   2. 点击包含 checkbox 的 label 可见区域
 *   3. 通过文本 "Verify" 找 label 点击
 *   4. 程序化 dispatchEvent 兜底
 *
 * @returns {Promise<boolean>} 是否成功点击
 */
async function clickVerifyCheckbox(page) {
    // ---- 方式 1: input[type="checkbox"] 坐标点击 ----
    try {
        const cb = await page.$('input[type="checkbox"]');
        if (cb) {
            const box = await cb.boundingBox();
            if (box) {
                console.log(`   🖱️  方式1: 点击 checkbox (${Math.round(box.x)}, ${Math.round(box.y)})`);
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                console.log('   ✅ checkbox 已点击');
                return true;
            }
        }
    } catch (e) {
        console.log(`   ⚠️  方式1 失败: ${e.message.slice(0, 60)}`);
    }

    // ---- 方式 2: 点击包含 checkbox 的 label ----
    try {
        const labels = await page.$$('label');
        for (const label of labels) {
            const hasCheckbox = await label.evaluate(el =>
                !!el.querySelector('input[type="checkbox"]')
            );
            if (hasCheckbox) {
                const box = await label.boundingBox();
                if (box) {
                    console.log(`   🖱️  方式2: 点击 label (${Math.round(box.x)}, ${Math.round(box.y)})`);
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                    console.log('   ✅ label 已点击');
                    return true;
                }
            }
        }
    } catch (e) {
        console.log(`   ⚠️  方式2 失败: ${e.message.slice(0, 60)}`);
    }

    // ---- 方式 3: 程序化 dispatchEvent 触发 ----
    try {
        const clicked = await page.evaluate(() => {
            const cb = document.querySelector('input[type="checkbox"]');
            if (!cb) return false;
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            // 额外触发原 onclick 中的函数调用
            // 原 onclick="function(){i[fn](Tr,Tr)}" 中的 i,fn,Tr 是页面闭包变量
            // 尝试通过父级元素的事件冒泡触发
            if (typeof cb.onclick === 'function') cb.onclick();
            return true;
        });
        if (clicked) {
            console.log('   ✅ 程序化触发 checkbox 成功');
            return true;
        }
    } catch (e) {
        console.log(`   ⚠️  方式3 失败: ${e.message.slice(0, 60)}`);
    }

    // ---- 方式 4: 检查 iframe ----
    try {
        const frames = await page.frames();
        for (const frame of frames) {
            if (frame === page.mainFrame()) continue;
            const clickedInFrame = await frame.evaluate(() => {
                const cb = document.querySelector('input[type="checkbox"]');
                if (!cb) return false;
                cb.checked = true;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return true;
            }).catch(() => false);
            if (clickedInFrame) {
                console.log('   ✅ iframe 内 checkbox 已点击');
                return true;
            }
        }
    } catch (e) {
        console.log(`   ⚠️  方式4 失败: ${e.message.slice(0, 60)}`);
    }

    return false;
}

/**
 * 处理 AdEx 人机验证页面
 *
 * 在导航过程中被调用 —— 当检测到页面经过 omg10.com/afu.php 时触发。
 * afu.php 是验证中转页:
 *   - 需要验证: 页面停留在 afu.php 显示 checkbox
 *   - 无需验证: 页面自动跳转到最终目标页
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<'verified' | 'skipped' | 'passed_through'>}
 */
async function handleAdExVerification(page) {
    // 检测是否在验证页面
    if (!(await detectVerifyCheckbox(page))) {
        return 'skipped';
    }

    console.log('   🔐 检测到 AdEx 人机验证页面！');

    // 短暂等待渲染完成
    await sleep(2000);

    // 尝试点击 checkbox
    const clicked = await clickVerifyCheckbox(page);

    if (!clicked) {
        console.log('   ⚠️  所有点击方式均失败');
        // 输出诊断信息
        try {
            const diag = await page.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
                    type: i.type, className: i.className?.slice(0, 40),
                    checked: i.checked,
                    rect: (() => { const r = i.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 }; })(),
                }));
                const labels = Array.from(document.querySelectorAll('label')).map(l => ({
                    text: l.textContent?.trim()?.slice(0, 30),
                    hasCheckbox: !!l.querySelector('input'),
                }));
                const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src?.slice(0, 100) }));
                return { title: document.title, url: window.location.href, inputs, labels, iframes };
            });
            console.log('   📋 诊断:', JSON.stringify(diag, null, 2));
        } catch (e) {
            console.log(`   📋 诊断失败: ${e.message}`);
        }
        return 'verified';
    }

    // 等待验证通过后的页面跳转
    console.log('   ⏳ 等待验证通过（页面跳转）...');
    try {
        await page.waitForFunction(
            () => !window.location.href.includes('afu.php'),
            { timeout: 60000, polling: 1000 }
        );
        console.log('   ✅ 验证通过，页面已跳转！');
        return 'verified';
    } catch {
        const afterUrl = page.url();
        if (!afterUrl.includes('afu.php')) {
            console.log('   ✅ 验证通过，页面已跳转！');
            return 'verified';
        }
        console.log('   ⚠️  验证超时（60s），继续执行...');
        return 'verified';
    }
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
            let title = await page.title();
            let finalUrl = page.url();
            if (finalUrl.includes('afu.php')) {
                console.log('   ⚡ 页面曾经过 afu.php 验证页');
                await handleAdExVerification(page);
                // 随机等待 0~30 秒（页面停留时间）
                await randomSleep(30000);
                title = await page.title();
                finalUrl = page.url();
            }
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
        await sleep(300000); // 固定等待 5 分钟
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