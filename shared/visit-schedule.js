/**
 * visit-schedule — 按本地时区与作息权重的日访问事件生成器
 *
 * 每个链接每天的访问量服从泊松分布（默认均值 250），并按小时权重分配到
 * 目标时区的各个小时：每个小时的访问数 ~ Poisson(日均 × 权重占比)，
 * 小时内到达时刻均匀分布。这正是分段常速率非齐次泊松过程的标准构造，
 * 既保留了泊松到达的随机性，又形成当地作息曲线。
 *
 * 时区与权重均可按班次传入；不传时保持原有美国东部行为，
 * 因此 mondiad.js 等旧调用方无需改动。
 */

export const ET_TZ = 'America/New_York';
export const JP_TZ = 'Asia/Tokyo';

// 24 个小时的未归一化权重：凌晨 0-5 点合计约 5%，晚间 18-21 点每小时最高
export const US_HOURLY_WEIGHTS = [
    1.2, 0.8, 0.6, 0.5, 0.5, 0.8,           // 0-5
    1.2,                                    // 6
    2.5, 3.5, 4.2,                          // 7-9
    4.8, 5.0, 5.2, 5.3, 5.2, 5.0, 4.8, 4.8, // 10-17
    6.0, 6.5, 6.8, 6.5,                     // 18-21
    4.5, 2.5,                               // 22-23
];

/** 兼容旧命名（原 HOURLY_WEIGHTS 即美国作息） */
export const HOURLY_WEIGHTS = US_HOURLY_WEIGHTS;

// 日本本地作息：凌晨 0-5 点最低，早间 7-9 点回升，白天平稳，
// 晚间 19-22 点最高（日本网络使用高峰偏晚）
export const JP_HOURLY_WEIGHTS = [
    1.0, 0.6, 0.5, 0.4, 0.4, 0.6,           // 0-5
    1.5,                                    // 6
    3.0, 4.0, 3.5,                          // 7-9
    4.0, 4.5, 4.2, 4.5, 4.8, 4.8, 5.0, 5.2, // 10-17
    6.0, 6.5, 6.8, 7.0,                     // 18-21
    6.5, 5.0,                               // 22-23
];

const fmtCache = new Map();

function formatterFor(tz) {
    let fmt = fmtCache.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
        fmtCache.set(tz, fmt);
    }
    return fmt;
}

/** 取某一时刻在指定时区下的日期/时间分量 */
export function tzParts(ms, tz = ET_TZ) {
    const parts = {};
    for (const p of formatterFor(tz).formatToParts(ms)) {
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

/** 某一时刻所属的指定时区日历日 */
export function tzDayKey(ms, tz = ET_TZ) {
    const { year, month, day } = tzParts(ms, tz);
    return { year, month, day };
}

/** 美国东部时间分量（保持旧签名） */
export function etParts(ms) {
    return tzParts(ms, ET_TZ);
}

/** 某一时刻所属的美国东部日历日（保持旧签名） */
export function etDayKey(ms) {
    return tzDayKey(ms, ET_TZ);
}

/** 日历日的下一天（按 UTC 计算，仅做日期进位，不涉及时区） */
export function nextDay({ year, month, day }) {
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + 1);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 把指定时区的墙上时间转换为 UTC 毫秒时间戳（自动处理夏令时偏移） */
export function wallToUtc(tz, year, month, day, hour = 0, minute = 0, second = 0) {
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = target;
    for (let i = 0; i < 3; i++) {
        const p = tzParts(guess, tz);
        const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        const diff = target - actual;
        if (diff === 0) break;
        guess += diff;
    }
    return guess;
}

/** 美国东部墙上时间转 UTC（保持旧签名） */
export function etWallToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
    return wallToUtc(ET_TZ, year, month, day, hour, minute, second);
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
 * 生成某个日历日的全部访问时刻（已排序）。
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} visitsPerDay 日访问量均值
 * @param {number[]} [weights=US_HOURLY_WEIGHTS] 24 小时权重
 * @param {string} [tz=ET_TZ] IANA 时区
 * @returns {number[]} UTC 毫秒时间戳，升序
 */
export function buildDayEvents(year, month, day, visitsPerDay,
    weights = US_HOURLY_WEIGHTS, tz = ET_TZ) {
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const events = [];

    for (let hour = 0; hour < 24; hour++) {
        const lambda = visitsPerDay * (weights[hour] || 0) / totalWeight;
        if (lambda <= 0) continue;

        const count = poisson(lambda);
        const hourStart = wallToUtc(tz, year, month, day, hour);
        for (let i = 0; i < count; i++) {
            events.push(hourStart + Math.floor(Math.random() * 3600) * 1000);
        }
    }

    return events.sort((a, b) => a - b);
}