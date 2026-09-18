/**
 * 脑图视图「…」菜单的**规格层**（用户 2026-09-17："相同的导出能力，脑图也要做一遍。
 * 也是注入到 obisidian 原生的菜单中。"）。
 *
 * ★ 与白板那份（`view/interact/viewMenu.ts`）同一条分工：
 *   * 本文件只产出"菜单长什么样"的**纯数据**，不 import `obsidian` —— 于是分组、置灰、
 *     顺序这些容易错又必须回归的规则可以在 node 下单测；
 *   * 塞进 `Menu` 的活交给 `ui/ContextMenus.appendMenuItems`。
 * ★ 每一项都**指向已有的通路**（`view.exportAs(kind)` / `fitContent()` / `toggleOutline()`），
 *   标题直接复用 `command.*.name` —— 措辞永远不可能与命令面板漂移。
 * ★ **类型在本地再写一份**（而不是 import 白板那份 `MenuItemSpec`）：`src/mind/**` 不许
 *   依赖白板的 `view/**`（`06 §2` 的边界，eslint 拦着）。两份结构一致，而 `appendMenuItems`
 *   认的是**结构**不是出处 ⇒ 传进去没有问题。
 */

import { t } from '../../util/i18n';

/** 菜单能触发的动作（`Record` 形式的动作表 ⇒ 视图那边少写一项就编译不过） */
export type MindMenuAction =
  | 'exportPng'
  | 'exportSvg'
  | 'exportOutlineMarkdown'
  | 'exportMarkdown'
  | 'exportFreeMind'
  | 'exportXmind'
  | 'fit'
  | 'toggleOutline';

export type MindMenuActions = { readonly [K in MindMenuAction]: () => void };

/** 动作之外还要知道的当下状态 */
export interface MindMenuState {
  /** 脑图加载好了没有（没加载时那几项导出没有意义） */
  loaded: boolean;
}

/** 菜单项：与白板那份 `MenuItemSpec` 结构一致（见文件头最后一条） */
export interface MindMenuItemSpec {
  id: string;
  title: string;
  icon?: string;
  disabled?: boolean;
  /** 这一项之前画一条分隔线（每组的第一项） */
  separatorBefore?: boolean;
  run: () => void;
}

type Seed = {
  action: MindMenuAction;
  titleKey: Parameters<typeof t>[0];
  icon: string;
};

/**
 * 按"用的时候会一起用"分组：**看图**（PNG / SVG）/ **换软件继续编**（大纲 md / md / FreeMind / XMind）
 * / **看整棵树**（适应内容 / 大纲视图）。
 *
 * ★ 顺序就是"我把这张图做完了，接下来会做什么"：先给一张图发出去，再给别的软件一份，
 *   最后是"我在哪儿"。
 * ★ 组间画分隔线（每组第一项带 `separatorBefore`）：八项排成一列，不分组就是一坨。
 */
export function mindMenuItems(actions: MindMenuActions, state: MindMenuState): MindMenuItemSpec[] {
  const groups: readonly (readonly Seed[])[] = [
    [
      { action: 'exportPng', titleKey: 'command.mindExportPng.name', icon: 'image' },
      { action: 'exportSvg', titleKey: 'command.mindExportSvg.name', icon: 'pen-tool' },
    ],
    [
      {
        action: 'exportOutlineMarkdown',
        titleKey: 'command.mindExportOutline.name',
        icon: 'list',
      },
      { action: 'exportMarkdown', titleKey: 'command.mindExportMarkdown.name', icon: 'file-text' },
      { action: 'exportFreeMind', titleKey: 'command.mindExportFreeMind.name', icon: 'file' },
      { action: 'exportXmind', titleKey: 'command.mindExportXmind.name', icon: 'network' },
    ],
    [
      { action: 'toggleOutline', titleKey: 'command.mindToggleOutline.name', icon: 'list-tree' },
      { action: 'fit', titleKey: 'command.mindFit.name', icon: 'maximize' },
    ],
  ];

  const items: MindMenuItemSpec[] = [];
  groups.forEach((group, groupIndex) => {
    group.forEach((seed, index) => {
      items.push({
        id: seed.action,
        title: t(seed.titleKey),
        icon: seed.icon,
        disabled: !state.loaded,
        separatorBefore: groupIndex > 0 && index === 0,
        run: () => actions[seed.action](),
      });
    });
  });
  return items;
}
