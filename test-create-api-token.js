/**
 * test-create-api-token.js — CREATE_API_TOKEN 爬虫自测脚本
 *
 * 用法: node test-create-api-token.js
 * 测试邮箱: elirivera@fhpfhp.fr.nf
 */

import { createApiTokenCrawler } from './create-api-token.js';
import { createProxy } from './shared/proxy-utils.js';
import { getAccountByEmail } from './shared/db.js';

const EMAIL = 'elirivera@fhpfhp.fr.nf';

async function main() {
    console.log('🧪 CREATE_API_TOKEN 爬虫自测');
    console.log('========================================');
    console.log(`📧 邮箱: ${EMAIL}\n`);

    // 1. 构建 mock task
    const task = {
        id: 9999,
        email: EMAIL,
        username: 'test',
        task_type: 'CREATE_API_TOKEN',
    };

    // 2. 获取代理
    let proxyManager;
    try {
        const { proxy, manager } = await createProxy();
        proxyManager = manager;

        // 3. 获取 cookies
        console.log('\n📦 获取账号 cookies...');
        const accountData = await getAccountByEmail(EMAIL);
        if (!accountData) {
            console.error('❌ 未找到账号记录');
            process.exit(1);
        }
        const cookies = accountData.cookies;
        console.log(`   🍪 已获取 ${cookies.length} 条 cookie`);

        // 4. 调用爬虫
        const result = await createApiTokenCrawler(task, proxy, cookies);

        // 5. 输出结果
        console.log('\n========================================');
        console.log('📊 测试结果:');
        console.log(`   ✅ success:   ${result.success}`);
        console.log(`   🔄 retryable: ${result.retryable}`);
        console.log(`   ❌ error:     ${result.error || '无'}`);
        if (result.apiToken) {
            console.log(`   🔑 apiToken:  ${result.apiToken}`);
        }

        if (result.success) {
            console.log('\n🎉 API Token 创建测试通过！');
        } else {
            console.log('\n❌ API Token 创建测试失败');
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