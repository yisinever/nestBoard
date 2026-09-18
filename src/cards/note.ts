/**
 * 便签卡（T1.32，`F2.1`）—— 内容**存在白板文件里**的内联卡片（`NoteContent.md`）。
 *
 * 两种呈现（`02 §3` 的显示态 / 编辑态）：
 *
 * | 模式 | 渲染 | 进入方式 |
 * |---|---|---|
 * | `display` | Obsidian Markdown 渲染（双链、标签、代码块、内嵌全都原生生效） | 默认 |
 * | `edit` | `MiniMarkdownEditor`（行首快捷输入 + 列表续行），`Esc` / `⌘Enter` / 失焦提交 | 双击卡片 |
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
    if (ctx.mode === 'edit') renderNoteEditor(el, card.title, card.content.md, ctx);
    else renderNotePreview(el, card.content.md, ctx);
  },

  /**
   * 节点被回收进复用池前的清理。
   * 这里删掉的每个 class，`render()` 里都加过一次 —— 漏一个，
   * 下一位租客（可能是图片卡）就会继承便签的样式。
   */
  destroy(el: HTMLElement): void {
    el.classList.remove(...NOTE_CLASSES);
    delete el.dataset.placeholder;
    // ★ 标题栏上的编辑残留也要收：输入框现在长在**标题栏**里（不在这个内容槽里），
    //   不清的话复用池的下一位租客会看到标题那一行被藏起来、还杵着一个输入框
    clearNoteTitleBand(el);
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
 * 便签的**编辑态**渲染（O22 重做：标题框 + 正文框两格，参考待办卡）。
 *
 * | 入口 | 编辑态 | 收口 |
 * |---|---|---|
 * | 双击 / `Enter`（`editEntry !== 'raw'`） | 上面标题框、下面正文编辑器 | 两格合并成**一次**写回 |
 * | `⌘`+双击 / 右键「编辑内容」（`'raw'`） | 只有正文编辑器（老样子） | 只写正文 |
 *
 * ★ `submit` 可替换：同步便签（`cards/syncNote.ts`，T7.04）提交时正文要写回**整组**，
 *   于是它把自己的收口传进来。不给则退回便签卡默认（`ctx.updateCard`，一次写回标题 + 正文）。
 */
export function renderNoteEditor(
  el: HTMLElement,
  title: string,
  md: string,
  ctx: CardRenderContext,
  submit?: (patch: { title?: string; md?: string }) => void,
): void {
  el.classList.add('nestboard-note-edit');

  // 收口：把"标题 + 正文"合并成一次写回（`ctx.updateCard`）——两格各自写会在第一笔
  // 之后触发重绘、把这次编辑还没结束的另一格现场丢掉（见 registry 的 `updateCard`）
  const write =
    submit ??
    ((patch: { title?: string; md?: string }) => {
      ctx.updateCard({
        title: patch.title,
        content: patch.md === undefined ? undefined : { md: patch.md },
      });
    });

  // `⌘`+双击 / 右键「编辑内容」：跳过标题，直接给正文（O01/O02）
  if (ctx.editEntry === 'raw') {
    new MiniMarkdownEditor({
      host: el,
      value: md,
      onSubmit: (value) => write({ md: value }),
      onExit: () => ctx.setMode('display'),
    }).focus();
    return;
  }

  renderNoteSplitEditor(el, title, md, ctx, write);
}

/**
 * 便签的**两格编辑态**（O22）：上面一个标题框，下面一块正文编辑器 —— 与待办卡
 * （`cards/todo.ts` 的 `renderSplitEditor`）同一套交互，标题与正文可以分别编辑。
 *
 * ── 两格怎么收口（同待办卡）────────────────────────────────
 *
 * 标题先在 DOM 里待着，等这次编辑真正结束时跟正文**合并成一次写回**（`write`）——
 * `ctx.updateCard` 的既有约定是"写入 = 这次编辑的终点"，所以"敲完标题按 `Enter`
 * 去正文"这一步不能提交标题（那会把正文那格一起拆掉）。
 *
 * | 收口 | 谁提交 |
 * |---|---|
 * | 焦点离开卡片 | 富余的一方（两格都提，一次写回） |
 * | 正文里 `⌘Enter` / `Esc` | 正文编辑器 |
 * | 标题框里 `Esc` | 只提正文（放弃的是**这一格**） |
 * | 焦点在两格之间换 | 谁都不提（`keepEditingOnBlur` 放行） |
 *
 * ★ 标题的权威是**标题框**：便签的标题是 `card.title`，正文里手写的 `# 标题`
 *   只是普通正文。
 */
function renderNoteSplitEditor(
  el: HTMLElement,
  title: string,
  md: string,
  ctx: CardRenderContext,
  write: (patch: { title?: string; md?: string }) => void,
): void {
  const doc = el.ownerDocument;

  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'nestboard-note-title-input';
  input.value = title;
  input.placeholder = t('card.title.placeholder');
  input.setAttribute('aria-label', t('card.title.placeholder'));

  const bodyHost = doc.createElement('div');
  bodyHost.className = 'nestboard-note-body-edit';

  /**
   * 标题框放哪 —— **优先放进标题栏**。
   *
   * ★ 用户 2026-09-16 反馈："编辑时，双击标题部分，输入框却在下方正文部分。"
   *   原先两格都塞在内容槽里、还把整条标题栏藏掉了（`.nestboard-card:has(…)` 那条），
   *   于是"改标题"看起来像"改正文" —— 连右键「编辑内容」（`raw`，只给正文）也显得在改标题。
   *   标题是那一行的字，输入框就该长在那一行上。
   * ★ 拿不到标题栏（单测里的裸元素、将来别的宿主）就退回老办法：两格摞在内容槽里 ——
   *   宁可位置不对，也不能出现两个输入框或一个都没有。
   */
  const band = titleBandOf(el);
  if (band) {
    band.classList.add('is-editing-note-title');
    band.appendChild(input);
    el.replaceChildren(bodyHost);
  } else {
    el.replaceChildren(input, bodyHost);
  }

  /** 把标题栏还给骨架（`CardLayer` 下一帧会把标题文字写回去） */
  const restoreBand = (): void => {
    if (!band) return;
    band.classList.remove('is-editing-note-title');
    input.remove();
  };

  /** 收工：先把标题栏还原，再回显示态（顺序反了的话骨架那一帧会看到残留的输入框） */
  const leave = (): void => {
    restoreBand();
    ctx.setMode('display');
  };

  const editor = new MiniMarkdownEditor({
    host: bodyHost,
    value: md,
    // 正文这格提交时把标题一起带上：`Esc` / `⌘Enter` / 点走都只走这一次写回
    onSubmit: () => commit(true),
    onExit: leave,
    // 焦点挪到同一张卡里的标题框 = 换了一格，不是离开（内容原地留着）
    keepEditingOnBlur: (event) => staysInside(el, event.relatedTarget),
  });

  /** 这次编辑是否已经落过盘。写进去就等于结束了，往后的 `blur` / `Esc` 不再写第二遍 */
  let written = false;

  function commit(keepTitle: boolean): void {
    if (written) return;
    const nextTitle = keepTitle ? input.value.trim() : title;
    const nextMd = editor.value;
    const titleChanged = keepTitle && nextTitle !== title;
    const mdChanged = nextMd !== md;
    if (!titleChanged && !mdChanged) return;
    written = true;
    write({
      title: titleChanged ? nextTitle : undefined,
      md: mdChanged ? nextMd : undefined,
    });
  }

  input.addEventListener('pointerdown', (event: Event) => {
    // 标题框**在标题栏里**，而标题栏也是卡片的一部分：不挡住这一下，
    // 画布会把它当成"按住卡片"的开始（进来选词却把卡拖走了）
    event.stopPropagation();
  });
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    // 绝不能让它冒泡到画布：空格会被当成平移、`Delete` 会删掉这张卡
    event.stopPropagation();
    // 输入法组词中一律放行：中文输入法确认候选词用的就是 `Enter`
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      editor.focus();
      return;
    }
    if (event.key === 'Escape') {
      // 放弃的是**这一格**：清了标题改动，正文那格照旧收下
      event.preventDefault();
      input.value = title;
      commit(false);
      leave();
    }
  });
  input.addEventListener('blur', (event: FocusEvent) => {
    // 失焦即落盘；只有焦点**离开这张卡**才算这次编辑结束
    commit(true);
    if (!staysInside(el, event.relatedTarget)) leave();
  });

  // 光标先落在标题上：双击进来的第一步是"这张卡叫什么"（与待办卡一致）
  input.focus();
  input.select();
}

/** 焦点是否仍落在这张卡的内容槽里（两格之间换 = 没走） */
function staysInside(el: HTMLElement, next: EventTarget | null): boolean {
  return next !== null && el.contains(next as Node);
}

/**
 * 便签的**标题栏**（`.nestboard-card-header`）；拿不到给 `null`。
 *
 * ★ 用可选调用（`closest?.` / `querySelector?.`）而不是直接调：单测里传进来的
 *   是**假 DOM 的裸元素**（没有 `closest` / `querySelector`），将来别的宿主也可能没有 ——
 *   拿不到就退回"两格摞在内容槽里"，不必让每个宿主都长出这两个方法。
 */
function titleBandOf(el: HTMLElement): HTMLElement | null {
  const card = el.closest?.('.nestboard-card');
  // ★ 不用 `instanceof HTMLElement` 收口：node 下的单测环境**没有这个全局**
  //   （会直接抛 `HTMLElement is not defined`），而 `querySelector` 给回来的本来就是
  //   `Element | null` —— 真值判断 + 断言就够了，还能顺手兼容假 DOM
  const band = card?.querySelector?.('.nestboard-card-header');
  return band ? (band as HTMLElement) : null;
}

/** 收掉标题栏上的编辑残留（输入框 + 那个 class）—— 节点回收时用 */
function clearNoteTitleBand(el: HTMLElement): void {
  const band = titleBandOf(el);
  if (!band) return;
  band.classList.remove('is-editing-note-title');
  band.querySelector('.nestboard-note-title-input')?.remove();
}
