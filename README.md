<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">基于 Cloudflare 的简约响应式邮箱服务，支持邮件发送、附件收发 🎉</p> 
    <p align="center">
        简体中文 | <a href="/README-en.md" style="margin-left: 5px">English </a>
    </p>
    <p align="center">
        <a href="https://github.com/maillab/cloud-mail/tree/main?tab=MIT-1-ov-file" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>    
        <a href="https://github.com/maillab/cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/maillab/cloud-mail" alt="releases" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/issues" >
            <img src="https://img.shields.io/github/issues/maillab/cloud-mail" alt="issues" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/stargazers" target="_blank">
            <img src="https://img.shields.io/github/stars/maillab/cloud-mail" alt="stargazers" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/forks" target="_blank" >
            <img src="https://img.shields.io/github/forks/maillab/cloud-mail" alt="forks" />
        </a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/20459" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/20459" alt="trendshift" >
        </a>
    </p>
</p>


## 项目简介

只需要一个域名，就可以创建多个不同的邮箱，类似各大邮箱平台。本项目支持部署到 Cloudflare Workers（低成本）或普通服务器（完全自主，不走 Cloudflare 转发）。

## 项目展示

- [在线演示](https://skymail.ink)<br>
- [部署文档](https://doc.skymail.ink)<br>

| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|-----------------------|-----------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |




## 功能介绍

- **💰 低成本使用**： 可部署到 Cloudflare Workers 降低服务器成本

- **💻 响应式设计**：响应式布局自动适配PC和大部分手机端浏览器

- **📧 邮件发送**：集成Resend发送邮件，支持群发，内嵌图片和附件发送，发送状态查看

- **🛡️ 管理员功能**：可以对用户，邮件进行管理，RABC权限控制对功能及使用资源限制

- **📦 附件收发**：支持收发附件，使用R2对象存储保存和下载文件

- **🔔 邮件推送**：接收邮件后可以转发到TG机器人或其他服务商邮箱

- **📡 开放API**：支持使用API批量生成用户，多条件查询邮件 

- **🔢 验证码识别**：使用Workers AI，自动识别邮件验证码 

- **📈 数据可视化**：使用ECharts对系统数据详情，用户邮件增长可视化显示

- **🎨 个性化设置**：可以自定义网站标题，登录背景，透明度

- **🤖 人机验证**：集成Turnstile人机验证，防止人机批量注册

- **📜 更多功能**：正在开发中...



## 技术栈

- **平台**：[Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web框架**：[Hono](https://hono.dev/)

- **ORM：**[Drizzle](https://orm.drizzle.team/)

- **前端框架**：[Vue3](https://vuejs.org/) 

- **UI框架**：[Element Plus](https://element-plus.org/) 

- **邮件推送：** [Resend](https://resend.com/)

- **缓存**：[Cloudflare KV](https://developers.cloudflare.com/kv/)

- **数据库**：[Cloudflare D1](https://developers.cloudflare.com/d1/)

- **文件存储**：[Cloudflare R2](https://developers.cloudflare.com/r2/)

## 服务器端部署（不使用 Cloudflare 转发）

本项目已支持直接部署在普通服务器（VPS / 独立服务器）上运行，不再依赖 Cloudflare Workers / KV / D1 / R2 / Email Routing。

### Docker 一键部署（推荐）

推荐使用项目根目录提供的 **一键运维脚本** `cloudmail.sh`（完整学习自 cloudmail-open-receiver.sh 的结构，支持菜单、状态持久化、自动安装 Docker、更新、日志、HTTPS 一键等）：

```bash
chmod +x cloudmail.sh
bash cloudmail.sh          # 交互菜单（推荐）
# 或直接
bash cloudmail.sh deploy
```

脚本会自动：
- 检测/安装 Docker
- 生成或引导配置 `.env`（JWT_SECRET、ADMIN、DOMAIN 等）
- 构建并启动容器（Web 3000 + 内置 SMTP 2525）
- 记录部署状态，后续可直接执行 `status`、`logs`、`restart`、`update`、`enable-ssl` 等

手动方式（不使用脚本）：
```bash
# 1. 创建 .env（关键配置）
cp mail-worker/.env.example .env
# 编辑 .env，修改 JWT_SECRET（必须）、ADMIN、DOMAIN

# 2. 启动
docker compose up -d --build

# 3. 查看日志
docker compose logs -f cloudmail
```

常用运维命令（无论是否用脚本）：
```bash
docker compose ps
docker compose logs -f cloudmail
docker compose restart cloudmail
docker compose down
```

- Web UI + API: `http://your-server-ip:3000`
- 内置 SMTP 接收: `your-server-ip:2525`（容器内）
- 数据持久化: Docker volume `cloudmail-data`（对应容器内 `/app/data`）

常用命令：
```bash
docker compose down
docker compose pull   # 更新镜像后
docker compose up -d --build
```

#### 生产 SMTP 端口 25
- MX 记录必须指向你的服务器
- 推荐做法：在 docker-compose 中把宿主机 25 映射到容器 2525：
  ```yaml
  ports:
    - "25:2525"   # 主机25 -> 容器2525
    - "3000:3000"
  ```
- 云服务器需在安全组/防火墙放行 25、2525、3000 端口。
- 部分云服务商默认封禁 25 端口，需工单申请解封。

#### 环境变量（docker-compose.yml 或 .env）
- `JWT_SECRET`（必填，强随机）
- `ADMIN` + `DOMAIN`（必填）
- `SMTP_PORT=2525`（可改成 25 如果直接映射）

### 纯 Node 部署（无 Docker）

### 快速开始

1. 克隆项目并进入 `mail-worker` 目录
2. 安装依赖：
   ```bash
   pnpm install
   ```
   注意：`better-sqlite3` 需要编译环境（Linux: `apt install python3 make g++` 或等价包）
3. 构建前端：
   ```bash
   pnpm run build:vue
   ```
   （会把 mail-vue 打包到 `mail-worker/dist`）
4. 复制配置：
   ```bash
   cp .env.example .env
   # 编辑 .env ，至少设置 JWT_SECRET、ADMIN、DOMAIN
   ```
5. 启动服务器：
   ```bash
   pnpm start:server
   # 开发热重载
   pnpm dev:server
   ```
6. 访问 http://your-server:3000

### 邮件接收（替代 Cloudflare Email Routing 转发）

- 服务器模式提供 `POST /receive` 端点用于接收邮件（webhook 方式）。
- 你可以使用任何支持“邮件转发到 HTTP / inbound webhook”的服务（ImprovMX、ForwardEmail、Mailgun Inbound Parse、自建 Postfix 转发等），将原始 MIME 内容 POST 到 `https://your-domain/receive`。
  - 推荐：`Content-Type: message/rfc822` + body 为完整 raw email，或 JSON `{ "to": "xxx@your.com", "raw": "完整MIME" }`
  - Header `X-To` 也可指定收件人。
- 域名 MX 记录需要指向能接收邮件并调用 webhook 的服务（或直接运行完整 MTA 后 webhook 调用本接口）。
- 注意：自建邮件接收涉及垃圾邮件、SPF/DKIM/DMARC、发信信誉等问题，生产环境请谨慎评估。

### 存储

- 默认使用本地磁盘（`data/attachments`、`data/static`）。
- 推荐配置 S3 兼容存储（MinIO、阿里云 OSS、AWS S3 等），在系统设置 → 高级设置 中填写 bucket / endpoint / accessKey / secretKey 即可切换，无需修改代码。
- 仍然支持 Resend 发信。

### 初始化

首次访问需调用一次初始化接口（带 JWT_SECRET）：
```
POST /init/你的jwt_secret
```
或直接访问首页后按提示操作。

### 与 Cloudflare 版本共存

- Worker 版本继续使用 wrangler 部署（wrangler.toml）。
- Server 版本使用 `src/server.js` + Node。
- 前端构建时通过 VITE_BASE_URL 控制 API 前缀（server 推荐 '' 或 '/api' 均已兼容）。

## 目录结构

```
cloud-mail
├── mail-worker				    # worker后端项目
│   ├── src                  
│   │   ├── api	 			    # api接口层			
│   │   ├── const  			    # 项目常量
│   │   ├── dao                 # 数据访问层
│   │   ├── email			    # 邮件处理接收
│   │   ├── entity			    # 数据库实体
│   │   ├── error			    # 自定义异常
│   │   ├── hono			    # web框架配置、拦截器、全局异常等
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 数据库缓存初始化
│   │   ├── model			    # 响应体数据封装
│   │   ├── security			# 身份权限认证
│   │   ├── service			    # 业务服务层
│   │   ├── template			# 消息模板
│   │   ├── utils			    # 工具类
│   │   └── index.js			# 入口文件
│   ├── pageckge.json			# 项目依赖
│   └── wrangler.toml			# 项目配置
│
├── mail-vue				    # vue前端项目
│   ├── src
│   │   ├── axios 			    # axios配置
│   │   ├── components			# 自定义组件
│   │   ├── echarts			    # echarts组件导入
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 入站初始化
│   │   ├── layout			    # 主体布局组件
│   │   ├── perm			    # 权限认证
│   │   ├── request			    # api接口
│   │   ├── router			    # 路由配置
│   │   ├── store			    # 全局状态管理
│   │   ├── utils			    # 工具类
│   │   ├── views			    # 页面组件
│   │   ├── app.vue			    # 入口组件
│   │   ├── main.js			    # 入口js
│   │   └── style.css			# 全局css
│   ├── package.json			# 项目依赖
└── └── env.release				# 项目配置
```

## 赞助

<a href="https://doc.skymail.ink/support.html" >
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## 许可证

本项目采用 [MIT](LICENSE) 许可证	


## 交流

[Telegram](https://t.me/cloud_mail_tg)



