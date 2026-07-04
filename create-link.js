import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';
import { openAccountPage } from './shared/open-account-utils.js';
import { handleCookieDialog } from './shared/crawler-utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const LINKS_URL = 'https://beta.publishers.adsterra.com/links';

/**
 * CREATE_LINK 爬虫
 *
 * 为 Adsterra Publisher 账号创建 Smartlink，直到总数达到 10 个。
 * 步骤：
 *   1. 调用 openAccountPage 打开 websites 页面
 *   2. 跳转到 links 页面，处理 Cookie 弹窗
 *   3. 读取分页中的总数，若 < 10 则循环创建
 *   4. 点击 "Add Smartlink" → 弹窗中点击 "Add" → 等 10s → 刷新页面
 *   5. 达到 10 个或重试耗尽后，获取每个 link 的名称和值
 *   6. 保存到 adsterra_link 表（跳过重复）
 *
 * @param {object} task - { id, username, email, ... }
 * @param {object} proxy - { host, port, username, password }
 * @param {Array<object>} cookies - Puppeteer setCookie 格式的 cookie 数组
 * @returns {Promise<{success: boolean, retryable: boolean, error: string|null}>}
 */
export async function createLinkCrawler(task, proxy, cookies) {
    console.log(`🚀 CREATE_LINK 爬虫: ${task.email}`);
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

        // 2. 打开账号页面
        console.log('\n📦 步骤 1: 打开账号页面...');
        const page = await openAccountPage(browser, proxy, cookies);

        // 3. 跳转到 links 页面
        console.log(`\n🌐 步骤 2: 跳转到 links 页面...`);
        await page.goto(LINKS_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(3000);

        // 处理 Cookie 弹窗
        await handleCookieDialog(page, 10);
        await sleep(3000);

        // 等待 DataGrid 加载
        console.log('   ⏳ 等待 Smartlink 列表加载...');
        await waitForDataGrid(page);

        const currentUrl = page.url();
        console.log(`   📍 当前 URL: ${currentUrl}`);
        if (currentUrl.includes('login')) {
            await browser.close();
            return { success: false, retryable: true, error: 'Cookies 已过期，被重定向到登录页' };
        }

        // 4. 循环创建 link，直到总数 >= 10 或重试耗尽
        console.log('\n🔁 步骤 3: 循环创建 Smartlink...');
        const MAX_CREATE_RETRIES = 10;
        let totalCount = await getTotalLinkCount(page);
        console.log(`   当前 link 总数: ${totalCount}`);

        let createAttempts = 0;
        while (totalCount < 10 && createAttempts < MAX_CREATE_RETRIES) {
            createAttempts++;
            console.log(`\n--- 创建第 ${createAttempts} 个 link (当前总数: ${totalCount}) ---`);

            // 点击 "Add Smartlink" 按钮
            const addBtn = await findButton(page, 'Add Smartlink');
            if (!addBtn) {
                console.error('   ❌ 未找到 Add Smartlink 按钮');
                break;
            }
            console.log(`   🖱️  点击 Add Smartlink (${addBtn.x}, ${addBtn.y})`);
            await page.mouse.click(addBtn.x, addBtn.y);
            await sleep(3000);

            // 等待弹窗出现，点击 "Add" 按钮
            const addModalBtn = await waitForModalButton(page, 'Add');
            if (!addModalBtn) {
                console.error('   ❌ 未找到弹窗中的 Add 按钮');
                break;
            }
            console.log(`   🖱️  点击弹窗 Add 按钮 (${addModalBtn.x}, ${addModalBtn.y})`);
            await page.mouse.click(addModalBtn.x, addModalBtn.y);

            // 等待 10 秒
            console.log('   ⏳ 等待 10 秒...');
            await sleep(10000);

            // 刷新页面
            console.log('   🔄 刷新页面...');
            await page.goto(LINKS_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
            await sleep(3000);
            await waitForDataGrid(page);
            await sleep(2000);

            // 重新读取总数
            totalCount = await getTotalLinkCount(page);
            console.log(`   当前 link 总数: ${totalCount}`);
        }

        if (totalCount < 10 && createAttempts >= MAX_CREATE_RETRIES) {
            console.log(`\n⚠️  重试耗尽 (${createAttempts}/${MAX_CREATE_RETRIES})，当前总数: ${totalCount}`);
        }

        // 5. 获取所有 link 的名称和值，保存到数据库
        console.log('\n📋 步骤 4: 获取 link 名称和值...');
        const savedCount = await captureAndSaveLinks(page, task.email);

        await browser.close();
        console.log(`\n✅ CREATE_LINK 爬虫完成！共保存 ${savedCount} 个 link`);
        return { success: true, retryable: false, error: null };

    } catch (e) {
        console.error('❌ 爬虫异常:', e.message);
        if (e.stack) console.error(e.stack);
        if (browser) await browser.close().catch(() => {});
        return { success: false, retryable: true, error: e.message };
    }
}

/**
 * 等待 DataGrid 加载完成
 */
async function waitForDataGrid(page) {
    for (let i = 0; i < 20; i++) {
        const hasData = await page.evaluate(() => {
            const rows = document.querySelectorAll('.MuiDataGrid-row, [role="row"][data-index]');
            return rows.length > 0;
        });
        if (hasData) {
            console.log(`   ✅ DataGrid 已加载 (${i * 500}ms)`);
            return;
        }
        await sleep(500);
    }
    console.log('   ⚠️  DataGrid 未在 10s 内加载');
}

/**
 * 从分页组件中读取 link 总数
 */
async function getTotalLinkCount(page) {
    // 先等待 DataGrid 有数据
    await waitForDataGrid(page);
    await sleep(2000);

    const count = await page.evaluate(() => {
        // 精确匹配 MUI TablePagination 的文本格式
        const paginationEls = document.querySelectorAll('.MuiTablePagination-displayedRows');
        for (const el of paginationEls) {
            const txt = (el.textContent || '').trim();
            // 格式: "1–10 of 25" 或 "1–1 of 1"
            const match = txt.match(/of\s+(\d+)/i);
            if (match) return parseInt(match[1]);
        }
        // 兜底
        const bodyText = (document.body?.innerText || '');
        const match = bodyText.match(/(\d+)[–\-]\d+\s+of\s+(\d+)/i);
        if (match) return parseInt(match[2]);
        return 0;
    });
    return count;
}

/**
 * 查找按钮并返回坐标
 */
async function findButton(page, buttonText) {
    return await page.evaluate((text) => {
        const lower = text.toLowerCase();
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            const btnText = (btn.textContent || '').trim().toLowerCase();
            if (btnText === lower && btn.offsetParent !== null) {
                const rect = btn.getBoundingClientRect();
                return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
            }
        }
        return null;
    }, buttonText);
}

/**
 * 等待弹窗中出现指定文本的按钮并返回坐标
 */
async function waitForModalButton(page, buttonText) {
    for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const btn = await page.evaluate((text) => {
            // 在弹窗中查找
            const dialogs = document.querySelectorAll('[role="dialog"]');
            for (const d of dialogs) {
                const dText = (d.textContent || '').trim();
                // 确认是 Add Smartlink 弹窗
                if (!dText.includes('Add new') && !dText.includes('Smartlink')) continue;

                const buttons = d.querySelectorAll('button');
                for (const btn of buttons) {
                    const btnText = (btn.textContent || '').trim();
                    if (btnText === text && !btn.disabled && btn.offsetParent !== null) {
                        const rect = btn.getBoundingClientRect();
                        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                    }
                }
            }
            return null;
        }, buttonText);
        if (btn) return btn;
        if (i % 4 === 3) {
            console.log(`   ⏳ 等待弹窗 Add 按钮... (${i + 1}s)`);
        }
    }
    return null;
}

/**
 * 遍历页面上的 link 行，获取每个 link 的名称和值，保存到数据库
 * 方案 A: 拦截剪贴板 → 点击 Copy link → 读取
 * 方案 B: 监控网络请求 → 获取 API 返回值
 * @returns {Promise<number>} 成功保存的 link 数量
 */
async function captureAndSaveLinks(page, email) {
    // 确保 DataGrid 已加载
    await waitForDataGrid(page);
    await sleep(2000);

    // 通过 API 获取 link 数据
    // Step 1: 获取所有 zone（link）
    console.log('   📡 获取 link 列表...');
    const zones = await page.evaluate(async () => {
        try {
            const resp = await fetch('/api/direct-link/zone');
            const json = await resp.json();
            return json?.data?.items || [];
        } catch (e) {
            return [];
        }
    });

    console.log(`   找到 ${zones.length} 个 zone`);

    if (zones.length === 0) {
        console.log('   ⚠️ 未找到任何 link');
        return 0;
    }

    // Step 2: 逐个获取每个 zone 的 placements（含 link URL 和名称）
    let savedCount = 0;
    for (let i = 0; i < zones.length; i++) {
        const zone = zones[i];
        const zoneId = zone.id;
        console.log(`\n   [${i + 1}/${zones.length}] zone_id=${zoneId}`);

        const placement = await page.evaluate(async (id) => {
            try {
                const resp = await fetch(`/api/direct-link/${id}/placements`);
                const json = await resp.json();
                return json?.data || [];
            } catch (e) {
                return [];
            }
        }, zoneId);

        if (placement.length === 0) {
            console.log('   ⚠️ 无 placement 数据');
            continue;
        }

        // 从 placement 中提取 link URL 和名称
        for (const p of placement) {
            const name = p.t_alias || zone.title || `Link_${zoneId}`;
            const codes = p.codes || [];
            for (const code of codes) {
                const linkUrl = code.code;
                if (linkUrl) {
                    console.log(`   🔗 ${name}: ${linkUrl.slice(0, 80)}...`);
                    const saved = await saveLinkToDb(email, name, linkUrl);
                    if (saved) savedCount++;
                }
            }
        }
    }

    return savedCount;
}

/**
 * 保存 link 到 adsterra_link 表（跳过重复的 link 值）
 * @returns {Promise<boolean>} 是否成功保存
 */
async function saveLinkToDb(email, name, linkUrl) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        // 检查是否已存在相同的 link 值
        const [existing] = await connection.execute(
            'SELECT id FROM adsterra_link WHERE link = ?',
            [linkUrl]
        );
        if (existing.length > 0) {
            console.log(`   ⏭️  跳过重复 link: ${linkUrl.slice(0, 50)}...`);
            return false;
        }

        await connection.execute(
            'INSERT INTO adsterra_link (link, name, account) VALUES (?, ?, ?)',
            [linkUrl, name, email]
        );
        console.log(`   💾 已保存: name=${name}, link=${linkUrl.slice(0, 50)}...`);
        return true;
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            console.log(`   ⏭️  重复条目，跳过`);
            return false;
        }
        console.error(`   ❌ 保存失败: ${err.message}`);
        return false;
    } finally {
        await connection.end();
    }
}