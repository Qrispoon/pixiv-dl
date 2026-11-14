# pixiv-tag-dl

按 Pixiv 标签批量下载作品，支持最低收藏数过滤，文件名固定为 `{画师}-{pid}-{收藏数}`。
Windows 优先，Node.js 零运行时依赖，动图默认转 GIF。

> 非官方工具，仅用于个人备份自己有权访问的内容。请遵守 Pixiv 服务条款，控制请求频率。

## 功能

- 按标签搜索（支持多标签、精确/部分匹配、日期范围）
- 收藏数下限/上限、R-18、AI、作品类型过滤
- 原图多页下载：`_p0/_p1/...`
- 动图 ugoira：默认转 GIF，可切换 MP4 / 原始 ZIP
- 断点续跑、失败清单 `ptdl retry`、并发下载、限速与 429 冷却
- 本机 HTTP(S) 代理支持（`--proxy` 或 `HTTPS_PROXY`）

## 环境要求

- Windows 10/11（其他平台未测试）
- Node.js **>= 24**
- 动图转码：`ffmpeg`（Windows 自带 `tar` 用于解 zip）

## 安装

```powershell
git clone https://github.com/Qrispoon/pixiv-dl.git
cd pixiv-tag-dl
npm link          # 之后可直接使用 ptdl；也可以 node bin/ptdl.mjs
```

## 快速开始

```powershell
# 代理（也可以写在 ptdl.config.json 里）
$env:HTTPS_PROXY = 'http://127.0.0.1:10090'
$env:HTTP_PROXY  = 'http://127.0.0.1:10090'
$env:NODE_USE_ENV_PROXY = '1'

# 1) 登录：token 只保存到本机 .secrets/
ptdl login

# 2) 自检
ptdl doctor

# 3) 先 dry-run 看候选
ptdl download 初音ミク -m 1000 --since 2024-01-01 --dry-run

# 4) 下载
ptdl download 初音ミク -m 1000 -o "D:\pixiv\miku"

# 5) 失败重试
ptdl retry -o "D:\pixiv\miku"
```

登录遇到 `pixiv://` 回调问题时，可用浏览器 cookie 直接换取 token：

```powershell
node scripts/login.mjs --cookie "PHPSESSID=..."
```

## 常用参数

```text
-o, --out <dir>           输出目录（默认 ./downloads）
-m, --min-bookmarks <n>   收藏数下限
-n, --limit <n>           最多下载作品数
--since / --until         日期范围（YYYY-MM-DD）
--r18 exclude|include|only
--ai exclude|include|only
--type illust|manga|all
--ugoira gif|mp4|zip|skip 动图格式（默认 gif）
--ugoira-width <px>       GIF/MP4 宽度（默认 540）
--name <模板>             默认 {artist}-{id}-{bookmarks}
--by-tag                  按标签建子目录
--jobs / --delay          并发与 API 间隔
--dry-run / --json / -v
```

完整参数：`ptdl --help`。

## 配置

复制 [`ptdl.config.example.json`](ptdl.config.example.json) 为 `ptdl.config.json`（或放到 `%APPDATA%\pixiv-tag-dl\config.json`）。
优先级：CLI > 环境变量 > 项目配置 > 用户配置 > 默认值。

## 文档

- [可行性报告（接口实测与限制）](docs/01-可行性报告.md)
- [项目方案（架构/算法/里程碑）](docs/02-项目方案.md)
- [命令速查](docs/03-命令速查.md)
- [M2 开发计划](docs/04-M2开发计划.md)
- [M1 测试报告](docs/05-M1测试报告-西行寺幽々子.md)
- [同类工具调研](docs/06-同类工具调研.md)

## 目录

```
bin/ptdl.mjs   CLI 入口
src/           实现（auth/http/pixiv/scan/filter/naming/state/download/ugoira）
test/          node:test 单测
scripts/       login / probe / coverage-lab / verify-range
docs/          报告与文档
```

## 已知限制

- 单日可见作品超过约 1 万时，非 Premium 账号无法保证枚举完整（会告警，不静默）；
- 非 Premium 账号没有服务端收藏数过滤/热门排序，扫描量较大；
- 受限/R-18 原图可能需要浏览器 cookie；
- 请自行控制频率，避免账号被临时限制。

## License

[MIT](LICENSE)
