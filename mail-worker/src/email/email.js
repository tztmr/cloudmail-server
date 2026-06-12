import PostalMime from 'postal-mime';
import emailService from '../service/email-service.js';
import accountService from '../service/account-service.js';
import settingService from '../service/setting-service.js';
import attService from '../service/att-service.js';
import constant from '../const/constant.js';
import fileUtils from '../utils/file-utils.js';
import { emailConst, isDel, settingConst } from '../const/entity-const.js';
import emailUtils from '../utils/email-utils.js';
import roleService from '../service/role-service.js';
import userService from '../service/user-service.js';
import telegramService from '../service/telegram-service.js';
import aiService from '../service/ai-service.js';

export async function email(message, env, ctx) {
	// CF Worker 邮件入口，保持原有逻辑
	try {
		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}

		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		await handleReceivedEmail({
			env,
			rawContent: content,
			to: message.to,
			// CF 特有能力
			onReject: (reason) => message.setReject(reason),
			onForward: async (target) => {
				try { await message.forward(target); } catch (e) { console.error('forward fail', target, e); }
			}
		});
	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e;
	}
}

/**
 * 通用邮件接收处理（服务器端 + CF 共用）
 * opts: { env, rawContent: string, to: string, onReject?: fn, onForward?: fn }
 */
export async function handleReceivedEmail(opts = {}) {
	const { env, rawContent, to, onReject, onForward } = opts;

	const {
		receive,
		tgChatId,
		tgBotStatus,
		forwardStatus,
		forwardEmail,
		ruleEmail,
		ruleType,
		r2Domain,
		noRecipient,
		blackSubject,
		blackContent,
		blackFrom,
		aiCode,
		aiCodeFilter
	} = await settingService.query({ env });

	if (receive === settingConst.receive.CLOSE) {
		if (onReject) onReject('Service suspended');
		return;
	}

	const emailParsed = await PostalMime.parse(rawContent);

	const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, emailParsed);

	if (blockFlag) {
		if (onReject) onReject('Message rejected');
		return;
	}

	const account = await accountService.selectByEmailIncludeDel({ env: env }, to);

	if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
		if (onReject) onReject('Recipient not found');
		return;
	}

	let userRow = {};
	if (account) {
		userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
	}

	if (account && userRow.email !== env.admin) {
		let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);
		if (!roleService.hasAvailDomainPerm(availDomain, to)) {
			if (onReject) onReject('The recipient is not authorized to use this domain.');
			return;
		}
		if (roleService.isBanEmail(banEmail, emailParsed.from.address)) {
			if (onReject) onReject('The recipient is disabled from receiving emails.');
			return;
		}
	}

	if (!emailParsed.to) {
		emailParsed.to = [{ address: to, name: emailUtils.getName(to) }];
	}

	const toName = emailParsed.to.find(item => item.address === to)?.name || '';
	const code = await aiService.extractCode({ env }, emailParsed, { aiCode, aiCodeFilter });

	const params = {
		toEmail: to,
		toName: toName,
		sendEmail: emailParsed.from.address,
		name: emailParsed.from.name || emailUtils.getName(emailParsed.from.address),
		subject: emailParsed.subject,
		code,
		content: emailParsed.html,
		text: emailParsed.text,
		cc: emailParsed.cc ? JSON.stringify(emailParsed.cc) : '[]',
		bcc: emailParsed.bcc ? JSON.stringify(emailParsed.bcc) : '[]',
		recipient: JSON.stringify(emailParsed.to),
		inReplyTo: emailParsed.inReplyTo,
		relation: emailParsed.references,
		messageId: emailParsed.messageId,
		userId: account ? account.userId : 0,
		accountId: account ? account.accountId : 0,
		isDel: isDel.DELETE,
		status: emailConst.status.SAVING
	};

	const attachments = [];
	const cidAttachments = [];

	for (let item of emailParsed.attachments) {
		let attachment = { ...item };
		attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
		attachment.size = item.content.length ?? item.content.byteLength;
		attachments.push(attachment);
		if (attachment.contentId) {
			cidAttachments.push(attachment);
		}
	}

	let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

	attachments.forEach(attachment => {
		attachment.emailId = emailRow.emailId;
		attachment.userId = emailRow.userId;
		attachment.accountId = emailRow.accountId;
	});

	try {
		if (attachments.length > 0) {
			await attService.addAtt({ env }, attachments);
		}
	} catch (e) {
		console.error(e);
	}

	emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);

	if (ruleType === settingConst.ruleType.RULE) {
		const emails = ruleEmail.split(',');
		if (!emails.includes(to)) {
			return;
		}
	}

	// TG 推送
	if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
		await telegramService.sendEmailToBot({ env }, emailRow);
	}

	// 转发到其他邮箱 (仅 CF 有 message.forward 能力)
	if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail && onForward) {
		const emails = forwardEmail.split(',');
		await Promise.all(emails.map(async target => {
			try {
				await onForward(target);
			} catch (e) {
				console.error(`转发邮箱 ${target} 失败：`, e);
			}
		}));
	}
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {
	const blackFromList = blackFromStr ? blackFromStr.split(',') : [];
	const blackContentList = blackContentStr ? blackContentStr.split(',') : [];
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : [];

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true;
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true;
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true;
		}
	}

	return false;
}
