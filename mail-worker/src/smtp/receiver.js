import { SMTPServer } from 'smtp-server';
import { handleReceivedEmail } from '../email/email';

export function startSmtpReceiver(env, opts = {}) {
	const port = opts.port || Number(process.env.SMTP_PORT || 2525);
	const host = opts.host || process.env.SMTP_HOST || '0.0.0.0';
	const enabled = opts.enabled !== false && (process.env.SMTP_ENABLED || 'true').toLowerCase() !== 'false';

	if (!enabled) {
		console.log('[SMTP] disabled');
		return null;
	}

	const allowedDomains = () => {
		const domains = Array.isArray(env.domain) ? env.domain : [];
		return domains.map((domain) => String(domain).replace(/^@/, '').toLowerCase()).filter(Boolean);
	};

	const server = new SMTPServer({
		name: 'cloudmail',
		banner: 'CloudMail SMTP ready',
		secure: false,
		authOptional: true,
		disabledCommands: ['AUTH'],
		size: Number(process.env.SMTP_MAX_SIZE || 25 * 1024 * 1024),
		onRcptTo(address, session, callback) {
			const recipient = String(address.address || '').toLowerCase();
			const domain = recipient.split('@')[1] || '';
			const allowList = allowedDomains();
			if (allowList.length === 0 || allowList.includes(domain)) {
				callback();
				return;
			}
			const err = new Error(`Relay access denied for domain ${domain}`);
			err.responseCode = 550;
			callback(err);
		},
		onData(stream, session, callback) {
			const chunks = [];
			stream.on('data', (chunk) => chunks.push(chunk));
			stream.on('error', callback);
			stream.on('end', async () => {
				const rawContent = Buffer.concat(chunks).toString('utf8');
				const recipients = (session.envelope.rcptTo || []).map((item) => item.address).filter(Boolean);
				try {
					for (const to of recipients) {
						await handleReceivedEmail({
							env,
							rawContent,
							to,
							onReject: (reason) => console.log(`[SMTP] rejected ${to}: ${reason}`)
						});
					}
					callback();
				} catch (err) {
					console.error('[SMTP] receive error:', err);
					callback(err);
				}
			});
		}
	});

	server.on('error', (err) => console.error('[SMTP] server error:', err));
	server.listen(port, host, () => {
		console.log(`[SMTP] listening on ${host}:${port}`);
	});

	return server;
}

export default startSmtpReceiver;
