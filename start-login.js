/**
 * test-login.js — Login 爬虫自测脚本
 *
 * 用法: node test-login.js
 * 测试邮箱: isaacnguyenig@mabal.fr.nf
 * 测试密码: 123456789_Chen
 */

import { loginCrawler } from './login.js';
import { createProxy } from './shared/proxy-utils.js';

const EMAIL = 'jackyF@mymail.infos.st';

async function main() {
    console.log('🧪 Login 爬虫脚本');
    console.log('========================================');
    console.log(`📧 邮箱: ${EMAIL}\n`);

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

        // 3. 调用登录爬虫（cookies 传 null，登录不需要已有 cookies）
        const result = await loginCrawler(task, proxy, null);

        // 4. 输出结果
        console.log('\n========================================');
        console.log('📊 测试结果:');
        console.log(`   ✅ success:  ${result.success}`);
        console.log(`   🔄 retryable: ${result.retryable}`);
        console.log(`   ❌ error:     ${result.error || '无'}`);

        if (result.success) {
            console.log('\n🎉 登录测试通过！');
        } else {
            console.log('\n❌ 登录测试失败');
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