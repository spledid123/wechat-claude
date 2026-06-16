# WeChat Claude

WeChat Claude 是一个本地运行的微信 Claude 桥接程序。它把微信消息交给 Claude Agent 处理，再把回复、生成文件或定时任务结果发回微信；正式版本通过 Electron 托盘运行，并提供本地管理面板。

这份 README 面向接手项目的人类工程师。普通使用者请看 [用户版 exe 使用说明](docs/user-exe-guide.md)，架构细节请看 [项目架构与打包说明](docs/architecture.md)，微信接口细节请看 [微信 iLink Bot API 实战文档](docs/wechat-ilink-api.md)。

## 当前状态

- 正式源码在 `src/`，核心业务模块在 `src/features/`。
- `test/` 保留为回归测试和历史分阶段文档；正式运行时不再从 `test/features` 引用代码。
- 本地数据默认写入程序所在目录旁边的 `.wechat-claude/`，不会提交到 git。
- Windows portable exe 通过 `electron-builder` 生成，产物在 `release/`，不会提交到 git。

## 快速开始

```powershell
npm install
npm run build:app
npm start
```

启动后会打印本地管理面板地址，默认类似：

```text
Admin panel : http://127.0.0.1:8787/
Data dir    : D:\path\to\project\.wechat-claude
```

如果还没有微信 token，服务不会退出；打开管理面板刷新二维码、扫码确认并保存 token，然后重启服务。

## 常用命令

```powershell
npm start
```

启动正式 CLI 服务。

```powershell
npm run build:app
```

编译正式 app，并复制数据库迁移文件到 `dist/`。

```powershell
npm run electron:dev
```

编译后用 Electron 启动托盘程序。

```powershell
npm run dist:win
```

生成 Windows 单文件 portable exe。

```powershell
npm run dist:win:dir
```

生成 `release/win-unpacked/` 目录版。

```powershell
npm run dist:win:zip
```

生成目录版并压缩为 zip。

## 测试

```powershell
npm test
npx tsc --noEmit
```

重点回归：

```powershell
npm test -- test/runtime/service.test.ts test/runtime/electron-main.test.ts
```

注意：部分测试仍然使用 `test/features` 中的历史实现，用于保留阶段性回归；正式运行时代码已经迁移到 `src/features`。

## 目录结构

```text
src/                 正式源码
src/features/        微信连接、Claude 会话、桥接、文件处理、调度器、管理后台
src/runtime/         正式服务运行时
src/electron/        Electron 托盘入口
src/types/           生产构建需要的补充类型声明
scripts/             正式构建、启动和打包脚本
docs/                使用、架构、打包说明
test/                回归测试与历史分阶段测试文档
```

## 本地数据和忽略规则

以下目录/文件是本地运行或构建产物，已在 `.gitignore` 中忽略：

```text
.wechat-claude/
.tmp/
dist/
release/
node_modules/
.env
.claude/
test_output.json
```

不要把 token、SQLite 数据库、工作区、日志、打包产物提交到 git。

## 交接提示

- 数据库迁移文件在 `src/features/01-claude-dialogue/db/migrations/`。
- 管理后台在 `src/features/07-frontend-admin/admin.ts`。
- 微信收发 API 在 `src/features/02-wechat-connectivity/wechat/`，参数和踩坑见 [微信 iLink Bot API 实战文档](docs/wechat-ilink-api.md)。
- Claude 权限和工作区限制在 `src/features/01-claude-dialogue/claude/permissions.ts`。
- Electron portable 数据目录修复逻辑在 `src/electron/paths.ts`。
