# Cloud Mail Server

基于 Node.js + Docker 的自建邮箱服务，支持 Web 管理后台、邮件接收、邮件发送、附件、用户和权限管理。

本分支已整理为服务器部署版，后端使用 SQLite 和本地对象缓存，数据持久化在 Docker volume 中。

## 一键部署

服务器上进入项目目录后直接执行：

```bash
chmod +x cloudmail.sh
bash cloudmail.sh
```

如果服务器上只有单独的 `cloudmail.sh`，脚本会自动从 `https://github.com/tztmr/cloudmail-server.git` 克隆源码到 `/opt/cloudmail-server`（root）或 `~/cloudmail-server`（普通用户）后继续部署。需要换仓库或安装目录时可设置：

```bash
CLOUDMAIL_REPO_URL=https://github.com/你的账号/你的仓库.git CLOUDMAIL_INSTALL_DIR=/opt/cloudmail-server bash cloudmail.sh deploy
```

非交互环境可以直接部署：

```bash
bash cloudmail.sh deploy
```

脚本支持：

- `deploy`：构建并启动 Docker 服务
- `status`：查看容器状态
- `logs`：查看日志
- `restart`：重启服务
- `update`：重新构建并启动
- `enable-ssl`：用 nginx + certbot 配置 HTTPS
- `uninstall`：停止并删除容器，保留数据卷
- `menu`：打开交互菜单

## 配置

首次部署会根据 `.env.example` 生成 `.env`。至少修改这几项：

```env
JWT_SECRET=change-me-at-least-32-random-chars
ADMIN=admin@yourdomain.com
DOMAIN=["yourdomain.com"]
```

常用端口：

```env
PORT=3000
SMTP_PORT=2525
SMTP_PUBLIC_PORT=25
```

一键部署默认会把服务器宿主机的 25 端口映射到容器的 2525：

```yaml
ports:
  - "3000:3000"
  - "25:2525"
```

注意：不少云服务器默认封禁 25 端口，需要在云厂商后台申请解封，并在安全组/防火墙放行 25、3000、80、443。

## 手动 Docker 部署

```bash
cp .env.example .env
# 编辑 .env
docker compose up -d --build
docker compose logs -f cloudmail
```

访问：

- Web UI + API：`http://服务器IP:3000`
- SMTP 接收：`服务器IP:25`

## DNS

将你的域名 MX 记录指向这台服务器。例如：

```text
example.com.    MX    10    mail.example.com.
mail.example.com. A          服务器公网 IP
```

生产环境建议同时配置 SPF、DKIM、DMARC。收信只需要 MX 能到达服务器；发信信誉、退信率和进垃圾箱问题需要额外维护。

## 技术栈

- 后端：Node.js、Hono、Drizzle、SQLite
- 前端：Vue 3、Element Plus、Pinia、Vite
- 邮件解析：postal-mime
- SMTP 接收：smtp-server
- 发送服务：Resend
- 附件存储：默认本地缓存，可在后台配置 S3 兼容存储

## 目录结构

```text
cloudmail_server
├── cloudmail.sh              # 一键部署/运维脚本
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── mail-worker               # Node 后端
│   ├── src/server.js         # 服务器入口
│   ├── src/smtp              # SMTP 接收
│   ├── src/adapter           # SQLite 数据和缓存适配层
│   ├── src/api               # API
│   ├── src/service           # 业务服务
│   └── scripts/build-server.mjs
└── mail-vue                  # Vue 前端
```

## 常用命令

```bash
bash cloudmail.sh status
bash cloudmail.sh logs
bash cloudmail.sh restart
bash cloudmail.sh enable-ssl
```

## 许可证

本项目采用 [MIT](LICENSE) 许可证。
