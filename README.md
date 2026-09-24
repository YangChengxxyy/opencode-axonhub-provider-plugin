# opencode-axonhub-provider-plugin

OpenCode v2 plugin that registers an [AxonHub](https://github.com/looplj/axonhub) gateway as a provider.
- 自动获取模型列表：`GET {baseURL}/v1/models`（默认每 5 分钟刷新）
- 思考强度：推理模型暴露 `low` / `medium` / `high` variants（模型选择器中切换，如 `glm-5.3/high`）
- 价格 / 上下文上限 / 能力元数据：从 [models.dev](https://models.dev/) 自动匹配（厂商官方价，或 ZenMux 网关价），无需手工配置
- 可配置 baseURL、协议（`openai` / `anthropic`）、apiKey
- 支持 `/connect`：注册 `AxonHub` 集成，TUI 里 `/connect → AxonHub → 输入 API key` 即可，连接后自动拉取模型列表

## 使用

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./path/to/opencode-axonhub-provider-plugin",
      "options": {
        "baseURL": "https://llm.cccloud.xin",
        "apiKey": "ah-...",
        "protocol": "openai",       // 或 "anthropic"（走 /anthropic/v1/messages）
        "pricing": "canonical",     // canonical=厂商官方价 | zenmux=ZenMux 网关价 | none=关闭
        "refreshMs": 300000          // 0 关闭自动刷新
      }
    }
  ]
}
```

`apiKey` 缺省读 `AXONHUB_API_KEY`，`baseURL` 缺省读 `AXONHUB_BASE_URL`（再缺省 `https://llm.cccloud.xin`）。

### 通过 /connect 设置 API key（推荐）

```jsonc
{
  "plugins": [
    {
      "package": "./path/to/opencode-axonhub-provider-plugin",
      "options": { "baseURL": "https://llm.cccloud.xin" }
    }
  ]
}
```

不配置任何 key 时插件照常加载（模型列表暂时为空），然后在 TUI 里 `/connect → AxonHub → API key` 输入即可；连接成功后自动拉取模型列表，切换/断开 key 也会自动刷新。模型请求的鉴权由 OpenCode 按 integration 自动注入，不会写进配置文件。

key 解析优先级：`options.apiKey` → `AXONHUB_API_KEY` 环境变量 → `/connect` 连接的 credential。

协议说明：
- `openai`：注册 provider `axonhub`，`baseURL = {baseURL}/v1`，思考强度映射为 `reasoning_effort`
- `anthropic`：注册 provider `axonhub-anthropic`，`baseURL = {baseURL}/anthropic`，思考强度映射为 `thinking.effort`

价格与元数据：基于 `https://models.dev/api.json`，按模型 ID 匹配（大小写、`4.5`/`4-5` 版本风格归一化，支持 `vendor/model` 前缀）。api.json 会缓存到磁盘（`$XDG_CACHE_HOME/opencode-axonhub-provider-plugin/api.json`，默认 `~/.cache/...`）：启动时先读缓存（离线也能秒开），随后后台拉取最新数据并热更新；每次模型列表刷新时也会重新拉取并回写缓存。`pricing: "canonical"` 优先取厂商官方数据（anthropic/openai/zai/deepseek/minimax/moonshotai/xai/stepfun/xiaomi），`"zenmux"` 优先取 ZenMux 网关价。匹配不到的模型回退 ID 启发式（价格留空）。注意：这是上游公开牌价，若你的 AxonHub 渠道有折扣/加价，以 AxonHub 后台实际计费为准。

## 开发

```sh
bun install
bun x tsc --noEmit
```
