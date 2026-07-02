import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';
import { ResidentProxyManager } from './proxy.js';
import {loginCrawler} from "./login.js";

const PROXY_API_KEY = '629a2e2ce2532c8c4ad034fbc4f3c8a5';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

// DB_CONFIG 从 shared/db.js 导入，用于爬虫自身的业务表操作（adsterra_account 等）

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

// ==================== Cloudflare Turnstile 反检测与交互 ====================

/**
 * 应用反检测补丁，隐藏无头模式特征（在页面导航前调用）
 * 针对 Cloudflare Turnstile 的 headless 检测做全面规避
 */
async function applyStealthPatches(page) {
    await page.evaluateOnNewDocument(() => {
        // 1. 隐藏 webdriver 属性（Cloudflare Turnstile 检测重点）
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });

        // 2. 模拟真实的 plugins 列表
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                { name: 'Native Client', filename: 'internal-nacl-plugin' },
            ],
        });

        // 3. 添加 chrome 对象（真实 Chrome 特有，headless 模式下缺失）
        window.chrome = {
            runtime: {},
            loadTimes: () => {},
            csi: () => {},
            app: { isInstalled: false },
        };

        // 4. 设置语言
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
        });

        // 5. 覆盖 permissions API（避免 Turnstile 检测通知权限）
        if (typeof navigator.permissions !== 'undefined') {
            const originalQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (params) => {
                if (params.name === 'notifications') {
                    return Promise.resolve({ state: 'denied' });
                }
                return originalQuery(params);
            };
        }

        // 6. 覆盖 WebGL 指纹（避免被识别为虚拟 GPU）
        const getParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return 'Intel Inc.';          // UNMASKED_VENDOR_WEBGL
            if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
            return getParam.call(this, param);
        };
    });
}

/**
 * 主动尝试解决 Turnstile 挑战
 *
 * 策略依次尝试：
 *   1. 检查 token 是否已自动生成
 *   2. 通过 turnstile.execute() API 主动触发
 *   3. 点击 Turnstile iframe 区域（模拟用户点击复选框）
 */
async function tryResolveTurnstile(page) {
    // 方法 1: 检查 token 是否已经生成
    const tokenCheck = await page.evaluate(() => {
        const input = document.querySelector('input[name="cloudflareCaptchaToken"]');
        return { exists: !!input, value: input?.value || '' };
    });
    if (tokenCheck.value) {
        console.log(`   ✅ Turnstile token 已存在 (${tokenCheck.value.slice(0, 20)}...)`);
        return { resolved: true, method: 'token_exists' };
    }
    if (!tokenCheck.exists) {
        console.log('   ℹ️  未检测到 Turnstile token 输入框（可能挑战模式不同）');
    }

    // 方法 2: 通过 Turnstile JavaScript API 主动执行
    const apiResult = await page.evaluate(() => {
        if (typeof turnstile !== 'undefined') {
            const widgets = document.querySelectorAll('.cf-turnstile');
            if (widgets.length > 0) {
                for (const w of widgets) {
                    // 优先用 data-widget-id
                    let id = w.getAttribute('data-widget-id');
                    if (!id) {
                        // 尝试从 turnstile.render 返回值获取
                        const allWidgets = document.querySelectorAll('[data-widget-id]');
                        if (allWidgets.length > 0) {
                            id = allWidgets[0].getAttribute('data-widget-id');
                        }
                    }
                    if (id) {
                        try {
                            turnstile.execute(id);
                            return { executed: true, method: 'turnstile_execute', widgetId: id };
                        } catch (e) {
                            return { executed: false, error: e.message };
                        }
                    }
                }
            }
        }
        return { executed: false };
    });
    if (apiResult.executed) {
        console.log(`   🎯 通过 Turnstile API 触发执行 (widget: ${apiResult.widgetId})`);
        return { resolved: false, method: 'turnstile_execute' };
    }

    // 方法 3: 点击 Turnstile iframe（模拟用户点击 "I'm not a robot" 复选框）
    const clickResult = await page.evaluate(() => {
        // 查找 Turnstile iframe（cross-origin，只能获取坐标）
        const iframes = document.querySelectorAll('iframe');
        for (const frame of iframes) {
            const src = (frame.src || '').toLowerCase();
            if (src.includes('challenges.cloudflare.com') || src.includes('cf-turnstile')) {
                const rect = frame.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                }
            }
        }

        // 查找 Turnstile 容器 div（点击 div 区域）
        const turnstileDiv = document.querySelector('.cf-turnstile');
        if (turnstileDiv) {
            const rect = turnstileDiv.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                return { found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
            }
        }

        return { found: false };
    });

    if (clickResult.found) {
        console.log(`   🖱️  点击 Turnstile 区域 (${clickResult.x}, ${clickResult.y})`);
        await page.mouse.click(clickResult.x, clickResult.y);
        return { resolved: false, method: 'iframe_click' };
    }

    console.log('   ℹ️  未找到 Turnstile iframe/div，等待自动完成...');
    return { resolved: false, method: 'passive_wait' };
}

/**
 * 检测 Cloudflare 挑战状态
 *
 * 返回三种状态之一：
 *   - success:     挑战通过，真实页面已加载
 *   - challenging: 挑战进行中
 *   - failed:      挑战失败（被拦截、拒绝访问等）
 */
async function detectCloudflareStatus(page) {
    const status = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const title = document.title;

        // ====== 挑战失败的标志 ======
        const failureKeywords = [
            'access denied',
            'blocked',
            'sorry, you have been blocked',
            'your request has been blocked',
            'forbidden',
            'error 403',
            'error 1020',
            'error 1006',
            'error 1007',
            'error 1008',
            'your ip',
            'your ip address has been',
            'owner of this website has banned',
            'unable to verify',
            'attention required',
            'complete the security check',
            '被拦截',
            '访问被拒绝',
            '您的请求已被拦截',
            '禁止访问',
        ];
        const hasFailureText = failureKeywords.some(kw => bodyText.includes(kw));

        // 页面标题是错误页（不同于挑战页）
        const isErrorTitle = title.includes('Access denied') || title.includes('Blocked') || title.includes('403') || title.includes('Forbidden');

        // Cloudflare 封锁页面特有的元素
        const hasErrorElement = !!(
            document.querySelector('#error-overview') ||
            document.querySelector('.error-code') ||
            document.querySelector('[class*="attack"]') ||
            document.querySelector('#cf-error-details')
        );

        const isFailed = hasFailureText || isErrorTitle || hasErrorElement;

        // ====== 挑战进行中的标志 ======
        // 1. URL 特征：Cloudflare 挑战页的 URL 模式
        const url = window.location.href;
        const isCfUrl = url.includes('/cdn-cgi/challenge') || url.includes('/cdn-cgi/l/') || url.includes('__cf_chl_');

        // 2. body 关键词（精确匹配 Cloudflare 挑战页文案）
        const challengeKeywords = [
            'just a moment',
            'checking your browser',
            'ddos protection',
            'ray id:',
            'performance & security by cloudflare',
            '正在验证您是否是真人',
            '请稍候，我们正在检查您的浏览器',
            'enable javascript and cookies',
            'please turn javascript on and reload',
            'checking if the site connection is secure',
            'reviewing the security of your connection',
            'attention required!',
            'complete the security check to access',
        ];
        const hasChallengeText = challengeKeywords.some(kw => bodyText.includes(kw));

        // 3. 短 body + 特定标题 → 大概率是挑战页
        const isCfTitle = title.includes('Just a moment') || title.includes('Checking');
        const isShortBody = bodyText.length > 0 && bodyText.length < 80;
        const looksLikeChallenge = isShortBody && (isCfTitle || isCfUrl);

        // 4. Cloudflare 挑战特有的 DOM 元素
        const hasChallengeElement = !!(
            document.querySelector('.cf-turnstile') ||
            document.querySelector('#turnstile-widget') ||
            document.querySelector('[data-cf-turnstile]') ||
            document.querySelector('#challenge-form') ||
            document.querySelector('#challenge-running') ||
            document.querySelector('#cf-content') ||
            document.querySelector('#cf-please-wait') ||
            document.querySelector('.cf-browser-verification') ||
            document.querySelector('.lds-ring')
        );

        // 5. 有 iframe 且 body 很短 → Turnstile 挑战特征
        const hasIframe = document.querySelectorAll('iframe').length > 0;

        // ====== 挑战成功的标志 ======
        // 检测 signup 页面特有的内容（从实际页面提取的关键词）
        const hasSignupContent = !!(
            bodyText.includes('sign up as a') ||
            bodyText.includes('monetize website') ||
            bodyText.includes('monetize') ||
            bodyText.includes('contact us') ||
            bodyText.includes('log in') ||
            bodyText.includes('publisher') ||
            bodyText.includes('advertiser') ||
            bodyText.includes('create account') ||
            bodyText.includes('get started') ||
            bodyText.includes('join now') ||
            bodyText.includes('register') ||
            bodyText.includes('dashboard') ||
            document.querySelector('input[type="email"]') ||
            document.querySelector('input[type="password"]') ||
            document.querySelector('input[name*="email" i]') ||
            document.querySelector('input[placeholder*="email" i]')
        );

        // ====== Turnstile 挑战状态（关键！）======
        // Turnstile 嵌入在 signup 页面中，通过 cloudflareCaptchaToken 来判断
        // 挑战进行中 → token 为空；挑战完成 → token 有值
        const turnstileToken = document.querySelector('input[name="cloudflareCaptchaToken"]');
        const turnstilePending = turnstileToken && !turnstileToken.value;  // token 存在但为空
        const turnstileDone = turnstileToken && turnstileToken.value;      // token 有值

        // 检测 Turnstile 是否预期会出现（cf-turnstile div 或 Turnstile API 已加载）
        const turnstileDiv = document.querySelector('.cf-turnstile');
        const turnstileExpected = !!turnstileDiv || typeof window.turnstile !== 'undefined';

        const isChallenging = !isFailed && (
            isCfUrl ||                          // URL 是 CF 挑战页
            hasChallengeText ||                 // 有 CF 挑战关键词
            hasChallengeElement ||              // 有 CF 挑战元素
            looksLikeChallenge ||               // 短 body + CF 标题/URL
            (hasIframe && isShortBody) ||       // iframe + 短 body
            turnstilePending ||                 // Turnstile token 存在但为空 → 挑战进行中
            // Turnstile div 存在但 token 还没出现 → 挑战加载中
            (turnstileExpected && !turnstileDone) ||
            // verifying 等关键词，但仅在 signup 内容未出现时才算挑战
            (!hasSignupContent && (bodyText.includes('verifying') || bodyText.includes('正在验证')))
        );

        // 挑战成功条件：
        // - 如果 Turnstile 预期出现，必须 token 有值才算成功
        // - 如果 Turnstile 不预期出现，有 signup 内容即可
        const isSuccess = !isChallenging && !isFailed && (
            turnstileDone ||                    // Turnstile token 已生成 → 成功
            (!turnstileExpected && hasSignupContent)  // 没有 Turnstile，有 signup 内容即可
        );

        return {
            isChallenging: isChallenging,
            isSuccess: isSuccess,
            isFailed: isFailed,
            title: title,
            url: url,
            hasRealContent: hasSignupContent,
            turnstileExpected: turnstileExpected,
            turnstilePending: turnstilePending,
            turnstileDone: turnstileDone,
            hasChallengeText: hasChallengeText,
            hasChallengeElement: hasChallengeElement,
            hasFailureText: hasFailureText,
            hasIframe: hasIframe,
            isShortBody: isShortBody,
            bodyLen: bodyText.length,
            bodyPreview: bodyText.slice(0, 200),
            iframeCount: document.querySelectorAll('iframe').length,
        };
    });

    return status;
}

/**
 * 等待 Cloudflare 挑战完成
 * @param {Page} page - Puppeteer 页面对象
 * @param {number} maxWaitMs - 最大等待时间（毫秒）
 * @returns {boolean} 是否挑战成功
 */
async function waitForCloudflareChallenge(page, maxWaitMs = 90000) {
    console.log('⏳ 检测 Cloudflare 挑战...');
    const startTime = Date.now();
    let lastStatus = null;
    let stuckCount = 0;
    let lastBodyText = '';
    let turnstileAttempted = false;

    while (Date.now() - startTime < maxWaitMs) {
        const status = await detectCloudflareStatus(page);
        lastStatus = status;

        // 挑战通过
        if (status.isSuccess) {
            return 'success';
        }

        // 挑战失败（被拦截、拒绝访问等），立即退出
        if (status.isFailed) {
            console.log('❌ Cloudflare 挑战失败！');
            console.log(`   标题: "${status.title}"`);
            console.log(`   body 预览: ${status.bodyPreview?.slice(0, 100)}`);
            return 'failed';
        }

        // 卡死检测：body 文本连续不变 + 没有真实内容 → 大概率是拦截页
        if (status.bodyPreview === lastBodyText && !status.hasRealContent) {
            stuckCount++;
            if (stuckCount >= 8) {
                console.log('❌ Cloudflare 挑战失败（页面卡死，内容无变化）！');
                console.log(`   标题: "${status.title}"`);
                console.log(`   body 预览: ${status.bodyPreview?.slice(0, 100)}`);
                console.log(`   body 长度: ${status.bodyLen}`);
                console.log(`   连续不变次数: ${stuckCount}`);
                return 'failed';
            }
        } else {
            stuckCount = 0;
        }
        lastBodyText = status.bodyPreview;

        const elapsed = Math.round((Date.now() - startTime) / 1000);

        // 在挑战过程中主动尝试解决 Turnstile（每 4 秒尝试一次，避免频繁点击）
        if (elapsed > 2 && (elapsed % 4 === 0) && !turnstileAttempted) {
            console.log(`   🔄 主动触发 Turnstile 挑战 (${elapsed}s)...`);
            await tryResolveTurnstile(page);
            turnstileAttempted = true;
        }
        // 每隔几秒重置尝试标记，以便重试
        if (elapsed % 4 === 1) {
            turnstileAttempted = false;
        }

        if (status.isChallenging) {
            console.log(`   🔄 挑战进行中... (${elapsed}s)${stuckCount > 0 ? ` 卡死计数: ${stuckCount}` : ''}`);
        } else {
            // 挑战标志消失了，但还没判定成功 → 打印原因帮助调试
            console.log(`   ⏳ 等待页面加载... (${elapsed}s) bodyLen=${status.bodyLen} hasRealContent=${status.hasRealContent} turnstileExpected=${status.turnstileExpected} turnstilePending=${status.turnstilePending} turnstileDone=${status.turnstileDone}`);
            console.log(`      挑战关键词: ${status.hasChallengeText}, 挑战元素: ${status.hasChallengeElement}, iframe: ${status.hasIframe}`);
        }

        await sleep(2000);
    }

    // 超时 - 最后再尝试一次 Turnstile
    console.log('⚠️  Cloudflare 挑战等待超时，进行最后一次 Turnstile 触发...');
    await tryResolveTurnstile(page);
    await sleep(5000);

    // 最终检查
    const finalCheck = await detectCloudflareStatus(page);
    if (finalCheck.isSuccess) {
        console.log('🎉 最后一次 Turnstile 触发后挑战成功！');
        return 'success';
    }

    console.log('⚠️  Cloudflare 挑战等待超时，最终状态:');
    console.log(`   isChallenging: ${finalCheck.isChallenging}`);
    console.log(`   isFailed: ${finalCheck.isFailed}`);
    console.log(`   hasRealContent: ${finalCheck.hasRealContent}`);
    console.log(`   turnstileDone: ${finalCheck.turnstileDone}`);
    console.log(`   标题: "${finalCheck.title}"`);
    console.log(`   body 预览: ${finalCheck.bodyPreview?.slice(0, 100)}`);
    return 'timeout';
}

export async function signupCrawler(task, proxy) {
    console.log('🚀 启动 CloakBrowser (Sign Up 爬虫)...\n');

    console.log(`👤 姓名: ${task.username}`);
    console.log(`📧 邮箱: ${task.email}`);

    // 以 username 为基准生成登录名称
    const loginName = task.username.replace(/\s+/g, '').toLowerCase() + Math.random().toString(36).substring(2, 6);
    console.log(`🔑 登录名: ${loginName}\n`);

    // 预 SIGN UP 阶段重试循环（最多 5 次）
    const MAX_RETRIES = 5;
    let signupClicked = false;

    for (let attempt = 0; attempt < MAX_RETRIES && !signupClicked; attempt++) {
        if (attempt > 0) {
            console.log(`\n🔄 第 ${attempt + 1}/${MAX_RETRIES} 次重试...`);
        }

        let browser;
        let proxyManager;  // 用于 confirm link 阶段的代理

        try {
            const platform = os.platform();
            console.log(`🖥️  当前平台: ${platform} (${isLinux ? '无头模式' : '窗口模式'})`);
            console.log(`   📡 代理: ${proxy.host}:${proxy.port}`);

            // 启动 CloakBrowser - Linux 使用无头模式，Windows 使用窗口模式
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

            // 设置默认超时
            page.setDefaultNavigationTimeout(60000);
            page.setDefaultTimeout(30000);

            // 设置视口大小
            await page.setViewport({ width: 1920, height: 1080 });

            // 步骤 1: 访问 https://adsterra.com
            // 使用 'load' 替代 'networkidle2'，避免因后台持续请求导致超时
            console.log('🌐 步骤 1: 访问 https://adsterra.com ...');
            try {
                await page.goto('https://adsterra.com', {
                    waitUntil: 'load',
                    timeout: 120000
                });
            } catch (e) {
                // 如果 load 事件也超时，先检查页面是否已有内容
                console.log('⚠️  页面加载超时，检查当前页面状态...');
                const currentUrl = page.url();
                if (!currentUrl.includes('adsterra.com')) {
                    throw new Error(`页面未能加载到 adsterra.com，当前 URL: ${currentUrl}`);
                }
                console.log('ℹ️  页面已部分加载，继续执行...');
            }

            // 额外等待确保页面渲染完成
            await sleep(3000);

            console.log('✅ 页面加载完成！');
            const title = await page.title();
            console.log(`📄 页面标题：${title}`);

            // 截图首页
            await page.screenshot({ path: 'step1-home.png', fullPage: true });
            console.log('📸 首页截图已保存：step1-home.png\n');

            // 步骤 2: 点击右上角的 SIGN UP 按钮
            console.log('🔍 步骤 2: 查找并点击 SIGN UP 按钮...');

            await sleep(2000);

            // 点击 SIGN UP 按钮
            await page.evaluate(() => {
                const elements = document.querySelectorAll('a, button, [role="button"]');
                for (const el of elements) {
                    const text = el.textContent.trim().toUpperCase();
                    if (text === 'SIGN UP' || text === 'SIGNUP' || text === 'Sign Up') {
                        el.click();
                        return true;
                    }
                }
                return false;
            });

            console.log('✅ 已点击 SIGN UP 按钮\n');
            await sleep(3000);

            // 截图弹窗
            await page.screenshot({ path: 'step2-after-signup-click.png', fullPage: true });
            console.log('📸 点击 SIGN UP 后截图已保存：step2-after-signup-click.png\n');

            // 步骤 3: 在弹出的 Sign up 弹窗中，点击 START EARNING 按钮
            console.log('🔍 步骤 3: 查找并点击 START EARNING 按钮...');

            await sleep(2000);

            // 查找 START EARNING 按钮并点击
            const startEarningResult = await page.evaluate(() => {
                const modalSelectors = ['.modal', '.popup', '.overlay', '[role="dialog"]', '.modal-content', '.popup-content'];
                let modalElement = null;
                for (const selector of modalSelectors) {
                    modalElement = document.querySelector(selector);
                    if (modalElement) break;
                }

                const searchScope = modalElement || document;
                const elements = searchScope.querySelectorAll('a, button, [role="button"]');

                for (const el of elements) {
                    const text = el.textContent.trim();
                    if (text.toUpperCase().includes('START EARNING')) {
                        return {
                            found: true,
                            tag: el.tagName,
                            text: text,
                            href: el.href || null,
                            className: el.className,
                            inModal: !!modalElement
                        };
                    }
                }

                return { found: false, inModal: !!modalElement };
            });

            console.log('查找 START EARNING 元素结果:', JSON.stringify(startEarningResult, null, 2));

            if (startEarningResult.found) {
                // 记录点击前的所有标签页
                const pagesBefore = await browser.pages();
                console.log(`📑 点击前有 ${pagesBefore.length} 个标签页`);

                // 点击按钮
                await page.evaluate(() => {
                    const elements = document.querySelectorAll('a, button, [role="button"]');
                    for (const el of elements) {
                        if (el.textContent.trim().toUpperCase().includes('START EARNING')) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                });

                console.log('✅ 已点击 START EARNING 按钮\n');

                // 等待新标签页出现
                console.log('⏳ 等待新标签页 (最多 30 秒)...');
                await sleep(30000);

                // 获取所有标签页
                const pagesAfter = await browser.pages();
                console.log(`📑 点击后有 ${pagesAfter.length} 个标签页`);

                // 查找新的标签页（排除 adsterra.com 主站和 cloudflare blob）
                let targetPage = null;
                let targetUrl = null;

                for (const p of pagesAfter) {
                    const url = p.url();
                    // 检查是否是新打开的页面（不是原始首页，也不是 blob URL）
                    if (url && !url.startsWith('blob:') && url !== 'about:blank') {
                        // 检查是否是 publishers.adsterra.com 的页面
                        if (url.includes('publishers.adsterra.com') || url.includes('beta.publishers')) {
                            targetPage = p;
                            targetUrl = url;
                            break;
                        }
                    }
                }

                // 如果没有找到 publishers 页面，找任何其他 http/https 页面
                if (!targetPage) {
                    for (const p of pagesAfter) {
                        const url = p.url();
                        if (url && url.startsWith('http') && !url.startsWith('blob:') && url !== 'about:blank' && !url.includes('adsterra.com')) {
                            targetPage = p;
                            targetUrl = url;
                            break;
                        }
                    }
                }

                if (targetPage && targetUrl) {
                    console.log(`\n✅ 检测到新标签页：${targetUrl}`);

                    try {
                        await targetPage.bringToFront();
                        await applyStealthPatches(targetPage);
                        await targetPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
                        // 为新标签页设置代理认证（新标签不继承 page.authenticate）
                        await targetPage.authenticate({
                            username: proxy.username,
                            password: proxy.password,
                        });
                        await sleep(3000);

                        const finalTitle = await targetPage.title();
                        console.log(`📄 页面标题：${finalTitle}`);

                        // 步骤 5: 处理 cookie 同意弹窗（先处理，避免弹出干扰 Cloudflare 挑战）
                        console.log('\n🍪 步骤 5: 检查并关闭 Cookie 同意弹窗...');

                        // 轮询等待 Cookie 弹窗出现，最多等 15 秒
                        let cookieResult = null;
                        for (let retry = 0; retry < 8; retry++) {
                            await sleep(2000);

                            cookieResult = await targetPage.evaluate(() => {
                                const cookiebotDialog = document.querySelector('#CybotCookiebotDialog');

                                if (cookiebotDialog) {
                                    const buttons = cookiebotDialog.querySelectorAll('button');

                                    // 优先查找 "Allow all" 按钮
                                    for (const btn of buttons) {
                                        const btnId = btn.id || '';
                                        const btnText = (btn.textContent || '').toLowerCase().trim();

                                        if (btnId.includes('LevelOptinAllowAll') && !btnId.includes('Selection') ||
                                            (btnText === 'allow all' && !btnText.includes('selection'))) {
                                            return {
                                                found: true,
                                                buttonTag: btn.tagName,
                                                buttonText: btnText,
                                                buttonId: btn.id,
                                                dialogFound: true,
                                                isAllowAll: true
                                            };
                                        }
                                    }

                                    // 找第一个非分类按钮
                                    for (const btn of buttons) {
                                        const btnId = btn.id || '';
                                        const btnText = (btn.textContent || '').toLowerCase().trim();

                                        if (!btnId.includes('ContentCookieContainer') &&
                                            !btnId.includes('IABv2') &&
                                            !btnText.includes('necessary') &&
                                            !btnText.includes('preferences') &&
                                            !btnText.includes('statistics') &&
                                            !btnText.includes('marketing') &&
                                            !btnText.includes('unclassified')) {
                                            return {
                                                found: true,
                                                buttonTag: btn.tagName,
                                                buttonText: (btn.textContent || '').trim().slice(0, 50),
                                                buttonId: btn.id,
                                                dialogFound: true,
                                                isMainButton: true
                                            };
                                        }
                                    }

                                    // 如果所有按钮都是分类按钮，点击第一个
                                    if (buttons.length > 0) {
                                        return {
                                            found: true,
                                            buttonTag: buttons[0].tagName,
                                            buttonText: (buttons[0].textContent || '').trim().slice(0, 50),
                                            buttonId: buttons[0].id,
                                            dialogFound: true,
                                            isFirst: true
                                        };
                                    }
                                }

                                // 尝试其他常见的 cookie banner
                                const bannerSelectors = [
                                    '[role="alertdialog"]',
                                    '[aria-label*="cookie" i]',
                                    '[aria-label*="consent" i]',
                                    '.cookie-banner',
                                    '#cookie-banner'
                                ];

                                for (const selector of bannerSelectors) {
                                    const banner = document.querySelector(selector);
                                    if (banner) {
                                        const buttons = banner.querySelectorAll('button');
                                        for (const btn of buttons) {
                                            const btnText = (btn.textContent || '').toLowerCase().trim();
                                            if (btnText.includes('accept') || btnText.includes('allow') ||
                                                btnText.includes('ok') || btnText.includes('agree')) {
                                                return { found: true, buttonTag: btn.tagName, buttonText: btnText, bannerFound: true };
                                            }
                                        }
                                        break;
                                    }
                                }

                                return { found: false };
                            });

                            if (cookieResult.found) {
                                console.log(`   ✅ Cookie 弹窗已出现 (第 ${retry + 1} 次检测)`);
                                break;
                            }
                            console.log(`   ⏳ 等待 Cookie 弹窗... (${(retry + 1) * 2}s)`);
                        }

                        console.log('查找 Cookie 弹窗结果:', JSON.stringify(cookieResult, null, 2));

                        if (cookieResult.found) {
                            // 点击按钮关闭弹窗
                            await targetPage.evaluate(() => {
                                // Cookiebot 特定处理
                                const cookiebotDialog = document.querySelector('#CybotCookiebotDialog');
                                if (cookiebotDialog) {
                                    const buttons = cookiebotDialog.querySelectorAll('button');

                                    // 优先查找 "Allow all" 按钮 - ID: CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll
                                    for (const btn of buttons) {
                                        const btnId = btn.id || '';
                                        const btnText = (btn.textContent || '').toLowerCase().trim();

                                        if (btnId.includes('LevelOptinAllowAll') && !btnId.includes('Selection') ||
                                            (btnText === 'allow all' && !btnText.includes('selection'))) {
                                            btn.click();
                                            console.log('Clicked Allow all button:', btnId);
                                            return true;
                                        }
                                    }

                                    // 找第一个非分类按钮（不是 Necessary、Statistics 等）
                                    for (const btn of buttons) {
                                        const btnId = btn.id || '';
                                        const btnText = (btn.textContent || '').toLowerCase().trim();

                                        if (!btnId.includes('ContentCookieContainer') &&
                                            !btnId.includes('IABv2') &&
                                            !btnText.includes('necessary') &&
                                            !btnText.includes('preferences') &&
                                            !btnText.includes('statistics') &&
                                            !btnText.includes('marketing') &&
                                            !btnText.includes('unclassified')) {
                                            btn.click();
                                            console.log('Clicked main button:', btnId);
                                            return true;
                                        }
                                    }

                                    // 如果没找到，点击第一个按钮
                                    if (buttons.length > 0) {
                                        buttons[0].click();
                                        console.log('Clicked first Cookiebot button (fallback)');
                                        return true;
                                    }
                                }

                                // 尝试其他 banner
                                const bannerSelectors = [
                                    '[role="alertdialog"]',
                                    '[aria-label*="cookie" i]',
                                    '.cookie-banner'
                                ];

                                for (const selector of bannerSelectors) {
                                    const banner = document.querySelector(selector);
                                    if (banner) {
                                        const buttons = banner.querySelectorAll('button');
                                        if (buttons.length > 0) {
                                            buttons[0].click();
                                            console.log('Clicked first button in banner');
                                            return true;
                                        }
                                    }
                                }

                                return false;
                            });

                            console.log('✅ 已点击 Cookie 同意按钮');
                            await sleep(3000);

                            // 截图确认弹窗已关闭
                            await targetPage.screenshot({ path: 'step5-after-cookie-accept.png', fullPage: true });
                            console.log('📸 Cookie 处理后截图已保存：step5-after-cookie-accept.png');
                        } else {
                            console.log('ℹ️ 未检测到 Cookie 同意弹窗');
                            // 截图查看当前页面状态
                            await targetPage.screenshot({ path: 'step5-no-cookie-banner.png', fullPage: true });
                            console.log('📸 当前页面截图已保存：step5-no-cookie-banner.png');
                        }

                        // 步骤 5.5: 填写姓名、邮箱和登录名称
                        console.log('\n📝 步骤 5.5: 填写姓名、邮箱和登录名称...');

                        // 填写姓名
                        const nameSelectors = [
                            '#text-field-name',
                            'input[name="name"]',
                            'input[name="fullName"]',
                            'input[name="full_name"]',
                            'input[placeholder*="name" i]',
                            'input[placeholder*="Name"]',
                            '#text-field-fullName',
                        ];
                        let nameFilled = false;
                        for (const sel of nameSelectors) {
                            try {
                                const el = await targetPage.$(sel);
                                if (el) {
                                    await el.click();
                                    await el.type(task.username, { delay: 50 });
                                    const val = await targetPage.$eval(sel, e => e.value);
                                    console.log(`   ✅ 姓名已填写: "${val}" (selector: ${sel})`);
                                    nameFilled = true;
                                    break;
                                }
                            } catch (_) {}
                        }
                        if (!nameFilled) {
                            console.warn('   ⚠️  未找到姓名字段，请手动确认选择器');
                        }

                        await sleep(500);

                        // 填写邮箱
                        const emailSelectors = [
                            '#text-field-email',
                            'input[name="email"]',
                            'input[type="email"]',
                            'input[placeholder*="email" i]',
                            'input[placeholder*="Email"]',
                        ];
                        let emailFilled = false;
                        for (const sel of emailSelectors) {
                            try {
                                const el = await targetPage.$(sel);
                                if (el) {
                                    await el.click();
                                    await el.type(task.email, { delay: 50 });
                                    const val = await targetPage.$eval(sel, e => e.value);
                                    console.log(`   ✅ 邮箱已填写: "${val}" (selector: ${sel})`);
                                    emailFilled = true;
                                    break;
                                }
                            } catch (_) {}
                        }
                        if (!emailFilled) {
                            console.warn('   ⚠️  未找到邮箱字段，请手动确认选择器');
                        }

                        await sleep(500);

                        // 填写登录名称
                        const loginSelectors = [
                            '#text-field-login',
                            'input[name="login"]',
                            'input[name="loginName"]',
                            'input[name="login_name"]',
                            'input[name="username"]',
                            'input[placeholder*="login" i]',
                            'input[placeholder*="Login"]',
                            'input[placeholder*="username" i]',
                        ];
                        let loginFilled = false;
                        for (const sel of loginSelectors) {
                            try {
                                const el = await targetPage.$(sel);
                                if (el) {
                                    await el.click();
                                    await el.type(loginName, { delay: 50 });
                                    const val = await targetPage.$eval(sel, e => e.value);
                                    console.log(`   ✅ 登录名已填写: "${val}" (selector: ${sel})`);
                                    loginFilled = true;
                                    break;
                                }
                            } catch (_) {}
                        }
                        if (!loginFilled) {
                            console.warn('   ⚠️  未找到登录名字段，请手动确认选择器');
                        }

                        // 步骤 6: 选择 Messenger 并填写账号
                        console.log('\n📋 步骤 6: 选择 Messenger 并填写随机账号...');

                        // 点击 Messenger 下拉框
                        await targetPage.click('#mui-component-select-messenger');
                        await sleep(1000);

                        // 获取选项（排除 WeChat）
                        const messengerOptions = await targetPage.evaluate(() => {
                            return Array.from(document.querySelectorAll('[role="option"]'))
                                .map(el => ({ text: el.textContent.trim(), value: el.getAttribute('data-value') }))
                                .filter(o => o.text !== 'WeChat');
                        });
                        console.log(`   可用选项: ${messengerOptions.map(o => o.text).join(', ')}`);

                        // 随机选一个
                        const chosen = messengerOptions[Math.floor(Math.random() * messengerOptions.length)];
                        console.log(`   🎯 随机选择: "${chosen.text}"`);

                        // 点击选项
                        await targetPage.evaluate((value) => {
                            const option = document.querySelector(`[role="option"][data-value="${value}"]`);
                            if (option) option.click();
                        }, chosen.value);
                        await sleep(500);

                        // 等待 Messenger Account 输入框变为可输入
                        console.log('   ⏳ 等待 Messenger Account 输入框变为可输入...');
                        for (let i = 0; i < 10; i++) {
                            const disabled = await targetPage.$eval('#text-field-messengerAccount', el => el.disabled);
                            if (!disabled) {
                                console.log(`   ✅ 输入框已可输入`);
                                break;
                            }
                            await sleep(500);
                        }

                        // 生成随机账号
                        const format = MESSENGER_FORMATS[chosen.text];
                        const account = generateRandomAccount(format.format);
                        console.log(`   📝 生成 ${chosen.text} 账号: "${account}"`);

                        // 输入账号
                        await targetPage.click('#text-field-messengerAccount');
                        await targetPage.type('#text-field-messengerAccount', account, { delay: 50 });
                        await sleep(500);

                        // 验证
                        const actualValue = await targetPage.$eval('#text-field-messengerAccount', el => el.value);
                        console.log(`   ✅ 实际输入: "${actualValue}"${actualValue === account ? ' ✔' : ' ✗'}`);

                        // 步骤 7: 国家下拉框选中 "United States"
                        console.log('\n🌍 步骤 7: 国家下拉框选中 "United States"...');

                        // MUI Autocomplete: 点击 → 输入 → 选择
                        await targetPage.click('#_r_c_');
                        await sleep(500);
                        await targetPage.type('#_r_c_', 'United', { delay: 100 });
                        await sleep(1500);

                        await targetPage.evaluate(() => {
                            const opts = document.querySelectorAll('[role="option"], .MuiAutocomplete-option');
                            for (const o of opts) {
                                if (o.textContent?.trim().includes('United States')) {
                                    o.click();
                                    return true;
                                }
                            }
                            return false;
                        });
                        await sleep(500);

                        const countryValue = await targetPage.$eval('#_r_c_', el => el.value);
                        console.log(`   ✅ 国家: "${countryValue}"`);

                        // 步骤 8: 密码输入框固定输入 "123456789_Chen"
                        console.log('\n🔐 步骤 8: 输入固定密码...');

                        const password = '123456789_Chen';
                        await targetPage.click('#password-password');
                        await targetPage.type('#password-password', password, { delay: 50 });
                        await sleep(300);

                        const pwValue = await targetPage.$eval('#password-password', el => el.value);
                        console.log(`   ✅ 密码: "${pwValue}"${pwValue === password ? ' ✔' : ' ✗'}`);

                        // 步骤 9: 勾选同意隐私协议
                        console.log('\n📜 步骤 9: 勾选同意隐私协议...');

                        // 查找并勾选隐私协议复选框
                        const termsChecked = await targetPage.evaluate(() => {
                            const checkbox = document.querySelector('input[name="areTermsAccepted"]');
                            if (checkbox && !checkbox.checked) {
                                checkbox.click();
                                return true;
                            }
                            return checkbox ? 'already checked' : 'not found';
                        });
                        console.log(`   ✅ 隐私协议: ${termsChecked === true ? '已勾选 ✔' : termsChecked}`);

                        // 步骤 10: 等待 Cloudflare 挑战完成（放最后，因为表单输入可能触发再次挑战）
                        console.log('\n🛡️  步骤 10: 等待 Cloudflare 挑战完成...');

                        const cfResult = await waitForCloudflareChallenge(targetPage, 90000);

                        if (cfResult === 'success') {
                            console.log('🎉 Cloudflare 挑战成功！页面已通过验证，可以正常访问。');
                        } else if (cfResult === 'failed') {
                            console.log('💀 Cloudflare 挑战失败！页面被拦截，无法继续。');
                        } else {
                            console.log('⚠️  Cloudflare 挑战超时，可能影响后续操作，但继续执行...');
                            await targetPage.screenshot({ path: 'step10-cloudflare-timeout.png', fullPage: true });
                        }

                        // 步骤 11: 确认 SIGN UP 按钮是否可点击，若可点击则提交注册
                        console.log('\n🔘 步骤 11: 查找 SIGN UP 按钮...');

                        const signupBtnInfo = await targetPage.evaluate(() => {
                            const selectors = [
                                'button[type="submit"]',
                                'input[type="submit"]',
                                'button',
                                '[role="button"]',
                            ];

                            for (const sel of selectors) {
                                const elements = document.querySelectorAll(sel);
                                for (const el of elements) {
                                    const text = (el.textContent || '').trim().toUpperCase();
                                    const value = ((el.value || '')).toUpperCase();
                                    if (text === 'SIGN UP' || text === 'SIGNUP' || text === 'CREATE ACCOUNT'
                                        || value === 'SIGN UP' || value === 'SIGNUP') {
                                        return {
                                            found: true,
                                            disabled: el.disabled || el.classList.contains('Mui-disabled'),
                                            tag: el.tagName,
                                            text: (el.textContent || el.value || '').trim(),
                                            id: el.id || '',
                                            className: el.className || '',
                                        };
                                    }
                                }
                            }
                            return { found: false };
                        });

                        console.log(`   SIGN UP 按钮: ${JSON.stringify(signupBtnInfo)}`);

                        if (signupBtnInfo.found && !signupBtnInfo.disabled) {
                            console.log('   ✅ 按钮可点击，正在提交注册...');

                            await targetPage.evaluate(() => {
                                const selectors = [
                                    'button[type="submit"]',
                                    'input[type="submit"]',
                                    'button',
                                    '[role="button"]',
                                ];
                                for (const sel of selectors) {
                                    const elements = document.querySelectorAll(sel);
                                    for (const el of elements) {
                                        const text = (el.textContent || '').trim().toUpperCase();
                                        const value = ((el.value || '')).toUpperCase();
                                        if (text === 'SIGN UP' || text === 'SIGNUP' || text === 'CREATE ACCOUNT'
                                            || value === 'SIGN UP' || value === 'SIGNUP') {
                                            el.click();
                                            return true;
                                        }
                                    }
                                }
                                return false;
                            });

                            console.log('   ✅ 已点击 SIGN UP 按钮');

                            signupClicked = true;

                            // 插入 adsterra_account 表记录
                            console.log('\n💾 插入 adsterra_account 记录...');
                            try {
                                const dbConn = await mysql.createConnection(DB_CONFIG);
                                const nowBeijing = new Date(new Date().getTime() + 8 * 60 * 60 * 1000)
                                    .toISOString().slice(0, 19).replace('T', ' ');
                                await dbConn.execute(
                                    'INSERT INTO adsterra_account (account, status, create_time) VALUES (?, ?, ?)',
                                    [task.email, 'SIGN_UP_SUCCESS', nowBeijing]
                                );
                                console.log(`   ✅ 已插入: account="${task.email}", status=SIGN_UP_SUCCESS, create_time=${nowBeijing}`);
                                await dbConn.end();
                            } catch (e) {
                                console.warn(`   ⚠️  插入 adsterra_account 失败: ${e.message}`);
                            }

                            // 步骤 12: 轮询等待注册处理完成并跳转到确认邮件页面
                            console.log('\n📧 步骤 12: 等待注册处理并跳转到确认邮件页面...');
                            console.log('   ⏳ 注册数据处理需要时间，耐心等待...');

                            const emailKeywords = [
                                'check your email',
                                'confirm your email',
                                'verify your email',
                                'verification email',
                                'email sent',
                                'we sent you',
                                'confirmation email',
                                'please check your',
                                'activate your account',
                                'check your inbox',
                                '验证邮件',
                                '确认邮件',
                                '请检查您的邮箱',
                                '邮件已发送',
                            ];

                            let emailPageInfo = null;
                            const maxWaitMs = 120000;  // 最多等 2 分钟
                            const pollStart = Date.now();

                            while (Date.now() - pollStart < maxWaitMs) {
                                await sleep(3000);

                                emailPageInfo = await targetPage.evaluate((keywords) => {
                                    const bodyText = (document.body?.innerText || '').toLowerCase();
                                    const url = window.location.href;
                                    const title = document.title;

                                    const hasEmailHint = keywords.some(kw => bodyText.includes(kw));
                                    const hasEmailImg = !!document.querySelector('img[src*="email" i], img[src*="mail" i]');
                                    const hasResendBtn = !!Array.from(document.querySelectorAll('button, a')).find(el =>
                                        (el.textContent || '').toLowerCase().includes('resend') ||
                                        (el.textContent || '').toLowerCase().includes('重新发送')
                                    );

                                    return {
                                        url,
                                        title,
                                        hasEmailHint,
                                        hasEmailImg,
                                        hasResendBtn,
                                        bodyPreview: bodyText.slice(0, 300),
                                        isEmailConfirmPage: hasEmailHint || (hasEmailImg && hasResendBtn),
                                    };
                                }, emailKeywords);

                                const elapsed = Math.round((Date.now() - pollStart) / 1000);

                                if (emailPageInfo.isEmailConfirmPage) {
                                    console.log(`   ✅ 已跳转到确认邮件页面！（等待 ${elapsed}s）`);
                                    console.log(`   URL: ${emailPageInfo.url}`);
                                    console.log(`   标题: "${emailPageInfo.title}"`);
                                    break;
                                }

                                console.log(`   ⏳ 等待中... (${elapsed}s) URL: ${emailPageInfo.url}`);
                            }

                            if (emailPageInfo && emailPageInfo.isEmailConfirmPage) {
                                // 步骤 13: 打开 yopmail 查看确认邮件
                                console.log('\n📬 步骤 13: 打开 yopmail 查看确认邮件...');

                                // 关闭当前浏览器
                                console.log('   🔒 关闭当前浏览器...');
                                await browser.close();

                                // 启动新浏览器，不挂代理
                                console.log('   🌐 启动新浏览器（无代理）...');
                                browser = await launch({
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

                                const yopmailPage = await browser.newPage();
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
                                    console.log('   ⚠️  页面加载超时，继续...');
                                }
                                await sleep(3000);

                                // 关闭广告弹窗
                                console.log('   🧹 关闭广告弹窗...');
                                for (let attempt = 0; attempt < 5; attempt++) {
                                    await yopmailPage.evaluate(() => {
                                        // 关闭各种可能的弹窗/广告
                                        const closeSelectors = [
                                            '[aria-label="Close"]',
                                            '[aria-label="close"]',
                                            '.close',
                                            '.dismiss',
                                            '[class*="close" i]',
                                            '[class*="dismiss" i]',
                                            'button[class*="close" i]',
                                            'div[class*="popup" i] button',
                                            'div[class*="modal" i] button',
                                            'div[class*="overlay" i] button',
                                            'div[class*="ad" i] button',
                                            'div[class*="ad" i] [class*="close" i]',
                                            'iframe + button',
                                            'button:has(svg)',
                                        ];
                                        for (const sel of closeSelectors) {
                                            try {
                                                const els = document.querySelectorAll(sel);
                                                for (const el of els) {
                                                    if (el.offsetParent !== null) {  // 可见元素
                                                        el.click();
                                                    }
                                                }
                                            } catch (_) {}
                                        }
                                        // 移除遮挡层
                                        const overlaySelectors = [
                                            'div[class*="overlay" i]',
                                            'div[class*="popup" i]',
                                            'div[class*="modal" i]',
                                            'div[class*="advertisement" i]',
                                            'div[id*="google_ads" i]',
                                            'ins.adsbygoogle',
                                        ];
                                        for (const sel of overlaySelectors) {
                                            try {
                                                document.querySelectorAll(sel).forEach(el => el.remove());
                                            } catch (_) {}
                                        }
                                    });
                                    await sleep(500);
                                }
                                console.log('   ✅ 广告弹窗处理完成');

                                // 提取邮箱前缀（@ 前面的部分）
                                const emailPrefix = task.email.split('@')[0];
                                console.log(`   📧 邮箱前缀: ${emailPrefix}`);

                                // 输入邮箱前缀
                                const inputSelectors = [
                                    '#login',
                                    'input[name="login"]',
                                    'input[name="email"]',
                                    'input[placeholder*="email" i]',
                                    'input[placeholder*="mail" i]',
                                    'input[placeholder*="Enter" i]',
                                    'input[type="text"]',
                                    'input:not([type="hidden"])',
                                ];

                                let inputFound = false;
                                for (const sel of inputSelectors) {
                                    try {
                                        const inputEl = await yopmailPage.$(sel);
                                        if (inputEl) {
                                            await inputEl.click({ clickCount: 3 });  // 三击全选
                                            await inputEl.type(emailPrefix, { delay: 30 });
                                            const val = await yopmailPage.$eval(sel, e => e.value);
                                            if (val === emailPrefix) {
                                                console.log(`   ✅ 已输入邮箱前缀: "${val}" (selector: ${sel})`);
                                                inputFound = true;

                                                // 按 Enter 键
                                                await yopmailPage.keyboard.press('Enter');
                                                console.log('   ✅ 已按 Enter，进入邮箱');
                                                break;
                                            }
                                        }
                                    } catch (_) {}
                                }

                                if (!inputFound) {
                                    console.warn('   ⚠️  未找到邮箱输入框');
                                    await yopmailPage.screenshot({ path: 'step13-yopmail-input-failed.png', fullPage: true });
                                    await browser.close();
                                    return { success: false, retryable: false, error: '未找到 yopmail 邮箱输入框' };
                                } else {
                                    // 等待邮箱加载
                                    await sleep(5000);

                                    // 再次清理广告
                                    await yopmailPage.evaluate(() => {
                                        ['div[class*="overlay" i]', 'div[class*="popup" i]', 'div[class*="modal" i]', 'div[class*="ad" i]', 'ins.adsbygoogle']
                                            .forEach(sel => document.querySelectorAll(sel).forEach(el => { try { el.remove(); } catch (_) {} }));
                                    });
                                    await sleep(2000);

                                    await yopmailPage.screenshot({ path: 'step13-yopmail-inbox.png', fullPage: true });
                                    console.log('   📸 yopmail 截图: step13-yopmail-inbox.png');

                                    // 步骤 14: 在邮件列表中查找 Adsterra 确认邮件并点击
                                    console.log('\n✉️  步骤 14: 查找 Adsterra 确认邮件...');

                                    // yopmail 邮件列表在 #ifinbox iframe 中
                                    const emailClicked = await yopmailPage.evaluate(() => {
                                        const iframe = document.getElementById('ifinbox');
                                        if (!iframe) return { found: false, error: 'ifinbox not found' };
                                        try {
                                            const doc = iframe.contentDocument || iframe.contentWindow?.document;
                                            if (!doc) return { found: false, error: 'ifinbox doc not accessible' };

                                            const items = doc.querySelectorAll('.m, .msg, .lm, [class*="message" i], [class*="email" i], div[onclick]');
                                            for (const item of items) {
                                                const text = (item.textContent || '').toLowerCase();
                                                if (text.includes('complete your registration') ||
                                                    (text.includes('adsterra') && text.includes('confirm'))) {
                                                    item.click();
                                                    return { found: true, text: (item.textContent || '').trim().slice(0, 200) };
                                                }
                                            }
                                            return { found: false, error: 'no matching email', itemCount: items.length };
                                        } catch (e) {
                                            return { found: false, error: e.message };
                                        }
                                    });

                                    console.log(`   邮件查找结果: ${JSON.stringify(emailClicked)}`);

                                    if (emailClicked.found) {
                                        console.log('   ✅ 已点击确认邮件，等待内容加载...');
                                        await sleep(5000);

                                        // 步骤 15: 从邮件内容中获取 Confirm email 按钮的链接
                                        console.log('\n🔗 步骤 15: 获取 Confirm email 链接...');

                                        // 邮件内容在 #ifmail iframe 中
                                        let confirmLink = null;
                                        for (let retry = 0; retry < 6 && !confirmLink; retry++) {
                                            if (retry > 0) {
                                                await sleep(2000);
                                                console.log(`   ⏳ 重试获取链接... (${retry}/5)`);
                                            }

                                            confirmLink = await yopmailPage.evaluate(() => {
                                                // 优先从 #ifmail iframe 中查找
                                                const iframe = document.getElementById('ifmail');
                                                if (iframe) {
                                                    try {
                                                        const doc = iframe.contentDocument || iframe.contentWindow?.document;
                                                        if (doc) {
                                                            const links = doc.querySelectorAll('a');
                                                            for (const a of links) {
                                                                const text = (a.textContent || '').trim().toLowerCase();
                                                                const href = a.href || '';
                                                                if (text.includes('confirm') && href.includes('adsterra.com/confirm')) {
                                                                    return { found: true, href, text, source: 'ifmail', linkCount: links.length };
                                                                }
                                                            }
                                                            for (const a of links) {
                                                                const href = a.href || '';
                                                                if (href.includes('adsterra.com/confirm')) {
                                                                    return { found: true, href, text: (a.textContent || '').trim(), source: 'ifmail', linkCount: links.length };
                                                                }
                                                            }
                                                            // 诊断：打印 ifmail body 内容
                                                            const bodyText = (doc.body?.innerText || '').slice(0, 300);
                                                            return { found: false, iframeId: 'ifmail', bodyPreview: bodyText, linkCount: links.length };
                                                        }
                                                    } catch (_) {}
                                                }
                                                return { found: false, error: 'ifmail not accessible' };
                                            });
                                        }

                                        if (confirmLink && confirmLink.found) {
                                            console.log(`   ✅ Confirm email 链接: ${confirmLink.href}`);
                                            console.log(`   按钮文本: "${confirmLink.text}"`);

                                            // 步骤 16: 关闭 yopmail 浏览器，重新打开代理浏览器访问 confirm 链接
                                            console.log('\n🔗 步骤 16: 访问 confirm 链接...');

                                            // 关闭 yopmail 浏览器
                                            console.log('   🔒 关闭 yopmail 浏览器...');
                                            await browser.close();

                                            // 重新启动代理浏览器
                                            console.log('   🌐 启动代理浏览器...');
                                            proxyManager = new ResidentProxyManager({
                                                apiKey: PROXY_API_KEY,
                                                country: 'US',
                                                rotationInterval: 30 * 60 * 1000,
                                                protocol: 'http',
                                                verbose: true,
                                            });

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

                                            const confirmPage = await browser.newPage();
                                            await applyStealthPatches(confirmPage);
                                            await confirmPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
                                            confirmPage.setDefaultNavigationTimeout(60000);
                                            confirmPage.setDefaultTimeout(30000);
                                            await confirmPage.setViewport({ width: 1920, height: 1080 });

                                            // 访问 confirm 链接
                                            console.log(`   🌐 访问: ${confirmLink.href}`);
                                            try {
                                                await confirmPage.goto(confirmLink.href, {
                                                    waitUntil: 'load',
                                                    timeout: 60000
                                                });
                                            } catch (e) {
                                                console.log('   ⚠️  页面加载超时，检查当前 URL...');
                                            }
                                            await sleep(3000);

                                            // 等待 confirm 处理完成，自动跳转到 login 页面
                                            console.log('   ⏳ 等待 confirm 处理并跳转到 login...');
                                            let loginUrl = '';
                                            for (let i = 0; i < 30; i++) {
                                                loginUrl = confirmPage.url();
                                                if (loginUrl.includes('publishers.adsterra.com/login')) {
                                                    console.log(`   ✅ 已跳转到 login 页面 (${i * 2}s)`);
                                                    break;
                                                }
                                                await sleep(2000);
                                                if (i % 5 === 0) {
                                                    console.log(`   ⏳ 等待中... (${i * 2}s) URL: ${loginUrl}`);
                                                }
                                            }

                                            if (!loginUrl.includes('publishers.adsterra.com/login')) {
                                                console.warn(`   ⚠️  未跳转到 login 页面，当前 URL: ${loginUrl}`);
                                                await confirmPage.screenshot({ path: 'step16-confirm-result.png', fullPage: true });
                                            } else {
                                                // 更新 adsterra_account 状态为 CONFIRM_EMAIL_SUCCESS
                                                console.log('\n💾 更新 adsterra_account 状态为 CONFIRM_EMAIL_SUCCESS...');
                                                try {
                                                    const dbConn = await mysql.createConnection(DB_CONFIG);
                                                    await dbConn.execute(
                                                        `UPDATE adsterra_account SET status = 'CONFIRM_EMAIL_SUCCESS' WHERE account = ?`,
                                                        [task.email]
                                                    );
                                                    console.log(`   ✅ 已更新: account="${task.email}", status=CONFIRM_EMAIL_SUCCESS`);
                                                    await dbConn.end();
                                                } catch (e) {
                                                    console.warn(`   ⚠️  更新失败: ${e.message}`);
                                                }
                                            }

                                            // 步骤 16-17 完成，关闭浏览器并返回
                                            console.log('\n========================================\n');
                                            console.log('✅ Sign Up 爬虫 + 邮件确认 完成！');
                                            await browser.close();


                                            return (await loginCrawler(task, proxy, null));
                                        } else {
                                            console.warn('   ⚠️  未找到 Confirm email 链接');
                                            if (confirmLink) {
                                                console.log(`   诊断: iframe linkCount=${confirmLink.linkCount}, body="${confirmLink.bodyPreview?.slice(0, 200)}"`);
                                            }
                                            await yopmailPage.screenshot({ path: 'step15-confirm-link-not-found.png', fullPage: true });
                                            await browser.close();
                                            return { success: false, retryable: false, error: '未找到 Confirm email 链接' };
                                        }
                                    } else {
                                        console.warn('   ⚠️  未找到 Adsterra 确认邮件');

                                        // yopmail 流程未完成，关闭浏览器并返回
                                        console.log('\n========================================\n');
                                        console.log('⚠️  未找到确认邮件');
                                        await browser.close();
                                        return { success: false, retryable: false, error: '未找到确认邮件' };
                                    }
                                }
                            } else {
                                console.log('   ⚠️  等待超时，未检测到确认邮件页面');
                                console.log(`   最终 URL: ${emailPageInfo?.url}`);
                                console.log(`   最终标题: "${emailPageInfo?.title}"`);
                                await targetPage.screenshot({ path: 'step12-timeout.png', fullPage: true });
                                console.log('   📸 超时截图: step12-timeout.png');
                            }
                        } else if (signupBtnInfo.found && signupBtnInfo.disabled) {
                            console.log('   ⚠️  SIGN UP 按钮存在但处于禁用状态，无法提交');
                        } else {
                            console.log('   ⚠️  未找到 SIGN UP 按钮');
                        }

                        // 截图
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        await targetPage.screenshot({ path: `step4-final-page-${timestamp}.png`, fullPage: true });
                        console.log(`📸 最终页面截图已保存：step4-final-page-${timestamp}.png`);

                        // 获取页面元数据
                        const metadata = await targetPage.evaluate(() => {
                            return {
                                url: url,
                                title: document.title,
                                h1s: Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim().slice(0, 100)),
                                forms: document.querySelectorAll('form').length,
                                inputs: document.querySelectorAll('input').length
                            };
                        });

                        console.log('\n📊 页面详细信息:');
                        console.log(`   - H1 标签：${metadata.h1s.length} 个`);
                        metadata.h1s.forEach((h1, i) => console.log(`     ${i + 1}. ${h1}`));
                        console.log(`   - 表单数：${metadata.forms}`);
                        console.log(`   - 输入框数：${metadata.inputs}`);

                        console.log('\n========================================\n');
                        console.log('✅ Sign Up 爬虫执行完成！');
                        console.log(`🔗 最终页面地址：${targetUrl}`);
                        await browser.close();
                        return { success: true };

                    } catch (e) {
                        console.log('⚠️ 获取新标签页详情失败:', e.message);
                        // 如果 SIGN UP 已经点击，错误向上传播
                        if (signupClicked) {
                            throw e;
                        }
                    }
                } else {
                    console.log('⚠️ 未找到符合条件的目标页面');
                }
            } else {
                console.log('⚠️ 未找到 START EARNING 按钮\n');
            }

            // 如果没有找到新页面，打印当前页面信息
            console.log('\n========== 当前页面信息 ==========');
            const finalUrl = page.url();
            console.log(`📍 当前 URL: ${finalUrl}`);
            console.log(`📄 页面标题：${await page.title()}`);

            console.log('\n========================================\n');
            console.log('✅ Sign Up 爬虫执行完成！');
            console.log(`🔗 最终页面地址：${finalUrl}`);
            await browser.close();
            return { success: true };

        } catch (error) {
            console.error('❌ 发生错误:', error.message);

            // 清理浏览器
            if (browser) {
                try { await browser.close(); } catch (_) {}
                browser = null;
            }

            if (!signupClicked) {
                // SIGN UP 之前失败 → 重试
                if (attempt < MAX_RETRIES - 1) {
                    console.log(`   🔄 将在下次循环中重试...\n`);
                    continue;
                }
                // 重试次数用完
                console.error('❌ 重试次数已用完');
                return { success: false, retryable: true, error: error.message };
            } else {
                // SIGN UP 之后失败 → 不可重试
                console.error('❌ SIGN UP 后流程异常');
                return { success: false, retryable: false, error: error.message };
            }
        }

    }

    // 如果 for 循环结束但 signupClicked 仍为 false（重试耗尽）
    if (!signupClicked) {
        console.error('❌ 未能成功提交 SIGN UP');
        return { success: false, retryable: true, error: '重试耗尽，未能成功提交 SIGN UP' };
    }
}
