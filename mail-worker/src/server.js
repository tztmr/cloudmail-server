/**
 * CloudMail Server 独立服务器入口
 * 运行: node src/server.js
 * 或者 pnpm dev:server (需要先构建前端到 dist)
 */
import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

import apiApp from './hono/webs.js';
import createD1Adapter from './adapter/d1-adapter.js';
import createKVAdapter from './adapter/kv-adapter.js';
import r2Service from './service/r2-service.js';
import settingService from './service/setting-service.js';
import userService from './service/user-service.js';
import verifyRecordService from './service/verify-record-service.js';
import emailService from './service/email-service.js';
import oauthService from './service/oauth-service.js';
import analysisService from './service/analysis-service.js';
import { handleReceivedEmail } from './email/email.js';
import { dbInit } from './init/init.js';
import { startSmtpReceiver } from './smtp/receiver.js';

// ====== 配置加载 ======
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || './data';
const STATIC_DIR = process.env.STATIC_DIR || './dist';
const DB_FILE = path.join(DATA_DIR, 'cloudmail.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ====== 创建适配器 ======
const { sqlite: sqliteDb, d1: dbAdapter } = createD1Adapter(DB_FILE);
const kvAdapter = createKVAdapter(DB_FILE);

// 构建 serverEnv，模拟 CF worker env + vars
const serverEnv = {
  db: dbAdapter,
  sqlite: sqliteDb,          // 给 orm 使用 better-sqlite
  kv: kvAdapter,
  isServer: true,
  DATA_DIR,
  // 从环境变量读取关键配置
  jwt_secret: process.env.JWT_SECRET || 'dev_jwt_secret_change_me',
  admin: process.env.ADMIN || 'admin@example.com',
  domain: process.env.DOMAIN ? JSON.parse(process.env.DOMAIN) : ['localhost'],
  orm_log: process.env.ORM_LOG === 'true',
  analysis_cache: process.env.ANALYSIS_CACHE === 'true',
  ai_model: process.env.AI_MODEL || '',
  // 其他可选
  linuxdo_switch: process.env.LINUXDO_SWITCH === 'true',
  linuxdo_client_id: process.env.LINUXDO_CLIENT_ID || '',
  linuxdo_callback_url: process.env.LINUXDO_CALLBACK_URL || '',
  project_link: process.env.PROJECT_LINK !== 'false',
};

// 暴露给全局，供 middleware / 其他模块兜底使用
globalThis.serverEnv = serverEnv;

// 也暴露给 r2/local 等服务直接读取
process.env.DATA_DIR = DATA_DIR;

// ====== 创建主应用 (同时服务 API + 静态 + SPA) ======
const app = new Hono();

// 1. 早期的 env 注入 (hono base 已有，这里再保险)
app.use('*', async (c, next) => {
  if (!c.env) c.env = { ...serverEnv };
  c.env.isServer = true;
  await next();
});

// 2. 附件与上传静态资源走存储服务 (必须在 SPA 静态之前)
app.get('/attachments/*', async (c) => {
  const key = c.req.path.replace(/^\//, '');
  const resp = await r2Service.getObj(c, key);
  return resp || c.notFound();
});

app.get('/static/*', async (c) => {
  const key = c.req.path.replace(/^\//, '');
  const resp = await r2Service.getObj(c, key);
  return resp || c.notFound();
});

// 服务器端邮件接收入口（不依赖 Cloudflare Email Workers）
// 支持 POST raw MIME (Content-Type: message/rfc822 或 text/plain) + header X-To / form field to
// 也支持简单 webhook: { to, raw } JSON
app.post('/receive', async (c) => {
  try {
    const ct = c.req.header('content-type') || '';
    let to = c.req.header('x-to') || c.req.query('to');
    let rawContent = '';

    if (ct.includes('application/json')) {
      const body = await c.req.json();
      to = to || body.to;
      rawContent = body.raw || body.content || body.email || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const form = await c.req.formData();
      to = to || form.get('to');
      rawContent = form.get('raw') || form.get('content') || '';
    } else {
      // raw body (推荐)
      rawContent = await c.req.text();
    }

    if (!to || !rawContent) {
      return c.json({ code: 400, message: '缺少 to 或邮件内容 (raw MIME)' }, 400);
    }

    await handleReceivedEmail({
      env: serverEnv,
      rawContent,
      to,
      onReject: (reason) => { console.log('receive rejected:', reason); },
      onForward: null // 服务器端暂不支持 message.forward，可在 handle 后自行处理或配置转发邮箱
    });

    return c.json({ code: 200, message: 'received' });
  } catch (e) {
    console.error('receive error', e);
    return c.json({ code: 500, message: e.message }, 500);
  }
});

// 3. API 路由
//    - 同时支持 /api/xxx 和 /xxx 两种调用方式，方便不同前端构建配置
app.all('/api/*', async (c) => {
  const newUrl = new URL(c.req.url);
  newUrl.pathname = newUrl.pathname.replace(/^\/api/, '') || '/';
  const newReq = new Request(newUrl.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
  });
  return apiApp.fetch(newReq);
});

// 直接挂载 apiApp（无 /api 前缀的情况）
app.route('/', apiApp);

// 4. 前端静态资源 (dist 目录)
const staticRoot = path.resolve(STATIC_DIR);

// 优先尝试 dist 下的 assets 等
app.use('/assets/*', serveStatic({ root: staticRoot }));
app.use('/tinymce/*', serveStatic({ root: staticRoot })); // 如果有
app.use('/mail-pwa.png', serveStatic({ root: staticRoot }));
app.use('/mail.png', serveStatic({ root: staticRoot }));

// 5. SPA fallback：把所有未匹配路由交给 index.html（支持前端路由）
app.get('*', async (c) => {
  // 跳过明显是 API 的
  if (c.req.path.startsWith('/api/')) {
    return c.notFound();
  }

  const indexPath = path.join(staticRoot, 'index.html');
  try {
    const html = await fs.promises.readFile(indexPath, 'utf8');
    c.header('Content-Type', 'text/html; charset=utf-8');
    // 可在此注入一些运行时配置给前端（可选）
    return c.html(html);
  } catch (e) {
    return c.text('Frontend not built. Run: pnpm run build:vue\nThen place dist inside mail-worker or set STATIC_DIR', 503);
  }
});

// ====== 定时任务 (替代 Worker scheduled) ======
function startCrons() {
  // 每天 16:00 (UTC?) 执行清理 + 统计
  // 与 wrangler.toml 里 crons 保持接近
  cron.schedule('0 16 * * *', async () => {
    console.log('[cron] running daily tasks...');
    try {
      await verifyRecordService.clearRecord({ env: serverEnv });
      await userService.resetDaySendCount({ env: serverEnv });
      await emailService.completeReceiveAll({ env: serverEnv });
      await oauthService.clearNoBindOathUser({ env: serverEnv });
      await analysisService.refreshEchartsCache({ env: serverEnv });
    } catch (e) {
      console.error('[cron] daily error:', e);
    }
  });

  // 每 30 分钟刷新一次分析缓存（如果开启）
  cron.schedule('*/30 * * * *', async () => {
    try {
      if (serverEnv.analysis_cache) {
        await analysisService.refreshEchartsCache({ env: serverEnv });
      }
    } catch (e) {
      console.error('[cron] analysis refresh error:', e);
    }
  });

  console.log('[server] cron jobs scheduled');
}

// ====== 启动 ======
async function bootstrap() {
  console.log('====================================');
  console.log('   CloudMail Server 启动中...');
  console.log('====================================');
  console.log('Data dir :', path.resolve(DATA_DIR));
  console.log('DB file  :', path.resolve(DB_FILE));
  console.log('Static   :', path.resolve(staticRoot));
  console.log('Admin    :', serverEnv.admin);
  console.log('Domains  :', serverEnv.domain);

  // 自动确保数据库表结构（Docker 一键部署友好，无需手动调用 /init）
  await dbInit.ensureSchema(serverEnv);

  // 强制从 DB 加载 setting 并写入 KV 缓存（保证 websiteConfig 等接口立即可用）
  try {
    const row = await (await import('./entity/orm.js')).default({ env: serverEnv }).select().from((await import('./entity/setting.js')).default).get();
    if (row) {
      row.resendTokens = JSON.parse(row.resendTokens || '{}');
      await serverEnv.kv.put('setting:', JSON.stringify(row));  // KvConst.SETTING
      console.log('[boot] setting cached into KV');
    }
  } catch (e) {
    console.warn('[boot] setting cache seed warn:', e.message);
  }

  startCrons();

  // 启动内置 SMTP 接收器（接收邮件，不依赖 Cloudflare）
  startSmtpReceiver(serverEnv);

  serve({
    fetch: app.fetch,
    port: PORT,
  }, (info) => {
    const smtpPort = process.env.SMTP_PORT || 2525;
    const smtpEnabled = (process.env.SMTP_ENABLED || 'true').toLowerCase() !== 'false';
    console.log(`\n🚀 Server 运行在 http://localhost:${info.port}`);
    console.log(`   前端访问: http://localhost:${info.port}`);
    console.log(`   API 示例: http://localhost:${info.port}/api/setting/websiteConfig`);
    if (smtpEnabled) {
      console.log(`   内置 SMTP 接收: 0.0.0.0:${smtpPort}  (MX 记录应指向本服务器)`);
    }
    console.log(`   提示: Docker 一键部署推荐，数据持久化在 ./data`);
    console.log('====================================\n');
  });
}

bootstrap().catch(err => {
  console.error('Server 启动失败:', err);
  process.exit(1);
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  sqliteDb.close();
  process.exit(0);
});
