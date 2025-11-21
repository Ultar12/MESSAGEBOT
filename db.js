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
                telegram_user_id TEXT
            );
        `);
        
        // Safe Migration: Add columns if missing
        await client.query(`ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS antimsg BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS autosave BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS telegram_user_id TEXT;`);
        
        // Numbers Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS broadcast_numbers (
                phone TEXT PRIMARY KEY
            );
        `);

        // Blacklist Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS blacklist (
                phone TEXT PRIMARY KEY
            );
        `);

        console.log('[DB] Tables initialized.');
    } catch (err) {
        console.error('[DB ERROR]', err);
    } finally {
        client.release();
    }
}

// --- SESSIONS ---
export async function saveSessionToDb(sessionId, phone, credsData, telegramUserId, antimsg = false, autosave = false) {
    // FIX: Ensure parameter count matches SQL placeholders (1 to 6)
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

        // If a specific user ID is provided (for regular users)
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
    } catch (e) { console.error('[DB] Delete Session Error', e); }
}

// --- NUMBERS ---
export async function addNumbersToDb(numbersArray) {
    if (numbersArray.length === 0) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const num of numbersArray) {
            await client.query('INSERT INTO broadcast_numbers (phone) VALUES ($1) ON CONFLICT DO NOTHING', [num]);
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }
}

export async function getAllNumbers() {
    try {
        const res = await pool.query('SELECT phone FROM broadcast_numbers');
        return res.rows.map(r => r.phone);
    } catch (e) { return []; }
}

export async function countNumbers() {
    try {
        const res = await pool.query('SELECT COUNT(*) FROM broadcast_numbers');
        return parseInt(res.rows[0].count);
    } catch (e) { return 0; }
}

export async function deleteNumbers(numbersArray) {
    if (numbersArray.length === 0) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM broadcast_numbers WHERE phone = ANY($1)', [numbersArray]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }
}

export async function clearAllNumbers() {
    try {
        await pool.query('DELETE FROM broadcast_numbers');
    } catch (e) { console.error('[DB] Clear Numbers Error', e); }
}

// --- BLACKLIST ---
export async function addToBlacklist(phone) {
    try {
        await pool.query('INSERT INTO blacklist (phone) VALUES ($1) ON CONFLICT DO NOTHING', [phone]);
    } catch (e) { console.error('[DB] Blacklist Add Error', e); }
}

export async function getBlacklist() {
    try {
        const res = await pool.query('SELECT phone FROM blacklist');
        return res.rows.map(r => r.phone);
    } catch (e) { return []; }
}
