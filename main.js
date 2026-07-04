import { getTask, updateTaskStatus, incrementRetryCount, getAccountByEmail } from './shared/db.js';
import { createProxy } from './shared/proxy-utils.js';
import { signupCrawler } from './signup.js';
import mysql from 'mysql2/promise';
import { DB_CONFIG } from './shared/db.js';
import { loginCrawler } from './login.js';
// import { accountCrawler } from './open-account.js';
import { payoutCrawler } from './payout.js';
import { createApiTokenCrawler } from './create-api-token.js';
import { createLinkCrawler } from './create-link.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const POLL_INTERVAL = 10000;  // 无任务时轮询间隔（毫秒）

// 任务类型 → 爬虫函数映射
const CRAWLER_DISPATCH = {
    'REGISTER': signupCrawler,
    'LOGIN': loginCrawler,
    // 'ACCOUNT': accountCrawler,
    // 'PAYOUT': payoutCrawler,
    'CREATE_API_TOKEN': createApiTokenCrawler,
    'CREATE_LINK': createLinkCrawler,
};

/**
 * 主调度循环
 * 轮询 crawler_task 表，调度对应爬虫执行任务
 */
async function mainLoop() {
    console.log('🚀 启动主调度器...\n');

    while (true) {
        try {
            const task = await getTask(Object.keys(CRAWLER_DISPATCH));
            if (!task) {
                console.log(`⏳ 暂无待处理任务，${POLL_INTERVAL / 1000}s 后重试...\n`);
                await sleep(POLL_INTERVAL);
                continue;
            }

            await executeTask(task);
        } catch (e) {
            console.error('💥 主调度器异常:', e.message);
            if (e.stack) console.error(e.stack);
            console.log(`⏳ ${POLL_INTERVAL * 10/ 1000}s 后重试...\n`);
            await sleep(POLL_INTERVAL * 10);
        }

    }
}

/**
 * 执行单个任务
 * 1. 分配代理
 * 2. 非 REGISTER 任务：查询 adsterra_account 获取 cookies
 * 3. 调用对应爬虫函数
 * 4. 根据结果更新任务状态
 */
async function executeTask(task) {
    console.log(`\n========== 处理任务 #${task.id} (类型: ${task.task_type}) ==========`);
    console.log(`   用户名: ${task.username}, 邮箱: ${task.email}`);

    await updateTaskStatus(task.id, 'processing');

    let proxyManager;
    try {
        // 1. 分配代理
        const { proxy, manager } = await createProxy();
        proxyManager = manager;

        // 2. 确定爬虫
        const crawler = CRAWLER_DISPATCH[task.task_type];
        if (!crawler) {
            throw new Error(`未知任务类型: ${task.task_type}`);
        }

        // 3. 非 REGISTER/LOGIN 任务：从 adsterra_account 获取 cookies
        let cookies = null;
        if (task.task_type !== 'REGISTER' && task.task_type !== 'LOGIN') {
            console.log('\n📦 查询账号 cookies...');
            const accountData = await getAccountByEmail(task.email);
            if (!accountData) {
                throw new Error(`未找到账号记录: ${task.email}`);
            }
            cookies = accountData.cookies;
            console.log(`   🍪 已获取 ${cookies.length} 条 cookie`);
        }

        // 4. 执行爬虫
        console.log(`\n▶️  启动爬虫: ${task.task_type}...\n`);
        const result = await crawler(task, proxy, cookies);

        // 5. 处理结果
        console.log(`\n========== 任务 #${task.id} 结果 ==========`);
        if (result.success) {
            console.log('✅ 任务执行成功');
            if (result.apiToken) {
                console.log(`   🔑 API Token: ${result.apiToken.slice(0, 10)}...${result.apiToken.slice(-4)}`);
                // 兜底保存 apiToken 到 crawler_task.result（爬虫内部已保存，此处确保一致性）
                await saveTaskResult(task.id, result.apiToken);
            }
            await updateTaskStatus(task.id, 'completed');
        } else if (result.retryable) {
            console.log(`🔄 任务需重试: ${result.error}`);
            await incrementRetryCount(task.id);
            await updateTaskStatus(task.id, 'retry');
        } else {
            console.log(`❌ 任务失败: ${result.error}`);
            await updateTaskStatus(task.id, 'failed');
        }
    } catch (e) {
        console.error(`\n💥 任务 #${task.id} 异常:`, e.message);
        if (e.stack) console.error(e.stack);
        await updateTaskStatus(task.id, 'failed');
    } finally {
        if (proxyManager) {
            proxyManager.destroy();
        }
    }
}

// 优雅退出
process.on('SIGINT', () => {
    console.log('\n\n👋 正在关闭主调度器...');
    process.exit(0);
});

/**
 * 兜底保存 apiToken 到 crawler_task.result 字段
 */
async function saveTaskResult(taskId, apiToken) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        await connection.execute(
            'UPDATE crawler_task SET result = ? WHERE id = ?',
            [apiToken, taskId]
        );
        console.log(`   💾 crawler_task.result 已保存 (task_id=${taskId})`);
    } catch (err) {
        console.error('   ⚠️  保存 result 失败:', err.message);
    } finally {
        await connection.end();
    }
}

// 启动
mainLoop().catch((error) => {
    console.error('❌ 主调度器异常:', error);
    process.exit(1);
});