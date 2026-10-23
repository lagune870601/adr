/**
 * test-form.js — 验证表单处理逻辑（真实页面，确定性测试）
 *
 * 直接访问已知会弹出"Prove you are not a robot"表单的真实页面。
 * 该页面的表单是概率性出现的，且有"有按钮/无按钮"两种变体，
 * 因此会重试多次直到捕获表单，再断言:
 *   detectForm 检测到 → checkbox 勾选 → （必要时）Continue 点击 → 倒计时/跳转启动
 *
 * 用法: node test-form.js
 */

import { launch } from 'cloakbrowser/puppeteer';
import { detectForm, handleForm } from './redirect-visitor.js';

const FORM_URL = 'https://marth.qualoportabl.com/click?key=f82dd54ee774e4650a74&subid=popzone129520';
const PROXY = 'socks5://chenchao:chenchao@104.233.202.50:17891';
const MAX_ATTEMPTS = 6;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const browser = await launch({
    headless: true,
    proxy: PROXY,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

try {
    let handled = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !handled; attempt++) {
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();
        await page.authenticate({ username: 'chenchao', password: 'chenchao' });

        console.log(`\n🌐 尝试 ${attempt}: 访问表单页`);
        await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

        let detected = false;
        for (let i = 0; i < 12 && !detected; i++) {
            detected = await detectForm(page);
            if (!detected) await sleep(1000);
        }
        console.log(`   表单出现: ${detected}`);

        if (detected) {
            const before = page.url();
            const hasBtn = !!(await page.$('#goBtn').catch(() => null));
            console.log(`   变体: ${hasBtn ? 'B（有 Continue 按钮）' : 'A（无按钮）'}`);

            const r = await handleForm(page);
            check('detectForm 检测到表单', true);
            check('checkbox 勾选成功', r.checked, `checked=${r.checked}`);
            if (hasBtn) check('Continue 点击成功', r.continued, `continued=${r.continued}`);
            check('倒计时/跳转已启动', r.redirected, `redirected=${r.redirected}`);

            // 轮询等待真实跳转（倒计时结束后才跳转，可能需数秒）
            let after = before;
            for (let w = 0; w < 15 && after === before; w++) {
                await sleep(1000);
                after = page.url();
            }
            const cdText = await page.evaluate(() => document.querySelector('#countdown')?.textContent || '').catch(() => '');
            console.log('   countdown 文案:', JSON.stringify(cdText));
            check('页面发生跳转', after !== before, `${before.slice(0, 55)} → ${after.slice(0, 55)}`);
            console.log('   最终 URL:', after.slice(0, 110));
            handled = true;
        } else {
            check(`第 ${attempt} 次尝试捕获表单`, false, '本次未出现表单');
        }
        await ctx.close().catch(() => {});
    }

    if (!handled) check('捕获到表单（任意一次尝试）', false, `${MAX_ATTEMPTS} 次均未出现`);
} catch (e) {
    check('测试执行无异常', false, e.message.slice(0, 80));
} finally {
    await browser.close().catch(() => {});
}

console.log('\n========================================');
console.log('📋 表单测试结果:');
let allPass = true;
for (const r of results) {
    if (!r.ok) allPass = false;
    console.log(`   ${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
}
console.log('========================================');
console.log(allPass ? '🎉 表单测试通过' : '💥 表单测试失败');
process.exit(allPass ? 0 : 1);