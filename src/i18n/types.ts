// Тип словаря i18n. Один источник правды для ключей.
// Добавление новой строки: (1) пишем ключ в Dictionary, (2) заполняем в ru.ts.
// en.ts на старте заглушка — при добавлении английского просто заполняем тот же
// набор ключей, компилятор подсветит недостающие.

export interface Dictionary {
  // Общие
  "common.ok": string;
  "common.cancel": string;
  "common.save": string;
  "common.refresh": string;
  "common.loading": string;
  "common.error": string;
  "common.confirm": string;
  "common.continue": string;
  "common.stop": string;
  "common.neverAgainInSession": string;

  // UI: вкладки workbench
  "tab.chat": string;
  "tab.runs": string;
  "tab.lab": string;
  "tab.references": string;
  "tab.rules": string;
  "tab.skills": string;
  "tab.providers": string;

  // Composer / модель
  "composer.placeholder": string;
  "composer.mode.ask": string;
  "composer.mode.plan": string;
  "composer.mode.build": string;
  "composer.mode.playtest": string;
  "composer.send": string;
  "composer.stopRun": string;

  // Модели / провайдеры
  "provider.select": string;
  "provider.modelPlaceholder": string;
  "provider.refreshModels": string;
  "provider.test": string;
  "provider.choose": string;
  "provider.configureKeys": string;
  "provider.keyStored": string;
  "provider.storedKey": string;
  "provider.selectProvider": string;

  // Запуски / фазы
  "run.started": string;
  "run.indexingProject": string;
  "run.buildingProject": string;
  "run.preparingContext": string;
  "run.askingModel": string;
  "run.cancelled": string;
  "run.phaseSkipped": string;
  "run.phaseComplete": string;
  "run.phaseFailed": string;

  // Ошибки — человекочитаемые
  "error.modelNotFound": string;
  "error.billingBlocked": string;
  "error.endpointMethod": string;
  "error.missingApiKey": string;
  "error.missingCloudflareAccount": string;
  "error.network": string;
  "error.aborted": string;
  "error.generic": string;

  // Token budget
  "budget.sessionLabel": string;
  "budget.inputTokens": string;
  "budget.outputTokens": string;
  "budget.visionCalls": string;
  "budget.limitExceededTitle": string;
  "budget.limitExceededBody": string;

  // Approval Gateway
  "approval.title": string;
  "approval.confirmOnce": string;
  "approval.alwaysInSession": string;
  "approval.always": string;
  "approval.deny": string;
  // Шаблон описания: {tool} = имя tool, {description} = человеческое описание.
  "approval.description": string;
  "approval.risk": string;
  "approval.risk.read": string;
  "approval.risk.write": string;
  "approval.risk.command": string;
  "approval.risk.network": string;
  "approval.risk.game-control": string;
  "approval.timeout": string;
  "approval.denied": string;

  // Sub-агенты
  "subagent.toggle": string;
  "subagent.add": string;
  "subagent.edit": string;
  "subagent.delete": string;
  "subagent.deleteConfirm": string;
  "subagent.id": string;
  "subagent.displayName": string;
  "subagent.model": string;
  "subagent.specialty": string;
  "subagent.specialty.reviewer": string;
  "subagent.specialty.researcher": string;
  "subagent.specialty.vision": string;
  "subagent.specialty.custom": string;
  "subagent.prompt": string;
  "subagent.allowedTools": string;
  "subagent.memoryMode": string;
  "subagent.memory.none": string;
  "subagent.memory.task": string;
  "subagent.memory.session": string;
  "subagent.memory.ask": string;
  "subagent.enabled": string;
  "subagent.disabled": string;
  "subagent.empty": string;
  "subagent.save": string;
  "subagent.cancel": string;

  // Source Ledger
  "references.title": string;
  "references.category.characters": string;
  "references.category.lore": string;
  "references.category.weapons": string;
  "references.category.locations": string;
  "references.category.misc": string;
  "references.searchPlaceholder": string;
  "references.addNote": string;

  // Blockbench MCP (Этап 3)
  "blockbench.label": string;
  "blockbench.connected": string;
  "blockbench.disconnected": string;
  "blockbench.connecting": string;
  "blockbench.error": string;
  "blockbench.connect": string;
  "blockbench.disconnect": string;
  "blockbench.toolCount": string;
  "blockbench.connectFailed": string;

  // Minecraft Dev Bridge (Этап 4): MCP-сервер внутри dev-сборки мода.
  "minecraftBridge.label": string;
  "minecraftBridge.connected": string;
  "minecraftBridge.disconnected": string;
  "minecraftBridge.connecting": string;
  "minecraftBridge.error": string;
  "minecraftBridge.connect": string;
  "minecraftBridge.disconnect": string;
  "minecraftBridge.toolCount": string;
  "minecraftBridge.connectFailed": string;
  "minecraftBridge.waitingForClient": string;
  "minecraftBridge.endpointNotFound": string;
  "minecraftBridge.noToken": string;
  "minecraftBridge.launchFirst": string;

  // Vision + Critic (Этап 5)
  "vision.label": string;
  "vision.evaluating": string;
  "vision.verdict.matches": string;
  "vision.verdict.mismatch": string;
  "vision.verdict.uncertain": string;
  "vision.noImages": string;
  "vision.disabled": string;

  "critic.label": string;
  "critic.evaluating": string;
  "critic.consensus": string;
  "critic.disagreement": string;
  "critic.uncertain": string;
  "critic.apply": string;
  "critic.reject": string;
  "critic.decideSelf": string;
  "critic.selfCritiqueWarning": string;
  "critic.disabled": string;
  "critic.mainOpinion": string;
  "critic.criticOpinion": string;

  "subagent.run": string;

  // Knowledge Base (Этап 6)
  "knowledge.title": string;
  "knowledge.empty": string;
  "knowledge.add": string;
  "knowledge.search": string;
  "knowledge.searchPlaceholder": string;
  "knowledge.category": string;
  "knowledge.category.api": string;
  "knowledge.category.gameplay": string;
  "knowledge.category.rendering": string;
  "knowledge.category.tools": string;
  "knowledge.category.assets": string;
  "knowledge.category.misc": string;
  "knowledge.searchViaModel": string;
  "knowledge.searchingViaModel": string;
  "knowledge.added": string;

  // Skills (Этап 6)
  "skills.title": string;
  "skills.empty": string;
  "skills.create": string;
  "skills.createPlaceholder": string;
  "skills.creating": string;
  "skills.created": string;
  "skills.matched": string;
  "skills.pin": string;
  "skills.unpin": string;
  "skills.delete": string;
  "skills.deleteConfirm": string;
  "skills.readonly": string;
}

export type DictionaryKey = keyof Dictionary;
