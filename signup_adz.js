/**
 * signup_adz.js — Adz2You (adz2you.xyz) 注册爬虫
 *
 * 框架与 signup.js 一致：CloakBrowser + 代理 + stealth 补丁 + 外层重试。
 * 步骤（与 adsterra 不同之处）：
 *   1. 访问 https://adz2you.xyz/
 *   2. 点击右上角 Sign Up → 跳转 https://adz2you.xyz/signup.php
 *   3. 填表：username(由 task.username 生成)、email(task.email)、
 *      Social Contact(随机)、社交账号(按类型生成)、password/repeat=123456789_Chen
 *   4. 点击 Submit
 *   5. 成功后抓 cookies 写入 adz_account 表（status=SIGN_UP_SUCCESS）
 *
 * 纯逻辑（Social/登录名生成、结果分类）在 shared/adz-utils.js，本文件 re-export。
 *
 * 入口：由 main.js 的 CRAWLER_DISPATCH['REGISTER_ADZ'] 调度。
 * 也可独立运行（手动/dry-run）：
 *   node signup_adz.js --dry-run                 # 只填表不提交，断言表单值
 *   node signup_adz.js --dry-run --headed        # 有头模式查看
 *   node signup_adz.js --dry-run --no-proxy      # 不走代理
 *   node signup_adz.js --email=xxx@warlus.asso.st --username="John Doe"   # 全量真实注册
 */

import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';
import { createProxy } from './shared/proxy-utils.js';
import {
    SOCIAL_TYPES,
    PASSWORD,
    pickSocialType,
    generateSocialHandle,
    socialHandleMatches,
    generateLoginName,
    classifySignupPage,
    normalizeCurrentIp,
    normalizeSmartLink,
} from './shared/adz-utils.js';

// re-export 纯函数，保持 signup_adz.js 的对外 API
export * from './shared/adz-utils.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== 配置常量 ====================

const HOME_URL = 'https://adz2you.xyz/';
const SIGNUP_URL = 'https://adz2you.xyz/signup.php';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const MAX_RETRIES = 5;
const SUBMIT_RESULT_WAIT_MS = 90000;
const ACCOUNT_INFO_WAIT_MS = 15000;

// ==================== Cloudflare / 反检测补丁（同 signup.js）====================

async function applyStealthPatches(page) {
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                { name: 'Native Client', filename: 'internal-nacl-plugin' },
            ],
        });
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: { isInstalled: false } };
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        if (typeof navigator.permissions !== 'undefined') {
            const originalQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (params) => {
                if (params.name === 'notifications') return Promise.resolve({ state: 'denied' });
                return originalQuery(params);
            };
        }
        const getParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParam.call(this, param);
        };
    });
}

// ==================== 页面操作 ====================

async function shot(page, file) {
    try { await page.screenshot({ path: file, fullPage: true }); console.log(`📸 ${file}`); } catch { /* ignore */ }
}

/** 填入单个文本输入框并回读校验 */
async function setInput(page, sel, value, label) {
    const el = await page.$(sel);
    if (!el) { console.log(`   ⚠️ 未找到${label} (${sel})`); return false; }
    await el.click({ clickCount: 3 }).catch(() => {});
    await el.type(value, { delay: 40 });
    const v = await page.$eval(sel, e => e.value).catch(() => null);
    console.log(`   ✅ ${label}: "${v}"${v === value ? ' ✔' : ' ✗'}`);
    return v === value;
}

/**
 * 填写注册表单并回读全部字段值。
 * @returns 回读结果对象（供 dry-run 断言）
 */
async function fillSignupForm(page, task, plan) {
    const { loginName, socialType, socialHandle } = plan;

    await setInput(page, '#username', loginName, '用户名');
    await setInput(page, '#email', task.email, '邮箱');

    // Social Contact（原生 select）
    await page.select('#social_type', socialType).catch(() => null);
    console.log(`   ✅ Social Contact: ${socialType}`);
    await sleep(300);

    await setInput(page, '#social_handle', socialHandle, '社交账号');
    await setInput(page, '#password', PASSWORD, '密码');
    await setInput(page, '#repeat-password', PASSWORD, '确认密码');

    // 同意条款（默认已勾选，兜底确保勾上）
    await page.evaluate(() => {
        const el = document.querySelector('#remember-me');
        if (el && !el.checked) el.click();
    });

    return await page.evaluate(() => ({
        username: document.querySelector('#username')?.value ?? null,
        email: document.querySelector('#email')?.value ?? null,
        socialType: document.querySelector('#social_type')?.value ?? null,
        socialHandle: document.querySelector('#social_handle')?.value ?? null,
        password: document.querySelector('#password')?.value ?? null,
        repeatPassword: document.querySelector('#repeat-password')?.value ?? null,
        termsChecked: !!document.querySelector('#remember-me')?.checked,
    }));
}

/** dry-run 断言：校验回读值是否符合预期 */
export function evaluateDryRun(filled, task, plan) {
    const checks = [];
    const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
    add('username == 生成的 loginName', filled.username === plan.loginName, `得到 "${filled.username}"，期望 "${plan.loginName}"`);
    add('email == task.email', filled.email === task.email, `得到 "${filled.email}"`);
    add('social_type 合法', SOCIAL_TYPES.includes(filled.socialType), `得到 "${filled.socialType}"`);
    add('social_type == 计划值', filled.socialType === plan.socialType, `得到 "${filled.socialType}"，期望 "${plan.socialType}"`);
    add('social_handle 符合命名规则', socialHandleMatches(filled.socialType, filled.socialHandle), `得到 "${filled.socialHandle}"`);
    add('password == 123456789_Chen', filled.password === PASSWORD, `得到 "${filled.password}"`);
    add('repeat-password == 123456789_Chen', filled.repeatPassword === PASSWORD, `得到 "${filled.repeatPassword}"`);
    add('terms 已勾选', filled.termsChecked === true);
    return checks;
}

function printDryRun(checks) {
    console.log('\n========================================');
    console.log('📋 dry-run 表单断言:');
    let allPass = true;
    for (const c of checks) {
        if (!c.ok) allPass = false;
        console.log(`   ${c.ok ? '✅ PASS' : '❌ FAIL'}  ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    }
    console.log('========================================');
    console.log(allPass ? '🎉 表单填充正确' : '💥 表单填充存在错误');
}

/** 点击 Submit 按钮 */
async function submitSignupForm(page) {
    return await page.evaluate(() => {
        const byName = document.querySelector('button[name="register"]');
        if (byName) { byName.click(); return true; }
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
            .find(b => /submit/i.test((b.textContent || '') + (b.value || '')));
        if (btn) { btn.click(); return true; }
        return false;
    });
}

/** 轮询等待注册结果 */
async function waitForResult(page, maxWaitMs) {
    const start = Date.now();
    let last = { url: page.url(), bodyText: '', title: '' };
    while (Date.now() - start < maxWaitMs) {
        await sleep(2000);
        last = await page.evaluate(() => ({
            url: location.href,
            bodyText: (document.body?.innerText || '').slice(0, 2000),
            title: document.title,
        })).catch(() => last);
        const verdict = classifySignupPage(last);
        if (verdict !== 'pending') return { verdict, info: last };
    }
    return { verdict: 'timeout', info: last };
}

async function captureCookies(page) {
    const cookies = await page.cookies();
    console.log(`   🍪 已获取 ${cookies.length} 条 cookies`);
    return JSON.stringify(cookies);
}

/** 从 account.php 抓取 Smart Link（#url_2）与 Current IP，最多等待 maxWaitMs */
async function extractAccountInfo(page, maxWaitMs) {
    const start = Date.now();
    let smartLink = '';
    let currentIp = '';
    while (Date.now() - start < maxWaitMs) {
        const info = await page.evaluate(() => {
            const link = document.querySelector('#url_2')?.value || '';
            let ip = '';
            for (const li of document.querySelectorAll('li')) {
                const b = li.querySelector('b');
                if (b && /current ip/i.test(b.textContent || '')) {
                    ip = (li.querySelector('p')?.textContent || '').trim();
                    break;
                }
            }
            return { link, ip };
        }).catch(() => ({ link: '', ip: '' }));
        smartLink = normalizeSmartLink(info.link);
        currentIp = normalizeCurrentIp(info.ip);
        if (smartLink && currentIp) break;
        await sleep(1000);
    }
    console.log(`   🔗 Smart Link: ${smartLink || '(未取到)'}`);
    console.log(`   🌐 Current IP: ${currentIp || '(未取到)'}`);
    return { smartLink, currentIp };
}

async function saveAdzAccount(email, { cookiesJson, smartLink, currentIp }) {
    const conn = await mysql.createConnection(DB_CONFIG);
    try {
        const nowBeijing = new Date(Date.now() + 8 * 60 * 60 * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');
        await conn.execute(
            'INSERT INTO adz_account (account, status, create_time, cookie, smart_link, login_ip) VALUES (?, ?, ?, ?, ?, ?)',
            [email, 'SIGN_UP_SUCCESS', nowBeijing, cookiesJson, smartLink, currentIp]
        );
        console.log(`   💾 已写入 adz_account: account=${email}, status=SIGN_UP_SUCCESS, smart_link=${smartLink || '-'}, login_ip=${currentIp || '-'}`);
    } finally {
        await conn.end();
    }
}

// ==================== 主流程 ====================

/**
 * @param {object} task   - 任务对象 { id, username, email, ... }
 * @param {object} proxy  - 代理对象 { host, port, username, password, url }
 * @param {object} [existingBrowser] - 可选，外部浏览器实例（AdsPower 等）
 * @param {object} [opts] - { dryRun, headed, keepOpen, noProxy }
 * @returns {Promise<{success, retryable?, error?, dryRun?, filled?, checks?}>}
 */
export async function signupAdzCrawler(task, proxy, existingBrowser = null, opts = {}) {
    const isExternalBrowser = !!existingBrowser;
    const { dryRun = false, headed = false, keepOpen = false, noProxy = false } = opts;
    const headless = headed ? false : isLinux;

    const plan = {
        loginName: generateLoginName(task.username),
        socialType: pickSocialType(),
        socialHandle: null,
    };
    plan.socialHandle = generateSocialHandle(plan.socialType);

    console.log(`🚀 启动${isExternalBrowser ? ' AdsPower' : ' CloakBrowser'} (Adz2You Sign Up 爬虫)...\n`);
    console.log(`👤 用户名: ${task.username} → ${plan.loginName}`);
    console.log(`📧 邮箱: ${task.email}`);
    console.log(`💬 Social Contact: ${plan.socialType} / ${plan.socialHandle}`);
    console.log(`🖥️  模式: ${headless ? '无头' : '有头'}${dryRun ? ' | DRY-RUN(不提交)' : ''}\n`);

    let submitted = false;

    for (let attempt = 0; attempt < MAX_RETRIES && !submitted; attempt++) {
        if (attempt > 0) console.log(`\n🔄 第 ${attempt + 1}/${MAX_RETRIES} 次重试...`);

        let browser = null;
        let failed = false;

        try {
            if (isExternalBrowser) {
                browser = existingBrowser;
            } else {
                browser = await launch({
                    headless,
                    proxy: noProxy ? undefined : proxy?.url,
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
                    ],
                });
            }

            const page = await browser.newPage();
            await applyStealthPatches(page);
            await page.setUserAgent(USER_AGENT);
            if (!noProxy && proxy) {
                await page.authenticate({ username: proxy.username, password: proxy.password });
                console.log('   ✅ 代理认证已设置');
            }
            page.setDefaultNavigationTimeout(60000);
            page.setDefaultTimeout(30000);
            await page.setViewport({ width: 1920, height: 1080 });

            // ---- 步骤 1: 访问首页 ----
            console.log('🌐 步骤 1: 访问首页 ...');
            try {
                await page.goto(HOME_URL, { waitUntil: 'load', timeout: 120000 });
            } catch {
                console.log('⚠️  首页加载超时，检查当前 URL...');
            }
            await sleep(3000);
            await shot(page, 'adz-step1-home.png');

            // ---- 步骤 2: 点击 Sign Up ----
            console.log('🔍 步骤 2: 点击右上角 Sign Up ...');
            const clicked = await page.evaluate(() => {
                const els = document.querySelectorAll('a, button');
                for (const el of els) {
                    const txt = (el.textContent || '').trim().toUpperCase();
                    const href = el.getAttribute('href') || '';
                    if (txt === 'SIGN UP' || txt === 'SIGNUP' || href.includes('signup.php')) {
                        el.click();
                        return true;
                    }
                }
                return false;
            });
            console.log(`   点击 Sign Up: ${clicked ? '✅' : '❌'}`);
            await sleep(3000);

            if (!page.url().includes('signup.php')) {
                console.log('   ↪️ 未跳转到 signup.php，直接访问注册页');
                await page.goto(SIGNUP_URL, { waitUntil: 'load', timeout: 120000 }).catch(() => {});
                await sleep(2000);
            }
            console.log(`   📄 当前 URL: ${page.url()}`);
            await shot(page, 'adz-step2-signup.png');

            // ---- 步骤 3: 填表 ----
            console.log('\n📝 步骤 3: 填写注册表单 ...');
            await page.waitForSelector('#username', { visible: true, timeout: 15000 }).catch(() => {});
            const filled = await fillSignupForm(page, task, plan);
            await shot(page, 'adz-step3-form-filled.png');

            if (dryRun) {
                const checks = evaluateDryRun(filled, task, plan);
                printDryRun(checks);
                return { success: checks.every(c => c.ok), dryRun: true, filled, checks };
            }

            // ---- 步骤 4: 提交 ----
            console.log('\n🔘 步骤 4: 提交表单 ...');
            const ok = await submitSignupForm(page);
            if (!ok) throw new Error('未找到 Submit 按钮');
            submitted = true;
            console.log('   ✅ 已点击 Submit');
            await sleep(3000);
            await shot(page, 'adz-step4-after-submit.png');

            // ---- 步骤 5: 判定结果并落库 ----
            console.log('\n⏳ 步骤 5: 确认注册结果 ...');
            const res = await waitForResult(page, SUBMIT_RESULT_WAIT_MS);
            console.log(`   判定: ${res.verdict} | URL: ${res.info.url}`);

            if (res.verdict === 'success') {
                const cookiesJson = await captureCookies(page);
                console.log('   🔎 抓取 account.php 信息（Smart Link / 当前 IP）...');
                const { smartLink, currentIp } = await extractAccountInfo(page, ACCOUNT_INFO_WAIT_MS);
                await saveAdzAccount(task.email, { cookiesJson, smartLink, currentIp });
                await shot(page, 'adz-step5-success.png');
                console.log('\n✅ Adz2You 注册完成！');
                return { success: true, smartLink, currentIp };
            }
            if (res.verdict === 'failed') {
                await shot(page, 'adz-step5-failed.png');
                return { success: false, retryable: false, error: '注册页报错（可能账号/邮箱已存在）' };
            }
            await shot(page, 'adz-step5-timeout.png');
            return { success: false, retryable: false, error: '未确认注册成功（超时）' };

        } catch (e) {
            console.error(`❌ 发生错误: ${e.message}`);

            if (!submitted && attempt < MAX_RETRIES - 1) {
                console.log('   🔄 将在下次循环中重试...\n');
                failed = false;  // 让 finally 关闭本次浏览器，下一轮重建
                continue;
            }

            failed = true;
            if (!submitted) {
                console.error('❌ 重试次数已用完');
                return { success: false, retryable: true, error: e.message };
            }
            console.error('❌ 提交后流程异常');
            return { success: false, retryable: false, error: e.message };
        } finally {
            if (browser && !isExternalBrowser && !(keepOpen && failed)) {
                await browser.close().catch(() => {});
            } else if (keepOpen && failed && browser && !isExternalBrowser) {
                console.log('   🔎 --keep-open: 保留浏览器窗口以供排查');
            }
        }
    }

    if (!submitted) {
        return { success: false, retryable: true, error: '重试耗尽，未能成功提交表单' };
    }
}

// ==================== 独立运行入口（手动 / dry-run）====================

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    const args = process.argv.slice(2);
    const opts = {
        dryRun: args.includes('--dry-run'),
        headed: args.includes('--headed'),
        keepOpen: args.includes('--keep-open'),
        noProxy: args.includes('--no-proxy'),
    };
    const emailArg = args.find(a => a.startsWith('--email='));
    const userArg = args.find(a => a.startsWith('--username='));
    const task = {
        id: 0,
        username: userArg ? userArg.slice('--username='.length) : 'Test User',
        email: emailArg
            ? emailArg.slice('--email='.length)
            : `test${Math.random().toString(36).slice(2, 8)}@warlus.asso.st`,
        task_type: 'REGISTER_ADZ',
    };

    (async () => {
        let proxy = null;
        let manager = null;
        try {
            if (!opts.noProxy) {
                const r = await createProxy({ country: 'US', protocol: 'http' });
                proxy = r.proxy;
                manager = r.manager;
                console.log(`📡 代理: ${proxy.host}:${proxy.port}\n`);
            }
            const result = await signupAdzCrawler(task, proxy, null, opts);
            console.log('\n📊 结果:', JSON.stringify(result));
            if (!result.success) process.exitCode = 1;
        } finally {
            if (manager) manager.destroy();
        }
    })().catch((e) => {
        console.error('💥 未捕获的错误:', e);
        process.exit(1);
    });
}