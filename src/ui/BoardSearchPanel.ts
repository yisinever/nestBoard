/**
 * 侧栏「跨白板搜索」（T7.02 / `F8-08`）。
 *
 * ## 它回答什么问题
 *
 * 白板内搜索（`⌘F`）只能搜**眼前这一块**。而"我明明在哪块板上写过这件事，
 * 是哪一块来着"恰恰发生在**没在看那块板**的时候 —— 用户手上没有任何一块板可以
 * 按 `⌘F`。这个侧栏把整个库当搜索范围。
 *
 * ## 为什么不复用 `ui/SearchPanel.ts`
 *
 * 那个面板是照**浏览器查找栏**做的：`⌘F` 打开、边打边搜、结果立刻飞到视野中心。
 * 它的每一条交互都建立在"有一块板在眼前"上（"飞过去"要有视口、"看下一处"要有
 * 画布）。跨板搜索的主场景恰好相反 —— 人不在任何白板上。硬套的话得给它加一条
 * "没有活动白板时改走另一套行为"的分支，那条分支会同时污染两个功能的代码。
 * **共用的是匹配规则**（`model/search.ts`）而不是面板。
 *
 * ## 结果为什么是排好序的平铺列表，而不是按白板分组
 *
 * 分组的直觉来自反链面板，但那里每一条命中的语义是"这块板提过它"，组本身就是主体。
 * 这里用户问的是"**哪一条**最接近我要找的"，而排序正是按"板名 → 标题 → 路径 →
 * 正文"分层的（见 `model/boardSearch.ts`）。按板分组会把这个顺序打散成"先按板排"，
 * 等于把最有用的信息扔掉。所以每条结果自己带着它属于哪块板。
 *
 * ## 一个刻意的性能取舍
 *
 * 查询**防抖 150ms**：跨板查询要遍历库里全部卡片，成本与库的大小成正比
 * （`02 §8.1` 那条"白板内搜索 10k 卡片 ≤ 200ms"是**单板**的验收线，跨板是它的 N 倍）。
 * 不防抖的话，连打五个字就是五次全库匹配，输入框的手感会肉眼可见地掉。
 */

import { ItemView, Platform, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_BOARD_SEARCH } from '../constants';
import { boardSearchStatus } from '../model/boardSearch';
import type { BoardMatch, BoardSearchHit } from '../model/boardSearch';
import { t } from '../util/i18n';
import type { MessageKey } from '../util/i18n';
import { debounce, type Debounced } from '../util/debounce';
import { openBoardView } from '../view/BoardViewHost';
import { boardSearchSignature, snippetParts, statusText } from './boardSearch';
import type NestboardPlugin from '../main';

/** 查询防抖窗口（ms）。取值理由见文件头"一个刻意的性能取舍" */
const BOARD_SEARCH_DEBOUNCE_MS = 150;

export class BoardSearchPanelView extends ItemView {
  private readonly plugin: NestboardPlugin;
  private query = '';

  /** 输入框与状态行**不参与重画**：光标住在输入框里，重建一次就丢一次 */
  private inputEl: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;

  private readonly scheduleRender: Debounced = debounce(
    () => this.render(),
    BOARD_SEARCH_DEBOUNCE_MS,
  );

  /**
   * 上一次画出来的内容指纹。
   *
   * ★ 必须有：索引**每扫完一片**就会广播一次，而扫描几十块板的过程中可能连着
   *   好几片都只带回来"结果没变"。无条件重画会让列表在启动时不停闪，
   *   用户刚滚动到的位置每两秒被弹回顶部一次。
   */
  private lastSignature = '';

  constructor(leaf: WorkspaceLeaf, plugin: NestboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_BOARD_SEARCH;
  }

  override getDisplayText(): string {
    return t('boardSearch.title');
  }

  override getIcon(): string {
    return 'search';
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass('nestboard-board-search');
    // 与 `BacklinkPanel` / `BoardListPanel` 同规矩：自己贴移动端标记，
    // 而不是去蹭宿主加在 `body` 上的 `.is-mobile`
    if (Platform.isMobile) this.contentEl.addClass('nestboard-is-mobile');

    this.buildChrome();
    // ★ 索引**懒启动**（`R4`：启动时读全库白板的 JSON 会把插件卡住）。
    //   这里刻意不是"打开插件就开始扫"，而是"用户真的打开这个侧栏才开始"
    this.plugin.boardSearch.ensure();
    this.render();

    // ★ 打开即聚焦输入框：用户是按"我要找东西"打开这个侧栏的，让他先点一下输入框
    //   才能开始打字，是白白多出来的一步（Obsidian 自己的搜索面板也是这么做的）
    this.inputEl?.focus();

    // 索引变化就重画：扫描每完成一片、每次保存、每次外部改动都会触发
    this.register(this.plugin.boardSearch.onChanged(() => this.render()));
  }

  override async onClose(): Promise<void> {
    // ★ 待触发的那次重画要先取消：`onClose` 之后 `contentEl` 已经被清空，
    //   延迟到达的回调会对着一个脱离文档的节点画图（画完也看不见，纯浪费）
    this.scheduleRender.cancel();
    this.contentEl.empty();
    this.inputEl = null;
    this.statusEl = null;
    this.bodyEl = null;
    this.lastSignature = '';
  }

  // ── 骨架（只建一次） ────────────────────────────────────────

  private buildChrome(): void {
    const toolbar = this.contentEl.createDiv({ cls: 'nestboard-board-search__toolbar' });

    const input = toolbar.createEl('input', {
      cls: 'nestboard-board-search__input',
      type: 'search',
    });
    input.setAttr('placeholder', t('boardSearch.placeholder'));
    input.setAttr('aria-label', t('boardSearch.placeholder'));
    input.value = this.query;
    // ★ 只重画**状态行与正文**，这个输入框自己不动 —— 否则每敲一个字光标都会丢
    input.addEventListener('input', () => {
      this.query = input.value;
      this.scheduleRender();
    });
    this.inputEl = input;

    this.statusEl = toolbar.createDiv({ cls: 'nestboard-board-search__status' });
    this.bodyEl = this.contentEl.createDiv({ cls: 'nestboard-board-search__body' });
  }

  // ── 重画 ────────────────────────────────────────────────────

  private render(): void {
    const body = this.bodyEl;
    if (!body) return;

    const index = this.plugin.boardSearch;
    const result = index.search(this.query);
    const status = boardSearchStatus(this.query, result, {
      ready: index.isReady,
      scanned: index.scannedBoards,
      indexed: index.indexedBoards,
    });

    const signature = boardSearchSignature(this.query, status, result.hits, result.boards);
    if (signature === this.lastSignature && body.childElementCount > 0) return;
    this.lastSignature = signature;

    this.statusEl?.setText(statusText(status));

    body.empty();
    if (status.kind === 'hint') return;

    this.renderBoards(body, result.boards);
    for (const hit of result.hits) body.appendChild(this.renderHit(hit));
  }

  /**
   * 板名命中的白板（`model/boardSearch.ts` 把它们与卡片命中分开了）。
   *
   * ★ 摆在卡片结果**之上**：用户敲"周报"时，最想确认的就是"我说的那块板在不在"，
   *   而这一组就是答案；把它放在几十条卡片结果下面，等于逼用户先滚过一整屏噪音。
   */
  private renderBoards(root: HTMLElement, boards: readonly BoardMatch[]): void {
    if (boards.length === 0) return;

    const section = root.createDiv({ cls: 'nestboard-board-search__boards' });
    section.createDiv({
      cls: 'nestboard-board-search__boards-head',
      text: t('boardSearch.boards.heading', { query: this.query.trim() }),
    });

    for (const board of boards) {
      const row = section.createEl('button', { cls: 'nestboard-board-search__board' });
      row.setAttr('aria-label', t('boardSearch.open.ariaLabel', { path: board.path }));

      const icon = row.createSpan({ cls: 'nestboard-board-search__board-icon' });
      setIcon(icon, 'layout-dashboard');

      const text = row.createDiv({ cls: 'nestboard-board-search__board-text' });
      text.createDiv({
        cls: 'nestboard-board-search__board-title',
        // 标题为空时显示路径：侧栏里一行只有图标和一个空字符串，用户会以为是坏数据
        text: board.title.length > 0 ? board.title : board.path,
      });
      text.createDiv({ cls: 'nestboard-board-search__board-path', text: board.path });

      row.addEventListener('click', () => {
        void this.openBoard(board.path);
      });
    }
  }

  private renderHit(hit: BoardSearchHit): HTMLElement {
    const doc = this.bodyEl?.ownerDocument ?? this.contentEl.ownerDocument;
    const row = doc.createElement('button');
    row.type = 'button';
    row.className = 'nestboard-board-search__hit';

    // 没标题的卡（便签十有八九没标题）至少说清楚命中的是哪个字段，
    // 否则用户看到的是一个只有类型名的空行 —— 而这一行同时也是读屏器唯一能读到的内容
    const hasTitle = hit.title.length > 0;
    const label = hasTitle ? hit.title : t(`search.field.${hit.field}` as MessageKey);

    row.setAttribute(
      'aria-label',
      t('boardSearch.open.ariaLabel', { path: `${hit.boardPath} · ${label}` }),
    );

    const head = doc.createElement('div');
    head.className = 'nestboard-board-search__hit-head';
    head.appendChild(
      labeled(doc, 'nestboard-board-search__hit-type', t(`card.type.${hit.type}` as MessageKey)),
    );
    head.appendChild(
      labeled(
        doc,
        hasTitle ? 'nestboard-board-search__hit-title' : 'nestboard-board-search__hit-field',
        label,
      ),
    );
    row.appendChild(head);

    // 片段：用真 `<mark>` 而不是自绘高亮 —— 它自带浏览器与主题的高亮样式，
    // 也自带无障碍语义（屏幕阅读器会读出"标出的内容"）
    const snippet = doc.createElement('div');
    snippet.className = 'nestboard-board-search__hit-snippet';
    const parts = snippetParts(hit.snippet, hit.matchStart, hit.matchLength);
    if (parts.before.length > 0) snippet.appendChild(doc.createTextNode(parts.before));
    const mark = doc.createElement('mark');
    // 用 `textContent` 而不是 `innerHTML`：片段来自用户的白板内容，走 HTML 解析
    // 就等于把卡片里写的 `<img onerror=...>` 搬进侧栏执行
    mark.textContent = parts.match;
    snippet.appendChild(mark);
    if (parts.after.length > 0) snippet.appendChild(doc.createTextNode(parts.after));
    row.appendChild(snippet);

    row.appendChild(
      labeled(
        doc,
        'nestboard-board-search__hit-board',
        hit.boardTitle.length > 0 ? hit.boardTitle : hit.boardPath,
      ),
    );

    row.addEventListener('click', () => {
      void this.openBoard(hit.boardPath, hit.cardId);
    });

    return row;
  }

  // ── 动作 ────────────────────────────────────────────────────

  /**
   * 打开白板；给了 `cardId` 就一并定位过去。
   *
   * ★ `revealCardById` 自己会处理"视图刚创建、内容还没加载完"的时序
   *   （见 `view/BoardView.ts` 里那个方法的注释），这里不必轮询等待。
   */
  private async openBoard(path: string, cardId?: string): Promise<void> {
    const view = await openBoardView(this.app, path);
    if (view && cardId !== undefined) view.revealCardById(cardId);
  }
}

/**
 * 打开（或聚焦）跨白板搜索侧栏。
 *
 * 三段式与 `openBoardView` / `openBoardListPanel` 同规矩：先找已有 leaf 复用 →
 * 没有才 `getRightLeaf` → `setViewState` → `revealLeaf`。漏掉 `revealLeaf`
 * 就是"视图建好了但不显示"。
 */
export async function openBoardSearchPanel(plugin: NestboardPlugin): Promise<void> {
  const app = plugin.app;
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_BOARD_SEARCH)[0];
  if (existing) {
    await app.workspace.revealLeaf(existing);
    return;
  }

  // `false` = 不新建分栏；用户把右栏关到没有时它会给一个
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: VIEW_TYPE_BOARD_SEARCH, active: true });
  await app.workspace.revealLeaf(leaf);
}

// ── 内部 ──────────────────────────────────────────────────────

/** 建一个带类名的 `<span>`（行的三处小标签结构一模一样，抽出来免得三份各漂各的） */
function labeled(doc: Document, className: string, text: string): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}
