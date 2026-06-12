import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * 创建兼容 Cloudflare D1 的适配器（基于 better-sqlite3）
 * 支持 prepare().bind().run() / .all()
 * 支持 batch()
 */
export function createD1Adapter(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  function makeStatement(sql) {
    let params = [];
    const stmtObj = {
      _sql: sql,
      _params: params,
      bind(...p) {
        params = p;
        stmtObj._params = params;
        return stmtObj;
      },
      async run() {
        try {
          const stmt = sqlite.prepare(sql);
          const info = stmt.run(params);
          return {
            success: true,
            meta: {
              changes: info.changes,
              last_row_id: info.lastInsertRowid,
              duration: 0
            }
          };
        } catch (e) {
          console.error('D1 run error:', e.message, 'SQL:', sql);
          throw e;
        }
      },
      async all() {
        try {
          const stmt = sqlite.prepare(sql);
          const rows = stmt.all(params);
          return { results: rows };
        } catch (e) {
          console.error('D1 all error:', e.message, 'SQL:', sql);
          throw e;
        }
      },
      async get() {
        try {
          const stmt = sqlite.prepare(sql);
          const row = stmt.get(params);
          return row || null;
        } catch (e) {
          console.error('D1 get error:', e.message, 'SQL:', sql);
          throw e;
        }
      },
      async first() {
        // D1 .first() compatibility (used in some init paths)
        return this.get();
      }
    };
    return stmtObj;
  }

  const d1 = {
    prepare(sql) {
      return makeStatement(sql);
    },

    async batch(statements) {
      const results = [];
      const transaction = sqlite.transaction((stmts) => {
        for (let s of stmts) {
          if (!s) continue;
          // 兼容 await prepare(...) 传进来的是 stmtObj
          if (s && s._sql !== undefined) {
            try {
              const stmt = sqlite.prepare(s._sql);
              const info = stmt.run(s._params || []);
              results.push({ success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } });
            } catch (e) {
              results.push({ success: false, error: e.message });
            }
            continue;
          }
          // 原生 better-sqlite3 Statement 没有 _sql/_params 标记
          if (s && s._sql === undefined && typeof s.run === 'function' && typeof s.all === 'function') {
            try {
              const info = s.run();
              results.push({ success: true, meta: { changes: info.changes || 0 } });
            } catch (e) {
              results.push({ success: false, error: e.message });
            }
            continue;
          }
          // 如果是我们的 stmtObj 带 run 方法 (async but we call sync inside tx)
          if (s && typeof s.run === 'function') {
            try {
              // 直接同步执行其内部逻辑 (我们知道是 wrapper)
              const info = sqlite.prepare(s._sql || '').run(s._params || []);
              results.push({ success: true, meta: { changes: info.changes } });
            } catch (e) {
              results.push({ success: false, error: e.message });
            }
          }
        }
      });

      try {
        transaction(statements);
      } catch (e) {
        console.error('D1 batch transaction error:', e);
      }
      return results;
    },

    // 额外直通，供复杂场景
    raw(sql, params = []) {
      const stmt = sqlite.prepare(sql);
      return stmt.all(params);
    }
  };

  return { sqlite, d1 };
}

export default createD1Adapter;
