import fs from 'fs/promises';
import path from 'path';
import constant from '../const/constant.js';

/**
 * 本地文件存储服务 (替代 R2 / KV 用于服务器端)
 * 存储路径: <dataDir>/<prefix>/...
 */
const localStorageService = {
  async getDataDir(c) {
    // 支持从 env 或 process
    const env = c?.env || globalThis.serverEnv || {};
    return env.DATA_DIR || process.env.DATA_DIR || './data';
  },

  async ensureDir(dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (_) {}
  },

  async getFilePath(c, key) {
    const dataDir = await this.getDataDir(c);
    // key 形如 attachments/xxx 或 static/background/yyy
    const fullPath = path.join(dataDir, key);
    // 安全：限制在 dataDir 内
    const resolved = path.resolve(fullPath);
    const base = path.resolve(dataDir);
    if (!resolved.startsWith(base)) {
      throw new Error('Invalid storage key path');
    }
    return resolved;
  },

  async getMetaPath(filePath) {
    return filePath + '.meta.json';
  },

  async putObj(c, key, content, metadata = {}) {
    const filePath = await this.getFilePath(c, key);
    await this.ensureDir(path.dirname(filePath));

    let buffer;
    if (content instanceof ArrayBuffer) {
      buffer = Buffer.from(content);
    } else if (Buffer.isBuffer(content)) {
      buffer = content;
    } else if (content instanceof Uint8Array) {
      buffer = Buffer.from(content);
    } else {
      buffer = Buffer.from(content);
    }

    await fs.writeFile(filePath, buffer);

    // 写 meta
    const metaPath = await this.getMetaPath(filePath);
    const meta = {
      contentType: metadata.contentType || metadata.httpMetadata?.contentType || 'application/octet-stream',
      contentDisposition: metadata.contentDisposition || metadata.httpMetadata?.contentDisposition || null,
      cacheControl: metadata.cacheControl || metadata.httpMetadata?.cacheControl || null,
      size: buffer.length
    };
    await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');
  },

  async getObj(c, key) {
    try {
      const filePath = await this.getFilePath(c, key);
      const metaPath = await this.getMetaPath(filePath);

      let meta = {};
      try {
        const metaRaw = await fs.readFile(metaPath, 'utf8');
        meta = JSON.parse(metaRaw);
      } catch (_) {}

      const data = await fs.readFile(filePath);

      return new Response(data, {
        headers: {
          'Content-Type': meta.contentType || 'application/octet-stream',
          'Content-Disposition': meta.contentDisposition || null,
          'Cache-Control': meta.cacheControl || 'public, max-age=31536000',
          'Content-Length': String(data.length)
        }
      });
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      console.error('local storage get error', e);
      return null;
    }
  },

  async delete(c, key) {
    try {
      const filePath = await this.getFilePath(c, key);
      const metaPath = await this.getMetaPath(filePath);
      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(metaPath).catch(() => {});
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('local delete error', e);
    }
  },

  async deleteMany(c, keys) {
    if (typeof keys === 'string') keys = [keys];
    for (const k of keys) {
      await this.delete(c, k);
    }
  },

  // 供 kvObj 兼容时使用，但服务器默认不走 KV 存大对象
  async toObjResp(c, key) {
    return await this.getObj(c, key);
  }
};

export default localStorageService;
