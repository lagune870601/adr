import { getTask, updateTaskStatus, incrementRetryCount, getAccountByEmail } from './shared/db.js';
import { createProxy } from './shared/proxy-utils.js';
import { signupCrawler } from './signup.js';
import { accountCrawler } from './open-account.js';
import { payoutCrawler } from './payout.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const POLL_INTERVAL = 10000;  // 无任务时轮询间隔（毫秒）

// 任务类型 → 爬虫函数映射
const CRAWLER_DISPATCH = {
    'REGISTER': signupCrawler,
    'ACCOUNT': accountCrawler,
    'PAYOUT': payoutCrawler,
};

/**
 * 主调度循环
 * 轮询 crawler_task 表，调度对应爬虫执行任务
 */
async function mainLoop() {
    console.log('🚀 启动主调度器...\n');

    while (true) {
        const task = await getTask(Object.keys(CRAWLER_DISPATCH));
        if (!task) {
            console.log(`⏳ 暂无待处理任务，${POLL_INTERVAL / 1000}s 后重试...\n`);
            await sleep(POLL_INTERVAL);
            continue;
        }

        await executeTask(task);
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

        // 3. 非 REGISTER 任务：从 adsterra_account 获取 cookies
        let cookies = null;
        if (task.task_type !== 'REGISTER') {
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

// 启动
mainLoop().catch((error) => {
    console.error('❌ 主调度器异常:', error);
    process.exit(1);
});