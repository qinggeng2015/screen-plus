# Screen Plus

一个支持会话保持和断线恢复的远程 Web 终端。服务端直接管理 shell 的 PTY 进程，浏览器负责显示和输入。进入页面时优先恢复最近使用的会话，包括接管旧页面尚未断开的连接；最近的会话已结束时，选择其他空闲会话，没有空闲会话则创建一个。

## 开发运行

```bash
npm install
npm run dev
```

前端默认监听 `0.0.0.0:5173`，后端默认监听 `0.0.0.0:3000`。本机可用 `http://127.0.0.1:5173` 访问，局域网设备用这台机器的局域网 IP 访问。

## 生产运行

```bash
npm run build
npm start
```

`npm start` 会从 `dist/` 提供前端静态文件，并通过 `/term` WebSocket 连接服务端管理的终端会话。在终端中可以直接使用本机 shell，也可以通过 SSH 连接远端后运行 Codex 等交互工具。

终端输出保留应用的原始同步刷新标记。前后端使用相同的终端行列限制，防止大屏或极小窗口下换行、光标定位不一致。

运行 `npm test` 可验证终端会话保持、画面恢复及终端尺寸一致性。运行 `node tests/integration/terminal-web.cjs` 可验证 HTTP/WebSocket、断线重连、会话接管和真实 PTY 的尺寸传播；集成测试需要 Node.js、已安装的 `node-pty`、`sh` 和 `stty`，会创建临时目录和独立会话，不连接已有会话。

### 会话保持与恢复

浏览器断线、刷新、关闭页面或切换会话时，服务端的终端和子进程继续运行。重新打开会话会恢复服务端保存的终端画面和最多 10000 行滚动历史。

同一会话同时只由一个页面控制。如果会话已被其他页面占用，可以在会话列表中接管，旧页面会显示断开提示。断线后可重新连接原会话，继续操作运行中的程序。

会话和终端画面只在当前服务进程存活期间保留。重启服务、重启或更新容器会结束会话及子进程，也不会恢复到新服务中，部署前应先保存工作。数据卷持久化的是认证配置、用户文件和 shell 历史，不是运行中的进程或终端画面。

首次访问页面时需要设置用户名和密码。密码会以哈希形式保存到配置文件中，后续重启服务不需要重新设置。

页面包含 Web App Manifest 和 Service Worker，可在 Android Chrome 中通过浏览器菜单安装到桌面，安装后会以独立窗口方式打开。Chrome 对完整 PWA 安装通常要求 HTTPS，`localhost` 例外；如果使用局域网 IP 访问，建议在前面加 HTTPS 反向代理，否则浏览器可能只显示“添加到主屏幕”。

如果需要挂在反向代理的子路径下，例如通过 `/screen/`、`/a/`、`/b/` 访问当前服务，服务会默认从请求路径自动推断前缀。反向代理需要同时转发 HTTP 和 WebSocket。以 Nginx 为例：

```nginx
location /screen/ {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Prefix /screen;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

如果你的代理规则会把路径改写得比较复杂，也可以显式固定前缀：

```bash
SCREEN_PLUS_BASE_PATH=/screen npm start
```

## Docker 运行

直接使用 Docker Compose：

```bash
docker compose up -d
```

默认访问地址：

```text
http://127.0.0.1:3000
```

`docker-compose.yml` 会把 `/data` 挂载到命名卷 `screen-plus-data`，认证配置默认保存到 `/data/config.json`。只要这个卷不删除，设置完密码后重启或重建容器都不会二次设置。

Docker 镜像内默认安装了 `openssh-client`，并默认使用 `zsh`，同时安装了 `zsh-autosuggestions` 和 `zsh-syntax-highlighting`。容器内默认用户目录是 `/data/home`，zsh 配置位于 `/data/zsh/.zshrc`，历史记录位于 `/data/zsh/.zsh_history`，都会随 `screen-plus-data` 卷持久化。

也可以使用已发布镜像：

```bash
docker run -d \
  --name screen-plus \
  --restart unless-stopped \
  -p 3000:3000 \
  -v screen-plus-data:/data \
  ghcr.io/qinggeng2015/screen-plus:latest
```

## 配置

- `PORT`: 后端监听端口，默认 `3000`
- `HOST`: 后端监听地址，默认 `0.0.0.0`
- `SCREEN_PLUS_BASE_PATH`: 显式指定反向代理子路径，例如 `/screen`；默认空，表示自动推断
- `SCREEN_PLUS_PREFIX`: 自动创建会话名前缀，默认 `sp`
- `SCREEN_PLUS_STATE_DIR`: 最近使用会话状态目录，默认项目内 `.screen-plus`
- `SCREEN_PLUS_CONFIG`: 认证配置文件路径，默认 `.screen-plus/config.json`，Docker 中默认 `/data/config.json`
- `SCREEN_PLUS_LOCALE`: 终端 UTF-8 locale，默认跟随环境变量，容器中默认 `en_US.UTF-8`
- `SCREEN_PLUS_SHELL`: 终端会话使用的 shell，Docker 中默认 `/usr/bin/zsh`
- `SCREEN_PLUS_HOME`: 新建终端会话的默认目录，默认使用当前用户 HOME
- `SHELL`: 未指定 `SCREEN_PLUS_SHELL` 时使用的默认 shell，Docker 中默认 `/usr/bin/zsh`
- `ZDOTDIR`: zsh 配置目录，Docker 中默认 `/data/zsh`

shell、工作目录和 locale 等配置对新创建的终端会话生效；已有会话里的 shell 环境不会在重新连接时自动改变，需要关闭后重建。乱码排查时，可以先在 Screen Plus 终端里执行：

```bash
locale
```

正常情况下至少 `LANG` 和 `LC_CTYPE` 应该是 UTF-8，例如 `en_US.UTF-8`。如果先进入 Screen Plus 再 `ssh` 到其他服务器，SSH 默认可能会把本地 locale 发送到远端；因此 Screen Plus 会清理非 UTF-8 的 `LC_*` 并只传递 UTF-8 的字符分类环境，避免远端 shell 落回 ASCII/C locale。

## 镜像发布

仓库包含 GitHub Actions 工作流 `.github/workflows/docker-image.yml`。推送到 `main`/`master`、推送 `v*.*.*` tag 或手动触发工作流时，会构建并发布镜像到：

```text
ghcr.io/qinggeng2015/screen-plus
```

## License

Screen Plus is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).

Dependency license metadata is described in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
