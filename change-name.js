import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import { openAccountPage } from './shared/open-account-utils.js';
import { handleCookieDialog } from './shared/crawler-utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const SETTINGS_URL = 'https://beta.publishers.adsterra.com/settings';
const YOPMAIL_URL = 'https://yopmail.net/';

/**
 * CHANGE_NAME 爬虫
 *
 * 修改 Adsterra Publisher settings 中的 Name 字段。
 * 步骤：
 *   1. 打开账号页面
 *   2. 跳转到 settings 页面
 *   3. 填写 Name 输入框
 *   4. 点击 SAVE CHANGES 按钮
 *   5. yopmail 获取验证码 → 填入 → 确认
 *
 * @param {object} task - { id, username, email, ... }
 * @param {object} proxy - { host, port, username, password }
 * @param {Array<object>} cookies - Puppeteer 格式的 cookie 数组
 * @returns {Promise<{success: boolean, retryable: boolean, error: string|null}>}
 */
export async function changeNameCrawler(task, proxy, cookies) {
    console.log(`🚀 CHANGE_NAME 爬虫: ${task.email}`);
    console.log(`   任务 ID: ${task.id}`);
    console.log(`   username: ${task.username}`);

    let browser;
    try {
        browser = await launch({
            headless: isLinux,
            proxy: 'http://' + proxy.username + ':' + proxy.password + '@' + proxy.host + ':' + proxy.port,
            humanize: true,
            timezone: 'America/New_York',
            locale: 'en-US',
            viewport: { width: 1920, height: 1080 },
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-accelerated-2d-canvas', '--disable-gpu']
        });

        // 1. 打开账号页面
        console.log('\n📦 步骤 1: 打开账号页面...');
        const page = await openAccountPage(browser, proxy, cookies);

        // 2. 跳转到 settings 页面
        console.log(`\n🌐 步骤 2: 跳转到 settings 页面...`);
        await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(3000);
        await handleCookieDialog(page, 10);
        await sleep(3000);

        // 3. 填写 Name
        console.log(`\n📝 步骤 3: 填写 Name: ${task.username}`);
        const nameFilled = await fillNameInput(page, task.username);
        if (!nameFilled) {
            console.log('   ⚠️ 未找到 Name 输入框');
        }
        await sleep(1000);

        // 4. 点击 SAVE CHANGES 按钮
        console.log('\n🔘 步骤 4: 点击 SAVE CHANGES 按钮...');
        const saveBtn = await findButton(page, 'Save changes');
        if (!saveBtn) {
            const debugBtns = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('button'))
                    .filter(b => b.offsetParent !== null)
                    .map(b => ({ text: (b.textContent || '').trim().slice(0, 50) }));
            });
            console.log(`   🔍 可见按钮: ${JSON.stringify(debugBtns)}`);
            await browser.close();
            return { success: false, retryable: false, error: '未找到 SAVE CHANGES 按钮' };
        }
        console.log(`   🖱️  点击 Save changes (${saveBtn.x}, ${saveBtn.y})`);
        await page.mouse.click(saveBtn.x, saveBtn.y);
        await sleep(3000);

        // 5. 处理验证码
        console.log('\n🔐 步骤 5: 处理验证码...');
        const code = await getVerificationCode(browser, task);
        if (!code) {
            await browser.close();
            return { success: false, retryable: true, error: '未能获取验证码' };
        }

        await enterVerificationCode(page, code);
        console.log('   ✅ 验证码已提交');

        await browser.close();
        console.log('\n✅ CHANGE_NAME 爬虫完成！');
        return { success: true, retryable: false, error: null };

    } catch (e) {
        console.error('❌ 爬虫异常:', e.message);
        if (e.stack) console.error(e.stack);
        if (browser) await browser.close().catch(() => {});
        return { success: false, retryable: true, error: e.message };
    }
}

// ==================== 工具函数 ====================

/**
 * 通过 label 的 for 属性填写 Name 输入框
 */
async function fillNameInput(page, value) {
    return await page.evaluate((val) => {
        const labels = document.querySelectorAll('label');
        for (const labelEl of labels) {
            const labelText = (labelEl.textContent || '').trim().toLowerCase().replace(/\s*\*$/, '');
            if (labelText === 'name') {
                const forId = labelEl.getAttribute('for');
                if (forId) {
                    const inp = document.getElementById(forId);
                    if (inp && inp.offsetParent !== null) {
                        const nativeSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value'
                        ).set;
                        nativeSetter.call(inp, val);
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    }
                }
            }
        }
        return false;
    }, value);
}

/**
 * 查找精确匹配文本的按钮
 */
async function findButton(page, text) {
    return await page.evaluate((t) => {
        const lower = t.toLowerCase();
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
            const btnText = (b.textContent || '').trim().toLowerCase();
            if (btnText === lower && b.offsetParent !== null) {
                const rect = b.getBoundingClientRect();
                return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
            }
        }
        return null;
    }, text);
}

/**
 * 从 yopmail 获取验证码
 */
async function getVerificationCode(browser, task) {
    console.log('   📬 打开 yopmail 获取验证码...');

    const yopmailPage = await browser.newPage();
    try {
        yopmailPage.setDefaultNavigationTimeout(60000);
        yopmailPage.setDefaultTimeout(30000);
        await yopmailPage.setViewport({ width: 1920, height: 1080 });

        console.log('   🌐 访问 yopmail.net...');
        await yopmailPage.goto(YOPMAIL_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(3000);

        // 关闭广告
        console.log('   🧹 关闭广告弹窗...');
        for (let i = 0; i < 5; i++) {
            await yopmailPage.evaluate(() => {
                ['[aria-label="Close"]', '[aria-label="close"]', '.close', '.dismiss',
                 'div[class*="overlay" i]', 'div[class*="popup" i]', 'div[class*="ad" i]', 'ins.adsbygoogle']
                    .forEach(sel => {
                        document.querySelectorAll(sel).forEach(el => {
                            try { el.click(); } catch (_) {}
                            try { el.remove(); } catch (_) {}
                        });
                    });
            });
            await sleep(500);
        }

        // 输入邮箱前缀
        const emailPrefix = task.email.split('@')[0];
        console.log(`   📧 邮箱前缀: ${emailPrefix}`);
        const inputSelectors = ['#login', 'input[name="login"]', 'input[type="text"]', 'input:not([type="hidden"])'];

        let inputFound = false;
        for (const sel of inputSelectors) {
            try {
                const inputEl = await yopmailPage.$(sel);
                if (inputEl) {
                    await inputEl.click({ clickCount: 3 });
                    await inputEl.type(emailPrefix, { delay: 30 });
                    const val = await yopmailPage.$eval(sel, e => e.value);
                    if (val === emailPrefix) {
                        console.log(`   ✅ 已输入邮箱前缀: "${val}"`);
                        await yopmailPage.keyboard.press('Enter');
                        inputFound = true;
                        break;
                    }
                }
            } catch (_) {}
        }

        if (!inputFound) {
            console.log('   ⚠️ 未找到 yopmail 输入框');
            return null;
        }

        await sleep(5000);

        // 查找验证码邮件
        console.log('   ✉️ 查找验证码邮件...');
        const emailClicked = await yopmailPage.evaluate(() => {
            const iframe = document.getElementById('ifinbox');
            if (!iframe) return { found: false, error: 'ifinbox not found' };
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc) return { found: false, error: 'doc not accessible' };
                const items = doc.querySelectorAll('.m, .msg, .lm, [class*="message" i], div[onclick]');
                const priorityKeywords = ['verification', 'security code', 'confirm'];
                for (const kw of priorityKeywords) {
                    for (const item of items) {
                        if ((item.textContent || '').toLowerCase().includes(kw)) {
                            item.click();
                            return { found: true, keyword: kw, text: (item.textContent || '').trim().slice(0, 150) };
                        }
                    }
                }
                return { found: false, error: 'no matching email', itemCount: items.length };
            } catch (e) {
                return { found: false, error: e.message };
            }
        });

        console.log(`   邮件查找: ${JSON.stringify(emailClicked)}`);
        if (!emailClicked.found) {
            console.log('   ⚠️ 未找到验证码邮件');
            return null;
        }

        await sleep(5000);

        // 提取验证码
        console.log('   🔍 提取验证码...');
        const code = await yopmailPage.evaluate(() => {
            const iframe = document.getElementById('ifmail');
            const getText = (doc) => {
                const bodyText = doc.body?.innerText || '';
                const patterns = [
                    /verification\s*code[:\s]*([\da-f]{6,8})/i,
                    /security\s*code[:\s]*([\da-f]{6,8})/i,
                    /code[:\s]*([\da-f]{6,8})/i,
                    /your\s+code[:\s]*([\da-f]{6,8})/i,
                    /code\s+is[:\s]*([\da-f]{6,8})/i,
                ];
                for (const p of patterns) {
                    const match = bodyText.match(p);
                    if (match) return match[1];
                }
                return null;
            };
            if (iframe) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (doc) return getText(doc);
                } catch (_) {}
            }
            return getText(document);
        });

        console.log(`   验证码: ${code || '未找到'}`);
        return code;

    } finally {
        await yopmailPage.close().catch(() => {});
    }
}

/**
 * 输入验证码并点击确认
 */
async function enterVerificationCode(page, code) {
    console.log(`   🔢 输入验证码: ${code}`);

    const filled = await page.evaluate((code) => {
        const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
        for (const inp of inputs) {
            if (inp.offsetParent !== null && inp.type !== 'hidden') {
                const parentText = (inp.parentElement?.textContent || '').toLowerCase();
                const placeholder = (inp.placeholder || '').toLowerCase();
                if (parentText.includes('code') || parentText.includes('verif') ||
                    placeholder.includes('code') || placeholder.includes('verif')) {
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeSetter.call(inp, code);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
            }
        }
        return false;
    }, code);

    if (filled) console.log('   ✅ 验证码已填入');
    await sleep(1000);

    // 点击确认按钮（Save changes 或 Confirm）
    const confirmBtn = await findButton(page, 'Save changes') || await findButtonByText(page, 'Confirm');
    if (confirmBtn) {
        console.log(`   🖱️  点击确认按钮 (${confirmBtn.x}, ${confirmBtn.y})`);
        await page.mouse.click(confirmBtn.x, confirmBtn.y);
    } else {
        console.log('   ⚠️ 未找到确认按钮，按 Enter...');
        await page.keyboard.press('Enter');
    }
    await sleep(20000);
}

/**
 * 通过包含文本查找按钮
 */
async function findButtonByText(page, text) {
    return await page.evaluate((t) => {
        const lower = t.toLowerCase();
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
            const btnText = (b.textContent || '').trim().toLowerCase();
            if (btnText.includes(lower) && b.offsetParent !== null) {
                const rect = b.getBoundingClientRect();
                return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
            }
        }
        return null;
    }, text);
}