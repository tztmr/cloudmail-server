import { drizzle } from 'drizzle-orm/d1';
import { drizzle as drizzleBetter } from 'drizzle-orm/better-sqlite3';

export default function orm(c) {
	if (c.env && c.env.orm) {
		return c.env.orm;
	}
	if (c.env && c.env.isServer && c.env.sqlite) {
		// server 模式使用 better-sqlite3 的 drizzle 实例
		return drizzleBetter(c.env.sqlite, { logger: !!c.env.orm_log });
	}
	return drizzle(c.env.db, { logger: c.env.orm_log });
}
