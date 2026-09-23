/**
 * 待办卡（T3.01 / T3.02，`F2.6`）—— 与标准 Markdown 任务语法 `- [ ]` **完全互换**。
 *
 * ── 两种呈现（`02 §3` 的显示态 / 编辑态） ────────────────────
 *
 * | 模式 | 渲染 | 交互 |
 * |---|---|---|
 * | `display` | 自绘勾选列表（点复选框改模型） | 勾选 / 折叠已完成 |
 * | `edit` | `MiniMarkdownEditor`（源码） | `Enter` 新建、`Tab` 缩进、`Esc` 退出 |
 *
 * ★ **显示态刻意自绘**，不交给 `renderMarkdown`：Obsidian 渲染出的任务复选框
 *   是"往源文件写任务"的语义，而本卡的正文根本不在 `.md` 里 —— 交给它要么点不动，
 *   要么把白板文件改花。自绘的那一版还能精确控制"完成置灰删除线"（`F2.6`）。
 *
 * ── 缩进落在哪（`Tab` 缩进的技术选择） ──────────────────────
 *
 * `TodoItem` 是 `03 §2.7` 定稿的 `{ text, done }`，**没有** `depth` 字段。为了让
 * "缩进 → 存盘 → 重开"不丢层级，缩进被编码进 `text` 的**前导空白**里：
 * `  - [ ] 子项` 这一行解析为 `{ text: '  子项', done: false }`。
 * 于是 Markdown 往返是**恒等**的，显示层级由 {@link todoDepth} 从同一份空白里推出来。
 *
 * ★ 不 import `obsidian`：DOM 全用 `ownerDocument.createElement`（与 `boardRef.ts`
 *   同一取舍），i18n 走 `util/i18n`，因此本文件的解析与渲染判定可在 node 下直接单测。
 */

import type { TodoContent, TodoItem } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import { MiniMarkdownEditor } from '../editor/MiniMarkdownEditor';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 新建待办卡的默认尺寸：约 8 行清单，够写一份当日待办 */
export const TODO_DEFAULT_SIZE: Size = { width: 280, height: 220 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（否则污染复用池节点） */
const TODO_CLASSES = [
  'nestboard-todo',
  'nestboard-todo-preview',
  'nestboard-todo-edit',
  'is-empty',
] as const;

/** 最多承认 6 级缩进：再深既看不出层级，也会把正文挤没 */
export const MAX_TODO_DEPTH = 6;

const INDENT_RE = /^[ \t]*/;
/** 任务行：`- [ ] 文本` / `* [x] 文本`；复选框后可以没有正文（空项） */
const TASK_LINE_RE = /^([ \t]*)[-*+][ \t]+\[([ xX])\](?:[ \t](.*))?$/;
/** 普通无序列表行：`- 文本`。Markdown 里 `- ` 与 `- [ ] ` 只差一个复选框，一样收进来 */
const BULLET_LINE_RE = /^([ \t]*)[-*+][ \t]+(.*)$/;
/** 首行标题：`# 标题`（`#标题` 在 CommonMark 里是正文，故要求 `#` 后有空白） */
const HEADING_LINE_RE = /^#{1,6}[ \t]+(.*)$/;

// ─────────────────────────────────────────────────────────────
// 纯逻辑（可单测）
// ─────────────────────────────────────────────────────────────

/** 把 `text` 拆成"前导空白"与"正文"。前导空白就是缩进（见文件头说明） */
export function splitTodoIndent(text: string): { indent: string; body: string } {
  const indent = INDENT_RE.exec(text)?.[0] ?? '';
  return { indent, body: text.slice(indent.length) };
}

/** 层级（0 起）：每 2 个空格（或 1 个 Tab）算一级，封顶 {@link MAX_TODO_DEPTH} */
export function todoDepth(text: string): number {
  let spaces = 0;
  for (const ch of splitTodoIndent(text).indent) spaces += ch === '\t' ? 2 : 1;
  return Math.min(MAX_TODO_DEPTH, Math.floor(spaces / 2));
}

/** 已完成项数（显示态的"N 项"与折叠开关都用它） */
export function countTodoDone(items: readonly TodoItem[]): number {
  let count = 0;
  for (const item of items) if (item.done) count += 1;
  return count;
}

/** 取反第 `index` 项；下标越界时原样返回（渲染与点击之间隔着一次重绘，不能假设还同步） */
export function toggleTodoItem(items: readonly TodoItem[], index: number): TodoItem[] {
  return items.map((item, i) => (i === index ? { text: item.text, done: !item.done } : item));
}

/**
 * 两份待办项是否一模一样（O02 的提交路径要用）。
 *
 * `text` 里含缩进、`done` 是布尔，逐字段比就够了 —— 比的是**内容**，
 * 而编辑态的清单每次解析都会新造一个数组（引用比较永远不等，那样"点进点出"也会标脏）。
 */
export function sameTodoItems(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.text === b[i].text && item.done === b[i].done);
}

/**
 * `TodoContent` → 标准 Markdown 任务语法（T3.02）。
 *
 * 有标题时输出 `# 标题` + 一个空行，与 {@link markdownToTodo} 互为反函数
 * （在"标题里没有多余空白、正文不含裸行"的正规输入下往返恒等）。
 */
export function todoToMarkdown(content: TodoContent): string {
  const lines: string[] = [];
  const title = content.title.trim();
  if (title.length > 0) lines.push(`# ${title}`, '');
  for (const item of content.items) {
    const { indent, body } = splitTodoIndent(item.text);
    lines.push(`${indent}- [${item.done ? 'x' : ' '}] ${body}`);
  }
  return lines.join('\n');
}

/**
 * 标准 Markdown → `TodoContent`（T3.02）。
 *
 * 比 `todoToMarkdown` 宽容：用户在编辑态手打的东西**一律不许丢**，所以
 *
 * * 任务行 `- [ ] x` / `- [x] x` → 带勾选态（缩进保留在 `text` 里）；
 * * 普通列表行 `- x` → 未勾选项（标记剥掉，缩进保留）；
 * * 其余非空行 → 未勾选项（原样收下 —— 只想列几行字的人不该被迫先打 `- `）；
 * * 空行 → 跳过；首个非空行若是 `# 标题` → 记为 `title`，不作为待办项。
 */
export function markdownToTodo(markdown: string): TodoContent {
  const items: TodoItem[] = [];
  let title = '';
  let firstLine = true;

  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/[ \t]+$/, '');
    if (line.trim().length === 0) continue;

    if (firstLine) {
      firstLine = false;
      const heading = HEADING_LINE_RE.exec(line.trimStart());
      // 只有**首行**能当标题：正文中间偶尔写的 `# xxx` 是内容，不是标题
      if (heading) {
        title = heading[1].trim();
        continue;
      }
    }

    const task = TASK_LINE_RE.exec(line);
    if (task) {
      items.push({ text: task[1] + (task[3] ?? ''), done: task[2].toLowerCase() === 'x' });
      continue;
    }

    const bullet = BULLET_LINE_RE.exec(line);
    if (bullet) {
      items.push({ text: bullet[1] + bullet[2], done: false });
      continue;
    }

    items.push({ text: line, done: false });
  }

  return { title, items };
}

// ─────────────────────────────────────────────────────────────
// "已完成"折叠状态（界面瞬态，不落盘）
// ─────────────────────────────────────────────────────────────

/**
 * `TodoContent` 是定稿形状，没有"是否展开已完成"这一位 —— 而它必须活过
 * "勾一下 → 内容指纹变了 → 整个槽位重画"这一轮。于是按卡片 id 存在模块级集合里：
 * 刷新后回到默认（展开），这正是"看一眼的偏好"该有的寿命。
 */
const collapsedCompleted = new Set<string>();

export function isCompletedCollapsed(cardId: string): boolean {
  return collapsedCompleted.has(cardId);
}

export function setCompletedCollapsed(cardId: string, collapsed: boolean): void {
  if (collapsed) collapsedCompleted.add(cardId);
  else collapsedCompleted.delete(cardId);
}

// ─────────────────────────────────────────────────────────────
// 卡片定义
// ─────────────────────────────────────────────────────────────

export const todoCard: CardTypeDefinition<'todo'> = {
  type: 'todo',

  get displayName(): string {
    return t('card.type.todo');
  },

  icon: 'check-square',
  defaultSize: TODO_DEFAULT_SIZE,

  createDefaultContent(): TodoContent {
    return { title: '', items: [] };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-todo');
    el.classList.remove('nestboard-todo-preview', 'nestboard-todo-edit', 'is-empty');
    delete el.dataset.placeholder;

    if (ctx.mode === 'edit') renderEditor(el, card.content, ctx);
    else renderPreview(el, card.id, card.content, ctx);
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...TODO_CLASSES);
    delete el.dataset.placeholder;
    el.replaceChildren();
  },

  toMarkdown(card): string {
    return todoToMarkdown(card.content);
  },
};

function renderPreview(
  el: HTMLElement,
  cardId: string,
  content: TodoContent,
  ctx: CardRenderContext,
): void {
  el.classList.add('nestboard-todo-preview');
  const doc = el.ownerDocument;
  const nodes: Node[] = [];

  const title = content.title.trim();
  if (title.length > 0) {
    const heading = doc.createElement('div');
    heading.className = 'nestboard-todo-title';
    heading.textContent = title;
    nodes.push(heading);
  }

  if (content.items.length === 0) {
    el.classList.add('is-empty');
    el.dataset.placeholder = 'true';
    const empty = doc.createElement('div');
    empty.className = 'nestboard-todo-empty';
    empty.textContent = t('card.todo.empty');
    nodes.push(empty);
    el.replaceChildren(...nodes);
    return;
  }

  const list = doc.createElement('div');
  list.className = 'nestboard-todo-list';
  content.items.forEach((item, index) => {
    list.appendChild(buildRow(doc, item, index, content.items, ctx));
  });
  nodes.push(list);

  const doneCount = countTodoDone(content.items);
  if (doneCount > 0) {
    const collapsed = isCompletedCollapsed(cardId);
    if (collapsed) list.classList.add('is-hide-done');
    nodes.push(buildCompletedToggle(doc, cardId, list, doneCount, collapsed));
  }

  el.replaceChildren(...nodes);
}

/** 一行待办：复选框 + 正文。点复选框改模型，正文区域仍可拖整张卡 */
function buildRow(
  doc: Document,
  item: TodoItem,
  index: number,
  items: readonly TodoItem[],
  ctx: CardRenderContext,
): HTMLElement {
  const row = doc.createElement('div');
  row.className = 'nestboard-todo-item';
  if (item.done) row.classList.add('is-done');
  row.style.setProperty('--nestboard-todo-depth', String(todoDepth(item.text)));

  const { body } = splitTodoIndent(item.text);

  const box = doc.createElement('input');
  box.type = 'checkbox';
  box.className = 'nestboard-todo-check';
  box.checked = item.done;
  box.setAttribute('aria-label', body.length > 0 ? body : t('card.todo.item'));
  // 只让复选框吃掉指针：正文区域的按下照常冒泡给画布（拖动 / 框选）
  box.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  box.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    // ★ 不让浏览器先改视觉：勾选与否一律由"模型变了 → 重画"决定。
    //   只读板上 `updateContent` 直接返回，勾选于是不会假装生效。
    event.preventDefault();
    ctx.updateContent({ items: toggleTodoItem(items, index) });
  });

  const text = doc.createElement('span');
  text.className = 'nestboard-todo-text';
  text.textContent = body;

  row.appendChild(box);
  row.appendChild(text);
  return row;
}

/** "已完成 N 项"折叠开关：点击只切 CSS 类，不写模型（纯显示偏好） */
function buildCompletedToggle(
  doc: Document,
  cardId: string,
  list: HTMLElement,
  doneCount: number,
  collapsed: boolean,
): HTMLElement {
  const toggle = doc.createElement('div');
  toggle.className = 'nestboard-todo-completed';
  toggle.setAttribute('role', 'button');
  toggle.setAttribute('tabindex', '0');
  if (collapsed) toggle.classList.add('is-collapsed');

  const chevron = doc.createElement('span');
  chevron.className = 'nestboard-todo-completed-chevron';

  const label = doc.createElement('span');
  label.className = 'nestboard-todo-completed-label';
  label.textContent = t('card.todo.completed', { count: doneCount });

  toggle.appendChild(chevron);
  toggle.appendChild(label);

  let state = collapsed;
  const apply = (next: boolean): void => {
    setCompletedCollapsed(cardId, next);
    if (next) list.classList.add('is-hide-done');
    else list.classList.remove('is-hide-done');
    if (next) toggle.classList.add('is-collapsed');
    else toggle.classList.remove('is-collapsed');
  };

  toggle.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  toggle.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    state = !state;
    apply(state);
  });
  toggle.addEventListener('keydown', (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    state = !state;
    apply(state);
  });

  return toggle;
}

/**
 * 编辑态（O02）。
 *
 * 默认是**两格**：上面一个标题输入框，下面一块清单编辑器（`MiniMarkdownEditor`）。
 * `ctx.editEntry === 'raw'`（`⌘`+双击 / `⌘`+Enter / 右键「编辑内容」）时仍是老样子：
 * 整份源码（`# 标题` + `- [ ] 项`）进一块 textarea。
 *
 * ── 为什么要有"标题框"这一格 ──────────────────────────────
 *
 * `TodoContent.title` 是模型里的一等字段，`# 标题` 只是它的**序列化形式**。
 * 让用户用 `#` 去改一个字段，等于把序列化格式当成了编辑界面：手滑删掉那个 `#`，
 * 标题就变成一条待办项（`markdownToTodo` 只认首行的 `# xx` 为标题）。
 *
 * 复用便签卡的 `MiniMarkdownEditor`（T1.33）—— 它已经带了本卡要的全部快捷输入：
 * `[ ] ` → `- [ ] `、`Enter` 续行、`Tab` 缩进（见该文件头部的能力表）。
 */
function renderEditor(el: HTMLElement, content: TodoContent, ctx: CardRenderContext): void {
  el.classList.add('nestboard-todo-edit');

  if (ctx.editEntry === 'raw') {
    new MiniMarkdownEditor({
      host: el,
      value: todoToMarkdown(content),
      onSubmit: (value) => ctx.updateContent(markdownToTodo(value)),
      onExit: () => ctx.setMode('display'),
      pasteImage: ctx.pasteImage,
      suggestLinks: ctx.suggestLinks,
    }).focus();
    return;
  }

  renderSplitEditor(el, content, ctx);
}

/**
 * 分栏编辑态：标题框 + 清单编辑器（O02）。
 *
 * ── 两格怎么收口 ──────────────────────────────────────────
 *
 * 两格各自回填自己的字段，但**整次编辑只落一次盘**：`updateContent` 的既有约定是
 * "写入内容 = 这次编辑的终点"（`BoardView.updateCardContent` 会顺手清掉编辑态），
 * 所以"敲完标题按 `Enter` 去清单"这一步不能提交标题 —— 那会把清单一起拆掉。
 * 于是标题先在 DOM 里待着，等真正要结束时跟清单合并成**一次 patch**：
 *
 * | 收口 | 谁提交 | 备注 |
 * |---|---|---|
 * | 焦点离开卡片 | 富余的一方 | 两格都提，一次 patch |
 * | 清单里 `⌘Enter` / `Esc` | 清单编辑器 | `Esc` 的语义在编辑器里就是"提交"（`MiniMarkdownEditor` 文件头） |
 * | 标题框里 `Esc` | 只提清单 | `Esc` 放弃**这一格**，别处的字照旧收下 |
 * | 焦点在两格之间换 | 谁都不提 | `keepEditingOnBlur` 放行，内容原地留着 |
 *
 * ★ 标题的权威是**标题框**：用户在清单里按源码习惯手写的 `# 标题` 只在标题框空着时
 *   才接管（不然那行字会静静消失 —— 而它本来是"想改标题"的意思）。
 */
function renderSplitEditor(el: HTMLElement, content: TodoContent, ctx: CardRenderContext): void {
  const doc = el.ownerDocument;

  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'nestboard-todo-title-input';
  input.value = content.title;
  input.placeholder = t('card.title.placeholder');
  input.setAttribute('aria-label', t('card.title.placeholder'));

  const listHost = doc.createElement('div');
  listHost.className = 'nestboard-todo-list-edit';

  el.replaceChildren(input, listHost);

  const editor = new MiniMarkdownEditor({
    host: listHost,
    value: todoToMarkdown({ title: '', items: content.items }),
    // 清单那格提交时把标题一起带上：`Esc` / `⌘Enter` / 点走都只走这一次 patch
    onSubmit: () => commit(true),
    onExit: () => ctx.setMode('display'),
    // 焦点挪到同一张卡里的标题框 = 换了一格，不是离开（内容原地留着，见上面那张表）
    keepEditingOnBlur: (event) => staysInside(el, event.relatedTarget),
    pasteImage: ctx.pasteImage,
    suggestLinks: ctx.suggestLinks,
  });

  /**
   * 这次编辑是否已经落过盘。写进去就等于结束了，往后的 `blur` / `Esc` 不再写第二遍。
   *
   * ★ 不是多余的保险，是两处真实存在的情况：① 编辑器那格失焦提交之后，
   *   浏览器还可能给标题框补一个 `blur`（重绘把节点换掉的那一下）；
   *   ② 标题框按 `Esc` 之后焦点跑掉，同样会再走一次 `blur`。
   *   而第二次写**拦不住** —— `items` 是重新解析出来的新数组，
   *   `updateCardContent` 的逐字段比对按**引用**比，永远算"变了"：
   *   于是多一次 revision、多一步 `⌘Z`（按下去还是原内容）。
   */
  let written = false;

  /**
   * 落盘。`keepTitle` 为假表示"标题框里那点改动放弃"（标题框按 `Esc`）。
   *
   * ★ 只该被调用一次 —— 写进去就等于这次编辑结束了。
   */
  function commit(keepTitle: boolean): void {
    if (written) return;
    const parsed = markdownToTodo(editor.value);
    const title = keepTitle ? input.value.trim() || parsed.title.trim() : content.title;
    const items = parsed.items;
    // 逐项比对：`items` 是每次解析新造的数组，引用比较永远不等 ——
    // 不比对的话"点进点出"也会把文件标脏
    if (title === content.title && sameTodoItems(items, content.items)) return;
    written = true;
    ctx.updateContent({ title, items });
  }

  // 标题框是**单行输入框**，不是 Markdown 编辑器：`Enter` = "写完这一步，去下一格"
  input.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    // ★ 绝不能让它冒泡到画布：空格会被当成平移、`Delete` 会删掉这张卡
    event.stopPropagation();
    // 输入法组词中一律放行：中文输入法确认候选词用的就是 `Enter`，
    // 拦下来会变成"选字选到一半，光标跳到清单去了、候选词也没了"
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' || event.key === 'Tab') {
      // 与标题行输入框同一规矩（`CardLayer.editTitle`）：提交，然后进正文
      event.preventDefault();
      editor.focus();
      return;
    }
    if (event.key === 'Escape') {
      // 放弃的是**这一格**：清了它的改动，但清单那格照旧收下（用户没想丢那份字）
      event.preventDefault();
      input.value = content.title;
      commit(false);
      ctx.setMode('display');
    }
  });
  input.addEventListener('blur', (event: FocusEvent) => {
    // 失焦即落盘（与标题行输入框同一规矩）；只有焦点**离开这张卡**才算这次编辑结束
    commit(true);
    if (!staysInside(el, event.relatedTarget)) ctx.setMode('display');
  });

  // 光标先落在标题上：双击进来的第一步是"这张卡叫什么"（O02）。
  // ★ 只 focus 标题框，不碰清单那格 —— 这里同时调两个的话，`editor.focus()`
  //   排的是微任务、`input.focus()` 是即时的，谁都可能后落地
  input.focus();
  input.select();
}

/** 焦点是否仍落在这张卡的内容槽里（两格之间换 = 没走） */
function staysInside(el: HTMLElement, next: EventTarget | null): boolean {
  // 刻意不写 `instanceof Node`：node 单测环境里没有那个全局，
  // 而卡片定义要能在无 DOM 的 node 下直接跑到（见文件头）
  return next !== null && el.contains(next as Node);
}
