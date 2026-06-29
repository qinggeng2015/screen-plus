# Screen Plus

一个基于 `screen` 的远程 Web 终端界面。进入页面会自动选择默认 screen 会话：没有会话时创建一个；再次进入时优先打开最近使用且未被占用的会话；如果最近会话已被占用，则顺延打开其他空闲会话，全部占用时创建新会话。

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

`npm start` 会从 `dist/` 提供前端静态文件，并通过 `/term` WebSocket 桥接到本机 `screen`。

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
- `SCREEN_BIN`: screen 可执行文件，默认 `screen`
- `SCREEN_PLUS_SCREENRC`: screen 配置文件路径，默认项目内 `screen-plus.screenrc`
- `SCREEN_PLUS_PREFIX`: 自动创建会话名前缀，默认 `sp`
- `SCREEN_PLUS_STATE_DIR`: 最近使用会话状态目录，默认项目内 `.screen-plus`
- `SCREEN_PLUS_CONFIG`: 认证配置文件路径，默认 `.screen-plus/config.json`，Docker 中默认 `/data/config.json`
- `SCREEN_PLUS_LOCALE`: 终端 UTF-8 locale，默认跟随环境变量，容器中默认 `en_US.UTF-8`
- `SCREEN_PLUS_SHELL`: screen 会话使用的 shell，Docker 中默认 `/usr/bin/zsh`
- `SCREEN_PLUS_HOME`: 新建 screen 会话和 attach 进程的默认目录，默认使用当前用户 HOME
- `SHELL`: screen 会话默认 shell，Docker 中默认 `/usr/bin/zsh`
- `ZDOTDIR`: zsh 配置目录，Docker 中默认 `/data/zsh`

默认 `screen-plus.screenrc` 配置了自然滚动和 10000 行 scrollback：

```screenrc
termcapinfo xterm* ti@:te@
termcapinfo xterm-256color* ti@:te@
defscrollback 10000
defutf8 on
utf8 on on
```

这类配置和 locale 环境对新创建的 screen 会话生效；已有会话里的 shell 环境不会在重新连接时自动改变，需要关闭后重建。乱码排查时，可以先在 Screen Plus 终端里执行：

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

This project uses GNU Screen at runtime. GNU Screen is free software licensed under the GNU General Public License, either version 3 or, at your option, any later version. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for details.
