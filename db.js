import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

export async function initDb() {
    const client = await pool.connect();
    try {
        // Sessions Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS wa_sessions (
                session_id TEXT PRIMARY KEY,
                phone TEXT,
                creds TEXT,
                antimsg BOOLEAN DEFAULT FALSE,
                autosave BOOLEAN DEFAULT FALSE,
                telegram_user_id TEXT,
                connected_at TIMESTAMP -- New column for duration
            );
        `);
        
        // Safe Migrations
        await client.query(`ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS antimsg BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS autosave BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS telegram_user_id TEXT;`);
        await client.query(`ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS connected_at TIMESTAMP;`);
        
        await client.query(`CREATE TABLE IF NOT EXISTS wa_ids (session_folder TEXT PRIMARY KEY, short_id TEXT UNIQUE);`);
        await client.query(`CREATE TABLE IF NOT EXISTS broadcast_numbers (phone TEXT PRIMARY KEY);`);
        await client.query(`CREATE TABLE IF NOT EXISTS blacklist (phone TEXT PRIMARY KEY);`);
        await client.query(`CREATE TABLE IF NOT EXISTS users (telegram_id TEXT PRIMARY KEY, points INTEGER DEFAULT 0, referral_earnings INTEGER DEFAULT 0, referrer_id TEXT, bank_name TEXT, account_number TEXT, account_name TEXT, is_banned BOOLEAN DEFAULT FALSE, joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS earnings_history (id SERIAL PRIMARY KEY, telegram_id TEXT, amount INTEGER, type TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await client.query(`CREATE TABLE IF NOT EXISTS withdrawals (id SERIAL PRIMARY KEY, telegram_id TEXT, amount_points INTEGER, amount_ngn INTEGER, status TEXT DEFAULT 'PENDING', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);

        console.log('[DB] Tables initialized.');
    } catch (err) {
        console.error('[DB ERROR]', err);
    } finally {
        client.release();
    }
}

// --- SESSIONS ---
export async function saveSessionToDb(sessionId, phone, credsData, telegramUserId, antimsg, autosave) {
    try {
        // Update or Insert. If inserting, set connected_at. If updating, keep existing connected_at unless it's null.
        await pool.query(
            `INSERT INTO wa_sessions (session_id, phone, creds, antimsg, autosave, telegram_user_id, connected_at) 
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) 
             ON CONFLICT (session_id) 
             DO UPDATE SET creds = $3, phone = $2, antimsg = $4, autosave = $5, telegram_user_id = $6`,
            [sessionId, phone, credsData, antimsg, autosave, telegramUserId]
        );
    } catch (e) { console.error('[DB] Save Session Error', e); }
}

// Helper to update connection time explicitly
export async function updateConnectionTime(sessionId) {
    try {
        await pool.query('UPDATE wa_sessions SET connected_at = CURRENT_TIMESTAMP WHERE session_id = $1', [sessionId]);
    } catch(e) {}
}

export async function setAntiMsgStatus(sessionId, status) {
    try {
        await pool.query('UPDATE wa_sessions SET antimsg = $1 WHERE session_id = $2', [status, sessionId]);
    } catch (e) { console.error('[DB] AntiMsg Update Error', e); }
}

export async function setAutoSaveStatus(sessionId, status) {
    try {
        await pool.query('UPDATE wa_sessions SET autosave = $1 WHERE session_id = $2', [status, sessionId]);
    } catch (e) { console.error('[DB] AutoSave Update Error', e); }
}

export async function getAllSessions(telegramUserId = null) {
    try {
        let queryText = 'SELECT * FROM wa_sessions';
        let queryParams = [];

        if (telegramUserId) {
            queryText += ' WHERE telegram_user_id = $1';
            queryParams = [telegramUserId.toString()];
        }
        
        const res = await pool.query(queryText, queryParams);
        return res.rows;
    } catch (e) { return []; }
}

export async function deleteSessionFromDb(sessionId) {
    try {
        await pool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]);
        await deleteShortId(sessionId);
    } catch (e) { console.error('[DB] Delete Session Error', e); }
}

// --- ID, NUMBERS, BLACKLIST, USER (Standard) ---
export async function getShortId(sessionFolder) { try { const res = await pool.query('SELECT short_id FROM wa_ids WHERE session_folder = $1', [sessionFolder]); return res.rows[0]?.short_id || null; } catch (e) { return null; } }
export async function saveShortId(sessionFolder, shortId) { try { await pool.query(`INSERT INTO wa_ids (session_folder, short_id) VALUES ($1, $2) ON CONFLICT (session_folder) DO NOTHING`, [sessionFolder, shortId]); } catch (e) {} }
export async function deleteShortId(sessionFolder) { try { await pool.query('DELETE FROM wa_ids WHERE session_folder = $1', [sessionFolder]); } catch (e) {} }
export async function addNumbersToDb(nums) { if(!nums.length) return; const c = await pool.connect(); try { await c.query('BEGIN'); for(const n of nums) await c.query('INSERT INTO broadcast_numbers (phone) VALUES ($1) ON CONFLICT DO NOTHING', [n]); await c.query('COMMIT'); } catch{ await c.query('ROLLBACK'); } finally { c.release(); } }
export async function getAllNumbers() { try { const r = await pool.query('SELECT phone FROM broadcast_numbers'); return r.rows.map(x=>x.phone); } catch { return []; } }
export async function countNumbers() { try { const r = await pool.query('SELECT COUNT(*) FROM broadcast_numbers'); return parseInt(r.rows[0].count); } catch { return 0; } }
export async function deleteNumbers(nums) { if(!nums.length) return; const c = await pool.connect(); try { await c.query('BEGIN'); await c.query('DELETE FROM broadcast_numbers WHERE phone = ANY($1)', [nums]); await c.query('COMMIT'); } catch { await c.query('ROLLBACK'); } finally { c.release(); } }
export async function clearAllNumbers() { await pool.query('DELETE FROM broadcast_numbers'); }
export async function addToBlacklist(p) { await pool.query('INSERT INTO blacklist (phone) VALUES ($1) ON CONFLICT DO NOTHING', [p]); }
export async function getBlacklist() { const r = await pool.query('SELECT phone FROM blacklist'); return r.rows.map(x=>x.phone); }
export async function getUser(tid) { const r = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tid]); return r.rows[0]; }
export async function createUser(tid, rid) { try { if(rid && rid!==tid) await pool.query('INSERT INTO users (telegram_id, referrer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tid, rid]); else await pool.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING', [tid]); } catch {} }
export async function banUser(tid, s) { await pool.query('UPDATE users SET is_banned = $1 WHERE telegram_id = $2', [s, tid]); }
export async function addPoints(tid, amt, type='TASK') { 
    const c = await pool.connect(); 
    try { 
        await c.query('BEGIN'); 
        await c.query('UPDATE users SET points = points + $1 WHERE telegram_id = $2', [amt, tid]); 
        await c.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, $2, $3)', [tid, amt, type]);
        if(type === 'TASK') {
            const u = await c.query('SELECT referrer_id FROM users WHERE telegram_id = $1', [tid]);
            const rid = u.rows[0]?.referrer_id;
            if(rid) {
                const comm = Math.floor(amt * 0.20);
                if(comm > 0) {
                     await c.query('UPDATE users SET points = points + $1, referral_earnings = referral_earnings + $1 WHERE telegram_id = $2', [comm, rid]);
                     await c.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, $2, $3)', [rid, comm, 'REFERRAL']);
                }
            }
        }
        await c.query('COMMIT'); 
    } catch { await c.query('ROLLBACK'); } finally { c.release(); } 
}
export async function getEarningsStats(tid) {
    const t = new Date(); t.setHours(0,0,0,0);
    const y = new Date(t); y.setDate(y.getDate() - 1);
    const tr = await pool.query(`SELECT SUM(amount) as total FROM earnings_history WHERE telegram_id = $1 AND type = 'TASK' AND created_at >= $2`, [tid, t.toISOString()]);
    const yr = await pool.query(`SELECT SUM(amount) as total FROM earnings_history WHERE telegram_id = $1 AND type = 'TASK' AND created_at >= $2 AND created_at < $3`, [tid, y.toISOString(), t.toISOString()]);
    return { today: tr.rows[0].total || 0, yesterday: yr.rows[0].total || 0 };
}
export async function getHistory(tid, type) {
    const table = type === 'WITHDRAWAL' ? 'withdrawals' : 'earnings_history';
    const res = await pool.query(`SELECT * FROM ${table} WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 10`, [tid]);
    return res.rows;
}
export async function getReferrals(tid) {
    const r = await pool.query('SELECT telegram_id, joined_at FROM users WHERE referrer_id = $1 ORDER BY joined_at DESC LIMIT 5', [tid]);
    const c = await pool.query('SELECT COUNT(*) FROM users WHERE referrer_id = $1', [tid]);
    return { list: r.rows, total: parseInt(c.rows[0].count) };
}
export async function updateBank(tid, bank, acc, name) { await pool.query('UPDATE users SET bank_name = $1, account_number = $2, account_name = $3 WHERE telegram_id = $4', [bank, acc, name, tid]); }
export async function createWithdrawal(tid, pts, ngn) { await pool.query('UPDATE users SET points = points - $1 WHERE telegram_id = $2', [pts, tid]); const r = await pool.query('INSERT INTO withdrawals (telegram_id, amount_points, amount_ngn) VALUES ($1, $2, $3) RETURNING id', [tid, pts, ngn]); return r.rows[0].id; }
