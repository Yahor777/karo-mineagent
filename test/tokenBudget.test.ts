import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenBudgetService } from "../src/providers/tokenBudget";

describe("TokenBudgetService", () => {
  it("estimates tokens via chars/4 heuristic", () => {
    assert.equal(TokenBudgetService.estimateTokens("abcd"), 1);
    assert.equal(TokenBudgetService.estimateTokens("abcde"), 2); // ceil(5/4)
    assert.equal(TokenBudgetService.estimateTokens(""), 0);
    assert.equal(TokenBudgetService.estimateTokens(null as unknown as string), 0);
  });

  it("accumulates usage across calls", () => {
    const budget = new TokenBudgetService(1_000_000);
    budget.record({ inputTokens: 100, outputTokens: 50, visionCalls: 1 });
    budget.record({ inputTokens: 200, outputTokens: 150, visionCalls: 0 });
    const snapshot = budget.snapshot();
    assert.equal(snapshot.usage.inputTokens, 300);
    assert.equal(snapshot.usage.outputTokens, 200);
    assert.equal(snapshot.usage.visionCalls, 1);
    assert.equal(snapshot.sessionUsed, 500);
  });

  it("does not mark exceeded when under limit", () => {
    const budget = new TokenBudgetService(1_000_000);
    budget.record({ inputTokens: 600_000, outputTokens: 100_000 });
    const check = budget.checkAfterResponse();
    assert.equal(check.exceeded, false);
    assert.equal(check.snapshot.exceeded, false);
  });

  it("marks exceeded when session usage exceeds limit", () => {
    const budget = new TokenBudgetService(1_000_000);
    budget.record({ inputTokens: 900_000, outputTokens: 200_000 });
    const check = budget.checkAfterResponse();
    assert.equal(check.exceeded, true);
    assert.equal(check.snapshot.sessionUsed, 1_100_000);
    assert.equal(check.snapshot.sessionLimit, 1_000_000);
  });

  it("hideForSession suppresses exceeded flag until reset", () => {
    const budget = new TokenBudgetService(100);
    budget.record({ inputTokens: 200, outputTokens: 0 });
    assert.equal(budget.checkAfterResponse().exceeded, true);
    budget.hideForSession();
    // Превышение есть, но юзер скрыл уведомление — не предлагаем стоп.
    assert.equal(budget.checkAfterResponse().exceeded, false);
    assert.equal(budget.checkAfterResponse().snapshot.exceeded, true); // но сам факт превышения виден
  });

  it("reset clears both usage and the hide flag", () => {
    const budget = new TokenBudgetService(100);
    budget.record({ inputTokens: 200, outputTokens: 0 });
    budget.hideForSession();
    budget.reset();
    assert.equal(budget.snapshot().sessionUsed, 0);
    assert.equal(budget.checkAfterResponse().exceeded, false);
  });

  it("setSessionLimit ignores non-positive values and falls back to default", () => {
    const budget = new TokenBudgetService(100);
    budget.setSessionLimit(0); // 0 в конфиге = "без лимита", но сервис ставит дефолт
    assert.ok(budget.snapshot().sessionLimit >= 1_000_000);
  });

  it("falls back to estimated usage when provider does not return usage", () => {
    const budget = new TokenBudgetService(1_000_000);
    budget.record(undefined, { inputTokens: 400, outputTokens: 100, visionCalls: 0 });
    assert.equal(budget.snapshot().sessionUsed, 500);
  });

  it("converts tokens to Cloudflare neurons using model pricing", () => {
    const budget = new TokenBudgetService(1_000_000);
    // Kimi K2.7 Code: 86364 input / 363636 output нейронов за 1M.
    budget.record(
      { inputTokens: 500_000, outputTokens: 100_000, visionCalls: 0 },
      undefined,
      { neuronsPerMInput: 86364, neuronsPerMOutput: 363636 }
    );
    const snap = budget.snapshot();
    assert.ok(snap.neuronsSpent > 0, "нейроны должны быть посчитаны");
    // 500k/1M * 86364 + 100k/1M * 363636 = 43182 + 36363.6 ≈ 79546
    assert.ok(snap.neuronsSpent >= 79_000 && snap.neuronsSpent <= 80_000, `ожидал ~79.5k нейронов, got ${snap.neuronsSpent}`);
    assert.equal(snap.neuronsDailyLimit, 10_000, "free tier = 10k нейронов в день");
  });

  it("does not count neurons when pricing is not provided", () => {
    const budget = new TokenBudgetService(1_000_000);
    budget.record({ inputTokens: 100_000, outputTokens: 50_000, visionCalls: 0 });
    assert.equal(budget.snapshot().neuronsSpent, 0, "без pricing нейроны не считаются");
  });
});
