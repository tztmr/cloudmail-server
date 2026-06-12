import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

import apiApp from './hono/webs';
import createD1Adapter from './adapter/d1-adapter';
import createKVAdapter from './adapter/kv-adapter';
import kvObjService from './service/kv-obj-service';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
import settingService from './service/setting-service';
import { dbInit } from './init/init';
import { handleReceivedEmail } from './email/email';
import { startSmtpReceiver } from './smtp/receiver';

const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const STATIC_DIR = process.env.STATIC_DIR || path.resolve('dist');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'cloudmail.db');

function parseJsonEnv(name, fallback) {
	const value = process.env[name];
	if (!value) {
		return fallback;
	}
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const { sqlite, d1 } = createD1Adapter(DB_FILE);
const kv = createKVAdapter(DB_FILE);
const serverEnv = {
	db: d1,
	kv,
	isServer: true,
	jwt_secret: process.env.JWT_SECRET || 'change-me-at-least-32-random-chars',
	admin: process.env.ADMIN || 'admin@yourdomain.com',
	domain: parseJsonEnv('DOMAIN', ['localhost']),
	orm_log: process.env.ORM_LOG === 'true',
	analysis_cache: process.env.ANALYSIS_CACHE === 'true',
	ai_model: process.env.AI_MODEL || '',
	linuxdo_switch: process.env.LINUXDO_SWITCH === 'true',
	linuxdo_client_id: process.env.LINUXDO_CLIENT_ID || '',
	linuxdo_client_secret: process.env.LINUXDO_CLIENT_SECRET || '',
	linuxdo_callback_url: process.env.LINUXDO_CALLBACK_URL || '',
	project_link: process.env.PROJECT_LINK !== 'false'
};

async function ensureSchema() {
	const store = new Map();
	const c = {
		env: serverEnv,
		req: {
			param(name) {
				return name === 'secret' ? serverEnv.jwt_secret : '';
			}
		},
		set(key, value) {
			store.set(key, value);
		},
		get(key) {
			return store.get(key);
		},
		text(value) {
			return value;
		}
	};
	await dbInit.init(c);
	await settingService.refresh(c);
}

const app = new Hono();

app.get('/attachments/*', async (c) => {
	const response = await kvObjService.toObjResp({ env: serverEnv }, c.req.path.substring(1));
	return response || c.notFound();
});

app.get('/static/*', async (c) => {
	const response = await kvObjService.toObjResp({ env: serverEnv }, c.req.path.substring(1));
	return response || c.notFound();
});

app.post('/receive', async (c) => {
	const contentType = c.req.header('content-type') || '';
	let to = c.req.header('x-to') || c.req.query('to');
	let rawContent = '';

	if (contentType.includes('application/json')) {
		const body = await c.req.json();
		to = to || body.to;
		rawContent = body.raw || body.content || body.email || '';
	} else if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
		const form = await c.req.formData();
		to = to || form.get('to');
		rawContent = form.get('raw') || form.get('content') || '';
	} else {
		rawContent = await c.req.text();
	}

	if (!to || !rawContent) {
		return c.json({ code: 400, message: '缺少 to 或 raw 邮件内容' }, 400);
	}

	const result = await handleReceivedEmail({
		env: serverEnv,
		rawContent,
		to,
		onReject: (reason) => console.log(`[receive] rejected ${to}: ${reason}`)
	});

	return c.json({ code: 200, message: 'received', data: result });
});

app.all('/api/*', async (c) => {
	const url = new URL(c.req.url);
	url.pathname = url.pathname.replace(/^\/api/, '') || '/';
	const request = new Request(url.toString(), {
		method: c.req.method,
		headers: c.req.raw.headers,
		body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body
	});
	return apiApp.fetch(request, serverEnv, {});
});

const staticRoot = path.resolve(STATIC_DIR);
app.use('/assets/*', serveStatic({ root: staticRoot }));
app.use('/tinymce/*', serveStatic({ root: staticRoot }));
app.use('/image/*', serveStatic({ root: staticRoot }));
app.use('/mail.png', serveStatic({ root: staticRoot }));
app.use('/mail-pwa.png', serveStatic({ root: staticRoot }));
app.use('/favicon.ico', serveStatic({ root: staticRoot }));

app.get('*', async (c) => {
	const indexPath = path.join(staticRoot, 'index.html');
	try {
		const html = await fs.promises.readFile(indexPath, 'utf8');
		return c.html(html);
	} catch {
		return c.text('Frontend not built. Please run pnpm --prefix mail-vue run build.', 503);
	}
});

function startCrons() {
	cron.schedule('0 16 * * *', async () => {
		try {
			await verifyRecordService.clearRecord({ env: serverEnv });
			await userService.resetDaySendCount({ env: serverEnv });
			await emailService.completeReceiveAll({ env: serverEnv });
			await oauthService.clearNoBindOathUser({ env: serverEnv });
			await analysisService.refreshEchartsCache({ env: serverEnv });
		} catch (err) {
			console.error('[cron] daily task failed:', err);
		}
	});

	cron.schedule('*/30 * * * *', async () => {
		if (!serverEnv.analysis_cache) {
			return;
		}
		try {
			await analysisService.refreshEchartsCache({ env: serverEnv });
		} catch (err) {
			console.error('[cron] analysis refresh failed:', err);
		}
	});
}

async function bootstrap() {
	console.log('CloudMail Server starting...');
	console.log(`Data dir: ${path.resolve(DATA_DIR)}`);
	console.log(`DB file : ${path.resolve(DB_FILE)}`);
	console.log(`Static  : ${staticRoot}`);

	await ensureSchema();
	startCrons();
	startSmtpReceiver(serverEnv);

	serve({ fetch: app.fetch, port: PORT, hostname: HOSTNAME }, (info) => {
		console.log(`Web/API listening on http://${HOSTNAME}:${info.port}`);
		if ((process.env.SMTP_ENABLED || 'true').toLowerCase() !== 'false') {
			console.log(`SMTP receiving on 0.0.0.0:${process.env.SMTP_PORT || 2525}`);
		}
	});
}

bootstrap().catch((err) => {
	console.error('CloudMail Server failed to start:', err);
	process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		try {
			sqlite.close();
		} finally {
			process.exit(0);
		}
	});
}
