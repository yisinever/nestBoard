/**
 * 文件树右键菜单的**规格层**（O12，接在 T1.67 的「添加到白板」上）。
 *
 * 只回答两件事：**这份菜单有哪些项**、**分组的分隔线落在哪**。
 * 标题与图标写在这里（它们和分组本来就是同一件事），动作由 `main.ts` 接
 * （只有它拿得到 `plugin` 与 `app`）。
 *
 * ★ 为什么单独拆一个文件、而不是继续摊在 `registerFileMenu` 的回调里：
 *   Obsidian 的 `file-menu` 事件只能在真实工作区里触发，排布一旦和技术接线混在一起，
 *   "文件夹有没有这一项""冲突副本是不是独占""分隔线落在哪"就只能靠人眼点一遍。
 *   拆开之后这三条都能在 node 下单测（与 `cardMenu.ts` 完全同一条取舍）。
 * ★ 分组用**顺序 + 分隔线**，不套折叠子菜单：这份菜单最多六项，
 *   为一个分组再点一次悬停不值（`cardMenu` 用子菜单是为了颜色盘那种十几项的选择）。
 * ★ **文件树的空白处没有入口**（O12 的第③条）：`workspace.on('file-menu')` 只对
 *   真实文件与文件夹发事件，空白区域没有对应的公开事件 —— 于是"在根目录新建白板"
 *   只能落到根目录这一层文件夹上（用户右键根目录等价）。这条限制写进了说明书 §17。
 */

import { BOARD_EXT, CANVAS_EXT } from '../../constants';
import { t } from '../../util/i18n';
import type { MessageKey } from '../../util/i18n';

/** 被右键的目标。刻意只收三个判断要用的字段，而不是收 `TAbstractFile` */
export interface FileMenuTarget {
  /** 文件夹（`TFolder`）：它没有"变成卡片"这种说法，只有"在这里建一块板" */
  folder: boolean;
  /** 扩展名（小写、不带点，即 `TFile.extension` 的取值）；文件夹传空串 */
  extension: string;
  /** 同步冲突副本（`isConflictBoardPath`）：它**独占**整份菜单 */
  conflict: boolean;
}

/** 目标之外还要知道的环境 */
export interface FileMenuContext {
  /** 配了「未整理」白板（`settings.homeBoardPath`）时才有"丢进收件箱"这一项 */
  homeConfigured: boolean;
}

/** 菜单项 id。`main.ts` 用一张 `Record<FileMenuAction, …>` 接动作，缺一个就编译不过 */
export type FileMenuAction =
  | 'newBoardHere'
  | 'newMindHere'
  | 'importCanvas'
  | 'addToUnsorted'
  | 'addToBoard'
  | 'deleteBoard'
  | 'viewConflict';

export interface FileMenuItem {
  id: FileMenuAction;
  title: string;
  icon: string;
  /** 在它之前插一条分隔线（O12 的分组）。一份菜单的第一项永远是 `false` */
  separatorBefore: boolean;
}

/** 一项的原料（`t()` 与图标在这里补上） */
type ItemSeed = readonly [FileMenuAction, MessageKey, string];

/**
 * 排出一份文件树菜单。空数组 = 不该出现菜单（当前不存在这种目标，但调用方可以一行处理）。
 *
 * 三组，组内连着排、组间一条分隔线：
 *
 * 1. **当白板 / 脑图用**：文件夹 →「在此新建 nestboard」+「在此新建 nestmind」，
 *    `.canvas` →「导入为白板」；
 * 2. **当卡片用**：「添加到收件箱」（配了 Home 才有）→「添加到白板」；
 * 3. **维护**：`.nboard` →「删除白板」。
 *
 * ★ 第 1 组排在最前：对着文件夹只有这两件事可做；对着一张画布，"把它打开成白板"
 *   十有八九比"把这张画布当成一张卡挂到某块板上"更想干（沿用原注释里的判断）。
 * ★ 两条"在此新建"并排（`C4`，用户 2026-09-18："要把脑图的新建也放进去"）：
 *   它们是同一件事的两个**机型**，分开摆只会让人怀疑"脑图是不是藏在别处"。
 * ★ 第 2 组对**任何文件**都开放（不按类型过滤）：`model/drop.ts` 的判定是"认不出的
 *   类型退到文件卡"，也就是说任何文件都能变成卡片 —— 过滤反而会造出"有的文件有这个
 *   菜单、有的没有"这种说不清规律的差异。
 */
export function fileMenuItems(target: FileMenuTarget, ctx: FileMenuContext): FileMenuItem[] {
  // 冲突副本：一份**可能救得回改动**的副本。把"添加到白板 / 删除白板"摆在旁边，
  // 用户很可能在看清差异之前就顺手点了 —— 而它是唯一还留着冲突内容的文件（T4.03）
  if (target.conflict) {
    return [make('viewConflict', 'menu.file.viewConflict', 'git-compare')];
  }

  const groups: FileMenuItem[][] = [];
  const group = (seeds: readonly ItemSeed[]): void => {
    if (seeds.length === 0) return;
    groups.push(seeds.map(([id, key, icon]) => make(id, key, icon)));
  };

  group(
    target.folder
      ? [
          ['newBoardHere', 'menu.file.newBoardHere', 'layout-dashboard'],
          // 图标与脑图视图自己的观感对齐（那里用的是分支 / 网络那一类）
          ['newMindHere', 'menu.file.newMindHere', 'network'],
        ]
      : target.extension === CANVAS_EXT
        ? [['importCanvas', 'menu.file.importCanvas', 'layout-dashboard']]
        : [],
  );

  group(
    target.folder
      ? []
      : [
          ...(ctx.homeConfigured
            ? [['addToUnsorted', 'menu.file.addToUnsorted', 'inbox'] as const]
            : []),
          ['addToBoard', 'menu.file.addToBoard', 'layout-dashboard'] as const,
        ],
  );

  // Obsidian 原生的删除不给白板留快照；这一项补的正是"删之前先存一份"（T4.04）
  group(
    !target.folder && target.extension === BOARD_EXT
      ? [['deleteBoard', 'menu.file.deleteBoard', 'trash']]
      : [],
  );

  return groups.flatMap((items, index) =>
    items.map((item, i) => ({ ...item, separatorBefore: index > 0 && i === 0 })),
  );
}

function make(id: FileMenuAction, key: MessageKey, icon: string): FileMenuItem {
  return { id, title: t(key), icon, separatorBefore: false };
}
