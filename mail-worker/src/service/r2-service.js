import s3Service from './s3-service.js';
import settingService from './setting-service.js';
import kvObjService from './kv-obj-service.js';
import localStorageService from './local-storage-service.js';

const r2Service = {

	async storageType(c) {

		const setting = await settingService.query(c);
		const { bucket, endpoint, s3AccessKey, s3SecretKey } = setting;

		if (!!(bucket && endpoint && s3AccessKey && s3SecretKey)) {
			return 'S3';
		}

		if (c.env.r2) {
			return 'R2';
		}

		// 服务器端本地存储（当没有 R2/S3 时默认）
		if (c.env.isServer || process.env.DATA_DIR || !c.env.r2) {
			// 优先使用 LOCAL，除非显式有 r2
			if (!c.env.r2) {
				return 'LOCAL';
			}
		}

		return 'KV';
	},

	async putObj(c, key, content, metadata) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.putObj(c, key, content, metadata);
		} else if (storageType === 'R2') {
			await c.env.r2.put(key, content, {
				httpMetadata: { ...metadata }
			});
		} else if (storageType === 'S3') {
			await s3Service.putObj(c, key, content, metadata);
		} else if (storageType === 'LOCAL') {
			await localStorageService.putObj(c, key, content, metadata);
		}

	},

	async getObj(c, key) {
		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			return await kvObjService.getObj(c, key);
		}

		if (storageType === 'R2') {
			return await c.env.r2.get(key);
		}

		if (storageType === 'S3') {
			return await s3Service.getObj(c, key);
		}

		if (storageType === 'LOCAL') {
			return await localStorageService.getObj(c, key);
		}

		return null;
	},

	async delete(c, key) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.deleteObj(c, key);
		} else if (storageType === 'R2') {
			await c.env.r2.delete(key);
		} else if (storageType === 'S3'){
			await s3Service.deleteObj(c, key);
		} else if (storageType === 'LOCAL') {
			await localStorageService.delete(c, key);
		}

	}

};
export default r2Service;
