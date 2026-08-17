/**
 * test-change-name.js — CHANGE_NAME 爬虫自测
 */
import { changeNameCrawler } from './change-name.js';
import { createProxy } from './shared/proxy-utils.js';
import { getAccountByEmail } from './shared/db.js';
import mysql from 'mysql2/promise';

const DB_CONFIG = { host: '166.0.19.103', port: 13307, user: 'root', password: 'root', database: 'ad' };
const TASK_ID = 117;

async function getTask() {
    const c = await mysql.createConnection(DB_CONFIG);
    const [r] = await c.execute('SELECT * FROM crawler_task WHERE id=?', [TASK_ID]);
    await c.end();
    return r[0];
}

async function main() {
    console.log('🧪 CHANGE_NAME 爬虫自测');
    const task = await getTask();
    console.log(`   task: id=${task.id}, username="${task.username}", email=${task.email}\n`);

    let proxyManager;
    try {
        const { proxy, manager } = await createProxy();
        proxyManager = manager;

        const accountData = await getAccountByEmail(task.email);
        if (!accountData) { console.error('❌ 未找到账号'); process.exit(1); }
        const cookies = accountData.cookies;
        console.log(`🍪 ${cookies.length} 条 cookie\n`);

        const result = await changeNameCrawler(task, proxy, cookies);

        console.log('\n========================================');
        console.log(`   ✅ success:   ${result.success}`);
        console.log(`   🔄 retryable: ${result.retryable}`);
        console.log(`   ❌ error:     ${result.error || '无'}`);
        if (result.success) console.log('\n🎉 CHANGE_NAME 测试通过！');
        else { console.log('\n❌ 测试失败'); process.exit(1); }
    } catch (e) {
        console.error('💥', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    } finally {
        if (proxyManager) proxyManager.destroy();
    }
}

main();