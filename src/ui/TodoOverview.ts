/**
 * 白板级「全部未完成待办」浮层（T3.03 / `F2.5`）。
 *
 * 存在的理由只有一个：待办一旦散在十几张卡里，"还剩什么没做"这个问题在板上
 * 是**看不出来**的 —— 得一张张翻过去。这个浮层把它拍平成一张清单。
 *
 * 三条设计约束：
 *
 *  * **不做 `Modal`**：用户要一边看浮层一边对照白板（点一条就飞过去、勾一条就划掉）。
 *    `Modal` 会把白板整个挡住，那是"弹窗"不是"浮层"—— 对比 `SearchPanel` 的取舍：
 *    那个面板的使命是"逐个比对结果"，所以它必须抢焦点；这个的使命是"陪着看"。
 *  * **不进画布**：与面包屑 / 性能提示同理，挂在视图根节点、活在屏幕坐标系里 ——
 *    塞进 `.nestboard-world` 会跟着缩放，30% 时文字只有几个像素高。
 *  * **不认识白板文件**：数据由 `board()` 现取、动作靠回调注入（与 `Breadcrumb` 一致），
 *    所以它在 node 下能单测，也不会因为白板模型变化而重写。
 */

import { splitTodoIndent } from '../cards/todo';
import { collectOpenTodos, type OpenTodoEntry } from '../model/todos';
import type { BoardFile } from '../model/schema';
import { t } from '../util/i18n';

export interface TodoOverviewOptions {
  /**
   * 取**当前**白板快照。
   *
   * ★ 做成函数而不是构造时传一份：浮层开着的过程中用户可能勾掉一条、撤销、
   *   甚至切到别的白板 —— 每次重画都重新取，清单才不会停留在打开那一刻。
   */
  board(): BoardFile | null;
  /**
   * 能不能直接勾掉。
   *
   * ★ 只读板上返回 `false`，浮层把复选框**禁用**掉 —— 而不是"看起来能点、
   *   点了没反应"。那正是"我勾了但它没保存"这种不信任感的来源。
   */
  canToggle(): boolean;
  /** 点了某一条：视图负责把视口挪过去并高亮（浮层不碰视口） */
  onPick(entry: OpenTodoEntry): void;
  /** 勾掉了某一条：视图负责写回模型 */
  onToggle(entry: OpenTodoEntry): void;
}

export class TodoOverview {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private visible = false;

  constructor(
    parent: HTMLElement,
    private readonly options: TodoOverviewOptions,
  ) {
    // ★ 从父节点取 `ownerDocument` 而不是用全局 `document`：视图可能被挂到一个
    //   独立窗口（弹出窗口 / 移动端分屏），全局 `document` 永远是主窗口那个 ——
    //   跨窗口建元素会直接抛错（与 `Breadcrumb` 同理）
    this.doc = parent.ownerDocument;
    this.root = this.doc.createElement('aside');
    this.root.className = 'nestboard-todo-overview';
    // ★ 用 `classList.add` 而不是把 `is-hidden` 拼进 `className`：显隐是后续反复
    //   增删的状态，走同一套 class API 才不会出现"字符串与 class 列表各说各话"
    this.root.classList.add('is-hidden');
    this.root.setAttribute('aria-label', t('todoOverview.title'));
    parent.appendChild(this.root);

    const head = this.doc.createElement('header');
    head.className = 'nestboard-todo-overview-head';

    const title = this.doc.createElement('span');
    title.className = 'nestboard-todo-overview-title';
    title.textContent = t('todoOverview.title');

    // 计数徽标常驻：清单很长时它是"还有多少"的唯一即时答案（列表本身要滚）
    this.countEl = this.doc.createElement('span');
    this.countEl.className = 'nestboard-todo-overview-count';

    const close = this.doc.createElement('button');
    close.type = 'button';
    close.className = 'nestboard-todo-overview-close';
    close.textContent = '×';
    close.setAttribute('aria-label', t('todoOverview.close'));
    close.addEventListener('click', () => this.close());

    head.appendChild(title);
    head.appendChild(this.countEl);
    head.appendChild(close);

    this.listEl = this.doc.createElement('div');
    this.listEl.className = 'nestboard-todo-overview-list';

    this.root.appendChild(head);
    this.root.appendChild(this.listEl);

    // Esc 关掉：点过浮层里的按钮之后焦点就在它身上，画布的 Esc 管不到这里
    this.root.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key !== 'Escape') return;
      event.preventDefault();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.visible;
  }

  show(): void {
    this.visible = true;
    this.root.classList.remove('is-hidden');
    this.refresh();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('is-hidden');
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.show();
  }

  /** 重画（内容变化 / 切换白板时调用）。**幂等**：可以反复调，不会累积 DOM */
  refresh(): void {
    const board = this.options.board();
    const entries = board ? collectOpenTodos(board) : [];
    this.countEl.textContent = String(entries.length);

    // ★ 一次 `replaceChildren` 而不是"逐行 append + 先清空"：后者会在清空与重建
    //   之间留下一帧空列表，用户看到的是"清单闪了一下"
    this.listEl.replaceChildren();

    if (entries.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'nestboard-todo-overview-empty';
      empty.textContent = t('todoOverview.empty');
      this.listEl.appendChild(empty);
      return;
    }

    const canToggle = this.options.canToggle();
    for (const entry of entries) this.listEl.appendChild(this.renderRow(entry, canToggle));
  }

  dispose(): void {
    this.root.remove();
  }

  // ── 内部 ────────────────────────────────────────────────────

  private renderRow(entry: OpenTodoEntry, canToggle: boolean): HTMLElement {
    const row = this.doc.createElement('div');
    row.className = 'nestboard-todo-overview-row';

    const box = this.doc.createElement('input');
    box.type = 'checkbox';
    box.className = 'nestboard-todo-overview-check';
    box.checked = false;
    box.disabled = !canToggle;
    // ★ 勾选是"改模型"，不是"改这一格的显示"：视觉一律由随后的重画决定。
    //   不 `preventDefault` 的话浏览器会先把框打上勾，重画又把它抹掉 —— 闪一下，
    //   而且中途撤销 / 写入失败时那个勾会留在屏幕上骗人（与卡片内勾选同一条原则）
    box.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.options.onToggle(entry);
    });

    const text = this.doc.createElement('button');
    text.type = 'button';
    text.className = 'nestboard-todo-overview-text';
    // 只画正文、不画缩进：扁平聚合列表里上一条可能来自别的卡，
    // 对着一条"无所依附"的子项缩进反而误导（存储格式见 `cards/todo.ts`）
    const body = splitTodoIndent(entry.text).body;
    text.textContent = body.length > 0 ? body : t('card.todo.item');
    text.addEventListener('click', () => this.options.onPick(entry));

    // 来源卡片的标题。没有标题的待办卡（新建后直接开写的情况很常见）用类型名兜底，
    // 否则这一列会是空白 —— 用户就不知道 这条是从哪冒出来的
    const source = this.doc.createElement('span');
    source.className = 'nestboard-todo-overview-source';
    const label = entry.cardTitle.trim();
    source.textContent = label.length > 0 ? label : t('card.type.todo');
    source.title = source.textContent;

    row.appendChild(box);
    row.appendChild(text);
    row.appendChild(source);
    return row;
  }
}
