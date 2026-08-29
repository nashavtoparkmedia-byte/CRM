const sqlite3 = require('sqlite3').verbose();
const config = require('./config');
const logger = require('./utils/logger');

class Database {
    constructor() {
        this.db = new sqlite3.Database(config.databasePath, (err) => {
            if (err) {
                logger.error('Error opening SQLite database:', err);
            } else {
                logger.info('Connected to SQLite database');
            }
        });
        this.init();
    }

    runCreateUsersTable() {
        return new Promise((resolve, reject) => this.db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT UNIQUE, username TEXT, first_name TEXT, last_name TEXT, full_name TEXT, phone TEXT, state TEXT DEFAULT 'IDLE', status TEXT DEFAULT 'Opened', vu_link TEXT, sts_link TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, function (err) { if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes }); }));
    }

    runCreateActionsTable() {
        return new Promise((resolve, reject) => this.db.run(`CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT, action_type TEXT, payload TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, function (err) { if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes }); }));
    }

    runAddColumnState() { return new Promise((resolve, reject) => this.db.run(`ALTER TABLE users ADD COLUMN state TEXT DEFAULT 'IDLE'`, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runAddColumnStatus() { return new Promise((resolve, reject) => this.db.run(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'Opened'`, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runAddColumnVuLink() { return new Promise((resolve, reject) => this.db.run(`ALTER TABLE users ADD COLUMN vu_link TEXT`, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runAddColumnStsLink() { return new Promise((resolve, reject) => this.db.run(`ALTER TABLE users ADD COLUMN sts_link TEXT`, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }

    runInsertUser(telegramId, username, firstName, lastName) { return new Promise((resolve, reject) => this.db.run(`INSERT OR IGNORE INTO users (telegram_id, username, first_name, last_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))`, [telegramId, username, firstName, lastName], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runInsertMinimalUser(telegramId, username) { return new Promise((resolve, reject) => this.db.run(`INSERT OR IGNORE INTO users (telegram_id, username, created_at) VALUES (?, ?, datetime('now'))`, [telegramId, username], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runInsertAction(telegramId, actionType, payload) { return new Promise((resolve, reject) => this.db.run(`INSERT INTO actions (telegram_id, action_type, payload) VALUES (?, ?, ?)`, [telegramId, actionType, payload], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdateUserField(telegramId, field, value) {
        if (field === 'state') return this.runUpdateState(telegramId, value);
        if (field === 'status') return this.runUpdateStatus(telegramId, value);
        if (field === 'username') return this.runUpdateUsername(telegramId, value);
        if (field === 'first_name') return this.runUpdateFirstName(telegramId, value);
        if (field === 'last_name') return this.runUpdateLastName(telegramId, value);
        if (field === 'full_name') return this.runUpdateFullName(telegramId, value);
        if (field === 'phone') return this.runUpdatePhone(telegramId, value);
        if (field === 'vu_link') return this.runUpdateVuLink(telegramId, value);
        if (field === 'sts_link') return this.runUpdateStsLink(telegramId, value);
        throw new Error(`unsupported user field: ${field}`);
    }
    runUpdateState(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET state = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdateStatus(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET status = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdateUsername(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET username = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdateFirstName(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET first_name = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdateLastName(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET last_name = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdateFullName(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET full_name = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdatePhone(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET phone = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdateVuLink(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET vu_link = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }
    runUpdateStsLink(id, value) { return new Promise((resolve, reject) => this.db.run(`UPDATE users SET sts_link = ? WHERE telegram_id = ?`, [value, id], function (err) { if (err) reject(err); else resolve({ changes: this.changes }); })); }

    getUserRow(telegramId) { return new Promise((resolve, reject) => this.db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId], (err, row) => err ? reject(err) : resolve(row))); }
    allUserRows() { return new Promise((resolve, reject) => this.db.all(`SELECT * FROM users ORDER BY created_at DESC`, [], (err, rows) => err ? reject(err) : resolve(rows))); }
    allRecentUserRows(limit) { return new Promise((resolve, reject) => this.db.all(`SELECT * FROM users ORDER BY created_at DESC LIMIT ?`, [limit], (err, rows) => err ? reject(err) : resolve(rows))); }
    allRecentActionRows(limit) { return new Promise((resolve, reject) => this.db.all(`SELECT * FROM actions ORDER BY created_at DESC LIMIT ?`, [limit], (err, rows) => err ? reject(err) : resolve(rows))); }
    allActionRowsByType(actionType, limit) { return new Promise((resolve, reject) => this.db.all(`SELECT * FROM actions WHERE action_type = ? ORDER BY created_at DESC LIMIT ?`, [actionType, limit], (err, rows) => err ? reject(err) : resolve(rows))); }
    allUserActivity(telegramId) { return new Promise((resolve, reject) => this.db.all(`SELECT action_type, COUNT(*) as count FROM actions WHERE telegram_id = ? GROUP BY action_type`, [telegramId], (err, rows) => err ? reject(err) : resolve(rows))); }
    getTotalUsers() { return new Promise((resolve, reject) => this.db.get(`SELECT COUNT(*) as count FROM users`, [], (err, row) => err ? reject(err) : resolve(row))); }
    getUsersToday() { return new Promise((resolve, reject) => this.db.get(`SELECT COUNT(*) as count FROM users WHERE date(created_at) = date('now')`, [], (err, row) => err ? reject(err) : resolve(row))); }
    getUsersYesterday() { return new Promise((resolve, reject) => this.db.get(`SELECT COUNT(*) as count FROM users WHERE date(created_at) = date('now', '-1 day')`, [], (err, row) => err ? reject(err) : resolve(row))); }
    getUsersLast7Days() { return new Promise((resolve, reject) => this.db.get(`SELECT COUNT(*) as count FROM users WHERE date(created_at) >= date('now', '-7 days')`, [], (err, row) => err ? reject(err) : resolve(row))); }
    getTotalActions() { return new Promise((resolve, reject) => this.db.get(`SELECT COUNT(*) as count FROM actions`, [], (err, row) => err ? reject(err) : resolve(row))); }
    allActionTypeCounts() { return new Promise((resolve, reject) => this.db.all(`SELECT action_type, COUNT(*) as count FROM actions GROUP BY action_type ORDER BY count DESC`, [], (err, rows) => err ? reject(err) : resolve(rows))); }
    getActionsToday() { return new Promise((resolve, reject) => this.db.get(`SELECT COUNT(*) as count FROM actions WHERE date(created_at) = date('now')`, [], (err, row) => err ? reject(err) : resolve(row))); }
    getStartedSurveyCount() { return new Promise((resolve, reject) => this.db.get(`SELECT COUNT(DISTINCT telegram_id) as count FROM actions WHERE action_type IN ('START_SURVEY', 'CONTROL_SURVEY')`, [], (err, row) => err ? reject(err) : resolve(row))); }
    getCompletedSurveyCount() { return new Promise((resolve, reject) => this.db.get(`SELECT COUNT(DISTINCT telegram_id) as count FROM actions WHERE action_type = 'SURVEY_COMPLETE'`, [], (err, row) => err ? reject(err) : resolve(row))); }

    // Initialize database tables
    async init() {
        try {
            await this.runCreateUsersTable();
            await this.runCreateActionsTable();

            // Ensure columns exist (migrations)
            const migrations = [this.runAddColumnState.bind(this), this.runAddColumnStatus.bind(this), this.runAddColumnVuLink.bind(this), this.runAddColumnStsLink.bind(this)];

            for (const migrate of migrations) {
                try {
                    await migrate();
                } catch (err) {
                    if (!err.message.includes('duplicate column name')) {
                        logger.error('Migration error:', err.message);
                    }
                }
            }

            logger.info('Database tables initialized');
        } catch (err) {
            logger.error('Database initialization error:', err);
        }
    }

    // User methods
    async registerUser(telegramId, username, firstName, lastName) {
        try {
            await this.runInsertUser(telegramId.toString(), username, firstName, lastName);
            logger.debug(`User registered: ${telegramId}`);
        } catch (err) {
            logger.error('User registration error:', err);
        }
    }

    async updateUser(telegramId, data) {
        try {
            for (const [key, value] of Object.entries(data)) await this.runUpdateUserField(telegramId.toString(), key, value);
            logger.debug(`User ${telegramId} updated with ${JSON.stringify(data)}`);
        } catch (err) {
            logger.error('User update error:', err);
        }
    }

    async setUserState(telegramId, state) {
        await this.updateUser(telegramId, { state });
    }

    async getUserState(telegramId) {
        const user = await this.getUserByTelegramId(telegramId);
        return user ? user.state : 'IDLE';
    }

    async getUserByTelegramId(telegramId) {
        return await this.getUserRow(telegramId.toString());
    }

    async getAllUsers() {
        return await this.allUserRows();
    }

    async getRecentUsers(limit = 10) {
        return await this.allRecentUserRows(limit);
    }

    // Action methods
    async logAction(telegramId, username, actionType, payload = {}) {
        try {
            // Register user if not exists (minimal)
            await this.runInsertMinimalUser(telegramId.toString(), username);

            // Log action
            await this.runInsertAction(telegramId.toString(), actionType, JSON.stringify(payload));

            logger.debug(`Action logged: ${actionType} for user ${telegramId}`);
        } catch (err) {
            logger.error('Logging error:', err);
        }
    }

    async getRecentActions(limit = 20) {
        return await this.allRecentActionRows(limit);
    }

    async getActionsByType(actionType, limit = 100) {
        return await this.allActionRowsByType(actionType, limit);
    }

    // Close connection
    close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) reject(err);
                else {
                    logger.info('Database connection closed');
                    resolve();
                }
            });
        });
    }
}

module.exports = new Database();
