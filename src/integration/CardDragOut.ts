/**
 * 拖出卡片到文件浏览器（T6.10 / `F6-04`）：把画布上的**移动手势**复用成"导出为 `.md`"。
 *
 * 它不接管任何事件，只被宿主喂两句话：
 *
 *   - `begin(ids)` —— 开始拖这几张卡了
 *   - `update(x, y)` —— 指针现在在这儿（宿主每帧调一次）
 *   - `finish()` —— 松手了；返回 `true` 表示"这一拖是导出"，宿主应当**取消**这次移动
 *
 * ── 为什么挂在移动手势上而不是原生拖拽 ──
 *
 * 见 `model/dragOut.ts` 顶部的注释：原生 `dragstart` 会给正在拖的指针补发
 * `pointercancel`，直接把移动手势打断。复用移动手势则连"取消"都不必另设计。
 *
 * ★ **悬停时必须给落点文件夹加高亮**（`DROP_OUT_HIGHLIGHT_CLASS`）：没有这个反馈，
 *   "松手会导出"就是完全隐形的行为 —— 用户会把一次误拖当成"卡片丢了"，
 *   而不是"多了一篇笔记"。这个类名是这条功能的可见部分。
 * ★ `update` 会被每帧调用（`pointermove`），所以**只有落点换了才回调**。
 *   少了这条去重，拖过长长的文件夹树时每一帧都要改一次 DOM。
 * ★ 高亮的清除在 `cancel()` / `finish()` 里兜底：无论这一拖以什么方式结束
 *   （松手导出、拖回画布、中途被打断），都不会在侧栏留下一个亮着的文件夹。
 */

import { dropFolderOf } from '../model/dragOut';

export interface CardDragOutPorts {
  /**
   * 指针底下那个元素的库内路径（文件夹或文件）。
   * 返回 `null` 表示那里不是文件浏览器里的条目 —— 这一拖就该按普通移动处理。
   */
  pathAt(clientX: number, clientY: number): string | null;
  /** 该路径是不是文件夹（外部事实，由宿主问 Vault） */
  isFolder(path: string): boolean;
  /** 高亮落点（`null` = 清除）。**只在落点变化时**调用 */
  onHighlight(folder: string | null): void;
  /** 把这几张卡导出到该文件夹（异步、不阻塞松手） */
  onExport(cardIds: readonly string[], folder: string): void;
}

export class CardDragOut {
  private cardIds: readonly string[] = [];
  private target: string | null = null;
  private dragging = false;

  constructor(private readonly ports: CardDragOutPorts) {}

  /** 开始拖这几张卡。换一次手势就要重新开始，所以先清干净上一次的残留 */
  begin(cardIds: readonly string[]): void {
    this.cancel();
    this.cardIds = [...cardIds];
    this.dragging = true;
  }

  /** 指针动了：更新落点与高亮 */
  update(clientX: number, clientY: number): void {
    if (!this.dragging) return;
    const path = this.ports.pathAt(clientX, clientY);
    const folder = path === null ? null : dropFolderOf(path, this.ports.isFolder(path));
    if (folder === this.target) return;
    this.target = folder;
    this.ports.onHighlight(folder);
  }

  /**
   * 松手。
   *
   * @returns `true` = 这一拖变成了导出，宿主**不要**提交移动（要么取消、要么还原）
   */
  finish(): boolean {
    const folder = this.target;
    const cardIds = this.cardIds;
    this.cancel();
    // 空选（理论上不该发生）不导出：宁可不做事，也不要写出一堆"未命名"文件
    if (folder === null || cardIds.length === 0) return false;
    this.ports.onExport(cardIds, folder);
    return true;
  }

  /** 这一拖此刻是否悬在某个文件夹上（画布内的落点提示要让路） */
  get active(): boolean {
    return this.target !== null;
  }

  /**
   * 收起落点但**不结束**这一次拖动。
   *
   * 用途是"拖到一半按下了 Alt"：那一刻这条手势的语义变成"在板内复制"，
   * 与"导出到别处"互斥，高亮得收掉。但它不是 `cancel` —— Alt 可以再松开，
   * 那时这条手势要能重新变回"可能导出"。
   */
  suspend(): void {
    if (this.target === null) return;
    this.target = null;
    this.ports.onHighlight(null);
  }

  /** 清掉这一次拖动的一切痕迹（高亮、落点、卡片清单） */
  cancel(): void {
    this.dragging = false;
    this.cardIds = [];
    if (this.target === null) return;
    this.target = null;
    this.ports.onHighlight(null);
  }
}
