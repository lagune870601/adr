/**
 * test-create-link.js — CREATE_LINK 爬虫自测脚本
 *
 * 用法: node test-create-link.js
 * 测试邮箱: elirivera@fhpfhp.fr.nf
 */

import { createLinkCrawler } from './create-link.js';
import { createProxy } from './shared/proxy-utils.js';
import { getAccountByEmail } from './shared/db.js';

const EMAIL = 'elirivera@fhpfhp.fr.nf';

async function main() {
    console.log('🧪 CREATE_LINK 爬虫自测');
    console.log(`📧 邮箱: ${EMAIL}\n`);

    const task = { id: 9999, email: EMAIL, username: 'test', task_type: 'CREATE_LINK' };

    let proxyManager;
    try {
        const { proxy, manager } = await createProxy();
        proxyManager = manager;

        console.log('📦 获取 cookies...');
        const accountData = await getAccountByEmail(EMAIL);
        if (!accountData) { console.error('❌ 未找到账号记录'); process.exit(1); }
        const cookies = accountData.cookies;
        console.log(`   🍪 ${cookies.length} 条 cookie\n`);

        const result = await createLinkCrawler(task, proxy, cookies);

        console.log('\n========================================');
        console.log('📊 测试结果:');
        console.log(`   ✅ success:   ${result.success}`);
        console.log(`   🔄 retryable: ${result.retryable}`);
        console.log(`   ❌ error:     ${result.error || '无'}`);

        if (result.success) {
            console.log('\n🎉 CREATE_LINK 测试通过！');
        } else {
            console.log('\n❌ CREATE_LINK 测试失败');
            process.exit(1);
        }
    } catch (e) {
        console.error('💥 异常:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    } finally {
        if (proxyManager) proxyManager.destroy();
    }
}

main();