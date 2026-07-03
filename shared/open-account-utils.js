const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const WEBSITES_URL = 'https://beta.publishers.adsterra.com/websites';
const LOGIN_URL = 'https://beta.publishers.adsterra.com/login';

/**
 * 打开 Adsterra Publisher 账号页面
 *
 * 使用 cookies 登录态直接访问 websites 页面，无需处理 Cloudflare 挑战。
 * 浏览器启动在调用方（主进程）中完成，本函数只负责 page 级别的操作。
 *
 * @param {Browser} browser - 已启动的 CloakBrowser 实例
 * @param {object} proxy - { host, port, username, password }
 * @param {Array<object>} cookies - Puppeteer setCookie 格式的 cookie 数组
 * @returns {Promise<Page>} 已打开 websites 页面的 page 对象
 */
export async function openAccountPage(browser, proxy, cookies) {
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

    // 设置视口
    await page.setViewport({ width: 1920, height: 1080 });

    // 步骤 1: 访问 login 页面建立 domain（cookie 需要先访问同域名页面才能设置）
    console.log(`   🌐 访问 ${LOGIN_URL} 建立 domain...`);
    try {
        await page.goto(LOGIN_URL, {
            waitUntil: 'load',
            timeout: 120000
        });
    } catch (e) {
        console.log('   ⚠️  页面加载超时，检查当前页面状态...');
        const currentUrl = page.url();
        console.log(`   当前 URL: ${currentUrl}`);
    }

    await sleep(2000);
    console.log('   ✅ Domain 已建立');

    // 步骤 2: 设置 cookies
    if (cookies && cookies.length > 0) {
        console.log(`   🍪 设置 ${cookies.length} 个 cookies...`);
        await page.setCookie(...cookies);
        console.log('   ✅ Cookies 设置完成');
    } else {
        console.log('   🍪 跳过（无可用 cookies）');
    }

    // 步骤 3: 访问 websites 页面
    console.log(`   🌐 访问 ${WEBSITES_URL} ...`);
    try {
        await page.goto(WEBSITES_URL, {
            waitUntil: 'load',
            timeout: 120000
        });
    } catch (e) {
        console.log('   ⚠️  页面加载超时，检查当前页面状态...');
        const currentUrl = page.url();
        console.log(`   当前 URL: ${currentUrl}`);
    }

    await sleep(20000);

    const title = await page.title();
    const finalUrl = page.url();
    console.log(`   📄 页面标题: ${title}`);
    console.log(`   🔗 URL: ${finalUrl}`);

    // 检查是否跳转到了登录页（cookies 可能已过期）
    if (finalUrl.includes('login')) {
        console.error('   ❌ Cookies 已过期，需要重新登录');
        throw new Error('Cookies 已过期，需要重新登录');
    }

    // 步骤 4: 处理 T&C 弹窗（如有）
    await handleTermsDialog(page);

    console.log('   ✅ websites 页面加载完成');
    return page;
}

/**
 * 处理 "Updates to Terms & Conditions and Privacy Policy" 弹窗
 *
 * MUI Dialog 结构：
 *   - 标题: "Updates to Terms & Conditions and Privacy Policy"
 *   - 复选框: input[type="checkbox"] — 同意条款
 *   - 按钮: "Confirm" — 初始 disabled，勾选复选框后启用
 *
 * @param {Page} page - Puppeteer 页面对象
 */
async function handleTermsDialog(page) {
    console.log('   🔍 检查 T&C 弹窗...');

    // 检测弹窗是否存在
    const tcDetected = await page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        return bodyText.includes('Updates to Terms') &&
               bodyText.includes('Privacy Policy');
    });

    if (!tcDetected) {
        console.log('   ℹ️ 未检测到 T&C 弹窗，跳过');
        return;
    }

    console.log('   ⚠️ 检测到 T&C 弹窗，开始处理...');

    // 等待弹窗完全渲染
    await sleep(2000);

    // 1. 点击复选框（同意条款）
    // MUI Checkbox 的 input 是隐藏的，需要点击其可见的父级元素
    console.log('   ☑️  勾选同意条款复选框...');

    const checkboxClicked = await page.evaluate(() => {
        // 方法 1: 查找包含 "I've read and accept" 文本的 label 并点击
        const labels = document.querySelectorAll('label');
        for (const label of labels) {
            const text = (label.textContent || '').trim();
            if (text.includes("I've read and accept") || text.includes('Terms & Conditions')) {
                // MUI checkbox 的可见元素通常在 label 内的 span 上
                const checkbox = label.querySelector('input[type="checkbox"]');
                if (checkbox) {
                    // 点击 checkbox 的父级 span（MUI 的可见部分）
                    const muiCheckbox = checkbox.closest('[class*="MuiCheckbox"]') || checkbox.parentElement;
                    if (muiCheckbox) {
                        const rect = muiCheckbox.getBoundingClientRect();
                        return {
                            found: true,
                            x: Math.round(rect.x + rect.width / 2),
                            y: Math.round(rect.y + rect.height / 2),
                            method: 'mui-checkbox',
                            labelText: text.slice(0, 60),
                        };
                    }
                }
                // 兜底：直接点击 label
                const rect = label.getBoundingClientRect();
                return {
                    found: true,
                    x: Math.round(rect.x + 20),
                    y: Math.round(rect.y + rect.height / 2),
                    method: 'label',
                    labelText: text.slice(0, 60),
                };
            }
        }

        // 方法 2: 直接查找 checkbox input
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        for (const cb of checkboxes) {
            const parentText = (cb.parentElement?.textContent || '').trim();
            if (parentText.includes('Terms') || parentText.includes('accept')) {
                const rect = cb.getBoundingClientRect();
                return {
                    found: true,
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2),
                    method: 'input-direct',
                };
            }
        }

        return { found: false };
    });

    if (!checkboxClicked.found) {
        console.log('   ⚠️  未找到 T&C 复选框，尝试跳过...');
        return;
    }

    console.log(`   复选框位置: (${checkboxClicked.x}, ${checkboxClicked.y}), method=${checkboxClicked.method}`);

    // 使用 Puppeteer 原生点击
    await page.mouse.click(checkboxClicked.x, checkboxClicked.y);
    await sleep(1000);

    // 验证复选框是否已勾选
    const isChecked = await page.evaluate(() => {
        // 在 T&C 弹窗中查找复选框
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
            const text = (d.textContent || '').trim();
            if (text.includes('Updates to Terms') && text.includes('Privacy Policy')) {
                const cb = d.querySelector('input[type="checkbox"]');
                if (cb) return cb.checked;
            }
        }
        // 兜底：全局搜索
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        for (const cb of checkboxes) {
            const parent = cb.closest('[role="dialog"]') || cb.closest('.MuiDialog-root');
            if (parent) {
                const parentText = (parent.textContent || '').trim();
                if (parentText.includes('Terms') && parentText.includes('Privacy')) {
                    return cb.checked;
                }
            }
        }
        return null;
    });
    console.log(`   复选框已勾选: ${isChecked}`);

    // 2. 点击 Confirm 按钮
    console.log('   🔘 点击 Confirm 按钮...');

    // 等待 Confirm 按钮变为可用
    let confirmClicked = false;
    for (let i = 0; i < 10; i++) {
        await sleep(1000);

        const confirmBtn = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (text === 'Confirm' && !btn.disabled && btn.offsetParent !== null) {
                    const rect = btn.getBoundingClientRect();
                    return {
                        found: true,
                        disabled: false,
                        x: Math.round(rect.x + rect.width / 2),
                        y: Math.round(rect.y + rect.height / 2),
                    };
                }
                if (text === 'Confirm') {
                    // 找到了但被禁用
                    return { found: true, disabled: true };
                }
            }
            return { found: false };
        });

        if (confirmBtn.found && !confirmBtn.disabled) {
            console.log(`   Confirm 按钮已可用 (${i + 1}s), 坐标: (${confirmBtn.x}, ${confirmBtn.y})`);
            await page.mouse.click(confirmBtn.x, confirmBtn.y);
            confirmClicked = true;
            break;
        }

        if (i % 3 === 0) {
            console.log(`   ⏳ 等待 Confirm 按钮可用... (${i + 1}s) disabled=${confirmBtn.disabled}`);
        }
    }

    if (!confirmClicked) {
        console.log('   ⚠️  Confirm 按钮未在 10s 内变为可用，尝试强制点击...');

        // 兜底：尝试强制点击 Confirm
        const forceClick = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if ((btn.textContent || '').trim() === 'Confirm') {
                    const rect = btn.getBoundingClientRect();
                    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                }
            }
            return null;
        });

        if (forceClick) {
            await page.mouse.click(forceClick.x, forceClick.y);
            confirmClicked = true;
        }
    }

    // 等待弹窗关闭
    await sleep(3000);
    console.log('   ✅ T&C 弹窗已处理');
}