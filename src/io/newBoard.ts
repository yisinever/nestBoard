/**
 * 造一块新的 `.nboard`（T1.61 子白板 / `F2-8-1`，也被 ⌘⇧N 与模板库复用）。
 *
 * ★ 这里是全插件**唯一**一处"落一个白板文件"的实现，三个入口共用：
 *   - `commands.ts` 的 ⌘⇧N：顶层板（`meta.parent = null`），建完直接打开；
 *   - `BoardView` 的「新建子白板」：`meta.parent` = 当前板，建完落成一张卡片；
 *   - `ui/templateActions.ts` 的「从模板新建白板」（`T4.14`）：传 `template`，内容由
 *     `instantiateTemplate()` 复制一份出来。
 *   抄成两份的话，"目录来自设置""默认背景来自设置""重名顺延"这三条规则会各写各的，
 *   而它们恰恰是用户最容易一眼看出不一致的地方。
 *
 * ★ 刻意**不发通知、不开视图**：这两件事只有 UI 层做得了、也只有 UI 层知道该怎么说
 *   （顶层板说"已创建白板"，子板说"已创建子白板"）。本模块只管"库里多了一块板"，
 *   于是它不依赖 `obsidian` 运行时，可以在 node 下用假 plugin 直接单测。
 *
 * ★ 失败**抛出**而不是返回 `null`：调用方要的是给用户一句带原因的话
 *   （`describeError`），把错误吞在这一层等于把唯一的原因弄丢了。
 */

import { BOARD_EXT } from '../constants';
import { createBoardFile } from '../model/factories';
import type { BoardFile, Column } from '../model/schema';
import { instantiateTemplate } from '../model/templates';
import { noteNameFrom, uniquePath } from '../util/fileName';
import { t } from '../util/i18n';
import type NestboardPlugin from '../main';

export interface NewBoardOptions {
  /**
   * 父白板路径（T1.61）。写进新板的 `meta.parent` —— 面包屑、`⌘U` 回父级、
   * `RenameWatcher` 修父子路径全都只认这一个字段（03 §3.2）。
   * 不传 = 顶层板，与"我就是要一块孤立的板"一致。
   */
  parent?: string | null;
  /**
   * 新板的标题。不传 = `未命名白板`（从模板建板时传模板名，见下）。
   */
  title?: string;
  /**
   * 从模板建板（`T4.14` / `F7-06`）：传一份**模板板**进来，内容由
   * `instantiateTemplate()` 复制成新的一份（换 id、落回原点、清只读）。
   *
   * ★ 走这条分支时**不套 `settings.defaultBackground`**：模板的底色是模板的一部分
   *   （情绪板的"干净背景"被用户设置里的圆点覆盖掉，模板就不像模板了）。
   *   其余规则（目录来自设置、重名顺延、注册表登记）与空白板**完全一样**。
   */
  template?: BoardFile;
  /**
   * 用**指定的完整路径**落板，跳过"按设置目录 + 重名顺延"那一步（T5.07 / `F7-03`）。
   *
   * ★ 只有 Home 白板走这条：它的位置是**用户自己填的**（`settings.homeBoardPath`）。
   *   再套一层 `uniquePath` 就等于"用户说放在 A，插件悄悄放到 `A 2`" —— 而下次启动
   *   又按 A 去找，于是**永远找不到**（每次打开都新建一块，用户的卡片散在一堆板里）。
   *   路径合法性由 `util/boardPath.ts` 在进门时归一化，这一层只管用。
   */
  exactPath?: string;
  /**
   * 用**指定的目录**当基底（O12：文件树右键「在此新建白板」）。不传 = 设置里的新建目录。
   *
   * ★ 与 `exactPath` 的分工：那个连**文件名**一起钉死（Home 白板，一格都不许挪），
   *   这个只换基底目录、重名照旧顺延 —— 在同一个文件夹里连点两次「在此新建白板」，
   *   第二块该叫 `未命名白板 2`，而不是覆盖掉前一块。
   * ★ 只对**空白板**分支生效：从模板建板时目录也从这里来，但路径同样要顺延。
   */
  folder?: string;
  /**
   * 新板的初始分栏（T5.07 / `F7-03`）。不传 = 空板，与过去的行为完全一致。
   *
   * ★ 只在**空白板**分支生效：从模板建板时结构由模板决定，再塞一栏会凭空多出来。
   */
  columns?: Column[];
}

/**
 * 造一块新白板（空白或从模板），返回落盘路径。
 *
 * 目录与默认背景每次现读 `plugin.settings`（T1.74 / T3.25）：用户换了新建目录之后
 * **下一次**新建就走新目录，不必重启。
 */
export async function createBoardInVault(
  plugin: NestboardPlugin,
  options: NewBoardOptions = {},
): Promise<string> {
  const parent = options.parent ?? null;
  const baseName = options.title?.trim() ? options.title.trim() : t('board.untitled');

  // `Boards/未命名白板.nboard` → `未命名白板 2.nboard` → …
  // ★ 复用 `uniquePath` 而不是在这里再写一遍顺延规则：附件导入 / 提升为笔记走的
  //   都是它，规则只该有一份（见 `util/fileName.ts` 的文件头注释）。
  // ★ `exactPath` 直接短路掉它：位置由调用方钉死（Home 白板），顺延会把它挪走
  const folder = options.folder ?? plugin.settings.newBoardFolder;
  const path =
    options.exactPath ??
    (await uniquePath(folder, noteNameFrom(baseName), `.${BOARD_EXT}`, (candidate) =>
      plugin.vaultIO.exists(candidate),
    ));

  // 背景写进**这个新文件**的 `view.background`：已有的白板保持各自的背景不变
  // （"我改了个默认值，所有板子都变了"不可接受）
  const board: BoardFile = options.template
    ? instantiateTemplate(options.template, { title: baseName, parent })
    : createBoardFile({
        meta: { title: baseName, parent },
        view: { background: plugin.settings.defaultBackground },
        // ★ 条件展开而不是 `columns: options.columns`：后者在不传时会把 `undefined`
        //   覆盖掉 `createBoardFile` 里的默认 `[]`（`{columns: [], ...rest}` 里 undefined 也算数）
        ...(options.columns ? { columns: options.columns } : {}),
      });

  await plugin.repository.createBoard(path, board);
  // 注册表是"白板之间互相引用"的索引（T1.63）：不在里面登记，新板就不会出现在
  // 任何选择器 / 面包屑里 —— 用户会觉得"我刚建的那块板不见了"
  await plugin.registry.upsert(path);
  return path;
}
