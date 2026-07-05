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
 * UPDATE_USDT_ADDRESS 爬虫
 *
 * 修改 Adsterra Publisher 账号的 USDT 钱包地址。
 * 步骤：
 *   1. 打开账号页面
 *   2. 跳转到 payout-information 页面
 *   3. 点击 Edit 进入编辑模式
 *   4. 只修改 wallet 地址字段
 *   5. 点击 SAVE CHANGES → 验证码 → yopmail 获取 → 填入 → 确认
 *   6. 保存 wallet address 到 adsterra_account.usdt_address
 *
 * @param {object} task - { id, email, payment_address, ... }
 * @param {object} proxy - { host, port, username, password }
 * @param {Array<object>} cookies - Puppeteer 格式的 cookie 数组
 * @returns {Promise<{success: boolean, retryable: boolean, error: string|null}>}
 */
export async function updateUsdtAddressCrawler(task, proxy, cookies) {
    console.log(`🚀 UPDATE_USDT_ADDRESS 爬虫: ${task.email}`);
    console.log(`   任务 ID: ${task.id}`);
    console.log(`   payment_address: ${task.payment_address}`);

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

        // 检查是否有 Your method 模块
        const payoutStatus = await page.evaluate(() => {
            const bodyText = document.body?.innerText || '';
            return { hasYourMethod: bodyText.includes('Your method') };
        });

        if (!payoutStatus.hasYourMethod) {
            await browser.close();
            return { success: false, retryable: false, error: '该账号未设置支付方式，无法修改 USDT 地址' };
        }

        // 3. 点击 Edit 按钮
        console.log('\n🔍 步骤 3: 点击 Edit 按钮...');
        const editClicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            const editBtns = [];
            for (const btn of buttons) {
                if ((btn.textContent || '').trim().toLowerCase() === 'edit' && btn.offsetParent !== null) {
                    const rect = btn.getBoundingClientRect();
                    editBtns.push({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), bottom: rect.bottom, right: rect.right });
                }
            }
            if (editBtns.length > 0) {
                editBtns.sort((a, b) => (b.bottom + b.right) - (a.bottom + a.right));
                return { found: true, ...editBtns[0] };
            }
            return { found: false };
        });

        if (!editClicked.found) {
            await browser.close();
            return { success: false, retryable: false, error: '未找到 Edit 按钮' };
        }
        console.log(`   🖱️  点击 Edit (${editClicked.x}, ${editClicked.y})`);
        await page.mouse.click(editClicked.x, editClicked.y);
        await sleep(3000);

        // 4. 只修改 wallet 地址
        console.log('\n📝 步骤 4: 修改 wallet 地址...');
        console.log(`   📝 Wallet: ${task.payment_address}`);
        await fillWalletInput(page, task.payment_address);

        // 5. 点击 SAVE CHANGES 按钮
        console.log('\n🔘 步骤 5: 点击 SAVE CHANGES 按钮...');
        const saveBtn = await findButton(page, 'Save changes') || await findButton(page, 'Save') || await findButtonByText(page, 'Save');
        if (!saveBtn) {
            await browser.close();
            return { success: false, retryable: false, error: '未找到 SAVE 按钮' };
        }
        console.log(`   🖱️  点击 Save (${saveBtn.x}, ${saveBtn.y})`);
        await page.mouse.click(saveBtn.x, saveBtn.y);
        await sleep(5000);

        // 6. 处理验证码
        console.log('\n🔐 步骤 6: 处理验证码...');
        const code = await getVerificationCode(browser, task);
        if (!code) {
            await browser.close();
            return { success: false, retryable: true, error: '未能获取验证码' };
        }

        await enterVerificationCode(page, code);
        console.log('   ✅ 验证码已提交');

        // 等待 30 秒，让页面处理验证
        console.log('   ⏳ 等待 30 秒...');
        await sleep(30000);

        // 检查是否已保存成功
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
            const saveBtn2 = await findButton(page, 'Save changes') || await findButton(page, 'Save') || await findButtonByText(page, 'Save');
            if (saveBtn2) {
                console.log(`   🖱️  再次点击 Save (${saveBtn2.x}, ${saveBtn2.y})`);
                await page.mouse.click(saveBtn2.x, saveBtn2.y);
                await sleep(5000);
            }
        }

        // 等待 30 秒确认保存
        console.log('   ⏳ 等待 30 秒确认保存...');
        await sleep(30000);

        // 7. 保存 wallet address 到数据库
        console.log('\n💾 步骤 7: 保存 wallet address 到数据库...');
        await saveWalletAddress(task.email, task.payment_address);

        await browser.close();
        console.log('\n✅ UPDATE_USDT_ADDRESS 爬虫完成！');
        return { success: true, retryable: false, error: null };

    } catch (e) {
        console.error('❌ 爬虫异常:', e.message);
        if (e.stack) console.error(e.stack);
        if (browser) await browser.close().catch(() => {});
        return { success: false, retryable: true, error: e.message };
    }
}

// ==================== 工具函数 ====================

async function fillWalletInput(page, value) {
    return await page.evaluate((val) => {
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

        console.log('   ✉️ 查找验证码邮件...');
        const emailClicked = await yopmailPage.evaluate(() => {
            const iframe = document.getElementById('ifinbox');
            if (!iframe) return { found: false, error: 'ifinbox not found' };
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc) return { found: false, error: 'doc not accessible' };
                const items = doc.querySelectorAll('.m, .msg, .lm, [class*="message" i], div[onclick]');
                const priorityKeywords = ['verification', 'security code', 'payout', 'confirm'];
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

async function enterVerificationCode(page, code) {
    console.log(`   🔢 输入验证码: ${code}`);

    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(1000);

    const filled = await page.evaluate((code) => {
        const allInputs = document.querySelectorAll('input[type="text"], input:not([type="hidden"])');
        const visibleInputs = Array.from(allInputs).filter(i => i.offsetParent !== null);

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
                return { found: true, method: 'keyword' };
            }
        }
        if (visibleInputs.length > 0) {
            const lastInp = visibleInputs[visibleInputs.length - 1];
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeSetter.call(lastInp, code);
            lastInp.dispatchEvent(new Event('input', { bubbles: true }));
            lastInp.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, method: 'last' };
        }
        return { found: false };
    }, code);

    console.log(`   输入结果: ${JSON.stringify(filled)}`);
    if (filled.found) console.log('   ✅ 验证码已填入');

    await sleep(1000);

    const confirmBtn = await findButtonByText(page, 'Save changes') || await findButton(page, 'Save changes') ||
                       await findButtonByText(page, 'Confirm');
    if (confirmBtn) {
        console.log(`   🖱️  点击确认按钮 (${confirmBtn.x}, ${confirmBtn.y})`);
        await page.mouse.click(confirmBtn.x, confirmBtn.y);
    } else {
        console.log('   ⚠️ 未找到确认按钮，按 Enter...');
        await page.keyboard.press('Enter');
    }
    await sleep(20000);
}

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