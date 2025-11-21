import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

export async function initDb() {
    const client = await pool.connect();
    try {
        // 1. Users Table (Updated)
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id TEXT PRIMARY KEY,
                points INTEGER DEFAULT 0,
                referral_earnings INTEGER DEFAULT 0,
                referrer_id TEXT,
                bank_name TEXT,
                account_number TEXT,
                account_name TEXT,
                is_banned BOOLEAN DEFAULT FALSE,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Migration
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_earnings INTEGER DEFAULT 0;`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;`);

        // 2. Earnings History (NEW)
        await client.query(`
            CREATE TABLE IF NOT EXISTS earnings_history (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT,
                amount INTEGER,
                type TEXT, -- 'TASK', 'REFERRAL'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 3. Withdrawals
        await client.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT,
                amount_points INTEGER,
                amount_ngn INTEGER,
                status TEXT DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 4. Sessions & IDs
        await client.query(`
            CREATE TABLE IF NOT EXISTS wa_sessions (
                session_id TEXT PRIMARY KEY,
                phone TEXT,
                creds TEXT,
                antimsg BOOLEAN DEFAULT FALSE,
                autosave BOOLEAN DEFAULT FALSE,
                telegram_user_id TEXT
            );
        `);
        await client.query(`CREATE TABLE IF NOT EXISTS wa_ids (session_folder TEXT PRIMARY KEY, short_id TEXT UNIQUE);`);
        
        // 5. Numbers & Blacklist
        await client.query(`CREATE TABLE IF NOT EXISTS broadcast_numbers (phone TEXT PRIMARY KEY);`);
        await client.query(`CREATE TABLE IF NOT EXISTS blacklist (phone TEXT PRIMARY KEY);`);

        console.log('[DB] Tables initialized.');
    } catch (err) {
        console.error('[DB ERROR]', err);
    } finally {
        client.release();
    }
}

// --- USER MANAGEMENT ---
export async function getUser(telegramId) {
    const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    return res.rows[0];
}

export async function createUser(telegramId, referrerId = null) {
    try {
        // Only set referrer if valid and not self
        if (referrerId && referrerId !== telegramId) {
            await pool.query(
                `INSERT INTO users (telegram_id, referrer_id) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING`,
                [telegramId, referrerId]
            );
        } else {
            await pool.query(
                `INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING`,
                [telegramId]
            );
        }
    } catch (e) {}
}

export async function banUser(telegramId, status) {
    await pool.query('UPDATE users SET is_banned = $1 WHERE telegram_id = $2', [status, telegramId]);
}

// --- POINTS & REFERRALS ---
export async function addPoints(telegramId, amount, type = 'TASK') {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Add Points to User
        await client.query('UPDATE users SET points = points + $1 WHERE telegram_id = $2', [amount, telegramId]);
        
        // 2. Log Transaction
        await client.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, $2, $3)', [telegramId, amount, type]);

        // 3. Referral Commission (20%)
        if (type === 'TASK') {
            const userRes = await client.query('SELECT referrer_id FROM users WHERE telegram_id = $1', [telegramId]);
            const referrerId = userRes.rows[0]?.referrer_id;
            
            if (referrerId) {
                const commission = Math.floor(amount * 0.20); // 20%
                if (commission > 0) {
                    await client.query('UPDATE users SET points = points + $1, referral_earnings = referral_earnings + $1 WHERE telegram_id = $2', [commission, referrerId]);
                    await client.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, $2, $3)', [referrerId, commission, 'REFERRAL']);
                }
            }
        }

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[DB] Add Points Error', e);
    } finally {
        client.release();
    }
}

// --- DASHBOARD STATS ---
export async function getEarningsStats(telegramId) {
    const today = new Date();
    today.setHours(0,0,0,0);
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Today's Earnings
    const todayRes = await pool.query(
        `SELECT SUM(amount) as total FROM earnings_history WHERE telegram_id = $1 AND type = 'TASK' AND created_at >= $2`,
        [telegramId, today.toISOString()]
    );

    // Yesterday's Earnings
    const yesterdayRes = await pool.query(
        `SELECT SUM(amount) as total FROM earnings_history WHERE telegram_id = $1 AND type = 'TASK' AND created_at >= $2 AND created_at < $3`,
        [telegramId, yesterday.toISOString(), today.toISOString()]
    );

    return {
        today: todayRes.rows[0].total || 0,
        yesterday: yesterdayRes.rows[0].total || 0
    };
}

export async function getHistory(telegramId, type = 'EARNINGS') {
    if (type === 'WITHDRAWAL') {
        const res = await pool.query('SELECT * FROM withdrawals WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 10', [telegramId]);
        return res.rows;
    } else {
        const res = await pool.query('SELECT * FROM earnings_history WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 10', [telegramId]);
        return res.rows;
    }
}

export async function getReferrals(telegramId) {
    const res = await pool.query('SELECT telegram_id, joined_at FROM users WHERE referrer_id = $1 ORDER BY joined_at DESC LIMIT 5', [telegramId]);
    const countRes = await pool.query('SELECT COUNT(*) FROM users WHERE referrer_id = $1', [telegramId]);
    return { list: res.rows, total: parseInt(countRes.rows[0].count) };
}

// --- BANKING ---
export async function updateBank(telegramId, bankName, accNum, accName) {
    await pool.query(
        `UPDATE users SET bank_name = $1, account_number = $2, account_name = $3 WHERE telegram_id = $4`,
        [bankName, accNum, accName, telegramId]
    );
}

export async function createWithdrawal(telegramId, points, ngn) {
    await pool.query('UPDATE users SET points = points - $1 WHERE telegram_id = $2', [points, telegramId]);
    const res = await pool.query(
        `INSERT INTO withdrawals (telegram_id, amount_points, amount_ngn) VALUES ($1, $2, $3) RETURNING id`,
        [telegramId, points, ngn]
    );
    return res.rows[0].id;
}

// --- EXISTING SESSION HELPERS ---
export async function saveSessionToDb(sessionId, phone, credsData, telegramUserId, antimsg, autosave) {
    try {
        await pool.query(
            `INSERT INTO wa_sessions (session_id, phone, creds, antimsg, autosave, telegram_user_id) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             ON CONFLICT (session_id) 
             DO UPDATE SET creds = $3, phone = $2, antimsg = $4, autosave = $5, telegram_user_id = $6`,
            [sessionId, phone, credsData, antimsg, autosave, telegramUserId]
        );
    } catch (e) { console.error('[DB] Save Session Error', e); }
}

export async function getAllSessions(telegramUserId = null) {
    try {
        let query = 'SELECT * FROM wa_sessions';
        let params = [];
        if (telegramUserId) {
            query += ' WHERE telegram_user_id = $1';
            params = [telegramUserId];
        }
        const res = await pool.query(query, params);
        return res.rows;
    } catch (e) { return []; }
}

export async function deleteSessionFromDb(sessionId) {
    try {
        await pool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]);
        await deleteShortId(sessionId);
    } catch (e) { console.error('[DB] Delete Session Error', e); }
}

// --- ID & NUMBER HELPERS ---
export async function getShortId(sessionFolder) {
    try { const res = await pool.query('SELECT short_id FROM wa_ids WHERE session_folder = $1', [sessionFolder]); return res.rows[0]?.short_id; } catch (e) { return null; }
}
export async function saveShortId(sessionFolder, shortId) {
    try { await pool.query(`INSERT INTO wa_ids (session_folder, short_id) VALUES ($1, $2) ON CONFLICT (session_folder) DO NOTHING`, [sessionFolder, shortId]); } catch (e) {}
}
export async function deleteShortId(sessionFolder) {
    try { await pool.query('DELETE FROM wa_ids WHERE session_folder = $1', [sessionFolder]); } catch (e) {}
}
export async function addNumbersToDb(nums) { 
    if(!nums.length) return;
    const client = await pool.connect();
    try { await client.query('BEGIN'); for(const n of nums) await client.query('INSERT INTO broadcast_numbers (phone) VALUES ($1) ON CONFLICT DO NOTHING', [n]); await client.query('COMMIT'); } catch{ await client.query('ROLLBACK'); } finally { client.release(); }
}
export async function getAllNumbers() { try { const r = await pool.query('SELECT phone FROM broadcast_numbers'); return r.rows.map(x=>x.phone); } catch { return []; } }
export async function countNumbers() { try { const r = await pool.query('SELECT COUNT(*) FROM broadcast_numbers'); return parseInt(r.rows[0].count); } catch { return 0; } }
export async function deleteNumbers(nums) { if(!nums.length) return; const c = await pool.connect(); try { await c.query('BEGIN'); await c.query('DELETE FROM broadcast_numbers WHERE phone = ANY($1)', [nums]); await c.query('COMMIT'); } catch { await c.query('ROLLBACK'); } finally { c.release(); } }
export async function clearAllNumbers() { await pool.query('DELETE FROM broadcast_numbers'); }
export async function addToBlacklist(p) { await pool.query('INSERT INTO blacklist (phone) VALUES ($1) ON CONFLICT DO NOTHING', [p]); }
export async function getBlacklist() { const r = await pool.query('SELECT phone FROM blacklist'); return r.rows.map(x=>x.phone); }
export async function setAntiMsgStatus(sid, status) { await pool.query('UPDATE wa_sessions SET antimsg = $1 WHERE session_id = $2', [status, sid]); }
export async function setAutoSaveStatus(sid, status) { await pool.query('UPDATE wa_sessions SET autosave = $1 WHERE session_id = $2', [status, sid]); }
