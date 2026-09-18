/**
 * 拖动 / 微移 / 缩放 / 旋转（T1.35 / T1.36 / T1.37 / T7.06）—— `02 §5.3` 的鼠标操作表。
 * 网格吸附（T3.11 / `F5-02`）与智能参考线（T3.12 / `F5-03`）挂在这里：
 * 移动时修正位移量（`ctrl` 临时反转网格、临时关闭参考线），缩放与旋转两者都不参与。
 * 两者的判定顺序与共存规则全在 `model/snapping.ts` 的 `snapMove()` 里。
 *
 * ── 一条贯穿全文件的核心决定：**拖动期间不写模型** ──────────
 *
 * 每次 `pointermove` 都 `mutate()` 的后果是三重的，而且每一重都致命：
 *  1. 每帧一次 `JSON.stringify` 落盘 + `revision` 疯涨，1000 张卡的白板必然掉帧（`02 §8.2` 要求 60fps）；
 *  2. 历史栈被"移动 1px"填满 —— `⌘Z` 要按 60 次才能退回原位；
 *  3. 每次 `mutate` 都触发一次外部同步事件，等于把用户的拖动广播给所有订阅者。
 *
 * 所以：**拖动中只写 DOM（预览），松手才提交一次**（`02 §8.1` 的"预览 vs 提交"）。
 * 卡片层负责预览（`CardLayer.previewRects` / `previewRotation`），本文件负责算几何，
 * 视图负责提交。
 *
 * ── 第二个决定：几何计算全部是纯函数 ────────────────────────
 *
 * `resizedRect` 这类函数错一点点，用户只会在"拉左上角时右边也跟着跑"这种地方
 * 隐约觉得别扭 —— 靠手测几乎不可能覆盖 8 个方位 × 等比 × 从中心 × 触底的组合。
 * 所以它们与指针、与 DOM 完全解耦，可以逐个方位钉死（`DragController.test.ts`）。
 *
 * ── 第三个决定：旋转**不挤进** `preview` / `commit` 这两条既有通道（T7.06）
 *
 * 移动与缩放提交的是**几何**（一批 `CardRect`），而旋转一个几何数字都不改，
 * 只改一个角度。硬塞进同一条通道的代价是：每一处"这批矩形是几何还是角度"
 * 都要特判一次，而且"移动 + 转身"会共用同一条历史记录（`⌘Z` 分不清退哪个）。
 * 所以旋转走一对**可选**的旁路回调（`previewRotation` / `commitRotation`）：
 * 不给这两个回调，控制器就退化成 T7.06 之前的样子，一行都不用改。
 *
 * ★ 不 import `obsidian`。
 */

import { MIN_CARD_SIZE, NUDGE_STEP, ROTATE_SNAP_STEP } from '../../constants';
import type { CardRect } from '../../model/ops';
import {
  EMPTY_GUIDES,
  gridSnapActive,
  normalizeGridSize,
  snapMove,
  type AlignConfig,
  type GridSnapConfig,
  type SmartGuides,
} from '../../model/snapping';

import {
  boundsOf,
  normalizeAngle,
  pointerAngleDeg,
  rectCenter,
  type Point,
  type Rect,
  type Size,
} from '../../util/geometry';
import { t } from '../../util/i18n';
import type { ResizeHandle } from '../render/CardLayer';

/** 世界坐标下"算不算开始拖了"的阈值（px）。与框选共用同一手感基准 */
export const DRAG_THRESHOLD_PX = 3;

// ─────────────────────────────────────────────────────────────
// 纯几何
// ─────────────────────────────────────────────────────────────

/** 整体平移：多选拖动 = 每张卡都平移同一个位移量（相对位置不变） */
export function movedRects(origin: readonly CardRect[], dx: number, dy: number): CardRect[] {
  return origin.map((rect) => ({ ...rect, x: rect.x + dx, y: rect.y + dy }));
}

export interface ResizeOptions {
  /** ⇧：保持原始宽高比 */
  keepAspect?: boolean;
  /** Alt：以中心为锚点缩放（两侧对称展开） */
  fromCenter?: boolean;
  /** 尺寸下限，默认 `MIN_CARD_SIZE` */
  min?: Size;
}

/**
 * 按手柄方位算出缩放后的矩形。
 *
 * 三个容易写错、也最容易被用户发现的地方：
 *
 *  * **不能翻转**。把右边缘一路拖过左边缘时，`width` 会是负数 —— 卡片瞬间消失
 *    （宽高为 0 的 DOM 什么都不画），用户以为卡片被删了。所以下限是**位移方向上的硬钳制**：
 *    谁在动就顶谁回去，锚定边永远不动（卡片不会从鼠标底下溜走）。
 *  * **轴不串味**。拖 `n` / `s` 时 `dx` 必须被忽略，否则卡片会横向漂移。
 *  * **等比时锚定边不动**。缩放比例以"相对变化更大的那一轴"为准，
 *    另一轴按原始比例推出来，再贴着不动的边重排。
 */
export function resizedRect(
  rect: CardRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options: ResizeOptions = {},
): CardRect {
  const { keepAspect = false, fromCenter = false, min = MIN_CARD_SIZE } = options;

  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');

  // 轴不串味：只让"真的有边在动"的那个轴吃位移
  const useDx = west || east ? dx : 0;
  const useDy = north || south ? dy : 0;

  let left = rect.x + (west ? useDx : 0);
  let right = rect.x + rect.width + (east ? useDx : 0);
  let top = rect.y + (north ? useDy : 0);
  let bottom = rect.y + rect.height + (south ? useDy : 0);

  // 从中心：对面那条边反向移动等量 → 中心保持不动
  if (fromCenter) {
    if (west) right -= useDx;
    else if (east) left -= useDx;
    if (north) bottom -= useDy;
    else if (south) top -= useDy;
  }

  if (keepAspect && rect.width > 0 && rect.height > 0) {
    const ratio = rect.width / rect.height;
    const width = right - left;
    const height = bottom - top;
    let nextWidth = width;
    let nextHeight = height;

    // 取"相对变化更大"的那一轴为准；另一轴推出来。这样斜着拖时手感跟手，
    // 不会出现"鼠标动了很多、卡片纹丝不动"（被另一轴的比例锁死）
    if (Math.abs(width - rect.width) >= Math.abs(height - rect.height) * ratio) {
      nextHeight = width / ratio;
    } else {
      nextWidth = height * ratio;
    }

    if (west) left = right - nextWidth;
    else right = left + nextWidth;
    if (north) top = bottom - nextHeight;
    else bottom = top + nextHeight;

    // 只有左右边在动（`w`/`e`）时，纵向以中心为锚对称展开 —— 否则卡片会单向上飘
    if (!north && !south) {
      const centerY = rect.y + rect.height / 2;
      top = centerY - nextHeight / 2;
      bottom = centerY + nextHeight / 2;
    }
    if (!west && !east) {
      const centerX = rect.x + rect.width / 2;
      left = centerX - nextWidth / 2;
      right = centerX + nextWidth / 2;
    }
  }

  // 下限钳制：把"在动的边"顶回去，锚定边不动
  if (right - left < min.width) {
    if (west) left = right - min.width;
    else right = left + min.width;
  }
  if (bottom - top < min.height) {
    if (north) top = bottom - min.height;
    else bottom = top + min.height;
  }

  return { id: rect.id, x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 把角度就近吸附到 `step` 的整数倍（度）。
 *
 * ★ 与 `resizedRect` 同样是**纯函数**：吸附的边界情形（`-7.5°` 该吸去 `0°` 还是
 *   `-15°`、`180°` 与 `-180°` 是不是同一个方向）靠手测根本试不出来，
 *   必须能逐个钉死。
 * ★ `step <= 0`（配置坏了 / 调用方传错）视为不吸附：宁可完全不吸，
 *   也不要因为一次除零让角度变成 `NaN` 并写进文件（`normalizeAngle` 兜底成 0，
 *   于是卡片会"自己转正"，比不吸更莫名其妙）。
 * ★ 结果过一遍 `normalizeAngle`：`Math.round(-180 / 15) * 15 = -180`，
 *   而 `-180` 在我们的约定里要写成 `180`。
 */
export function snapAngle(deg: number, step: number = ROTATE_SNAP_STEP): number {
  if (!(step > 0)) return normalizeAngle(deg);
  return normalizeAngle(Math.round(deg / step) * step);
}

/**
 * 把**世界坐标**里的一次位移投影到**卡片自己的坐标轴**上（T7.06）。
 *
 * ★ 只有旋转过的卡片用得到，但少了它缩放会明显不对：一张转了 45° 的卡，
 *   它的"右边"在屏幕上指向右下，而 `resizedRect` 收的 `(dx, dy)` 是**世界轴**上的 ——
 *   直接把世界位移喂进去，用户拖的是屏幕上那条边，卡片动的却是它自己那条边，
 *   表现就是"手柄不跟手，还往旁边跑"。转过 90° 时最夸张：拖右边会变成拖下边。
 * ★ 用旋转的**逆变换**（转 `-deg`）就够了，不需要另一套 `resizedRect`：
 *   缩放的全部几何本来就活在"卡片自己的坐标系"里，把指针位移翻译过去，其余一字不改。
 * ★ `deg === 0` 时原样返回（绝大多数卡片），不白算两次三角函数 ——
 *   这条早退也保证了"没转过的卡片缩放行为与 T7.06 之前逐比特相同"。
 */
export function localDelta(dx: number, dy: number, deg: number): Point {
  if (deg === 0) return { x: dx, y: dy };
  const rad = (-deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** 方向键微移的方向与步长；不是方向键则返回 `null` */
export function nudgeDelta(key: string, large: boolean): Point | null {
  const amount = large ? NUDGE_STEP.large : NUDGE_STEP.small;
  switch (key) {
    case 'ArrowLeft':
      return { x: -amount, y: 0 };
    case 'ArrowRight':
      return { x: amount, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -amount };
    case 'ArrowDown':
      return { x: 0, y: amount };
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 控制器
// ─────────────────────────────────────────────────────────────

export type DragKind = 'move' | 'resize' | 'rotate';

export interface DragStart {
  kind: DragKind;
  /** 世界坐标起点 */
  origin: Point;
  /** 起始几何（多选移动 = 多张；缩放 / 旋转 = 一张） */
  rects: readonly CardRect[];
  /** 缩放手柄方位（`kind === 'resize'` 时必填） */
  handle?: ResizeHandle | null;
  /**
   * 卡片当前的旋转角（度，缺席当 `0`）。
   *
   * ★ 两种手势都读它，读的是**同一个数**："卡片此刻转了多少"。
   *   `resize` 用它把指针位移投影到卡片自己的坐标轴（见 `localDelta`），
   *   `rotate` 用它当角位移的**基准** —— 于是从一张已经歪着的卡片继续转，
   *   手感与从正的开始转完全一样。
   */
  angle?: number;
  /**
   * 网格吸附（T3.11 / `F5-02`）。只在 `kind === 'move'` 时生效，缺席 = 不吸。
   *
   * ★ 是拖动**开始那一刻**的设置快照：拖动途中即便用户在别处改了开关，
   *   也不该让手里这张卡突然跳一格（那样只会让人以为"白板自己动了"）。
   */
  grid?: GridSnapConfig;
  /**
   * 智能参考线（T3.12 / `F5-03`）。同样只在 `kind === 'move'` 时生效，缺席 = 不对齐。
   *
   * `others` 是拖动**开始那一刻**的邻近卡片快照：拖动期间模型不落盘（见文件头），
   * 所以这份快照在整个手势里都有效，不必逐帧重算。
   */
  align?: AlignConfig;
}

export interface DragModifiers {
  /** ⇧：缩放时等比 */
  shift?: boolean;
  /** Alt：缩放时从中心 */
  alt?: boolean;
  /** Ctrl：临时反转网格吸附开关（T3.11）—— 开着变不吸、关着变吸 */
  ctrl?: boolean;
}

export interface DragControllerOptions {
  /**
   * 拖动中的预览：只写 DOM。
   *
   * ★ `guides` 与 `rects` 必然来自**同一次** `update()`：拆成两个回调的话，
   *   总会有那么一帧是"卡片已经吸过去了、参考线还画在旧位置"（与下面
   *   `BoardView` 把预览与连线合并成一次提交是同一条理由）。
   */
  preview(rects: readonly CardRect[], guides: SmartGuides): void;
  /**
   * 旋转预览：只写 DOM 上的 `transform`。
   *
   * ★ 是**可选**能力：不提供时旋转手势仍然能算（`update` 照样返回 `true`），
   *   只是屏幕上不动 —— 这让"只想测几何"的调用方（与既有的测试）不必为一个
   *   与它们无关的手势补一个空实现。
   */
  previewRotation?(cardId: string, degrees: number): void;
  /** 提交并返回"是否真的改了"；返回 false 时控制器会自己 `resync()` */
  commit(rects: readonly CardRect[], label: string): boolean;
  /**
   * 提交旋转并返回"是否真的改了"（T7.06）。缺席 = 这次旋转作废（会 `resync()`）。
   *
   * ★ 与 `commit` 分成两个回调而不是加一个可选参数：调用方一眼能看出
   *   "几何提交"与"角度提交"是两条路，不必在实现里先判断"这次是哪种"。
   */
  commitRotation?(cardId: string, degrees: number): boolean;
  /** 让视图从模型重新同步 DOM（取消拖动 / 提交无变化时用） */
  resync(): void;
  /** 阈值（世界坐标 px） */
  threshold?: number;
}

interface DragSession {
  kind: DragKind;
  origin: Point;
  rects: CardRect[];
  handle: ResizeHandle | null;
  /** 卡片开始拖时已经转了多少（度）。`resize` 用来投影位移，`rotate` 用来当基准 */
  angle: number;
  /** 当前旋转角（度）；只有 `kind === 'rotate'` 用得到，`finish()` 提交的就是它 */
  rotation: number;
  /** 是否已越过阈值 —— 没越过就只是一次点击，不该提交、也不该 resync */
  active: boolean;
  last: CardRect[];
  /** 网格吸附配置；`null` = 这次拖动不吸（缩放 / 调用方未提供） */
  grid: GridSnapConfig | null;
  /** 智能参考线的对齐目标；`null` = 这次拖动不对齐（缩放 / 调用方未提供） */
  align: AlignConfig | null;
  /**
   * 起始包围盒（网格吸附的锚点）。
   *
   * 在 `begin()` 里算一次就存下来，而不是每次 `update()` 现算：一整段拖动里它**恒定**，
   * 每帧重算既浪费（`O(选中数)`）又给了"锚点漂移导致卡片缓慢走位"的可乘之机。
   */
  originBox: Rect | null;
}

export class DragController {
  private readonly options: DragControllerOptions;
  private readonly threshold: number;
  private session: DragSession | null = null;

  constructor(options: DragControllerOptions) {
    this.options = options;
    this.threshold = options.threshold ?? DRAG_THRESHOLD_PX;
  }

  get isActive(): boolean {
    return this.session !== null;
  }

  /** 是否真的在拖（越过阈值）。决定"这次交互要不要提交" */
  get isDragging(): boolean {
    return this.session?.active ?? false;
  }

  begin(start: DragStart): void {
    this.session = {
      kind: start.kind,
      origin: start.origin,
      rects: start.rects.map((rect) => ({ ...rect })),
      handle: start.handle ?? null,
      angle: start.angle ?? 0,
      rotation: start.angle ?? 0,
      active: false,
      last: start.rects.map((rect) => ({ ...rect })),
      // 缩放与旋转都不吸附：网格是"摆放位置"的约束，而改尺寸有自己的手柄锚点，
      // 两套约束叠在一起会让"拖右下角"变成"卡片跳着走"；旋转的吸附是 15° 那一档
      // （见 `rotateDegrees`），与网格毫无关系。
      grid:
        start.kind === 'move' && start.grid
          ? { enabled: start.grid.enabled, size: normalizeGridSize(start.grid.size) }
          : null,
      // 参考线同理只在移动时生效：缩放的锚点由手柄决定，"跟隔壁对齐"与"改尺寸"无关
      align: start.kind === 'move' ? (start.align ?? null) : null,
      originBox: boundsOf(start.rects),
    };
  }

  /** 返回是否产生了预览（越过阈值后才是 `true`） */
  update(point: Point, modifiers: DragModifiers = {}): boolean {
    const session = this.session;
    if (!session) return false;

    const dx = point.x - session.origin.x;
    const dy = point.y - session.origin.y;

    if (!session.active) {
      // 手抖不算拖动：否则"点一下卡片"也会写一次模型 + 记一条历史
      if (Math.hypot(dx, dy) < this.threshold) return false;
      session.active = true;
    }

    // 旋转走旁路（T7.06）：几何一个数字都不改，只有角度在动
    if (session.kind === 'rotate') {
      session.rotation = this.rotateDegrees(session, point, modifiers);
      this.options.previewRotation?.(session.rects[0].id, session.rotation);
      return true;
    }

    const moved = this.movedFrom(session, dx, dy, modifiers);
    session.last = moved.rects;
    this.options.preview(moved.rects, moved.guides);
    return true;
  }

  /**
   * 这一帧的几何：缩放 / 移动各一条路（旋转在上面已经分流出去了）。
   *
   * ★ 抽出来只为了让 `update()` 读起来还是"取位移 → 算几何 → 预览"三步 ——
   *   缩放的位移投影（`localDelta`）与移动的吸附修正各有一段话要说，
   *   摊在 `update()` 里会把那条主线淹掉。
   */
  private movedFrom(
    session: DragSession,
    dx: number,
    dy: number,
    modifiers: DragModifiers,
  ): { rects: CardRect[]; guides: SmartGuides } {
    const handle = session.handle;
    if (session.kind !== 'resize' || !handle) return this.moveRects(session, dx, dy, modifiers);

    // ★ 投影到卡片自己的坐标轴（见 `localDelta`）：转 90° 的卡片上，"右边"那个手柄
    //   在屏幕上就是**下面** —— 不投影的话指针往下拖、卡片却往右长（手柄甩开手指）
    const local = localDelta(dx, dy, session.angle);
    return {
      rects: session.rects.map((rect) =>
        resizedRect(rect, handle, local.x, local.y, {
          keepAspect: modifiers.shift === true,
          fromCenter: modifiers.alt === true,
        }),
      ),
      // 缩放从不给参考线（见 `moveRects` 的注释）：两套约束叠在一起会让手柄跳着走
      guides: EMPTY_GUIDES,
    };
  }

  /**
   * 旋转角（度）= 起始角 + `起点方向 → 当前方向`的角位移（T7.06）。
   *
   * ★ 用**方位角之差**而不是"把指针的 x 位移换算成角度"之类：手柄拖到哪，
   *   卡片就转到哪，指针与手柄之间没有累积漂移 —— 每一帧都从同一次 `origin` 重算，
   *   而不是在上一次的结果上继续加（那样会越拖越快、并且抖一下就回不去）。
   * ★ 差值必须过一遍 `normalizeAngle`：直接相减会在 ±180° 那一线跳变
   *   （`179° → -179°` 的差是 `-358°`），卡片会自己猛转一整圈。
   * ★ ⇧ 吸附到 15°（`ROTATE_SNAP_STEP`）：想"摆正 / 摆成 45° 斜排"时不必靠手感凑。
   * ★ 旋转中心取**起始矩形**的中心：拖动期间卡片几何不变（见 `schema.CardBase.rotation`），
   *   所以这个中心在整个手势里恒定 —— 每帧重算是在给自己创造"中心漂移"的机会。
   */
  private rotateDegrees(session: DragSession, point: Point, modifiers: DragModifiers): number {
    const center = rectCenter(session.rects[0]);
    const turned = normalizeAngle(
      pointerAngleDeg(center, point) - pointerAngleDeg(center, session.origin),
    );
    const degrees = normalizeAngle(session.angle + turned);
    return modifiers.shift === true ? snapAngle(degrees) : degrees;
  }

  /**
   * 移动的几何：先按网格/参考线修正"整组位移量"，再原样施加到每一张卡上。
   *
   * ★ 修正的是**位移量**而不是结果坐标，这是"组内相对位置不变"的关键 ——
   *   逐张吸附会把多选的一组卡片揉散（见 `model/snapping.ts` 的文件头）。
   *
   * Ctrl 在这里一次性决定两件事（见 `model/snapping.ts` 与 PRD）：
   *   * 网格：**反转**（开着变不吸、关着变吸）；
   *   * 参考线：**临时关闭** —— 对齐 Sketch 的惯例（按住 Ctrl 就是对不齐也不吸），
   *     用户想随手摆一张"就是不在任何线上"的卡时不必去改设置。
   */
  private moveRects(
    session: DragSession,
    dx: number,
    dy: number,
    modifiers: DragModifiers,
  ): { rects: CardRect[]; guides: SmartGuides } {
    const invert = modifiers.ctrl === true;
    const grid = session.grid;
    const snap = snapMove({
      origin: session.originBox,
      delta: { x: dx, y: dy },
      grid: grid && gridSnapActive(grid, invert) ? { enabled: true, size: grid.size } : null,
      align: invert ? null : session.align,
    });
    return { rects: movedRects(session.rects, snap.delta.x, snap.delta.y), guides: snap.guides };
  }

  /**
   * 松手提交。返回是否写入了模型。
   * 没越过阈值（只是点了一下）时什么都不做 —— 连 `resync()` 都省掉。
   */
  finish(): boolean {
    const session = this.session;
    this.session = null;
    if (!session || !session.active) return false;

    // 旋转提交的是角度，不是几何（T7.06）：与 `commit` 分开，历史记录才不会混
    if (session.kind === 'rotate') {
      const changed = this.options.commitRotation?.(session.rects[0].id, session.rotation) ?? false;
      // 提交被拒（视图没接这个能力 / 角度原样不变）时 DOM 上还留着预览 → 必须回滚视觉
      if (!changed) this.options.resync();
      return true;
    }

    const label = session.kind === 'resize' ? t('history.resize') : t('history.move');
    const changed = this.options.commit(session.last, label);
    // 提交被模型拒绝（比如几何原样不变）时，DOM 上还留着预览 → 必须回滚视觉
    if (!changed) this.options.resync();
    return true;
  }

  /** Esc 取消：把预览丢掉，从模型重画 */
  cancel(): void {
    const session = this.session;
    this.session = null;
    if (session?.active) this.options.resync();
  }
}
