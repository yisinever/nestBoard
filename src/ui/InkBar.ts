/**
 * 手绘工具条（T3.07 / `F4-02`、`F4-06`、`F4-07`）：手绘态下浮在画布底部的一条小工具条 ——
 * 笔型 + 颜色 + 4 档笔宽（+ 临时标注态的「清空」）。
 *
 * 为什么要有它，而不是只给快捷键：`X`（换色）与 `1`–`4`（笔宽）确实能干活，但
 * **发现不了** —— 用户不会去翻命令面板找"笔宽 3"。工具条把"现在拿的是哪支笔、
 * 能换成什么"直接摊在眼前，快捷键就退化成熟练用户的加速器。
 *
 * ★ DOM 位置：挂在覆盖层的 HUD 里（`OverlayLayer.hud`），也就是**画布容器内部**。
 *   所以它必须带 `OVERLAY_UI_ATTR`：容器上的手绘控制器在**捕获阶段**就会收到
 *   `pointerdown`，不标记的话"点一下换颜色"会顺手在画布上落一个点。
 *
 * ★ 橡皮态整条隐藏（由调用方 `setVisible(false)`）：橡皮没有颜色与笔宽可调，
 *   一条点不动的工具条比没有更糟；`D` / `E` 切回来时再显示。
 *
 * ★ 三支笔的图标**用 CSS 画**（`__tip` 系列），不引图标库、也不塞一段 SVG 字符串：
 *   做法与旁边那排"笔宽圆点"完全一样（`createWidthButton` 里也是内联尺寸），
 *   而且荧光笔那颗能直接吃 `--nestboard-ink-swatch` ——
 *   于是**当前色半透明的一小条**就是"荧光笔"最贴切的图标，随着换色实时变。
 *
 * ★ 它不认识 `InkController`：状态靠 `state()` / `tool()` 回调现取（这里绝不缓存副本），
 *   点击靠回调送出。于是它既能在 node 下单测，也不会因为将来笔的模型变化而重写。
 */

import { OVERLAY_UI_ATTR } from '../constants';
import { INK_BRUSH_WIDTHS, INK_COLORS, type InkTool, type InkToolState } from '../model/ink';
import type { HexColor } from '../model/schema';
import { t, type MessageKey } from '../util/i18n';

export interface InkBarOptions {
  /** 读当前笔状态（每次重画现取：调用方是唯一真值来源） */
  state: () => InkToolState;
  /** 读当前拿的是哪支笔（画笔 / 荧光笔 / 临时标注） */
  tool: () => InkTool;
  /** 点了调色板里的某一色 */
  onColor: (color: HexColor) => void;
  /** 点了「自定义…」→ 调用方弹取色器 */
  onCustomColor: () => void;
  /** 点了笔宽档位（`INK_BRUSH_WIDTHS` 的下标） */
  onWidth: (index: number) => void;
  /** 换笔 */
  onTool: (tool: InkTool) => void;
  /** 点了「清空」：清空临时标注层（不动已经落盘的笔迹） */
  onClear: () => void;
  /** 临时标注层里有几笔：决定「清空」可不可点（0 = 点不动） */
  annotations: () => number;
}

/**
 * 工具条上摆哪几支笔，以及**按什么顺序**。
 *
 * ★ 橡皮不在这里：它没有颜色与笔宽可调，整条工具条在橡皮态是收起的（见文件头）。
 * ★ 顺序 = 从"最常用"到"最临时"：画笔、荧光笔、临时标注。
 *   临时标注排最后不是因为它次要，而是因为它**不落盘** —— 放在最边上，
 *   与另外两支（会留下东西的）之间隔着一道视觉边界。
 */
const BAR_TOOLS: Array<{ tool: InkTool; labelKey: MessageKey }> = [
  { tool: 'brush', labelKey: 'inkBar.tool.brush' },
  { tool: 'marker', labelKey: 'inkBar.tool.marker' },
  { tool: 'annotate', labelKey: 'inkBar.tool.annotate' },
];

/**
 * 笔宽圆点的显示直径区间（px）。
 *
 * ★ 只求"一眼看出依次变粗"，刻意**不**按真实线宽等比：`INK_BRUSH_WIDTHS` 是
 *   2/4/7/12，等比画出来最小的那颗只有 2px（在按钮里几乎看不见）。
 *   这里把最细的一档抬到 4px 地板，保持单调即可 —— 圆点是**图标**，不是标尺。
 */
const DOT_MIN_PX = 4;
const DOT_MAX_PX = 14;

/**
 * 事件目标身上的 `closest()`。
 *
 * ★ 返回类型直接写 `HTMLButtonElement`（而不是 `Element | null`）：本类只拿它找按钮，
 *   于是这条类型就是"工具条只认按钮"的声明 —— 也省掉了调用处一次无处安放的 cast。
 */
interface ClosestCapable {
  closest(selector: string): HTMLButtonElement | null;
}

/**
 * 事件目标是不是元素。
 *
 * ★ 用"**有没有 `closest()`**"而不是 `instanceof Element`，两个理由，都不是洁癖：
 *  * **跨窗口会静默失效**：视图可能被挂到弹出窗口里（见构造函数的 `ownerDocument`），
 *    那时事件目标是**那个窗口**的元素，而 `instanceof` 右边的 `Element` 是本窗口的
 *    ——跨窗口 `instanceof` 恒为 `false`。整条委托会一声不响地什么都不做，
 *    而点工具条"像没事一样"是最难查的一类故障；
 *  * node 下没有 DOM 全局，`instanceof Element` 会直接抛 `ReferenceError`，
 *    于是本类永远不可能有单测（同一条判定在 `InkController.isOverlayUi` 里也是这么写的）。
 *
 * 鸭子类型在这里并不更松：事件目标本来就只能是元素、`document` 或 `null`。
 */
function hasClosest(target: EventTarget | null): target is EventTarget & ClosestCapable {
  return typeof (target as Partial<ClosestCapable> | null)?.closest === 'function';
}

export class InkBar {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly tools: HTMLElement[] = [];
  private readonly swatches: HTMLElement[] = [];
  private readonly widths: HTMLElement[] = [];
  private readonly custom: HTMLElement;
  private readonly clear: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly options: InkBarOptions,
  ) {
    // ★ 从父节点取 `ownerDocument` 而不是用全局 `document`：视图可能被挂到独立窗口
    //   （弹出窗口 / 未来的移动端分屏），跨窗口建元素会直接抛错（同 `Breadcrumb`）
    this.doc = parent.ownerDocument;
    this.root = this.doc.createElement('div');
    this.root.className = 'nestboard-ink-bar is-hidden';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', t('inkBar.ariaLabel'));
    // ★ 见文件头：不标这个，点工具条等于在画布上落笔
    this.root.setAttribute(OVERLAY_UI_ATTR, '');
    parent.appendChild(this.root);

    // 笔型组排在最前：它决定"这一笔画出来是什么、画完去哪"，
    // 比颜色与笔宽都更根本（而颜色 / 笔宽是三支笔共用的，放在后面才符合从属关系）
    const toolGroup = this.doc.createElement('div');
    toolGroup.className = 'nestboard-ink-bar__group';
    for (const { tool, labelKey } of BAR_TOOLS)
      toolGroup.appendChild(this.createToolButton(tool, labelKey));
    this.clear = this.createClearButton();
    toolGroup.appendChild(this.clear);
    this.root.appendChild(toolGroup);

    this.root.appendChild(this.createDivider());

    const palette = this.doc.createElement('div');
    palette.className = 'nestboard-ink-bar__group';
    for (const color of INK_COLORS) palette.appendChild(this.createSwatch(color));
    this.custom = this.createCustomSwatch();
    palette.appendChild(this.custom);
    this.root.appendChild(palette);

    this.root.appendChild(this.createDivider());

    const brushes = this.doc.createElement('div');
    brushes.className = 'nestboard-ink-bar__group';
    INK_BRUSH_WIDTHS.forEach((_, index) => brushes.appendChild(this.createWidthButton(index)));
    this.root.appendChild(brushes);

    // ★ 一次委托：整条工具条只挂一个监听器。按钮是启动时一次性建好的（不会重建），
    //   但把"谁被点了"收在一处，加新按钮时不必记得再绑一次
    this.root.addEventListener('click', (event) => this.onClick(event));
  }

  /** 显示 / 隐藏（橡皮态与退出手绘时隐藏） */
  setVisible(visible: boolean): void {
    this.root.classList.toggle('is-hidden', !visible);
  }

  /**
   * 按当前状态重画高亮。**幂等**：可以反复调。
   *
   * ★ 选中态写在 `aria-pressed` 上，class 只是它的视觉投影：屏幕阅读器与样式
   *   共用一份真值，不会出现"看着选中了、读出来没选中"。
   */
  render(): void {
    const state = this.options.state();

    // 当前笔色写到根节点上：一排笔宽圆点（CSS 里读 `--nestboard-ink-swatch`）跟着变色，
    // 于是"现在拿的是哪支颜色的笔"在这条工具条上有两处呼应
    this.root.style.setProperty('--nestboard-ink-swatch', state.color);

    for (const swatch of this.swatches) {
      const active = swatch.dataset.color === state.color;
      swatch.classList.toggle('is-active', active);
      swatch.setAttribute('aria-pressed', String(active));
    }

    // ★ 当前色不在调色板里（取色器选的自定义色）时，让它落在"自定义"那颗上：
    //   否则七颗色点全不高亮，用户会以为自己没选中任何颜色
    const inPalette = INK_COLORS.includes(state.color);
    this.custom.classList.toggle('is-active', !inPalette);
    this.custom.setAttribute('aria-pressed', String(!inPalette));

    for (const button of this.widths) {
      const active = Number(button.dataset.widthIndex) === state.widthIndex;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    const tool = this.options.tool();
    for (const button of this.tools) {
      const active = button.dataset.tool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    // ★ 「清空」的可见性与可点性**分成两件事**（T7.07）：
    //   可见 = "临时标注态，或者确实还有临时笔迹" —— 用荧光笔的状态下切到画笔时，
    //   临时笔迹还留在屏幕上，这时按钮必须还在，否则用户只能靠 `Esc`（那会连手绘态一起退掉）。
    //   可点 = "确实有笔迹可清" —— 没有笔迹时按钮**留在原位但点不动**（位置不跳，
    //   而"点了没反应"比"少了一个按钮"更让人摸不着头脑）。
    const annotating = tool === 'annotate';
    const pending = this.options.annotations();
    this.root.classList.toggle('is-annotating', annotating);
    this.clear.hidden = !annotating && pending === 0;
    this.clear.disabled = pending === 0;
    this.clear.setAttribute('aria-disabled', String(pending === 0));
  }

  dispose(): void {
    this.root.remove();
    this.tools.length = 0;
    this.swatches.length = 0;
    this.widths.length = 0;
  }

  // ── 内部 ────────────────────────────────────────────────

  private onClick(event: MouseEvent): void {
    const target = event.target;
    if (!hasClosest(target)) return;
    const button = target.closest('button');
    // 包含关系校验：与 `HitTest.resolveCardElement` 同样的理由 ——
    // 将来若把工具条嵌进别处，别的界面的按钮不该被这条委托吃掉
    if (!button || !this.root.contains(button)) return;
    // ★ 点不动的那颗（清空）不派发：`click` 在 `disabled` 的按钮上本来就不会触发，
    //   但它还留着 `aria-disabled` 的投影路径（脚本派发、无指针设备），
    //   这里拦一句，免得"没有笔迹可清"却被当成一次清空而弹出提示
    if (button.disabled) return;

    const tool = button.dataset.tool;
    if (tool) {
      this.options.onTool(tool as InkTool);
      return;
    }
    const color = button.dataset.color;
    if (color) {
      this.options.onColor(color as HexColor);
      return;
    }
    if (button.dataset.action === 'custom') {
      this.options.onCustomColor();
      return;
    }
    if (button.dataset.action === 'clear') {
      this.options.onClear();
      return;
    }
    const index = button.dataset.widthIndex;
    if (index !== undefined) this.options.onWidth(Number(index));
  }

  private createToolButton(tool: InkTool, labelKey: MessageKey): HTMLElement {
    const button = this.createButton(`nestboard-ink-bar__tool nestboard-ink-bar__tool--${tool}`);
    button.dataset.tool = tool;
    button.setAttribute('aria-label', t(labelKey));
    button.setAttribute('title', t(labelKey));

    // ★ 图标是一小段"笔尖"（CSS 里画），三支笔各不同形：
    //   画笔 = 细实线、荧光笔 = 当前色的半透明粗条、临时标注 = 虚线
    const tip = this.doc.createElement('span');
    tip.className = 'nestboard-ink-bar__tip';
    tip.setAttribute('aria-hidden', 'true');
    button.appendChild(tip);

    this.tools.push(button);
    return button;
  }

  private createClearButton(): HTMLButtonElement {
    const button = this.createButton('nestboard-ink-bar__clear');
    button.dataset.action = 'clear';
    button.setAttribute('aria-label', t('inkBar.clear'));
    button.setAttribute('title', t('inkBar.clear'));
    button.hidden = true;
    // ★ 显式 `disabled` 初值：`render()` 之前（工具条还没显示的那段时间）它必须点不动，
    //   否则"刚进手绘就点到清空"会走到一条还没有笔迹的路径上
    button.disabled = true;
    button.textContent = '✕';
    return button;
  }

  private createSwatch(color: HexColor): HTMLElement {
    const button = this.createButton('nestboard-ink-bar__swatch');
    button.dataset.color = color;
    // 颜色本身写进 CSS 变量：换主题 / 加色都不用改样式表
    button.style.setProperty('--nestboard-ink-swatch', color);
    button.setAttribute('aria-label', t('inkBar.color', { color }));
    this.swatches.push(button);
    return button;
  }

  private createCustomSwatch(): HTMLElement {
    const button = this.createButton('nestboard-ink-bar__swatch nestboard-ink-bar__swatch--custom');
    button.dataset.action = 'custom';
    button.setAttribute('aria-label', t('inkBar.customColor'));
    return button;
  }

  private createWidthButton(index: number): HTMLElement {
    const button = this.createButton('nestboard-ink-bar__width');
    button.dataset.widthIndex = String(index);
    button.setAttribute('aria-label', t('inkBar.width', { n: index + 1 }));

    const dot = this.doc.createElement('span');
    dot.className = 'nestboard-ink-bar__dot';
    const size = this.dotSize(index);
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    button.appendChild(dot);

    this.widths.push(button);
    return button;
  }

  /** 圆点直径：按真实线宽在 4–14px 之间线性映射（单调即可，见 `DOT_MIN_PX` 注释） */
  private dotSize(index: number): number {
    const widest = INK_BRUSH_WIDTHS[INK_BRUSH_WIDTHS.length - 1] ?? 1;
    const width = INK_BRUSH_WIDTHS[index] ?? 0;
    if (widest <= 0) return DOT_MIN_PX;
    return DOT_MIN_PX + (DOT_MAX_PX - DOT_MIN_PX) * (width / widest);
  }

  private createButton(className: string): HTMLButtonElement {
    const button = this.doc.createElement('button');
    // ★ 显式 `type`：按钮在 `<form>` 里的默认类型是 `submit`，将来若把工具条放进设置面板，
    //   漏掉这一句就是"点一下换颜色顺手提交了一次表单"
    button.type = 'button';
    button.className = className;
    return button;
  }

  private createDivider(): HTMLElement {
    const divider = this.doc.createElement('span');
    divider.className = 'nestboard-ink-bar__divider';
    divider.setAttribute('aria-hidden', 'true');
    return divider;
  }
}
