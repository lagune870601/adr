import http from 'node:http';
import mysql from 'mysql2/promise';

const config = {
    db: {
        host: process.env.DB_HOST || '166.0.19.103',
        port: Number(process.env.DB_PORT || 13307),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'root',
        database: process.env.DB_NAME || 'ad',
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_POOL_SIZE || 5),
        charset: 'utf8mb4',
        connectTimeout: 10000,
    },
    port: Number(process.env.ALLOCATOR_PORT || 18010),
    token: process.env.ALLOCATOR_TOKEN || '',
    country: process.env.IP_COUNTRY || '美国',
    networkType: process.env.IP_NETWORK_TYPE || '普通宽带',
    batchSize: Math.max(1, Number(process.env.BATCH_SIZE || 20)),
    lowWater: Math.max(0, Number(process.env.LOW_WATER || 5)),
    refillAttempts: Math.max(1, Number(process.env.REFILL_ATTEMPTS || 4)),
};

const SELECT_CANDIDATES_SQL = `
SELECT id, ip FROM ip_cz88
WHERE is_delete = 0
  AND country = ?
  AND network_type = ?
  AND vpn = 0 AND tor = 0 AND proxy = 0 AND spider = 0 AND icloud_private_relay = 0
  AND (last_use_time IS NULL OR last_use_time < NOW() - INTERVAL 15 DAY)
ORDER BY last_use_time ASC, id ASC
LIMIT ?`;

const RESERVE_ONE_SQL = `
UPDATE ip_cz88
SET last_use_time = NOW()
WHERE id = ?
  AND (last_use_time IS NULL OR last_use_time < NOW() - INTERVAL 15 DAY)`;

class NoIpError extends Error {
    constructor() {
        super('no available ip');
        this.name = 'NoIpError';
    }
}

const pool = mysql.createPool(config.db);

const state = {
    queue: [],
    refilling: false,
    refillPromise: null,
    served: 0,
    batches: 0,
    lastError: null,
    lastRefillAt: null,
};

function log(event, data = {}) {
    const line = { ts: new Date().toISOString(), event, ...data };
    console.log(JSON.stringify(line));
}

/** 从数据库按「最久未用优先」取一批候选，逐行做带资格条件的原子 UPDATE 预留 */
async function reserveBatch(want) {
    const got = [];
    for (let attempt = 0; attempt < config.refillAttempts && got.length < want; attempt++) {
        const need = want - got.length;
        let rows;
        try {
            [rows] = await pool.execute(SELECT_CANDIDATES_SQL, [config.country, config.networkType, need]);
        } catch (e) {
            log('select_error', { error: e.message, attempt });
            throw e;
        }
        if (!rows.length) break;

        const results = await Promise.all(rows.map(async (row) => {
            try {
                const [res] = await pool.execute(RESERVE_ONE_SQL, [row.id]);
                return res.affectedRows === 1 ? { id: row.id, ip: row.ip } : null;
            } catch (e) {
                log('reserve_error', { id: row.id, error: e.message });
                return null;
            }
        }));
        for (const item of results) {
            if (item) got.push(item);
        }
    }
    return got;
}

function refill() {
    if (state.refilling) return state.refillPromise;
    state.refilling = true;
    state.refillPromise = (async () => {
        try {
            const got = await reserveBatch(config.batchSize);
            if (got.length) {
                state.queue.push(...got);
                state.batches++;
            }
            state.lastError = null;
            state.lastRefillAt = new Date().toISOString();
            log('refill', { reserved: got.length, queue: state.queue.length, batches: state.batches });
        } catch (e) {
            state.lastError = e.message;
            log('refill_error', { error: e.message, queue: state.queue.length });
        } finally {
            state.refilling = false;
            state.refillPromise = null;
        }
    })();
    return state.refillPromise;
}

async function allocate() {
    if (state.queue.length === 0) {
        if (state.refilling) {
            await state.refillPromise;
        } else {
            await refill();
        }
        if (state.queue.length === 0) {
            if (state.lastError) {
                const e = new Error(state.lastError);
                e.code = 'DB';
                throw e;
            }
            throw new NoIpError();
        }
    }

    const item = state.queue.shift();
    state.served++;
    if (state.queue.length <= config.lowWater && !state.refilling) refill();
    return item;
}

function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
}

const server = http.createServer(async (req, res) => {
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        send(res, 400, { error: 'bad_request' });
        return;
    }

    if (config.token && req.headers['x-allocator-token'] !== config.token) {
        send(res, 401, { error: 'unauthorized' });
        return;
    }

    if (url.pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        try {
            await pool.query('SELECT 1');
            send(res, 200, {
                ok: true,
                db: true,
                queue: state.queue.length,
                refilling: state.refilling,
                served: state.served,
                batches: state.batches,
                last_refill_at: state.lastRefillAt,
                last_error: state.lastError,
            });
        } catch (e) {
            send(res, 503, { ok: false, db: false, error: e.message, queue: state.queue.length });
        }
        return;
    }

    if (url.pathname === '/allocate' && (req.method === 'POST' || req.method === 'GET')) {
        try {
            const item = await allocate();
            log('allocate', item);
            send(res, 200, item);
        } catch (e) {
            if (e instanceof NoIpError) {
                send(res, 503, { error: 'no_available_ip' });
            } else {
                log('allocate_error', { error: e.message });
                send(res, 503, { error: 'db_unavailable', detail: e.message });
            }
        }
        return;
    }

    send(res, 404, { error: 'not_found' });
});

async function main() {
    log('start', {
        db_host: config.db.host,
        db_port: config.db.port,
        db_name: config.db.database,
        country: config.country,
        network_type: config.networkType,
        batch_size: config.batchSize,
        low_water: config.lowWater,
        port: config.port,
        auth: Boolean(config.token),
    });
    await refill();
    server.listen(config.port, '0.0.0.0', () => {
        log('listening', { port: config.port });
    });
}

async function shutdown(signal) {
    log('shutdown', { signal, queue: state.queue.length });
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((e) => {
    log('fatal', { error: e.message });
    process.exit(1);
});