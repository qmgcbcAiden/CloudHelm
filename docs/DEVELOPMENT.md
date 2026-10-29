# 开发、验证与贡献

## 环境

| 项目 | 要求 |
| --- | --- |
| Node.js | 24 |
| pnpm | 11.9.0，与根 `package.json` 一致 |
| Python | CI 使用 3.12，仅供本地 Node 原生依赖构建；远端不要求 Python |
| Go | 固定 1.27.3；creack/pty 1.1.24、x/sys 0.49.0，见 go.mod/go.sum |
| macOS | Xcode Command Line Tools／Clang |
| Windows | Visual Studio 2022 C++ Build Tools 与 Windows SDK |

依赖版本以提交到仓库的 `package.json` 和 `pnpm-lock.yaml` 为准。`pnpm-workspace.yaml` 明确允许需要的原生构建，不应为解决安装问题而全局放开所有依赖脚本。

```sh
pnpm install --frozen-lockfile
pnpm build:native
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
Tests/           按模块分区的单元／集成测试、专用 fixture、smoke 与离线评估
scripts/         版本、发布、Git 钩子及工程检查（无测试实现）
.github/workflows/ci.yml
```

职责与依赖规则见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [AGENTS.md](../AGENTS.md)。不得从 renderer 直接导入后端适配器，不得让适配器互相依赖具体实现。手写源文件原则上不超过 800 行，函数保持单一职责；复用逻辑提取为职责明确的模块。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发版 |
| `pnpm build` | 编译主进程、preload、worker 和界面 |
| `pnpm check` | TypeScript、Vitest、ESLint、依赖方向、行数与测试目录检查，以及版本／更新日志校验 |
| `pnpm lint:tests` | 阻止测试文件、快照和专用 fixture 混入业务与工程脚本目录 |
| `pnpm version:set` | 从根目录 `version.json` 同步各包版本与 README；传入参数（如 `pnpm version:set 0.2.0`）时先写入 `version.json`。通常无需手动运行，pre-commit 钩子会自动同步 |
| `pnpm version:check` | 只校验 `version.json`、各 `package.json` 与 README 版本一致，不一致退出非零 |
| `pnpm test:ui` | 使用模拟后端验证 renderer 交互 |
| `pnpm test:markdown` | 验证 Markdown 排版、链接和代码复制 |
| `pnpm test:ai-panel` | 使用模拟后端检查 AI 侧栏、权限入口、计划与折叠 |
| `pnpm --filter @cloudhelm/desktop package` | 编译、重建 Electron 原生模块并生成本平台目录包 |
| `pnpm test:desktop` | 启动编译后的真实 Electron 应用 |
| `pnpm test:desktop:packaged` | 启动目录包并检查其自身依赖与资源 |

### 集中测试工作区

测试统一放在根目录 [`Tests/`](../Tests/README.md)，按 `core`、`application`、`adapters`、`contracts`、`desktop` 分区；测试专用辅助模块也留在这里。`Tests/smoke/` 保存浏览器和桌面探针，`Tests/scripts/` 测试工程脚本，`Tests/evaluation/` 只处理离线对照元数据。产品中的 `host-connection-test.ts`／`.tsx` 是用户连接测试功能，仍属于业务代码。

`Tests/package.json` 是独立私有 workspace，依赖使用已验证的固定版本，版本同步和提交钩子也覆盖它；不加入桌面发行依赖。业务代码禁止反向导入测试。TypeScript、ESLint、依赖与 800 行检查都覆盖测试；页面 fixture 也纳入类型检查。

```sh
pnpm test --maxWorkers=2
pnpm exec vitest run Tests/desktop/worker/verification-user-workflow.test.ts
pnpm lint:tests
```

`pnpm test` 仍运行完整默认集合，`--maxWorkers=2` 可用于内存或冷启动受限的本机。环境跳过不算真实环境验收，不通过新增排除掩盖失败。

### 浏览器测试

```sh
pnpm exec playwright install chromium
pnpm test:ui
pnpm test:markdown
```

`test:ui` 使用假 SSH、假模型、文档地址和假凭据，不连接用户服务器；覆盖主机菜单、私钥选择、未保存配置测试、对话时间线、用户消息复制／编辑、窗口与终端尺寸、审批、接管、右键菜单（终端／输入框／主机／对话／标签）与快捷键设置录制，以及友好错误。截图在 `.cache/ui-smoke/`。

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

### 远端命令执行组件

Agent 命令需要远端 Python 3。固定组件通过 SFTP 放置在私有临时目录，仅负责启动目标程序、回传输出和退出码及隔离 sudo 密码通道。普通人工 SSH 终端不依赖此组件。缺少 Python 3 时提示并暂停，不自动安装或换用复杂 Shell 包装。

安全审核先用 Tree-sitter 解析命令；缺少 `tree-sitter-bash.wasm` 时分析器不可用，所有 Agent 命令都会被拒绝并暂停任务（失败不放行）。语法文件有三处部署位置，按顺序取第一个存在的：打包后的 `resources/tree-sitter-bash.wasm`、构建产物目录（`out/main/tree-sitter-bash.wasm`，由 `electron.vite.config.ts` 随主进程构建产出，覆盖 dev、`electron-vite preview` 和 `electron .`）、以及源码/测试解析到的 `tree-sitter-bash` 包。未打包运行时不能依赖模块解析，因为产物目录看不到适配器自己的 `node_modules`。

sudo 支持可静态解析的前台命令列表（`;`、换行、`&&`、`||`），每条实际执行前复核授权。只有 sudo 发出 askpass 请求时才弹出密码输入。终端完整显示远端用户名、主机、工作目录、原始命令和输出；提示符及命令回显与操作输出分开，PTY 从启动时采用当前窗口尺寸。AI 提示符采用标准 Bash 样式，不加载用户自定义 PS1。人工接管立即打开原生交互 Shell，可按需执行 `su -`。

已验证的 sudo 密码仅在 worker 内存中缓存 5 分钟（固定期限，使用不续期），绑定任务、主机、登录和执行身份、终端及连接代次和策略版本；暂停、断线、接管、认证失败和任务结束时清除。缓存只响应专用 askpass 请求，不向业务 stdin 投递。认证再次挑战时丢弃旧值并重新提示，命令仍逐条经过 SafetyGate。

工具结果显式区分认证成功、需要认证和认证失败：退出码 0 优先于输出中的历史重试提示。`sudo -n` 缺少认证可恢复，`sudo -l/-v` 探测不发送到远端，也不暂停任务；真实认证拒绝仍暂停。诊断日志记录认证状态和 `authentication.reused` 关联事件，不记录凭据。Docker 默认 socket 权限失败在相同身份和终端内短暂记忆 60 秒，阻止同批次重复失败的普通查询，由模型提出新的 sudo 操作并重新审核。

Agent 命令环境禁用 Git/systemd 分页器和 Git 终端认证，采用 UTF-8，避免日志分页等待和中文转义。人工终端环境不受影响。

sudo 的默认回归测试可单独运行：

```sh
pnpm exec vitest run Tests/desktop/worker/sudo-terminal.integration.test.ts Tests/adapters/ssh-command-terminal.test.ts Tests/adapters/remote-command-program.test.ts
```

其中真实本地进程／PTY 测试使用 sudo 替身验证 askpass 密码隔离、免密和取消路径，不连接生产服务器，也不修改本机 sudo 策略。真实服务器验收和剩余兼容性边界见 [STATUS.md](STATUS.md)。

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

执行上述命令前先运行目录包构建和桌面测试。生产分发需要另行配置签名／公证。

### 版本号与自动发布

根目录 `version.json` 是版本号的唯一来源。发布新版本的流程：

1. 编辑根目录 `version.json`（只改这一处）。`pnpm install` 的 prepare 生命周期会把 git `core.hooksPath` 指向 `.githooks`，提交时 pre-commit 钩子自动同步根与各 workspace `package.json` 的 `version`（含 `apps/desktop`，即 electron-builder 与 `app.getVersion()` 的来源）以及 README 版本说明并加入暂存；不想用钩子时可手动运行 `pnpm version:set <新版本>`。
2. 在根目录 [CHANGELOG.md](../CHANGELOG.md) 补写该版本小节，整理**上一版本到本版本之间的全部更新**（格式与分类见文件内编写约定，素材可用 `git log v<上一版本>..HEAD --oneline` 汇总）。忘了写不拦截：提交升版时 pre-commit 钩子会自动补一条「修复了一些已知问题」默认条目并把 CHANGELOG.md 并入本次提交，之后可润色并补充提交。
3. 提交并推送 `version.json`、更新日志与同步结果到默认分支。
4. CI 在三平台构建与检查全部通过后，若本次 push 修改了 `version.json` 且 `v<版本>` 标签不存在，自动创建 GitHub Release（**标记为预发布**；Release 说明正文取自 CHANGELOG.md 对应版本小节，末尾附加 GitHub 自动生成的提交清单）并附上 DMG×2 与 NSIS 安装包；其余情况只构建、不发布。缺条目或提取失败时说明回退为纯自动生成，不拦截发布。发布 job 只在推送到 `dev`（开发仓库主线）或默认分支（总仓库）时运行，其余分支的推送只构建。

判定逻辑在 `scripts/release-decision.mjs`（含单元测试）；同步逻辑在 `scripts/set-version.mjs`（`--check` 供 CI 校验），钩子逻辑在 `scripts/pre-commit-version.mjs`（含单元测试；版本不一致且未改 `version.json` 时会拦截提交，避免不一致进入仓库）；更新日志的解析、提取与默认条目补写在 `scripts/changelog.mjs`（含单元测试；`pnpm changelog:check` 只提醒不拦截）。同一版本的标签已存在时不会重复发布；如发布中断需要补发，可在 Actions 页面手动运行 CI 并勾选 `force_publish`（标签不存在时自动补发当前版本）。

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

## 原生组件验收

`pnpm build:native` 使用固定 Go 版本及 `CGO_ENABLED=0` 构建两种 Linux ELF，生成 SHA-256 清单。`CLOUDHELM_GO` 可指定固定工具链路径；不接受静默使用不同版本。`verify-native-helper.mjs` 检查 ELF 架构、程序头、无动态解释器/依赖及工件摘要；三种桌面包的真实 Electron 冒烟都检查随包的两种工件。

`.github/workflows/native-linux.yml` 使用专用隔离账户、合成凭据、临时 sshd 和 PAM，执行 amd64/arm64 × glibc/musl。`Tests/native/` 的测试通过真实 SSH 字节流驱动组件。跳过不算通过；SELinux 使用专用 enforcing 环境，普通容器无法代替该证据。当前修复轮的运行结果记录在 [TOOLS_REPAIR_STATUS.md](TOOLS_REPAIR_STATUS.md)。
