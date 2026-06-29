import mysql from 'mysql2/promise';

const DB_CONFIG = { host: '166.0.19.103', port: 13307, user: 'root', password: 'root', database: 'ad' };

const ACCOUNTS = [
    'brown.olivia@himail.infos.st',
    'garcia.charlotte@mesemails.fr.nf',
    'johnson.emma@ypmail.sehier.fr',
];

function getDateStr(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
}

async function fetchStats(apiKey, date) {
    const url = `https://api3.adsterratools.com/publisher/stats.json?finish_date=${date}&start_date=${date}&group_by=date`;
    try {
        const resp = await fetch(url, {
            headers: { 'X-Api-Key': apiKey },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch (e) {
        // Try with token param
        try {
            const url2 = `${url}&token=${apiKey}`;
            const resp2 = await fetch(url2);
            if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
            return await resp2.json();
        } catch (e2) {
            return { error: e.message };
        }
    }
}

async function main() {
    const conn = await mysql.createConnection(DB_CONFIG);
    const [rows] = await conn.execute(
        'SELECT account, api_key, status FROM adsterra_account WHERE account IN (?, ?, ?)',
        ACCOUNTS
    );
    await conn.end();

    const yesterday = getDateStr(-1);
    const today = getDateStr(0);

    for (const row of rows) {
        console.log(`\n=== ${row.account} (${row.status}) ===`);

        for (const [label, date] of [['Yesterday', yesterday], ['Today', today]]) {
            const data = await fetchStats(row.api_key, date);
            if (data.error) {
                console.log(`  ${label} (${date}): Error - ${data.error}`);
            } else if (data.items?.length > 0) {
                const item = data.items[0];
                console.log(`  ${label} (${date}): impression=${item.impression}  cpm=$${item.cpm}  revenue=$${Number(item.revenue).toFixed(4)}`);
            } else {
                console.log(`  ${label} (${date}): No data`);
            }
        }
    }
}

main().catch(e => console.error(e));