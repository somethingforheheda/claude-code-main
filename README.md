# Claude Code 源码编译运行指南

## 环境要求

- [Bun](https://bun.sh) >= 1.3.11
- Node.js >= 18.0.0

## 快速开始

### 1. 安装依赖

```bash
# 使用 npm 安装依赖（推荐，Bun 可能因网络问题失败）
npm install

# 或尝试使用 Bun
bun install
```

> **注意**：本项目包含 4 个 Anthropic 私有包的 stubs（位于 `stubs/` 目录），用于解决编译时的依赖缺失问题。这些 stubs 已通过 `bunfig.toml` 配置的路径别名自动映射，无需额外操作。

### 2. 编译

```bash
bun run build
```

编译成功后会在根目录生成 `cli.js`（约 22MB）。

### 3. 运行

```bash
# 设置 API Key
export ANTHROPIC_API_KEY=your_api_key_here

# 启动交互界面
bun cli.js

# 或直接传入 prompt（非交互模式）
bun cli.js -p "你好"
```

### 常用命令

```bash
bun cli.js --version       # 查看版本
bun cli.js --help          # 查看帮助
bun cli.js --model <model> # 指定模型
```

---

## 项目说明

本项目为 `@anthropic-ai/claude-code v2.1.88` 源码，使用 **Bun** 作为构建工具，基于 TypeScript + React (Ink) 构建的终端 AI 编程助手。

### 技术栈

| 技术 | 用途 |
|------|------|
| Bun | 构建工具 + 运行时 |
| TypeScript | 主要开发语言 |
| React + Ink | 终端 UI 渲染 |
| Zod v4 | 数据校验 |
| @anthropic-ai/sdk | Anthropic API 客户端 |
| @modelcontextprotocol/sdk | MCP 协议支持 |

---

## 构建细节

### 编译命令（完整）

```bash
bun build src/entrypoints/cli.tsx --outfile cli.js --target bun \
  --define 'MACRO.VERSION="2.1.88"' \
  --define 'MACRO.BUILD_TIME="2025-01-01T00:00:00Z"' \
  --define 'MACRO.FEEDBACK_CHANNEL="https://github.com/anthropics/claude-code/issues"' \
  --define 'MACRO.ISSUES_EXPLAINER="https://github.com/anthropics/claude-code/issues"' \
  --define 'MACRO.NATIVE_PACKAGE_URL="https://npmjs.com"' \
  --define 'MACRO.PACKAGE_URL="https://npmjs.com"' \
  --define 'MACRO.VERSION_CHANGELOG=""'
```

`MACRO.*` 是 Bun 编译时宏，在源码中作为常量使用，必须在构建时注入。

### 路径别名

项目在 `bunfig.toml` 中配置了路径别名：

```toml
[build]
alias = { "src" = "./src", "react/compiler-runtime" = "react-compiler-runtime" }
```

源码中 `src/xxx` 的绝对路径引用通过此别名解析到 `./src/xxx`。

---

## 私有包存根说明

以下 4 个 Anthropic 内部私有包在 npm 上不公开，已在 `stubs/` 目录中创建功能存根，并通过 `bunfig.toml` 路径别名自动映射：

| 包名 | 对应功能 | 影响 |
|------|----------|------|
| `@ant/claude-for-chrome-mcp` | Claude in Chrome 浏览器控制 | Chrome 集成不可用 |
| `@ant/computer-use-mcp` | Computer Use 鼠标键盘控制 | Computer Use 不可用 |
| `@anthropic-ai/mcpb` | MCP 插件包（.dxt 格式）安装 | 插件市场不可用 |
| `@anthropic-ai/sandbox-runtime` | 沙箱文件/网络权限隔离 | 沙箱模式不可用 |

**新增 stubs（位于 `stubs/` 目录）：**

| 包名 | 对应功能 | 影响 |
|------|----------|------|
| `@anthropic-ai/bedrock-sdk` | AWS Bedrock 集成 | Bedrock 模式不可用 |
| `@anthropic-ai/foundry-sdk` | Anthropic Foundry 集成 | Foundry 模式不可用 |
| `@anthropic-ai/vertex-sdk` | Google Vertex AI 集成 | Vertex 模式不可用 |
| `@aws-sdk/client-bedrock` | AWS Bedrock 客户端 | Bedrock 模型列表不可用 |

核心对话、代码编辑、工具调用等主要功能不受影响。`npm install` 不会覆盖这些 stubs。

---

## 认证方式

### 方式一：API Key（推荐开发用）

```bash
export ANTHROPIC_API_KEY=sk-ant-xxxx
bun cli.js
```

### 方式二：OAuth 登录

```bash
bun cli.js
# 启动后在界面中选择登录，走 claude.ai 授权流程
```

### 方式三：AWS Bedrock

```bash
export AWS_ACCESS_KEY_ID=xxx
export AWS_SECRET_ACCESS_KEY=xxx
export AWS_REGION=us-east-1
bun cli.js --model anthropic.claude-3-5-sonnet-20241022-v2:0
```

---

## 修改源码后如何验证

仓库中已包含编译好的 `cli.js`，可以直接 `bun cli.js` 运行，**不需要重新编译**。

如果你修改了源码想验证效果，流程如下：

```bash
# 1. 修改源码（src/ 目录下的任意文件）

# 2. 重新编译
bun run build

# 3. 运行验证
bun cli.js
```

**注意**：以下模块涉及 Anthropic 内部私有包，修改后无法编译：

- `src/utils/claudeInChrome/` — Chrome 集成
- `src/utils/sandbox/` — 沙箱模式
- `src/skills/bundled/claudeInChrome.ts`
- `src/utils/plugins/mcpbHandler.ts`

其他绝大部分功能（UI、命令、工具调用、对话逻辑等）均可正常编译验证。

---

## 常见问题

**Q: 运行后界面卡住？**
A: 正常现象，Ink (React 终端 UI) 启动需要 1-2 秒，等待即可。

**Q: `MACRO is not defined` 报错？**
A: 需要用 `bun run build` 重新编译，直接运行 `.ts` 源文件不行。

**Q: API Error: `headers?.get is not a function`？**
A: 升级 zod 到 v4：`bun add zod@^4`，然后重新 `bun run build`。

**Q: `organization has been disabled` 报错？**
A: API Key 所属组织被禁用。如果是环境变量设置的 Key，尝试 `unset ANTHROPIC_API_KEY` 后用 OAuth 登录。
