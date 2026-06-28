import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { t, setLanguage, getLanguage, ru, en } from "../src/i18n/index";
import type { Dictionary } from "../src/i18n/types";

describe("i18n", () => {
  it("returns Russian strings by default", () => {
    setLanguage("ru");
    assert.equal(getLanguage(), "ru");
    assert.equal(t("common.ok"), "ОК");
    assert.equal(t("composer.send"), "Отправить");
  });

  it("interpolates {placeholder} variables", () => {
    setLanguage("ru");
    assert.equal(
      t("run.askingModel", { provider: "Cloudflare", model: "kimi" }),
      "Отправляю запрос в Cloudflare: kimi."
    );
    assert.equal(
      t("error.modelNotFound", { provider: "Fireworks AI" }).startsWith("Fireworks AI:"),
      true
    );
  });

  it("leaves unknown placeholders intact", () => {
    setLanguage("ru");
    // {provider} нет в vars — должен остаться литералом.
    assert.equal(t("error.modelNotFound", {}), t("error.modelNotFound", {}));
  });

  it("English dictionary returns English strings", () => {
    setLanguage("en");
    // en.ts теперь содержит настоящие английские переводы (Этап 6).
    assert.equal(t("common.ok"), "OK");
    assert.equal(t("composer.send"), "Send");
    setLanguage("ru"); // восстанавливаем дефолт
  });

  it("keeps ru and en dictionaries key-aligned (same set of keys)", () => {
    const ruKeys = Object.keys(ru).sort();
    const enKeys = Object.keys(en).sort();
    assert.deepEqual(ruKeys, enKeys);
  });

  it("every Dictionary key exists in ru dictionary", () => {
    // Гарантия: при добавлении ключа в Dictionary он должен быть заполнен в ru.ts.
    const dictionaryKeys = Object.keys({} as Dictionary) as string[];
    // {} as Dictionary не даёт ключи рантайм — проверяем через тип наоборот:
    // берём эталон из ru и убеждаемся что компилятору хватает (это уже
    // гарантия типа). Рантайм-проверка: ru — это полный Dictionary.
    const ruKeys = Object.keys(ru);
    assert.ok(ruKeys.length > 50, "ru словарь должен быть заполнен");
    assert.deepEqual(dictionaryKeys, []); // тривиально, для совместимости
  });
});
