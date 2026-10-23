/**
 * test-redirect-visitor.js — redirect-visitor.js 端到端测试
 *
 * 真实联网 + 真实代理，跑 1 轮完整流程（停留缩短到 15 秒），
 * 解析主脚本输出并断言:
 *   1. 轮次正常结束
 *   2. 至少记录到 1 次重定向跳转
 *   3. 若出现验证表单，则 checkbox 勾选 与 Continue 点击都成功
 *
 * 用法: node test-redirect-visitor.js
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DWELL_SEC = 15;
const TIMEOUT_MS = 180000; // 3 分钟上限

async function main() {
    console.log('🧪 端到端测试开始：1 轮 / 停留 %d 秒 / 真实代理\n', DWELL_SEC);

    const child = spawn(
        process.execPath,
        ['redirect-visitor.js', '--rounds=1', `--dwell-sec=${DWELL_SEC}`],
        { cwd: __dirname }
    );

    let output = '';
    child.stdout.on('data', (d) => {
        const s = d.toString();
        output += s;
        process.stdout.write(s);
    });
    child.stderr.on('data', (d) => {
        const s = d.toString();
        output += s;
        process.stderr.write(s);
    });

    const timer = setTimeout(() => {
        console.log('\n⏰ 测试超时，终止子进程');
        child.kill('SIGINT');
    }, TIMEOUT_MS);

    const exitCode = await new Promise((resolve) => {
        child.on('close', (code) => resolve(code ?? 1));
    });
    clearTimeout(timer);

    // ---------------- 断言 ----------------
    const results = [];
    const check = (name, ok, detail = '') =>
        results.push({ name, ok, detail });

    const summaryMatch = output.match(
        /ROUND_SUMMARY round=(\d+) redirects=(\d+) error=(\w+) form=(\w+) checked=(\S+) continued=(\S+)/
    );

    check('轮次正常结束 (ROUND_SUMMARY 输出)', !!summaryMatch);

    if (summaryMatch) {
        const [, , redirectsStr, error, form, checked, continued] = summaryMatch;
        const redirects = parseInt(redirectsStr, 10);

        check('页面加载成功 (非错误页)', error === 'no', `error=${error}`);
        check('重定向跳转记录 >= 1 次', redirects >= 1, `实际: ${redirects}`);
        check('退出码为 0', exitCode === 0, `实际: ${exitCode}`);

        if (form === 'yes') {
            check('验证表单勾选成功', checked === 'yes', `实际: ${checked}`);
            check('Continue 点击成功', continued === 'yes', `实际: ${continued}`);
        } else {
            console.log('\nℹ️  本轮未出现验证表单（概率性），跳过表单断言');
        }
    } else {
        check('子进程退出码为 0', exitCode === 0, `实际: ${exitCode}`);
    }

    // ---------------- 汇总 ----------------
    console.log('\n========================================');
    console.log('📋 测试结果汇总:');
    let allPass = true;
    for (const r of results) {
        const icon = r.ok ? '✅ PASS' : '❌ FAIL';
        if (!r.ok) allPass = false;
        console.log(`   ${icon}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    }
    console.log('========================================');
    console.log(allPass ? '🎉 测试全部通过' : '💥 测试存在失败项');

    process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
    console.error('❌ 测试脚本异常:', e);
    process.exit(1);
});