import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import { ResidentProxyManager } from './proxy.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const PROXY_API_KEY = '629a2e2ce2532c8c4ad034fbc4f3c8a5';

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

        const isChallenging = !isFailed && (
            isCfUrl ||                          // URL 是 CF 挑战页
            hasChallengeText ||                 // 有 CF 挑战关键词
            hasChallengeElement ||              // 有 CF 挑战元素
            looksLikeChallenge ||               // 短 body + CF 标题/URL
            (hasIframe && isShortBody) ||       // iframe + 短 body
            turnstilePending ||                 // Turnstile token 存在但为空 → 挑战进行中
            // verifying 等关键词，但仅在 signup 内容未出现时才算挑战
            (!hasSignupContent && (bodyText.includes('verifying') || bodyText.includes('正在验证')))
        );

        // 挑战成功 = 没有挑战标志 + 没有失败标志 + (Turnstile 完成 或 有 signup 内容)
        // 注意：如果 Turnstile 存在，必须等它完成；如果不存在，有 signup 内容即可
        const isSuccess = !isChallenging && !isFailed && (
            turnstileDone ||                    // Turnstile token 已生成
            (!turnstileToken && hasSignupContent)  // 没有 Turnstile，有 signup 内容即可
        );

        return {
            isChallenging: isChallenging,
            isSuccess: isSuccess,
            isFailed: isFailed,
            title: title,
            url: url,
            hasRealContent: hasSignupContent,
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
async function waitForCloudflareChallenge(page, maxWaitMs = 60000) {
    console.log('⏳ 检测 Cloudflare 挑战...');
    const startTime = Date.now();
    let lastStatus = null;
    let stuckCount = 0;
    let lastBodyText = '';

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
            if (stuckCount >= 5) {
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
        if (status.isChallenging) {
            console.log(`   🔄 挑战进行中... (${elapsed}s)${stuckCount > 0 ? ` 卡死计数: ${stuckCount}` : ''}`);
        } else {
            // 挑战标志消失了，但还没判定成功 → 打印原因帮助调试
            console.log(`   ⏳ 等待页面加载... (${elapsed}s) bodyLen=${status.bodyLen} hasRealContent=${status.hasRealContent} turnstilePending=${status.turnstilePending} turnstileDone=${status.turnstileDone}`);
            console.log(`      挑战关键词: ${status.hasChallengeText}, 挑战元素: ${status.hasChallengeElement}, iframe: ${status.hasIframe}`);
        }

        await sleep(2000);
    }

    // 超时
    console.log('⚠️  Cloudflare 挑战等待超时，最终状态:');
    console.log(`   isChallenging: ${lastStatus?.isChallenging}`);
    console.log(`   isFailed: ${lastStatus?.isFailed}`);
    console.log(`   hasRealContent: ${lastStatus?.hasRealContent}`);
    console.log(`   标题: "${lastStatus?.title}"`);
    console.log(`   body 预览: ${lastStatus?.bodyPreview?.slice(0, 100)}`);
    return 'timeout';
}

async function signupCrawler() {
    console.log('🚀 启动 CloakBrowser (Sign Up 爬虫)...\n');

    let browser;
    let proxyManager;

    try {
        const platform = os.platform();
        console.log(`🖥️  当前平台: ${platform} (${isLinux ? '无头模式' : '窗口模式'})`);

        // 获取代理
        console.log('🔌 获取代理...');
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

        // 启动 CloakBrowser - Linux 使用无头模式，Windows 使用窗口模式
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
            console.log('⏳ 等待新标签页 (最多 10 秒)...');
            await sleep(10000);

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

                    const cfResult = await waitForCloudflareChallenge(targetPage, 60000);

                    if (cfResult === 'success') {
                        console.log('🎉 Cloudflare 挑战成功！页面已通过验证，可以正常访问。');
                    } else if (cfResult === 'failed') {
                        console.log('💀 Cloudflare 挑战失败！页面被拦截，无法继续。');
                    } else {
                        console.log('⚠️  Cloudflare 挑战超时，可能影响后续操作，但继续执行...');
                        await targetPage.screenshot({ path: 'step10-cloudflare-timeout.png', fullPage: true });
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
                    console.log('\n🕐 浏览器保持打开状态，按 Ctrl+C 退出...');

                    // 保持进程运行
                    await new Promise(() => {});
                    return;

                } catch (e) {
                    console.log('⚠️ 获取新标签页详情失败:', e.message);
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
signupCrawler().catch((error) => {
    console.error('❌ 未捕获的错误:', error);
    process.exit(1);
});
