/**
 * visit-schedule — 美国东部时间下的日访问事件生成器
 *
 * 每个链接每天的访问量服从泊松分布（默认均值 250），并按小时权重分配到
 * 美国东部时间的各个小时：每个小时的访问数 ~ Poisson(日均 × 权重占比)，
 * 小时内到达时刻均匀分布。这正是分段常速率非齐次泊松过程的标准构造，
 * 既保留了泊松到达的随机性，又形成美国当地的作息曲线。
 */

export const ET_TZ = 'America/New_York';

// 24 个小时的未归一化权重：凌晨 0-5 点合计约 5%，晚间 18-21 点每小时最高
export const HOURLY_WEIGHTS = [
    1.2, 0.8, 0.6, 0.5, 0.5, 0.8,           // 0-5
    1.2,                                    // 6
    2.5, 3.5, 4.2,                          // 7-9
    4.8, 5.0, 5.2, 5.3, 5.2, 5.0, 4.8, 4.8, // 10-17
    6.0, 6.5, 6.8, 6.5,                     // 18-21
    4.5, 2.5,                               // 22-23
];

const ET_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
});

/** 取某一时刻在美国东部时间下的日期/时间分量 */
export function etParts(ms) {
    const parts = {};
    for (const p of ET_FMT.formatToParts(ms)) {
        if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
    }
    return {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
        second: parts.second,
    };
}

/** 某一时刻所属的美国东部日历日 */
export function etDayKey(ms) {
    const { year, month, day } = etParts(ms);
    return { year, month, day };
}

/** 日历日的下一天（按 UTC 计算，仅做日期进位，不涉及时区） */
export function nextDay({ year, month, day }) {
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + 1);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 把美国东部时间的墙上时间转换为 UTC 毫秒时间戳（自动处理夏令时偏移） */
export function etWallToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = target;
    for (let i = 0; i < 3; i++) {
        const p = etParts(guess);
        const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        const diff = target - actual;
        if (diff === 0) break;
        guess += diff;
    }
    return guess;
}

/** Knuth 法采样泊松分布（lambda 为日均 250 量级时也只有几百次迭代） */
export function poisson(lambda) {
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
        k++;
        p *= Math.random();
    } while (p > limit);
    return k - 1;
}

/**
 * 生成某个美国东部日历日的全部访问时刻（已排序）。
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} visitsPerDay 日访问量均值
 * @returns {number[]} UTC 毫秒时间戳，升序
 */
export function buildDayEvents(year, month, day, visitsPerDay) {
    const totalWeight = HOURLY_WEIGHTS.reduce((sum, w) => sum + w, 0);
    const events = [];

    for (let hour = 0; hour < 24; hour++) {
        const lambda = visitsPerDay * HOURLY_WEIGHTS[hour] / totalWeight;
        if (lambda <= 0) continue;

        const count = poisson(lambda);
        const hourStart = etWallToUtc(year, month, day, hour);
        for (let i = 0; i < count; i++) {
            events.push(hourStart + Math.floor(Math.random() * 3600) * 1000);
        }
    }

    return events.sort((a, b) => a - b);
}