/**
 * 用户模板库（`T4.14` / `F7-06`）：扫模板目录 / 读一份模板 / 把当前板另存为模板。
 *
 * ── 为什么模板是"库里的 `.nboard` 文件"，而不是插件数据里的一串 JSON ──
 *
 * 1. **用户看得见、能自己管**：发给同事、放进 Git、用别的编辑器打开改 —— 这些都是
 *    "文件"这个形状天然会得到的能力；存进 `data.json` 就只能靠插件自己再长一套导入导出。
 * 2. **白拿一整套已经磨过的读写**：模板文件就是一份合法的板，解析走 `parseBoardFile()`
 *    （坏文件被挡住，而不是把视图搞崩），重名顺延走 `uniquePath()`，
 *    连"模板里到底有什么"都能直接打开那块板看 —— 不必为模板再写一遍解析器。
 * 3. **代价写在明处**：模板是合法的 `.nboard`，所以它也会出现在白板选择器 / 注册表里
 *    （README 的局限里写了这一条）。这不是疏忽 —— "模板也是板"正是上面两条的前提。
 *
 * ★ 与 `io/newBoard.ts` 的分工：那边管"落一块**新板**"（全插件唯一的落板入口），
 *   这边只管"模板文件"这一种普通文件。所以「从模板新建白板」= 这里读出模板 →
 *   `newBoard.createBoardInVault({ template })`，落板的三条规则（目录来自设置 / 重名顺延 /
 *   注册表登记）仍然只有那一份实现。
 *
 * ★ 不发通知、不开视图、不碰注册表：那是 UI 层的事。
 * ★ 读不出来的模板**不抛**（只计数）：一份坏文件不该让整张模板列表打不开。
 */

import { BOARD_EXT } from '../constants';
import { describeTemplate, packTemplate, type TemplateSummary } from '../model/templates';
import type { BoardFile } from '../model/schema';
import { noteNameFrom, normalizeFolder, splitName, uniquePath } from '../util/fileName';
import { parseBoardFile } from './boardText';
import { serializeBoard } from './BoardRepository';
import type NestboardPlugin from '../main';

/** 列表里的一条用户模板 */
export interface UserTemplate {
  path: string;
  title: string;
  summary: TemplateSummary;
  /**
   * 解析后的板（`T6.09` 起带上）。
   *
   * ★ 是**白拿**的：`listUserTemplates` 为算 `summary` 本来就要解析一遍，
   *   顺手留下解析结果，模板市场的预览就不必再读一次盘 ——
   *   一次打开弹窗读两遍同样的文件，在几十份模板的库里是能感觉到的。
   * ★ 代价写在明处：这些板会随列表一起活在内存里，直到对话框关闭。
   *   单份模板通常只有几 KB，而且弹窗是**瞬态**的 —— 换掉"重复解析 + 重复 IO"划算。
   */
  board: BoardFile;
}

export interface UserTemplateList {
  templates: UserTemplate[];
  /** 读不出来的份数（坏 JSON / 不是板文件）—— 列表照常给，只是要告诉用户跳过了几份 */
  skipped: number;
}

/**
 * 这个路径是不是模板目录下的模板。
 *
 * ★ 认**子目录**（`Templates/研究/xxx.nboard` 也算）：用户想按主题分文件夹是很自然的诉求，
 *   而"只有摊在根上才认"会让人以为模板凭空消失了。
 */
export function isTemplatePath(folder: string, path: string): boolean {
  if (!path.endsWith(`.${BOARD_EXT}`)) return false;
  const dir = normalizeFolder(folder);
  // 目录为空 = 用户明确把模板目录设成了库根，这时候**不认**任何文件：
  // "全库的板都算模板"会让列表里出现所有白板，那不是模板库
  if (dir.length === 0) return false;
  return path.startsWith(`${dir}/`);
}

/** 模板的显示名：优先 `meta.title`，空标题退回文件名（手改过的文件标题可能是空的） */
function templateTitle(board: BoardFile, path: string): string {
  const title = board.meta.title.trim();
  return title.length > 0 ? title : splitName(path).base;
}

/**
 * 扫一遍模板目录。
 *
 * ★ 只读**这个目录下**的文件：全库扫一遍在几百块板的大库里是白等（列表本身也不显示它们）。
 */
export async function listUserTemplates(plugin: NestboardPlugin): Promise<UserTemplateList> {
  const folder = plugin.settings.templateFolder;
  const paths = (await plugin.vaultIO.list(BOARD_EXT))
    .filter((path) => isTemplatePath(folder, path))
    // 稳定排序：列表顺序不该跟着文件系统的返回顺序飘
    .sort();

  const templates: UserTemplate[] = [];
  let skipped = 0;

  for (const path of paths) {
    try {
      const raw = await plugin.vaultIO.read(path);
      const board = parseBoardFile(raw);
      if (!board) {
        skipped += 1;
        continue;
      }
      templates.push({
        path,
        title: templateTitle(board, path),
        summary: describeTemplate(board),
        board,
      });
    } catch {
      // 读失败（文件刚被删 / 权限）等价于"这一份用不了"，与坏内容同样处理
      skipped += 1;
    }
  }

  return { templates, skipped };
}

/**
 * 读一份模板准备使用。
 *
 * @returns 读不出来 / 不是板文件时返回 `null`（UI 据此给一句带路径的话）；
 *   **IO 层的错误照旧抛出** —— 那是"库出问题了"，不是"这份模板坏了"，两者要给不同的话。
 */
export async function readTemplate(
  plugin: NestboardPlugin,
  path: string,
): Promise<BoardFile | null> {
  const raw = await plugin.vaultIO.read(path);
  return parseBoardFile(raw);
}

/**
 * 把一块板另存为模板，返回落盘路径。
 *
 * ★ 重名**顺延**（`xxx 2.nboard`）而不是报错：这是所有"导出 / 另存"的既定规则，
 *   模板也一样 —— 用户第二次另存同名模板时，想要的显然是"再存一份"，不是"你先去删一个"。
 */
export async function saveBoardAsTemplate(
  plugin: NestboardPlugin,
  board: BoardFile,
  name: string,
): Promise<string> {
  const title = name.trim().length > 0 ? name.trim() : board.meta.title.trim();
  const path = await uniquePath(
    plugin.settings.templateFolder,
    noteNameFrom(title),
    `.${BOARD_EXT}`,
    (candidate) => plugin.vaultIO.exists(candidate),
  );
  await plugin.vaultIO.create(path, serializeBoard(packTemplate(board, title)));
  return path;
}
