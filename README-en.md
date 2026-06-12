# Cloud Mail Server

A self-hosted email service built with Node.js and Docker. It includes a web admin UI, inbound SMTP receiving, optional sending through Resend, attachments, users, and role-based permissions.

This repository is now focused on server deployment. The runtime uses SQLite and local object-cache adapters, with persistent data stored in a Docker volume.

## One-Command Deploy

Run this on your server from the project directory:

```bash
chmod +x cloudmail.sh
bash cloudmail.sh
```

For non-interactive deployment:

```bash
bash cloudmail.sh deploy
```

The script supports `deploy`, `status`, `logs`, `restart`, `update`, `enable-ssl`, `uninstall`, and `menu`.

## Configuration

The script creates `.env` from `.env.example` on first deploy. Update at least:

```env
JWT_SECRET=change-me-at-least-32-random-chars
ADMIN=admin@yourdomain.com
DOMAIN=["yourdomain.com"]
```

Default ports:

```env
PORT=3000
SMTP_PORT=2525
SMTP_PUBLIC_PORT=25
```

The one-command deployment maps host port 25 to the container SMTP port by default:

```yaml
ports:
  - "3000:3000"
  - "25:2525"
```

Many cloud providers block port 25 by default, so you may need to request an unblock and open firewall/security-group rules.

## Manual Docker Deploy

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
docker compose logs -f cloudmail
```

Access:

- Web UI + API: `http://server-ip:3000`
- SMTP receiving: `server-ip:25`

## DNS

Point your MX record to this server:

```text
example.com.    MX    10    mail.example.com.
mail.example.com. A          your-server-ip
```

SPF, DKIM, and DMARC are recommended for production.

## Stack

- Backend: Node.js, Hono, Drizzle, SQLite
- Frontend: Vue 3, Element Plus, Pinia, Vite
- Email parsing: postal-mime
- Inbound SMTP: smtp-server
- Sending: Resend
- Attachments: local cache storage by default, S3-compatible storage configurable in the admin UI

## License

This project is licensed under the [MIT](LICENSE) license.
