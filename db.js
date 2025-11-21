import pg from 'pg';
import 'dotenv/config';

// Connect to Postgres
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render/Heroku
});

// Initialize Tables
export async function initDb() {
    const client = await pool.connect();
    try {
        // Table for WhatsApp Sessions
        await client.query(`
            CREATE TABLE IF NOT EXISTS wa_sessions (
                session_id TEXT PRIMARY KEY,
                phone TEXT,
                creds TEXT
            );
        `);
        // Table for Broadcast Numbers
        await client.query(`
            CREATE TABLE IF NOT EXISTS broadcast_numbers (
                phone TEXT PRIMARY KEY
            );
        `);
        console.log('[DB] Tables initialized.');
    } catch (err) {
        console.error('[DB ERROR] Init failed:', err);
    } finally {
        client.release();
    }
}

// --- SESSION METHODS ---
export async function saveSessionToDb(sessionId, phone, credsData) {
    try {
        await pool.query(
            `INSERT INTO wa_sessions (session_id, phone, creds) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (session_id) 
             DO UPDATE SET creds = $3, phone = $2`,
            [sessionId, phone, credsData]
        );
    } catch (e) { console.error('[DB] Save Session Error', e); }
}

export async function getAllSessions() {
    try {
        const res = await pool.query('SELECT * FROM wa_sessions');
        return res.rows;
    } catch (e) { return []; }
}

export async function deleteSessionFromDb(sessionId) {
    try {
        await pool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]);
    } catch (e) { console.error('[DB] Delete Session Error', e); }
}

// --- NUMBER METHODS ---
export async function addNumbersToDb(numbersArray) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const num of numbersArray) {
            await client.query(
                'INSERT INTO broadcast_numbers (phone) VALUES ($1) ON CONFLICT DO NOTHING', 
                [num]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[DB] Add Numbers Error', e);
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

export async function clearAllNumbers() {
    try {
        await pool.query('DELETE FROM broadcast_numbers');
    } catch (e) { console.error('[DB] Clear Numbers Error', e); }
}
