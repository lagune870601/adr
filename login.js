import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';
import { ResidentProxyManager } from './proxy.js';
import {
    sleep,
    applyStealthPatches,
    waitForCloudflareChallenge,
    getLoginIp,
} from './shared/crawler-utils.js';

const PROXY_API_KEY = '629a2e2ce2532c8c4ad034fbc4f3c8a5';

const isLinux = os.platform() === 'linux';

// Messenger 账号格式映射
const MESSENGER_FORMATS = {
    'Teams':     { format: 'email',    example: 'user@company.com' },
    'Jabber':    { format: 'xmpp',     example: 'user@jabber.org' },
    'Telegram':  { format: 'telegram', example: '@telegram_user' },
    'Facebook':  { format: 'facebook', example: 'facebook.user' },
    'WhatsApp':  { format: 'phone',    example: '+1234567890' },
    'Instagram': { format: 'instagram', example: '@insta_user' },
    'Twitter':   { format: 'twitter',  example: '@twitter_user' },
};

function generateRandomAccount(format) {
    const randomStr = () => Math.random().toString(36).substring(2, 10);
    const randomNum = () => Math.floor(Math.random() * 9000000000) + 1000000000;

    switch (format) {
        case 'email':     return `${randomStr()}@${randomStr()}.com`;
        case 'xmpp':      return `${randomStr()}@jabber.org`;
        case 'telegram':  return `@${randomStr()}`;
        case 'facebook':  return `fb.${randomStr()}`;
        case 'phone':     return `+1${randomNum()}`;
        case 'instagram': return `@${randomStr()}`;
        case 'twitter':   return `@${randomStr()}`;
        default:          return randomStr();
    }
}

/**
 * 在 adsterra.com 首页查找并点击 LOG IN 按钮，然后在下拉框中点击 "As a publisher" 链接
 *
 * DOM 结构：
 *   <div class="dropdown responsive-menu-buttons__dropdown">
 *     <div class="dropdown-link d-flex align-center">
 *       <button type="button" class="btn btn--white ..." title="">Log in</button>
 *     </div>
 *     <div class="dropdown-area collapsed">
 *       <div class="dropdown-wrapper-item">
 *         <div class="dropdown-item">
 *           <a href="https://beta.partners.adsterra.com/login/" target="_blank">As an advertiser</a>
 *         </div>
 *         <div class="dropdown-item">
 *           <a href="https://beta.publishers.adsterra.com/login/" target="_blank">As a publisher</a>
 *         </div>
 *       </div>
 *     </div>
 *   </div>
 */
async function clickLoginDropdown(page) {
    // 1. 等待页面稳定，确保 DOM 渲染完成
    await sleep(2000);
    console.log('   🔍 查找 Log in 按钮...');

    // 通过 evaluate 在浏览器上下文中直接点击（绕过 Puppeteer 的可见性检查）
    const clicked = await page.evaluate(() => {
        const allBtns = document.querySelectorAll('button');
        // 先输出所有 button 的详细信息帮助调试
        const debugInfo = Array.from(allBtns).map(b => ({
            text: (b.textContent || '').trim().slice(0, 50),
            classes: b.className,
            visible: b.offsetParent !== null,
            rect: { w: b.offsetWidth, h: b.offsetHeight },
        }));

        // 策略 1: 文本精确匹配 "Log in"
        for (const btn of allBtns) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'log in') {
                btn.click();
                return { success: true, method: 'text_match', debug: debugInfo };
            }
        }

        // 策略 2: .dropdown-link 内的 button
        const dropdownBtns = document.querySelectorAll('.dropdown-link button');
        for (const btn of dropdownBtns) {
            btn.click();
            return { success: true, method: 'dropdown_link', debug: debugInfo };
        }

        // 策略 3: 任何包含 "log" 和 "in" 文本的 button
        for (const btn of allBtns) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text.includes('log') && text.includes('in')) {
                btn.click();
                return { success: true, method: 'fuzzy_text', debug: debugInfo };
            }
        }

        return { success: false, totalButtons: allBtns.length, debug: debugInfo };
    });

    if (!clicked.success) {
        console.error('   ❌ 页面上所有 button 信息:', JSON.stringify(clicked.debug, null, 2));
        throw new Error(`未找到 Log in 按钮（页面上共有 ${clicked.totalButtons} 个 button）`);
    }
    console.log(`   ✅ 已点击 Log in 按钮 (method: ${clicked.method})，等待下拉框出现...`);

    // 等待下拉框展开
    await sleep(2000);

    // 2. 在下拉框中点击 "As a publisher" 链接
    const publisherClicked = await page.evaluate(() => {
        // 策略 1: 精确 href 匹配
        const exact = document.querySelector('a[href="https://beta.publishers.adsterra.com/login/"]');
        if (exact) { exact.click(); return { success: true, method: 'exact_href' }; }

        // 策略 2: 文本包含 "as a publisher"
        const allLinks = document.querySelectorAll('a');
        for (const link of allLinks) {
            const text = (link.textContent || '').trim().toLowerCase();
            if (text.includes('as a publisher')) {
                link.click();
                return { success: true, method: 'text_match', text: text.trim().slice(0, 50) };
            }
        }

        // 策略 3: href 包含 publishers.adsterra.com/login
        for (const link of allLinks) {
            const href = (link.getAttribute('href') || '').toLowerCase();
            if (href.includes('publishers.adsterra.com/login')) {
                link.click();
                return { success: true, method: 'href_match', href: href.slice(0, 80) };
            }
        }

        return { success: false, totalLinks: allLinks.length };
    });

    if (!publisherClicked.success) {
        throw new Error(`未找到 "As a publisher" 链接（页面上共有 ${publisherClicked.totalLinks} 个 a 标签）`);
    }
    console.log(`   ✅ 已点击 "As a publisher" 链接 (method: ${publisherClicked.method})`);
}

/**
 * 关闭 Cookiebot 弹窗（多策略：先点击按钮，失败则强制隐藏 DOM）
 *
 * adsterra.com 首页使用 Cookiebot Edge 弹窗：
 *   #CybotCookiebotDialog 容器
 *   #CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll 按钮（文本"全部允许"）
 */
async function closeCookieDialog(page) {
    console.log('   🍪 关闭 Cookie 同意弹窗...');

    for (let i = 0; i < 6; i++) {
        await sleep(2000);

        const result = await page.evaluate(() => {
            const dialog = document.querySelector('#CybotCookiebotDialog');
            if (!dialog) {
                // 检查是否有其他类型的 cookie 弹窗
                const otherBanners = document.querySelectorAll(
                    '[class*="cookie-banner"], [class*="cookie-consent"], ' +
                    '[class*="CookieConsent"], [class*="cookies"], ' +
                    '[id*="cookie"], [class*="consent"], ' +
                    '.cc-window, .osano-cm-window'
                );
                // 也没有检测到其他类型的弹窗 → 无需关闭
                if (otherBanners.length === 0) return { found: false, reason: 'no_dialog' };

                // 有其他弹窗，尝试关闭
                for (const banner of otherBanners) {
                    const btns = banner.querySelectorAll('button, a');
                    for (const btn of btns) {
                        const t = (btn.textContent || '').trim().toLowerCase();
                        if (t.includes('accept') || t.includes('allow') || t.includes('agree') || t.includes('ok')) {
                            btn.click();
                            return { found: true, action: 'other_banner_clicked', text: t };
                        }
                    }
                }
                return { found: true, action: 'other_banner_no_button' };
            }

            // ===== Cookiebot 弹窗处理 =====
            const style = window.getComputedStyle(dialog);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return { found: false, reason: 'dialog_hidden' };
            }

            // 策略 1: 通过精确 ID 点击 Allow All 按钮
            const allowBtn = document.querySelector('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll');
            if (allowBtn) {
                // 尝试 dispatchEvent 模拟真实点击
                allowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return { found: true, action: 'clicked_allow_all', text: (allowBtn.textContent || '').trim() };
            }

            // 策略 2: 通过文本查找按钮
            const buttons = dialog.querySelectorAll('button');
            for (const btn of buttons) {
                const t = (btn.textContent || '').trim().toLowerCase();
                if (t.includes('allow all') || t.includes('全部允许') || t.includes('accept')) {
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return { found: true, action: 'clicked_allow_all_fallback', text: t };
                }
            }

            // 策略 3: 点击 dialog 中第一个 button
            if (buttons.length > 0) {
                buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return { found: true, action: 'clicked_first_button', text: (buttons[0].textContent || '').trim().slice(0, 30) };
            }

            return { found: true, action: 'dialog_present_no_button' };
        });

        if (!result.found) {
            if (result.reason === 'no_dialog' || result.reason === 'dialog_hidden') {
                console.log('   ✅ Cookie 弹窗已关闭');
                return true;
            }
            continue;
        }

        if (result.action.startsWith('clicked_')) {
            console.log(`   ✅ 已点击按钮 (${result.action}: ${result.text || ''})，等待弹窗关闭...`);
            await sleep(1500);

            // 验证弹窗是否已关闭
            const stillOpen = await page.evaluate(() => {
                const d = document.querySelector('#CybotCookiebotDialog');
                if (!d) return false;
                const s = window.getComputedStyle(d);
                return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            });

            if (!stillOpen) {
                console.log('   ✅ Cookie 弹窗已成功关闭');
                return true;
            }
            console.log('   ⏳ 弹窗尚未关闭，继续等待...');
        } else {
            console.log(`   ⚠️  弹窗状态: ${result.action}`);
        }
    }

    // ===== 兜底策略：强制隐藏弹窗 =====
    console.log('   ⚠️  按钮点击未生效，强制隐藏 Cookie 弹窗 DOM...');
    await page.evaluate(() => {
        const dialog = document.querySelector('#CybotCookiebotDialog');
        if (dialog) {
            dialog.style.setProperty('display', 'none', 'important');
        }
        // 也隐藏遮罩层
        const overlay = document.querySelector('#CybotCookiebotDialogBodyLevelDialogOverlay');
        if (overlay) {
            overlay.style.setProperty('display', 'none', 'important');
        }
    });
    await sleep(1000);
    console.log('   ✅ Cookie 弹窗已强制隐藏');
    return true;
}

/**
 * 在 Publisher 登录页面填写账号密码
 *
 * DOM 结构（诊断确认）：
 *   input[name="login"]  → 邮箱输入框（id="text-field-login" 动态生成，不稳定）
 *   input[name="signin"] → 密码输入框（id="password-signin" 动态生成，不稳定）
 *   button[type="submit"] text="Log in" → 登录按钮
 */
async function fillLoginForm(page, email, password) {
    console.log('   📝 填写登录表单...');

    // 等待表单输入框出现（页面可能先显示 Cloudflare 挑战）
    let inputFound = false;
    for (let i = 0; i < 10; i++) {
        inputFound = await page.evaluate(() => {
            return !!(document.querySelector('input#text-field-login') || document.querySelector('input[name="login"]'));
        });
        if (inputFound) break;
        console.log(`   ⏳ 等待登录表单加载... (${(i + 1) * 2}s)`);
        await sleep(2000);
    }

    if (!inputFound) {
        // 诊断：输出当前页面内容帮助调试
        const diag = await page.evaluate(() => ({
            url: window.location.href,
            title: document.title,
            bodyLen: (document.body?.innerText || '').length,
            bodyPreview: (document.body?.innerText || '').slice(0, 300),
            inputs: Array.from(document.querySelectorAll('input')).map(i => ({
                type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, visible: i.offsetParent !== null
            })),
            buttons: Array.from(document.querySelectorAll('button')).map(b => ({
                text: (b.textContent || '').trim().slice(0, 30), visible: b.offsetParent !== null
            })),
            iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({
                src: (f.src || '').slice(0, 100), visible: f.offsetParent !== null
            })),
        }));
        console.log('   ❌ 诊断信息:', JSON.stringify(diag, null, 2));
        throw new Error(`未找到邮箱输入框（当前 URL: ${diag.url}）`);
    }

    // 1. 填写邮箱
    // 使用 Puppeteer 的 type() 模拟真实键盘输入，React/MUI 才能正确捕获
    const emailInput = await page.$('input#text-field-login');
    if (!emailInput) {
        throw new Error('未找到邮箱输入框 #text-field-login');
    }
    await emailInput.click();
    // 先清空再输入
    await emailInput.click({ clickCount: 3 });  // 三击全选
    await emailInput.type(email, { delay: 50 });
    console.log(`   ✅ 已输入邮箱: ${email}`);

    await sleep(500);

    // 2. 填写密码
    const passwordInput = await page.$('input#password-signin');
    if (!passwordInput) {
        throw new Error('未找到密码输入框 #password-signin');
    }
    await passwordInput.click();
    await passwordInput.click({ clickCount: 3 });  // 三击全选
    await passwordInput.type(password, { delay: 50 });
    console.log('   ✅ 已输入密码');
}

/**
 * 提交登录表单 - 先触发 Turnstile 等待 token，再提交表单
 * 返回 true 表示登录成功（页面跳转），false 表示需要继续等待
 */
async function submitLoginForm(page) {
    console.log('   🎯 触发 Turnstile 挑战...');

    // 1. 先执行 Turnstile（多策略触发）
    await page.evaluate(() => {
        if (typeof turnstile === 'undefined') return;

        // 策略 1: execute() 不带参数
        try { turnstile.execute(); } catch (_) {}

        // 策略 2: 查找容器，获取 widget ID 后 execute
        const container = document.querySelector('.cf-turnstile, #cf-turnstile, [data-cf-turnstile]');
        if (container) {
            let widgetId = container.getAttribute('data-widget-id');
            if (!widgetId) {
                // 尝试 render 获取新 widget ID
                try {
                    widgetId = turnstile.render(container);
                } catch (_) {}
            }
            if (widgetId) {
                try { turnstile.execute(widgetId); } catch (_) {}
            }
        }

        // 策略 3: 查找所有带 data-widget-id 的元素
        const allWidgets = document.querySelectorAll('[data-widget-id]');
        for (const w of allWidgets) {
            const id = w.getAttribute('data-widget-id');
            if (id) {
                try { turnstile.execute(id); } catch (_) {}
            }
        }
    });

    // 2. 等待 Turnstile token 生成（最多 40s）
    console.log('   ⏳ 等待 Turnstile 挑战完成...');
    let tokenGenerated = false;
    for (let i = 0; i < 20; i++) {
        await sleep(2000);

        // 检查 URL 是否已跳转
        const curUrl = page.url();
        if (curUrl.includes('publishers.adsterra.com/websites') ||
            curUrl.includes('publishers.adsterra.com/dashboard') ||
            curUrl.includes('publishers.adsterra.com/home')) {
            console.log('   ✅ 登录成功！页面已跳转。');
            return true;
        }

        // 检查 Turnstile token 是否已生成
        tokenGenerated = await page.evaluate(() => {
            const input = document.querySelector('input[name="cloudflareCaptchaToken"]');
            return input && input.value ? input.value : null;
        });

        if (tokenGenerated) {
            console.log(`   ✅ Turnstile token 已生成`);
            break;
        }

        // 如果 Turnstile API 还没加载，等待它
        const apiReady = await page.evaluate(() => typeof turnstile !== 'undefined');
        if (apiReady) {
            // 每 5 轮重试一次 execute（多策略）
            if (i % 5 === 0) {
                const result = await page.evaluate(() => {
                    const results = [];
                    try { turnstile.execute(); results.push('execute_default'); } catch (_) {}
                    const container = document.querySelector('.cf-turnstile, #cf-turnstile, [data-cf-turnstile]');
                    if (container) {
                        const id = container.getAttribute('data-widget-id');
                        if (id) { try { turnstile.execute(id); results.push('execute_'+id); } catch (_) {} }
                    }
                    // 检查是否有 Turnstile iframe 可点击
                    const iframes = document.querySelectorAll('iframe');
                    for (const f of iframes) {
                        const src = (f.src || '').toLowerCase();
                        if (src.includes('challenges.cloudflare.com')) {
                            const rect = f.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                results.push('iframe_found');
                                return { results, clickIframe: true, x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
                            }
                        }
                    }
                    return { results, clickIframe: false };
                });

                // 如果有 Turnstile iframe 可见，点击它
                if (result.clickIframe) {
                    console.log(`   🖱️  点击 Turnstile iframe (${Math.round(result.x)}, ${Math.round(result.y)})`);
                    await page.mouse.click(result.x, result.y);
                }
            }
        }

        // 每 5 轮打印状态
        if (i % 5 === 0) {
            const status = await page.evaluate(() => {
                const tokenInput = document.querySelector('input[name="cloudflareCaptchaToken"]');
                const containers = document.querySelectorAll('.cf-turnstile, #cf-turnstile, [data-cf-turnstile]');
                return {
                    token: tokenInput ? (tokenInput.value ? 'exists' : 'empty') : 'no_input',
                    containers: containers.length,
                    hasTurnstile: typeof turnstile !== 'undefined',
                };
            });
            console.log(`   ⏳ 等待中... token=${status.token} containers=${status.containers} turnstile=${status.hasTurnstile}`);
        }
    }

    // 3. Token 已生成或超时 → 提交表单
    if (tokenGenerated) {
        console.log('   🔑 提交表单...');
        await page.evaluate(() => {
            // 先点击按钮（触发事件处理）
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                const type = btn.getAttribute('type') || '';
                if (type === 'submit' && text === 'log in') {
                    btn.click();
                    return;
                }
            }
            // 降级：直接提交表单
            const form = document.querySelector('form');
            if (form) form.submit();
        });
    } else {
        console.log('   ⚠️  Turnstile 超时，尝试直接提交表单...');
        await page.evaluate(() => {
            // 点击登录按钮
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text === 'log in') {
                    btn.click();
                    return;
                }
            }
            // 降级：直接提交表单
            const form = document.querySelector('form');
            if (form) form.submit();
        });
    }

    // 4. 等待页面跳转
    console.log('   ⏳ 等待页面跳转...');
    for (let i = 0; i < 15; i++) {
        await sleep(2000);
        const curUrl = page.url();
        if (curUrl.includes('publishers.adsterra.com/websites') ||
            curUrl.includes('publishers.adsterra.com/dashboard') ||
            curUrl.includes('publishers.adsterra.com/home')) {
            console.log('   ✅ 登录成功！页面已跳转。');
            return true;
        }
    }

    console.log('   ⚠️  登录提交后页面未跳转');
    return false;
}

/**
 * 获取当前页面所有 cookies 并序列化为 JSON 字符串
 */
async function getCookiesJson(page) {
    console.log('   🍪 获取 cookies...');
    const cookies = await page.cookies();
    const jsonStr = JSON.stringify(cookies);
    console.log(`   ✅ 已获取 ${cookies.length} 个 cookies`);
    return jsonStr;
}

/**
 * 更新 adsterra_account 表的 login_ip 和 cookies
 */
async function updateAccountInDb(email, loginIp, cookiesJson) {
    console.log(`   💾 更新数据库: account=${email}`);
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        await connection.execute(
            `UPDATE adsterra_account SET status = 'STOP', login_ip = ?, cookie = ? WHERE account = ?`,
            [loginIp || '', cookiesJson, email]
        );
        console.log('   ✅ 数据库更新成功');
    } catch (err) {
        console.error('   ❌ 数据库更新失败:', err.message);
        throw err;
    } finally {
        await connection.end();
    }
}

export async function loginCrawler(task, proxy, _cookies = null) {
    console.log('🚀 启动 CloakBrowser (Login 爬虫)...\n');

    console.log(`👤 姓名: ${task.username}`);
    console.log(`📧 邮箱: ${task.email}`);

    const MAX_RETRIES = 5;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.log(`\n🔄 第 ${attempt + 1}/${MAX_RETRIES} 次重试...`);
        }

        let browser;

        try {
            const platform = os.platform();
            console.log(`🖥️  当前平台: ${platform} (${isLinux ? '无头模式' : '窗口模式'})`);
            console.log(`   📡 代理: ${proxy.host}:${proxy.port}`);

            // 启动 CloakBrowser
            browser = await launch({
                headless: isLinux,
                proxy: 'http://' + proxy.username + ':' + proxy.password + '@' + proxy.host + ':' + proxy.port,
                humanize: true,
                timezone: 'America/New_York',
                locale: 'en-US',
                viewport: { width: 1920, height: 1080 },
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
            await applyStealthPatches(page);
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');

            // 代理认证
            await page.authenticate({
                username: proxy.username,
                password: proxy.password,
            });
            console.log('   ✅ 代理认证已设置');

            page.setDefaultNavigationTimeout(60000);
            page.setDefaultTimeout(30000);

            await page.setViewport({ width: 1920, height: 1080 });

            // ==================== 步骤 1: 访问 https://adsterra.com ====================
            console.log('\n🌐 步骤 1: 访问 https://adsterra.com ...');
            try {
                await page.goto('https://adsterra.com', {
                    waitUntil: 'load',
                    timeout: 120000
                });
            } catch (e) {
                console.log('⚠️  页面加载超时，检查当前页面状态...');
                const currentUrl = page.url();
                if (!currentUrl.includes('adsterra.com')) {
                    throw new Error(`页面未能加载到 adsterra.com，当前 URL: ${currentUrl}`);
                }
                console.log('ℹ️  页面已部分加载，继续执行...');
            }

            // 等待页面渲染稳定
            await sleep(6000);

            const title = await page.title();
            console.log(`📄 页面标题：${title}`);

            await sleep(10000);
            // ==================== 步骤 3: 点击 LOG IN → 选择 Publisher ====================
            console.log('\n🔑 步骤 3: 点击 LOG IN → 选择 "As a publisher"...');
            await clickLoginDropdown(page);

            // 等待新页面/标签页打开（a 标签有 target="_blank"）
            console.log('⏳ 等待 Publisher 登录页面打开...');
            await sleep(5000);

            // 在所有页面中查找 publisher 登录页（比直接取最后一个页面更健壮）
            let publisherPage = null;
            for (let attempt = 0; attempt < 6; attempt++) {
                const allPages = await browser.pages();
                for (const p of allPages) {
                    const pUrl = p.url();
                    if (pUrl.includes('publishers.adsterra.com/login')) {
                        publisherPage = p;
                        console.log(`   ✅ 找到 Publisher 登录页: ${pUrl}`);
                        break;
                    }
                }
                if (publisherPage) break;
                // 还没加载出来，等 2s 再试
                console.log(`   ⏳ 等待新标签页加载... (${(attempt + 1) * 2}s)`);
                await sleep(2000);
            }

            if (!publisherPage) {
                // 没找到 publisher 页面，检查是否有新标签页打开
                const allPages = await browser.pages();
                if (allPages.length > 1) {
                    // 取最后一个页面作为 publisher 页面
                    publisherPage = allPages[allPages.length - 1];
                    console.log(`   ℹ️  使用最后打开的页面: ${publisherPage.url()}`);
                } else {
                    // 没有新标签页，使用当前页面
                    publisherPage = page;
                    console.log('   ℹ️  未检测到新标签页，使用当前页面');
                }

                // 如果当前页面不是 publisher 登录页，手动导航
                const pUrl = publisherPage.url();
                if (!pUrl.includes('publishers.adsterra.com/login')) {
                    console.log('   🔗 手动导航到 Publisher 登录页面...');
                    await publisherPage.goto('https://beta.publishers.adsterra.com/login', {
                        waitUntil: 'load',
                        timeout: 60000
                    });
                    await sleep(3000);
                    console.log(`   📍 最终 URL: ${publisherPage.url()}`);
                }
            }

            // 切换到 publisher 页面
            await publisherPage.setViewport({ width: 1920, height: 1080 });
            await publisherPage.bringToFront();
            await sleep(30000);

            // ==================== 步骤 4: 等待 Cloudflare 挑战完成（登录页） ====================
            console.log('\n🛡️  步骤 4: 等待 Cloudflare 挑战完成...');
            const cfBeforeForm = await waitForCloudflareChallenge(publisherPage, 90000);

            if (cfBeforeForm === 'success') {
                console.log('🎉 Cloudflare 挑战成功！登录表单已加载。');
            } else if (cfBeforeForm === 'failed') {
                console.log('💀 Cloudflare 挑战失败！页面被拦截，无法继续。');
                await browser.close();
                return { success: false, retryable: false, error: 'Cloudflare 挑战失败，页面被拦截' };
            } else {
                console.log('⚠️  Cloudflare 挑战超时，继续尝试填写表单...');
            }

            // ==================== 步骤 5: 填写登录表单 ====================
            console.log('\n📝 步骤 5: 填写登录表单...');
            await fillLoginForm(publisherPage, task.email, '123456789_Chen');

            // 截图保存（表单已填写）
            await publisherPage.screenshot({ path: 'step5-form-filled.png', fullPage: false });

            // ==================== 步骤 6: 提交登录 ====================
            console.log('\n🔑 步骤 6: 提交登录...');
            const loginSuccess = await submitLoginForm(publisherPage);
            let loginIp = null;     // 在 if 块外声明，后续打印需用到
            let cookiesJson = null; // 同上

            if (loginSuccess) {
                console.log('\n✅ 登录成功！已跳转到目标页面。');

                // ==================== 步骤 7: 获取登录 IP ====================
                console.log('\n🌐 步骤 7: 获取登录 IP（Active Sessions）...');
                try {
                    loginIp = await getLoginIp(publisherPage, 40);
                    if (loginIp) {
                        console.log(`   ✅ 登录 IP: ${loginIp}`);
                    }
                } catch (e) {
                    console.log(`   ⚠️  获取 IP 失败: ${e.message}`);
                }

                // ==================== 步骤 8: 等待 60s 后获取 cookies ====================
                console.log('\n⏳ 步骤 8: 等待 60 秒后获取 cookies...');
                for (let i = 0; i < 12; i++) {
                    await sleep(5000);
                    console.log(`   ⏳ 等待中... (${(i + 1) * 5}s)`);
                }

                try {
                    cookiesJson = await getCookiesJson(publisherPage);
                } catch (e) {
                    console.log(`   ⚠️  获取 cookies 失败: ${e.message}`);
                }

                // ==================== 步骤 9: 更新数据库 ====================
                if (task.email) {
                    console.log('\n💾 步骤 9: 更新数据库...');
                    try {
                        await updateAccountInDb(task.email, loginIp, cookiesJson || '');
                    } catch (e) {
                        console.log(`   ⚠️  数据库更新失败: ${e.message}`);
                    }
                } else {
                    console.log('   ℹ️  无邮箱信息，跳过数据库更新');
                }

            } else {
                console.log('⚠️  登录未完成，页面 URL: ' + publisherPage.url());
            }

            // 截图保存
            await publisherPage.screenshot({ path: 'step6-after-login.png', fullPage: false });

            // 打印最终信息
            console.log('\n========================================');
            const finalUrl = publisherPage.url();
            console.log('✅ Login 爬虫执行完成！');
            console.log(`🔗 最终页面地址：${finalUrl}`);
            if (loginIp) console.log(`🌐 登录 IP: ${loginIp}`);
            console.log('========================================\n');

            await browser.close();
            return { success: loginSuccess, url: finalUrl, loginIp };

        } catch (error) {
            console.error('❌ 发生错误:', error.message);

            if (browser) {
                try { await browser.close(); } catch (_) {}
                browser = null;
            }

            if (attempt < MAX_RETRIES - 1) {
                console.log('   🔄 将在下次循环中重试...\n');
                continue;
            }

            console.error('❌ 重试次数已用完');
            return { success: false, retryable: true, error: error.message };
        }
    }

    console.error('❌ 重试耗尽，未能成功执行登录流程');
    return { success: false, retryable: true, error: '重试耗尽，未能成功执行登录流程' };
}