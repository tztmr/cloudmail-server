import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * 基于 SQLite 的 KV 存储适配器，模拟 Cloudflare KV
 * 支持:
 *  - put(key, value, { metadata?, expirationTtl? })
 *  - get(key, { type: 'json' | 'text' | 'arrayBuffer' })
 *  - getWithMetadata(key, { type })
 *  - delete(key)
 *  - list({ prefix, limit })
 */
export function createKVAdapter(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 使用单独的 kv 库文件或复用主库，这里为了简单复用同一个 db 文件
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');

  // 初始化 KV 表
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT,
      metadata TEXT,
      expiration INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_kv_expiration ON kv_store(expiration);
  `);

  const getStmt = sqlite.prepare('SELECT value, metadata, expiration FROM kv_store WHERE key = ?');
  const putStmt = sqlite.prepare(`
    INSERT INTO kv_store (key, value, metadata, expiration)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, metadata=excluded.metadata, expiration=excluded.expiration
  `);
  const delStmt = sqlite.prepare('DELETE FROM kv_store WHERE key = ?');
  const listStmt = sqlite.prepare(`
    SELECT key, metadata, expiration FROM kv_store
    WHERE key LIKE ? || '%' AND (expiration IS NULL OR expiration > ?)
    ORDER BY key LIMIT ?
  `);
  const cleanupStmt = sqlite.prepare('DELETE FROM kv_store WHERE expiration IS NOT NULL AND expiration <= ?');

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function isExpired(row) {
    return row && row.expiration && row.expiration <= nowSec();
  }

  const kv = {
    async put(key, value, options = {}) {
      let valStr;
      if (value instanceof ArrayBuffer || value instanceof Uint8Array || Buffer.isBuffer(value)) {
        // 对于二进制 (以前 KV 存附件)，我们 base64 存储
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        valStr = 'b64:' + buf.toString('base64');
      } else if (typeof value === 'object') {
        valStr = JSON.stringify(value);
      } else {
        valStr = String(value);
      }

      const metaStr = options.metadata ? JSON.stringify(options.metadata) : null;
      let exp = null;
      if (options.expirationTtl) {
        exp = nowSec() + Number(options.expirationTtl);
      } else if (options.expiration) {
        exp = Number(options.expiration);
      }

      putStmt.run(key, valStr, metaStr, exp);
    },

    async get(key, options = {}) {
      // 先清理过期
      try { cleanupStmt.run(nowSec()); } catch (_) {}

      const row = getStmt.get(key);
      if (!row || isExpired(row)) {
        if (row && isExpired(row)) delStmt.run(key);
        return null;
      }

      let v = row.value;
      if (typeof v === 'string' && v.startsWith('b64:')) {
        const b64 = v.slice(4);
        if (options.type === 'arrayBuffer') {
          return Buffer.from(b64, 'base64').buffer;
        }
        return Buffer.from(b64, 'base64').toString(); // 降级
      }

      if (options.type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },

    async getWithMetadata(key, options = {}) {
      try { cleanupStmt.run(nowSec()); } catch (_) {}

      const row = getStmt.get(key);
      if (!row || isExpired(row)) {
        if (row && isExpired(row)) delStmt.run(key);
        return { value: null, metadata: null };
      }

      let value = row.value;
      const metadata = row.metadata ? JSON.parse(row.metadata) : null;

      if (typeof value === 'string' && value.startsWith('b64:')) {
        const buf = Buffer.from(value.slice(4), 'base64');
        if (options.type === 'arrayBuffer') {
          value = buf.buffer;
        } else {
          value = buf;
        }
      } else if (options.type === 'json' && typeof value === 'string') {
        try { value = JSON.parse(value); } catch {}
      }

      return { value, metadata };
    },

    async delete(key) {
      if (Array.isArray(key)) {
        const delMany = sqlite.prepare('DELETE FROM kv_store WHERE key = ?');
        const tx = sqlite.transaction((keys) => keys.forEach(k => delMany.run(k)));
        tx(key);
      } else {
        delStmt.run(key);
      }
    },

    async list(options = {}) {
      try { cleanupStmt.run(nowSec()); } catch (_) {}

      const prefix = options.prefix || '';
      const limit = options.limit || 1000;
      const rows = listStmt.all(prefix, nowSec(), limit);

      return {
        keys: rows.map(r => ({
          name: r.key,
          metadata: r.metadata ? JSON.parse(r.metadata) : null,
          expiration: r.expiration || null
        })),
        list_complete: rows.length < limit,
        cursor: null
      };
    }
  };

  return kv;
}

export default createKVAdapter;
