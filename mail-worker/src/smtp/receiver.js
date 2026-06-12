/**
 * Built-in SMTP receiver for inbound emails.
 * Listens for SMTP (port 2525 recommended) and feeds raw messages into handleReceivedEmail.
 *
 * Usage in server:
 *   import { startSmtpReceiver } from './smtp/receiver.js';
 *   startSmtpReceiver(serverEnv, { port: 2525 });
 */
import { SMTPServer } from 'smtp-server';
import { handleReceivedEmail } from '../email/email.js';

export function startSmtpReceiver(env, opts = {}) {
  const port = opts.port || Number(process.env.SMTP_PORT || 2525);
  const host = opts.host || process.env.SMTP_HOST || '0.0.0.0';
  const enabled = opts.enabled !== false && (process.env.SMTP_ENABLED || 'true').toLowerCase() !== 'false';

  if (!enabled) {
    console.log('[SMTP] disabled via config');
    return null;
  }

  // Allowed domains from env (primary source of truth for this instance)
  const getAllowedDomains = () => {
    let domains = env.domain || [];
    if (typeof domains === 'string') {
      try { domains = JSON.parse(domains); } catch { domains = []; }
    }
    return (domains || []).map(d => d.replace(/^@/, '').toLowerCase());
  };

  const allowed = getAllowedDomains();

  const smtpServer = new SMTPServer({
    name: 'cloudmail',                 // EHLO greeting
    banner: 'CloudMail SMTP ready',
    secure: false,                     // plain SMTP, use reverse proxy or starttls if needed
    authOptional: true,
    disabledCommands: ['AUTH'],        // inbound MX typically unauthenticated
    size: 25 * 1024 * 1024,            // 25MB max message

    // Early reject for unknown domains (prevent backscatter / open relay)
    onRcptTo(address, session, callback) {
      const rcpt = (address.address || '').toLowerCase();
      const domain = rcpt.split('@')[1] || '';
      const allowList = getAllowedDomains();

      if (allowList.length === 0 || allowList.includes(domain)) {
        // Accept; business logic inside handle will further check accounts / noRecipient etc.
        return callback();
      }
      const err = new Error('Relay access denied for domain ' + domain);
      err.responseCode = 550;
      callback(err);
    },

    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', async () => {
        const rawBuffer = Buffer.concat(chunks);
        const rawContent = rawBuffer.toString('utf8');

        const recipients = (session.envelope.rcptTo || []).map(r => r.address).filter(Boolean);

        if (recipients.length === 0) {
          return callback();
        }

        let hadError = false;
        for (const to of recipients) {
          try {
            await handleReceivedEmail({
              env,
              rawContent,
              to,
              onReject: (reason) => {
                console.log(`[SMTP] message to ${to} rejected: ${reason}`);
              },
              onForward: null
            });
          } catch (e) {
            hadError = true;
            console.error(`[SMTP] handleReceivedEmail error for ${to}:`, e.message);
          }
        }

        if (hadError) {
          // Still accept so sender doesn't retry forever; we logged it
          return callback();
        }
        callback();
      });

      stream.on('error', (err) => {
        console.error('[SMTP] stream error:', err);
        callback(err);
      });
    },

    onConnect(session, callback) {
      // Optional: IP allow list or rate limit could go here
      callback();
    },

    onMailFrom(address, session, callback) {
      callback(); // accept all senders (standard for receiving)
    },

    onClose(session) {
      // cleanup if needed
    }
  });

  smtpServer.on('error', (err) => {
    console.error('[SMTP] server error:', err);
  });

  smtpServer.listen(port, host, () => {
    console.log(`[SMTP] receiver listening on ${host}:${port} (allowed domains: ${allowed.join(', ') || 'any (from env)'})`);
  });

  // Graceful shutdown hook (if process exits)
  const shutdown = () => {
    try { smtpServer.close(); } catch (_) {}
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return smtpServer;
}

export default startSmtpReceiver;
