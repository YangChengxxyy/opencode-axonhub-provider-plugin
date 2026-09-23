/**
 * AxonHub provider plugin for OpenCode v2.
 *
 * - Auto-discovers models from an AxonHub gateway (`GET {baseURL}/v1/models`)
 * - Registers them under a configurable protocol ("openai" or "anthropic")
 * - Enriches models with pricing / context limits / reasoning capability from
 *   models.dev (canonical vendor rates, or ZenMux gateway rates)
 * - Exposes reasoning-effort (思考强度) variants for reasoning-capable models
 *
 * Options (opencode.jsonc `plugins: [{ package, options }]`):
 *   baseURL    - AxonHub root, default https://llm.cccloud.xin (env AXONHUB_BASE_URL)
 *   apiKey     - AxonHub API key (env AXONHUB_API_KEY)
 *   protocol   - "openai" | "anthropic" (default "openai")
 *   pricing    - "canonical" | "zenmux" | "none" (default "canonical")
 *                canonical = models.dev 厂商官方价; zenmux = ZenMux 网关价
 *   refreshMs  - model list refresh interval, default 300000 (0 disables)
 */
import { Model, Plugin, Provider } from "@opencode/plugin"

type Options = {
  baseURL?: string
  apiKey?: string
  protocol?: "openai" | "anthropic"
  pricing?: "canonical" | "zenmux" | "none"
  refreshMs?: number
}

const OPENAI_PKG = "@opencode/ai/providers/openai-compatible"
// anthropic-compatible 在 opencode 2.0.15 二进制里运行时解析裸包 '@opencode/ai' 失败，
// 改用内置 anthropic（同样 Anthropic 协议、支持 baseURL 覆盖）。
const ANTHROPIC_PKG = "@opencode/ai/providers/anthropic"
const MODELS_DEV_API = "https://models.dev/api.json"

const EFFORTS = ["low", "medium", "high"] as const

/** Model-ID substring heuristics: reasoning-capable model families (fallback). */
const REASONING_MATCHERS: RegExp[] = [
  /^(o[134](-mini)?|gpt-5|gpt-6)/, // OpenAI
  /^claude-(opus|sonnet|haiku)/, // Anthropic
  /^glm/, // Zhipu
  /^deepseek/,
  /^(kimi|moonshot)/i,
  /^minimax/i,
  /^grok/,
  /^qwen/, // Qwen thinking
  /^(step|doubao|seed)/i,
  /^(mimo|muse)/i,
]

function supportsReasoning(id: string): boolean {
  const lower = id.toLowerCase()
  return REASONING_MATCHERS.some((re) => re.test(lower))
}

/** Rough per-family context/output limits; unknown models get conservative defaults (fallback). */
const LIMITS: { match: RegExp; context: number; output: number }[] = [
  { match: /^claude-(opus|sonnet)-?5/, context: 200_000, output: 64_000 },
  { match: /^claude/, context: 200_000, output: 32_000 },
  { match: /^gpt-6|^o[134]/, context: 400_000, output: 128_000 },
  { match: /^gpt-5/, context: 400_000, output: 128_000 },
  { match: /^glm/, context: 200_000, output: 128_000 },
  { match: /^deepseek/, context: 164_000, output: 64_000 },
  { match: /^(kimi|moonshot)/i, context: 256_000, output: 64_000 },
  { match: /^minimax/i, context: 1_000_000, output: 128_000 },
  { match: /^grok/, context: 256_000, output: 128_000 },
  { match: /^qwen/, context: 262_000, output: 64_000 },
]

function limitsFor(id: string): { context: number; output: number } {
  const lower = id.toLowerCase()
  for (const l of LIMITS) if (l.match.test(lower)) return { context: l.context, output: l.output }
  return { context: 128_000, output: 32_000 }
}

interface AxonHubModel {
  id: string
  created?: number
}

async function fetchModels(baseURL: string, apiKey: string): Promise<AxonHubModel[]> {
  const res = await fetch(`${baseURL}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`AxonHub model list failed: ${res.status} ${await res.text().catch(() => "")}`)
  const body = (await res.json()) as { data?: AxonHubModel[] }
  return body.data ?? []
}

// ---------------------------------------------------------------------------
// models.dev enrichment
// ---------------------------------------------------------------------------

interface DevModel {
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

/** Normalize an id for fuzzy equality: case, and `4.5` vs `4-5` version styles. */
function norm(id: string): string {
  return id.toLowerCase().replaceAll(".", "-")
}

interface DevEntry {
  provider: string
  key: string
  nkey: string
  dev: DevModel
}

class ModelsDevIndex {
  private readonly exact = new Map<string, DevEntry[]>()
  private readonly suffix = new Map<string, DevEntry[]>()

  constructor(entries: DevEntry[]) {
    for (const e of entries) {
      push(this.exact, e.nkey, e)
      const slash = e.nkey.lastIndexOf("/")
      if (slash >= 0) push(this.suffix, e.nkey.slice(slash + 1), e)
    }
  }

  /**
   * Resolve metadata for a bare model id. Preference order:
   * pricingProvider (e.g. zenmux) → canonical vendors → any provider (exact key, then `vendor/id` suffix).
   */
  lookup(id: string, pricingProvider?: string): DevModel | undefined {
    const n = norm(id)
    // 合并 exact（裸 id）与 suffix（`vendor/id`）候选，再按 provider 优先级选一条，
    // 否则 canonical 裸 key 永远先命中，pricingProvider 排不到前面。
    const hits = [...(this.exact.get(n) ?? []), ...(this.suffix.get(n) ?? [])]
    if (hits.length === 0) return undefined
    return this.pick(hits, pricingProvider)?.dev
  }

  private pick(hits: DevEntry[], pricingProvider?: string): DevEntry | undefined {
    const order = [
      pricingProvider,
      "anthropic",
      "openai",
      "zai",
      "zhipuai",
      "deepseek",
      "minimax",
      "moonshotai",
      "xai",
      "stepfun",
      "xiaomi",
      "google",
    ].filter((p): p is string => typeof p === "string")
    for (const p of order) {
      const hit = hits.find((h) => h.provider === p)
      if (hit) return hit
    }
    return hits[0]
  }
}

function push(map: Map<string, DevEntry[]>, key: string, e: DevEntry): void {
  const list = map.get(key)
  if (list) list.push(e)
  else map.set(key, [e])
}

async function fetchModelsDev(): Promise<ModelsDevIndex | undefined> {
  try {
    const res = await fetch(MODELS_DEV_API)
    if (!res.ok) throw new Error(`${res.status}`)
    const body = (await res.json()) as Record<string, { models?: Record<string, DevModel> }>
    const entries: DevEntry[] = []
    for (const [provider, info] of Object.entries(body)) {
      for (const [key, dev] of Object.entries(info.models ?? {})) {
        if (dev.limit?.context || dev.cost) entries.push({ provider, key, nkey: norm(key), dev })
      }
    }
    return new ModelsDevIndex(entries)
  } catch (err) {
    console.error("[axonhub] models.dev fetch failed, falling back to heuristics:", err)
    return undefined
  }
}

function buildModels(
  providerID: Provider.ID,
  remote: AxonHubModel[],
  protocol: "openai" | "anthropic",
  devIndex: ModelsDevIndex | undefined,
  pricingProvider?: string,
): Model.Info[] {
  return remote.map((m) => {
    const meta = devIndex?.lookup(m.id, pricingProvider)
    const limit = meta?.limit?.context
      ? { context: meta.limit.context, output: meta.limit.output ?? 64_000 }
      : limitsFor(m.id)
    const reasoning = meta ? meta.reasoning === true : supportsReasoning(m.id)
    return {
      ...Model.Info.default(providerID, Model.ID.make(m.id)),
      name: meta?.name ?? m.id,
      limit,
      time: { released: m.created ?? Date.now() / 1000 },
      capabilities: {
        tools: meta?.tool_call ?? true,
        input: ["text", "image"],
        output: ["text"],
      },
      cost: meta?.cost
        ? ([
            {
              input: meta.cost.input ?? 0,
              output: meta.cost.output ?? 0,
              cache: {
                read: meta.cost.cache_read ?? 0,
                write: meta.cost.cache_write ?? 0,
              },
            },
            // Model.Info["cost"] 的数值是 USD/M tokens 的 brand 类型；运行时就是普通 number。
          ] as unknown as Model.Info["cost"])
        : [],
      // 思考强度 variants: pick one in the model picker (e.g. `glm-5.3/high`).
      variants: reasoning
        ? EFFORTS.map((effort) => ({
            id: Model.VariantID.make(effort),
            settings: {
              providerOptions:
                protocol === "anthropic"
                  ? { thinking: { effort } }
                  : { reasoningEffort: effort },
            },
          }))
        : [],
    }
  })
}

export default Plugin.define({
  id: "axonhub",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as Options
    const baseURL = (opts.baseURL ?? process.env.AXONHUB_BASE_URL ?? "https://llm.cccloud.xin").replace(/\/+$/, "")
    const apiKey = opts.apiKey ?? process.env.AXONHUB_API_KEY
    const protocol: "openai" | "anthropic" = opts.protocol === "anthropic" ? "anthropic" : "openai"
    const pricing = opts.pricing ?? "canonical"
    const refreshMs = opts.refreshMs ?? 300_000

    if (!apiKey) {
      throw new Error(`[axonhub] missing API key: set options.apiKey or AXONHUB_API_KEY`)
    }

    const providerID = Provider.ID.make(protocol === "anthropic" ? "axonhub-anthropic" : "axonhub")
    const pricingProvider = pricing === "zenmux" ? "zenmux" : undefined

    const source = {
      models: await fetchModels(baseURL, apiKey),
      devIndex: pricing === "none" ? undefined : await fetchModelsDev(),
    }

    const providerInfo = (): Provider.Info => ({
      ...Provider.Info.empty(providerID),
      name: `AxonHub (${protocol})`,
      activation: "enabled",
      package: protocol === "anthropic" ? ANTHROPIC_PKG : OPENAI_PKG,
      settings:
        protocol === "anthropic"
          ? { baseURL: `${baseURL}/anthropic/v1`, apiKey }
          : { baseURL: `${baseURL}/v1`, apiKey },
    })

    await ctx.provider.transform((editor) => {
      editor.add({
        info: providerInfo(),
        models: buildModels(providerID, source.models, protocol, source.devIndex, pricingProvider),
      })
    })

    if (refreshMs > 0) {
      const timer = setInterval(() => {
        void (async () => {
          try {
            source.models = await fetchModels(baseURL, apiKey)
            if (pricing !== "none") source.devIndex = await fetchModelsDev()
            await ctx.provider.reload()
          } catch (err) {
            console.error("[axonhub] refresh failed:", err)
          }
        })()
      }, refreshMs)
      return () => clearInterval(timer)
    }
  },
})
