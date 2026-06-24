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

Docker 镜像内默认安装并使用 `zsh`，同时安装了 `zsh-autosuggestions` 和 `zsh-syntax-highlighting`。容器内 zsh 配置位于 `/data/zsh/.zshrc`，历史记录位于 `/data/zsh/.zsh_history`，都会随 `screen-plus-data` 卷持久化。

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
- `SCREEN_BIN`: screen 可执行文件，默认 `screen`
- `SCREEN_PLUS_SCREENRC`: screen 配置文件路径，默认项目内 `screen-plus.screenrc`
- `SCREEN_PLUS_PREFIX`: 自动创建会话名前缀，默认 `sp`
- `SCREEN_PLUS_STATE_DIR`: 最近使用会话状态目录，默认项目内 `.screen-plus`
- `SCREEN_PLUS_CONFIG`: 认证配置文件路径，默认 `.screen-plus/config.json`，Docker 中默认 `/data/config.json`
- `SCREEN_PLUS_LOCALE`: 终端 UTF-8 locale，默认跟随环境变量，容器中默认 `C.UTF-8`
- `SCREEN_PLUS_SHELL`: screen 会话使用的 shell，Docker 中默认 `/usr/bin/zsh`
- `SHELL`: screen 会话默认 shell，Docker 中默认 `/usr/bin/zsh`
- `ZDOTDIR`: zsh 配置目录，Docker 中默认 `/data/zsh`

默认 `screen-plus.screenrc` 配置了自然滚动和 10000 行 scrollback：

```screenrc
termcapinfo xterm* ti@:te@
termcapinfo xterm-256color* ti@:te@
defscrollback 10000
defutf8 on
```

这类配置对新创建的 screen 会话生效；已有会话需要关闭后重建。

## 镜像发布

仓库包含 GitHub Actions 工作流 `.github/workflows/docker-image.yml`。推送到 `main`/`master`、推送 `v*.*.*` tag 或手动触发工作流时，会构建并发布镜像到：

```text
ghcr.io/qinggeng2015/screen-plus
```
