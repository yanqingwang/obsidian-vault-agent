# Vault Agent

中文优先的 Obsidian vault 智能体插件——直连国产大模型 API（OpenAI 兼容协议），智能体可自主**搜索、读取、创建、修改**你的笔记。无需安装任何 CLI，无需海外账号，无需配置环境变量。

A China-first Obsidian agent plugin that talks directly to OpenAI-compatible LLM APIs and can autonomously search, read, create, and edit your notes. No CLI, no proxy, no foreign payment wall.

**报告日期：2026年09月13日** · v0.1.0

## 为什么做这个 / Why

海外的同类形态（[Claudian](https://github.com/yishentu/claudian)）依赖 Claude Code CLI 与海外订阅，国内用户配置门槛高且支付困难。Vault Agent 把同一形态的智能体体验变成**填一个 API Key 就能用**：

| 你想用 | 选这个预设 |
|---|---|
| DeepSeek 深度求索 | `DeepSeek` |
| 智谱 GLM / Z.ai | `智谱 GLM` / `Z.ai` |
| Kimi（月之暗面） | `Kimi` |
| 通义 Qwen（Qoder 同源模型） | `通义 Qwen (DashScope)` |
| 豆包/Seed（Trae 同源模型） | `火山方舟 Ark`（填接入点 ID） |
| 腾讯混元（WorkBuddy 同源模型） | `腾讯混元 Hunyuan` |
| Hermes（Nous Research） | `Hermes` 或 `OpenRouter` |
| 其他任意 OpenAI 兼容服务 | `自定义` |

> Trae / Qoder / WorkBuddy 本体不对外提供个人 API 通道，本插件支持的是它们背后的模型服务商官方 API（火山方舟、DashScope、腾讯混元），申请即用、人民币计费。

## 功能 / Features

- **智能体工具调用**：`search_notes` / `read_note` / `list_notes` / `get_active_note` / `create_note` / `edit_note`（精确替换）/ `append_note` / `read_properties`，单轮可多步连续操作。
- **流式输出**：SSE 流式渲染，支持 reasoning（DeepSeek-R1 / Kimi thinking 等）；直连失败自动降级为非流式（Obsidian requestUrl）。
- **本地代理（可选）**：AI 请求可经本机 HTTP 代理转发（`http://` 绝对 URI 直转、`https://` CONNECT 隧道），仅桌面端。
- **写操作确认**：默认每次创建/修改前询问；可在设置中开启自动执行。
- **上下文感知**：自动告知当前打开的笔记路径，方便直接整理正在编辑的内容。
- **中文优先**：内置中文系统提示与界面，可切换英文；自定义系统提示词。
- **会话保留**：最近对话自动保存，重启后继续；完整记录另存为可检索的 `history.jsonl`（见下）。

## 使用 / Usage

1. 设置 → Vault Agent → 选择服务商 → 粘贴 API Key → 选择模型。
2. 点击左侧 ribbon 图标（或命令面板 "Open Vault Agent"）打开侧栏对话。
3. 例如：「找出最近关于 X 的笔记整理成一篇 MOC」「把当前笔记的结尾改成总结段落」。

## 本地代理 / Local proxy

设置 → Vault Agent → **本地代理（可选）** 填 `host:port`（如 `http://127.0.0.1:9000`；需认证时写 `user:pass@host:port`），
AI 请求即经该代理转发，便于抓包排查或在受限网络下中转；留空直连。仅桌面端生效，不支持 SOCKS。

## 会话历史 / Conversation history

聊天过程中，插件把每条事件（用户消息、助手回答、思考、工具调用与结果）追加写入
`.obsidian/plugins/vault-agent/history.jsonl`。`data.json` 里只留最近 40 条用于恢复界面，
这份 JSONL 才是带时间戳、带会话 id、带工具调用的完整记录。用 `tools/history_db.py`
（仅标准库）导入 SQLite，即可随时检索：

```bash
python tools/history_db.py import                  # 增量导入，可重复执行
python tools/history_db.py search 同步任务          # 全文检索（FTS5 trigram，支持中文）
python tools/history_db.py search --tool read_note  # 按工具过滤
python tools/history_db.py sessions                # 列出会话
python tools/history_db.py show <session 前缀>      # 打印某个会话的完整对话
python tools/history_db.py stats
```

数据库默认落在 JSONL 同目录（`history.db`）；导入按事件 id 去重，重复运行只写入新增事件。
路径可用 `--vault <vault 根目录>` 或 `--jsonl/--db` 指定。

## 安全 / Safety

- API Key 只存本机 Obsidian 配置（`data.json`），不上传。
- 智能体没有删除、移动文件与执行命令的工具；写操作默认需确认。
- 长笔记读取与工具结果均自动截断，控制 token 成本。

## 开发 / Development

```bash
npm install
npm run build   # tsc 检查 + esbuild 产出 main.js
npm test        # node 端到端单测（mock SSE 服务 + 工具循环 + 历史记录器）
```

## License

MIT
