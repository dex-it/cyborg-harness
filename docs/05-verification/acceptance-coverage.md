---
level: verification
status: review
date: 2026-11-11
origin: derived
---

# Матрица приёмки

Собрана из историй, имён тестов и исключений [acceptance.md](acceptance.md) командой `npm run check:acceptance -- --write`; руками не правится.

Итог: критериев 248; тестом 202, исключением 20, целевое поведение 26.

| Критерий | Чем проверяется |
|---|---|
| ST-1001/1 | `core/test/loader.test.ts`, `core/test/semver-manifest.test.ts` |
| ST-1001/2 | `core/test/loader.test.ts`, `core/test/window.test.ts` |
| ST-1001/3 | `core/test/manifest-schema.test.ts`, `core/test/semver-manifest.test.ts` |
| ST-1001/4 | `electron/test/plugins.test.ts` |
| ST-1001/5 | `core/test/graph.test.ts`, `electron/test/plugins.test.ts` |
| ST-1001/6 | `electron/test/plugins.test.ts` |
| ST-1001/7 | `core/test/loader.test.ts`, `electron/test/plugins.test.ts`, `playground/test/plugins-model.test.ts` |
| ST-1001/8 | `core/test/events.test.ts`, `core/test/status.test.ts` |
| ST-1001/9 | `core/test/loader.test.ts`, `core/test/manifest-schema.test.ts` |
| ST-1001/10 | `core/test/loader.test.ts`, `core/test/status.test.ts` |
| ST-1001/11 | `electron/test/plugins.test.ts` |
| ST-1002/1 | `core/test/graph.test.ts`, `core/test/loader.test.ts` |
| ST-1002/2 | `core/test/graph.test.ts` |
| ST-1002/3 | `core/test/graph.test.ts`, `core/test/status.test.ts` |
| ST-1002/4 | `core/test/graph.test.ts` |
| ST-1002/5 | `core/test/events.test.ts`, `core/test/graph.test.ts` |
| ST-1002/6 | `core/test/graph.test.ts`, `core/test/loader.test.ts` |
| ST-1002/7 | `core/test/graph.test.ts`, `core/test/loader.test.ts` |
| ST-1003/1 | `core/test/loader.test.ts` |
| ST-1003/2 | `core/test/hosts.test.ts`, `core/test/loader.test.ts`, `electron/test/plugins.test.ts`; часть - окно: хост в `utilityProcess`: `playground/scripts/smoke.mjs` |
| ST-1003/3 | `core/test/hosts.test.ts`, `core/test/pty.test.ts`; часть - замер: срок обнаружения зависания при значениях по умолчанию: `npm run spike:hosts`, [spike-hosts.md](spike-hosts.md) |
| ST-1003/4 | `core/test/hosts.test.ts`, `core/test/stress-lifecycle.test.ts` |
| ST-1003/5 | `core/test/hosts.test.ts` |
| ST-1003/6 | `core/test/loader.test.ts` |
| ST-1003/7 | `core/test/loader.test.ts` |
| ST-1003/8 | `core/test/ui-shell.test.ts`; часть - окно: окно и виды после сбоя хоста: `playground/scripts/smoke.mjs` |
| ST-1004/1 | `core/test/loader.test.ts` |
| ST-1004/2 | `core/test/loader.test.ts`, `electron/test/plugins.test.ts` |
| ST-1004/3 | `core/test/loader.test.ts`, `core/test/stress-lifecycle.test.ts` |
| ST-1004/4 | `core/test/loader.test.ts`, `electron/test/plugins.test.ts` |
| ST-1005/1 | `core/test/lifecycle.test.ts` |
| ST-1005/2 | `core/test/subscriptions.test.ts` |
| ST-1005/3 | `core/test/lifecycle.test.ts` |
| ST-1005/4 | `core/test/lifecycle.test.ts` |
| ST-1005/5 | `core/test/lifecycle.test.ts`, `core/test/stress-lifecycle.test.ts` |
| ST-1005/6 | `electron/test/plugins.test.ts` |
| ST-1006/1 | `core/test/events.test.ts` |
| ST-1006/2 | `core/test/events.test.ts`, `electron/test/plugins.test.ts` |
| ST-1006/3 | `core/test/events.test.ts` |
| ST-1006/4 | `core/test/events.test.ts`, `core/test/window.test.ts` |
| ST-1006/5 | замер: `npm run spike:gateway`, [spike-gateway.md](spike-gateway.md); бюджеты - `npm run check:budgets` (`playground/budgets.json`) |
| ST-1006/6 | целевое поведение |
| ST-1007/1 | `core/test/instance.test.ts`, `core/test/workspace.test.ts`; часть - окно: фокус окна: `playground/scripts/smoke.mjs` |
| ST-1007/2 | `core/test/instance.test.ts`, `electron/test/instances.test.ts`; часть - окно: сообщение и код выхода приложения: `playground/src/main/main.ts`, `playground/scripts/smoke.mjs` |
| ST-1007/3 | `core/test/workspace.test.ts` |
| ST-1007/4 | `core/test/workspace.test.ts` |
| ST-1007/5 | `core/test/workspace.test.ts` |
| ST-1007/6 | `core/test/workspace.test.ts` |
| ST-1007/7 | ручная: вопрос о живых pty при закрытии и смене воркспейса (`electron/src/restarts.ts`): smoke глушит диалог, [macos-check.md](macos-check.md) |
| ST-1007/8 | `core/test/loader.test.ts`, `core/test/workspace.test.ts` |
| ST-1007/9 | `core/test/os.test.ts` |
| ST-1008/1 | `core/test/pty.test.ts` |
| ST-1008/2 | `core/test/pty.test.ts`, `core/test/stress-pty.test.ts` |
| ST-1008/3 | `core/test/pty.test.ts`, `core/test/stress-pty.test.ts` |
| ST-1008/4 | `core/test/pty.test.ts` |
| ST-1008/5 | `core/test/pty-host.test.ts` |
| ST-1008/6 | `core/test/pty.test.ts`, `core/test/stress-pty.test.ts` |
| ST-1009/1 | `core/test/purity.test.ts` |
| ST-1009/2 | документ: осмотр по SAD, раздел 2; перенос формата - `core/test/workspace.test.ts` |
| ST-2001/1 | `core/test/loader.test.ts`, `core/test/plugin-imports.test.ts` |
| ST-2001/2 | `core/test/registry.test.ts`, `core/test/trust.test.ts` |
| ST-2001/3 | `core/test/registry.test.ts` |
| ST-2001/4 | `core/test/trust.test.ts` |
| ST-2001/5 | `core/test/loader.test.ts`, `core/test/rpc.test.ts` |
| ST-2001/6 | `core/test/subscriptions.test.ts`, `core/test/trust.test.ts` |
| ST-2001/7 | `core/test/events.test.ts` |
| ST-2001/8 | `core/test/loader.test.ts` |
| ST-2001/9 | `core/test/channel.test.ts`, `core/test/window.test.ts` |
| ST-2001/10 | `core/test/window.test.ts`, `electron/test/view-files.test.ts` |
| ST-2002/1 | `core/test/loader.test.ts`, `core/test/trust.test.ts` |
| ST-2002/2 | `core/test/command-callers.test.ts`, `core/test/graph.test.ts` |
| ST-2002/3 | `electron/test/key-route.test.ts`, `electron/test/plugins.test.ts`; часть - окно: `<iframe>` вида: `playground/scripts/smoke.mjs` |
| ST-2002/4 | `core/test/lifecycle.test.ts`, `core/test/workspace.test.ts` |
| ST-2002/5 | `core/test/keys-registry.test.ts` |
| ST-2002/6 | `core/test/loader.test.ts`, `electron/test/app-menu.test.ts` |
| ST-2003/1 | `core/test/loader.test.ts`, `core/test/semver-manifest.test.ts` |
| ST-2003/2 | `core/test/ui-shell.test.ts`, `electron/test/view-files.test.ts`; часть - окно: `playground/scripts/smoke.mjs` |
| ST-2003/3 | `electron/test/view-frames.test.ts` |
| ST-2003/4 | окно: `playground/scripts/smoke.mjs`, шаг перезапуска хоста: вид под плашкой без ввода |
| ST-2003/5 | `electron/test/plugins.test.ts`, `playground/test/plugins-model.test.ts`, `playground/test/window-plan.test.ts`; часть - окно: `playground/scripts/smoke.mjs` |
| ST-2003/6 | `core/test/documents.test.ts` |
| ST-2003/7 | целевое поведение |
| ST-2003/8 | `core/test/loader.test.ts`, `core/test/semver-manifest.test.ts` |
| ST-2004/1 | `core/test/window.test.ts` |
| ST-2004/2 | `core/test/window.test.ts`, `electron/test/window-layer.test.ts` |
| ST-2004/3 | `core/test/keys-registry.test.ts`, `core/test/window.test.ts`, `electron/test/window-layer.test.ts` |
| ST-2004/4 | `core/test/os.test.ts`, `core/test/window.test.ts` |
| ST-2004/5 | `core/test/loader.test.ts`, `electron/test/plugins.test.ts` |
| ST-2005/1 | окно: `playground/scripts/smoke.mjs`, шаг «элементы ядра» |
| ST-2005/2 | `core/test/window.test.ts`; часть - окно: `playground/scripts/smoke.mjs` |
| ST-2005/3 | целевое поведение |
| ST-2005/4 | целевое поведение |
| ST-2006/1 | `core/test/pty.test.ts`, `core/test/purity.test.ts`, `playground/test/agents.test.ts` |
| ST-2006/2 | `core/test/pty.test.ts` |
| ST-2006/3 | `playground/test/agents.test.ts` |
| ST-2006/4 | `playground/test/agents.test.ts` |
| ST-2006/5 | `playground/test/agents.test.ts` |
| ST-2006/6 | `playground/test/agents.test.ts` |
| ST-2006/7 | `playground/test/agents.test.ts` |
| ST-2006/8 | `playground/test/agents.test.ts` |
| ST-2006/9 | `playground/test/agents.test.ts` |
| ST-2006/10 | `playground/test/agents.test.ts` |
| ST-2006/11 | `playground/test/agents.test.ts` |
| ST-2006/12 | `playground/test/agents.test.ts` |
| ST-2006/13 | `playground/test/agents.test.ts` |
| ST-2006/14 | `playground/test/agents.test.ts` |
| ST-2007/1 | `core/test/purity.test.ts` |
| ST-2007/2 | документ: гейты CI `.github/workflows/ci.yml`: `npm test` с `core/test/plugin-imports.test.ts`, `typecheck`, `lint`, `smoke` |
| ST-3001/1 | ручная: дефект #?: прямой запрос хоста от плагина без прав к `pty.share`, `pty.attach`, `pty.write`, `pty.resize`, `pty.kill` даёт `NotFound`, к `pty.list` - пустой список, к `serve.close` - `ok`, а не `PermissionDenied` с записью `denied` (проверки права нет, операция идёт по таблице самого плагина, чужого он не касается); остальные члены `ctx.os` отказывают как надо - `core/test/trust.test.ts` |
| ST-3001/2 | `core/test/os.test.ts`, `core/test/security-gateway.test.ts` |
| ST-3001/3 | `core/test/os.test.ts` |
| ST-3001/4 | `core/test/os.test.ts` |
| ST-3001/5 | `core/test/os.test.ts` |
| ST-3001/6 | `core/test/os.test.ts`, `core/test/stress-workspace.test.ts`, `core/test/window.test.ts` |
| ST-3001/7 | `core/test/loader.test.ts`, `core/test/os.test.ts` |
| ST-3001/8 | `core/test/os.test.ts`, `core/test/pty.test.ts`, `electron/test/plugins.test.ts` |
| ST-3001/9 | `core/test/plugin-imports.test.ts`, `core/test/trust.test.ts`, `core/test/workspace-trust.test.ts` |
| ST-3001/10 | целевое поведение |
| ST-3002/1 | `core/test/os.test.ts` |
| ST-3002/2 | `core/test/os-lifetime.test.ts`, `core/test/os.test.ts`, `core/test/security-gateway.test.ts` |
| ST-3002/3 | `core/test/os.test.ts`, `core/test/workspace-trust.test.ts` |
| ST-3002/4 | `core/test/net-fetch.test.ts`, `core/test/os.test.ts` |
| ST-3002/5 | `core/test/net-fetch.test.ts`, `core/test/net-transport.test.ts` |
| ST-3002/6 | `core/test/serve.test.ts` |
| ST-3002/7 | `core/test/os-lifetime.test.ts`, `core/test/os.test.ts`, `core/test/serve.test.ts` |
| ST-3003/1 | `core/test/via-contract.test.ts` |
| ST-3003/2 | целевое поведение |
| ST-3003/3 | `core/test/command-callers.test.ts`, `playground/test/agents.test.ts` |
| ST-3003/4 | `core/test/command-callers.test.ts` |
| ST-3003/5 | `core/test/graph.test.ts`, `core/test/loader.test.ts`, `electron/test/plugins.test.ts` |
| ST-3004/1 | `core/test/os.test.ts`, `electron/test/secrets-file.test.ts` |
| ST-3004/2 | `core/test/os.test.ts`, `core/test/secrets-journal.test.ts`, `core/test/security-gateway.test.ts` |
| ST-3004/3 | `core/test/diagnostics.test.ts`, `core/test/secrets-journal.test.ts` |
| ST-3004/4 | `core/test/os.test.ts`, `core/test/uninstall.test.ts`, `electron/test/secrets-file.test.ts` |
| ST-3004/5 | `core/test/plugin-log.test.ts` |
| ST-3005/1 | `core/test/loader.test.ts`, `core/test/workspace.test.ts`, `electron/test/plugins.test.ts` |
| ST-3005/2 | `electron/test/view-frames.test.ts`; часть - окно: вызов `fromWindow` на каждом канале окна: `electron/src/channels.ts`, `playground/scripts/smoke.mjs` |
| ST-3005/3 | `core/test/plugin-imports.test.ts`, `electron/test/window-layer.test.ts` |
| ST-3005/4 | `electron/test/view-files.test.ts` |
| ST-3005/5 | `core/test/semver-manifest.test.ts`, `electron/test/plugins.test.ts`, `electron/test/view-files.test.ts` |
| ST-3005/6 | `electron/test/navigation.test.ts` |
| ST-3005/7 | целевое поведение |
| ST-3006/1 | `playground/test/agents.test.ts` |
| ST-3006/2 | `playground/test/agents.test.ts` |
| ST-3006/3 | `playground/test/agents.test.ts` |
| ST-3006/4 | `playground/test/agents.test.ts` |
| ST-3006/5 | целевое поведение |
| ST-3007/1 | целевое поведение |
| ST-3007/2 | целевое поведение |
| ST-3007/3 | целевое поведение |
| ST-3007/4 | целевое поведение |
| ST-3007/5 | целевое поведение |
| ST-3007/6 | целевое поведение |
| ST-3007/7 | `core/test/os.test.ts`, `core/test/plugin-check.test.ts`, `core/test/pty.test.ts` |
| ST-3007/8 | целевое поведение |
| ST-3008/1 | `core/test/loader.test.ts`, `core/test/uninstall.test.ts`, `core/test/window.test.ts` |
| ST-3008/2 | `core/test/loader.test.ts`, `core/test/workspace-trust.test.ts`, `core/test/workspace.test.ts` |
| ST-3008/3 | целевое поведение |
| ST-4001/1 | `core/test/trace.test.ts` |
| ST-4001/2 | `core/test/trace.test.ts` |
| ST-4001/3 | `core/test/trace.test.ts` |
| ST-4001/4 | `core/test/trace.test.ts` |
| ST-4001/5 | `core/test/trace.test.ts` |
| ST-4001/6 | `core/test/diagnostics.test.ts`, `core/test/trace.test.ts` |
| ST-4001/7 | `core/test/trace.test.ts` |
| ST-4001/8 | `core/test/trace.test.ts` |
| ST-4001/9 | `core/test/trace.test.ts` |
| ST-4001/10 | замер: `npm run spike:gateway` и `-- --trace=off`, [spike-gateway.md](spike-gateway.md) |
| ST-4001/11 | `core/test/diagnostics.test.ts`, `core/test/trace.test.ts` |
| ST-4002/1 | целевое поведение |
| ST-4002/2 | `core/test/host-output.test.ts`, `core/test/trust.test.ts` |
| ST-4002/3 | `core/test/diagnostics.test.ts`, `core/test/plugin-log.test.ts` |
| ST-4002/4 | `core/test/diagnostics.test.ts`, `core/test/plugin-log.test.ts` |
| ST-4002/5 | `core/test/diagnostics-ring.test.ts`, `core/test/diagnostics.test.ts` |
| ST-4003/1 | `core/test/diagnostics.test.ts`, `electron/test/diagnostics.test.ts` |
| ST-4003/2 | `core/test/diagnostics.test.ts` |
| ST-4003/3 | `core/test/diagnostics.test.ts`, `electron/test/diagnostics.test.ts` |
| ST-4003/4 | `core/test/diagnostics.test.ts`, `electron/test/diagnostics.test.ts`, `playground/test/plugins-model.test.ts` |
| ST-4003/5 | `core/test/diagnostics.test.ts`, `electron/test/diagnostics.test.ts` |
| ST-4003/6 | `core/test/trace.test.ts` |
| ST-4004/1 | `core/test/diagnostics.test.ts`, `electron/test/diagnostics.test.ts` |
| ST-4004/2 | `core/test/diagnostics.test.ts` |
| ST-4004/3 | `core/test/diagnostics.test.ts`, `electron/test/diagnostics.test.ts` |
| ST-4004/4 | `core/test/diagnostics.test.ts` |
| ST-4004/5 | `core/test/diagnostics.test.ts` |
| ST-4005/1 | `core/test/status.test.ts`, `electron/test/plugins.test.ts`, `playground/test/plugins-model.test.ts` |
| ST-4005/2 | `electron/test/plugins.test.ts` |
| ST-4005/3 | целевое поведение |
| ST-4005/4 | `electron/test/plugins.test.ts` |
| ST-5001/1 | `core/test/graph.test.ts`, `core/test/semver-manifest.test.ts` |
| ST-5001/2 | `core/test/graph.test.ts`, `core/test/loader.test.ts` |
| ST-5001/3 | `core/test/graph.test.ts`, `core/test/semver-manifest.test.ts` |
| ST-5001/4 | `core/test/graph.test.ts` |
| ST-5001/5 | `core/test/api-version.test.ts` |
| ST-5001/6 | `core/test/graph.test.ts`, `core/test/registry.test.ts` |
| ST-5002/1 | `core/test/api-snapshot.test.ts`; часть - ручная: карта `Contracts` и контракты `cyborg.*` в роде изменения: ревью по ADR-CH-0002, п. 4 (FR-CH-5003, «Ещё нет») |
| ST-5002/2 | `core/test/registry.test.ts` |
| ST-5002/3 | `core/test/api-snapshot.test.ts`; часть - ручная: новое обязательное поле JSON манифеста и карта `Contracts`: ревью по `contracts/README.md` («Что снимок не видит») и ADR-CH-0002, п. 4 |
| ST-5002/4 | целевое поведение |
| ST-5002/5 | `contracts/test/package.test.ts` |
| ST-5002/6 | `core/test/loader.test.ts` |
| ST-5002/7 | документ: `contracts/CHANGELOG.md`; формат - `scripts/test/release.test.ts` |
| ST-5002/8 | `core/test/graph.test.ts` |
| ST-5003/1 | `core/test/via-contract.test.ts` |
| ST-5003/2 | `core/test/via-contract.test.ts` |
| ST-5003/3 | `core/test/journal.test.ts`, `core/test/status.test.ts` |
| ST-5003/4 | `core/test/status.test.ts` |
| ST-5003/5 | ручная: ревью по ADR-CH-0002, п. 4: срок жизни члена с `@deprecated` сверкой рода изменения не держится (FR-CH-5003, «Ещё нет»); пометку `@deprecated` держит снимок `core/test/api-snapshot/1.0.0.txt` |
| ST-5003/6 | `testing/test/kit.test.ts` |
| ST-5004/1 | `core/test/loader.test.ts` |
| ST-5004/2 | `core/test/config.test.ts`, `core/test/loader.test.ts` |
| ST-5004/3 | `core/test/config.test.ts`, `core/test/json-schema.test.ts`, `core/test/loader.test.ts`, `core/test/trust.test.ts` |
| ST-5004/4 | `core/test/loader.test.ts` |
| ST-5004/5 | `playground/src/main/legacy-workspace.test.ts` |
| ST-5004/6 | `core/test/uninstall.test.ts` |
| ST-5004/7 | `core/test/config.test.ts`, `core/test/loader.test.ts`, `core/test/workspace.test.ts` |
| ST-5004/8 | `core/test/loader.test.ts`, `core/test/workspace.test.ts` |
| ST-6001/1 | `core/test/package.test.ts`, `core/test/public-api.test.ts`, `electron/test/boundary.test.ts`, `electron/test/example.test.ts` |
| ST-6001/2 | `core/test/public-api.test.ts`; часть - ручная: расширение экспорта только новой версией пакета: сверки перечня `exports` с версией нет (FR-CH-6004, «Ещё нет», T-06) |
| ST-6001/3 | `electron/test/plugins.test.ts` |
| ST-6001/4 | `electron/test/plugins.test.ts` |
| ST-6001/5 | `electron/test/plugins.test.ts` |
| ST-6001/6 | целевое поведение |
| ST-6001/7 | `core/test/graph.test.ts`, `core/test/loader.test.ts`, `electron/test/plugins.test.ts` |
| ST-6001/8 | `core/test/api-version.test.ts`, `electron/test/consumer.test.ts`, `scripts/test/release.test.ts` |
| ST-6002/1 | `core/test/api-snapshot.test.ts`, `core/test/graph.test.ts`, `scripts/test/release.test.ts`; часть - ручная: ломающее изменение только мажорной версией: сверки рода изменения с версией пакета нет (FR-CH-6004, «Ещё нет», T-06) |
| ST-6002/2 | `core/test/api-snapshot.test.ts`, `core/test/api-version.test.ts`, `core/test/semver-manifest.test.ts` |
| ST-6002/3 | целевое поведение |
| ST-6002/4 | окно: `npm run smoke` в CI на macOS и Linux, [macos-check.md](macos-check.md) |
| ST-7001/1 | инструменты: `core/test/plugin-template.test.ts`, `tools/cyborg-plugin/test/template.test.ts` |
| ST-7001/2 | инструменты: `tools/cyborg-plugin/test/build.test.ts` |
| ST-7001/3 | инструменты: `tools/cyborg-plugin/test/build.test.ts` |
| ST-7001/4 | целевое поведение |
| ST-7002/1 | `contracts/test/package.test.ts`, `core/test/plugin-check.test.ts` |
| ST-7002/2 | `core/test/plugin-check.test.ts` |
| ST-7002/3 | `core/test/plugin-check.test.ts`, `tools/cyborg-plugin/test/cli.test.ts` |
| ST-7002/4 | `core/test/plugin-check.test.ts` |
| ST-7002/5 | целевое поведение |
| ST-7002/6 | `core/test/plugin-imports.test.ts` |
| ST-7003/1 | инструменты: `testing/test/kit.test.ts` |
| ST-7003/2 | инструменты: `testing/test/agent-suite.test.ts` |
| ST-7003/3 | инструменты: `testing/test/agent-suite.test.ts` |
| ST-7003/4 | документ: [руководство «Тесты плагина»](../guide/authors/testing.md) |
| ST-7003/5 | целевое поведение |
| ST-7004/1 | документ: [author-kit-run.md](author-kit-run.md), `scripts/test/api-reference.test.ts` |
| ST-7004/2 | целевое поведение |
| ST-7004/3 | целевое поведение |
| ST-7004/4 | ручная: [author-kit-run.md](author-kit-run.md) |
