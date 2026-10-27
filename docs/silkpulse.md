# SilkPulse H5 调试接入

## 项目与代码

当前项目是 TypeScript + Webpack 的 ws-scrcpy H5；已有 iPhone 触控分支继续使用，无须新建工作区。

- 主入口：`src/public/index.html`、`src/app/index.ts`。
- iPhone 检测入口：`src/public/iphone-touch.html`。
- 调试引导：`src/public/silkpulse-bootstrap.js`；构建配置：`webpack/silkpulse.ts`、`webpack/ws-scrcpy.common.ts`。
- 独立验证页：`src/public/silkpulse-check.html`、`silkpulse-check.js`。
- 服务：`https://debug.foxhello.com`；SDK：`/sdk.js`；设备通道：`wss://debug.foxhello.com/ws/device`。
- SilkPulse 项目：`ws-scrcpy`，ID：`cs_4ee29f3c9b4d814c27d14518`，标签：`ws-scrcpy,production,cloudphone-h5`。

页面 head 中的同源外部引导脚本先于业务脚本执行。开启后，它给官方 SDK 设置 `data-server`、`data-project-id`、`data-device-token` 和 `data-tags`。业务启动最多等待 SDK 1.5 秒；失败或超时后继续启动。SDK 晚到仍可连接，早期事件可能遗漏。`loaded` 仅代表脚本已加载，连接状态应在控制台/API 核实。SPA 重入通过全局标志去重；关闭时刷新页面，移除已安装的采集钩子。

## 配置与凭证边界

复制 `silkpulse.public.example.json` 为被 Git 忽略的 `.silkpulse.public.local.json`，填入业务项目的 **projectId 和 deviceToken**。可用 `SILKPULSE_PUBLIC_CONFIG=/absolute/path/public.json` 指定其他位置。该配置会进入浏览器，deviceToken 是设备注册令牌，不是项目 API Key。

允许的字段只有：`server`、`projectId`、`deviceToken`、`environment`、`tags`、`testDeviceIds`、`sessionMinutes`。包含其他字段时构建直接失败，防止误用私有配置。未提供项目/令牌时不加载 SDK，业务仍可运行。修改公开配置后需要重新构建。

私有配置已安全保存在：

- 本机：`/Users/fumingzhen/.config/silkpulse/ws-scrcpy.json`。
- SilkPulse 服务器：`/home/ubuntu/.config/silkpulse/projects/ws-scrcpy.json`。

目录权限 0700，文件权限 0600。私有 JSON 包含 `SILKPULSE_SERVER`、`SILKPULSE_API_KEY` 及项目注册信息，不能作为前端公开配置。管理员凭证只在 `oracle.server` 容器环境中使用，未复制到本机。API Key 不进入仓库、前端构建或部署包。

项目 API Key 只用于 AI/服务器 API 的 `Authorization: Bearer <项目 API Key>`；不要放入 URL、聊天、命令参数或浏览器配置。关闭调试后不发送后续采集，历史记录仍保留在 SilkPulse。排障请使用测试账号及必要页面，避免采集无关敏感业务内容。

## 开启、关闭与指定设备

生产环境默认关闭；没有全局默认开启选项。

- 当前标签页排障：打开 `http://192.168.31.16:8000/?silkpulse=1#!action=stream&udid=emulator-5554&player=mse`。
- 关闭：打开同一页面，把查询参数改为 `?silkpulse=0`；或在验证页点击“关闭本会话调试”。
- iPhone 检测页：`http://192.168.31.16:8000/iphone-touch.html?silkpulse=1`，后续同标签页、同源跳转沿用会话。
- 独立采集验证：`http://192.168.31.16:8000/silkpulse-check.html?silkpulse=1`。

查询参数放在 `#!` 之前。引导读取后会从地址栏移除它，保留业务 hash 路由。会话保存于 sessionStorage，默认 30 分钟，`sessionMinutes` 可配置 1–120 分钟；有效期在页面加载时检查，已打开页面不会到点自动断开。需要立即停止时使用关闭链接/按钮刷新。关闭状态优先于测试设备名单。Safari 禁止存储时，显式链接仍能在当前页启用，但跨页不保证保留。

指定测试设备自动开启：在该浏览器控制台读取 `window.WSSilkPulse.testDeviceId`，加入公开配置 `testDeviceIds` 数组后重新构建部署。它是本浏览器本源的随机选择器，不是 SilkPulse `/api/devices` 中的设备 ID。清理网站数据会改变它；名单不是鉴权边界。也可在 Safari Web Inspector 读取该值。流页面还会把 hash 路由中的 `udid` 和 `player` 作为安全标签上报，例如 `udid-emulator-5554`、`player-mse`，用于在控制台区分对应云手机和播放器。

## 手机验证步骤

1. iPhone 与 H5 服务网络互通，在 Safari 打开上面的启用链接。若旧页面仍在，重新加载以使用新 HTML。
2. 在 SilkPulse 控制台选择 `ws-scrcpy`，确认设备在线、URL 为该 H5、标签含项目和环境。
3. 打开独立验证页，等待 `SDK 状态：loaded`，点击“运行采集验证”。页面会显示唯一 `silkpulse-check-...` 标记、HTTP 状态，并触发一个明确标记的测试错误；不修改云手机。
4. 用项目 API/CLI 核对 logs、network、errors 都包含该标记。验证页使用严格 CSP，快照/exec 限制见下一节。
5. 返回业务页操作云手机，观察业务日志及请求；只读远程验证使用 `return location.href`。
6. 使用关闭链接，确认新页面没有 `#ws-silkpulse-sdk`，业务照常启动；验证设备连接结束。

本轮已经用真实桌面浏览器验证。iPhone 16 Pro / Safari iOS 26.6.1 的实际设备连接与触控排障记录仍需在手机打开链接后验证；桌面浏览器不能替代真机结论。

## CSP

当前业务入口未设置 CSP。若后续增加 CSP，请将下列源合并到现有策略，不要覆盖业务原有资源源：

```text
script-src ... https://debug.foxhello.com;
connect-src ... https://debug.foxhello.com wss://debug.foxhello.com;
```

本地 bootstrap/check 使用外部脚本，需要允许 `'self'`。验证页提供禁止内联脚本、禁止动态执行的独立严格 CSP；已验证 SDK 加载、WSS 注册、日志/请求/错误采集。

官方 SDK 当前通过 `new Function` 执行远程代码；`GET /snapshot` 也通过 exec 调用快照函数。因此不含 `'unsafe-eval'` 的严格 CSP 会阻止 **exec 和 snapshot**。接入没有放宽 CSP；需要这些能力时须评估应用 CSP 或推动上游提供兼容实现。当前无 CSP 的业务页已完成只读执行。一次预览快照请求曾超时，不能把 SDK 脚本 loaded 等同于所有 API 可用。

## AI 排障

仓库内保留上游官方 CLI：`tools/skill/scripts/silkpulse.mjs`。来源、固定提交及许可证见 `tools/skill/UPSTREAM.md`。官方 Skill：<https://github.com/2234839/silkpulse/blob/master/tools/skill/SKILL.md>。

优先通过本仓库包装器运行，它从私有配置加载项目 API Key，仅通过子进程环境传给官方 CLI，不打印密钥：

```sh
node scripts/silkpulse.mjs devices
node scripts/silkpulse.mjs snapshot DEVICE_ID
node scripts/silkpulse.mjs logs DEVICE_ID
node scripts/silkpulse.mjs network DEVICE_ID
node scripts/silkpulse.mjs errors DEVICE_ID
node scripts/silkpulse.mjs exec DEVICE_ID 'return location.href'
```

AI 可先 devices 选择本次排障设备，再读取日志/请求/错误及快照，以 URL、时间、标签、唯一标记关联证据。`exec` 具有修改页面的能力，本轮验证只使用只读代码；其他交互应由具体排障任务授权。

如在其他机器运行，可通过秘密管理器注入 `SILKPULSE_API_KEY`，并设置 `SILKPULSE_SERVER=https://debug.foxhello.com`；或用 `SILKPULSE_PRIVATE_CONFIG=/private/path/ws-scrcpy.json` 指向权限 0600 的私有文件。官方 CLI 需要支持内置 fetch 的 Node.js（建议 Node 20+）。

直接 API 同样只用项目 Bearer：`GET /api/devices`、`GET /api/devices/{id}/snapshot`、`/logs`、`/network`、`/errors`；只读执行 `POST /api/devices/{id}/exec`，JSON 为 `{"code":"return location.href"}`。不要使用管理员 Key 调试业务。

## 构建与检查

```sh
node scripts/test-silkpulse.js
node scripts/test-touch-input.js
node scripts/test-touch-pressure.js
npm run dist:prod
```

本次沿用现有发布方式，只构建并发布生产前端，保留已有后端进程；源码与静态资源一起备份，可回滚。正式发布文件名含内容哈希，先发布资源，最后原子替换 HTML。普通构建仍使用仓库的 `npm run dist:prod`。

已验证公开 HTTPS、SDK HTTP 200、WSS 实际设备注册；服务器本地通过有效证书校验访问 HTTPS 源站成功。**Cloudflare 控制台的 Full (strict) 模式尚未确认**：公网 HTTPS 和有效源站证书不能证明该开关状态，需要在 Cloudflare SSL/TLS 页面或具备域名读取权限的 API 中确认。此次未获得 Cloudflare API 凭证，未修改该设置。
