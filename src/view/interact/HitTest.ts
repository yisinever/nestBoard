/**
 * 命中测试 + 卡片层事件委托（T1.30）—— `02 §8.2`「事件委托」。
 *
 * 两种命中方式，各有各的用处，**不能互相替代**：
 *
 * 1. **DOM 命中（委托）**：卡片层只挂 3 个监听器（`pointerdown` / `dblclick` /
 *    `contextmenu`），靠 `closest('[data-card-id], [data-column-id]')` 找到端点元素
 *    （`O21` 之后分栏也是端点，见 `resolveEndpoint`）。
 *    浏览器已经把"点在哪张卡上"算好了，还自带 `z-index`、`pointer-events`、
 *    圆角、`overflow` 等全部细节 —— 1000 张卡也只挂 3 个监听器，而不是 3000 个。
 * 2. **几何命中（`hitTest`）**：不依赖浏览器的场景才用 ——
 *    触屏/键盘操作、拖拽过程中指针落在被拖元素之外、以及单测。
 *
 * ★ 卡片 DOM 上的 ID 属性名来自 `constants.CARD_ID_ATTR`，与 `CardLayer` 写入时同名，
 *   避免"一处写 `data-card-id`，另一处写 `cardId`"这种沉默的漂移。
 *
 * ★ 不 import `obsidian`。几何部分可在 node 下单测；DOM 部分只在调用时触到全局对象。
 */

import { CARD_ID_ATTR, COLUMN_ID_ATTR } from '../../constants';
import type { Card } from '../../model/schema';
import {
  rectCenter,
  rectContainsPoint,
  rotatePoint,
  type Point,
  type Rect,
} from '../../util/geometry';
import type { Viewport } from '../../canvas/Viewport';

// ─────────────────────────────────────────────────────────────
// 几何命中（纯逻辑，可单测）
// ─────────────────────────────────────────────────────────────

/**
 * 命中世界坐标下最上层的一张卡（`z` 最大者胜）。
 *
 * 不假设入参已排序：调用方手里的数组可能刚被 `mutate` 改过，
 * 命中测试是"用户点哪张"的唯一依据，不能因为顺序假设而点错卡。
 *
 * ★ `rectOf` 是给"卡片被画在别处"准备的（T2.03 栏内滚动、T1.70 拖动中的预览）：
 *   模型里的坐标与屏幕上的位置差一个偏移。不传就是"模型即所见"。
 *   传错的表现是"卡片明明在眼前，点它却点不动"。
 */
export function hitTest(
  cards: readonly Card[],
  worldPoint: Point,
  rectOf?: (card: Card) => Rect,
): Card | null {
  let best: Card | null = null;
  for (const card of cards) {
    const rect = rectOf ? rectOf(card) : card;
    if (!hitsCardRect(rect, card.rotation ?? 0, worldPoint)) continue;
    if (!best || card.z >= best.z) best = card;
  }
  return best;
}

/**
 * 点在不在卡片上（T7.06）。`deg` 是卡片自身的旋转角。
 *
 * ★ 转过的卡片把**点反向转回去**，再按轴对齐矩形判定 —— 而不是把矩形转成外接矩形：
 *   后者会把卡片四角之外那块空白也算成"卡在身上"，于是"点空白处新建便签"
 *   会在转过的卡片旁边突然点不动（那几个角看起来明明是空的）。
 *   反着转点，判定与屏幕上的形状**逐像素一致**。
 * ★ 旋转中心 = 矩形中心（见 `schema.CardBase.rotation`），所以 `rectCenter` 就是
 *   正确的旋转中心；`rectOf` 已经带上了栏内滚动的偏移，于是转的也是"看到的那张卡"。
 */
function hitsCardRect(rect: Rect, deg: number, point: Point): boolean {
  const local = deg === 0 ? point : rotatePoint(point, rectCenter(rect), -deg);
  return rectContainsPoint(rect, local);
}

/** 屏幕坐标版的命中（内部做世界坐标换算，避免调用方重复写 `toWorld`） */
export function hitTestAtScreen(
  cards: readonly Card[],
  viewport: Viewport,
  screenPoint: Point,
  rectOf?: (card: Card) => Rect,
): Card | null {
  return hitTest(cards, viewport.toWorld(screenPoint), rectOf);
}

// ─────────────────────────────────────────────────────────────
// DOM 命中（事件委托）
// ─────────────────────────────────────────────────────────────

/**
 * 从事件目标向上找**端点元素** —— 卡片或分栏（`O21`）。
 * `root` 是画布容器：**必须**校验包含关系，否则嵌在其他视图里的卡片
 * （比如未来的只读嵌入 `BoardEmbed`）会被误判成本视图的命中。
 *
 * ★ 名字里的 "card" 是历史叫法：`O21` 之后分栏同样是连线的合法端点，两边共用
 *   这一个「向上找」的实现（`CardLayer` 与 `ColumnLayer` 各写一遍必然漂移）。
 * ★ 因此**它不等于"这是一张卡片"**：拿到元素之后还要读属性才知道是哪一种。
 *   要卡片 id 用 {@link resolveCardId}，要"卡片或分栏"用 {@link resolveEndpoint}。
 * ★ 多个祖先都带这两个属性时 `closest` 取**最近的**：栏里的卡片是自己的框，
 *   不会被误判成"它的那一栏"（卡片在 DOM 里其实是栏的兄弟，这条只是兜底）。
 */
export function resolveCardElement(
  target: EventTarget | null,
  root: HTMLElement,
): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const element = target.closest<HTMLElement>(`[${CARD_ID_ATTR}], [${COLUMN_ID_ATTR}]`);
  if (!element || !root.contains(element)) return null;
  return element;
}

/** 端点的种类（`O21`）：卡片，还是分栏 */
export type EndpointKind = 'card' | 'column';

/** 一个连线端点：id + 它是卡片还是分栏（id 在两者之间唯一，不必再带冗余字段） */
export interface ResolvedEndpoint {
  id: string;
  kind: EndpointKind;
}

/**
 * 从事件目标解析出**连线端点**（卡片或分栏，`O21`）。
 *
 * ★ 这是 ConnectController 唯一该用的入口：它要的既不是"卡片"，也不是"栏"，
 *   而是"指针底下那个可以拖出线的东西" —— 而这两种端点在连线的世界里是同一种东西。
 * ★ 返回 `kind` 而不是只返回 id：调用方需要知道去哪张表里查几何（`cards` / `columns`），
 *   靠 id 反查两个数组虽然也行，但那是每个调用点各写一遍的猜谜。
 */
export function resolveEndpoint(
  target: EventTarget | null,
  root: HTMLElement,
): ResolvedEndpoint | null {
  const element = resolveCardElement(target, root);
  if (!element) return null;
  const cardId = element.getAttribute(CARD_ID_ATTR);
  if (cardId) return { id: cardId, kind: 'card' };
  const columnId = element.getAttribute(COLUMN_ID_ATTR);
  return columnId ? { id: columnId, kind: 'column' } : null;
}

/**
 * 事件目标是否落在某个分栏的**自身背景**上（不含栏内卡片）。
 *
 * ★ 卡片与分栏在 DOM 里是**兄弟**（都直接挂在 `world` 下，靠 `z-index` 竞争），
 *   不是父子 —— 所以这个判定不会把"栏里的卡片"误判成"栏的背景"。
 *   这一点很重要：双击栏里的卡片必须进编辑态，双击栏背景才什么都不做。
 */
export function isInsideColumn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest(`[${COLUMN_ID_ATTR}]`) !== null;
}

/**
 * 只需要**卡片** ID 时的便捷版。
 *
 * ★ 与 {@link resolveEndpoint} 的分工不能混：读的是 `CARD_ID_ATTR` 这一个属性，
 *   所以分栏元素在这里返回 `null`（它确实不是卡片）。要"卡片或分栏"就必须走
 *   `resolveEndpoint`，否则分栏会被静默当成"背景"（`O21` 之前正是这样）。
 */
export function resolveCardId(target: EventTarget | null, root: HTMLElement): string | null {
  return resolveCardElement(target, root)?.getAttribute(CARD_ID_ATTR) ?? null;
}

// ─────────────────────────────────────────────────────────────
// 委托器
// ─────────────────────────────────────────────────────────────

/** 委托的三种事件。`pointermove`/`pointerup` 不在此列：拖拽期间由 window 统一接管 */
export const CARD_POINTER_PHASES = ['pointerdown', 'dblclick', 'contextmenu'] as const;

export type CardPointerPhase = (typeof CARD_POINTER_PHASES)[number];

export interface CardPointerDetail {
  phase: CardPointerPhase;
  cardId: string;
  /** 命中的卡片元素（`closest` 的结果），需要读卡片内部 DOM 时用 */
  element: HTMLElement;
  /** 屏幕坐标（相对画布容器左上角） */
  screen: Point;
  /** 世界坐标（已换算，控制器不必再碰 `Viewport`） */
  world: Point;
  original: MouseEvent;
}

export type CardPointerHandler = (detail: CardPointerDetail) => void;

export interface CardEventDelegateOptions {
  /** 画布容器：既作为监听宿主，也作为坐标原点与包含关系校验的边界 */
  host: HTMLElement;
  viewport: Viewport;
}

/**
 * 卡片层事件委托：**一个事件类型一个监听器**，而不是每张卡一套。
 *
 * 同时它承担了"坐标换算"这件事：控制器拿到 `detail` 时屏幕/世界坐标都齐了，
 * 不必再各自 `getBoundingClientRect()` —— 那样每加一个控制器就多一次 layout 读。
 */
export class CardEventDelegate {
  private readonly host: HTMLElement;
  private readonly viewport: Viewport;
  private readonly handlers = new Map<CardPointerPhase, Set<CardPointerHandler>>();
  private readonly bound: Array<{ phase: CardPointerPhase; listener: EventListener }> = [];

  constructor(options: CardEventDelegateOptions) {
    this.host = options.host;
    this.viewport = options.viewport;

    for (const phase of CARD_POINTER_PHASES) {
      const listener: EventListener = (event) => this.dispatch(phase, event as MouseEvent);
      this.host.addEventListener(phase, listener);
      this.bound.push({ phase, listener });
    }
  }

  /** 订阅某一相位，返回退订函数 */
  on(phase: CardPointerPhase, handler: CardPointerHandler): () => void {
    let set = this.handlers.get(phase);
    if (!set) {
      set = new Set();
      this.handlers.set(phase, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  dispose(): void {
    for (const { phase, listener } of this.bound) this.host.removeEventListener(phase, listener);
    this.bound.length = 0;
    this.handlers.clear();
  }

  private dispatch(phase: CardPointerPhase, event: MouseEvent): void {
    // 只认主键：右键交给 contextmenu，中键留给平移（T1.20）
    if (phase === 'pointerdown' && event.button !== 0) return;

    const element = resolveCardElement(event.target, this.host);
    if (!element) return;
    const cardId = element.getAttribute(CARD_ID_ATTR);
    if (!cardId) return;

    const handlers = this.handlers.get(phase);
    if (!handlers || handlers.size === 0) return;

    const bounds = this.host.getBoundingClientRect();
    const screen = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const detail: CardPointerDetail = {
      phase,
      cardId,
      element,
      screen,
      world: this.viewport.toWorld(screen),
      original: event,
    };

    // 复制一份再派发：监听里退订不能影响本轮遍历
    for (const handler of [...handlers]) handler(detail);
  }
}
