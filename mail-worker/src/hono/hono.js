import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result.js';
import { cors } from 'hono/cors';

// 服务器端注入 env（必须尽早执行，兼容 CF worker + server 双模式）
app.use('*', async (c, next) => {
	if (!c.env && globalThis.serverEnv) {
		c.env = { ...globalThis.serverEnv };
	}
	c.env = c.env || {};
	c.env.isServer = c.env.isServer || !!globalThis.serverEnv;
	await next();
});

app.use('*', cors());

app.onError((err, c) => {
	if (!c.env && globalThis.serverEnv) {
		c.env = { ...globalThis.serverEnv };
	}
	c.env = c.env || {};

	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定 D1 database not bound',502));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;


