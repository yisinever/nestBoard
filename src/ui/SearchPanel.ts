/**
 * 白板内搜索面板（T2.09 / T2.10 / `F8-01` / `F8-02`）。
 *
 * 交互照**浏览器查找栏**来，而不是"弹个列表让用户点"：
 *
 *   ⌘F 打开 → 边打边搜，第一个结果立刻飞到视野中心并高亮
 *   Enter / ⌘G → 看下一处（列表同步滚动）
 *   ↑ / ↓ → 手动挪光标，同样立刻飞过去
 *   Esc → 关闭（`Modal` 自带的语义）
 *
 * ★ 为什么不是 `SuggestModal`：它把"输入 → 过滤 → 选择 → 关闭"绑成了一条流水线，
 *   而我们这里**不能关闭** —— 用户要一边看着白板一边逐个比对结果。硬套的话得靠
 *   反射去改它的内部状态（`suggestions` / `selectedItem` 都不是公开 API），
 *   Obsidian 一升级就会碎。
 *
 * ★ 面板本身**不认识白板**：它只拿着 `board()` 这个取快照的函数与 `onPick` 回调。
 *   搜索算法在 `model/search.ts`（纯函数、可单测），"飞过去 + 高亮"在视图层
 *   （只有视图知道视口与渲染层）。面板只管"输入与列表"。
 */

import { Modal, type App } from 'obsidian';
import { searchBoard, type SearchHit } from '../model/search';
import type { BoardFile } from '../model/schema';
import { t } from '../util/i18n';
import type { MessageKey } from '../util/i18n';

export interface SearchPanelOptions {
  /**
   * 取**当前**白板快照。
   *
   * ★ 做成函数而不是构造时传一份：面板开着的过程中用户可能撤销、删卡、
   *   甚至切到别的白板 —— 每次查询都重新取，结果才不会停留在打开那一刻的快照上。
   */
  board(): BoardFile | null;
  /** 选中第 `index` 条结果（视图负责飞到卡片并高亮） */
  onPick(hit: SearchHit, index: number): void;
  /**
   * 面板关闭。
   *
   * ★ 把"最后搜的词 + 光标"**一起交出去**，而不是让视图自己回头来读：
   *   `onClose` 一触发本对象就开始清空字段，视图再去问 `query` 只会拿到空串 ——
   *   ⌘G 于是永远跳不动（`T2.10`）。
   */
  onClose(state: { query: string; index: number }): void;
  /**
   * 预填的查询词与起始光标。
   *
   * ★ 给"面板关掉之后又按 ⌘G"用：用户按 Esc 只是想腾出视线，不是想忘掉刚搜的词，
   *   重新打开时把词和进度都还给他，才是"继续找"的语义（T2.10）。
   */
  initialQuery?: string;
  initialCursor?: number;
}

export class SearchPanel extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private hits: readonly SearchHit[] = [];
  /** 当前光标位置；`-1` = 还没有选中任何一条 */
  private cursor = -1;

  constructor(
    app: App,
    private readonly options: SearchPanelOptions,
  ) {
    super(app);
  }

  /** 面板里现在输入的词（视图要拿它记住"上次搜了什么"） */
  get query(): string {
    return this.inputEl?.value ?? '';
  }

  /** 当前光标（同上，供 ⌘G 接着往下走） */
  get cursorIndex(): number {
    return this.cursor;
  }

  override onOpen(): void {
    this.modalEl.addClass('nestboard-search-panel');
    this.titleEl.setText(t('search.title'));

    const input = this.contentEl.createEl('input', {
      cls: 'nestboard-search-input',
      type: 'text',
      attr: {
        placeholder: t('search.placeholder'),
        spellcheck: 'false',
        autocomplete: 'off',
      },
    });
    this.inputEl = input;
    input.value = this.options.initialQuery ?? '';
    input.addEventListener('input', () => this.refresh());
    input.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.statusEl = this.contentEl.createDiv({ cls: 'nestboard-search-status' });
    this.listEl = this.contentEl.createDiv({ cls: 'nestboard-search-results' });

    this.refresh();
    // 复用上次的进度：`refresh()` 会先把光标放在第一条上，这里再挪到该去的地方
    this.moveTo(this.options.initialCursor ?? 0);

    // 自动聚焦，光标落在末尾：打开就能打字；⌘G 复用时用户想接着改词而不是重打
    // ★ 下一帧再聚焦：`open()` 之后 Modal 才被挂到 DOM 上，立刻 `focus()`
    //   有时会被随后插入的容器抢走（表现为"打开了但打字没反应"）
    const doc = this.modalEl.ownerDocument;
    doc.defaultView?.setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  }

  override onClose(): void {
    const state = this.snapshot();
    this.inputEl = null;
    this.listEl = null;
    this.statusEl = null;
    this.hits = [];
    this.cursor = -1;
    this.contentEl.empty();
    this.options.onClose(state);
  }

  /** ⌘G / Enter：看下一处（T2.10）。到底了从第一条重来 —— 这正是"转一圈"的直觉 */
  next(): void {
    if (this.hits.length === 0) return;
    this.focusAt((this.cursor + 1) % this.hits.length);
  }

  /** 关掉面板时把"最后搜的词 + 挪到哪了"交给视图（⌘G 在面板关闭后仍然可用） */
  snapshot(): { query: string; index: number } {
    return { query: this.query, index: this.cursor };
  }

  /** 直接定位到第 `index` 条（越界时绕回开头）。⌘G 复用上次进度时用 */
  moveTo(index: number): void {
    if (this.hits.length === 0) return;
    this.focusAt(((index % this.hits.length) + this.hits.length) % this.hits.length);
  }

  // ── 内部 ────────────────────────────────────────────────────

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (this.hits.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.focusAt((this.cursor + delta + this.hits.length) % this.hits.length);
      return;
    }
    if (event.key === 'Enter') {
      // 回车 = 看下一处。这里没有"提交"这回事：搜索是即时的，
      // 把回车留给"再看一个"比留给"确认当前项"有用得多（后者还要用户先按 Esc 才能继续看）
      event.preventDefault();
      this.next();
    }
  }

  private refresh(): void {
    const board = this.options.board();
    this.hits = board ? searchBoard(board, this.query) : [];
    this.cursor = -1;
    this.renderList();

    // 一有结果就飞过去（浏览器查找栏的体验）：用户不必"再按一次回车"
    // 才知道第一个结果在哪，也立刻看得出自己搜的词对不对
    if (this.hits.length > 0) this.focusAt(0);
  }

  private focusAt(index: number): void {
    const hit = this.hits[index];
    if (!hit) return;
    this.cursor = index;

    const items = this.listEl?.querySelectorAll<HTMLElement>('.nestboard-search-hit');
    items?.forEach((item, at) => {
      const current = at === index;
      item.classList.toggle('is-current', current);
      // 键盘一路按下去时光标会跑出可视区，`nearest` 只滚最小距离，不打断手感
      if (current) item.scrollIntoView({ block: 'nearest' });
    });

    this.options.onPick(hit, index);
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();

    if (this.hits.length === 0) {
      // 空输入与"搜不到"是两件事，文案必须分开：一个在说"怎么用"，一个在说"确实没有"
      this.statusEl?.setText(this.query.trim().length === 0 ? t('search.hint') : t('search.empty'));
      return;
    }
    this.statusEl?.setText(t('search.count', { count: this.hits.length }));

    const doc = list.ownerDocument;
    const fragment = doc.createDocumentFragment();
    this.hits.forEach((hit, index) => fragment.appendChild(this.renderHit(hit, index)));
    list.appendChild(fragment);
  }

  private renderHit(hit: SearchHit, index: number): HTMLElement {
    const doc = this.modalEl.ownerDocument;
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'nestboard-search-hit';

    const head = doc.createElement('div');
    head.className = 'nestboard-search-hit-head';

    const type = doc.createElement('span');
    type.className = 'nestboard-search-hit-type';
    type.textContent = t(`card.type.${hit.type}` as MessageKey);
    head.appendChild(type);

    if (hit.title.length > 0) {
      const title = doc.createElement('span');
      title.className = 'nestboard-search-hit-title';
      title.textContent = hit.title;
      head.appendChild(title);
    } else {
      // 没标题的卡（便签十有八九没标题）：至少说清楚命中的是哪个字段，
      // 否则用户看到的是一个只有类型名的空行
      const field = doc.createElement('span');
      field.className = 'nestboard-search-hit-field';
      field.textContent = t(`search.field.${hit.field}` as MessageKey);
      head.appendChild(field);
    }
    item.appendChild(head);

    // 片段：用真 `<mark>` 而不是自绘高亮 —— 它自带浏览器与主题的高亮样式，
    // 也自带无障碍语义（屏幕阅读器会读出"标出的内容"）
    const snippet = doc.createElement('div');
    snippet.className = 'nestboard-search-hit-snippet';
    const before = hit.snippet.slice(0, hit.matchStart);
    const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
    if (before.length > 0) snippet.appendChild(doc.createTextNode(before));
    const mark = doc.createElement('mark');
    mark.textContent = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
    snippet.appendChild(mark);
    if (after.length > 0) snippet.appendChild(doc.createTextNode(after));
    item.appendChild(snippet);

    // ★ 用 `pointerdown` 而不是 `click`：列表每次输入都会重建，`click` 要等
    //   "按下 + 抬起"完整走完，中间那一帧元素可能已经不在文档里，事件就丢了
    //   （表现为"点了某条结果没反应，得再点一次"）
    item.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.focusAt(index);
    });

    return item;
  }
}
