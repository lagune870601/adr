/**
 * crawler-utils.js — Adsterra 爬虫共享工具函数
 *
 * 包含：反检测补丁、Cloudflare Turnstile 处理、Cookie 弹窗处理等
 * 供 signup.js / login.js 等爬虫脚本复用
 */

// ==================== 工具函数 ====================

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== Cloudflare Turnstile 反检测与交互 ====================

/**
 * 应用反检测补丁，隐藏无头模式特征（在页面导航前调用）
 * 针对 Cloudflare Turnstile 的 headless 检测做全面规避
 */
export async function applyStealthPatches(page) {
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
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParam.call(this, param);
        };
    });
}

/**
 * 主动尝试解决 Turnstile 挑战
 */
export async function tryResolveTurnstile(page) {
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
        const containers = document.querySelectorAll('.cf-turnstile, #cf-turnstile, [data-cf-turnstile]');
        if (typeof turnstile !== 'undefined') {
            if (containers.length > 0) {
                for (const w of containers) {
                    let id = w.getAttribute('data-widget-id');
                    if (!id) {
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
            const container = document.getElementById('cf-turnstile') || document.querySelector('.cf-turnstile');
            if (container && containers.length > 0) {
                try {
                    turnstile.render(container);
                    return { executed: true, method: 'turnstile_rerender' };
                } catch (_) {}
            }
            try {
                turnstile.execute();
                return { executed: true, method: 'turnstile_execute_default' };
            } catch (e) {
                return { executed: false, error: e.message };
            }
        }
        return { executed: false, method: 'no_api' };
    });

    if (apiResult.executed) {
        console.log(`   🎯 通过 Turnstile API 触发 (method: ${apiResult.method})`);
        return { resolved: false, method: apiResult.method };
    }

    // 方法 3: 点击 Turnstile 容器区域（模拟用户点击）
    const clickResult = await page.evaluate(() => {
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
        for (const sel of ['.cf-turnstile', '#cf-turnstile', '[data-cf-turnstile]']) {
            const el = document.querySelector(sel);
            if (el) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                }
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
 */
export async function detectCloudflareStatus(page) {
    const status = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const title = document.title;

        // ====== 挑战失败的标志 ======
        const failureKeywords = [
            'access denied', 'blocked', 'sorry, you have been blocked',
            'your request has been blocked', 'forbidden', 'error 403',
            'error 1020', 'error 1006', 'error 1007', 'error 1008',
            'your ip', 'your ip address has been', 'owner of this website has banned',
            'unable to verify', 'attention required', 'complete the security check',
            '被拦截', '访问被拒绝', '您的请求已被拦截', '禁止访问',
        ];
        const hasFailureText = failureKeywords.some(kw => bodyText.includes(kw));
        const isErrorTitle = title.includes('Access denied') || title.includes('Blocked') || title.includes('403') || title.includes('Forbidden');
        const hasErrorElement = !!(
            document.querySelector('#error-overview') ||
            document.querySelector('.error-code') ||
            document.querySelector('[class*="attack"]') ||
            document.querySelector('#cf-error-details')
        );
        const isFailed = hasFailureText || isErrorTitle || hasErrorElement;

        // ====== 挑战进行中的标志 ======
        const url = window.location.href;
        const isCfUrl = url.includes('/cdn-cgi/challenge') || url.includes('/cdn-cgi/l/') || url.includes('__cf_chl_');
        const challengeKeywords = [
            'just a moment', 'checking your browser', 'ddos protection',
            'ray id:', 'performance & security by cloudflare',
            '正在验证您是否是真人', '请稍候，我们正在检查您的浏览器',
            'enable javascript and cookies', 'please turn javascript on and reload',
            'checking if the site connection is secure',
            'reviewing the security of your connection',
            'attention required!', 'complete the security check to access',
        ];
        const hasChallengeText = challengeKeywords.some(kw => bodyText.includes(kw));
        const isCfTitle = title.includes('Just a moment') || title.includes('Checking');
        const isShortBody = bodyText.length > 0 && bodyText.length < 80;
        const looksLikeChallenge = isShortBody && (isCfTitle || isCfUrl);
        const hasChallengeElement = !!(
            document.querySelector('#challenge-form') ||
            document.querySelector('#challenge-running') ||
            document.querySelector('#cf-content') ||
            document.querySelector('#cf-please-wait') ||
            document.querySelector('.cf-browser-verification') ||
            document.querySelector('.lds-ring')
        );
        const hasIframe = document.querySelectorAll('iframe').length > 0;

        // ====== 挑战成功的标志 ======
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

        // ====== Turnstile 挑战状态 ======
        const turnstileToken = document.querySelector('input[name="cloudflareCaptchaToken"]');
        const turnstilePending = turnstileToken && !turnstileToken.value;
        const turnstileDone = turnstileToken && turnstileToken.value;
        const turnstileDiv = document.querySelector('.cf-turnstile, #cf-turnstile');
        const turnstileExpected = !!turnstileDiv || typeof window.turnstile !== 'undefined';

        const isChallenging = !isFailed && (
            isCfUrl || hasChallengeText || hasChallengeElement ||
            looksLikeChallenge || (hasIframe && isShortBody && !hasSignupContent) ||
            turnstilePending ||
            (turnstileExpected && !turnstileDone && !hasSignupContent) ||
            (!hasSignupContent && (bodyText.includes('verifying') || bodyText.includes('正在验证')))
        );

        const isSuccess = !isChallenging && !isFailed && (
            turnstileDone || hasSignupContent
        );

        return {
            isChallenging, isSuccess, isFailed, title, url,
            hasRealContent: hasSignupContent,
            turnstileExpected, turnstilePending, turnstileDone,
            hasChallengeText, hasChallengeElement, hasFailureText,
            hasIframe, isShortBody, bodyLen: bodyText.length,
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
 * @returns {Promise<'success'|'failed'|'timeout'>}
 */
export async function waitForCloudflareChallenge(page, maxWaitMs = 90000) {
    console.log('⏳ 检测 Cloudflare 挑战...');
    const startTime = Date.now();
    let lastStatus = null;
    let stuckCount = 0;
    let lastBodyText = '';
    let turnstileAttempted = false;

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const status = await detectCloudflareStatus(page);
            lastStatus = status;

            if (status.isSuccess) {
                return 'success';
            }

            if (status.isFailed) {
                console.log('❌ Cloudflare 挑战失败！');
                console.log(`   标题: "${status.title}"`);
                console.log(`   body 预览: ${status.bodyPreview?.slice(0, 100)}`);
                return 'failed';
            }

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

            if (elapsed > 2 && (elapsed % 4 === 0) && !turnstileAttempted) {
                console.log(`   🔄 主动触发 Turnstile 挑战 (${elapsed}s)...`);
                await tryResolveTurnstile(page);
                turnstileAttempted = true;
            }
            if (elapsed % 4 === 1) {
                turnstileAttempted = false;
            }

            if (status.isChallenging) {
                console.log(`   🔄 挑战进行中... (${elapsed}s)${stuckCount > 0 ? ` 卡死计数: ${stuckCount}` : ''}`);
            } else {
                console.log(`   ⏳ 等待页面加载... (${elapsed}s) bodyLen=${status.bodyLen} hasRealContent=${status.hasRealContent} turnstileExpected=${status.turnstileExpected} turnstilePending=${status.turnstilePending} turnstileDone=${status.turnstileDone}`);
                console.log(`      挑战关键词: ${status.hasChallengeText}, 挑战元素: ${status.hasChallengeElement}, iframe: ${status.hasIframe}`);
            }
        } catch (e) {
            // 页面导航中 frame detached → 等待页面稳定后继续
            if (e.message && (e.message.includes('detached Frame') || e.message.includes('Execution context was destroyed'))) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                console.log(`   ⚠️  页面正在导航，等待稳定... (${elapsed}s)`);
                await sleep(3000);
                continue;
            }
            throw e;
        }

        await sleep(2000);
    }

    console.log('⚠️  Cloudflare 挑战等待超时，进行最后一次 Turnstile 触发...');
    await tryResolveTurnstile(page);
    await sleep(5000);

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

// ==================== Cookie 弹窗处理 ====================

/**
 * 处理 Cookiebot 同意弹窗
 * @param {Page} page - Puppeteer 页面对象
 * @param {number} maxWaitSec - 最大等待秒数
 * @returns {Promise<boolean>} 是否成功关闭弹窗
 */
export async function handleCookieDialog(page, maxWaitSec = 16) {
    console.log('   🍪 检查并关闭 Cookie 同意弹窗...');

    for (let retry = 0; retry < Math.ceil(maxWaitSec / 2); retry++) {
        await sleep(2000);

        const cookieResult = await page.evaluate(() => {
            const cookiebotDialog = document.querySelector('#CybotCookiebotDialog');

            if (cookiebotDialog) {
                const buttons = cookiebotDialog.querySelectorAll('button');

                // 优先查找 "Allow all" 按钮
                for (const btn of buttons) {
                    const btnId = btn.id || '';
                    const btnText = (btn.textContent || '').toLowerCase().trim();
                    if (btnId.includes('LevelOptinAllowAll') && !btnId.includes('Selection') ||
                        (btnText === 'allow all' && !btnText.includes('selection'))) {
                        return { found: true, buttonText: btnText, buttonId: btn.id, dialogFound: true, isAllowAll: true };
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
                        return { found: true, buttonText: (btn.textContent || '').trim().slice(0, 50), buttonId: btn.id, dialogFound: true, isMainButton: true };
                    }
                }

                if (buttons.length > 0) {
                    return { found: true, buttonText: (buttons[0].textContent || '').trim().slice(0, 50), buttonId: buttons[0].id, dialogFound: true, isFirst: true };
                }
            }

            // 尝试其他常见的 cookie banner
            const bannerSelectors = [
                '[role="alertdialog"]', '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
                '.cookie-banner', '#cookie-banner',
            ];
            for (const selector of bannerSelectors) {
                const banner = document.querySelector(selector);
                if (banner) {
                    const buttons = banner.querySelectorAll('button');
                    for (const btn of buttons) {
                        const btnText = (btn.textContent || '').toLowerCase().trim();
                        if (btnText.includes('accept') || btnText.includes('allow') ||
                            btnText.includes('ok') || btnText.includes('agree')) {
                            return { found: true, buttonText: btnText, bannerFound: true };
                        }
                    }
                    break;
                }
            }

            return { found: false };
        });

        if (cookieResult.found) {
            console.log(`   ✅ Cookie 弹窗已出现 (第 ${retry + 1} 次检测)`);

            // 点击按钮关闭弹窗
            await page.evaluate(() => {
                const cookiebotDialog = document.querySelector('#CybotCookiebotDialog');
                if (cookiebotDialog) {
                    const buttons = cookiebotDialog.querySelectorAll('button');
                    for (const btn of buttons) {
                        const btnId = btn.id || '';
                        const btnText = (btn.textContent || '').toLowerCase().trim();
                        if (btnId.includes('LevelOptinAllowAll') && !btnId.includes('Selection') ||
                            (btnText === 'allow all' && !btnText.includes('selection'))) {
                            btn.click();
                            return true;
                        }
                    }
                    for (const btn of buttons) {
                        const btnId = btn.id || '';
                        const btnText = (btn.textContent || '').toLowerCase().trim();
                        if (!btnId.includes('ContentCookieContainer') && !btnId.includes('IABv2') &&
                            !btnText.includes('necessary') && !btnText.includes('preferences') &&
                            !btnText.includes('statistics') && !btnText.includes('marketing') &&
                            !btnText.includes('unclassified')) {
                            btn.click();
                            return true;
                        }
                    }
                    if (buttons.length > 0) {
                        buttons[0].click();
                        return true;
                    }
                }
                const bannerSelectors = [
                    '[role="alertdialog"]', '[aria-label*="cookie" i]',
                    '.cookie-banner', '#cookie-banner',
                ];
                for (const selector of bannerSelectors) {
                    const banner = document.querySelector(selector);
                    if (banner) {
                        const buttons = banner.querySelectorAll('button');
                        if (buttons.length > 0) {
                            buttons[0].click();
                            return true;
                        }
                    }
                }
                return false;
            });

            console.log(`   ✅ 已点击 Cookie 同意按钮: ${cookieResult.buttonText || cookieResult.buttonId}`);
            await sleep(3000);
            return true;
        }

        console.log(`   ⏳ 等待 Cookie 弹窗... (${(retry + 1) * 2}s)`);
    }

    console.log('   ℹ️ 未检测到 Cookie 同意弹窗');
    return false;
}

// ==================== 登录 IP 获取 ====================

/**
 * 获取登录 IP（从 Active Sessions 页面）
 * @param {Page} page - Puppeteer 页面对象
 * @param {number} maxWaitSec - 最大等待秒数
 * @returns {Promise<string|null>} IP 地址或 null
 */
export async function getLoginIp(page, maxWaitSec = 40) {
    console.log('   🌐 访问 settings?tab=ACTIVE_SESSIONS ...');
    try {
        await page.goto('https://beta.publishers.adsterra.com/settings?tab=ACTIVE_SESSIONS', {
            waitUntil: 'load',
            timeout: 60000
        });
    } catch (e) {
        console.log('   ⚠️  页面加载超时，继续...');
    }
    await sleep(5000);

    console.log(`   📍 Settings URL: ${page.url()}`);
    console.log('   ⏳ 等待 Active Sessions 数据加载...');

    let sessionIp = null;
    for (let i = 0; i < Math.ceil(maxWaitSec / 2); i++) {
        sessionIp = await page.evaluate(() => {
            const tables = document.querySelectorAll('table, [role="table"], .MuiTable-root');
            for (const table of tables) {
                const rows = table.querySelectorAll('tr, [role="row"]');
                const cells = rows[rows.length - 1].querySelectorAll('td, [role="cell"]');
                for (const cell of cells) {
                    const text = (cell.textContent || '').trim();
                    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)) {
                        return text;
                    }
                }
            }
            const bodyText = document.body?.innerText || '';
            const ipMatch = bodyText.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
            return ipMatch ? ipMatch[0] : null;
        });

        if (sessionIp) {
            console.log(`   ✅ IP 已获取: ${sessionIp} (${i * 2}s)`);
            return sessionIp;
        }

        if (i % 5 === 0) {
            console.log(`   ⏳ 等待表格数据... (${i * 2}s)`);
        }
        await sleep(2000);
    }

    console.warn('   ⚠️  未获取到 IP');
    return null;
}