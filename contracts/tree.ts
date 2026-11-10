import type { Subscription } from './index.ts';

/** Что показать у узла дерева. Порядок значимости при совпадении нескольких причин задаёт поставщик, потребитель рисует то, что получил. */
export type TreeMarkKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface TreeMark {
  /** Относительно корня, разделитель `/`; отметка файла, а не каталога: каталог потребитель отмечает сам по детям. */
  readonly path: string;
  readonly kind: TreeMarkKind;
}

/**
 * `cyborg.tree-decoration` 1, кратность many (SAD, раздел 4): контракт объявляет владелец дерева (`files`), вкладчики (`git` и другие) отдают отметки, рисует владелец.
 * Черновик PL-04. Поставщик объявляет `guard: { "fs.read": 0 }` на `marks`.
 */
export interface TreeDecoration {
  /** Отметки корня на сейчас; `root` - абсолютный путь. Корня поставщик не знает - пусто. */
  marks(root: string): Promise<TreeMark[]>;
  /** Набор отметок корня мог измениться по причине, которой дерево не видит (индекс, ветка); `root` - корень, о котором речь. */
  onChange(listener: (root: string) => void): Subscription;
}
