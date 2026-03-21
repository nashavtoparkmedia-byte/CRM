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

    // Promisified database methods
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    // Initialize database tables
    async init() {
        try {
            await this.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_id TEXT UNIQUE,
                    username TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    full_name TEXT,
                    phone TEXT,
                    state TEXT DEFAULT 'IDLE',
                    status TEXT DEFAULT 'Opened',
                    vu_link TEXT,
                    sts_link TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await this.run(`
                CREATE TABLE IF NOT EXISTS actions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_id TEXT,
                    action_type TEXT,
                    payload TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await this.run(`
                CREATE TABLE IF NOT EXISTS connection_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_id TEXT UNIQUE,
                    username TEXT,
                    full_name TEXT,
                    phone TEXT,
                    vu_link TEXT,
                    sts_link TEXT,
                    status TEXT DEFAULT 'New',
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Ensure columns exist (migrations)
            const migrations = [
                `ALTER TABLE users ADD COLUMN state TEXT DEFAULT 'IDLE'`,
                `ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'Opened'`,
                `ALTER TABLE users ADD COLUMN vu_link TEXT`,
                `ALTER TABLE users ADD COLUMN sts_link TEXT`
            ];

            for (const sql of migrations) {
                try {
                    await this.run(sql);
                } catch (err) {
                    if (!err.message.includes('duplicate column name')) {
                        logger.error(`Migration error (${sql}):`, err.message);
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
            await this.run(
                `INSERT OR IGNORE INTO users (telegram_id, username, first_name, last_name, created_at) 
                 VALUES (?, ?, ?, ?, datetime('now'))`,
                [telegramId.toString(), username, firstName, lastName]
            );
            logger.debug(`User registered: ${telegramId}`);
        } catch (err) {
            logger.error('User registration error:', err);
        }
    }

    async updateUser(telegramId, data) {
        try {
            const keys = Object.keys(data);
            const values = Object.values(data);
            const setClause = keys.map(key => `${key} = ?`).join(', ');

            await this.run(
                `UPDATE users SET ${setClause} WHERE telegram_id = ?`,
                [...values, telegramId.toString()]
            );
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

    async upsertConnectionLocal(telegramId, username, data) {
        try {
            // Check if exists
            const existing = await this.get('SELECT id FROM connection_requests WHERE telegram_id = ?', [telegramId.toString()]);

            if (existing) {
                const keys = Object.keys(data);
                const values = Object.values(data);
                const setClause = keys.map(key => `${key} = ?`).join(', ');
                await this.run(
                    `UPDATE connection_requests SET ${setClause}, updated_at = datetime('now') WHERE telegram_id = ?`,
                    [...values, telegramId.toString()]
                );
            } else {
                const keys = ['telegram_id', 'username', ...Object.keys(data)];
                const placeholders = keys.map(() => '?').join(', ');
                const values = [telegramId.toString(), username, ...Object.values(data)];
                await this.run(
                    `INSERT INTO connection_requests (${keys.join(', ')}) VALUES (${placeholders})`,
                    values
                );
            }
        } catch (err) {
            logger.error('Upsert connection local error:', err);
        }
    }

    async getUserByTelegramId(telegramId) {
        return await this.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId.toString()]);
    }

    async getAllUsers() {
        return await this.all('SELECT * FROM users ORDER BY created_at DESC');
    }

    async getRecentUsers(limit = 10) {
        return await this.all(
            'SELECT * FROM users ORDER BY created_at DESC LIMIT ?',
            [limit]
        );
    }

    // Action methods
    async logAction(telegramId, username, actionType, payload = {}) {
        try {
            // Register user if not exists (minimal)
            await this.run(
                `INSERT OR IGNORE INTO users (telegram_id, username, created_at) 
                 VALUES (?, ?, datetime('now'))`,
                [telegramId.toString(), username]
            );

            // Log action
            await this.run(
                `INSERT INTO actions (telegram_id, action_type, payload) VALUES (?, ?, ?)`,
                [telegramId.toString(), actionType, JSON.stringify(payload)]
            );

            logger.debug(`Action logged: ${actionType} for user ${telegramId}`);
        } catch (err) {
            logger.error('Logging error:', err);
        }
    }

    async getRecentActions(limit = 20) {
        return await this.all(
            'SELECT * FROM actions ORDER BY created_at DESC LIMIT ?',
            [limit]
        );
    }

    async getActionsByType(actionType, limit = 100) {
        return await this.all(
            'SELECT * FROM actions WHERE action_type = ? ORDER BY created_at DESC LIMIT ?',
            [actionType, limit]
        );
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
