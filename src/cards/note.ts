/**
 * 便签卡（T1.32，`F2.1`）—— 内容**存在白板文件里**的内联卡片（`NoteContent.md`）。
 *
 * 两种呈现（`02 §3` 的显示态 / 编辑态）：
 *
 * | 模式 | 渲染 | 进入方式 |
 * |---|---|---|
 * | `display` | Obsidian Markdown 渲染（双链、标签、代码块、内嵌全都原生生效） | 默认 |
 * | `edit` | `MiniMarkdownEditor`（行首快捷输入 + 列表续行 + `⌘B`/`⌘I` + 粘图 + `[[` 补全），`Esc` / `⌘Enter` / 失焦提交 | 双击卡片 |
 *
 * ── `F5`（用户 2026-09-21）：卡内编辑**只有正文**，与文档节点同款 ──
 *
 * ★ 便签卡与引用卡（`.md` 文档节点）在"怎么改内容、怎么改标题"上**必须是同一套**
 *   （用户原话："不能是'一个能干的另一个干不了'"）：
 *   * **内容** = 正文编辑器（`MiniMarkdownEditor`）—— 编辑态里**没有标题那一格**；
 *   * **标题** = 卡面那一行的就地输入（`BoardView.editCardTitle` → `CardLayer.editTitle`，
 *     也就是右键「编辑标题」那一项；双击标题行也走它）。
 * ★ 从前这里是"标题框 + 正文框两格"（`O22`），本次按上面那条口径**收掉了标题框**：
 *   两格意味着"进内容编辑就顺带进标题编辑"，而文档节点那边标题根本不在编辑器里
 *   —— 这正是当初说的"两个半套"。想改标题仍有明确的入口（见上），而且输入框就长在
 *   **标题那一行上**（那条反馈的落点没变，只是入口从"双击进两格"换成了"双击标题行"）。
 *
 * ── 深色变体（`O06`） ──────────────────────────────────────
 *
 * `NoteContent.variant === 'dark'` 时是张黑底白字的"黑卡"。三个要点：
 *
 * 1. **内容一个字都不改**，变的只是底色与正文色。所以渲染 / 导出 / 搜索那条路都不用分叉，
 *    只有"画"的地方要跟着走 —— 视图侧靠一条 CSS 类（`is-dark`），
 *    导出侧靠 `export/toPng.ts` 的 `isDarkNoteCard`（两边取同一组颜色）。
 * 2. **类加在内容槽上，配色打在卡片外壳上**：便签的标题行属于骨架（`CardLayer`），
 *    只把正文涂黑会留一条浅色的标题带、像没上完色。反选外壳的手段是样式表里的
 *    `:has(> .nestboard-card-content.is-dark)`（同一条手法在空标题上已经用过）。
 * 3. 切换入口是卡片右键菜单的一项（`menu.card.noteDark` / `noteLight`），
 *    切换逻辑在 `BoardView.toggleNoteVariant` —— 与"显示/隐藏标题"同一条路，
 *    于是它自动进了撤销栈（`history.noteVariant`）。
 *
 * ★ 编辑态的实现在 `src/editor/MiniMarkdownEditor.ts`（T1.33；P4 起搬到共享层）。本文件只做接线：
 *   `renderEditor` 把内容槽交给编辑器，再把 `onSubmit` / `onExit` 转成视图调用。
 *   这样待办卡（T3.01）等同样要编辑正文的类型可以原样复用那个编辑器。
 *
 * ★ `NoteContent.editorMode`（`'markdown' | 'preview'`）是**持久偏好**
 *   ——"这张卡常驻源码编辑"。卡片右键菜单（T1.41）与 `CardTypeMenuItem.action`
 *   那套机制已经落地了，但仍**没有一项去写 `NoteContent.editorMode`**：
 *   实际消费它的渲染分支还没做（瞬时编辑态由 `editingCardId` 决定，
 *   见 `CardViewMode` 的注释）。所以这里仍然不读它 —— 提前读只会得到一个改不动的死字段。
 *
 * ★ 不 import `obsidian`：Markdown 渲染由 `CardRenderContext.renderMarkdown` 注入，
 *   所以本文件的判定与提交逻辑可以在 node 下直接单测。
 */

import type { NoteContent } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import { MiniMarkdownEditor } from '../editor/MiniMarkdownEditor';
import type { CardRenderContext, CardTypeDefinition, CardTypeMenuItem } from './registry';

/** 新建便签的默认尺寸：约 8 行正文，够写一句结论又不至于压住整屏 */
export const NOTE_DEFAULT_SIZE: Size = { width: 260, height: 170 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（否则会污染复用池里的节点） */
const NOTE_CLASSES = [
  'nestboard-note',
  'nestboard-note-preview',
  'nestboard-note-edit',
  // 深色变体（`O06`）：不摘掉的话，下一位租客（复用池里什么类型都可能）会继承黑底
  'is-dark',
] as const;

/**
 * 正文为空 → 显示引导文案而不是一片空白。
 * 抽成纯函数是为了可单测：空/纯空白/有内容三种输入的判定是这里唯一的分支。
 */
export function isBlankNote(md: string): boolean {
  return md.trim().length === 0;
}

export const noteCard: CardTypeDefinition<'note'> = {
  type: 'note',

  // getter：语言切换后取到的仍是当前语言的名称
  get displayName(): string {
    return t('card.type.note');
  },

  icon: 'sticky-note',
  defaultSize: NOTE_DEFAULT_SIZE,

  createDefaultContent(): NoteContent {
    // 新便签一律是浅色：`variant` 缺席 = `light`，键不写进文件（见 `NoteVariant`）
    return { md: '', editorMode: 'preview' };
  },

  /**
   * 便签的类型专属菜单项：**现在是空的**。
   *
   * ★ 「深色便签」（`O06` 的 `variant`）那一项**收起来了**（用户 2026-09-16：
   *   "深色便签、强调颜色这两块功能都可以隐藏了"）。数据与渲染都还在（旧文件里的
   *   深色便签照旧显示、样式表也照旧管着），只是**不再给入口** ——
   *   真要回滚，把这一项加回来即可（`bindTypeItem` 那一边一个字都不用动）。
   * ★ 保留这个方法而不是删掉：类型定义里"有没有专属菜单项"是个公开问题，
   *   留一个空实现 + 这段说明，比"哪天要加回来时先找半天当初删在哪"划算。
   */
  contextMenu(): CardTypeMenuItem[] {
    return [];
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-note');
    // 深色变体（`O06`）：这个类只画"内容槽"，卡片外壳（底色 / 标题行 / 分隔线）
    // 由样式表用 `:has(> .nestboard-card-content.is-dark)` 反选过去 —— 见文件头的第 2 条
    el.classList.toggle('is-dark', card.content.variant === 'dark');
    if (ctx.mode === 'edit') renderNoteEditor(el, card.content.md, ctx);
    else renderNotePreview(el, card.content.md, ctx);
  },

  /**
   * 节点被回收进复用池前的清理。
   * 这里删掉的每个 class，`render()` 里都加过一次 —— 漏一个，
   * 下一位租客（可能是图片卡）就会继承便签的样式。
   *
   * ★ `F5` 起**不必**再收"标题栏上的编辑残留"：编辑态里已经没有标题框了
   *   （标题编辑走 `CardLayer.editTitle`，它自己摘输入框、`CardLayer.resetNode`
   *   也会兜一遍 —— 见本文件文件头那段）。
   */
  destroy(el: HTMLElement): void {
    el.classList.remove(...NOTE_CLASSES);
    delete el.dataset.placeholder;
  },

  toMarkdown(card): string {
    return card.content.md;
  },
};

/**
 * 便签的**显示态**渲染。
 *
 * ★ 导出给同步便签（`cards/syncNote.ts`，T7.04）复用：同步便签的正文就是便签的正文，
 *   两者"显示出来长什么样"必须一模一样 —— 各写一份的话，改了便签的行距或占位文案，
 *   同步便签会悄悄停在旧样子，而那种不一致用户根本没法解释。
 */
export function renderNotePreview(el: HTMLElement, md: string, ctx: CardRenderContext): void {
  el.classList.add('nestboard-note-preview');

  if (isBlankNote(md)) {
    el.dataset.placeholder = 'true';
    el.textContent = t('card.note.empty');
    return;
  }

  delete el.dataset.placeholder;
  // 渲染是**异步**的（内嵌笔记/图片要等加载）。期间卡片可能已被回收复用，
  // 由视图注入的 `renderMarkdown` 负责丢弃过期结果 —— 本文件不碰 DOM 生命周期。
  void ctx.renderMarkdown(md, el);
}

/**
 * 便签的**编辑态**渲染：整块内容槽交给 `MiniMarkdownEditor`（`F5`，用户 2026-09-21：
 * 与文档节点——也就是引用卡——同款）。
 *
 * ★ 这里**没有标题那一格**（`O22` 的"标题框 + 正文框两格"已按上面那条口径收掉）：
 *   标题是卡面那一行的字，改它走 `BoardView.editCardTitle`（右键「编辑标题」，
 *   双击卡面标题行也走它）—— 与引用卡（`.md` 文档节点）完全同一条路。
 * ★ 所有入口（双击 / `⌘`+双击 / `Enter` / 右键「编辑内容」/ 快捷操作栏）都是这一条：
 *   `ctx.editEntry` 对便签不再有分支意义（它仍给待办卡那种"标题 + 正文两格"的类型用）。
 * ★ `submit` 可替换：同步便签（`cards/syncNote.ts`，T7.04）的正文要写回**整组**，
 *   于是它把自己的收口传进来。不给则退回单卡写回（`ctx.updateContent`）。
 */
export function renderNoteEditor(
  el: HTMLElement,
  md: string,
  ctx: CardRenderContext,
  submit?: (md: string) => void,
): void {
  el.classList.add('nestboard-note-edit');
  new MiniMarkdownEditor({
    host: el,
    value: md,
    onSubmit: (value) => (submit ? submit(value) : ctx.updateContent({ md: value })),
    onExit: () => ctx.setMode('display'),
    // 截图直接粘进正文（`F5`）：落盘规则由视图给，卡片只转交
    pasteImage: ctx.pasteImage,
    suggestLinks: ctx.suggestLinks,
  }).focus();
}
