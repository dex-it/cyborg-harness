import type { LayoutMark } from './layout.ts';
import type { MenuName } from './manifest-menus.ts';

/** Строка снимка меню. Пункт плагина, который не работает, остаётся: `enabled: false` и `mark` говорят почему, убирать пункт нельзя (FR-5006, FR-10007). */
export interface MenuEntry {
  readonly pluginId: string;
  /** Имя пункта внутри плагина. */
  readonly id: string;
  readonly menu: MenuName;
  readonly title: string;
  /** Своя команда плагина: исполнять её просит `Kernel.runMenuItem`. */
  readonly command: string;
  readonly order: number;
  /** Сочетание пункта в записи манифеста (`CmdOrCtrl+Shift+F`): нет, если человек отдал его другой команде, освободил (`null`) или оно занято окном и другим пунктом. */
  readonly accelerator?: string;
  readonly enabled: boolean;
  /** Есть только у пункта с галочкой. */
  readonly checked?: boolean;
  /** Почему плагин сейчас не работает; у работающего нет. */
  readonly mark?: LayoutMark;
}
