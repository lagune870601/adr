/**
 * test-login.js — Login 爬虫自测脚本
 *
 * 用法: node test-login.js
 * 测试邮箱: isaacnguyenig@mabal.fr.nf
 * 测试密码: 123456789_Chen
 *
 * 当前测试模式: 直接测试密码重置流程（从 yopmail 开始，跳过登录）
 */

import { handlePasswordResetAndRelogin } from './login.js';
import { createProxy } from './shared/proxy-utils.js';

const EMAIL = 'bello.luigi@vitahicks.com';

async function main() {
    console.log('🧪 密码重置流程测试脚本');
    console.log('========================================');
    console.log(`📧 邮箱: ${EMAIL}\n`);
    console.log('🔍 测试模式: 直接从 yopmail 获取重置链接 → 设置新密码 → 重新登录\n');

    // 1. 构建 mock task
    const task = {
        id: 9999,
        email: EMAIL,
        username: 'test',
        task_type: 'LOGIN',
    };

    // 2. 获取代理
    let proxyManager;
    try {
        const { proxy, manager } = await createProxy();
        proxyManager = manager;

        // 3. 直接调用密码重置流程（从 yopmail 开始，无需前置登录）
        const result = await handlePasswordResetAndRelogin(task, proxy);

        // 4. 输出结果
        console.log('\n========================================');
        console.log('📊 测试结果:');
        console.log(`   ✅ success:  ${result.success}`);
        console.log(`   ❌ error:     ${result.error || '无'}`);
        if (result.loginIp) console.log(`   🌐 loginIp:  ${result.loginIp}`);
        if (result.cookiesJson) console.log(`   🍪 cookies:  ${result.cookiesJson.length} 字符`);

        if (result.success) {
            console.log('\n🎉 密码重置 + 重新登录测试通过！');
        } else {
            console.log('\n❌ 测试失败');
            process.exit(1);
        }
    } catch (e) {
        console.error('\n💥 测试异常:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    } finally {
        if (proxyManager) {
            proxyManager.destroy();
        }
    }
}

main();