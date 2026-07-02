import { launch } from 'cloakbrowser/puppeteer';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const LOGIN_URL = 'https://beta.publishers.adsterra.com/login';
const PAYOUTS_URL = 'https://beta.publishers.adsterra.com/payouts';

/**
 * 从页面文本中提取 Scheduled payouts 信息
 */
function parsePayoutInfo(pageText) {
    const result = { amount: null, date: null };

    // 找金额: "$数字" 格式
    const amountMatch = pageText.match(/\$([\d.]+)/);
    if (amountMatch) {
        result.amount = parseFloat(amountMatch[1]);
    }

    // 找日期: "will become final on" 后面的日期
    const dateMatch = pageText.match(/will become final on (\w+\s+\d+)/i);
    if (dateMatch) {
        result.date = dateMatch[1];
        console.log(`   📅 Pending: $${result.amount}, final on ${result.date}`);
        return result;
    }

    // 兜底: 找 "Scheduled payouts" 区域的金额
    const scheduledMatch = pageText.match(/Scheduled payouts[\s\S]*?\$([\d.]+)/i);
    if (scheduledMatch) {
        result.amount = parseFloat(scheduledMatch[1]);
        console.log(`   📅 Scheduled amount: $${result.amount}`);
    }

    // 兜底: 找 "Payout date" 里的日期
    const payoutDateMatch = pageText.match(/Payout date[\s\S]*?(\w+\s+\d+)/i);
    if (payoutDateMatch) {
        result.date = payoutDateMatch[1];
        console.log(`   📅 Payout date: ${result.date}`);
    }

    return result;
}

/**
 * 更新 adsterra_account 的 next_pay_amount 和 next_pay_date
 */
async function updateAccountPayout(email, amount, dateStr) {
    const conn = await mysql.createConnection(DB_CONFIG);
    try {
        let nextPayDate = null;
        if (dateStr) {
            // 将 "Jun 30" 转为完整日期
            const now = new Date();
            const parsed = new Date(`${dateStr} ${now.getFullYear()} GMT`);
            // 如果解析出的日期已过但月份对不上，尝试下一年
            if (parsed < now && dateStr.includes('Jan') && now.getMonth() > 6) {
                nextPayDate = new Date(`${dateStr} ${now.getFullYear() + 1} GMT`);
            } else if (parsed < now) {
                // 可能月份已过但跨年了，直接存原始字符串让 MySQL 处理
                nextPayDate = dateStr;
            } else {
                nextPayDate = parsed;
            }
        }

        const updateFields = [];
        const params = [];
        if (amount !== null && amount !== undefined) {
            updateFields.push('next_pay_amount = ?');
            params.push(amount);
        }
        if (nextPayDate) {
            updateFields.push('next_pay_date = ?');
            params.push(nextPayDate instanceof Date ? nextPayDate : dateStr);
        }
        if (updateFields.length === 0) {
            console.log('   ⚠️ 无支付信息需要更新');
            return;
        }

        params.push(email);
        await conn.execute(
            `UPDATE adsterra_account SET ${updateFields.join(', ')} WHERE account = ?`,
            params
        );
        console.log(`   💾 已更新: ${email} — amount=${amount}, date=${nextPayDate || dateStr}`);
    } finally {
        await conn.end();
    }
}

/**
 * Payout 爬虫 — 从 main.js 调度器调用
 * @param {object} task - crawler_task 行
 * @param {object} proxy - { host, port, username, password }
 * @param {Array} cookies - Puppeteer 格式的 cookie 数组
 * @returns {{ success, retryable, error }}
 */
export async function payoutCrawler(task, proxy, cookies) {
    console.log(`🚀 Payout 爬虫: ${task.email || task.username}`);
    let browser;
    try {
        // 1. 启动浏览器
        browser = await launch({
            headless: true,
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
        const page = await browser.newPage();
        await page.authenticate({ username: proxy.username, password: proxy.password });
        await page.setViewport({ width: 1920, height: 1080 });

        // 2. 访问 login 页面建立 domain
        console.log('   🌐 访问 login 页面...');
        await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await sleep(2000);

        // 3. 设置 cookies
        if (cookies?.length) {
            await page.setCookie(...cookies);
            console.log(`   🍪 已设置 ${cookies.length} 个 cookies`);
        }

        // 4. 访问 payouts 页面
        console.log('   🌐 访问 payouts 页面...');
        await page.goto(PAYOUTS_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await sleep(3000);

        const url = page.url();
        console.log(`   URL: ${url}`);

        if (url.includes('login')) {
            await browser.close();
            return { success: false, retryable: true, error: '需要登录，cookies 可能已过期' };
        }

        // 5. 提取页面文本
        const pageText = await page.evaluate(() => document.body?.innerText || '');
        await browser.close();

        // 6. 解析支付信息
        const payoutInfo = parsePayoutInfo(pageText);
        if (payoutInfo.amount === null && payoutInfo.date === null) {
            // 可能页面没有 pending payment
            console.log('   ℹ️ 没有 pending payout 信息');
            return { success: true, retryable: false, error: null };
        }

        // 7. 更新数据库
        const email = task.email || task.username;
        await updateAccountPayout(email, payoutInfo.amount, payoutInfo.date);

        return { success: true, retryable: false, error: null };

    } catch (e) {
        if (browser) await browser.close().catch(() => {});
        console.error(`   ❌ ${e.message}`);
        return { success: false, retryable: true, error: e.message };
    }
}