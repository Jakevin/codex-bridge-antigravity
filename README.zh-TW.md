# codex-bridge-antigravity

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

輕量級本機 OpenAI Responses API 橋接器，將 Google Antigravity 官方 CLI (`agy`) 無縫整合至 OpenAI Codex（支援 Desktop 與 CLI），同時完整保留原生 GPT 模型的路由與認證機制。

![Codex 模型選單顯示原生 GPT 與 Antigravity 模型](assets/model-selector.png)

---

## 專案概述

OpenAI Codex 的 WebSocket 與 HTTP 端點設定屬於 **Provider 層級**（供應商層級），而非個別模型層級。因此，`codex-bridge-antigravity` 在本機建立了一套智慧反向路由器：

- **原生 GPT / Codex 模型**：原樣轉發給官方 ChatGPT / Codex 後端，沿用您 Codex 現有的 Bearer 登入憑證與 Session。
- **Antigravity 模型（`antigravity/*`）**：由本機路由器攔截，轉譯為官方 `agy` CLI 命令並以 `stream-json` 事件串流方式執行，再包裝回標準 OpenAI Responses SSE/WebSocket 格式。

這讓您在同一個工作區與同一個 Codex 模型選單中，能自由且無縫地在 GPT 與 Gemini 模型間切換。

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
│  官方 OpenAI/ChatGPT 後端        │   │ Google Antigravity   │
│  (原生 Bearer Token 透傳)        │   │ 官方 CLI (`agy`)     │
└──────────────────────────────────┘   └──────────────────────┘
```

---

## 主要特點

- **零干擾雙向共存**：原生 GPT 模型依舊直連官方後端，完全不會被傳入 Antigravity。
- **動態模型目錄同步**：自動從 `agy models` 即時讀取可用模型（如 Gemini 3.8 Flash、Gemini 3.8 Pro）。
- **修復 Codex 切換模型錯誤**：修正模型目錄中的 `use_responses_lite = false`，徹底解決切換到 Antigravity 模型時 Codex 前端帳號驗證崩潰的問題。
- **對話歷程壓縮（Compaction）**：完整實作 `/v1/responses/compact` 端點，符合 OpenAI Compact API 規格，對話過長時能自動完成摘要總結。
- **一鍵安裝與安全復原**：`setup` 自動備份並設定 `~/.codex/config.toml`；隨時可透過 `disconnect` 指令完全還原。

---

## 前置需求

- **Node.js**：`>= 22.0.0`
- **Google Antigravity CLI (`agy`)**：已安裝並完成官方帳號登入（執行 `agy models` 需能列出模型）。
- **OpenAI Codex**：已安裝 Codex Desktop 或 Codex CLI。

---

## 快速開始

### 1. 檢測與診斷

複製此專案並檢測本機環境：

```bash
git clone https://github.com/Jakevin/codex-bridge-antigravity.git
cd codex-bridge-antigravity

# 執行自動化回歸測試
npm test

# 診斷 agy 與 Codex 本機設定路徑
node src/cli.mjs doctor
```

### 2. 啟動本機守護程序（Daemon）

啟動橋接伺服器（預設監聽連接埠 `17842`）：

```bash
node src/cli.mjs serve --cwd "$PWD"
```

在另一個終端機視窗測試端點：

```bash
# 健康檢查
curl http://127.0.0.1:17842/healthz

# 查詢模型目錄
curl http://127.0.0.1:17842/v1/models

# 測試生成回答
curl http://127.0.0.1:17842/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"antigravity/gemini-3.8-flash-low","input":"Reply with exactly AGY_OK"}'
```

### 3. 整合至 Codex

將橋接器寫入 Codex 設定檔中：

```bash
node src/cli.mjs setup --cwd "$PWD" --replace-codex-route
```

重新啟動 Codex Desktop 應用程式或重新開啟 Codex CLI。現在模型選單中除了原生的 GPT 模型外，還會出現 `Antigravity — ...` 模型可供選取。

### 4. 取消整合與還原

若想還原至執行 `setup` 前的 Codex 設定，隨時執行：

```bash
node src/cli.mjs disconnect
```

---

## 執行模式

執行 `serve` 時，可透過 `--mode` 指定 AGY 的工作模式：

- **`accept-edits`（預設）**：AGY 會在指定工作區內自動執行其程式修改與工具呼叫。
- **`plan`（唯讀規劃模式）**：僅進行規劃與診斷，不更動工作區檔案：
  ```bash
  node src/cli.mjs serve --cwd "$PWD" --mode plan
  ```

---

## 環境變數與設定檔

設定檔案預設存放在 `~/.codex-bridge-antigravity/`。

可透過下列環境變數自訂路徑與連接埠：

| 環境變數 | 說明 | 預設值 |
|---|---|---|
| `PORT` | 橋接器 HTTP/WebSocket 連接埠 | `17842` |
| `AGY_PATH` | 官方 `agy` 執行檔路徑 | 自動從 `$PATH` 搜尋 |
| `CODEX_HOME` | Codex 設定目錄 | `~/.codex` |
| `CODEX_ANTIGRAVITY_HOME` | 橋接器狀態存放目錄 | `~/.codex-bridge-antigravity` |

---

## 常見問題與排除

- **Codex 切換模型時報錯 (`use_responses_lite`)**：本版本已將模型規格中的 `use_responses_lite` 設為 `false`，避免 Codex upstream 驗證被拒絕。
- **連接埠衝突**：若 `17842` 已被其他本機代理（如 Freebuff 或其他服務）佔用，可指定 `PORT=17845 node src/cli.mjs serve`，並重新執行 `setup`。
- **AGY 授權失效**：若收到認證錯誤，請在終端機執行 `agy auth` 於瀏覽器中重新授權 Google 帳號。

---

## 合規與免責聲明

`codex-bridge-antigravity` 是一個獨立、非商業性的個人本機開發輔助工具，旨在供開發者於本機 (`localhost`) 串接自己已獲官方授權之帳號與憑證。

- 本專案與 OpenAI 或 Google 無官方隸屬、背書或贊助關係。
- 透過橋接器傳送的所有請求，均使用使用者自己的憑證與配額。
- 請勿將本工具用於多租戶公開架設、轉售服務、或違反平台服務條款之未授權模型蒸餾與擷取行為。

---

## 授權條款

本專案採用 [MIT License](LICENSE) 授權 © 2026 Jakevin
