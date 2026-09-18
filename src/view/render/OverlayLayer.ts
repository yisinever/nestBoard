/**
 * 覆盖层：参考线 / 框选 / 插入线 / HUD 容器（T1.28）。
 *
 * 位置在 02 §2 的层级⑤ —— **最上面**，但 `pointer-events: none`：
 * 它只负责"画提示"，永远不参与命中测试（唯一可交互层是卡片层）。
 * 单独一层的理由也在 02 §2：参考线与框选每帧都在变，混在卡片层里会触发卡片重排。
 *
 * 坐标系：**屏幕坐标**（1 单位 = 1 CSS 像素）。
 * 参考线/框选/插入线都是"跟指针、跟屏幕"的东西，画在屏幕坐标里线条才清晰；
 * 需要世界坐标的调用方自己用 `Viewport.toScreen()` 换算后再传进来。
 *
 * 本 Sprint 只交付骨架与三个绘制原语，真正的调用方分别是：
 *   * 框选矩形 → T1.31 `MarqueeController`
 *   * 智能参考线 → T3.12 `model/snapping.ts`
 *   * 分栏插入线 → T1.55 `model/columns.ts`
 *   * HUD 容器 → T2.17 诊断信息面板 / T1.66 拖拽幽灵卡
 *
 * ★ 不 import `obsidian`，只用标准 DOM / Canvas API。
 */

import type { Rect } from '../../util/geometry';
import type { Viewport } from '../../canvas/Viewport';
import { CanvasLayer } from './CanvasLayer';

/** 1px 线画在整数坐标上会跨两个物理像素 → 加 0.5 才是"一根清晰的线" */
const CRISP = 0.5;

/** 框选填充的不透明度（颜色取自主题，透明度交给 `globalAlpha`，避免写死 rgba） */
const MARQUEE_FILL_ALPHA = 0.12;

/** 框选与参考线共用的虚线节奏（屏幕像素） */
const GUIDE_DASH = [4, 4] as const;

/** 幽灵卡的填充不透明度（T1.66）：要看得见，但不能盖住底下已经有的卡片 */
const GHOST_FILL_ALPHA = 0.16;

/** 幽灵卡边框的虚线节奏：比参考线更长，一眼能分出"这是待落下的东西" */
const GHOST_DASH = [6, 4] as const;

/** 幽灵卡标签的字号（屏幕像素）与内边距 */
const LABEL_FONT_SIZE = 12;
const LABEL_PADDING_X = 6;
const LABEL_PADDING_Y = 3;

/** 连线拖拽预览的线宽与端点圆点半径（屏幕像素） */
const CONNECT_LINE_WIDTH = 2;
const CONNECT_DOT_RADIUS = 3.5;

/** 连线目标卡的高亮填充不透明度（T1.68）：比幽灵卡更淡，别把目标卡内容糊掉 */
const CONNECT_TARGET_ALPHA = 0.14;

/** 主题变量读不到时的兜底（正常不会走到：Obsidian 一定提供这些变量） */
const FALLBACK_COLOR = 'gray';

export interface OverlayPalette {
  /** 强调色：框选边线、插入线、参考线 */
  accent: string;
  /** 次要色：辅助性提示 */
  muted: string;
  /** 强调色底上的文字色：幽灵卡标签是"强调色底 + 反白字" */
  onAccent: string;
  /**
   * 界面字体族（用于幽灵卡标签）。
   *
   * ★ 必须从主题变量里取**计算后的值**：canvas 的 `ctx.font` 不认 `var(--font-interface)`，
   *   写死 `sans-serif` 又会让提示文字与 Obsidian 界面明显不是一个字体。
   */
  fontFamily: string;
}

/** 世界/屏幕无关的一段线（屏幕坐标） */
export interface OverlaySegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export class OverlayLayer extends CanvasLayer {
  private readonly hudEl: HTMLElement;
  private palette: OverlayPalette | null = null;
  private camera = { x: 0, y: 0, zoom: 1 };

  constructor(host: HTMLElement) {
    super(host, 'nestboard-overlay-canvas');

    const hud = document.createElement('div');
    hud.className = 'nestboard-overlay-hud';
    hud.setAttribute('data-overlay-hud', '');
    host.appendChild(hud);
    this.hudEl = hud;
  }

  /** HUD 容器：放常驻的小控件（缩放读数、性能提示） */
  get hud(): HTMLElement {
    return this.hudEl;
  }

  /**
   * 每帧开始：清空整层并刷新调色板。
   *
   * 覆盖层每次只画几十条线，全量 `clearRect` 比维护脏区划算得多。
   * 调色板每帧重读 —— 用户切换深浅主题会立刻生效，不必额外订阅事件。
   */
  beginFrame(): void {
    this.clear();
    this.palette = this.readPalette();
  }

  /**
   * 视口变化时把残留的提示清掉。
   * 相机一动，上一帧画在屏幕坐标里的框选/参考线就全错位了，留着比没有更糟。
   */
  sync(viewport: Viewport): void {
    const cameraChanged =
      viewport.x !== this.camera.x ||
      viewport.y !== this.camera.y ||
      viewport.zoom !== this.camera.zoom;
    if (cameraChanged) {
      this.camera = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
      this.clear();
      this.palette = null;
    }
    super.resize(viewport.width, viewport.height);
  }

  /** 框选矩形（T1.31） */
  drawMarquee(rect: Rect): void {
    const palette = this.palette ?? this.readPalette();
    const ctx = this.ctx;
    this.resetTransform();

    ctx.save();
    ctx.globalAlpha = MARQUEE_FILL_ALPHA;
    ctx.fillStyle = palette.accent;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + CRISP, rect.y + CRISP, rect.width, rect.height);
    ctx.restore();
  }

  /**
   * 智能参考线（T3.12）：竖向线贯穿整个视口高度，横向线贯穿整个宽度。
   * 传入的是**屏幕 x / y**。
   */
  drawGuides(verticals: readonly number[], horizontals: readonly number[]): void {
    if (verticals.length === 0 && horizontals.length === 0) return;
    const palette = this.palette ?? this.readPalette();
    const ctx = this.ctx;
    this.resetTransform();

    ctx.save();
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([...GUIDE_DASH]);

    for (const x of verticals) {
      const at = Math.round(x) + CRISP;
      ctx.beginPath();
      ctx.moveTo(at, 0);
      ctx.lineTo(at, this.height);
      ctx.stroke();
    }
    for (const y of horizontals) {
      const at = Math.round(y) + CRISP;
      ctx.beginPath();
      ctx.moveTo(0, at);
      ctx.lineTo(this.width, at);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 分栏插入线（T1.55）：一段实心短线，两端带小帽 */
  drawInsertLine(segment: OverlaySegment): void {
    const palette = this.palette ?? this.readPalette();
    const ctx = this.ctx;
    this.resetTransform();

    const { x1, y1, x2, y2 } = segment;
    ctx.save();
    ctx.strokeStyle = palette.accent;
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 拖入的幽灵卡 + 落点高亮（T1.66）。
   *
   * `rect` 是**屏幕坐标**：幽灵卡跟着指针走，而指针活在屏幕里 ——
   * 拿世界尺寸去画，缩到 30% 时一张卡在屏幕上只剩几十像素，幽灵卡会显得巨大又错位。
   */
  drawDropGhost(rect: Rect, label: string): void {
    const palette = this.palette ?? this.readPalette();
    const ctx = this.ctx;
    this.resetTransform();

    ctx.save();

    // 落点高亮：先把"卡会占多大一块"铺出来
    ctx.globalAlpha = GHOST_FILL_ALPHA;
    ctx.fillStyle = palette.accent;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    // 幽灵卡轮廓：用虚线，与"已经存在的卡"（实线）一眼可分
    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([...GHOST_DASH]);
    ctx.strokeRect(rect.x + CRISP, rect.y + CRISP, rect.width, rect.height);
    // ★ 必须复位：虚线状态会留在 ctx 上，后面画的框选 / 参考线会跟着变成虚线
    ctx.setLineDash([]);

    if (label.length > 0) this.drawGhostLabel(rect, label, palette);

    ctx.restore();
  }

  /**
   * 连线拖拽预览（T1.68 / F3-01）：一条从起点跟到指针的实线，两端各一个圆点。
   *
   * `segment` 是**屏幕坐标**：指针活在屏幕里，用世界坐标画的话缩到 30% 时
   * 橡皮筋线会细得像蛛丝、端点小到看不见。
   *
   * 用实线而不是虚线，与"要落下的东西"（幽灵卡、插入线，都是虚线）区分开 ——
   * 用户此刻是在**拉一根线**，线本身就是结果，不是预告。
   */
  drawConnectPreview(segment: OverlaySegment): void {
    const palette = this.palette ?? this.readPalette();
    const ctx = this.ctx;
    this.resetTransform();

    const { x1, y1, x2, y2 } = segment;
    ctx.save();
    ctx.strokeStyle = palette.accent;
    ctx.fillStyle = palette.accent;
    ctx.lineWidth = CONNECT_LINE_WIDTH;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // 两端圆点：起点说明"这根线从哪来"，终点说明"现在指的哪儿"
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      ctx.beginPath();
      ctx.arc(x, y, CONNECT_DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 连线目标卡高亮（T1.68）：松手会连到这张卡上。
   *
   * 与 `drawDropGhost` 分成两个方法而不是共用一个：幽灵卡的语义是"这里会出现
   * 一张新卡"（所以有尺寸 + 标签），这里是"既有卡片要接收这条线"（所以只描边）。
   * 合成一个就得靠参数区分两种含义，调用方迟早会传错。
   */
  drawConnectTarget(rect: Rect): void {
    const palette = this.palette ?? this.readPalette();
    const ctx = this.ctx;
    this.resetTransform();

    ctx.save();
    ctx.globalAlpha = CONNECT_TARGET_ALPHA;
    ctx.fillStyle = palette.accent;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([...GHOST_DASH]);
    ctx.strokeRect(rect.x + CRISP, rect.y + CRISP, rect.width, rect.height);
    // ★ 复位虚线：不复位会让之后画的框选 / 参考线全变成虚线
    ctx.setLineDash([]);
    ctx.restore();
  }

  override dispose(): void {
    this.hudEl.remove();
    this.palette = null;
    super.dispose();
  }

  /**
   * 幽灵卡标签（"作为引用卡放入 ×3"）。
   *
   * ★ 调用方必须已经 `ctx.save()`：这里改了 `font` / `textBaseline`，
   *   不复位会让后续所有文字绘制都歪掉。
   */
  private drawGhostLabel(rect: Rect, text: string, palette: OverlayPalette): void {
    const ctx = this.ctx;
    ctx.font = `${LABEL_FONT_SIZE}px ${palette.fontFamily}`;

    const width = ctx.measureText(text).width + LABEL_PADDING_X * 2;
    const height = LABEL_FONT_SIZE + LABEL_PADDING_Y * 2;
    // 默认贴在卡上方；顶到视口上沿就翻进卡内 —— 贴着边缘拖时提示不能被裁掉
    const above = rect.y - height - 2;
    const y = above >= 0 ? above : rect.y + 2;
    // 右边缘同理：宁可贴住右边，也不要让文字伸出屏幕
    const x = Math.max(0, Math.min(rect.x, this.width - width));

    ctx.fillStyle = palette.accent;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = palette.onAccent;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + LABEL_PADDING_X, y + height / 2);
  }

  /** 从主题变量取色（Obsidian 主题一定提供这些变量；读不到才兜底） */
  private readPalette(): OverlayPalette {
    const style = getComputedStyle(this.canvas);
    const accent =
      style.getPropertyValue('--interactive-accent').trim() ||
      style.getPropertyValue('--text-accent').trim() ||
      FALLBACK_COLOR;
    const muted = style.getPropertyValue('--text-muted').trim() || FALLBACK_COLOR;
    const onAccent = style.getPropertyValue('--text-on-accent').trim() || '#fff';
    const fontFamily = style.getPropertyValue('--font-interface').trim() || 'sans-serif';
    return { accent, muted, onAccent, fontFamily };
  }
}
