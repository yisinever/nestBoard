/**
 * Home 白板与它的收件箱（T5.07 / `F7-03` / `F11-09`）。
 *
 * ## Home 解决什么问题
 *
 * 到 v1.0 为止，"往白板里放点东西"永远要先回答一个问题：**放哪块板？**
 * 想不清楚的时候，人要么随手建一块新板（白板越攒越多），要么干脆放弃（东西留在原处）。
 * Home 把这个问题从"每次都要答"降级成"默认有个答案"：
 * - 「打开 Home 白板」不必先想要去哪 —— 它就是你手边那块；
 * - 「添加到收件箱」不必挑目标 —— 落进 Home 的 `Unsorted` 栏，回头再整理。
 *
 * ## 为什么建板这件事要经过 `io/newBoard.ts`
 *
 * 那里是全插件唯一一处"落一个白板文件"的实现（目录规则 / 默认背景 / 注册表登记）。
 * Home 只是把其中**两条**规则钉死（路径由设置给、初始带一栏收件箱），
 * 剩下的（`repository.createBoard` + `registry.upsert`）必须和别的入口是同一条路 ——
 * 否则"新建的白板没出现在选择器里"这类 bug 会在两个入口里各修一遍。
 *
 * ## 纯的部分与不纯的部分
 *
 * `boardTitleFromPath` / `unsortedColumnOf` / `unsortedDropPoint` 是纯函数（可测）；
 * `ensureHomeBoard` 要读写 Vault。整份文件**零 `obsidian` 运行时依赖**，
 * 所以 `ensureHomeBoard` 也能在 node 下用假 plugin 直接测。
 */

import { BOARD_EXT, UNSORTED_COLUMN_TITLE } from '../constants';
import { baseNameOf } from '../model/drop';
import { createColumn } from '../model/factories';
import type { BoardFile, Column } from '../model/schema';
import type { Point } from '../util/geometry';
import { createBoardInVault } from './newBoard';
import type NestboardPlugin from '../main';

/**
 * 路径 → 白板的标题（去掉目录与扩展名）。
 *
 * ★ 用**文件名**当标题而不是写死一句 `Home`：用户完全可以把文件改名成
 *   `主页.nboard` 或 `工作台.nboard`（甚至改到别的目录），设置里改一下路径即可。
 *   标题跟着文件名走，他看到的板和文件管理器里的一致 —— 这是文件格式的一部分，
 *   不该由插件另外记一份。
 */
export function boardTitleFromPath(path: string): string {
  const name = baseNameOf(path);
  const suffix = `.${BOARD_EXT}`;
  return name.toLowerCase().endsWith(suffix) ? name.slice(0, name.length - suffix.length) : name;
}

/**
 * 确保 Home 白板存在，返回它的路径。
 *
 * 三种情形，各有各的处理：
 * 1. **没配置**（`settings.homeBoardPath === ''`）→ `null`。调用方负责说"Home 没开"；
 *    本模块不弹通知（同 `io/newBoard.ts` 的规矩：这一层不做只有 UI 才知道怎么说的事）。
 * 2. **已经在索引里** → 直接返回。绝大多数调用都走这一条，一次查表。
 * 3. **不在索引里** → 再看盘上有没有：
 *    - 有 → 只是没被登记（比如刚被外部创建），**登记一下就走**。
 *      ★ 绝不能"既然不在索引里就建一块" —— 那会把用户已经放好东西的板整块覆盖掉，
 *        是本功能唯一可能造成数据损失的路径。
 *    - 没有 → 按 `exactPath` 落一块新的，带一栏 `Unsorted`。
 */
export async function ensureHomeBoard(plugin: NestboardPlugin): Promise<string | null> {
  const path = plugin.settings.homeBoardPath;
  if (path === '') return null;
  if (plugin.registry.getByPath(path)) return path;

  if (await plugin.vaultIO.exists(path)) {
    await plugin.registry.upsert(path);
    return path;
  }

  await createBoardInVault(plugin, {
    exactPath: path,
    title: boardTitleFromPath(path),
    columns: [createColumn({ title: UNSORTED_COLUMN_TITLE })],
  });
  return path;
}

/**
 * 收件箱那一栏（T5.07），没有则 `null`。
 *
 * ★ 按**标题**找：标题已经写进了 `.nboard` 文件，是这块板自己的数据，插件不该
 *   在别处另存一份"哪一栏是收件箱"（那就会出现"文件里改了、插件还记得旧的"）。
 *   代价是用户把这一栏改名之后，"默认落点"会退回视口中心 —— 这是可接受的降级，
 *   比"插件偷偷记住一个 id，而那一栏早就被删了"要好。
 */
export function unsortedColumnOf(board: BoardFile): Column | null {
  return board.columns.find((column) => column.title.trim() === UNSORTED_COLUMN_TITLE) ?? null;
}

/**
 * 「添加到收件箱」该落在哪儿：收件箱分栏的**中心**（世界坐标）。
 *
 * ★ 为什么要有这个函数：`BoardView.placeDroppedCards` 是按"落点在哪一栏里"决定
 *   卡片归属的（`model/drop.ts`）。想让它真的进收件箱，就得把落点算到那一栏中心 ——
 *   否则新卡会落在视口正中央，而视口在哪儿完全取决于用户上次看到哪。
 *   没有收件箱时返回 `null`，调用方回落到"视口中心"（与过去的行为一致）。
 */
export function unsortedDropPoint(board: BoardFile): Point | null {
  const column = unsortedColumnOf(board);
  if (!column) return null;
  return { x: column.x + column.width / 2, y: column.y + column.height / 2 };
}
