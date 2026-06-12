import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export function createKVAdapter(dbPath) {
	const dir = path.dirname(dbPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS kv_store (
			key TEXT PRIMARY KEY,
			value TEXT,
			metadata TEXT,
			expiration INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_kv_store_expiration ON kv_store(expiration);
	`);

	const getStmt = sqlite.prepare('SELECT value, metadata, expiration FROM kv_store WHERE key = ?');
	const putStmt = sqlite.prepare(`
		INSERT INTO kv_store (key, value, metadata, expiration)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			metadata = excluded.metadata,
			expiration = excluded.expiration
	`);
	const deleteStmt = sqlite.prepare('DELETE FROM kv_store WHERE key = ?');
	const cleanupStmt = sqlite.prepare('DELETE FROM kv_store WHERE expiration IS NOT NULL AND expiration <= ?');
	const listStmt = sqlite.prepare(`
		SELECT key, metadata, expiration FROM kv_store
		WHERE key LIKE ? || '%' AND (expiration IS NULL OR expiration > ?)
		ORDER BY key
		LIMIT ?
	`);

	function nowSec() {
		return Math.floor(Date.now() / 1000);
	}

	function encodeValue(value) {
		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Buffer.isBuffer(value)) {
			return `b64:${Buffer.from(value).toString('base64')}`;
		}
		if (typeof value === 'object') {
			return JSON.stringify(value);
		}
		return String(value);
	}

	function decodeValue(value, type) {
		if (typeof value === 'string' && value.startsWith('b64:')) {
			const buffer = Buffer.from(value.slice(4), 'base64');
			return type === 'arrayBuffer' ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer;
		}
		if (type === 'json') {
			try {
				return JSON.parse(value);
			} catch {
				return null;
			}
		}
		return value;
	}

	function isExpired(row) {
		return row?.expiration && row.expiration <= nowSec();
	}

	function readRow(key) {
		cleanupStmt.run(nowSec());
		const row = getStmt.get(key);
		if (isExpired(row)) {
			deleteStmt.run(key);
			return null;
		}
		return row || null;
	}

	return {
		async put(key, value, options = {}) {
			const metadata = options.metadata ? JSON.stringify(options.metadata) : null;
			const expiration = options.expiration
				? Number(options.expiration)
				: options.expirationTtl
					? nowSec() + Number(options.expirationTtl)
					: null;
			putStmt.run(key, encodeValue(value), metadata, expiration);
		},
		async get(key, options = {}) {
			const row = readRow(key);
			return row ? decodeValue(row.value, options.type) : null;
		},
		async getWithMetadata(key, options = {}) {
			const row = readRow(key);
			if (!row) {
				return { value: null, metadata: null };
			}
			return {
				value: decodeValue(row.value, options.type),
				metadata: row.metadata ? JSON.parse(row.metadata) : null
			};
		},
		async delete(key) {
			if (Array.isArray(key)) {
				const transaction = sqlite.transaction((keys) => keys.forEach((item) => deleteStmt.run(item)));
				transaction(key);
				return;
			}
			deleteStmt.run(key);
		},
		async list(options = {}) {
			cleanupStmt.run(nowSec());
			const prefix = options.prefix || '';
			const limit = options.limit || 1000;
			const rows = listStmt.all(prefix, nowSec(), limit);
			return {
				keys: rows.map((row) => ({
					name: row.key,
					metadata: row.metadata ? JSON.parse(row.metadata) : null,
					expiration: row.expiration || null
				})),
				list_complete: rows.length < limit,
				cursor: null
			};
		}
	};
}

export default createKVAdapter;
