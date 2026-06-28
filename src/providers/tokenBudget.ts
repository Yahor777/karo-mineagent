// Token budget: считает потребление токенов за сессию и сигнализирует,
// когда лимит превышен. НЕ прерывает выполняющийся запрос — только
// предлагает стоп ПОСЛЕ завершения ответа модели (правило из roadmap.md).

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  visionCalls: number;
}

// Pricing модели в нейронах за 1M токенов (берётся из capabilities модели).
// Используется для пересчёта потраченных токенов в нейроны Cloudflare.
export interface ModelPricing {
  neuronsPerMInput?: number;
  neuronsPerMOutput?: number;
}

export interface BudgetSnapshot {
  sessionUsed: number;
  sessionLimit: number;
  usage: TokenUsage;
  exceeded: boolean;
  // Нейроны Cloudflare, потраченные за сессию (для topbar-чипа).
  // Free tier Cloudflare: 10 000 нейронов в день.
  // ВАЖНО: neuronsSpent имеет смысл ТОЛЬКО для Cloudflare. Для других
  // провайдеров (WaveSpeed, OpenAI, Fireworks, Anthropic) это 0 — они
  // тарифицируются в долларах/кредитах, не в нейронах. UI скрывает чип
  // нейронов когда neuronsSpent = 0 и показывает только токены.
  neuronsSpent: number;
  neuronsDailyLimit: number;
  // Активный провайдер — UI использует чтобы отличить Cloudflare (нейроны)
  // от остальных (только токены).
  providerId: string;
}

export interface BudgetCheckResult {
  exceeded: boolean;
  snapshot: BudgetSnapshot;
}

const DEFAULT_SESSION_LIMIT = 1_000_000;
const CLOUDFLARE_FREE_TIER_DAILY = 10_000;

export class TokenBudgetService {
  private inputTokens = 0;
  private outputTokens = 0;
  private visionCalls = 0;
  private neuronsSpent = 0;
  private hiddenForSession = false;
  // Какой провайдер активен. Нейроны считаются только для "cloudflare".
  private providerId: string = "cloudflare";

  public constructor(private sessionLimit: number = DEFAULT_SESSION_LIMIT) {}

  // Устанавливает активного провайдера. Нейроны Cloudflare считаются только
  // когда providerId = "cloudflare". Для остальных провайдеров neuronsSpent
  // остаётся 0, и UI показывает только токены за сессию.
  public setProviderId(providerId: string): void {
    if (providerId !== this.providerId) {
      this.providerId = providerId;
      // Сбрасываем нейроны при смене провайдера — они не суммируются между
      // Cloudflare и не-Cloudflare.
      this.neuronsSpent = 0;
    }
  }

  public setSessionLimit(limit: number): void {
    this.sessionLimit = limit > 0 ? Math.floor(limit) : DEFAULT_SESSION_LIMIT;
  }

  // Регистрирует завершённый вызов модели. usage из ответа провайдера если есть,
  // иначе — оценка (chars/4), помеченная как estimated в вызывающем коде.
  // pricing — данные о стоимости модели для пересчёта токенов в нейроны.
  public record(usage: Partial<TokenUsage> | undefined, estimated?: TokenUsage, pricing?: ModelPricing): void {
    const effective = usage ?? estimated ?? { inputTokens: 0, outputTokens: 0, visionCalls: 0 };
    const inTok = Math.max(0, effective.inputTokens ?? 0);
    const outTok = Math.max(0, effective.outputTokens ?? 0);
    const vis = Math.max(0, effective.visionCalls ?? 0);
    this.inputTokens += inTok;
    this.outputTokens += outTok;
    this.visionCalls += vis;

    // Пересчёт в нейроны: (tokens / 1M) * neuronsPerM.
    // ТОЛЬКО для Cloudflare — другие провайдеры тарифицируются в деньгах,
    // не в нейронах. Нейроны WaveSpeed-моделей в capabilities — это
    // Cloudflare-единицы, не имеющие отношения к WaveSpeed-биллингу.
    if (pricing && this.providerId === "cloudflare") {
      const inN = pricing.neuronsPerMInput ? (inTok / 1_000_000) * pricing.neuronsPerMInput : 0;
      const outN = pricing.neuronsPerMOutput ? (outTok / 1_000_000) * pricing.neuronsPerMOutput : 0;
      this.neuronsSpent += Math.ceil(inN + outN);
    }
  }

  // Оценка токенов строки по эвристике chars/4. Используется когда провайдер
  // не отдаёт usage в ответе.
  public static estimateTokens(text: string): number {
    return Math.ceil((text?.length ?? 0) / 4);
  }

  public snapshot(): BudgetSnapshot {
    const sessionUsed = this.inputTokens + this.outputTokens;
    return {
      sessionUsed,
      sessionLimit: this.sessionLimit,
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        visionCalls: this.visionCalls
      },
      exceeded: sessionUsed > this.sessionLimit,
      neuronsSpent: this.neuronsSpent,
      neuronsDailyLimit: CLOUDFLARE_FREE_TIER_DAILY,
      providerId: this.providerId
    };
  }

  // Вызывается ПОСЛЕ завершения ответа модели. Если лимит превышен и юзер
  // ещё не нажал «больше не показывать в этой сессии» — возвращает exceeded=true.
  public checkAfterResponse(): BudgetCheckResult {
    const snapshot = this.snapshot();
    const exceeded = snapshot.exceeded && !this.hiddenForSession;
    return { exceeded, snapshot };
  }

  // Кнопка «больше не показывать в этой сессии».
  public hideForSession(): void {
    this.hiddenForSession = true;
  }

  public reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.visionCalls = 0;
    this.neuronsSpent = 0;
    this.hiddenForSession = false;
  }
}
