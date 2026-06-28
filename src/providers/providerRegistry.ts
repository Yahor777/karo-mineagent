import { ConfigService } from "../config/configService";
import type { MineAgentConfig, ProviderId } from "../config/types";
import { AnthropicProvider } from "./anthropicProvider";
import { CloudflareProvider } from "./cloudflareProvider";
import { OpenAICompatibleProvider } from "./openaiCompatibleProvider";
import type { ProviderAdapter, ProviderModel } from "./ProviderAdapter";

const openAiModels: ProviderModel[] = [
  {
    id: "openai-default",
    label: "OpenAI default model",
    provider: "openai",
    capabilities: {
      contextWindow: 400000,
      vision: true,
      tools: true,
      jsonMode: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "medium"
    }
  }
];

const fireworksModels: ProviderModel[] = [
  // === Z.AI (Zhipu) === GLM-серия, flagship coding
  {
    id: "accounts/fireworks/models/glm-5p2",
    label: "GLM 5.2 (flagship coding)",
    provider: "fireworks",
    vendor: "zai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 1400,
      neuronsPerMOutput: 4400
    }
  },
  {
    id: "accounts/fireworks/models/glm-5p2-fp8",
    label: "GLM 5.2 FP8",
    provider: "fireworks",
    vendor: "zai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "fast"
    }
  },
  {
    id: "accounts/fireworks/models/glm-4p7-flash",
    label: "GLM 4.7 Flash (бюджетная)",
    provider: "fireworks",
    vendor: "zai",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 202752,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast"
    }
  },

  // === Moonshot AI === Kimi-серия, frontier coding + vision
  {
    id: "accounts/fireworks/models/kimi-k2p7-code",
    label: "Kimi K2.7 Code",
    provider: "fireworks",
    vendor: "moonshotai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "fast",
      neuronsPerMInput: 950,
      neuronsPerMOutput: 4000
    }
  },
  {
    id: "accounts/fireworks/models/kimi-k2p6",
    label: "Kimi K2.6",
    provider: "fireworks",
    vendor: "moonshotai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "fast",
      neuronsPerMInput: 950,
      neuronsPerMOutput: 4000
    }
  },

  // === DeepSeek === reasoning-специалисты
  {
    id: "accounts/fireworks/models/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "fireworks",
    vendor: "deepseek",
    category: "reasoning",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 1740,
      neuronsPerMOutput: 3480
    }
  },
  {
    id: "accounts/fireworks/models/deepseek-v4-flash",
    label: "DeepSeek V4 Flash (быстрая)",
    provider: "fireworks",
    vendor: "deepseek",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 140,
      neuronsPerMOutput: 280
    }
  },

  // === Qwen (Alibaba) === coder + vision
  {
    id: "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
    label: "Qwen3 Coder 480B A35B",
    provider: "fireworks",
    vendor: "qwen",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "medium"
    }
  },
  {
    id: "accounts/fireworks/models/qwen3p7-plus",
    label: "Qwen3.7 Plus",
    provider: "fireworks",
    vendor: "qwen",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 400,
      neuronsPerMOutput: 1600
    }
  },

  // === MiniMax === vision + long context
  {
    id: "accounts/fireworks/models/minimax-m3",
    label: "MiniMax M3",
    provider: "fireworks",
    vendor: "other",
    category: "vision",
    apiType: "text",
    capabilities: {
      contextWindow: 512000,
      vision: true,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 300,
      neuronsPerMOutput: 1200
    }
  },

  // === OpenAI gpt-oss === budget coding
  {
    id: "accounts/fireworks/models/gpt-oss-120b",
    label: "GPT OSS 120B",
    provider: "fireworks",
    vendor: "openai",
    category: "reasoning",
    apiType: "text",
    capabilities: {
      contextWindow: 131072,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "medium",
      neuronsPerMInput: 150,
      neuronsPerMOutput: 600
    }
  },
  {
    id: "accounts/fireworks/models/gpt-oss-20b",
    label: "GPT OSS 20B (быстрая)",
    provider: "fireworks",
    vendor: "openai",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 131072,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 70,
      neuronsPerMOutput: 300
    }
  },

  // === Llama ===
  {
    id: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    label: "Llama 3.3 70B Instruct",
    provider: "fireworks",
    vendor: "meta",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 131072,
      vision: false,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast"
    }
  }
];

// === WaveSpeed AI === агрегатор 290+ LLM моделей (OpenAI-compat endpoint)
// Base URL: https://llm.wavespeed.ai/v1
// Модели в формате {vendor}/{model-name}
// Документация: https://wavespeed.ai/docs/llm-service-overview
// API ключи: https://wavespeed.ai/accesskey
const wavespeedModels: ProviderModel[] = [
  // === Z.AI (Zhipu) ===
  {
    id: "z-ai/glm-5.2",
    label: "GLM 5.2 (flagship coding)",
    provider: "wavespeed",
    vendor: "zai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 1400,
      neuronsPerMOutput: 4400
    }
  },
  {
    id: "z-ai/glm-5.1",
    label: "GLM 5.1",
    provider: "wavespeed",
    vendor: "zai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 202752,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 1400,
      neuronsPerMOutput: 4400
    }
  },

  // === DeepSeek ===
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "wavespeed",
    vendor: "deepseek",
    category: "reasoning",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 1800,
      neuronsPerMOutput: 3700
    }
  },
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "wavespeed",
    vendor: "deepseek",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 170,
      neuronsPerMOutput: 340
    }
  },
  {
    id: "deepseek/deepseek-v3.2",
    label: "DeepSeek V3.2",
    provider: "wavespeed",
    vendor: "deepseek",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 163840,
      vision: false,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 260,
      neuronsPerMOutput: 380
    }
  },

  // === Qwen (Alibaba) ===
  {
    id: "qwen/qwen3.7-max",
    label: "Qwen3.7 Max",
    provider: "wavespeed",
    vendor: "qwen",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 1000000,
      vision: false,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 2500,
      neuronsPerMOutput: 7500
    }
  },

  // === MiniMax ===
  {
    id: "minimax/minimax-m3",
    label: "MiniMax M3",
    provider: "wavespeed",
    vendor: "other",
    category: "vision",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: true,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 600,
      neuronsPerMOutput: 2400
    }
  },
  {
    id: "minimax/minimax-m2.7",
    label: "MiniMax M2.7",
    provider: "wavespeed",
    vendor: "other",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 204800,
      vision: false,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 300,
      neuronsPerMOutput: 1200
    }
  },

  // === OpenAI ===
  {
    id: "openai/gpt-5.5",
    label: "GPT 5.5",
    provider: "wavespeed",
    vendor: "openai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 1050000,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "high",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 5000,
      neuronsPerMOutput: 30000
    }
  },
  {
    id: "openai/gpt-5.4-mini",
    label: "GPT 5.4 Mini",
    provider: "wavespeed",
    vendor: "openai",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 400000,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 750,
      neuronsPerMOutput: 4500
    }
  },
  {
    id: "openai/gpt-5.4-nano",
    label: "GPT 5.4 Nano",
    provider: "wavespeed",
    vendor: "openai",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 400000,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 200,
      neuronsPerMOutput: 1300
    }
  },

  // === Anthropic ===
  {
    id: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    provider: "wavespeed",
    vendor: "other",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 1000000,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "high",
      codingQuality: "frontier",
      speed: "medium",
      neuronsPerMInput: 4800,
      neuronsPerMOutput: 23800
    }
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    provider: "wavespeed",
    vendor: "other",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 1000000,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "fast",
      neuronsPerMInput: 2800,
      neuronsPerMOutput: 14300
    }
  },
  {
    id: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    provider: "wavespeed",
    vendor: "other",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 200000,
      vision: true,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 950,
      neuronsPerMOutput: 4800
    }
  },

  // === Google ===
  {
    id: "google/gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    provider: "wavespeed",
    vendor: "google",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "fast",
      neuronsPerMInput: 1500,
      neuronsPerMOutput: 9000
    }
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash (бюджетная)",
    provider: "wavespeed",
    vendor: "google",
    category: "fast",
    apiType: "text",
    capabilities: {
      contextWindow: 1048576,
      vision: true,
      tools: true,
      jsonMode: true,
      fixedContext: true,
      costHint: "low",
      codingQuality: "strong",
      speed: "fast",
      neuronsPerMInput: 300,
      neuronsPerMOutput: 2500
    }
  },

  // === Moonshot ===
  {
    id: "moonshot/kimi-k2p6",
    label: "Kimi K2.6",
    provider: "wavespeed",
    vendor: "moonshotai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "fast"
    }
  }
];

// === Kimchi === OpenAI-совместимый шлюз к моделям Kimi (Moonshot).
// Base URL: https://llm.kimchi.dev/openai (endpoints /v1/chat/completions, /v1/models)
// Это первоклассный провайдер: ключ хранится в SecretStorage под id "kimchi".
const kimchiModels: ProviderModel[] = [
  {
    id: "kimi-k2.7",
    label: "Kimi K2.7 (flagship coding)",
    provider: "kimchi",
    vendor: "moonshotai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "fast"
    }
  },
  {
    id: "kimi-k2.6",
    label: "Kimi K2.6",
    provider: "kimchi",
    vendor: "moonshotai",
    category: "flagship",
    apiType: "text",
    capabilities: {
      contextWindow: 262144,
      vision: true,
      tools: true,
      jsonMode: true,
      reasoning: true,
      fixedContext: true,
      costHint: "medium",
      codingQuality: "frontier",
      speed: "fast"
    }
  }
];

export class ProviderRegistry {
  public constructor(
    private readonly configService: ConfigService,
    private readonly config: MineAgentConfig
  ) {}

  public async get(providerId: ProviderId): Promise<ProviderAdapter> {
    const config = await this.latestConfig();
    const apiKey = await this.configService.getProviderKey(providerId);
    if (!apiKey) {
      throw new Error(`Missing API key for ${providerId}. Use MineAgent: Set Provider API Key.`);
    }

    switch (providerId) {
      case "openai":
        return new OpenAICompatibleProvider({
          id: "openai",
          displayName: "OpenAI",
          baseUrl: "https://api.openai.com",
          apiKey,
          defaultModels: openAiModels
        });
      case "anthropic":
        return new AnthropicProvider(apiKey);
      case "fireworks":
        return new OpenAICompatibleProvider({
          id: "fireworks",
          displayName: "Fireworks AI",
          baseUrl: "https://api.fireworks.ai/inference",
          apiKey,
          defaultModels: fireworksModels
        });
      case "wavespeed":
        return new OpenAICompatibleProvider({
          id: "wavespeed",
          displayName: "WaveSpeed AI",
          baseUrl: "https://llm.wavespeed.ai",
          apiKey,
          defaultModels: wavespeedModels
        });
      case "kimchi":
        return new OpenAICompatibleProvider({
          id: "kimchi",
          displayName: "Kimchi (Kimi)",
          baseUrl: "https://llm.kimchi.dev/openai",
          apiKey,
          defaultModels: kimchiModels
        });
      case "cloudflare": {
        const accountId = config.providers.cloudflare.accountId
          || process.env.MINEAGENT_CLOUDFLARE_ACCOUNT_ID?.trim()
          || process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
        if (!accountId) {
          throw new Error("Missing Cloudflare Account ID. Configure Cloudflare provider first.");
        }
        return new CloudflareProvider(apiKey, accountId);
      }
      case "custom":
        return new OpenAICompatibleProvider({
          id: "custom",
          displayName: "Custom OpenAI-Compatible",
          baseUrl: config.providers.custom.baseUrl,
          apiKey,
          defaultModels: [],
          chatEndpoint: config.providers.custom.chatEndpoint,
          modelsEndpoint: config.providers.custom.modelsEndpoint
        });
    }
  }

  public async providerStatuses(): Promise<Array<{ id: ProviderId; hasKey: boolean }>> {
    return Promise.all(
      (["openai", "anthropic", "fireworks", "cloudflare", "wavespeed", "kimchi", "custom"] as ProviderId[]).map(async (id) => ({
        id,
        hasKey: await this.configService.hasProviderKey(id)
      }))
    );
  }

  private async latestConfig(): Promise<MineAgentConfig> {
    return await this.configService.readConfig() ?? this.config;
  }
}
