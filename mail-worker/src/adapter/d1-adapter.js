import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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
		const statement = {
			_sql: sql,
			_params: params,
			bind(...values) {
				params = values;
				statement._params = params;
				return statement;
			},
			async run() {
				const info = sqlite.prepare(sql).run(params);
				return {
					success: true,
					meta: {
						changes: info.changes,
						last_row_id: Number(info.lastInsertRowid || 0),
						duration: 0
					}
				};
			},
			async all() {
				return { results: sqlite.prepare(sql).all(params) };
			},
			async get() {
				return sqlite.prepare(sql).get(params) || null;
			},
			async first(columnName) {
				const row = await this.get();
				if (!row || !columnName) {
					return row;
				}
				return row[columnName];
			},
			async raw() {
				const stmt = sqlite.prepare(sql);
				return stmt.raw().all(params);
			}
		};
		return statement;
	}

	const d1 = {
		prepare(sql) {
			return makeStatement(sql);
		},
		async batch(statements) {
			const results = [];
			const transaction = sqlite.transaction((items) => {
				for (const item of items) {
					if (!item) {
						continue;
					}
					const info = sqlite.prepare(item._sql).run(item._params || []);
					results.push({
						success: true,
						meta: {
							changes: info.changes,
							last_row_id: Number(info.lastInsertRowid || 0),
							duration: 0
						}
					});
				}
			});
			transaction(statements);
			return results;
		},
		exec(sql) {
			sqlite.exec(sql);
		}
	};

	return { sqlite, d1 };
}

export default createD1Adapter;
