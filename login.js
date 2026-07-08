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
 * 检测页面是否显示密码重置提示（安全策略更新导致密码被重置）
 */
async function checkPasswordResetMessage(page) {
    // 先尝试查找 toast/alert 中的错误信息（更精确）
    const toastResult = await page.evaluate(() => {
        const toastEl = document.querySelector(
            '[class*="toast" i], [class*="alert" i], [class*="message" i], ' +
            '[class*="notification" i], [role="alert"], ' +
            '[class*="error" i], [class*="warning" i], ' +
            '.MuiAlert-root, .MuiSnackbar-root, [class*="snackbar" i]'
        );
        if (toastEl) {
            const text = (toastEl.textContent || '').toLowerCase();
            return {
                found: text.includes('password was reset') || text.includes('security update') ||
                       text.includes('password') && text.includes('reset') && text.includes('email'),
                text: text.slice(0, 300),
                source: 'toast',
            };
        }
        return { found: false, source: 'no_toast' };
    });

    if (toastResult.found) {
        console.log('   🔄 Toast 检测到密码重置提示:', toastResult.text.slice(0, 200));
        return true;
    }

    // 降级：全文搜索
    const result = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        return {
            hasResetMessage: bodyText.includes('your password was reset') ||
                             bodyText.includes('password was reset') ||
                             bodyText.includes('security update') ||
                             (bodyText.includes('password') && bodyText.includes('reset') && bodyText.includes('email')),
            bodyPreview: bodyText.slice(0, 500),
        };
    });
    if (result.hasResetMessage) {
        console.log('   🔄 全文检测到密码重置提示:', result.bodyPreview.slice(0, 200));
    }
    return result.hasResetMessage;
}

/**
 * 处理密码重置流程：yopmail → 获取 restore 链接 → 设置新密码 → 重新登录
 *
 * 流程：
 *   1. 关闭当前代理浏览器
 *   2. 启动无代理浏览器访问 yopmail，获取重置密码邮件中的 restore 链接
 *   3. 关闭 yopmail 浏览器
 *   4. 启动代理浏览器访问 restore 链接
 *   5. 输入新密码 "123456789_Chen" 并点击 CONTINUE
 *   6. 等待跳转到登录页面
 *   7. 填写登录表单并提交
 *   8. 获取 loginIp 和 cookies
 *   9. 返回结果 { success, loginIp, cookiesJson }
 */
export async function handlePasswordResetAndRelogin(task, proxy) {
    console.log('\n🔐 ==== 开始密码重置流程 ====\n');

    // ========== 阶段 1: 无代理浏览器 → yopmail 获取 restore 链接 ==========
    console.log('📬 阶段 1: 打开 yopmail 获取重置密码链接...');

    let yopmailBrowser;
    let resetLink = null;

    try {
        yopmailBrowser = await launch({
            headless: isLinux,
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

        const yopmailPage = await yopmailBrowser.newPage();
        await applyStealthPatches(yopmailPage);
        await yopmailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
        yopmailPage.setDefaultNavigationTimeout(60000);
        yopmailPage.setDefaultTimeout(30000);
        await yopmailPage.setViewport({ width: 1920, height: 1080 });

        // 访问 yopmail
        console.log('   🌐 访问 https://yopmail.net/ ...');
        try {
            await yopmailPage.goto('https://yopmail.net/', {
                waitUntil: 'load',
                timeout: 60000
            });
        } catch (e) {
            console.log('   ⚠️  yopmail 加载超时，继续...');
        }
        await sleep(3000);

        // 关闭广告弹窗
        console.log('   🧹 关闭广告弹窗...');
        for (let attempt = 0; attempt < 5; attempt++) {
            await yopmailPage.evaluate(() => {
                const closeSelectors = [
                    '[aria-label="Close"]', '[aria-label="close"]', '.close', '.dismiss',
                    '[class*="close" i]', '[class*="dismiss" i]', 'button[class*="close" i]',
                    'div[class*="popup" i] button', 'div[class*="modal" i] button',
                    'div[class*="overlay" i] button', 'div[class*="ad" i] button',
                    'div[class*="ad" i] [class*="close" i]', 'iframe + button', 'button:has(svg)',
                ];
                for (const sel of closeSelectors) {
                    try { document.querySelectorAll(sel).forEach(el => { if (el.offsetParent !== null) el.click(); }); } catch (_) {}
                }
                ['div[class*="overlay" i]', 'div[class*="popup" i]', 'div[class*="modal" i]',
                 'div[class*="advertisement" i]', 'div[id*="google_ads" i]', 'ins.adsbygoogle']
                    .forEach(sel => { try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch (_) {} });
            });
            await sleep(500);
        }
        console.log('   ✅ 广告弹窗处理完成');

        // 提取邮箱前缀
        const emailPrefix = task.email.split('@')[0];
        console.log(`   📧 邮箱前缀: ${emailPrefix}`);

        // 输入邮箱前缀
        const inputSelectors = [
            '#login', 'input[name="login"]', 'input[name="email"]',
            'input[placeholder*="email" i]', 'input[placeholder*="mail" i]',
            'input[placeholder*="Enter" i]', 'input[type="text"]',
            'input:not([type="hidden"])',
        ];

        let inputFound = false;
        for (const sel of inputSelectors) {
            try {
                const inputEl = await yopmailPage.$(sel);
                if (inputEl) {
                    await inputEl.click({ clickCount: 3 });
                    await inputEl.type(emailPrefix, { delay: 30 });
                    const val = await yopmailPage.$eval(sel, e => e.value);
                    if (val === emailPrefix) {
                        console.log(`   ✅ 已输入邮箱前缀: "${val}" (selector: ${sel})`);
                        inputFound = true;
                        await yopmailPage.keyboard.press('Enter');
                        console.log('   ✅ 已按 Enter，进入邮箱');
                        break;
                    }
                }
            } catch (_) {}
        }

        if (!inputFound) {
            console.warn('   ⚠️  未找到邮箱输入框');
            await yopmailPage.screenshot({ path: 'step-reset-yopmail-input-failed.png', fullPage: true });
            await yopmailBrowser.close();
            return { success: false, error: '未找到 yopmail 邮箱输入框' };
        }

        // 等待邮箱加载
        await sleep(5000);

        // 再次清理广告
        await yopmailPage.evaluate(() => {
            ['div[class*="overlay" i]', 'div[class*="popup" i]', 'div[class*="modal" i]',
             'div[class*="ad" i]', 'ins.adsbygoogle']
                .forEach(sel => document.querySelectorAll(sel).forEach(el => { try { el.remove(); } catch (_) {} }));
        });
        await sleep(2000);

        await yopmailPage.screenshot({ path: 'step-reset-yopmail-inbox.png', fullPage: true });
        console.log('   📸 yopmail 截图已保存');

        // 在邮件列表中查找 Adsterra 密码重置邮件
        console.log('   🔍 查找密码重置邮件...');

        const emailClicked = await yopmailPage.evaluate(() => {
            const iframe = document.getElementById('ifinbox');
            if (!iframe) return { found: false, error: 'ifinbox not found' };
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc) return { found: false, error: 'ifinbox doc not accessible' };

                const items = doc.querySelectorAll('.m, .msg, .lm, [class*="message" i], [class*="email" i], div[onclick]');
                for (const item of items) {
                    const text = (item.textContent || '').toLowerCase();
                    // 匹配密码重置邮件（包含 reset / restore / password 等关键词）
                    if ((text.includes('reset') || text.includes('restore') || text.includes('password')) &&
                        (text.includes('adsterra') || text.includes('publisher'))) {
                        item.click();
                        return { found: true, text: (item.textContent || '').trim().slice(0, 200) };
                    }
                }
                // 降级：查找包含 "reset your password" 的邮件
                for (const item of items) {
                    const text = (item.textContent || '').toLowerCase();
                    if (text.includes('reset your password') || text.includes('password reset') ||
                        text.includes('restore your password') || text.includes('security update')) {
                        item.click();
                        return { found: true, text: (item.textContent || '').trim().slice(0, 200) };
                    }
                }
                return { found: false, error: 'no matching reset email', itemCount: items.length };
            } catch (e) {
                return { found: false, error: e.message };
            }
        });

        console.log(`   邮件查找结果: ${JSON.stringify(emailClicked)}`);

        if (!emailClicked.found) {
            console.warn('   ⚠️  未找到密码重置邮件');
            await yopmailPage.screenshot({ path: 'step-reset-email-not-found.png', fullPage: true });
            await yopmailBrowser.close();
            return { success: false, error: '未找到密码重置邮件' };
        }

        console.log('   ✅ 已点击密码重置邮件，等待内容加载...');
        await sleep(5000);

        // 从邮件内容中获取 restore 链接
        console.log('   🔗 获取密码重置链接...');

        for (let retry = 0; retry < 6 && !resetLink; retry++) {
            if (retry > 0) {
                await sleep(2000);
                console.log(`   ⏳ 重试获取链接... (${retry}/5)`);
            }

            resetLink = await yopmailPage.evaluate(() => {
                const iframe = document.getElementById('ifmail');
                if (iframe) {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (doc) {
                            const links = doc.querySelectorAll('a');
                            // 优先匹配 adsterra.com/restore/ 链接
                            for (const a of links) {
                                const href = a.href || '';
                                if (href.includes('adsterra.com/restore/')) {
                                    return { found: true, href, text: (a.textContent || '').trim(), source: 'ifmail', linkCount: links.length };
                                }
                            }
                            // 降级：任何包含 restore 的 adsterra 链接
                            for (const a of links) {
                                const href = a.href || '';
                                if (href.includes('adsterra.com') && (href.includes('restore') || href.includes('reset'))) {
                                    return { found: true, href, text: (a.textContent || '').trim(), source: 'ifmail_fallback', linkCount: links.length };
                                }
                            }
                            const bodyText = (doc.body?.innerText || '').slice(0, 300);
                            return { found: false, iframeId: 'ifmail', bodyPreview: bodyText, linkCount: links.length };
                        }
                    } catch (_) {}
                }
                return { found: false, error: 'ifmail not accessible' };
            });
        }

        if (!resetLink || !resetLink.found) {
            console.warn('   ⚠️  未找到密码重置链接');
            if (resetLink) {
                console.log(`   诊断: ${JSON.stringify(resetLink)}`);
            }
            await yopmailPage.screenshot({ path: 'step-reset-link-not-found.png', fullPage: true });
            await yopmailBrowser.close();
            return { success: false, error: '未找到密码重置链接' };
        }

        console.log(`   ✅ 密码重置链接: ${resetLink.href}`);
        await yopmailBrowser.close();
        console.log('   🔒 已关闭 yopmail 浏览器');

    } catch (error) {
        console.error('   ❌ yopmail 流程出错:', error.message);
        if (yopmailBrowser) {
            try { await yopmailBrowser.close(); } catch (_) {}
        }
        return { success: false, error: `yopmail 流程出错: ${error.message}` };
    }

    // ========== 阶段 2: 代理浏览器 → 访问 restore 链接 → 设置新密码 → 重新登录 ==========
    console.log('\n🔐 阶段 2: 访问密码重置链接并设置新密码...');

    let proxyBrowser;
    try {
        proxyBrowser = await launch({
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

        const restorePage = await proxyBrowser.newPage();
        await applyStealthPatches(restorePage);
        await restorePage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
        await restorePage.authenticate({
            username: proxy.username,
            password: proxy.password,
        });
        restorePage.setDefaultNavigationTimeout(60000);
        restorePage.setDefaultTimeout(30000);
        await restorePage.setViewport({ width: 1920, height: 1080 });

        // 访问 restore 链接
        console.log(`   🌐 访问 restore 链接...`);
        try {
            await restorePage.goto(resetLink.href, {
                waitUntil: 'load',
                timeout: 60000
            });
        } catch (e) {
            console.log('   ⚠️  restore 页面加载超时，继续...');
        }
        await sleep(5000);

        // 等待可能的 Cloudflare 挑战
        console.log('   🛡️  等待 Cloudflare 挑战（如有）...');
        const cfResult = await waitForCloudflareChallenge(restorePage, 60000);
        if (cfResult === 'failed') {
            console.log('   ❌ Cloudflare 挑战失败，无法继续');
            await proxyBrowser.close();
            return { success: false, error: 'Cloudflare 挑战失败' };
        }
        console.log(`   ✅ Cloudflare 状态: ${cfResult}`);

        // 查找 New password 输入框并输入密码（使用 Puppeteer type 模拟真实输入）
        console.log('   📝 输入新密码...');
        const newPassword = '123456789_Chen';

        // 先查找密码输入框是否存在，以及使用哪个选择器
        const passwordSelector = await restorePage.evaluate(() => {
            const selectors = [
                'input[name="password"]',
                'input[type="password"]',
                'input[name="newPassword"]',
                'input[name="new_password"]',
                'input[placeholder*="password" i]',
                'input[placeholder*="new" i]',
                '#password',
                '#newPassword',
                '#text-field-newPassword',
                '#text-field-password',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    return { selector: sel, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder || '' };
                }
            }
            // 调试：打印所有 input
            const allInputs = Array.from(document.querySelectorAll('input')).map(i => ({
                id: i.id, name: i.name, type: i.type, placeholder: i.placeholder,
                className: i.className.slice(0, 60),
            }));
            const allButtons = Array.from(document.querySelectorAll('button')).map(b => ({
                id: b.id, text: (b.textContent || '').trim().slice(0, 40),
                className: b.className.slice(0, 60),
            }));
            return { selector: null, debug: { inputs: allInputs, buttons: allButtons } };
        });

        if (!passwordSelector.selector) {
            console.warn('   ⚠️  未找到密码输入框，诊断信息:');
            console.log(`      ${JSON.stringify(passwordSelector.debug)}`);
            await restorePage.screenshot({ path: 'step-reset-no-password-input.png', fullPage: true });
            await proxyBrowser.close();
            return { success: false, error: '未找到新密码输入框' };
        }

        console.log(`   ✅ 找到密码输入框: ${passwordSelector.selector} (id=${passwordSelector.id}, name=${passwordSelector.name})`);

        // 使用 type() 模拟真实键盘输入（React/MUI 需要）
        const pwInput = await restorePage.$(passwordSelector.selector);
        await pwInput.click();
        await pwInput.click({ clickCount: 3 });  // 三击全选
        await pwInput.type(newPassword, { delay: 50 });

        // 验证输入
        const actualValue = await restorePage.$eval(passwordSelector.selector, el => el.value);
        console.log(`   ✅ 已输入新密码: "${'*'.repeat(actualValue.length)}"${actualValue === newPassword ? ' ✔' : ' ✗'}`);
        await sleep(1000);

        // 查找 CONTINUE 按钮并点击
        console.log('   🔘 查找 CONTINUE 按钮...');
        const continueClicked = await restorePage.evaluate(() => {
            const allElements = document.querySelectorAll('button, a, input[type="submit"], [role="button"]');
            for (const el of allElements) {
                const text = (el.textContent || '').trim().toUpperCase();
                const value = ((el.value || '')).toUpperCase();
                if (text === 'CONTINUE' || text === 'SUBMIT' || text === 'RESET' || text === 'RESET PASSWORD' ||
                    value === 'CONTINUE' || value === 'SUBMIT' || value === 'RESET') {
                    el.click();
                    return { found: true, text: (el.textContent || el.value || '').trim().slice(0, 30), tag: el.tagName };
                }
            }
            // 降级：找页面上第一个可点击的提交按钮
            for (const el of allElements) {
                const type = el.getAttribute('type') || '';
                if (type === 'submit') {
                    el.click();
                    return { found: true, text: (el.textContent || el.value || '').trim().slice(0, 30), tag: el.tagName, method: 'type_submit' };
                }
            }
            // 降级：找 form.submit()
            const form = document.querySelector('form');
            if (form) {
                form.submit();
                return { found: true, text: 'form.submit()', method: 'form_submit' };
            }
            return { found: false };
        });

        if (!continueClicked.found) {
            console.warn('   ⚠️  未找到 CONTINUE 按钮');
            await restorePage.screenshot({ path: 'step-reset-no-continue-button.png', fullPage: true });
            await proxyBrowser.close();
            return { success: false, error: '未找到 CONTINUE 按钮' };
        }

        console.log(`   ✅ 已点击 ${continueClicked.text} 按钮`);
        await sleep(3000);

        // 等待页面跳转到登录页
        console.log('   ⏳ 等待跳转到登录页面...');
        let redirectedToLogin = false;
        for (let i = 0; i < 30; i++) {
            const curUrl = restorePage.url();
            if (curUrl.includes('publishers.adsterra.com/login')) {
                console.log(`   ✅ 已跳转到登录页面 (${i * 2}s)`);
                redirectedToLogin = true;
                break;
            }
            await sleep(2000);
            if (i % 5 === 0) {
                console.log(`   ⏳ 等待中... (${i * 2}s) URL: ${curUrl}`);
            }
        }

        if (!redirectedToLogin) {
            console.warn(`   ⚠️  未跳转到登录页面，当前 URL: ${restorePage.url()}`);
            await restorePage.screenshot({ path: 'step-reset-no-redirect.png', fullPage: true });
            // 即使没跳转，也尝试继续
        }

        // ========== 阶段 3: 重新登录 ==========
        console.log('\n🔑 阶段 3: 使用新密码重新登录...');

        // 处理可能的 cookie 弹窗
        console.log('   🍪 检查 Cookie 弹窗...');
        for (let retry = 0; retry < 6; retry++) {
            await sleep(2000);
            const cookieResult = await restorePage.evaluate(() => {
                const dialog = document.querySelector('#CybotCookiebotDialog');
                if (dialog) {
                    const buttons = dialog.querySelectorAll('button');
                    for (const btn of buttons) {
                        const btnId = btn.id || '';
                        const btnText = (btn.textContent || '').toLowerCase().trim();
                        if (btnId.includes('LevelOptinAllowAll') || btnText === 'allow all') {
                            btn.click();
                            return { found: true };
                        }
                    }
                    if (buttons.length > 0) { buttons[0].click(); return { found: true }; }
                }
                return { found: false };
            });
            if (cookieResult.found) {
                console.log('   ✅ Cookie 弹窗已关闭');
                await sleep(2000);
                break;
            }
        }

        // 填写登录表单前先处理 Cloudflare 挑战
        console.log('   🛡️  等待 Cloudflare 挑战完成（登录页）...');
        const cfBeforeLogin = await waitForCloudflareChallenge(restorePage, 90000);
        if (cfBeforeLogin === 'failed') {
            console.log('   ❌ Cloudflare 挑战失败，无法继续');
            await proxyBrowser.close();
            return { success: false, error: 'Cloudflare 挑战失败' };
        }
        console.log(`   ✅ Cloudflare 状态: ${cfBeforeLogin}`);

        // 填写登录表单
        console.log('   📝 填写登录表单...');
        await fillLoginForm(restorePage, task.email, newPassword);

        // 提交登录
        console.log('   🎯 提交登录...');
        const loginSuccess = await submitLoginForm(restorePage);

        let loginIp = null;
        let cookiesJson = null;

        if (loginSuccess) {
            console.log('   ✅ 密码重置后登录成功！');

            // 获取登录 IP
            console.log('   🌐 获取登录 IP...');
            try {
                loginIp = await getLoginIp(restorePage, 40);
                if (loginIp) console.log(`   ✅ 登录 IP: ${loginIp}`);
            } catch (e) {
                console.log(`   ⚠️  获取 IP 失败: ${e.message}`);
            }

            // 等待 60s 后获取 cookies
            console.log('   ⏳ 等待 60 秒后获取 cookies...');
            for (let i = 0; i < 12; i++) {
                await sleep(5000);
                console.log(`   ⏳ 等待中... (${(i + 1) * 5}s)`);
            }

            try {
                cookiesJson = await getCookiesJson(restorePage);
            } catch (e) {
                console.log(`   ⚠️  获取 cookies 失败: ${e.message}`);
            }

            await restorePage.screenshot({ path: 'step-reset-login-success.png', fullPage: false });

            await proxyBrowser.close();
            console.log('\n🔐 ==== 密码重置流程完成 ====\n');
            return { success: true, loginIp, cookiesJson };
        } else {
            console.log('   ❌ 密码重置后登录仍然失败');
            await restorePage.screenshot({ path: 'step-reset-relogin-failed.png', fullPage: false });
            await proxyBrowser.close();
            return { success: false, error: '密码重置后登录仍失败' };
        }

    } catch (error) {
        console.error('   ❌ 重置流程出错:', error.message);
        if (proxyBrowser) {
            try { await proxyBrowser.close(); } catch (_) {}
        }
        return { success: false, error: `重置流程出错: ${error.message}` };
    }
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

                // 等待页面加载完成，确保错误信息已渲染
                await sleep(5000);

                // 诊断页面内容
                const pageDiag = await publisherPage.evaluate(() => {
                    const bodyText = (document.body?.innerText || '').toLowerCase();
                    const toastEl = document.querySelector('[class*="toast" i], [class*="alert" i], [class*="message" i], [class*="notification" i], [role="alert"]');
                    const toastText = toastEl ? (toastEl.textContent || '').trim().slice(0, 200) : '';
                    return {
                        bodyPreview: bodyText.slice(0, 1000),
                        toastText,
                        url: window.location.href,
                        title: document.title,
                    };
                });
                console.log('   📋 页面诊断:');
                console.log(`      URL: ${pageDiag.url}`);
                console.log(`      Title: ${pageDiag.title}`);
                if (pageDiag.toastText) console.log(`      Toast: ${pageDiag.toastText}`);
                console.log(`      Body preview: ${pageDiag.bodyPreview.slice(0, 300)}`);

                // 检查是否因安全策略更新导致密码被重置
                const needsReset = await checkPasswordResetMessage(publisherPage);

                if (needsReset) {
                    console.log('\n🔄 检测到密码重置提示，启动密码重置流程...');
                    await browser.close(); // 关闭当前浏览器，让 handlePasswordResetAndRelogin 自行管理浏览器

                    const resetResult = await handlePasswordResetAndRelogin(task, proxy);

                    if (resetResult.success) {
                        loginIp = resetResult.loginIp;
                        cookiesJson = resetResult.cookiesJson;

                        // 更新数据库
                        if (task.email) {
                            console.log('\n💾 更新数据库（密码重置后）...');
                            try {
                                await updateAccountInDb(task.email, loginIp, cookiesJson || '');
                            } catch (e) {
                                console.log(`   ⚠️  数据库更新失败: ${e.message}`);
                            }
                        }

                        // 重置流程中已关闭浏览器，打印最终信息后直接返回
                        console.log('\n========================================');
                        console.log('✅ Login 爬虫执行完成（密码重置后）！');
                        if (loginIp) console.log(`🌐 登录 IP: ${loginIp}`);
                        console.log('========================================\n');

                        return { success: true, url: 'https://beta.publishers.adsterra.com/login', loginIp };
                    }

                    // 重置失败，返回错误
                    console.log('❌ 密码重置流程失败');
                    return { success: false, retryable: false, error: resetResult.error || '密码重置流程失败' };
                } else {
                    console.log('⚠️  登录未完成，页面 URL: ' + publisherPage.url());
                }
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