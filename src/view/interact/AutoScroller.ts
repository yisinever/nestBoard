/**
 * 拖动中的**贴边自动滚屏**（用户 2026-09-28："线不能跨屏幕，线拖出屏幕时候，
 * 屏幕应该会会滚动"）。
 *
 * ── 它解决什么 ──────────────────────────────────────────────
 *
 * 拖一根连线（或任何跟着指针的东西）到视口边缘之外，从前就"够不着了"：
 * 必须松手、滚屏、重新拖。贴边自动滚屏是所有画布产品的默认答案 ——
 * 指针贴近视口边缘时，画布按贴近程度**匀速**往那个方向平移，松手即停。
 *
 * ── 用法 ────────────────────────────────────────────────────
 *
 * 拖动开始时 `start(host)`，结束时 `stop()`。宿主喂三件事：指针的**屏幕**位置、
 * 视口的屏幕矩形、以及"往这个方向平移这么多屏幕像素"。
 *
 * ★ 速度曲线是**线性贴近渐快**（越贴边越快，封顶 {@link MAX_SPEED}）——
 *   常速会让"只想挪过一张卡的距离"变成冲刺，线性是各家的通用手感。
 * ★ 循环自己会停：宿主说 `active() === false`（松手）就不再排下一帧，
 *   宿主不必记得调 `stop()`（但调了也无妨，幂等）。
 * ★ 本文件不认识 Viewport / BoardView —— 换算成世界坐标与触发重画都是宿主的事
 *   （`viewport.panBy` 自带 notify ⇒ 重画免费）。
 */

/** 距视口边多近开始滚（屏幕 px） */
const EDGE_ZONE = 48;
/** 贴到边上时的最大速度（每帧屏幕 px；60fps 下 ≈ 1080px/s） */
const MAX_SPEED = 18;

/** 指针位置的屏幕坐标 */
export interface ScreenPoint {
  x: number;
  y: number;
}

export interface AutoScrollerHost {
  /** 指针此刻的屏幕位置（拖动中由 pointermove 持续喂入；丢失 = 这一帧不滚） */
  pointerScreen(): ScreenPoint | null;
  /** 视口在屏幕上的矩形（贴边判定用它） */
  viewportBounds(): { left: number; top: number; right: number; bottom: number } | null;
  /** 还在拖吗？（false ⇒ 循环自停） */
  active(): boolean;
  /** 平移这么多屏幕像素（宿主负责换算世界坐标与重画；返回是否真的动了） */
  panByScreen(dx: number, dy: number): void;
}

export class AutoScroller {
  private frame: number | null = null;
  private host: AutoScrollerHost | null = null;

  /** 拖动开始时调（重复调是幂等的：已经在滚就继续滚） */
  start(host: AutoScrollerHost): void {
    this.host = host;
    if (this.frame === null) this.frame = window.requestAnimationFrame(this.tick);
  }

  /** 拖动结束时调（不调也行：`active()` 为 false 时循环自己停） */
  stop(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.host = null;
  }

  private readonly tick = (): void => {
    this.frame = null;
    const host = this.host;
    if (!host || !host.active()) {
      this.host = null;
      return;
    }
    const pointer = host.pointerScreen();
    const bounds = host.viewportBounds();
    if (pointer && bounds) {
      const dx = edgePush(pointer.x, bounds.left, bounds.right);
      const dy = edgePush(pointer.y, bounds.top, bounds.bottom);
      if (dx !== 0 || dy !== 0) host.panByScreen(dx, dy);
    }
    this.frame = window.requestAnimationFrame(this.tick);
  };
}

/** 距哪条边近就往哪边推（在贴边区之内返回带方向的每帧位移，否则 0） */
function edgePush(value: number, min: number, max: number): number {
  if (value < min + EDGE_ZONE) return -speedAt(min + EDGE_ZONE - value);
  if (value > max - EDGE_ZONE) return speedAt(value - (max - EDGE_ZONE));
  return 0;
}

function speedAt(depth: number): number {
  return MAX_SPEED * Math.min(1, depth / EDGE_ZONE);
}
