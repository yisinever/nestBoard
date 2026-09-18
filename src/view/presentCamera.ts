/**
 * 演示相机的**纯数学**（J-06）：目标视口怎么算、怎么从当前视口飞过去。
 *
 * ★ 不 import `obsidian`、不碰 DOM —— 与 `Viewport.ts` 同一种性质。
 *   "一张卡飞过去之后应该占多大、居中在哪"是纯几何，必须能单测；
 *   真正的动画循环（`requestAnimationFrame`）在 `PresentationController` 里。
 */

import { clamp, rectCenter, roundTo, type Rect, type Size } from '../util/geometry';
import { MAX_ZOOM, MIN_ZOOM, type ViewportState } from '../canvas/Viewport';

/** 聚焦一张卡时四周留白（**屏幕像素**）。留白比"适应全部"（64）大一点：讲一张卡时它不该顶到边 */
export const PRESENT_FOCUS_PADDING = 96;

/**
 * 聚焦时的倍率上限。
 *
 * ★ 为什么需要上限：一张 240×160 的便签放进 1200×800 的视口，纯 fit 会算出 ≈3.4 倍，
 *   卡上的字大到只剩两三个 —— "聚焦"变成了"怼脸"。演示要的是"看清这张卡",
 *   而不是把它的像素铺满屏幕；1.5 倍既明显区别于总览，也还留着上下文。
 * ★ 大卡片不受它影响（`fit` 算出来的倍率本来就小），下界沿用画布的 `MIN_ZOOM`。
 */
export const PRESENT_MAX_ZOOM = 1.5;

/** 相机飞行的时长（ms，`06 §4.1` 给的 300~450ms 取中） */
export const PRESENT_DURATION_MS = 400;

export interface PresentFocusOptions {
  /** 四周留白（屏幕像素），默认 {@link PRESENT_FOCUS_PADDING} */
  padding?: number;
  /** 倍率上限，默认 {@link PRESENT_MAX_ZOOM} */
  maxZoom?: number;
}

/**
 * 把一张卡的包围盒放进视口：居中 + 尽量充满（带留白），倍率封顶。
 *
 * 返回的 `x` / `y` 是 `Viewport` 的平移量（`screen = world × zoom + offset`），
 * 与 `view.x` / `view.y` 同一套定义。
 *
 * ★ 视口还没量到尺寸（宽高为 0：视图刚挂载、标签页被折叠）时返回 `null`，
 *   让调用方**跳过这一步**。硬算会得到 `zoom = 1 / 0` 之类的值 ——
 *   一次 NaN 写进视口就再也拉不回来了。
 */
export function presentTargetViewport(
  rect: Rect,
  viewSize: Size,
  options: PresentFocusOptions = {},
): ViewportState | null {
  if (viewSize.width <= 0 || viewSize.height <= 0) return null;
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;

  const padding = options.padding ?? PRESENT_FOCUS_PADDING;
  const availableWidth = Math.max(1, viewSize.width - padding * 2);
  const availableHeight = Math.max(1, viewSize.height - padding * 2);
  const zoom = clamp(
    Math.min(availableWidth / Math.max(rect.width, 1), availableHeight / Math.max(rect.height, 1)),
    MIN_ZOOM,
    Math.min(options.maxZoom ?? PRESENT_MAX_ZOOM, MAX_ZOOM),
  );

  const center = rectCenter(rect);
  return {
    x: roundTo(viewSize.width / 2 - center.x * zoom),
    y: roundTo(viewSize.height / 2 - center.y * zoom),
    zoom: roundTo(zoom, 4),
  };
}

/**
 * ease-in-out（三次）：两端慢、中间快。
 *
 * 用它而不是线性：相机起步与刹车都该柔和，线性插值在启停两处会"啪"地一下，
 * 直播时那种顿挫比多花 100ms 明显得多。
 */
export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * 视口插值。
 *
 * ★ 平移用线性、**缩放用等比**（几何插值）：倍率是"每秒放大多少倍"的尺度，
 *   对 1 → 1.5 与 2 → 3 这两段，等比插值下**视觉速度相同**，线性插值则前者
 *   看起来慢、后者看起来快。相机变焦的直觉是前者，所以这里取对数尺度。
 * ★ 任一端的倍率非正（脏数据）时退回线性，绝不产生 `NaN` / 负数。
 */
export function interpolateViewport(
  from: ViewportState,
  to: ViewportState,
  t: number,
): ViewportState {
  const k = clamp(t, 0, 1);
  const zoom =
    from.zoom > 0 && to.zoom > 0
      ? from.zoom * Math.pow(to.zoom / from.zoom, k)
      : from.zoom + (to.zoom - from.zoom) * k;
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    zoom,
  };
}

/** 两个视口是否已经足够接近（动画可以提前收尾，省下最后几帧看不见的写操作） */
export function viewportSettled(a: ViewportState, b: ViewportState, epsilon = 0.5): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.zoom - b.zoom) < 0.001
  );
}
