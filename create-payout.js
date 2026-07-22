import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';
import { openAccountPage } from './shared/open-account-utils.js';
import { handleCookieDialog } from './shared/crawler-utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const PAYOUT_URL = 'https://beta.publishers.adsterra.com/payout-information';
const YOPMAIL_URL = 'https://yopmail.net/';

/**
 * CREATE_PAYOUT 爬虫
 *
 * 为 Adsterra Publisher 账号设置 Tether/Bitcoin 支付方式。
 * 步骤：
 *   1. 打开账号页面
 *   2. 跳转到 payout-information 页面
 *   3. 若已设置则点击 Edit，否则点击 Tether/Bitcoin 支付方式
 *   4. 填写表单：First Name, Last Name, Account Type, Full Home Address, Wallet
 *   5. 点击 SAVE → 验证码 → yopmail 获取验证码 → 填入 → 确认
 *   6. 保存 wallet address 到 adsterra_account.usdt_address
 *
 * @param {object} task - { id, username, email, address, payment_address, ... }
 * @param {object} proxy - { host, port, username, password }
 * @param {Array<object>} cookies - Puppeteer setCookie 格式的 cookie 数组
 * @returns {Promise<{success: boolean, retryable: boolean, error: string|null}>}
 */
export async function createPayoutCrawler(task, proxy, cookies) {
    console.log(`🚀 CREATE_PAYOUT 爬虫: ${task.email}`);
    console.log(`   任务 ID: ${task.id}`);
    console.log(`   username: ${task.username}`);
    console.log(`   address: ${task.address}`);
    console.log(`   payment_address: ${task.payment_address}`);

    const firstName = (task.username || '').trim().split(/\s+/)[0] || '';
    const lastName = (task.username || '').trim().split(/\s+/).slice(1).join(' ') || '';

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

        // 2. 跳转到 payout-information 页面
        console.log(`\n🌐 步骤 2: 跳转到 payout-information 页面...`);
        await page.goto(PAYOUT_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(3000);
        await handleCookieDialog(page, 10);
        await sleep(5000);

        // 检查页面是否正常加载
        if (page.url().includes('chrome-error') || page.url() === 'about:blank') {
            await browser.close();
            return { success: false, retryable: true, error: '页面加载失败，代理连接异常' };
        }

        // 检查是否已设置支付方式
        let alreadySet = false;
        const payoutStatus = await page.evaluate(() => {
            const bodyText = document.body?.innerText || '';
            return {
                hasChooseMethod: bodyText.includes('Choose method'),
                hasYourMethod: bodyText.includes('Your method'),
            };
        });

        if (payoutStatus.hasYourMethod) {
            console.log('   ℹ️ 该账号已设置支付方式，点击 Edit 按钮进入编辑模式...');
            alreadySet = true;

            // 点击右下角的 Edit 按钮
            const editClicked = await page.evaluate(() => {
                // 查找所有可见的 Edit 按钮
                const buttons = document.querySelectorAll('button');
                const editBtns = [];
                for (const btn of buttons) {
                    if ((btn.textContent || '').trim().toLowerCase() === 'edit' && btn.offsetParent !== null) {
                        const rect = btn.getBoundingClientRect();
                        editBtns.push({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), bottom: rect.bottom, right: rect.right });
                    }
                }
                // 取右下角那个（bottom + right 最大的）
                if (editBtns.length > 0) {
                    editBtns.sort((a, b) => (b.bottom + b.right) - (a.bottom + a.right));
                    return { found: true, ...editBtns[0] };
                }
                return { found: false };
            });

            if (editClicked.found) {
                console.log(`   🖱️  点击 Edit (${editClicked.x}, ${editClicked.y})`);
                await page.mouse.click(editClicked.x, editClicked.y);
                await sleep(3000);
            } else {
                console.log('   ⚠️  未找到 Edit 按钮');
            }
        } else if (!payoutStatus.hasChooseMethod) {
            await browser.close();
            return { success: false, retryable: false, error: '未找到 Choose method 或 Your method 模块' };
        }

        // 3. 点击支付方式（仅在未设置时）
        if (!alreadySet) {
            console.log('\n🔍 步骤 3: 点击 Tether/Bitcoin 支付方式...');
            const paySystemClicked = await page.evaluate(() => {
                const buttons = document.querySelectorAll('[role="button"]');
                for (const btn of buttons) {
                    const img = btn.querySelector('img');
                    const alt = (img?.getAttribute('alt') || '').toUpperCase();
                    if (alt.includes('TETHER') || alt.includes('BITCOIN')) {
                        const rect = btn.getBoundingClientRect();
                        return {
                            found: true,
                            alt,
                            x: Math.round(rect.x + rect.width / 2),
                            y: Math.round(rect.y + rect.height / 2),
                        };
                    }
                }
                return { found: false };
            });

            if (!paySystemClicked.found) {
                await browser.close();
                return { success: false, retryable: false, error: '未找到 Tether/Bitcoin 支付方式' };
            }
            console.log(`   🖱️  点击支付方式: ${paySystemClicked.alt} (${paySystemClicked.x}, ${paySystemClicked.y})`);
            await page.mouse.click(paySystemClicked.x, paySystemClicked.y);
            await sleep(3000);
        }

        // 4. 填写表单
        console.log('\n📝 步骤 4: 填写表单...');

        // 选择 Account type: Individual (第一个 radio)
        console.log('   ☑️  选择 Account type: Individual...');
        await page.evaluate(() => {
            const radios = document.querySelectorAll('input[type="radio"][name="userType"]');
            if (radios.length > 0) {
                radios[0].click();
            }
        });
        await sleep(500);

        // 填写 First name
        console.log(`   📝 First name: ${firstName}`);
        await fillInput(page, 'First name', firstName);

        // 填写 Last name
        console.log(`   📝 Last name: ${lastName}`);
        await fillInput(page, 'Last name', lastName);

        // 填写 Full home address（加随机后缀确保表单数据有变化，使 SAVE CHANGES 按钮可点击）
        const addressWithRandom = task.address;
        console.log(`   📝 Full home address: ${addressWithRandom}`);
        await fillInput(page, 'Full home address', addressWithRandom);

        // 填写 Wallet（查找包含 wallet 或 USDT 或 BTC 的输入框）
        console.log(`   📝 Wallet: ${task.payment_address}`);
        const walletFilled = await fillWalletInput(page, task.payment_address);
        if (!walletFilled) {
            // 调试：输出所有可见的输入框
            const debugInputs = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
                    .filter(i => i.offsetParent !== null)
                    .map(i => ({
                        placeholder: i.placeholder,
                        name: i.name,
                        id: i.id,
                        parentText: (i.parentElement?.textContent || '').trim().slice(0, 120),
                        label: (i.closest('label')?.textContent || '').trim().slice(0, 60),
                    }));
            });
            console.log(`   🔍 可用输入框: ${JSON.stringify(debugInputs)}`);
            console.log('   ⚠️  未找到 wallet 输入框，尝试模糊匹配...');
            await fillInputByLabel(page, ['wallet', 'usdt', 'btc', 'address', 'account', 'tether', 'bitcoin'], task.payment_address);
        }

        await sleep(1000);

        // 5. 点击 SAVE 按钮（编辑模式下是 SAVE CHANGES）
        console.log('\n🔘 步骤 5: 点击 SAVE 按钮...');
        const saveBtn = await findButton(page, 'Save changes') || await findButton(page, 'Save') || await findButtonByText(page, 'Save');
        if (!saveBtn) {
            // 调试输出
            const debugBtns = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('button'))
                    .filter(b => b.offsetParent !== null)
                    .map(b => ({ text: (b.textContent || '').trim().slice(0, 50) }));
            });
            console.log(`   🔍 可见按钮: ${JSON.stringify(debugBtns)}`);
            await browser.close();
            return { success: false, retryable: false, error: '未找到 SAVE 按钮' };
        }
        console.log(`   🖱️  点击 Save (${saveBtn.x}, ${saveBtn.y})`);
        await page.mouse.click(saveBtn.x, saveBtn.y);
        await sleep(2000);
        await page.screenshot({ path: 'debug-payout-after-save.png', fullPage: false });
        console.log('   📸 截图: debug-payout-after-save.png');

        // 6. 处理验证码（第一次）
        console.log('\n🔐 步骤 6: 处理第一次验证码 (payout)...');
        const code1 = await getVerificationCode(browser, page, task);
        if (!code1) {
            await browser.close();
            return { success: false, retryable: true, error: '未能获取第一次验证码' };
        }

        // 填入验证码并确认
        await enterVerificationCode(page, code1);
        console.log('   ✅ 第一次验证码已提交，按 Enter 提交');

        // 等待 30 秒，让页面处理验证
        console.log('   ⏳ 等待 30 秒...');
        await sleep(30000);

        // 检查是否已保存成功（出现 Edit 按钮表示已保存）
        const isSaved = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const b of buttons) {
                if ((b.textContent || '').trim().toLowerCase() === 'edit' && b.offsetParent !== null) {
                    return true;
                }
            }
            return false;
        });

        if (isSaved) {
            console.log('   ✅ 表单已保存成功（检测到 Edit 按钮）');
        } else {
            // 再次点击 SAVE 按钮
            console.log('   🔘 再次查找并点击 SAVE 按钮...');
            const saveBtn2 = await findButton(page, 'Save changes') || await findButton(page, 'Save') || await findButtonByText(page, 'Save');
            if (saveBtn2) {
                console.log(`   🖱️  点击 Save (${saveBtn2.x}, ${saveBtn2.y})`);
                await page.mouse.click(saveBtn2.x, saveBtn2.y);
                console.log('   ✅ 已点击 SAVE');
                await sleep(5000);
            } else {
                console.log('   ℹ️ 未找到 SAVE 按钮（可能已保存）');
            }
        }

        // 等待 30 秒，确认保存完成
        console.log('   ⏳ 等待 30 秒确认保存...');
        await sleep(30000);

        // 7. 保存 wallet address 到数据库
        console.log('\n💾 步骤 7: 保存 wallet address 到数据库...');
        await saveWalletAddress(task.email, task.payment_address);

        await browser.close();
        console.log('\n✅ CREATE_PAYOUT 爬虫完成！');
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
 * 通过 label 文本查找输入框并填写（精确匹配 label 中的文本）
 */
async function fillInput(page, labelText, value) {
    const result = await page.evaluate(({ label, val }) => {
        const lower = label.toLowerCase();
        // 查找所有 label 元素，通过 for 属性找到关联的 input
        const labels = document.querySelectorAll('label');
        for (const labelEl of labels) {
            const labelContent = (labelEl.textContent || '').trim().toLowerCase().replace(/\s*\*$/, '').replace(/\s*#/, '');
            // 精确匹配 label 文本
            if (labelContent === lower || labelContent.startsWith(lower)) {
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
    }, { label: labelText, val: value });
    if (result) console.log(`      ✅ ${labelText}: ${value}`);
    else console.log(`      ⚠️  ${labelText} 未找到匹配的输入框`);
}

/**
 * 专门填写 Wallet 输入框（在 label 中有 "Supported networks" 文字的区域）
 */
async function fillWalletInput(page, value) {
    return await page.evaluate((val) => {
        // 查找 label 文本为 "wallet" 的 label，通过 for 属性找到 input
        const labels = document.querySelectorAll('label');
        for (const labelEl of labels) {
            const labelText = (labelEl.textContent || '').trim().toLowerCase().replace(/\s*\*$/, '').replace(/\s*#/, '');
            if (labelText === 'wallet' || labelText.startsWith('wallet')) {
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
 * 通过多个 label 关键词模糊匹配填写输入框
 */
async function fillInputByLabel(page, keywords, value) {
    return await page.evaluate(({ keywords, val }) => {
        const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
        for (const inp of inputs) {
            const parentText = (inp.parentElement?.textContent || '').toLowerCase();
            const labelText = (inp.closest('label')?.textContent || '').toLowerCase();
            const combined = parentText + ' ' + labelText;
            for (const kw of keywords) {
                if (combined.includes(kw.toLowerCase())) {
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeInputValueSetter.call(inp, val);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
            }
        }
        return false;
    }, { keywords, val: value });
}

/**
 * 查找按钮坐标
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

/**
 * 从 yopmail 获取验证码
 */
async function getVerificationCode(browser, mainPage, task) {
    console.log('   📬 打开 yopmail 获取验证码...');

    const yopmailPage = await browser.newPage();
    try {
        yopmailPage.setDefaultNavigationTimeout(60000);
        yopmailPage.setDefaultTimeout(30000);
        await yopmailPage.setViewport({ width: 1920, height: 1080 });

        // 访问 yopmail
        console.log('   🌐 访问 yopmail.net...');
        await yopmailPage.goto(YOPMAIL_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(3000);

        // 关闭广告弹窗
        console.log('   🧹 关闭广告弹窗...');
        try {
            for (let i = 0; i < 5; i++) {
                try {
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
                } catch (_) {}
                await sleep(500);
            }
        } catch (_) {}

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
            console.log('   ⚠️  未找到 yopmail 输入框');
            return null;
        }

        await sleep(5000);

        // 查找 Adsterra 验证码邮件
        console.log('   ✉️  查找验证码邮件...');

        // 先获取邮件列表
        const emailList = await yopmailPage.evaluate(() => {
            const iframe = document.getElementById('ifinbox');
            if (!iframe) return [];
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc) return [];
                const items = doc.querySelectorAll('.m, .msg, .lm, [class*="message" i], div[onclick]');
                const list = [];
                items.forEach((item, idx) => {
                    const text = (item.textContent || '').trim();
                    list.push({ idx, text: text.slice(0, 200) });
                });
                return list;
            } catch (e) {
                return [];
            }
        });

        console.log(`   邮件列表: ${emailList.length} 封`);
        emailList.forEach(e => console.log(`      [${e.idx}] ${e.text.slice(0, 100)}`));

        // 优先查找包含 verification/code/security/payout 关键词的邮件
        const emailClicked = await yopmailPage.evaluate(() => {
            const iframe = document.getElementById('ifinbox');
            if (!iframe) return { found: false, error: 'ifinbox not found' };
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc) return { found: false, error: 'ifinbox doc not accessible' };

                const items = doc.querySelectorAll('.m, .msg, .lm, [class*="message" i], div[onclick]');
                // 优先关键词
                const priorityKeywords = ['verification', 'security code', 'payout', 'confirm'];
                for (const kw of priorityKeywords) {
                    for (const item of items) {
                        const text = (item.textContent || '').toLowerCase();
                        if (text.includes(kw)) {
                            item.click();
                            return { found: true, keyword: kw, text: (item.textContent || '').trim().slice(0, 150) };
                        }
                    }
                }
                // 兜底：adsterra
                for (const item of items) {
                    const text = (item.textContent || '').toLowerCase();
                    if (text.includes('adsterra')) {
                        item.click();
                        return { found: true, keyword: 'adsterra', text: (item.textContent || '').trim().slice(0, 150) };
                    }
                }
                return { found: false, error: 'no matching email', itemCount: items.length };
            } catch (e) {
                return { found: false, error: e.message };
            }
        });

        console.log(`   邮件查找: ${JSON.stringify(emailClicked)}`);

        if (!emailClicked.found) {
            // 尝试不通过 iframe 直接查找
            const fallback = await yopmailPage.evaluate(() => {
                const items = document.querySelectorAll('.m, .msg, .lm, [class*="message" i]');
                for (const item of items) {
                    const text = (item.textContent || '').toLowerCase();
                    if (text.includes('adsterra') || text.includes('verification') || text.includes('code')) {
                        item.click();
                        return { found: true, text: (item.textContent || '').trim().slice(0, 200) };
                    }
                }
                return { found: false };
            });
            if (!fallback.found) {
                console.log('   ⚠️  未找到验证码邮件');
                return null;
            }
        }

        await sleep(5000);

        // 从邮件内容中提取验证码
        console.log('   🔍 提取验证码...');
        const code = await yopmailPage.evaluate(() => {
            const iframe = document.getElementById('ifmail');
            const getText = (doc) => {
                const bodyText = doc.body?.innerText || '';
                // 优先匹配验证码上下文（支持数字和十六进制）
                const patterns = [
                    /verification\s*code[:\s]*([\da-f]{6,8})/i,
                    /security\s*code[:\s]*([\da-f]{6,8})/i,
                    /confirmation\s*code[:\s]*([\da-f]{6,8})/i,
                    /code[:\s]*([\da-f]{6,8})/i,
                    /your\s+code[:\s]*([\da-f]{6,8})/i,
                    /code\s+is[:\s]*([\da-f]{6,8})/i,
                    /here'?s?\s*(?:your\s*)?(?:verification\s*)?code[:\s]*([\da-f]{6,8})/i,
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
        if (!code) {
            // 调试输出邮件内容
            const debugBody = await yopmailPage.evaluate(() => {
                const iframe = document.getElementById('ifmail');
                const getBody = (doc) => (doc.body?.innerText || '').slice(0, 500);
                if (iframe) {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (doc) return getBody(doc);
                    } catch (_) {}
                }
                return getBody(document);
            });
            console.log(`   📧 邮件内容预览: ${debugBody}`);
        }
        return code;

    } finally {
        await yopmailPage.close().catch(() => {});
    }
}

/**
 * 在验证码输入框中输入验证码并点击确认
 */
async function enterVerificationCode(page, code) {
    console.log(`   🔢 输入验证码: ${code}`);

    // 截图看当前状态
    await page.screenshot({ path: 'debug-verification-before.png', fullPage: false });

    // 滚动到页面底部，确保验证码输入框可见
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(1000);
    await page.screenshot({ path: 'debug-verification-scrolled.png', fullPage: false });

    // 查找验证码输入框（在 dialog 中查找，或在整个页面中查找）
    const filled = await page.evaluate((code) => {
        // 先在 dialog 中查找
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
            const dText = (d.textContent || '').trim();
            if (!dText.includes('code') && !dText.includes('verif') && !dText.includes('confirm')) continue;
            const inputs = d.querySelectorAll('input[type="text"], input:not([type="hidden"])');
            for (const inp of inputs) {
                if (inp.offsetParent !== null) {
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeSetter.call(inp, code);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    return { found: true, method: 'dialog' };
                }
            }
        }
        // 兜底：查找页面中所有可见输入框，取最后一个（验证码通常在底部）
        const allInputs = document.querySelectorAll('input[type="text"], input:not([type="hidden"])');
        const visibleInputs = Array.from(allInputs).filter(i => i.offsetParent !== null);
        if (visibleInputs.length > 0) {
            // 优先找有 code/verif 关键词的
            for (const inp of visibleInputs) {
                const parentText = (inp.parentElement?.textContent || '').toLowerCase();
                const placeholder = (inp.placeholder || '').toLowerCase();
                if (parentText.includes('code') || parentText.includes('verif') || placeholder.includes('code')) {
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeSetter.call(inp, code);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    return { found: true, method: 'fallback-keyword', placeholder };
                }
            }
            // 最后兜底：取最后一个可见输入框
            const lastInp = visibleInputs[visibleInputs.length - 1];
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeSetter.call(lastInp, code);
            lastInp.dispatchEvent(new Event('input', { bubbles: true }));
            lastInp.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, method: 'fallback-last', placeholder: lastInp.placeholder };
        }
        return { found: false };
    }, code);

    console.log(`   输入结果: ${JSON.stringify(filled)}`);

    if (filled.found) {
        console.log('   ✅ 验证码已填入');
    } else {
        console.log('   ⚠️ 未找到验证码输入框');
    }

    await sleep(1000);
    await page.screenshot({ path: 'debug-verification-after.png', fullPage: false });

    await sleep(1000);

    // 点击确认按钮（可能是 Save changes, Confirm, Verify, Submit）
    const confirmBtn = await findButtonByText(page, 'Save changes') || await findButton(page, 'Save changes') ||
                       await findButtonByText(page, 'Confirm') || await findButtonByText(page, 'Verify') ||
                       await findButtonByText(page, 'Submit') || await findButton(page, 'Save');
    if (confirmBtn) {
        console.log(`   🖱️  点击确认按钮 "${confirmBtn.text || '?'}" (${confirmBtn.x}, ${confirmBtn.y})`);
        await page.mouse.click(confirmBtn.x, confirmBtn.y);
    } else {
        // 调试
        const debugBtns = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button'))
                .filter(b => b.offsetParent !== null)
                .map(b => ({ text: (b.textContent || '').trim().slice(0, 50) }));
        });
        console.log(`   ⚠️  未找到确认按钮，可见按钮: ${JSON.stringify(debugBtns)}`);
        console.log('   ⚠️  按 Enter 尝试...');
        await page.keyboard.press('Enter');
    }
    await sleep(20000);
}

/**
 * 保存 wallet address 到 adsterra_account.usdt_address
 */
async function saveWalletAddress(email, walletAddress) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        const [result] = await connection.execute(
            'UPDATE adsterra_account SET usdt_address = ? WHERE account = ?',
            [walletAddress, email]
        );
        console.log(`   💾 adsterra_account.usdt_address 更新: ${result.affectedRows} 行`);
    } catch (err) {
        console.error('   ❌ 保存失败:', err.message);
    } finally {
        await connection.end();
    }
}