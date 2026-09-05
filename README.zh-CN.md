# codex-bridge-antigravity

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

轻量级本地 OpenAI Responses API 桥接器，将 Google Antigravity 官方 CLI (`agy`) 无缝集成至 OpenAI Codex（支持 Desktop 与 CLI），同时完整保留原生 GPT 模型的路由与认证机制。

![Codex 模型菜单显示原生 GPT 与 Antigravity 模型](assets/model-selector.png)

---

## 项目概述

OpenAI Codex 的 WebSocket 与 HTTP 端点配置属于 **Provider 层级**（提供商层级），而非单个模型层级。因此，`codex-bridge-antigravity` 在本地构建了一套智能反向路由器：

- **原生 GPT / Codex 模型**：原样转发至官方 ChatGPT / Codex 后端，沿用您 Codex 现有的 Bearer 登录凭据与 Session。
- **Antigravity 模型（`antigravity/*`）**：由本地路由器拦截，转译为官方 `agy` CLI 命令并以 `stream-json` 事件流方式执行，再包装回标准 OpenAI Responses SSE/WebSocket 格式。

这让您可以在同一工作区以及同一 Codex 模型菜单中，自由无缝地在 GPT 与 Gemini 模型之间切换。

```
┌─────────────────────────────────────────────────────────────┐
│                        Codex Client                         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ (Provider 路由: 127.0.0.1:17842)
┌─────────────────────────────────────────────────────────────┐
│                  codex-bridge-antigravity                   │
│                                                             │
│   ┌───────────────────────────┐   ┌─────────────────────┐   │
│   │   原生 GPT / Codex 模型   │   │   antigravity/*     │   │
│   └─────────────┬─────────────┘   └──────────┬──────────┘   │
└─────────────────┼────────────────────────────┼──────────────┘
                  │                            │
                  ▼                            ▼
┌──────────────────────────────────┐   ┌──────────────────────┐
│  官方 OpenAI/ChatGPT 后端        │   │ Google Antigravity   │
│  (原生 Bearer Token 透传)        │   │ 官方 CLI (`agy`)     │
└──────────────────────────────────┘   └──────────────────────┘
```

---

## 主要特性

- **零干扰双向共存**：原生 GPT 模型依然直连官方后端，完全不会进入 Antigravity。
- **动态模型目录同步**：自动从 `agy models` 实时读取可用模型（如 Gemini 3.8 Flash、Gemini 3.8 Pro）。
- **修复 Codex 切换模型报错**：修复模型目录配置中的 `use_responses_lite = false`，彻底解决切换至 Antigravity 模型时 Codex 前端账号校验崩溃的问题。
- **对话历史压缩（Compaction）**：完整实现 `/v1/responses/compact` 端点，遵循 OpenAI Compact API 规范，对话过长时平滑自动总结。
- **一键配置与安全还原**：`setup` 自动备份并修改 `~/.codex/config.toml`；随时可使用 `disconnect` 命令完全还原。

---

## 前置要求

- **Node.js**：`>= 22.0.0`
- **Google Antigravity CLI (`agy`)**：已安装并完成官方账号登录（运行 `agy models` 需能列出模型）。
- **OpenAI Codex**：已安装 Codex Desktop 或 Codex CLI。

---

## 快速上手

### 1. 检测与诊断

克隆本项目并检测本地环境：

```bash
git clone https://github.com/Jakevin/codex-bridge-antigravity.git
cd codex-bridge-antigravity

# 运行自动化回归测试
npm test

# 诊断 agy 与 Codex 本地配置路径
node src/cli.mjs doctor
```

### 2. 启动本地守护进程（Daemon）

启动桥接服务器（默认监听端口 `17842`）：

```bash
node src/cli.mjs serve --cwd "$PWD"
```

在另一终端窗口测试端点：

```bash
# 健康检查
curl http://127.0.0.1:17842/healthz

# 查询模型目录
curl http://127.0.0.1:17842/v1/models

# 测试生成响应
curl http://127.0.0.1:17842/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"antigravity/gemini-3.8-flash-low","input":"Reply with exactly AGY_OK"}'
```

### 3. 集成至 Codex

将桥接器写入 Codex 配置文件：

```bash
node src/cli.mjs setup --cwd "$PWD" --replace-codex-route
```

重启 Codex Desktop 应用程序或重启 Codex CLI。现在模型菜单中除原生 GPT 模型外，还会出现 `Antigravity — ...` 模型可供选择。

### 4. 断开集成与恢复

若想还原至运行 `setup` 前的 Codex 配置，随时执行：

```bash
node src/cli.mjs disconnect
```

---

## 运行模式

运行 `serve` 时，可通过 `--mode` 指定 AGY 的工作模式：

- **`accept-edits`（默认）**：AGY 会在指定工作区内自动执行代码修改与工具调用。
- **`plan`（只读规划模式）**：仅进行方案规划与诊断，不修改工作区文件：
  ```bash
  node src/cli.mjs serve --cwd "$PWD" --mode plan
  ```

---

## 环境变量与配置文件

配置文件默认保存在 `~/.codex-bridge-antigravity/`。

可通过以下环境变量自定义路径与端口：

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 桥接器 HTTP/WebSocket 监听端口 | `17842` |
| `AGY_PATH` | 官方 `agy` 可执行文件路径 | 自动从 `$PATH` 查找 |
| `CODEX_HOME` | Codex 配置目录 | `~/.codex` |
| `CODEX_ANTIGRAVITY_HOME` | 桥接器运行时状态目录 | `~/.codex-bridge-antigravity` |

---

## 常见问题与排查

- **Codex 切换模型时报错 (`use_responses_lite`)**：本版本已将模型定义中的 `use_responses_lite` 设为 `false`，避免 Codex upstream 账号校验被拒。
- **端口冲突**：如果 `17842` 端口被其他本地代理占用，可指定 `PORT=17845 node src/cli.mjs serve` 并重新执行 `setup`。
- **AGY 认证失效**：如果收到认证错误提示，请在终端运行 `agy auth` 在浏览器中重新登录 Google 账号。

---

## 合规与免责声明

`codex-bridge-antigravity` 是一个独立的、非商业性质的个人本地开发辅助工具，供开发者在本地 (`localhost`) 串接自己拥有合法授权的账号与凭证。

- 本项目与 OpenAI 或 Google 无任何官方隶属、背书或赞助关系。
- 通过桥接器发送的所有请求，均消耗使用者自己的账户凭证与配额。
- 请勿将本工具用于多租户公网部署、商业转售、或违反平台服务条款的未授权模型蒸馏抓取。

---

## 开源协议

本项目采用 [MIT License](LICENSE) 授权 © 2026 Jakevin
