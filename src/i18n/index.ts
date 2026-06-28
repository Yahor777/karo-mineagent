import type { Dictionary, DictionaryKey } from "./types";
import { ru } from "./ru";
import { en } from "./en";

export type { Dictionary, DictionaryKey } from "./types";
export { ru } from "./ru";
export { en } from "./en";

export type Language = "ru" | "en";

const dictionaries: Record<Language, Dictionary> = { ru, en };

// Текущий язык. По умолчанию русский (проект строго на русском до отдельного
// решения добавить английский). Меняется через setLanguage() когда появится
// настройка mineagent.language.
let currentLanguage: Language = "ru";

export function setLanguage(language: Language): void {
  currentLanguage = language;
}

export function getLanguage(): Language {
  return currentLanguage;
}

// Главная функция перевода. Типобезопасна по ключу, поддерживает интерполяцию.
//   t("run.askingModel", { provider: "Cloudflare", model: "kimi" })
//   → "Отправляю запрос в Cloudflare: kimi."
export function t(key: DictionaryKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[currentLanguage][key] ?? ru[key] ?? key;
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
