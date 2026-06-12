import BizError from '../error/biz-error.js';
import settingService from './setting-service.js';
import { t } from '../i18n/i18n.js'

const turnstileService = {

	async verify(c, token) {

		if (!token) {
			throw new BizError(t('emptyBotToken'),400);
		}

		const settingRow = await settingService.query(c)

		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				secret: settingRow.secretKey,
				response: token,
				remoteip: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || ''
			})
		});

		const result = await res.json();

		if (!result.success) {
			throw new BizError(t('botVerifyFail'),400)
		}
	}
};

export default turnstileService;
