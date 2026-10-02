# 开发、验证与贡献

## 环境

| 项目 | 要求 |
| --- | --- |
| Node.js | 24 |
| pnpm | 11.9.0，与根 `package.json` 一致 |
| Python | CI 使用 3.12，供原生依赖构建 |
| macOS | Xcode Command Line Tools／Clang |
| Windows | Visual Studio 2022 C++ Build Tools 与 Windows SDK |

依赖版本以提交到仓库的 `package.json` 和 `pnpm-lock.yaml` 为准。`pnpm-workspace.yaml` 明确允许需要的原生构建，不应为解决安装问题而全局放开所有依赖脚本。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 启动 Electron 开发环境。应用配置保存在 Electron 的 `userData` 目录；`CLOUDHELM_USER_DATA` 可指定独立测试目录，避免混用个人配置。

## 仓库布局

```text
apps/desktop/src/
  main/          窗口、IPC、持久化与凭据保护
  preload/       对 renderer 暴露的窄接口
  renderer/      React 界面与状态投影
  worker/        utility process 中的 SSH 和 Agent 装配
packages/
  core/          业务类型、端口和纯策略
  application/   安全入口、输入协调、终端控制与写锁
  adapters/      Pi、SSH、SQLite 和 Bash 解析实现
  contracts/     renderer/main/worker 的边界类型
scripts/         UI、Markdown、Electron 启动及依赖探针
.github/workflows/ci.yml
```

职责与依赖规则见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [AGENTS.md](../AGENTS.md)。不得从 renderer 直接导入后端适配器，不得让适配器互相依赖具体实现。手写源文件原则上不超过 800 行，函数保持单一职责；复用逻辑提取为职责明确的模块。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发版 |
| `pnpm build` | 编译主进程、preload、worker 和界面 |
| `pnpm check` | TypeScript、Vitest、ESLint、依赖方向与行数检查 |
| `pnpm test:ui` | 使用模拟后端验证 renderer 交互 |
| `pnpm test:markdown` | 验证 Markdown 排版、链接和代码复制 |
| `pnpm --filter @cloudhelm/desktop package` | 编译、重建 Electron 原生模块并生成本平台目录包 |
| `pnpm test:desktop` | 启动编译后的真实 Electron 应用 |
| `pnpm test:desktop:packaged` | 启动目录包并检查其自身依赖与资源 |

### 浏览器测试

```sh
pnpm exec playwright install chromium
pnpm test:ui
pnpm test:markdown
```

`test:ui` 使用假 SSH、假模型、文档地址和假凭据，不连接用户服务器；覆盖主机菜单、私钥选择、未保存配置测试、对话切换、审批、接管及友好错误。截图在 `.cache/ui-smoke/`。

`test:markdown` 验证 GFM、代码复制、原始 HTML 禁用、外链协议和图片隐私，截图在 `.cache/markdown-smoke/`。本机可用 `CLOUDHELM_SMOKE_BROWSER_CHANNEL=chrome` 选择已安装的 Chrome；Windows PowerShell 设置环境变量时使用 `$env:CLOUDHELM_SMOKE_BROWSER_CHANNEL = 'chrome'`。

### 桌面测试

先生成目录包以完成 Electron 原生依赖重建，再执行：

```sh
pnpm --filter @cloudhelm/desktop package
pnpm test:desktop
pnpm test:desktop:packaged
```

测试使用独立临时 `userData`，验证 preload 隔离、SQLite、Tree-sitter WASM、safeStorage 加解密和窗口渲染。连接测试探针启动临时 loopback SSH 服务，通过 renderer → main → worker 验证指纹、密码认证、连接清理，以及不保存主机、不打开 Shell。私钥选择器的自动测试使用原生对话框替身，不读取真实私钥。

截图写入 `.cache/desktop-smoke/`。可以通过 `--executable=/absolute/path/to/executable` 指定待检查的打包程序。原生模块发生 ABI 不匹配时，应为当前 Electron 重新构建依赖；不要复制另一平台的 `node_modules` 代替构建。

### 可选真实 SSH／Pi 协议集成

默认测试中另有三项依赖显式本地 SSH 服务的集成测试，未设置环境变量时跳过：

| 变量 | 含义 |
| --- | --- |
| `CLOUDHELM_TEST_SSH_KEY` | 临时本地测试服务的私钥路径；设置后启用测试 |
| `CLOUDHELM_TEST_SSH_PORT` | 本地 SSH 端口，默认 22388 |
| `CLOUDHELM_TEST_SSH_USER` | 测试账户，默认读取当前用户 |
| `CLOUDHELM_TEST_REMOTE_ROOT` | 远端临时目录；macOS 默认 `/private/tmp`，其他平台默认 `/tmp` |

准备临时账户与服务后运行 `pnpm test`。测试只连接 `127.0.0.1`，包含真实 PTY、SFTP、安装确认以及真实 Pi SDK 对本地模型协议 fixture 的多轮调用。使用专用测试环境，不要把测试端口转发到生产服务器。

这些测试中的模型回答是预设数据，不能证明真实模型可以独立完成部署。验收清单见 [STATUS.md](STATUS.md)。

## 打包与 GitHub Actions

目录包默认在 `apps/desktop/dist/`。制作安装包可在对应原生平台执行：

```sh
# macOS，按本机架构选择 arm64 或 x64
pnpm --filter @cloudhelm/desktop exec electron-builder --mac dmg --arm64 --publish never

# Windows x64
pnpm --filter @cloudhelm/desktop exec electron-builder --win nsis --x64 --publish never
```

执行上述命令前先运行目录包构建和桌面测试。生产分发需要另行配置签名／公证；当前 CI 生成未签名安装包，不自动创建 Release。

[CI 工作流](../.github/workflows/ci.yml) 在 push、Pull Request 和手动触发时运行：

| 构建目标 | 原生 runner | 安装包 Artifact |
| --- | --- | --- |
| macOS arm64 | `macos-15` | `CloudHelm-macos-arm64` |
| macOS x64 | `macos-15-intel` | `CloudHelm-macos-x64` |
| Windows x64 | `windows-2022` | `CloudHelm-windows-x64` |

每个平台依次完成锁文件安装、`pnpm check`、UI/Markdown 测试、目录包构建、编译后与打包后 Electron 测试，再生成 DMG／NSIS。三个平台独立运行；同一源分支的新运行会取消旧运行。`smoke-平台名` 保存截图，安装包和截图保留 7 天。

工作流仅请求仓库内容只读权限，不需要模型 Key、生产 SSH 凭据或发布 Token。Fork PR 的工作流可能需要维护者批准；手动运行入口需要工作流已存在于默认分支。状态以对应提交的 Checks 为准，不用历史绿色结果代替新提交结果。

## 提交与 PR

1. 阅读仓库约束，检查当前分支和未提交改动，保留其他人的工作。
2. 用 `git remote -v` 核对仓库地址；`origin`、`upstream` 是本地别名，不代表固定账户。
3. 在自己的仓库使用功能分支开发，默认采用 `codex/` 前缀；提交信息使用简体中文。
4. 运行与改动相关的检查，更新使用说明和真实验证边界。
5. 推送自己的分支，向维护者指定的项目仓库及基线分支发起 PR。未指定时核对项目默认分支。
6. PR 说明问题、最终行为、测试证据和剩余限制，等待维护者审核；不要自动合并或覆盖对方分支。

提交代码或 PR 前检查差异，避免加入私钥、API Key、用户数据库、个人终端日志及本地构建产物。文档修改只需核对命令、链接与实现是否一致；不必为纯文字修改编写实现镜像测试。
