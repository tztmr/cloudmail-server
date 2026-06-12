import app from '../hono/hono.js';
import { dbInit } from '../init/init.js';

app.get('/init/:secret', (c) => {
	return dbInit.init(c);
})
