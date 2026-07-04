import mysql from 'mysql2/promise';

// ==================== 数据库配置（唯一数据源） ====================

export const DB_CONFIG = {
    host: '166.0.19.103',
    port: 13307,
    user: 'root',
    password: 'root',
    database: 'ad',
};

// ==================== crawler_task 任务生命周期 ====================

/**
 * 从 crawler_task 表中查询一条待处理的任务
 * 条件: task_type IN (...), task_status IN ('pending','retry'), scheduled_time <= PT时间, is_delete=0, retry_count < 5
 * 按 scheduled_time 升序，取一条
 */
export async function getTask(taskTypes) {
    console.log('🔍 查询待处理任务...');
    const connection = await mysql.createConnection(DB_CONFIG);

    try {
        // scheduled_time 存储的是 US Eastern Time
        const nowPt = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' })
            .replace(' ', 'T').substring(0, 19);
        const placeholders = taskTypes.map(() => '?').join(',');
        const sql = `SELECT id, username, email, retry_count, scheduled_time, task_type, address, payment_address
             FROM crawler_task
             WHERE task_type IN (${placeholders})
               AND task_status IN ('pending', 'retry')
               AND scheduled_time <= ?
               AND is_delete = 0
               AND retry_count < 5
             ORDER BY scheduled_time ASC
             LIMIT 1`;
        const [rows] = await connection.execute(
            `SELECT id, username, email, retry_count, scheduled_time, task_type, address, payment_address
             FROM crawler_task
             WHERE task_type IN (${placeholders})
               AND task_status IN ('pending', 'retry')
               AND scheduled_time <= ?
               AND is_delete = 0
               AND retry_count < 5
             ORDER BY scheduled_time ASC
             LIMIT 1`,
            [...taskTypes, nowPt]
        );

        if (rows.length === 0) {
            console.warn('⚠️  没有待处理的任务');
            return null;
        }

        const task = rows[0];
        console.log(`✅ 找到任务: id=${task.id}, type=${task.task_type}, username="${task.username}", email="${task.email}"`);
        console.log(`   retry_count=${task.retry_count}, scheduled_time=${task.scheduled_time}`);
        return task;
    } finally {
        await connection.end();
    }
}

/**
 * 更新 crawler_task 状态
 */
export async function updateTaskStatus(taskId, status) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        await connection.execute(
            'UPDATE crawler_task SET task_status = ? WHERE id = ?',
            [status, taskId]
        );
        console.log(`   💾 任务状态已更新: id=${taskId}, status=${status}`);
    } finally {
        await connection.end();
    }
}

/**
 * 递增 crawler_task 的 retry_count
 */
export async function incrementRetryCount(taskId) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        await connection.execute(
            'UPDATE crawler_task SET retry_count = retry_count + 1, last_retry_time = NOW() WHERE id = ?',
            [taskId]
        );
        console.log(`   💾 retry_count +1 (task id=${taskId})`);
    } finally {
        await connection.end();
    }
}

// ==================== adsterra_account 账号查询（供非 REGISTER 任务使用） ====================

/**
 * 将 Chrome 扩展格式的 cookie 数组转换为 Puppeteer setCookie 格式
 */
function convertCookies(rawCookies) {
    return rawCookies
        .filter(c => c.session !== true)
        .map(c => {
            const cookie = {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                httpOnly: c.httpOnly || false,
                secure: c.secure || false,
            };
            if (c.expirationDate) {
                cookie.expires = c.expirationDate;
            }
            if (c.sameSite) {
                const mapping = {
                    'no_restriction': 'None',
                    'lax': 'Lax',
                    'strict': 'Strict',
                    'unspecified': 'Lax',
                };
                cookie.sameSite = mapping[c.sameSite] || 'Lax';
            }
            return cookie;
        });
}

/**
 * 按 email 查询 adsterra_account 表，返回账号信息和 Puppeteer 格式的 cookies
 * @param {string} email - 对应 adsterra_account.account 字段
 * @returns {{ account, loginIp, cookies: Array } | null}
 */
export async function getAccountByEmail(email) {
    console.log(`🔍 查询账号: ${email}`);
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        const [rows] = await connection.execute(
            'SELECT account, cookie, login_ip, status FROM adsterra_account WHERE account = ?',
            [email]
        );

        if (rows.length === 0) {
            console.warn(`⚠️  未找到账号 "${email}" 的记录`);
            return null;
        }

        const record = rows[0];
        const rawCookies = typeof record.cookie === 'string'
            ? JSON.parse(record.cookie)
            : (record.cookie || []);

        console.log(`   cookie 数量: ${rawCookies.length}`);

        return {
            account: record.account,
            loginIp: record.login_ip,
            cookies: convertCookies(rawCookies),
        };
    } finally {
        await connection.end();
    }
}