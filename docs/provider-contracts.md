# Provider Adapter Contracts

The agent logic depends only on `ProviderAdapter`, never on a concrete provider.

```ts
interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk>;
  listModels(): Promise<ProviderModel[]>;
  countTokens?(request: ChatRequest): Promise<TokenCount>;
  validateKey(): Promise<boolean>;
}
```

## Supported Providers

- OpenAI
- Anthropic Claude
- Fireworks AI
- Custom OpenAI-compatible provider

## Capabilities

Each model advertises:

- context window
- vision
- tools
- JSON mode
- cost hint
- coding quality
- speed

Capabilities are hints for planning and UI decisions. They must not be used as hard security boundaries.

## Secret Handling

- API keys are stored in VS Code SecretStorage.
- `.mineagent/config.json` may store provider ids, default model ids, and custom base URLs.
- Provider keys must never be written to workspace files, prompts, command output, logs, reference packs, or run evidence.

## Model IDs

The scaffold avoids relying on hardcoded model ids. Provider model lists should come from provider APIs when possible, with generic fallback entries for initial UI operation.
