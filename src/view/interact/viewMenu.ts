/**
 * 白板视图右上角「⋯ 更多」菜单的**规格层**（O11）。
 *
 * 拆两层与右键菜单同一条理由：
 *  * 本文件只产出「菜单长什么样」的纯数据（含各自的 `run`），**不 import `obsidian`**
 *    —— 于是"什么时候该置灰""哪些项之间要有分隔线"这些容易错、又必须回归的规则
 *    可以在 node 下单测；
 *  * `ui/ViewMenu.ts` 负责那枚 `⋯` 按钮，`ui/ContextMenus.ts` 负责塞进 Obsidian 的 `Menu`。
 *
 * ★ 这个菜单是**汇总入口**，不是新能力：每一项都指向命令面板里已经存在的同一条通路
 *   （`view.exportPng()` 之类），所以标题直接复用 `command.*.name` —— 措辞永远不可能
 *   与命令面板漂移。唯一的例外是「复制白板链接」：到这一批才有\"复制**这块板**的链接\"
 *   这个动作（`buildNestboardUri` 此前只被索引笔记与搜索面板间接用到）。
 */

import { t } from '../../util/i18n';
import type { MenuItemSpec } from './cardMenu';

/**
 * 菜单能触发的动作。
 *
 * ★ 做成"动作名 → 无参方法"的映射而不是一串独立的回调：`BoardView` 那边写
 *   `{ exportPng: () => this.exportPng(), ... }` 时**少写一个就编译不过**
 *   （`Record<ViewMenuAction, () => void>`），而不是"渲染时才发现少了一项"。
 */
export type ViewMenuAction =
  | 'exportPng'
  | 'exportSvg'
  | 'exportPdf'
  | 'exportMarkdown'
  | 'copyBoardLink'
  | 'openHome'
  | 'fitContent';

export type ViewMenuActions = { readonly [K in ViewMenuAction]: () => void };

/** 动作之外还要知道的当下状态 */
export interface ViewMenuState {
  /** 有内容可适应（空板没得适应） */
  hasContent: boolean;
  /** 已经认领了路径（板子还没加载完时没有"这块板的链接"） */
  canCopyLink: boolean;
}

type Seed = {
  action: ViewMenuAction;
  titleKey: Parameters<typeof t>[0];
  icon: string;
  disabled?: boolean;
};

/**
 * 按"用的时候会一起用"分组：导出四件套 / 拿到这块板 / 看整块板。
 *
 * ★ 顺序与 `05` 里 O11 那一行写的一致（导出 → 复制链接 → Home → 适应内容）：
 *   菜单的阅读顺序就是"我把这块板做完了，接下来会做什么"。
 * ★ 组与组之间画分隔线（每组的**第一项**带 `separatorBefore`）：7 项排成一列时，
 *   没有分隔线就是一坨，"导出完想干嘛"和"我在哪儿"混在一起。
 */
export function viewMenuItems(actions: ViewMenuActions, state: ViewMenuState): MenuItemSpec[] {
  const groups: readonly (readonly Seed[])[] = [
    [
      { action: 'exportPng', titleKey: 'command.exportPng.name', icon: 'image' },
      { action: 'exportSvg', titleKey: 'command.exportSvg.name', icon: 'pen-tool' },
      { action: 'exportPdf', titleKey: 'command.exportPdf.name', icon: 'file' },
      {
        action: 'exportMarkdown',
        titleKey: 'command.exportMarkdown.name',
        icon: 'file-text',
      },
    ],
    [
      {
        action: 'copyBoardLink',
        titleKey: 'command.copyBoardLink.name',
        icon: 'link',
        // ★ 没有路径时置灰而不是藏起来：这条项在"板子正在加载"和"刚从别处导入"
        //   这两种情况下都会短暂置灰，藏起来会让菜单在眼皮底下跳一次。
        disabled: !state.canCopyLink,
      },
    ],
    [
      {
        action: 'openHome',
        titleKey: 'command.openHome.name',
        icon: 'home',
        // ★ 没设 Home 也**不置灰**：点下去会给出"去设置里填路径"的提示
        //   （与命令面板同一个行为），而这里正是用户发现那个设置的地方。
      },
      {
        action: 'fitContent',
        titleKey: 'command.zoomFit.name',
        icon: 'maximize',
        disabled: !state.hasContent,
      },
    ],
  ];

  const items: MenuItemSpec[] = [];
  groups.forEach((group, groupIndex) => {
    group.forEach((seed, index) => {
      items.push({
        id: seed.action,
        title: t(seed.titleKey),
        icon: seed.icon,
        disabled: seed.disabled === true,
        separatorBefore: groupIndex > 0 && index === 0,
        run: () => actions[seed.action](),
      });
    });
  });
  return items;
}
