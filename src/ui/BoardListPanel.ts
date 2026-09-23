/**
 * 侧栏「白板列表」（T5.08 / `F7-04`）。
 *
 * ## 它回答什么问题
 *
 * 白板一多，"我那块板呢"就成了第一个卡住人的问题：Obsidian 的文件浏览器只按目录排，
 * 而白板的组织方式往往**不是**目录 —— 同一批板可能散在几个目录里、按主题（标签）连在一起。
 * 这个侧栏给同一份白板三种看法：
 *
 * * **目录树** —— "我知道它在哪个文件夹"；
 * * **按最近打开** —— "我刚才还在看它"；
 * * **按标签** —— "那些 `#项目` 的板"。
 *
 * ## 为什么不是塞进文件浏览器
 *
 * Obsidian 没有公开 API 能往文件浏览器里插东西（与 `F7-04` 那条"塞进核心反链面板"
 * 是同一个限制，见 `integration/BacklinkPanel.ts` 的文件头）。所以做法一样：
 * 自己提供一个侧栏视图，用户摆在自己顺手的位置。
 *
 * ## 三个实现上的坑（都在下面代码里标了 ★）
 *
 * 1. **工具栏不参与重画**：筛选框如果每敲一个字就被重建，光标会当场丢失。
 * 2. **不是每次 `onChanged` 都要重画**：`BoardRegistry` 在白板每次自动保存时都会广播，
 *    而列表只依赖标题 / 路径 / 标签 —— 无条件重画会让"停下来看列表"这件事
 *    在别人编辑那块板时变成幻灯片。
 * 3. **折叠状态得自己记**：`<details>` 的展开态是 DOM 状态，重画一次就全丢了。
 */

import { ItemView, Platform, setIcon } from 'obsidian';
import type { ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_BOARD_LIST } from '../constants';
import { t } from '../util/i18n';
import { openBoardView } from '../view/BoardViewHost';
import {
  buildFolderTree,
  filterBoards,
  groupByTag,
  recentBoards,
  type BoardFolderNode,
  type BoardListItem,
  type BoardListView,
} from './boardList';
import type { BoardEntry } from '../io/BoardRegistry';
import type NestboardPlugin from '../main';

const VIEW_MODES: readonly BoardListView[] = ['folders', 'recent', 'tags'];

const MODE_ICONS: Record<BoardListView, string> = {
  folders: 'folder',
  recent: 'history',
  tags: 'tags',
};

const MODE_LABEL_KEYS = {
  folders: 'boardList.mode.folders',
  recent: 'boardList.mode.recent',
  tags: 'boardList.mode.tags',
} as const;

export class BoardListPanelView extends ItemView {
  private readonly plugin: NestboardPlugin;
  private mode: BoardListView = 'folders';
  private query = '';
  /** 用户折叠起来的目录路径。★ 必须自己记：`<details>` 的展开态活不过一次重画 */
  private readonly collapsedFolders = new Set<string>();

  /** 正文容器。工具栏**不参与重画**（见文件头第 1 条），所以这里只有正文 */
  private bodyEl: HTMLElement | null = null;
  private modeButtons: HTMLButtonElement[] = [];
  private filterInput: HTMLInputElement | null = null;

  /**
   * 上一次画出来的"内容指纹"。
   *
   * 见文件头第 2 条：`BoardRegistry` 在**每次自动保存**时都会广播，
   * 而列表只显示 `path` / `title` / `tags`。指纹里刻意**不放 `updatedAt`** ——
   * 放了的话，"旁边标签页里那朋友正在编辑的白板"会让这个列表每 400ms 重建一次，
   * 而屏幕上其实一个像素都不会变。
   */
  private lastSignature = '';

  constructor(leaf: WorkspaceLeaf, plugin: NestboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_BOARD_LIST;
  }

  override getDisplayText(): string {
    return t('boardList.title');
  }

  override getIcon(): string {
    return 'layout-list';
  }

  /**
   * 记住用户选的是哪种看法（Obsidian 会把它存进 `workspace.json`）。
   *
   * ★ **只存 `mode`，不存 `query`**：把筛选词一起恢复的话，用户下次打开侧栏
   *   会看见一个空列表，而"为什么一块板都没有"要盯着那个输入框才想得起来 ——
   *   一个被遗忘的筛选器比一个被遗忘的排序方式伤人得多。
   */
  override getState(): Record<string, unknown> {
    return { mode: this.mode };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const mode = (state as { mode?: unknown } | null)?.mode;
    if (typeof mode === 'string' && (VIEW_MODES as readonly string[]).includes(mode)) {
      this.mode = mode as BoardListView;
    }
    // `setState` 可能在 `onOpen` 之前到达（官方没承诺先后），所以这里只更新数据，
    // 画不画交给 `onOpen` —— 那边会先建工具栏再画一次
    this.syncChrome();
    this.refresh();
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass('nestboard-board-list');
    // 与 `BacklinkPanel` 同规矩：自己贴移动端标记，而不是蹭宿主加在 `body` 上的 `.is-mobile`
    if (Platform.isMobile) this.contentEl.addClass('nestboard-is-mobile');

    this.buildChrome();
    // ★ 必须补这一句：`setState` 虽然也会调 `syncChrome()`，但它跑在 `buildChrome` 之前
    //   （那时 `modeButtons` 还是空的）。漏掉的话，面板第一次打开时三个看法**一个都没高亮**，
    //   用户看不出"我现在看的是目录还是标签"
    this.syncChrome();
    this.refresh();

    // 索引变化就重画 —— 但由指纹决定"值不值得"，见 `lastSignature`
    this.register(this.plugin.registry.onChanged(() => this.refresh()));
    // ★ 链接 / 标签索引也要订阅（`F1` 追记）：卡内标签只活在 `LinkIndex` 里，
    //   不订阅的话"在卡片里写一个 `#标签`，侧栏标签那一档不更新"
    this.register(this.plugin.linkIndex.onChanged(() => this.refresh()));
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty();
    this.bodyEl = null;
    this.modeButtons = [];
    this.filterInput = null;
    this.lastSignature = '';
  }

  // ── 骨架（只建一次） ────────────────────────────────────────

  private buildChrome(): void {
    const toolbar = this.contentEl.createDiv({ cls: 'nestboard-board-list__toolbar' });

    const modes = toolbar.createDiv({ cls: 'nestboard-board-list__modes' });
    modes.setAttr('role', 'group');
    modes.setAttr('aria-label', t('boardList.modes.ariaLabel'));

    for (const mode of VIEW_MODES) {
      const label = t(MODE_LABEL_KEYS[mode]);
      const button = modes.createEl('button', { cls: 'nestboard-board-list__mode' });
      button.setAttr('aria-label', label);
      setIcon(button.createSpan({ cls: 'nestboard-board-list__mode-icon' }), MODE_ICONS[mode]);
      button.createSpan({ cls: 'nestboard-board-list__mode-label', text: label });
      button.addEventListener('click', () => {
        this.mode = mode;
        this.syncChrome();
        this.refresh();
      });
      this.modeButtons.push(button);
    }

    const filter = toolbar.createEl('input', {
      cls: 'nestboard-board-list__filter',
      type: 'search',
    });
    filter.setAttr('placeholder', t('boardList.filter.placeholder'));
    filter.setAttr('aria-label', t('boardList.filter.placeholder'));
    filter.value = this.query;
    // 只重画正文，不碰这个输入框本身 —— 否则每敲一个字光标都会丢（文件头第 1 条）
    filter.addEventListener('input', () => {
      this.query = filter.value;
      this.refresh();
    });
    this.filterInput = filter;

    this.bodyEl = this.contentEl.createDiv({ cls: 'nestboard-board-list__body' });
  }

  /** 把工具栏的"当前是什么状态"同步到 DOM（不改结构，所以不会动到光标） */
  private syncChrome(): void {
    if (this.filterInput && this.filterInput.value !== this.query)
      this.filterInput.value = this.query;
    VIEW_MODES.forEach((mode, index) => {
      const button = this.modeButtons[index];
      if (!button) return;
      const active = mode === this.mode;
      button.toggleClass('is-active', active);
      button.setAttr('aria-pressed', String(active));
    });
  }

  // ── 重画 ────────────────────────────────────────────────────

  private refresh(): void {
    const body = this.bodyEl;
    if (!body) return;

    const entries = this.plugin.registry.all();
    const query = this.query.trim();
    const visible = filterBoards(entries, query);
    const recent = this.plugin.settings.recentBoards;

    const signature = this.signatureOf(entries, recent, query);
    if (signature === this.lastSignature && body.childElementCount > 0) return;
    this.lastSignature = signature;

    body.empty();

    if (entries.length === 0) {
      body.createDiv({ cls: 'nestboard-board-list__empty', text: t('boardList.empty.none') });
      return;
    }

    // ★ 筛选命中为空时**不显示**目录树/标签组：一个空树只让人以为是坏了
    if (visible.length === 0) {
      body.createDiv({
        cls: 'nestboard-board-list__empty',
        text: t('boardList.empty.noMatch', { query }),
      });
      return;
    }

    switch (this.mode) {
      case 'folders':
        this.renderFolders(body, visible);
        return;
      case 'recent':
        this.renderRecent(body, visible, recent);
        return;
      case 'tags':
        this.renderTags(body, visible);
        return;
    }
  }

  /**
   * 内容指纹：路径 / 标题 / 标签 / 最近打开顺序 / 当前查询。
   *
   * ★ 用 `\u0000` 做字段分隔符（路径里不可能出现它），避免
   *   "`A` + `BC`" 与 "`AB` + `C`" 拼出同一个字符串这种经典误判。
   */
  private signatureOf(
    entries: readonly BoardEntry[],
    recent: readonly string[],
    query: string,
  ): string {
    const parts = entries.map((entry) => {
      const cardTags = this.mode === 'tags' ? this.cardTagKeysOf(entry.path).join('\u0001') : '';
      return `${entry.path}\u0000${entry.title}\u0000${entry.tags.join('\u0001')}\u0000${cardTags}`;
    });
    return [this.mode, query, recent.join('\u0001'), parts.join('\n')].join('\u0002');
  }

  // ── 三种看法 ────────────────────────────────────────────────

  private renderFolders(root: HTMLElement, entries: readonly BoardListItem[]): void {
    const tree = buildFolderTree(entries);
    // 目录在前、根目录下的板在后 —— 与文件浏览器的习惯一致
    this.renderFolderChildren(root, tree);
    for (const board of tree.boards) this.renderRow(root, board, false);
  }

  private renderFolderChildren(parent: HTMLElement, node: BoardFolderNode): void {
    for (const folder of node.folders) {
      const details = parent.createEl('details', { cls: 'nestboard-board-list__folder' });
      // 折叠状态来自我们自己的集合，而不是"上次渲染的 DOM 长什么样"
      if (!this.collapsedFolders.has(folder.path)) details.open = true;
      details.addEventListener('toggle', () => {
        if (details.open) this.collapsedFolders.delete(folder.path);
        else this.collapsedFolders.add(folder.path);
      });

      const summary = details.createEl('summary', { cls: 'nestboard-board-list__folder-head' });
      const icon = summary.createSpan({ cls: 'nestboard-board-list__folder-icon' });
      setIcon(icon, 'folder');
      summary.createSpan({ cls: 'nestboard-board-list__folder-name', text: folder.name });
      // 用 `title`（悬停提示）而不是 `aria-label`：后者会把无障碍名字整个换掉，
      // 而文件夹名本来就已经是它 —— 完整路径只对"同名目录"有用，那是鼠标的事
      summary.setAttr('title', folder.path);

      const body = details.createDiv({ cls: 'nestboard-board-list__folder-body' });
      this.renderFolderChildren(body, folder);
      // 目录树里路径是冗余的（目录名就在上一行的 `<summary>` 里）
      for (const board of folder.boards) this.renderRow(body, board, false);
    }
  }

  private renderRecent(
    root: HTMLElement,
    entries: readonly BoardListItem[],
    recent: readonly string[],
  ): void {
    // 已打开过的板里，筛出来的那些；顺序完全由"最近打开"决定
    const items = recentBoards(entries, recent);
    if (items.length === 0) {
      root.createDiv({ cls: 'nestboard-board-list__empty', text: t('boardList.empty.noRecent') });
      return;
    }
    for (const board of items) this.renderRow(root, board, true);
  }

  private renderTags(root: HTMLElement, entries: readonly BoardListItem[]): void {
    // ★ 标签来源是**两份的并集**（`F1` 追记）：白板级 `meta.tags` ∪ **卡内标签**
    //   —— 用户天天写的是后者，只看前者的话"在便签里写了一堆 #纪要 的板"会掉进
    //   "未加标签"，这一档就废了。
    for (const group of groupByTag(entries, (path) => this.cardTagKeysOf(path))) {
      root.createDiv({
        cls: 'nestboard-board-list__group-head',
        // `null` 是"没打标签"那一组；它显示成不带 `#` 的一句话，免得看起来像个叫"未加标签"的标签
        text: group.tag === null ? t('boardList.untagged') : `#${group.tag}`,
      });
      for (const board of group.boards) {
        this.renderRow(root, board, true);
        // 这个标签是在**哪张卡上**写的：列出来，点一下直接跳过去（`F1` 的"直接"那一半）
        if (group.tag !== null) this.renderTagHits(root, board, group.tag);
      }
    }
  }

  /** 一张卡上写过的标签（去重）—— 分组与指纹共用同一份来源 */
  private cardTagKeysOf(path: string): string[] {
    const keys = new Set<string>();
    for (const hit of this.plugin.linkIndex.tagHitsOf(path)) {
      const tag = hit.tag.trim();
      if (tag.length > 0) keys.add(tag);
    }
    return [...keys];
  }

  /**
   * 一个标签在某块板上**写在哪几张卡**。
   *
   * ★ 白板级 `meta.tags` 没有卡片可指（那是"这块板是什么"），所以这里通常为空 ——
   *   空则一个节点都不建（不留空壳）。
   */
  private renderTagHits(parent: HTMLElement, board: BoardListItem, tag: string): void {
    const hits = this.plugin.linkIndex
      .tagHitsOf(board.path)
      .filter((hit) => hit.tag.trim() === tag && hit.anchorId.length > 0);
    for (const hit of hits) {
      const item = parent.createEl('button', { cls: 'nestboard-board-list__tag-hit' });
      item.setAttr('aria-label', t('boardList.tagHit.ariaLabel', { board: board.path }));
      const icon = item.createSpan({ cls: 'nestboard-board-list__tag-hit-icon' });
      setIcon(icon, 'text-select');
      item.createSpan({
        cls: 'nestboard-board-list__tag-hit-title',
        text: hit.label.trim().length > 0 ? hit.label : t('boardList.tagHit.untitled'),
      });
      item.addEventListener('click', () => {
        void this.openBoard(board.path, hit.anchorId);
      });
    }
  }

  // ── 一行白板 ────────────────────────────────────────────────

  /**
   * 一行 = 一个 `<button>`。
   *
   * ★ 用真按钮而不是 `<div>` + click：键盘 Enter / Space 与读屏的"按钮"角色都是白拿的，
   *   自己用 `tabindex` + `keydown` 补一遍只会补漏（漏掉 Space 时是"按了没反应"，
   *   最难被发现的那类无障碍缺陷）。
   */
  private renderRow(parent: HTMLElement, board: BoardListItem, showPath: boolean): void {
    const row = parent.createEl('button', { cls: 'nestboard-board-list__row' });
    row.setAttr('aria-label', t('boardList.open.ariaLabel', { path: board.path }));

    const icon = row.createSpan({ cls: 'nestboard-board-list__row-icon' });
    setIcon(icon, 'layout-dashboard');

    const text = row.createDiv({ cls: 'nestboard-board-list__row-text' });
    text.createDiv({
      cls: 'nestboard-board-list__row-title',
      text: board.title.length > 0 ? board.title : board.path,
    });
    // 路径只在"看不出位置"的两种看法里显示（最近打开 / 按标签）：
    // 同名白板在不同目录下是完全可能的，只给标题等于给了两个一模一样、点进去却不同的行
    if (showPath) {
      text.createDiv({ cls: 'nestboard-board-list__row-path', text: board.path });
    }

    row.addEventListener('click', () => {
      void this.openBoard(board.path);
    });
  }

  private async openBoard(path: string, anchorId?: string): Promise<void> {
    const view = await openBoardView(this.app, path);
    // 卡片级命中（`F1` 追记）：打开那块板并**把那张卡亮出来** ——
    // 与反链面板同一条做法（那边点"哪张卡提过我"也是这么跳的）
    if (view && anchorId !== undefined && anchorId.length > 0) view.revealCardById(anchorId);
    // 从列表里点开也算一次"打开"：已有的标签页被复用（`onLoadFile` 不会再触发）时
    // 只有这一行能把它挪到"最近打开"的队首
    this.plugin.rememberRecentBoard(path);
    this.syncChrome();
    this.refresh();
  }
}

/**
 * 打开（或聚焦）白板列表侧栏。
 *
 * 三段式与 `openBoardView` / `openBacklinkPanel` 同规矩：先找已有 leaf 复用 →
 * 没有才 `getRightLeaf` → `setViewState` → `revealLeaf`。漏掉 `revealLeaf`
 * 就是"视图建好了但不显示"。
 */
export async function openBoardListPanel(plugin: NestboardPlugin): Promise<void> {
  const app = plugin.app;
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_BOARD_LIST)[0];
  if (existing) {
    await app.workspace.revealLeaf(existing);
    return;
  }

  // `false` = 不新建分栏；用户把右栏关到没有时它会给一个
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: VIEW_TYPE_BOARD_LIST, active: true });
  await app.workspace.revealLeaf(leaf);
}
