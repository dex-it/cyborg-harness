# Решения ADR-CH

Решения об устройстве ядра. Где ADR расходится с [SAD](../design/sad.md), действует SAD ([раздел 7](../design/sad.md#7-расхождения-с-первой-редакцией-пакета)). Статусы ведёт шапка каждого файла; приёмка владельцем - [чек-лист P-11](../../06-plans/acceptance-checklist.md).

**Номера идут не подряд.** Нет ADR-CH-0006, 0009, 0010, 0011 и 0013: 0006 (перенос Cyborg «душителем» с паритетом) снят и в харнес не вошёл, 0009, 0010, 0011 и 0013 влиты при слиянии с master 2026-11-06 в ADR-CH-0001, 0005, 0003 и 0007; номера не переиспользуются. Счётчик `docs/.req_counter/ADR` - 0016.

| ADR | Тема | Статус в шапке |
|---|---|---|
| [ADR-CH-0001](ADR-CH-0001-core-and-plugins.md) | ядро и плагины | review |
| [ADR-CH-0002](ADR-CH-0002-manifest-and-compatibility.md) | манифест, совместимость, `config` и `state` | review |
| [ADR-CH-0003](ADR-CH-0003-trust-and-isolation.md) | доверие и изоляция | review |
| [ADR-CH-0004](ADR-CH-0004-agent-provider-contract.md) | контракт агента | review |
| [ADR-CH-0005](ADR-CH-0005-plugin-interaction.md) | связь плагинов (бывший `ADR-CH-0005-extension-points`) | review |
| [ADR-CH-0007](ADR-CH-0007-plugin-ui.md) | интерфейс плагинов (бывший `ADR-CH-0007-ui-slots-and-commands`) | review |
| [ADR-CH-0008](ADR-CH-0008-terminology.md) | терминология | review |
| [ADR-CH-0012](ADR-CH-0012-pty-host.md) | pty-хост | accepted |
| [ADR-CH-0014](ADR-CH-0014-secrets.md) | секреты | proposed |
| [ADR-CH-0015](ADR-CH-0015-workspace-trust.md) | доверие к воркспейсу | accepted |
| [ADR-CH-0016](ADR-CH-0016-command-callers.md) | права вызывающего у команд | accepted |
