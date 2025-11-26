import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render/Heroku
});

export async function initDb() {
    const client = await pool.connect();
    try {
        // 1. SESSIONS TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS wa_sessions (
                session_id TEXT PRIMARY KEY,
                phone TEXT,
                creds TEXT,
                antimsg BOOLEAN DEFAULT FALSE,
                autosave BOOLEAN DEFAULT FALSE,
                telegram_user_id TEXT,
                connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                short_id TEXT UNIQUE,
                last_points_award TIMESTAMP,
                last_disconnect TIMESTAMP,
                last_message_sent TIMESTAMP
            );
        `);
        
        // 2. ID MAPPING TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS wa_ids (
                session_folder TEXT PRIMARY KEY,
                short_id TEXT UNIQUE
            );
        `);
        
        // 3. USERS TABLE (Financials & Profile)
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
                is_verified BOOLEAN DEFAULT FALSE,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_points_award TIMESTAMP,
                ip_address TEXT,
                user_address TEXT,
                user_name TEXT,
                user_email TEXT,
                device_info TEXT,
                verification_timestamp TIMESTAMP
            );
        `);
        
        // 4. DATA TABLES
        await client.query(`CREATE TABLE IF NOT EXISTS broadcast_numbers (phone TEXT PRIMARY KEY);`);
        await client.query(`CREATE TABLE IF NOT EXISTS blacklist (phone TEXT PRIMARY KEY);`);
        
        // 5. FINANCIAL TABLES
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
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS earnings_history (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT,
                amount INTEGER,
                type TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --- SAFE MIGRATIONS (Ensure columns exist for old DBs) ---
        const migrations = [
            `ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS antimsg BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS autosave BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS telegram_user_id TEXT`,
            `ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS short_id TEXT UNIQUE`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS ip_address TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS user_email TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS device_info TEXT`
        ];

        for (const query of migrations) {
            try { await client.query(query); } catch (e) { /* Ignore if exists */ }
        }

        console.log('[DB] Database initialized successfully.');
    } catch (err) {
        console.error('[DB FATAL]', err);
    } finally {
        client.release();
    }
}

// ================= SESSIONS =================

export async function saveSessionToDb(sessionId, phone, credsData, telegramUserId, antimsg, autosave, shortId = null) {
    try {
        await pool.query(
            `INSERT INTO wa_sessions (session_id, phone, creds, antimsg, autosave, telegram_user_id, connected_at, short_id) 
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7) 
             ON CONFLICT (session_id) 
             DO UPDATE SET creds = $3, phone = $2, antimsg = $4, autosave = $5, telegram_user_id = $6, short_id = $7, connected_at = CURRENT_TIMESTAMP`,
            [sessionId, phone, credsData, antimsg, autosave, telegramUserId, shortId]
        );
    } catch (e) { console.error('[DB] Save Session Error', e.message); }
}

export async function updateConnectionTime(sessionId) {
    try { await pool.query('UPDATE wa_sessions SET connected_at = CURRENT_TIMESTAMP WHERE session_id = $1', [sessionId]); } catch(e) {}
}

export async function setAntiMsgStatus(sessionId, status) {
    try {
        await pool.query('UPDATE wa_sessions SET antimsg = $1 WHERE session_id = $2', [status, sessionId]);
    } catch (e) { console.error('[DB] AntiMsg Update Error:', e.message); }
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

export async function getSessionByShortId(shortId) {
    try {
        const res = await pool.query('SELECT * FROM wa_sessions WHERE short_id = $1', [shortId]);
        return res.rows[0] || null;
    } catch (e) { return null; }
}

export async function deleteSessionFromDb(sessionId) {
    try {
        await pool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]);
        await deleteShortId(sessionId); 
    } catch (e) { console.error('[DB] Delete Session Error', e); }
}

// ================= SHORT IDS =================

export async function getShortId(sessionFolder) {
    try {
        const res = await pool.query('SELECT short_id FROM wa_ids WHERE session_folder = $1', [sessionFolder]);
        return res.rows[0]?.short_id || null;
    } catch (e) { return null; }
}

export async function saveShortId(sessionFolder, shortId) {
    try {
        await pool.query(`INSERT INTO wa_ids (session_folder, short_id) VALUES ($1, $2) ON CONFLICT (session_folder) DO NOTHING`, [sessionFolder, shortId]);
    } catch (e) {}
}

export async function deleteShortId(sessionFolder) {
    try {
        await pool.query('DELETE FROM wa_ids WHERE session_folder = $1', [sessionFolder]);
    } catch (e) {}
}

// ================= NUMBERS & CONTACTS =================

export async function addNumbersToDb(numbersArray) {
    if (!numbersArray || numbersArray.length === 0) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const num of numbersArray) {
            if (num && num.length >= 7 && num.length <= 15) {
                await client.query('INSERT INTO broadcast_numbers (phone) VALUES ($1) ON CONFLICT DO NOTHING', [num]);
            }
        }
        await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); } finally { client.release(); }
}

export async function getAllNumbers() {
    try {
        const res = await pool.query('SELECT phone FROM broadcast_numbers');
        return res.rows.map(r => r.phone);
    } catch (e) { return []; }
}

export async function checkNumberInDb(phone) {
    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const res = await pool.query('SELECT 1 FROM broadcast_numbers WHERE phone = $1', [cleanPhone]);
        return res.rowCount > 0;
    } catch (e) { return false; }
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
    } catch (e) { await client.query('ROLLBACK'); } finally { client.release(); }
}

export async function clearAllNumbers() {
    try { await pool.query('DELETE FROM broadcast_numbers'); } catch (e) {}
}

// ================= USER & POINTS SYSTEM =================

export async function getUser(telegramId) {
    const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    return res.rows[0];
}

export async function createUser(telegramId, referrerId = null) {
    try {
        if (referrerId && referrerId !== telegramId) {
            await pool.query(`INSERT INTO users (telegram_id, referrer_id) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING`, [telegramId, referrerId]);
        } else {
            await pool.query(`INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING`, [telegramId]);
        }
        return true;
    } catch (e) { return false; }
}

export async function addPoints(telegramId, amount, type = 'TASK') {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET points = points + $1 WHERE telegram_id = $2', [amount, telegramId]);
        await client.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, $2, $3)', [telegramId, amount, type]);
        await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); } finally { client.release(); }
}

export async function addPointsToUser(telegramId, points) {
    // Alias for addPoints to match external calls
    return await addPoints(telegramId, points, 'ADMIN_ADJUST');
}

export async function awardHourlyPoints(connectedFolders = []) {
    const client = await pool.connect();
    try {
        const now = new Date();
        // Only get sessions that have credentials (active)
        const res = await client.query(`SELECT * FROM wa_sessions WHERE creds IS NOT NULL`);
        
        for (const session of res.rows) {
            const userId = session.telegram_user_id;
            if (!userId) continue;
            
            // Only award if this specific session is currently connected in memory
            if (connectedFolders.length > 0 && !connectedFolders.includes(session.session_id)) {
                continue;
            }
            
            const lastAward = session.last_points_award ? new Date(session.last_points_award) : null;
            
            // Check if 1 hour (3600000 ms) has passed
            if (!lastAward || (now - lastAward) >= 3600000) {
                await client.query('BEGIN');
                
                // 1. Award User (+20)
                await client.query('UPDATE users SET points = points + 20, last_points_award = $1 WHERE telegram_id = $2', [now, userId]);
                await client.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, 20, \'HOURLY\')', [userId]);
                
                // 2. Update Session Timestamp
                await client.query('UPDATE wa_sessions SET last_points_award = $1 WHERE session_id = $2', [now, session.session_id]);
                
                // 3. Award Referrer (+10)
                const userRes = await client.query('SELECT referrer_id FROM users WHERE telegram_id = $1', [userId]);
                const referrerId = userRes.rows[0]?.referrer_id;
                
                if (referrerId) {
                    await client.query('UPDATE users SET points = points + 10, referral_earnings = referral_earnings + 10 WHERE telegram_id = $1', [referrerId]);
                    await client.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, 10, \'REFERRAL_HOURLY\')', [referrerId]);
                }
                
                await client.query('COMMIT');
            }
        }
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[DB] Award hourly points error:', e.message);
    } finally {
        client.release();
    }
}

export async function deductOnDisconnect(sessionId) {
    const client = await pool.connect();
    try {
        const sessionRes = await client.query('SELECT telegram_user_id FROM wa_sessions WHERE session_id = $1', [sessionId]);
        if (sessionRes.rows.length === 0) return;
        
        const userId = sessionRes.rows[0].telegram_user_id;
        if (!userId) return;

        // Deduct 100 points
        const deduction = 100;
        const userRes = await client.query('SELECT points FROM users WHERE telegram_id = $1', [userId]);
        const currentPoints = userRes.rows[0]?.points || 0;
        
        if (currentPoints > 0) {
            await client.query('UPDATE users SET points = points - $1 WHERE telegram_id = $2', [deduction, userId]);
            await client.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, $2, \'PENALTY_DISCONNECT\')', [userId, -deduction]);
        }
        await client.query('UPDATE wa_sessions SET last_disconnect = $1 WHERE session_id = $2', [new Date(), sessionId]);
    } catch(e) { console.error('Deduction error', e); } 
    finally { client.release(); }
}

export async function saveVerificationData(telegramId, name, address, email, ip, deviceInfo) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Check if new user
        const checkRes = await client.query('SELECT is_verified FROM users WHERE telegram_id = $1', [telegramId]);
        
        // If user doesn't exist, create them first
        if (checkRes.rows.length === 0) {
            await client.query('INSERT INTO users (telegram_id) VALUES ($1)', [telegramId]);
        }
        
        const isAlreadyVerified = checkRes.rows.length > 0 && checkRes.rows[0].is_verified;
        
        // Update Details
        await client.query(
            `UPDATE users SET user_name = $1, user_address = $2, user_email = $3, ip_address = $4, device_info = $5, verification_timestamp = CURRENT_TIMESTAMP, is_verified = true 
             WHERE telegram_id = $6`,
            [name, address, email, ip, deviceInfo, telegramId]
        );
        
        // Award Welcome Bonus (+200) ONLY if not previously verified
        if (!isAlreadyVerified) {
            await client.query('UPDATE users SET points = points + 200 WHERE telegram_id = $1', [telegramId]);
            await client.query('INSERT INTO earnings_history (telegram_id, amount, type) VALUES ($1, $2, \'WELCOME_BONUS\')', [telegramId, 200]);
        }
        
        await client.query('COMMIT');
    } catch (e) { 
        await client.query('ROLLBACK'); 
        console.error('[DB] Verification Save Error:', e.message);
    } finally {
        client.release();
    }
}

// ================= FINANCIALS & STATS =================

export async function getEarningsStats(telegramId) {
    const today = new Date(); today.setHours(0,0,0,0);
    const res = await pool.query(`SELECT SUM(amount) as total FROM earnings_history WHERE telegram_id = $1 AND type IN ('TASK', 'HOURLY', 'REFERRAL_HOURLY') AND created_at >= $2`, [telegramId, today.toISOString()]);
    return { today: res.rows[0].total || 0 };
}

export async function getReferrals(telegramId) {
    const res = await pool.query('SELECT COUNT(*) FROM users WHERE referrer_id = $1', [telegramId]);
    return { total: parseInt(res.rows[0].count) };
}

export async function updateBank(telegramId, bankName, accNum, accName) {
    await pool.query(`UPDATE users SET bank_name = $1, account_number = $2, account_name = $3 WHERE telegram_id = $4`, [bankName, accNum, accName, telegramId]);
}

export async function createWithdrawal(telegramId, points, ngn) {
    await pool.query('UPDATE users SET points = points - $1 WHERE telegram_id = $2', [points, telegramId]);
    const res = await pool.query(`INSERT INTO withdrawals (telegram_id, amount_points, amount_ngn) VALUES ($1, $2, $3) RETURNING id`, [telegramId, points, ngn]);
    return res.rows[0].id;
}

export async function getTodayEarnings(telegramId) {
    const res = await pool.query(`SELECT SUM(amount) as total FROM earnings_history WHERE telegram_id = $1 AND DATE(created_at) = CURRENT_DATE`, [telegramId]);
    return parseInt(res.rows[0]?.total || 0);
}

export async function getYesterdayEarnings(telegramId) {
    const res = await pool.query(`SELECT SUM(amount) as total FROM earnings_history WHERE telegram_id = $1 AND DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'`, [telegramId]);
    return parseInt(res.rows[0]?.total || 0);
}

export async function getWithdrawalHistory(telegramId, limit = 5) {
    const res = await pool.query(`SELECT id, amount_points, amount_ngn, status, created_at FROM withdrawals WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT $2`, [telegramId, limit]);
    return res.rows;
}

export async function getEarningsHistory(telegramId, limit = 5) {
    const res = await pool.query(`SELECT amount, type, created_at FROM earnings_history WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT $2`, [telegramId, limit]);
    return res.rows;
}

export async function isUserVerified(telegramId) {
    const res = await pool.query('SELECT is_verified FROM users WHERE telegram_id = $1', [telegramId]);
    return res.rows[0]?.is_verified || false;
}

export async function markUserVerified(telegramId) {
    await pool.query('UPDATE users SET is_verified = true WHERE telegram_id = $1', [telegramId]);
}

export async function updateWithdrawalStatus(withdrawalId, status) {
    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, withdrawalId]);
}

export async function getWithdrawalDetails(withdrawalId) {
    const res = await pool.query('SELECT telegram_id, amount_points FROM withdrawals WHERE id = $1', [withdrawalId]);
    return res.rows[0];
}

export async function deleteUserAccount(telegramId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM earnings_history WHERE telegram_id = $1', [telegramId]);
        await client.query('DELETE FROM withdrawals WHERE telegram_id = $1', [telegramId]);
        await client.query('DELETE FROM users WHERE telegram_id = $1', [telegramId]);
        await client.query('COMMIT');
        console.log('[DB] Deleted user:', telegramId);
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
