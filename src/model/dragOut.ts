/**
 * 拖出卡片到文件浏览器（T6.10 / `F6-04`）的**纯逻辑部分**。
 *
 * 与拖入（`model/drop.ts`）是反着的两条路：拖入回答"外面来的东西怎么变成卡"，
 * 拖出回答"一张卡怎么变成外面的一份文件"。能在这里回答的只有两件事：
 *
 *   1. `dropFolderOf(path, isFolder)`：指针底下那个元素的 `data-path` → 落点文件夹
 *   2. `noteMarkdownOf(fragment)`：这张卡的正文该写什么、有没有值得写出去的
 *
 * （文件叫什么不在这里：那是 `NotePromoter.writeBacked` 的既有职责，
 * 与"提升为笔记"共用同一套命名规则。`model/` 不该反向 import `integration/`。）
 *
 * ── 为什么"拖出"不做成原生拖拽 ──
 *
 * 浏览器一开原生 `dragstart` 就会给正在拖的那个指针补发 `pointercancel`，
 * 而画布的移动手势**正是**靠 `pointermove` / `pointerup` 跑完的（见
 * `BoardView.startDragSession`）。也就是说，在卡片上加 `draggable="true"`
 * 会把"拖动卡片"这个主手势直接打断 —— 这是不能拿来做代价的。
 *
 * 于是反过来用：**复用已有的移动手势**，只在松手那一刻看指针落在了哪儿。
 * 好处不只是"不打架"：拖到一半反悔（拖回画布内松手）天然就是"取消"，
 * 不需要再为它设计一个取消手势。
 *
 * ★ 不 import `obsidian`、不碰 DOM：`isFolder` 这种外部事实由调用方注入，
 *   于是"指针落在文件上该进哪个目录"这类判定能在 node 下逐条钉死。
 */

/**
 * 落点高亮的类名。
 *
 * 定义在这里（而不是各文件各写一遍字符串）：`integration/` 负责加、`styles.css`
 * 负责画，两边都从这里取，改名字时不会漏掉一处。
 */
export const DROP_OUT_HIGHLIGHT_CLASS = 'nestboard-drop-out-target';

/**
 * 指针底下的 `data-path` → 落点文件夹（Vault 相对路径，`''` = 根目录）。
 *
 * 落在文件夹上 → 就是它自己；落在文件上 → **它所在的目录**。
 * 后者是必须的：文件浏览器里滚到某个文件上就想松手是常态，
 * 若只认文件夹行，用户会觉得"十次里有九次没反应"。
 *
 * ★ 根目录下的文件返回 `''` 而不是 `'/'`：全库统一用 `''` 表示根
 *   （`NotePromoter.boardFolderOf` 同此约定），多一个 `'/'` 形态就会让
 *   `folder.length > 0` 这类判断在根目录上判错。
 */
export function dropFolderOf(path: string, isFolder: boolean): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (isFolder) return trimmed;
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? '' : trimmed.slice(0, slash);
}

/**
 * 卡片的 Markdown 片段 → 要写进文件的正文。
 *
 * 返回 `null` 表示"这张卡没什么可写的"（片段全是空白）。必须挡一道：
 * 拖一张空卡片出去会得到一个**空文件**，而用户的结论是"导出坏了"。
 * 调用方据此跳过，并在全都没内容时给出"没有可导出的内容"，而不是写出一堆空文件。
 *
 * ★ 只做"去首尾空白 + 统一换行"，不做别的整理 —— 写进文件的就是卡片上那份内容。
 */
export function noteMarkdownOf(fragment: string): string | null {
  const markdown = fragment.replace(/\r\n?/g, '\n').trim();
  return markdown.length === 0 ? null : markdown;
}
