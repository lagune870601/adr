import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';
import { openAccountPage } from './shared/open-account-utils.js';
import { handleCookieDialog } from './shared/crawler-utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const API_SETTINGS_URL = 'https://beta.publishers.adsterra.com/settings?tab=API';

/**
 * CREATE_API_TOKEN 爬虫
 *
 * 为已有的 Adsterra Publisher 账号创建 API Token。
 * 步骤：
 *   1. 调用 openAccountPage 打开 websites 页面（cookies 登录态）
 *   2. 跳转到 settings API 页面
 *   3. 点击 "Generate API token" 按钮 → 弹出弹窗
 *   4. 点击弹窗上的 "Generate" 按钮
 *   5. 等待约 20s → 弹窗变为 "API token generated"
 *   6. 获取 input#text-field- 的 value（即 API Token）
 *   7. 保存到 adsterra_account.api_key 和 crawler_task.result
 *   8. 更新 crawler_task.task_status = 'completed'
 *
 * @param {object} task - crawler_task 表记录 { id, username, email, ... }
 * @param {object} proxy - { host, port, username, password }
 * @param {Array<object>} cookies - Puppeteer setCookie 格式的 cookie 数组
 * @returns {Promise<{success: boolean, retryable: boolean, error: string|null, apiToken: string|null}>}
 */
export async function createApiTokenCrawler(task, proxy, cookies) {
    console.log(`🚀 CREATE_API_TOKEN 爬虫: ${task.email}`);
    console.log(`   任务 ID: ${task.id}`);

    let browser;
    try {
        // 1. 启动浏览器
        const platform = os.platform();
        console.log(`🖥️  平台: ${platform} (${isLinux ? '无头模式' : '窗口模式'})`);
        console.log(`   📡 代理: ${proxy.host}:${proxy.port}`);

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

        // 2. 打开账号页面（cookies 登录态，无需 CF 处理）
        console.log('\n📦 步骤 1: 打开账号页面...');
        const page = await openAccountPage(browser, proxy, cookies);

        // 3. 跳转到 API 设置页面
        console.log(`\n🌐 步骤 2: 跳转到 API 设置页面...`);
        try {
            await page.goto(API_SETTINGS_URL, {
                waitUntil: 'load',
                timeout: 60000
            });
        } catch (e) {
            console.log('   ⚠️  页面加载超时，检查当前状态...');
        }
        await sleep(20000);

        const currentUrl = page.url();
        console.log(`   📍 当前 URL: ${currentUrl}`);

        // 检查是否被重定向到登录页
        if (currentUrl.includes('login')) {
            await browser.close();
            return {
                success: false,
                retryable: true,
                error: 'Cookies 已过期，被重定向到登录页',
                apiToken: null
            };
        }

        // 4. 处理可能出现的 Cookie 弹窗（会阻挡按钮点击）
        console.log('\n🍪 步骤 3: 处理 Cookie 弹窗...');
        await handleCookieDialog(page, 10);
        await sleep(1000);

        // 5. 点击 "Generate API token" 按钮（使用 Puppeteer 原生点击以触发 React 事件）
        console.log('\n🔍 步骤 4: 查找并点击 "Generate API token" 按钮...');

        // 先找到按钮的坐标
        const genBtnInfo = await page.evaluate(() => {
            const allElements = document.querySelectorAll('button, a, [role="button"]');
            for (const el of allElements) {
                const text = (el.textContent || '').trim();
                if (text.toLowerCase().includes('generate api token') ||
                    text.toLowerCase().includes('generate api')) {
                    if (el.offsetParent !== null) {
                        const rect = el.getBoundingClientRect();
                        return {
                            found: true,
                            text,
                            tag: el.tagName,
                            className: el.className?.slice(0, 100),
                            x: Math.round(rect.x + rect.width / 2),
                            y: Math.round(rect.y + rect.height / 2),
                        };
                    }
                }
            }
            return { found: false };
        });

        console.log(`   按钮信息: ${JSON.stringify(genBtnInfo)}`);

        if (!genBtnInfo.found) {
            const debugInfo = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
                    text: (b.textContent || '').trim().slice(0, 80),
                    className: b.className?.slice(0, 80),
                    visible: b.offsetParent !== null,
                }));
                return { buttons, bodyText: (document.body?.innerText || '').slice(0, 500) };
            });
            console.log('   🔍 页面调试信息:');
            console.log(`   Buttons: ${JSON.stringify(debugInfo.buttons)}`);
            console.log(`   Body preview: ${debugInfo.bodyText.slice(0, 300)}`);

            await browser.close();
            return {
                success: false,
                retryable: false,
                error: '未找到 "Generate API token" 按钮',
                apiToken: null
            };
        }

        // 使用 Puppeteer 原生点击
        await page.mouse.click(genBtnInfo.x, genBtnInfo.y);
        console.log('   ✅ 已点击按钮');

        // 6. 等待弹窗出现，然后点击弹窗上的 "Generate" 按钮
        console.log('\n🔍 步骤 5: 等待弹窗出现...');

        // 等待弹窗标题出现（"Generate API token" 文本出现在 dialog 中）
        let dialogAppeared = false;
        try {
            await page.waitForFunction(() => {
                // 检查是否有标题为 "Generate API token" 的弹窗
                const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="Title"], [class*="heading"]');
                for (const h of headings) {
                    const text = (h.textContent || '').trim();
                    if (text === 'Generate API token') {
                        return true;
                    }
                }
                // 兜底：检查 body 中是否包含特定的弹窗文案组合
                const bodyText = document.body?.innerText || '';
                return bodyText.includes('Generate API token') &&
                       (bodyText.includes('Cancel') || bodyText.includes('Generate'));
            }, { timeout: 15000 });
            dialogAppeared = true;
        } catch (e) {
            console.log('   ⚠️  弹窗标题未在 15s 内出现');
        }

        // 截图调试
        if (!dialogAppeared) {
            await page.screenshot({ path: 'debug-api-dialog.png', fullPage: false });
            console.log('   📸 截图已保存: debug-api-dialog.png');
        } else {
            console.log('   ✅ 弹窗已出现');
        }

        // 点击弹窗中的 "Generate" 按钮
        console.log('   查找弹窗中的 "Generate" 按钮...');

        let modalGenerateClicked = null;
        for (let i = 0; i < 10; i++) {
            await sleep(1000);

            // 先查找按钮坐标，再用 Puppeteer 原生点击
            const generateBtnInModal = await page.evaluate(() => {
                // 搜索所有可见按钮，找文本为 "Generate" 的（排除 "Generate API token"）
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = (btn.textContent || '').trim();
                    if (text === 'Generate' && btn.offsetParent !== null) {
                        const rect = btn.getBoundingClientRect();
                        return {
                            found: true,
                            text,
                            x: Math.round(rect.x + rect.width / 2),
                            y: Math.round(rect.y + rect.height / 2),
                            className: btn.className?.slice(0, 100),
                        };
                    }
                }
                return { found: false };
            });

            if (generateBtnInModal.found) {
                console.log(`   找到按钮: ${JSON.stringify(generateBtnInModal)} (${i + 1}s)`);
                await page.mouse.click(generateBtnInModal.x, generateBtnInModal.y);
                modalGenerateClicked = { clicked: true, ...generateBtnInModal };
                break;
            }

            if (i % 3 === 0 && i > 0) {
                console.log(`   ⏳ 等待 Generate 按钮... (${i + 1}s)`);
            }
        }

        if (!modalGenerateClicked || !modalGenerateClicked.clicked) {
            // 截图保存当前状态
            await page.screenshot({ path: 'debug-api-modal-failed.png', fullPage: false });
            console.log('   📸 截图已保存: debug-api-modal-failed.png');

            // 输出调试信息
            const modalDebug = await page.evaluate(() => {
                const allButtons = Array.from(document.querySelectorAll('button')).map(b => ({
                    text: (b.textContent || '').trim().slice(0, 50),
                    visible: b.offsetParent !== null,
                }));
                const bodyText = (document.body?.innerText || '').slice(0, 500);
                return { allButtons, bodyText };
            });
            console.log('   🔍 弹窗调试信息:');
            console.log(`   Buttons: ${JSON.stringify(modalDebug.allButtons)}`);
            console.log(`   Body preview: ${modalDebug.bodyText.slice(0, 300)}`);

            await browser.close();
            return {
                success: false,
                retryable: false,
                error: '未找到弹窗中的 "Generate" 按钮',
                apiToken: null
            };
        }

        // 6. 等待 ~20 秒，弹窗变为 "API token generated"
        console.log('\n⏳ 步骤 6: 等待 API token 生成 (~20s)...');
        let apiToken = null;
        const maxWaitSec = 60; // 最多等 60 秒
        for (let i = 0; i < Math.ceil(maxWaitSec / 2); i++) {
            await sleep(2000);

            const checkResult = await page.evaluate(() => {
                // 检查弹窗标题是否变为 "API token generated"
                const allText = document.body?.innerText || '';

                // 查找 input#text-field- 的值
                const input = document.querySelector('input[id="text-field-"]');
                const tokenValue = input?.value || '';

                // 检查弹窗中是否包含 "API token generated" 文案
                const hasGeneratedText =
                    allText.includes('API token generated') ||
                    allText.includes('token generated') ||
                    allText.includes('Token generated');

                return {
                    hasGeneratedText,
                    tokenValue,
                    hasInput: !!input,
                    inputId: input?.id || null,
                };
            });

            console.log(`   [${(i + 1) * 2}s] generatedText=${checkResult.hasGeneratedText}, hasInput=${checkResult.hasInput}, tokenLen=${checkResult.tokenValue.length}`);

            if (checkResult.tokenValue) {
                apiToken = checkResult.tokenValue;
                console.log(`   ✅ API Token 已获取: ${apiToken.slice(0, 10)}...${apiToken.slice(-4)}`);
                break;
            }

            if (checkResult.hasGeneratedText && !checkResult.tokenValue) {
                console.log('   ⚠️  弹窗显示生成完成，但 token 尚未出现，继续等待...');
            }
        }

        if (!apiToken) {
            // 最后一次尝试获取
            const lastCheck = await page.evaluate(() => {
                const input = document.querySelector('input[id="text-field-"]');
                return { tokenValue: input?.value || '', inputId: input?.id || null };
            });
            console.log(`   最后一次检查: token=${lastCheck.tokenValue ? lastCheck.tokenValue.slice(0, 10) + '...' : '无'}, inputId=${lastCheck.inputId}`);

            if (lastCheck.tokenValue) {
                apiToken = lastCheck.tokenValue;
            }
        }

        await browser.close();

        if (!apiToken) {
            console.error('   ❌ 未能获取到 API Token');
            return {
                success: false,
                retryable: true,
                error: '等待超时，未能获取到 API Token',
                apiToken: null
            };
        }

        // 7. 保存到数据库
        console.log('\n💾 步骤 7: 保存 API Token 到数据库...');
        await saveApiToken(task.email, task.id, apiToken);

        console.log('\n✅ CREATE_API_TOKEN 爬虫完成！');
        return {
            success: true,
            retryable: false,
            error: null,
            apiToken: apiToken
        };

    } catch (e) {
        console.error('❌ 爬虫异常:', e.message);
        if (e.stack) console.error(e.stack);

        if (browser) {
            await browser.close().catch(() => {});
        }

        return {
            success: false,
            retryable: true,
            error: e.message,
            apiToken: null
        };
    }
}

/**
 * 保存 API Token 到 adsterra_account 和 crawler_task 表
 * @param {string} email - 账号邮箱
 * @param {number} taskId - crawler_task 的 id
 * @param {string} apiToken - API Token 值
 */
async function saveApiToken(email, taskId, apiToken) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        // 更新 adsterra_account 表的 api_key 字段
        const [accountResult] = await connection.execute(
            'UPDATE adsterra_account SET api_key = ? WHERE account = ?',
            [apiToken, email]
        );
        console.log(`   💾 adsterra_account 更新: ${accountResult.affectedRows} 行 (account=${email})`);

        // 更新 crawler_task 表的 result 字段
        const [taskResult] = await connection.execute(
            'UPDATE crawler_task SET result = ? WHERE id = ?',
            [apiToken, taskId]
        );
        console.log(`   💾 crawler_task.result 更新: ${taskResult.affectedRows} 行 (task_id=${taskId})`);

        console.log('   ✅ 数据库保存完成');
    } catch (err) {
        console.error('   ❌ 数据库保存失败:', err.message);
        throw err;
    } finally {
        await connection.end();
    }
}