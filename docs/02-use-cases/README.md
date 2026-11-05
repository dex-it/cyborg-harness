# Сценарии

Файл на сценарий (по плану корпуса: `02-use-cases/<слаг>/`). Сценарии привязаны к требованиям [BRD](../01-product/brd.md) и фич; приведены к [SAD2](../03-architecture/design/sad2.md): хосты и сторож, контракты, pty-хост, `<iframe>`, второй этап изоляции доступа.

| Сценарий | Актор | Требования |
|---|---|---|
| [user-after-upgrade](user-after-upgrade/scenario.md) | Пользователь | BR-CH-002 |
| [plugin-failure-isolated](plugin-failure-isolated/scenario.md) | Пользователь, мейнтейнер | BR-CH-006 |
| [terminal-survives-host-restart](terminal-survives-host-restart/scenario.md) | Пользователь | BR-CH-006, BR-CH-003 |
| [author-writes-plugin](author-writes-plugin/scenario.md) | Автор плагина | BR-CH-004 |
| [maintainer-adds-feature](maintainer-adds-feature/scenario.md) | Мейнтейнер | BR-CH-001 |
| [second-agent](second-agent/scenario.md) | Автор плагина агента, пользователь | BR-CH-003 |
| [third-party-install-permissions](third-party-install-permissions/scenario.md) | Пользователь (этап 2) | BR-CH-004, BR-CH-005 |
