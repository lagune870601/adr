import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { ResidentProxyManager } from './proxy.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const PROXY_API_KEY = '629a2e2ce2532c8c4ad034fbc4f3c8a5';

const DB_CONFIG = {
    host: '166.0.19.103',
    port: 13307,
    user: 'root',
    password: 'root',
    database: 'ad',
};

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
 * 从 crawler_task 表中查询一条待注册的任务
 * 条件: task_type=REGISTER, task_status IN ('pending','retry'), scheduled_time <= 北京时间, is_delete=0, retry_count < 5
 * 按 scheduled_time 升序（最接近当前时间的排最前），取一条
 */
async function getRegisterTask() {
    console.log('🔍 查询待注册任务...');
    const connection = await mysql.createConnection(DB_CONFIG);

    try {
        // scheduled_time 按北京时间录入，使用北京时间进行比较
        const nowBeijing = new Date(new Date().getTime() + 8 * 60 * 60 * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');
        const [rows] = await connection.execute(
            `SELECT id, username, email, retry_count, scheduled_time
             FROM crawler_task
             WHERE task_type = 'REGISTER'
               AND task_status IN ('pending', 'retry')
               AND scheduled_time <= ?
               AND is_delete = 0
               AND retry_count < 5
             ORDER BY scheduled_time ASC
             LIMIT 1`,
            [nowBeijing]
        );

        if (rows.length === 0) {
            console.warn('⚠️  没有待注册的任务');
            return null;
        }

        const task = rows[0];
        console.log(`✅ 找到任务: id=${task.id}, username="${task.username}", email="${task.email}"`);
        console.log(`   retry_count=${task.retry_count}, scheduled_time=${task.scheduled_time}`);
        return task;
    } finally {
        await connection.end();
    }
}

/**
 * 更新 crawler_task 状态
 */
async function updateTaskStatus(taskId, status) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        await connection.execute(
            'UPDATE crawler_task SET task_status = ? WHERE id = ?',
            [status, taskId]
        );
        console.log(`   💾 任务状态已更新: id=${taskId}, status=${status}`);
    } finally {
        await connection.end();
    }
}

/**
 * 递增 crawler_task 的 retry_count
 */
async function incrementRetryCount(taskId) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        await connection.execute(
            'UPDATE crawler_task SET retry_count = retry_count + 1, last_retry_time = NOW() WHERE id = ?',
            [taskId]
        );
        console.log(`   💾 retry_count +1 (task id=${taskId})`);
    } finally {
        await connection.end();
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
            console.log(`   ⏳ 等待页面加载... (${elapsed}s) bodyLen=${status.bodyLen} hasRealContent=${status.hasRealContent} turnstileExpected=${status.turnstileExpected} turnstilePending=${status.turnstilePending} turnstileDone=${status.turnstileDone}`);
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

    // 从数据库查询待注册任务
    const task = await getRegisterTask();
    if (!task) {
        console.error('❌ 没有待注册的任务，退出');
        process.exit(1);
    }

    // 更新任务状态为 processing
    await updateTaskStatus(task.id, 'processing');

    // 以 username 为基准生成登录名称
    const loginName = task.username.replace(/\s+/g, '').toLowerCase() + Math.random().toString(36).substring(2, 6);
    console.log(`👤 姓名: ${task.username}`);
    console.log(`📧 邮箱: ${task.email}`);
    console.log(`🔑 登录名: ${loginName}\n`);

    // 预 SIGN UP 阶段重试循环（最多 5 次）
    const MAX_RETRIES = 5;
    let signupClicked = false;

    for (let attempt = 0; attempt < MAX_RETRIES && !signupClicked; attempt++) {
        if (attempt > 0) {
            console.log(`\n🔄 第 ${attempt + 1}/${MAX_RETRIES} 次重试...`);
            await updateTaskStatus(task.id, 'retry');
            await incrementRetryCount(task.id);
        }

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

                    const cfResult = await waitForCloudflareChallenge(targetPage, 60000);

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
                            if (proxyManager) {
                                proxyManager.destroy();
                            }

                            // 启动新浏览器，不挂代理
                            console.log('   🌐 启动新浏览器（无代理）...');
                            browser = await launch({
                                headless: isLinux,
                                args: [
                                    '--no-sandbox',
                                    '--disable-setuid-sandbox',
                                    '--disable-dev-shm-usage',
                                    '--disable-accelerated-2d-canvas',
                                    '--disable-gpu',
                                ]
                            });

                            const yopmailPage = await browser.newPage();
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
                                console.log('\n🕐 yopmail 浏览器保持打开状态，按 Ctrl+C 退出...');
                                await new Promise(() => {});
                                return;
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
                                        await proxyManager.start();
                                        const proxy2 = await proxyManager.getProxy();
                                        console.log(`   📡 代理地址: ${proxy2.host}:${proxy2.port}`);

                                        browser = await launch({
                                            headless: isLinux,
                                            args: [
                                                '--no-sandbox',
                                                '--disable-setuid-sandbox',
                                                '--disable-dev-shm-usage',
                                                '--disable-accelerated-2d-canvas',
                                                '--disable-gpu',
                                                `--proxy-server=${proxy2.host}:${proxy2.port}`,
                                            ]
                                        });

                                        const confirmPage = await browser.newPage();
                                        await confirmPage.authenticate({
                                            username: proxy2.username,
                                            password: proxy2.password,
                                        });
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

                                            // 步骤 17: 在 login 页面输入邮箱和密码并登录
                                            console.log('\n🔐 步骤 17: 输入邮箱和密码登录...');

                                            const password = '123456789_Chen';
                                            console.log(`   📧 邮箱: ${task.email}`);
                                            console.log(`   🔑 密码: ${password}`);

                                            // 等待页面渲染完成
                                            console.log('   ⏳ 等待登录表单渲染...');
                                            for (let i = 0; i < 15; i++) {
                                                const hasInputs = await confirmPage.evaluate(() => {
                                                    return document.querySelectorAll('input').length > 0;
                                                });
                                                if (hasInputs) { console.log(`   ✅ 表单已渲染 (${i * 2}s)`); break; }
                                                await sleep(2000);
                                            }

                                            // 填写邮箱 (login 页面用 #text-field-login)
                                            const emailSelectors = [
                                                '#text-field-login',
                                                'input[name="login"]',
                                                'input[type="email"]',
                                                'input[name="email"]',
                                                'input[placeholder*="email" i]',
                                            ];
                                            for (const sel of emailSelectors) {
                                                try {
                                                    const el = await confirmPage.$(sel);
                                                    if (el) {
                                                        await el.click({ clickCount: 3 });
                                                        await el.type(task.email, { delay: 50 });
                                                        const val = await confirmPage.$eval(sel, e => e.value);
                                                        console.log(`   ✅ 邮箱已填写: "${val}"`);
                                                        break;
                                                    }
                                                } catch (_) {}
                                            }

                                            await sleep(500);

                                            // 填写密码 (#password-signin)
                                            const pwSelectors = [
                                                '#password-signin',
                                                'input[type="password"]',
                                                'input[name="password"]',
                                                'input[name="signin"]',
                                            ];
                                            for (const sel of pwSelectors) {
                                                try {
                                                    const el = await confirmPage.$(sel);
                                                    if (el) {
                                                        await el.click({ clickCount: 3 });
                                                        await el.type(password, { delay: 50 });
                                                        const val = await confirmPage.$eval(sel, e => e.value);
                                                        console.log(`   ✅ 密码已填写: "${val}"`);
                                                        break;
                                                    }
                                                } catch (_) {}
                                            }

                                            await sleep(500);

                                            // 等待 Cloudflare 校验完成，LOG IN 按钮变为可点击
                                            console.log('   ⏳ 等待 Cloudflare 校验（按钮变为可点击）...');
                                            let loginBtnReady = false;
                                            const waitStart = Date.now();
                                            const maxWaitBtn = 180000;  // 最多等 3 分钟

                                            while (Date.now() - waitStart < maxWaitBtn) {
                                                let btnStatus = { found: false };
                                                let tokenState = { tokenValue: '', tsExists: false };

                                                try {
                                                    btnStatus = await confirmPage.evaluate(() => {
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
                                                                if (text === 'LOG IN' || text === 'LOGIN' || text === 'SIGN IN'
                                                                    || value === 'LOG IN' || value === 'LOGIN') {
                                                                    const isDisabled = el.disabled
                                                                        || el.classList.contains('Mui-disabled')
                                                                        || el.getAttribute('aria-disabled') === 'true';
                                                                    return {
                                                                        found: true,
                                                                        disabled: isDisabled,
                                                                        text: (el.textContent || el.value || '').trim(),
                                                                        id: el.id || '',
                                                                    };
                                                                }
                                                            }
                                                        }
                                                        return { found: false };
                                                    });

                                                    tokenState = await confirmPage.evaluate(() => {
                                                        const input = document.querySelector('input[name="cloudflareCaptchaToken"]');
                                                        const tsDiv = document.querySelector('.cf-turnstile');
                                                        return {
                                                            tokenValue: input?.value || '',
                                                            tsExists: !!tsDiv,
                                                        };
                                                    });
                                                } catch (e) {
                                                    // 页面导航中，执行上下文被销毁，重试
                                                    if (e.message.includes('Execution context was destroyed')) {
                                                        console.log(`   ⚠️  页面导航中，等待稳定...`);
                                                        await sleep(2000);
                                                        continue;
                                                    }
                                                    throw e;
                                                }

                                                const elapsed = Math.round((Date.now() - waitStart) / 1000);

                                                if (btnStatus.found && !btnStatus.disabled) {
                                                    console.log(`   ✅ 按钮已可点击 (${elapsed}s) token=${tokenState.tokenValue ? '***' : '(empty)'}`);
                                                    loginBtnReady = true;
                                                    break;
                                                }

                                                if (btnStatus.found && btnStatus.disabled) {
                                                    if (elapsed % 10 === 0) {
                                                        console.log(`   ⏳ 按钮灰色, token=${tokenState.tokenValue ? '***' : '(empty)'}, tsDiv=${tokenState.tsExists} (${elapsed}s)`);
                                                    }
                                                } else if (!btnStatus.found) {
                                                    console.log(`   ⚠️  未找到按钮 (${elapsed}s)`);
                                                    break;
                                                }

                                                await sleep(2000);
                                            }

                                            if (loginBtnReady) {
                                                // 点击登录按钮
                                                console.log('   🔘 点击登录按钮...');
                                                await confirmPage.evaluate(() => {
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
                                                            if (text === 'LOG IN' || text === 'LOGIN' || text === 'SIGN IN'
                                                                || value === 'LOG IN' || value === 'LOGIN') {
                                                                el.click();
                                                                return true;
                                                            }
                                                        }
                                                    }
                                                    return false;
                                                });

                                                console.log('   ✅ 已点击登录按钮');

                                                // 等待登录处理（页面会跳转，需处理导航错误）
                                                console.log('   ⏳ 等待登录处理...');
                                                await sleep(5000);

                                                let finalUrl = '';
                                                let finalTitle = '';
                                                try {
                                                    finalUrl = confirmPage.url();
                                                    finalTitle = await confirmPage.title();
                                                } catch (e) {
                                                    // 导航中上下文被销毁，等待稳定后重试
                                                    console.log('   ⚠️  页面导航中，等待稳定...');
                                                    await sleep(3000);
                                                    try {
                                                        finalUrl = confirmPage.url();
                                                        finalTitle = await confirmPage.title();
                                                    } catch (_) {
                                                        finalUrl = confirmPage.url();
                                                        finalTitle = '(navigation error)';
                                                    }
                                                }
                                                console.log(`   最终 URL: ${finalUrl}`);
                                                console.log(`   页面标题: "${finalTitle}"`);

                                                if (finalUrl.includes('/websites') || finalUrl.includes('dashboard') || !finalUrl.includes('login')) {
                                                    console.log('   ✅ 登录成功！');

                                                    // 步骤 18: 获取 Active Sessions 的 IP 和 cookies，更新 adsterra_account
                                                    console.log('\n📊 步骤 18: 获取 IP 和 cookies...');

                                                    // 访问 settings 页面
                                                    console.log('   🌐 访问 settings?tab=ACTIVE_SESSIONS ...');
                                                    try {
                                                        await confirmPage.goto('https://beta.publishers.adsterra.com/settings?tab=ACTIVE_SESSIONS', {
                                                            waitUntil: 'load',
                                                            timeout: 60000
                                                        });
                                                    } catch (e) {
                                                        console.log('   ⚠️  页面加载超时，继续...');
                                                    }
                                                    await sleep(5000);

                                                    console.log(`   📍 Settings URL: ${confirmPage.url()}`);

                                                    // 等待页面数据加载完成（表格出现）
                                                    console.log('   ⏳ 等待 Active Sessions 数据加载...');
                                                    let sessionIp = null;
                                                    for (let i = 0; i < 20; i++) {
                                                        sessionIp = await confirmPage.evaluate(() => {
                                                            const tables = document.querySelectorAll('table, [role="table"], .MuiTable-root');
                                                            for (const table of tables) {
                                                                const rows = table.querySelectorAll('tr, [role="row"]');
                                                                for (let r = 1; r < rows.length; r++) {
                                                                    const cells = rows[r].querySelectorAll('td, [role="cell"]');
                                                                    for (const cell of cells) {
                                                                        const text = (cell.textContent || '').trim();
                                                                        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)) {
                                                                            return text;
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                            const bodyText = document.body?.innerText || '';
                                                            const ipMatch = bodyText.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
                                                            return ipMatch ? ipMatch[0] : null;
                                                        });
                                                        if (sessionIp) {
                                                            console.log(`   ✅ IP 已获取: ${sessionIp} (${i * 2}s)`);
                                                            break;
                                                        }
                                                        if (i % 5 === 0) {
                                                            console.log(`   ⏳ 等待表格数据... (${i * 2}s)`);
                                                        }
                                                        await sleep(2000);
                                                    }

                                                    if (!sessionIp) {
                                                        console.warn('   ⚠️  未获取到 IP');
                                                    }

                                                    // 等待 cookies 设置完成
                                                    console.log('   ⏳ 等待 cookies 设置完成...');
                                                    await sleep(10000);

                                                    console.log(`   🌐 Active Session IP: ${sessionIp || '未找到'}`);

                                                    // 获取 cookies 并转为 JSON
                                                    const cookies = await confirmPage.cookies();
                                                    const cookiesJson = JSON.stringify(cookies);
                                                    console.log(`   🍪 Cookies 数量: ${cookies.length}`);

                                                    // 更新 adsterra_account 表
                                                    console.log('   💾 更新 adsterra_account 记录...');
                                                    try {
                                                        const dbConn = await mysql.createConnection(DB_CONFIG);
                                                        await dbConn.execute(
                                                            `UPDATE adsterra_account
                                                             SET login_ip = ?, cookie = ?, status = 'STOP', is_delete = 1
                                                             WHERE account = ?`,
                                                            [sessionIp || '', cookiesJson, task.email]
                                                        );
                                                        console.log(`   ✅ 已更新: account="${task.email}", login_ip="${sessionIp}", status=STOP, is_delete=1`);
                                                        await dbConn.end();
                                                    } catch (e) {
                                                        console.warn(`   ⚠️  更新 adsterra_account 失败: ${e.message}`);
                                                    }

                                                    // 更新任务状态为 completed
                                                    console.log('   💾 更新任务状态为 completed...');
                                                    await updateTaskStatus(task.id, 'completed');
                                                    console.log('   ✅ 任务已完成！');
                                                } else {
                                                    console.log('   ⚠️  可能仍在登录页，请手动确认');
                                                }

                                                await confirmPage.screenshot({ path: 'step17-login-result.png', fullPage: true });
                                                console.log('   📸 登录结果截图: step17-login-result.png');
                                            } else {
                                                console.warn('   ⚠️  按钮等待超时，Cloudflare 校验可能未完成');
                                                await confirmPage.screenshot({ path: 'step17-login-timeout.png', fullPage: true });
                                            }
                                        }

                                        // 步骤 16-17 完成，保持浏览器打开
                                        console.log('\n========================================\n');
                                        console.log('✅ Sign Up 爬虫 + 邮件确认 + 登录 完成！');
                                        console.log('\n🕐 浏览器保持打开状态，按 Ctrl+C 退出...');
                                        await new Promise(() => {});
                                        return;
                                    } else {
                                        console.warn('   ⚠️  未找到 Confirm email 链接');
                                        if (confirmLink) {
                                            console.log(`   诊断: iframe linkCount=${confirmLink.linkCount}, body="${confirmLink.bodyPreview?.slice(0, 200)}"`);
                                        }
                                        await yopmailPage.screenshot({ path: 'step15-confirm-link-not-found.png', fullPage: true });
                                    }
                                } else {
                                    console.warn('   ⚠️  未找到 Adsterra 确认邮件');

                                    // yopmail 流程未完成，保持浏览器打开
                                    console.log('\n========================================\n');
                                    console.log('⚠️  未找到确认邮件，yopmail 浏览器保持打开');
                                    console.log('\n🕐 按 Ctrl+C 退出...');
                                    await new Promise(() => {});
                                    return;
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
                    console.log('\n🕐 浏览器保持打开状态，按 Ctrl+C 退出...');

                    // 保持进程运行
                    await new Promise(() => {});
                    return;

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
        console.log('\n🕐 浏览器保持打开状态，按 Ctrl+C 退出...');

        // 保持进程运行
        await new Promise(() => {});

    } catch (error) {
        console.error('❌ 发生错误:', error.message);

        // 清理浏览器
        if (browser) {
            try { await browser.close(); } catch (_) {}
            browser = null;
        }
        if (proxyManager) {
            proxyManager.destroy();
            proxyManager = null;
        }

        if (!signupClicked) {
            // SIGN UP 之前失败 → 重试
            if (attempt < MAX_RETRIES - 1) {
                console.log(`   🔄 将在下次循环中重试...\n`);
                continue;
            }
            // 重试次数用完 → 标记 failed
            console.error('❌ 重试次数已用完，任务标记为 failed');
            await updateTaskStatus(task.id, 'failed');
            process.exit(1);
        } else {
            // SIGN UP 之后失败 → 直接标记 failed
            console.error('❌ SIGN UP 后流程异常，任务标记为 failed');
            await updateTaskStatus(task.id, 'failed');
            process.exit(1);
        }
    }

    }

    // 如果 for 循环结束但 signupClicked 仍为 false（重试耗尽）
    if (!signupClicked) {
        console.error('❌ 未能成功提交 SIGN UP，退出');
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
