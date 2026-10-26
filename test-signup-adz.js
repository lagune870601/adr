/**
 * test-signup-adz.js — signup_adz.js 端到端 / dry-run 测试
 *
 * 两种模式：
 *   node test-signup-adz.js --dry-run   # 真实浏览器填表但不提交，断言表单值（无副作用，可反复跑）
 *   node test-signup-adz.js             # 全量真实注册，断言跳转成功 + adz_account 落库
 *
 * 可选：
 *   --clean      # E2E 前先删除该测试邮箱在 adz_account 的行，保证可重复运行
 *   --headed     # 有头模式
 *   --email=xx   # 指定测试邮箱（默认 test<随机>@warlus.asso.st）
 *
 * 需要联网 + 代理 + CloakBrowser 运行环境（Docker）。
 */

import mysql from 'mysql2/promise';
import { signupAdzCrawler } from './signup_adz.js';
import { createProxy } from './shared/proxy-utils.js';
import { DB_CONFIG } from './shared/db.js';

const DOMAIN = 'warlus.asso.st';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const clean = args.includes('--clean');
const headed = args.includes('--headed');
const emailArg = args.find(a => a.startsWith('--email='));
const email = emailArg ? emailArg.slice('--email='.length) : `test${Math.random().toString(36).slice(2, 8)}@${DOMAIN}`;
const username = 'Test User';

async function deleteAccount(account) {
    const conn = await mysql.createConnection(DB_CONFIG);
    try {
        const [r] = await conn.execute('DELETE FROM adz_account WHERE account = ?', [account]);
        console.log(`🧹 已清理 ${r.affectedRows} 行: account=${account}`);
    } finally {
        await conn.end();
    }
}

async function getAccount(account) {
    const conn = await mysql.createConnection(DB_CONFIG);
    try {
        const [rows] = await conn.execute('SELECT account, status, create_time, cookie, smart_link, login_ip FROM adz_account WHERE account = ?', [account]);
        return rows[0] || null;
    } finally {
        await conn.end();
    }
}

async function main() {
    console.log(`🧪 signup_adz ${dryRun ? 'DRY-RUN' : 'E2E'} 测试`);
    console.log(`👤 用户名: ${username}`);
    console.log(`📧 测试邮箱: ${email}\n`);

    const results = [];
    const check = (name, ok, detail = '') => results.push({ name, ok, detail });

    let manager;
    try {
        if (clean && !dryRun) await deleteAccount(email);

        const { proxy, manager: m } = await createProxy({ country: 'US', protocol: 'http' });
        manager = m;
        console.log(`📡 代理: ${proxy.host}:${proxy.port}\n`);

        const task = { id: 9999, username, email, task_type: 'REGISTER_ADZ' };
        const result = await signupAdzCrawler(task, proxy, null, { dryRun, headed });

        if (dryRun) {
            for (const c of result.checks || []) check(`[dry] ${c.name}`, c.ok, c.detail);
            check('dry-run result.success', result.success === true);
        } else {
            check('注册 result.success === true', result.success === true, result.error || '');
            if (result.success) {
                const row = await getAccount(email);
                check('adz_account 存在该账号记录', !!row);
                if (row) {
                    check('status == SIGN_UP_SUCCESS', row.status === 'SIGN_UP_SUCCESS', `得到 "${row.status}"`);
                    let cookieArr = null;
                    try { cookieArr = JSON.parse(row.cookie); } catch { /* ignore */ }
                    check('cookie 为合法 JSON 数组', Array.isArray(cookieArr), `type=${typeof row.cookie}`);
                    check('cookie 非空', Array.isArray(cookieArr) && cookieArr.length > 0, `len=${cookieArr?.length ?? 0}`);
                    check('smart_link 非空且形如 URL', /^https?:\/\//.test(row.smart_link || ''), `得到 "${row.smart_link}"`);
                    check('login_ip 非空', !!row.login_ip, `得到 "${row.login_ip}"`);
                }
            }
        }
    } catch (e) {
        check('测试执行无异常', false, e.message.slice(0, 120));
    } finally {
        if (manager) manager.destroy();
    }

    console.log('\n========================================');
    console.log('📋 测试结果汇总:');
    let allPass = true;
    for (const r of results) {
        if (!r.ok) allPass = false;
        console.log(`   ${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    }
    console.log('========================================');
    console.log(allPass ? '🎉 测试全部通过' : '💥 测试存在失败项');
    process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
    console.error('❌ 测试脚本异常:', e);
    process.exit(1);
});