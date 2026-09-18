/**
 * 卡片层：DOM 卡片渲染 + 视口裁剪 + DOM 复用池（T1.24 / T1.25 / T1.26）。
 *
 * 它是 02 §2 里**唯一可交互的内容层**，也是"1000 卡还能拖动"的性能主战场。
 * 三条设计约束都来自 02 §8.2：
 *
 * | 手段 | 本文件的落点 |
 * |---|---|
 * | 视口裁剪（外扩 200px） | `sync()` → `cardsIntersecting()`，屏幕外不创建 DOM |
 * | DOM 复用池（按类型回收） | `acquireNode()` / `releaseNode()` + `pool` |
 * | GPU 合成（单容器变换） | 本层**只写世界坐标**，平移缩放交给 `.nestboard-world` 的 transform |
 *
 * ★ 为什么卡片用 `left/top` 而不是给每张卡加 `translate3d`：
 *   后者会把每张卡提升为独立合成层，1000 卡 = 1000 个层，显存直接爆掉。
 *   正确做法是全层共用一个 `.nestboard-world` 容器做 `translate3d + scale`，
 *   卡片只在**内容变化时**才写一次 `left/top`，平移缩放期间一张卡都不动。
 *
 * ★ 模块约束：不 import `obsidian`，只用标准 DOM（不用 Obsidian 扩展的
 *   `createDiv` / `addClass` 等方法）—— 这样纯几何部分能在 node 下单测，
 *   整个文件也能在非 Obsidian 环境（如将来的嵌入渲染器）复用。
 *
 * ★ T1.32 起，卡片**内容**由 `cards/registry.ts` 的类型定义渲染，本层只提供骨架
 *   （定位 / 标题 / 选中态 / 复用池）。所以本层不能认识"便签卡"，
 *   只认识"注册表 + 一个内容槽位"。缺类型的卡片回落到类型占位。
 */

import {
  AUTO_HEIGHT_MAX_STEP,
  CARD_ID_ATTR,
  MIN_CARD_SIZE,
  RESIZE_HANDLE_ATTR,
  ROTATE_HANDLE_ATTR,
  cardDisplayHeight,
} from '../../constants';
import {
  CARD_TYPE_LABEL_KEY,
  type CardRenderContext,
  type CardTypeRegistry,
  type CardViewMode,
} from '../../cards/registry';
import type { CardRect } from '../../model/ops';
import type { BoardFile, Card, CardColor, CardType, HexColor } from '../../model/schema';
import {
  clipPathValue,
  scrollClip,
  scrolledRect,
  type ColumnScrollView,
} from '../../model/columnScroll';
import { accentColorValue, cardColorValue } from '../../util/color';
import { rectsIntersect, type Rect } from '../../util/geometry';
import { t } from '../../util/i18n';
import type { Viewport } from '../../canvas/Viewport';

/**
 * 8 个尺寸手柄的方位（T1.37）：四角 + 四边。
 *
 * 方位名就是 CSS 里的定位名（`nw` = 左上），拖动控制器按它决定"现在哪条边在动"。
 * 命名与 CSS 类名（`.nestboard-handle-nw`）共用同一份数组，避免两处各列一遍。
 */
export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type ResizeHandle = (typeof RESIZE_HANDLES)[number];

// ─────────────────────────────────────────────────────────────
// 纯逻辑（可在 node 环境单测，不依赖 DOM）
// ─────────────────────────────────────────────────────────────

/**
 * 卡片的世界坐标矩形。裁剪与命中共用同一份换算，避免"两处各写一遍"。
 *
 * ★ 高度走 {@link cardDisplayHeight}（`O31`）：**收起的卡片只有标题行那么高** ——
 *   框选、裁剪、命中要是还按模型里的 `height` 算，就会出现"点得到、看不见 / 看得见、框不中"。
 */
export function cardRect(card: Pick<Card, 'x' | 'y' | 'width' | 'height' | 'collapsed'>): Rect {
  return { x: card.x, y: card.y, width: card.width, height: cardDisplayHeight(card) };
}

/**
 * 按 `z` 升序排列（越大越靠上）。
 *
 * 同 `z` 时以 `id` 兜底，保证**排序结果稳定** —— 否则同一份文件在不同会话里
 * 可能渲染出不同的叠放次序，肉眼表现为"卡片自己换了层"。
 */
export function sortCardsByZ(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 卡片是否与给定世界矩形相交（裁剪判据）。
 *
 * ★ 这里的判据刻意用**模型**坐标、不叠栏内滚动偏移（T2.03）：滚动只是
 *   "把栏里的内容窗口挪一挪"，成员始终落在栏的矩形里 —— 用模型坐标裁剪，
 *   一栏在滚的时候里面那些卡片**一个都不会被回收**（它们本来就在屏幕上）。
 *   反过来按视觉坐标裁，滚一下就要把滚出窗口的卡片反复回收再挂回来，
 *   把复用池（T1.26）的收益在这条路径上全部浪费掉。
 */
export function isCardVisible(card: Card, viewRect: Rect): boolean {
  return rectsIntersect(cardRect(card), viewRect);
}

/**
 * 挑出与给定世界矩形相交的卡片（顺序保持不变）。
 *
 * 一个函数两处用，是刻意的：裁剪（"哪些要挂 DOM"）与框选（"哪些被选中"）
 * 必须是**同一套判据**，否则会出现"看得见却框不中"这种没法解释的 bug。
 *
 * ★ 框选要传 `rectOf`（视觉几何）：用户框的是**屏幕上看到的位置**，
 *   栏内滚动过的成员若按模型坐标判，会出现"框中了看不见的卡、看得见的却没框中"。
 */
export function cardsIntersecting(
  cards: readonly Card[],
  viewRect: Rect,
  rectOf?: (card: Card) => Rect,
): Card[] {
  if (!rectOf) return cards.filter((card) => isCardVisible(card, viewRect));
  return cards.filter((card) => rectsIntersect(rectOf(card), viewRect));
}

/**
 * 参与裁剪与命中的卡片 = 全部卡片 − 被收起编组的成员（O03）。
 *
 * ★ 抽成纯函数是为了**能单测**：`CardLayer` 的 DOM 部分要跑在 Obsidian 里，
 *   而这条判据错了极难肉眼发现 —— 少藏一张就是"有个分组收起了，屏上却还杵着一张卡，
 *   点它还会选中"（它已经不在任何一组的框里了，用户找不到它归谁管）。
 * ★ 传空集时**原样返回入参**（不复制）：这是绝大多数时候，而它每帧都会被调一次。
 */
export function visibleCardsOf(
  cards: readonly Card[],
  hidden: ReadonlySet<string>,
): readonly Card[] {
  if (hidden.size === 0) return cards;
  return cards.filter((card) => !hidden.has(card.id));
}

/** 矩形是否完全一致（用于"视口没动就不做任何事"的短路） */
function rectEquals(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// ─────────────────────────────────────────────────────────────
// DOM 渲染
// ─────────────────────────────────────────────────────────────

/**
 * 每种类型的池子上限。裁剪后大量卡片会同时离场，若无限缓存，
 * "逛遍整块 5000 卡白板"会把 5000 个无主节点留在内存里 —— 池子本身成了泄漏源。
 */
const MAX_POOL_PER_TYPE = 64;

/**
 * 搜索结果高亮闪一下的时长（ms，T2.09 / `F8-02`）。
 * 太短视线来不及移过去；太长会和选中框叠在一起，也让"连按 ⌘G 逐个看"时
 * 前后两处的高亮互相干扰
 */
const SEARCH_FLASH_MS = 1400;

interface MountedCard {
  readonly element: HTMLElement;
  /**
   * 当前卡片数据。**必须随每次重绘更新** —— `setBoard` 后模型里是全新的对象，
   * 若这里留着旧引用，"回收时读类型"这类操作就会对着一份过期数据做判断。
   */
  card: Card;
  /**
   * 上次渲染内容时的"指纹"（模式 + 内容序列化）。
   * 与当前指纹相同就**跳过重绘** —— 便签卡的正文是 Obsidian Markdown 渲染，
   * 一次改动事件就把所有可见卡片重渲一遍是不可接受的（`02 §8.2`）。
   */
  stamp: string | null;
  /**
   * 上一次渲染本卡时用的上下文。
   *
   * 留着它是为了 `remeasure()` —— 引用卡读完 Vault 后要重量一次高度，
   * 那一刻**不能**再 `createContext()`：那会在内容槽上再挂一个 `Component`，
   * 把原来那个挤掉（`cardComponents` 是 WeakMap，覆盖 = 永久泄漏一个已加载组件）。
   */
  context: CardRenderContext | null;
}

export interface CardLayerOptions {
  /** 卡片类型注册表（T1.32）。缺类型的卡片回落到类型占位 */
  registry: CardTypeRegistry;
  /** 每张卡此刻的呈现模式。参与指纹，因此模式一变就会重绘 */
  modeOf: (card: Card) => CardViewMode;
  /** 为本卡构造渲染上下文（视图注入 app / 路径 / Markdown 渲染器等能力） */
  createContext: (card: Card, contentEl: HTMLElement) => CardRenderContext;
  /**
   * 内容槽被清空 / 节点被回收前，让视图回收挂在槽上的资源。
   *
   * `createContext` 通常会在槽上挂一个卡片级 `Component`（`MarkdownRenderer`
   * 的内嵌组件都挂在它下面）。不提供这个回调的话，"滚一圈 1000 张卡"就等于
   * 泄漏 1000 个组件 —— 本层不认识 `Component`，所以只能把这件事交回给视图。
   */
  releaseContent?: (contentEl: HTMLElement) => void;
  /** 标题就地编辑提交（T1.40）。空串 = 用户清空了标题，照实写回 */
  commitTitle?: (cardId: string, title: string) => void;
  /**
   * 卡片色 → 这条底色上**读得清**的墨色（`O38` 的撞色标题带用）。
   *
   * ★ 必须由视图注入：卡片色可能是 `var(--color-red)`，CSS 算不出它的亮度 ——
   *   只有 DOM 能取到计算后的值（与 `EdgeRenderer` / `readPngPalette` 同一个坑）。
   * ★ 不给这个回调 = 标题字色交给样式表兜底（`--text-on-accent`），不会变成隐形字。
   */
  resolveInk?: (color: CardColor) => HexColor;
  /**
   * 量出内容比卡片更高（T1.38）。由视图写回模型 ——
   * 本层不认识 `BoardRepository`，也不该认识（`03 §7.2` 的依赖方向）。
   */
  onAutoHeight?: (cardId: string, height: number) => void;
  /**
   * 收起 / 展开这一张卡（`O31`）。由视图写回模型（与 `commitTitle` 同一条：
   * 本层不认识 `BoardRepository`）。**不传** = 标题行上那个小按钮不出现。
   */
  toggleCollapsed?: (cardId: string) => void;
  /**
   * 每类卡片的节点复用池上限（T3.22）。省略即 {@link MAX_POOL_PER_TYPE}。
   *
   * ★ 由视图按性能档位传进来：池子占的是**常驻内存**，手机上那是最稀缺的资源，
   *   而内存多少只有视图层问得到（它认识 `Platform` / `navigator`）。
   */
  maxPoolPerType?: number;
  /**
   * 无障碍（T3.26 / `02 §7`）。省略 = 不写任何 `aria-*`。
   *
   * ★ 可访问名由**外面**算好传进来（`labelOf`），而不是本层自己拼：
   *   名字的组成规则（类型 + 标题 + 状态）属于"文案"，要能在 node 下单测
   *   （见 `view/a11y.ts`）。本层继续只认识"卡片 + 一个字符串"。
   */
  a11y?: {
    /** 一张卡的可访问名。`state.selected` 由本层提供 —— 只有它知道现在选中的是谁 */
    labelOf: (card: Card, state: { selected: boolean }) => string;
    /** 操作提示节点的 `id`（`aria-describedby` 指向它） */
    hintId: string;
  };
}

export class CardLayer {
  private readonly host: HTMLElement;
  private readonly options: CardLayerOptions;

  /** 当前白板的全部卡片，已按 `z` 升序 */
  private cards: Card[] = [];

  /** 已挂载到 DOM 的卡片：`cardId → 节点`，同时充当"当前可见集合" */
  private readonly mounted = new Map<string, MountedCard>();

  /** 按类型回收的空闲节点池（T1.26） */
  private readonly pool = new Map<CardType, HTMLElement[]>();

  private lastViewRect: Rect | null = null;

  /** 搜索结果定位时"还没进场、等挂载后再闪"的那张卡（见 `flash`） */
  private flashTarget: string | null = null;

  /** 内容变了（换板 / 增删改）→ 下次 `sync()` 必须重绘已挂载的卡片 */
  private dirty = true;

  /**
   * 当前选中的卡片 id（T1.31）。
   *
   * 选中态**不进模型**：它是纯界面状态，关掉视图就该消失，绝不能写进 `.nboard`。
   * 但卡片层必须持有它 —— 否则"选中后平移一下再回来"的新挂载卡片会丢失选中外观。
   */
  private selected: ReadonlySet<string> = new Set();

  /**
   * 被过滤器判定为"不匹配"的卡片（T3.17 / T3.18）。
   *
   * ★ 只降不透明度，**不移除**：过滤是"帮我在几百张卡里找东西"，不是"把这些卡
   *   藏起来" —— 不匹配的那几张仍需留在原位提供上下文（"我要找的那张就在这堆里"），
   *   只是变淡。移除会让用户误以为卡片被删了，并且一旦过滤词改了就全屏重挂载。
   */
  private dimmed: ReadonlySet<string> = new Set();

  /**
   * 属于某个编组的卡片（T3.14）。给成员一个淡淡的标记，让"它们是一组"看得见 ——
   * 否则编组是**完全不可见**的（几何不变、层序不变），用户按了 `⌘G` 却看不到任何反馈。
   */
  private grouped: ReadonlySet<string> = new Set();

  /**
   * 被**收起的编组**里的卡片（O03）。
   *
   * ★ 与 `dimmed` / `grouped` 不是一回事：那两个只改外观，这一批要**真的从 DOM 里
   *   拿走**（"先别占地方"）。实现上不另立一套记账，而是在裁剪前把它们排除出候选集 ——
   *   于是 `reconcile` 的"离场"分支会照常把它们回收进池，展开时再照常挂载回来，
   *   与"滚出视口"复用同一条路径。
   * ★ 必须标脏：`sync()` 在"视口没动、内容没变"时直接返回，
   *   不标脏的话收起 / 展开要等用户平移一下才看得见。
   */
  private hidden: ReadonlySet<string> = new Set();

  /**
   * 分栏内滚动的可视状态（T2.03 / `F2-7-10`），由视图算好喂进来。
   *
   * ★ 本层不自己算偏移：它要的是"这一栏现在看到哪一段"，而那个值同时决定
   *   落点判定、插入线、连线锚点 —— 各算一份必然对不上（见 `model/columnScroll.ts`）。
   */
  private columnScroll: ReadonlyMap<string, ColumnScrollView> = new Map();

  /**
   * 当前**被滚动位移过**的卡片 id。
   *
   * 只在需要"把位移还回去"时才用到：一栏的内容变少 / 被折叠 / 卡片被拖出去之后，
   * 上一次的 `top` 必须写回模型值，否则卡片会永久偏在上面（下次重挂载才恢复）。
   */
  private readonly scrolled = new Set<string>();

  constructor(host: HTMLElement, options: CardLayerOptions) {
    this.host = host;
    this.options = options;
    this.host.classList.add('nestboard-card-layer');
  }

  /** 已挂载（可见）的卡片数量，供诊断面板与测试使用 */
  get renderedCount(): number {
    return this.mounted.size;
  }

  /** 当前生效的池子上限（T3.22）。坏值一律回落到常量，池子不该因为一个错参数而无限长 */
  private poolLimit(): number {
    const limit = this.options.maxPoolPerType;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
      return MAX_POOL_PER_TYPE;
    }
    return Math.floor(limit);
  }

  /** 池中空闲节点数（诊断用） */
  get pooledCount(): number {
    let total = 0;
    for (const nodes of this.pool.values()) total += nodes.length;
    return total;
  }

  /**
   * 换板 / 内容变更：更新数据源并标脏。
   *
   * 刻意**不做渲染** —— 渲染必须知道当前视口（要裁剪），而视口只有 `sync()` 拿得到。
   * 调用方改完数据后照常调用 `sync(viewport)` 即可，`dirty` 会保证重绘。
   */
  setBoard(board: BoardFile | null): void {
    if (!board) {
      this.clear();
      return;
    }
    this.cards = sortCardsByZ(board.cards);
    this.dirty = true;
    this.lastViewRect = null;
  }

  /**
   * 清空当前白板：所有可见卡片立刻回收进池（节点留着下次复用）。
   * 换板、视图卸载文件时调用 —— 不能等下一次 `sync()`，否则会短暂显示上一块板的卡片。
   */
  clear(): void {
    for (const entry of this.mounted.values()) {
      this.releaseNode(entry.card.type, entry.element);
    }
    this.mounted.clear();
    this.cards = [];
    this.dirty = true;
    this.lastViewRect = null;
  }

  /**
   * 每帧入口：按当前视口裁剪，挂载进场卡片、回收离场卡片。
   *
   * 视口未动且内容未变时直接返回 —— 平移缩放的绝大多数帧都不会走到 DOM 写操作，
   * 这正是"单容器变换、卡片零重排"能成立的前提（02 §8.2）。
   */
  sync(viewport: Viewport): void {
    const viewRect = viewport.visibleBounds();
    if (!this.dirty && rectEquals(viewRect, this.lastViewRect)) return;

    const forceApply = this.dirty;
    this.reconcile(viewRect, forceApply);

    this.lastViewRect = viewRect;
    this.dirty = false;
  }

  /** 内容变更但未换板时，显式标脏（`setBoard` 的轻量别名） */
  refresh(): void {
    this.dirty = true;
  }

  /**
   * 更新选中外观（T1.31）。
   *
   * ★ 只改 class，不改 `z-index`：选中态**不该**顺手把卡片提到最前 ——
   *   层序是数据（`card.z`），用户没按 ⌘⇧↑ 就不能变。
   * ★ 传进来的就是同一份 `Set` 引用（`SelectionModel` 里那个），所以本层不做拷贝；
   *   调用方每次都会给一个新的快照，不会出现"看着像新数据、其实是旧对象"的坑。
   */
  setSelection(ids: ReadonlySet<string>): void {
    this.selected = ids;
    const a11y = this.options.a11y;
    // 旋转手柄只在**单选**时浮出来（T7.06）：多选时"绕哪个中心转、每张转多少度"
    // 都没有唯一答案（见 `DragController` 的 rotate 分支），与其猜一个不如不给。
    // 尺寸手柄不受影响 —— 它们本来就不支持多选缩放（T1.37）。
    const sole = ids.size === 1;
    for (const [id, entry] of this.mounted) {
      const selected = ids.has(id);
      entry.element.classList.toggle('is-selected', selected);
      entry.element.classList.toggle('is-sole-selected', selected && sole);
      // 选中是**可访问名的一部分**（"便签卡：周会（已选中）"，T3.26）——
      // 读屏用户看不到蓝框，这句话是他唯一能知道"我选上没选上"的地方。
      // ★ 选一次就重写一次，不做"只在变化时写"的优化：这里要省的是
      //   "视图与渲染层各自维护一份选中快照"那种会差一拍的复杂度，
      //   而写一个字符串的开销远小于那个 bug 的排查成本
      if (a11y) entry.element.setAttribute('aria-label', a11y.labelOf(entry.card, { selected }));
    }
  }

  /**
   * 更新"被过滤掉"的卡片外观（T3.17 / T3.18）。
   *
   * 与 `setSelection` 同一套写法：只改 class、只碰已挂载的节点，新挂载的在
   * `applyCard` 里补。传进来的是视图算好的快照。
   */
  setDimmed(ids: ReadonlySet<string>): void {
    this.dimmed = ids;
    for (const [id, entry] of this.mounted) {
      entry.element.classList.toggle('is-dimmed', ids.has(id));
    }
  }

  /** 更新"属于编组"的卡片外观（T3.14）。与 `setDimmed` 同一套写法 */
  setGrouped(ids: ReadonlySet<string>): void {
    this.grouped = ids;
    for (const [id, entry] of this.mounted) {
      entry.element.classList.toggle('is-grouped', ids.has(id));
    }
  }

  /**
   * 更新"屏幕上不存在的卡片"（收起编组的成员 O03、收起分栏的成员 `O16`）：
   * 它们将不再挂载到 DOM。
   *
   * ★ 只标脏、不立即动手：真正的取舍发生在 `sync()` 的裁剪里，
   *   这样才能保证"进场 / 离场"永远只有一处判断（见 `reconcile` 的注释）。
   * ★ 传进来的就是视图算好的快照（`BoardView.hiddenCardIds`），本层不自己算 ——
   *   命中、框选、连线也都要问同一个问题，答案只能有一份。
   */
  setHidden(ids: ReadonlySet<string>): void {
    if (ids === this.hidden) return;
    this.hidden = ids;
    this.dirty = true;
  }

  /** 当前被隐藏的卡片 id（收起编组 / 收起分栏；诊断 / 单测用） */
  get hiddenIds(): ReadonlySet<string> {
    return this.hidden;
  }

  /**
   * 搜索结果定位后的短暂高亮（T2.09 / `F8-02`）。
   *
   * ★ 还没挂载的卡片要**记下来**而不是直接放弃：视图刚把视口移过去，本帧的
   *   `sync()` 还没跑，卡片此刻确实不在 DOM 里 —— 直接查 `mounted` 会找不到节点，
   *   高亮静默丢失，用户看到的是"跳过去了，但那张卡什么标记都没有"。
   *   记成待办，等它进场时在 `applyCard` 里补上（视口外 → 视口内本来就要走那一趟）。
   */
  flash(cardId: string): void {
    const entry = this.mounted.get(cardId);
    if (!entry) {
      this.flashTarget = cardId;
      return;
    }
    this.playFlash(entry.element);
  }

  private playFlash(element: HTMLElement): void {
    // 连续两次定位到同一张卡时要能**重放**：先摘掉 class、强制重排、再加回去。
    // 少了这一步，第二次按 ⌘G 回到同一张卡上时按钮毫无反应（动画只在第一次生效）
    element.classList.remove('is-search-hit');
    void element.offsetWidth;
    element.classList.add('is-search-hit');
    element.ownerDocument.defaultView?.setTimeout(
      () => element.classList.remove('is-search-hit'),
      SEARCH_FLASH_MS,
    );
  }

  /**
   * 更新"栏内滚动"的可见状态（T2.03 / `F2-7-10`）。
   *
   * 每帧都可能被调用（滚轮每滚一下一次），所以**只写受影响的卡片**，
   * 而且只写 `top` / `clip-path` 两个值 —— 见 `applyColumnScroll`。
   */
  setColumnScroll(views: ReadonlyMap<string, ColumnScrollView>): void {
    this.columnScroll = views;
    this.applyColumnScroll();
  }

  /**
   * 异步内容落地后重新量一次高度（T1.38 × T1.44）。
   *
   * 引用卡的高度取决于"读到的正文有多少" —— 而读到正文是异步的，`render()` 返回时
   * 槽位还是空的，那一刻量出来是 0。卡片定义画完真实内容后通过
   * `CardRenderContext.contentReady()` 喊一声，本方法就用**同一份上下文**重量一次。
   */
  remeasure(cardId: string): void {
    const entry = this.mounted.get(cardId);
    if (!entry?.context) return;
    const content = entry.element.querySelector<HTMLElement>('.nestboard-card-content');
    if (!content) return;
    this.measureContent(entry, content, entry.context, this.options.modeOf(entry.card));
  }

  /** 卸载：已挂载与池中的节点全部从 DOM 摘除，释放引用 */
  dispose(): void {
    this.clear();
    for (const nodes of this.pool.values()) {
      for (const node of nodes) node.remove();
    }
    this.pool.clear();
  }

  // ── 核心：裁剪 → 增删 ────────────────────────────────────

  /**
   * 参与裁剪的卡片 = 全部卡片 − 被收起编组的成员（O03）。
   * 判据本身在 `visibleCardsOf`（纯函数、已单测），这里只负责把"藏哪些"传进去。
   */
  private selectable(): readonly Card[] {
    return visibleCardsOf(this.cards, this.hidden);
  }

  private reconcile(viewRect: Rect, forceApply: boolean): void {
    // 裁剪判据只此一处（`cardsIntersecting` 已单测），避免"渲染用一种、回收用另一种"。
    // ★ 收起编组的成员在**裁剪之前**就被排除（O03）：它们既不该挂载，也不该占着
    //   "已挂载"这张表 —— 命中与框选问的是同一份 DOM / 集合，藏起来要藏得干净。
    const visible = cardsIntersecting(this.selectable(), viewRect);
    const visibleIds = new Set(visible.map((card) => card.id));

    // 1) 离场：已挂载但不再可见 → 回收
    for (const [id, entry] of this.mounted) {
      if (!visibleIds.has(id)) {
        this.releaseNode(entry.card.type, entry.element);
        this.mounted.delete(id);
        this.scrolled.delete(id);
      }
    }

    // 2) 进场 / 重绘：按 `z` 顺序遍历，保证同层级的叠放稳定
    //    （`zIndex` 才是叠放主依据；遍历顺序只是给同 `z` 的卡片一个确定次序）
    for (const card of visible) {
      const existing = this.mounted.get(card.id);
      if (existing) {
        if (forceApply) {
          existing.card = card;
          this.applyCard(existing);
        }
        continue;
      }

      const element = this.acquireNode(card.type);
      const entry: MountedCard = { element, card, stamp: null, context: null };
      this.mounted.set(card.id, entry);
      this.applyCard(entry);
      this.host.appendChild(element);
    }
  }

  // ── DOM 复用池（T1.26） ──────────────────────────────────

  private acquireNode(type: CardType): HTMLElement {
    const reused = this.pool.get(type)?.pop();
    return reused ?? this.createNode(type);
  }

  /**
   * 回收节点。超上限的节点直接丢弃 —— 池子是**缓存**不是仓库，
   * 缓存无界就等于把内存泄漏伪装成优化。
   */
  private releaseNode(type: CardType, element: HTMLElement): void {
    element.remove();
    // 类型定义与视图注入的资源都挂在**内容槽**上（`render` 收到的就是这个元素），
    // 所以这里必须找内容槽、而不是拿卡片根元素去清理 —— 否则会对着错误的 DOM 做清理
    const content = element.querySelector<HTMLElement>('.nestboard-card-content');
    if (content) {
      // 先让类型定义解绑自己的东西（事件、异步任务），再让视图回收卡片级组件
      this.options.registry.destroy(content, type);
      this.options.releaseContent?.(content);
    }

    const nodes = this.pool.get(type) ?? [];
    if (!this.pool.has(type)) this.pool.set(type, nodes);
    if (nodes.length >= this.poolLimit()) return;
    this.resetNode(element);
    nodes.push(element);
  }

  /** 复位到"干净"状态：只保留骨架，卡片私有内容由 `applyCard` 重新填 */
  private resetNode(element: HTMLElement): void {
    element.removeAttribute(CARD_ID_ATTR);
    element.removeAttribute('data-locked');
    // 可访问名也必须清掉（T3.26）：池里复用的节点带着上一张卡的名字，
    // 下一次 `applyCard` 之前若被读屏摸到，念出来的就是**别的卡片**的标题
    element.removeAttribute('aria-label');
    element.classList.remove(
      'is-title-hidden',
      'is-selected',
      'is-sole-selected',
      'is-editing-title',
      'has-accent',
      // 过滤 / 编组标记也必须清掉（T3.14 / T3.17）：池里复用的节点带着上一次的
      // 状态，下一张卡会在完全无关的时候变淡、或者莫名显示成"编组成员"
      'is-dimmed',
      'is-grouped',
      // 搜索高亮也必须清掉（T2.09）：池里复用的节点带着上一次的 `is-search-hit`，
      // 下一张卡会在完全无关的时候亮一下
      'is-search-hit',
    );
    // 栏内滚动的裁剪必须清掉（T2.03）：留着它，下一张用这个节点的卡片
    // 会莫名缺掉一角 —— 而"回收池最脏的那种 bug"就是这种"内容对了但样子不对"
    element.style.clipPath = '';
    // 旋转也是内联样式（T7.06），同样必须清掉：池里复用的节点带着上一张卡的
    // `rotate()`，下一张会在完全无关的时候歪着出场
    element.style.transform = '';
    // 颜色是内联 CSS 变量，回收时必须一并清掉 —— 否则下一张用这个节点的卡片
    // 会先闪一下上一张的颜色（池子复用最容易漏的一类脏数据）
    element.style.removeProperty('--nestboard-card-color');
    element.style.removeProperty('--nestboard-card-accent');
    const title = element.querySelector<HTMLElement>('.nestboard-card-title');
    if (title) {
      title.textContent = '';
      title.classList.remove('is-empty');
    }
    const icon = element.querySelector<HTMLElement>('.nestboard-card-icon');
    if (icon) {
      icon.textContent = '';
      icon.classList.add('is-empty');
    }
    // 卡面标记与标题格式（`O38`）也走内联 CSS 变量，同样是**池子复用最容易漏的脏数据**
    for (const name of [
      '--nestboard-card-title-weight',
      '--nestboard-card-title-style',
      '--nestboard-card-title-decoration',
      '--nestboard-card-title-ink',
      '--nestboard-card-ink',
    ]) {
      element.style.removeProperty(name);
    }
    const input = element.querySelector<HTMLInputElement>('.nestboard-card-title-input');
    input?.remove();
    element.classList.remove('is-editing-title', 'is-collapsed');
    // 骨架级的清空；类型定义自己的 class / dataset 由 `destroy()` 负责摘掉
    const content = element.querySelector<HTMLElement>('.nestboard-card-content');
    if (content) {
      content.textContent = '';
      delete content.dataset.placeholder;
    }
  }

  // ── 单卡渲染 ─────────────────────────────────────────────

  private createNode(type: CardType): HTMLElement {
    const element = document.createElement('div');
    element.className = 'nestboard-card';
    element.dataset.cardType = type;

    // 无障碍（T3.26 / `02 §7`）：
    //  * `role="group"` 而不是 `button` —— 卡片里有输入框（待办勾选框、链接地址），
    //    写成 `button` 会把内部控件"吃掉"，读屏再也点不进去；
    //  * `tabindex="0"` 是"Tab 在卡片间移动焦点"的**唯一**实现方式：这张卡必须
    //    本身可聚焦，没有别的键盘入口能到达它；
    //  * `aria-describedby` 指向画布上那行隐藏提示（"按 Enter 编辑…"）——
    //    挂在这里而不是每张卡各写一句，是因为所有卡片的提示**逐字相同**。
    element.setAttribute('role', 'group');
    element.setAttribute('tabindex', '0');
    if (this.options.a11y) element.setAttribute('aria-describedby', this.options.a11y.hintId);

    const header = document.createElement('div');
    header.className = 'nestboard-card-header';
    // 卡面标记（`O38`）：在**标题前面**留一格（emoji，一张卡最多一个）。
    // ★ 常驻 DOM、空的时候由 `is-empty` 收起来 —— 与手柄同理：增删节点会让
    //   `querySelector` 的缓存与 CSS 选择器都变得不可靠。
    const icon = document.createElement('span');
    icon.className = 'nestboard-card-icon is-empty';
    // 装饰性符号：读屏念出那个 emoji 的名字对听的人没有任何帮助
    icon.setAttribute('aria-hidden', 'true');
    header.appendChild(icon);
    const title = document.createElement('span');
    title.className = 'nestboard-card-title';
    header.appendChild(title);
    // 收起 / 展开（`O31`）：与分栏的折叠按钮同一套做法（一个带字形的小按钮）。
    // ★ 卡片 id 是 `applyCard` 才写上去的，所以这里**点的时候现读**属性，而不是闭包捕获
    //   （`createNode` 拿不到 card，而每个复用的节点都要能服务下一张卡）。
    // ★ 按钮挂在**标题行**里：没有标题行（`showTitle: false` / 空标题）时它跟着那行一起隐藏，
    //   那种卡片仍可右键 →「收起卡片」。
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'nestboard-card-collapse';
    collapse.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
    collapse.addEventListener('click', (event: Event) => {
      event.stopPropagation();
      const id = element.getAttribute(CARD_ID_ATTR);
      if (id) this.options.toggleCollapsed?.(id);
    });
    header.appendChild(collapse);
    element.appendChild(header);

    // 内容槽：本层只管骨架，真正的富内容由 `cards/` 的类型定义填（T1.32），
    // 未注册的类型由 `renderContent` 回落到类型占位。
    const content = document.createElement('div');
    content.className = 'nestboard-card-content';
    element.appendChild(content);

    // 左侧强调色条（T1.39）。常驻 DOM、由 class 决定显隐：
    // 增删节点会让 `querySelector` 的缓存与 CSS 选择器都变得不可靠
    const accent = document.createElement('div');
    accent.className = 'nestboard-card-accent';
    element.appendChild(accent);

    // 尺寸手柄（T1.37）：**一次性建好 8 个**，而不是选中时再插。
    // 手柄要先存在于 DOM 里，命中测试才可能摸到它；"选中才建"会让第一次拖动
    // 慢一帧（要先建节点再等下一帧的 pointerdown 才对得上），手感直接发飘。
    for (const handle of RESIZE_HANDLES) {
      const node = document.createElement('div');
      node.className = `nestboard-handle nestboard-handle-${handle}`;
      node.setAttribute(RESIZE_HANDLE_ATTR, handle);
      element.appendChild(node);
    }

    // 旋转手柄（T7.06）：**一个**，挂在卡片上方。同样常驻 DOM（理由同上），
    // 显隐交给 CSS —— 它只在"单选的、没锁的"卡片上出现。
    // ★ 不复用 `.nestboard-handle` 那个类：那个类被 `is-selected:not(.is-locked)`
    //   一条规则统管，跟着它走的话多选时也会冒出来（而多选转不了，见 `setSelection`）。
    const rotate = document.createElement('div');
    rotate.className = 'nestboard-rotate-handle';
    rotate.setAttribute(ROTATE_HANDLE_ATTR, '');
    // `title` 是给鼠标用户的（悬停看一眼就知道这是干嘛的），
    // `aria-label` 是给读屏的 —— 手柄是纯装饰性 `div`，不给名字就等于"抓不到"
    rotate.setAttribute('aria-label', t('card.rotateHandle'));
    rotate.title = t('card.rotateHandle');
    element.appendChild(rotate);

    return element;
  }

  private applyCard(entry: MountedCard): void {
    const { element, card } = entry;
    // 用常量写属性：命中测试 (`HitTest.resolveCardElement`) 读同一个名字，不许各写一份
    element.setAttribute(CARD_ID_ATTR, card.id);
    element.dataset.cardType = card.type;
    if (card.locked) element.dataset.locked = 'true';
    else element.removeAttribute('data-locked');

    // 世界坐标 → 只写这一次；平移缩放期间 world 容器负责变换，这里不再触碰
    const style = element.style;
    style.left = `${card.x}px`;
    style.top = `${card.y}px`;
    style.width = `${card.width}px`;
    // ★ `O31`：收起时只有标题行那么高。`cardDisplayHeight` 是**唯一**口径 ——
    //   几何那边（`cardRect` / `BoardView.toCardRect`）用的是同一个函数
    style.height = `${cardDisplayHeight(card)}px`;
    style.zIndex = String(card.z);

    // 旋转（T7.06 / `F2-00-10`）：绕**自身中心**转，`left/top/width/height` 一个都不动
    //（见 `schema.CardBase.rotation`）。`transform-origin` 由样式表钉成 `center`。
    // ★ 归零时写空串而不是 `rotate(0deg)`：`transform` 非 `none` 会给卡片造一个
    //   层叠上下文与一个独立合成层 —— 而 98% 的卡片从没转过，没必要为它们付这个代价
    //   （本层头注里"1000 卡不要一人一个层"说的是同一件事）。
    const rotation = card.rotation ?? 0;
    style.transform = rotation === 0 ? '' : `rotate(${rotation}deg)`;

    // 颜色（T1.39）：**写成 CSS 变量**而不是内联 background。
    // 背景、边框、强调色条要取同一个颜色，三处各写一遍内联样式必然漏掉一处；
    // 主题色给 `var(--color-*)`（深浅主题自动跟随），自定义色给 HEX。
    style.setProperty('--nestboard-card-color', cardColorValue(card.color));
    const accent = accentColorValue(card.accent);
    element.classList.toggle('has-accent', accent !== null);
    if (accent) style.setProperty('--nestboard-card-accent', accent);
    else style.removeProperty('--nestboard-card-accent');

    const title = element.querySelector<HTMLElement>('.nestboard-card-title');
    if (title && !element.classList.contains('is-editing-title')) {
      // ★ 收起时那一行的取值要问类型（`O34`）：有些卡的名字不在 `card.title` 上
      //   （链接卡的网页标题在 `content.title`），收起只留那一行时不接管就是一条空白。
      const text =
        card.collapsed === true ? this.options.registry.collapsedTitle(card) : card.title;
      title.textContent = text;
      // 空标题在显示态不画那行（否则每张卡顶部都悬着一条无意义的空白）
      title.classList.toggle('is-empty', text.length === 0);
    }

    // 卡面标记与标题整条格式（`O38`）：两项都**只在数据说有的时候写**
    //（缺省即"没有" —— 与 `rotation` / `collapsed` 同一条纪律）
    // ★ 这里读的是**卡级** `icon`，不是 `cards/cardIcon.cardIconOf` —— 这一格是
    //   **卡片外壳标题行**里那一格（便签在用）。白板卡的标记画在**它自己的内容**里
    //   （迷你档正中 / 展开档标题行左边，见 `cards/boardRef`），换成 `cardIconOf`
    //   会让白板卡的 emoji **画两遍**。
    const mark = card.icon ?? '';
    const iconEl = element.querySelector<HTMLElement>('.nestboard-card-icon');
    if (iconEl) {
      iconEl.textContent = mark;
      iconEl.classList.toggle('is-empty', mark.length === 0);
    }

    const look = card.titleStyle;
    // ★ 加粗**只在用户设过时才写**：标题本来是半粗的（样式表定的），
    //   无条件写 `normal` 会把所有卡的标题都压平（这是个会一眼看出来的回归）
    if (look?.bold === undefined) style.removeProperty('--nestboard-card-title-weight');
    else style.setProperty('--nestboard-card-title-weight', look.bold ? 'bold' : 'normal');
    style.setProperty('--nestboard-card-title-style', look?.italic === true ? 'italic' : 'normal');
    style.setProperty(
      '--nestboard-card-title-decoration',
      look?.underline === true ? 'underline' : 'none',
    );
    if (look?.ink) style.setProperty('--nestboard-card-title-ink', look.ink);
    else style.removeProperty('--nestboard-card-title-ink');

    // 撞色标题带要用的**墨色**（"这个底色上读得清"的深色或浅色）：主题色是
    // `var(--color-red)`，CSS 算不出它的亮度 ⇒ 只有视图能解析（`resolveInk` 注入，
    // 与脑图的 `resolveTheme` / 导出的 `readPngPalette` 是同一条思路）。
    const ink = this.options.resolveInk?.(card.color) ?? null;
    if (ink) style.setProperty('--nestboard-card-ink', ink);
    else style.removeProperty('--nestboard-card-ink');

    // 收起（`O31`）：class 收掉内容槽（样式表），高度在上面写 `style.height` 时已经压过
    const collapsed = card.collapsed === true;
    element.classList.toggle('is-collapsed', collapsed);
    const collapseButton = element.querySelector<HTMLElement>('.nestboard-card-collapse');
    if (collapseButton) {
      const key = collapsed ? 'menu.card.expand' : 'menu.card.collapse';
      collapseButton.textContent = collapsed ? '▸' : '▾';
      collapseButton.setAttribute('aria-expanded', String(!collapsed));
      collapseButton.setAttribute('aria-label', t(key));
      collapseButton.title = t(key);
    }

    // `showTitle: false` 时标题行整体隐藏（F2-00-9 的显示开关，T1.40）
    element.classList.toggle('is-title-hidden', !card.showTitle);
    // 新进场的卡片也要立刻带上选中外观（滚动回来后不能"忘了自己被选中"）
    element.classList.toggle('is-selected', this.selected.has(card.id));
    element.classList.toggle(
      'is-sole-selected',
      this.selected.has(card.id) && this.selected.size === 1,
    );
    // 锁定的卡片不显示尺寸手柄（T1.37 与 F2-00-6 的"锁定"是同一件事的两面）
    element.classList.toggle('is-locked', card.locked);
    // 图片卡的"取消边框"（2026-09-17）：底色、边框、阴影一起收掉，只留照片本身
    element.classList.toggle('is-borderless', card.showBorder === false);
    // 分栏里的卡片：不给旋转手柄（用户 2026-09-17："在分栏当中不应该可以旋转"）
    element.classList.toggle('is-in-column', card.columnId !== null);
    // 过滤（T3.17 / T3.18）与编组归属（T3.14）：新挂载的卡片也要立刻带上正确外观
    element.classList.toggle('is-dimmed', this.dimmed.has(card.id));
    element.classList.toggle('is-grouped', this.grouped.has(card.id));

    // 可访问名（T3.26）：新挂载的卡片立刻带上名字，读屏才念得出来。
    // ★ 标题改了也要跟着变，所以每次 `applyCard` 都重写一次（标题编辑就归它管）
    if (this.options.a11y) {
      element.setAttribute(
        'aria-label',
        this.options.a11y.labelOf(card, { selected: this.selected.has(card.id) }),
      );
    }

    // 栏内滚动（T2.03）会**改写**上面刚写的 `top`，必须紧跟着它做
    this.applyScrollFor(entry);
    this.renderContent(entry);

    // 搜索结果定位时这张卡还没进场（见 `flash`）：现在补上那次高亮
    if (this.flashTarget === card.id) {
      this.flashTarget = null;
      this.playFlash(element);
    }
  }

  // ── 栏内滚动（T2.03 / F2-7-10） ──────────────────────────

  /**
   * 只重写"受滚动影响"的那几张卡。
   *
   * ★ 不走 `applyCard`：那是"内容级"重绘（算 class、写 dataset、比指纹）。
   *   滚动每滚一下就要走一遍，那里每帧只该改 2 个 CSS 数字（同 `previewRects` 的道理）。
   */
  private applyColumnScroll(): void {
    for (const [id, entry] of this.mounted) {
      const columnId = entry.card.columnId;
      const view = columnId ? (this.columnScroll.get(columnId) ?? null) : null;
      // 与滚动无关的卡片（没栏 / 那栏装得下且自己也没被挪过）直接跳过
      if (!view && !this.scrolled.has(id)) continue;
      this.applyScrollFor(entry);
    }
  }

  /** 按当前栏内偏移把一张卡摆到**视觉**位置（模型值只在这里被换算） */
  private applyScrollFor(entry: MountedCard): void {
    const columnId = entry.card.columnId;
    const view = columnId ? (this.columnScroll.get(columnId) ?? null) : null;
    if (view) this.scrolled.add(entry.card.id);
    else this.scrolled.delete(entry.card.id);
    this.applyScrollTo(entry, view);
  }

  /**
   * 把"这一栏滚到哪了"落到 DOM。
   *
   * ★ 只碰 `top` 与 `clip-path`，不碰 `left/width/height`：
   *   栏内滚动是纯纵向的，横向多写一笔就可能和"卡片比栏还宽"这种情形打架。
   * ★ 偏移为 0 / 没有滚动时，`top` 必须**写回模型值**：卡片被拖出栏之后
   *   上一次的位移要真的还回去，否则它会永久偏在上面，直到重新挂载才复原。
   * ★ 完全看不见的卡片用 `clip-path` 而不是 `display: none`：后者量出
   *   宽高为 0，自动高度（T1.38）会把卡片压扁，滚回来看见一张空卡。
   */
  private applyScrollTo(entry: MountedCard, view: ColumnScrollView | null): void {
    const { element, card } = entry;
    const style = element.style;
    if (!view || view.offset <= 0) {
      style.top = `${card.y}px`;
      style.clipPath = '';
      return;
    }
    const visual = scrolledRect(cardRect(card), view.offset);
    style.top = `${visual.y}px`;
    style.clipPath = clipPathValue(scrollClip(visual, view.viewport));
  }

  /**
   * 取某张卡的内容槽元素。
   *
   * ★ 菜单动作往槽里下发指令时要用它（如"编辑说明文字"）：卡片容器本身是
   *   复用池里借出来的，只有渲染层知道此刻是哪个节点装着这张卡 ——
   *   视图若自己去 `querySelector`，卡片一被回收就会指到别人身上。
   */
  contentElementOf(cardId: string): HTMLElement | null {
    return (
      this.mounted.get(cardId)?.element.querySelector<HTMLElement>('.nestboard-card-content') ??
      null
    );
  }

  /**
   * 就地编辑**标题行**（T1.40，右键「编辑标题」）。
   *
   * 为什么不用 `contenteditable`：它会把整段 HTML 暴露给 IME，中文输入法下
   * 组词过程中一旦重排（`applyCard` 会写 `textContent`）候选框就飞了。
   * 一个真 `<input>` 没有这个问题，还白拿一个"Esc 放弃、Enter 提交"的原生语义。
   *
   * ★ 便签 / 同步便签的双击编辑走的是**编辑态里的标题框**（O22，见 `cards/note.ts`），
   *   不再走这里；这一条只剩右键菜单「编辑标题」在用 —— 语义就是"只把名字改了"。
   *
   * ★ **预填**（`O37`）：文件卡（`.md`）/ 白板卡（`.nboard`）的标题**就是文件名**，它们的
   *   `card.title` 通常是空的 —— 输入框空着而卡面上明明写着名字时，用户按一下 `Enter`
   *   什么都不会发生，像是"编辑标题坏了"。视图把当前主名算好传进来（`options.initial`）。
   *
   * @returns 是否**真的**开了标题输入框。`false` = 这张卡没挂载（视口外）、只读，
   *          或已经在编辑标题了。
   */
  editTitle(cardId: string, options: { initial?: string } = {}): boolean {
    const entry = this.mounted.get(cardId);
    if (!entry || entry.card.locked) return false;
    const element = entry.element;
    const title = element.querySelector<HTMLElement>('.nestboard-card-title');
    if (!title || element.classList.contains('is-editing-title')) return false;

    /**
     * 输入框往哪儿放 —— **优先"卡外那行名字"**。
     *
     * ★ 迷你白板卡（`O18`）的名字画在卡**外面**正下方（`cards/boardRef.ts` 的
     *   `createMiniName`），而卡片自己的标题行本来就是收起的（`showTitle` 默认 `false`）。
     *   把输入框塞进卡内的话，用户看到的是"输入框冒在方块里"、而卡外那行名字还在原地
     *   没动 —— 用户 2026-09-16 的原话："编辑标题应该直接改迷你形式底部的文字，
     *   不要在迷你卡片内部出现输入框"。
     * ★ 找不到那个名字元素（别的类型、或内容还没渲染）就退回卡内标题行 ——
     *   两条路都要能编辑，只是位置不同。
     */
    const host = element.querySelector<HTMLElement>('.nestboard-board-ref-mini-title') ?? title;
    const inCard = host === title;
    if (inCard) {
      // ★ `O36`：空标题的卡片上，`is-empty` 会让**整行**一起藏起来
      //   （`styles.css` 的 `.nestboard-card-header:has(> .is-empty)`）—— 只摘 `is-title-hidden`
      //   的话，用户点了「编辑标题」却什么都看不见，表现就是"没反应"。结束时 `applyCard`
      //   会照原样重算这个类，不必在这里复原。
      element.classList.remove('is-title-hidden');
      title.classList.remove('is-empty');
    } else {
      // 卡外那行名字平时是装饰（`pointer-events: none`）：编辑时把它放行，并做上记号
      host.classList.add('is-editing');
    }
    element.classList.add('is-editing-title');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nestboard-card-title-input';
    input.value = options.initial ?? entry.card.title;
    // 空标题时给一行灰字：双击进来的用户此刻只看见一张卡和一个光标，
    // 得有个东西告诉他"这里能写字"（标题栏自带 `is-empty` 收起，提示不会留在画面上）
    input.placeholder = t('card.title.placeholder');
    input.setAttribute('aria-label', t('card.title.placeholder'));
    // 标题栏是窄条，原生 `size` 会把它撑成几百 px，交给 CSS 控制宽度
    // ★ 记下原来那行字：卡外那行名字**不是 `applyCard` 画的**（它在内容槽里，由
    //   `cards/boardRef.ts` 渲染），而 `applyCard` 只在内容指纹变了时才重画 ——
    //   按 `Esc` 放弃时得把它原样还回去，不然名字就空在那儿了。
    const previousText = host.textContent ?? '';
    host.textContent = '';
    host.appendChild(input);

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      element.classList.remove('is-editing-title');
      host.classList.remove('is-editing');
      input.remove();
      host.textContent = previousText;
      // 让 `applyCard` 重新接管标题显示（模型里的值才是唯一事实来源）。
      // 提交成功时模型变了 ⇒ 内容指纹也变了 ⇒ 它会把卡外那行名字重画成新名字
      this.applyCard(entry);
      if (commit && input.value !== entry.card.title) {
        this.options.commitTitle?.(cardId, input.value);
      }
    };

    input.addEventListener('keydown', (event: KeyboardEvent) => {
      // 标题输入框里的按键绝不能再冒泡给画布：空格会被画布当平移、Delete 会删卡片
      event.stopPropagation();
      // 输入法组词中一律放行：中文输入法确认候选词用的就是 `Enter`
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' || event.key === 'Tab') {
        // `Tab` 与 `Enter` 同义：都是"改完了，收工"
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));

    input.focus();
    input.select();
    return true;
  }

  /**
   * 拖动 / 缩放过程中的**预览**（T1.35–T1.37）：只写 DOM，一个字节都不落盘。
   *
   * 为什么不复用 `applyCard`：它会重跑 `renderContent`（内容指纹没变时虽然会跳过，
   * 但 `querySelector`、class 计算、`dataset` 写入这些每帧都要重来一遍）。
   * 拖动时每帧只该做一件事 —— 改 4 个 CSS 数字。
   *
   * ★ 预览必须"可丢弃"：松手提交、或者按 Esc 取消时，视图会从模型重画一遍
   *   （`refreshCards()`），所以这里写坏了大不了重画，不存在数据风险。
   */
  previewRects(rects: readonly CardRect[]): void {
    for (const rect of rects) {
      const entry = this.mounted.get(rect.id);
      if (!entry) continue;
      const style = entry.element.style;
      style.left = `${rect.x}px`;
      style.top = `${rect.y}px`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;
      // ★ 手里的卡片不能被栏窗口裁掉（T2.03）：拖出分栏的过程中它必须整张可见，
      //   否则会出现"卡拖到一半少了下半截"这种只在一帧里发生的怪相。
      //   松手后视图会 `refreshCards()` 重画，清除不会被"记住"。
      style.clipPath = '';
      this.scrolled.delete(rect.id);
    }
  }

  /**
   * 旋转过程中的预览（T7.06）：**只写 `transform`**，别的一个字节都不碰。
   *
   * ★ 与 `previewRects` 同一套契约：可丢弃、每帧调用、不做任何记录。
   *   旋转不改几何，所以预览与提交之间没有"半个状态"可言 ——
   *   松手走 `applyCardRotations` 落盘，中途被打断（Esc / 切板）则由视图重画覆盖。
   * ★ 归零写空串的理由同 `applyCard`（不白造层叠上下文）。
   */
  previewRotation(cardId: string, degrees: number): void {
    const entry = this.mounted.get(cardId);
    if (!entry) return;
    entry.element.style.transform = degrees === 0 ? '' : `rotate(${degrees}deg)`;
  }

  /**
   * 渲染内容槽（T1.32）—— 卡片层只提供槽位，具体内容由类型定义负责。
   *
   * ★ **指纹去重是这里唯一的性能闸门**：`refresh()` 会把所有可见卡片重跑一遍，
   *   若每次都重渲 Markdown，改一个字就要重排整屏（`02 §8.2`）。
   *   指纹 = 呈现模式 + 内容序列化：模式一变（双击进编辑）必须重绘，
   *   内容没变则原样保留已渲染的 DOM（连内嵌内容都不必重新加载）。
   */
  private renderContent(entry: MountedCard): void {
    const content = entry.element.querySelector<HTMLElement>('.nestboard-card-content');
    if (!content) return;

    const { card } = entry;
    const mode = this.options.modeOf(card);
    const stamp = `${mode}\u0000${stringifyContent(card)}`;
    if (entry.stamp === stamp) return;
    entry.stamp = stamp;

    // 先让视图回收上一份内容挂着的资源，再整块清空 ——
    // 只改 `textContent` 的话，旧组件仍活着（`MarkdownRenderer` 的内嵌）
    this.options.releaseContent?.(content);
    content.textContent = '';
    delete content.dataset.placeholder;

    const context = this.options.createContext(card, content);
    entry.context = context;
    const rendered = this.options.registry.render(content, card, context);
    if (!rendered) {
      // 未注册的类型（本 Sprint 只实现了便签卡）：宁可显示类型名，也不能一片空白
      content.dataset.placeholder = 'true';
      content.textContent = t(CARD_TYPE_LABEL_KEY[card.type]);
    }

    this.measureContent(entry, content, context, mode);
  }

  /**
   * 自动高度（T1.38，`F2-00-8`）：内容变多了就把卡片长高。
   *
   * ── 三个刻意的取舍 ─────────────────────────────────────────
   *
   * 1. **只增不减**。模型里没有"这张卡的高度是用户手拉的还是自动长的"这个字段
   *    （`03 §2.7` 的字段表是定稿的，不该为一件小事加字段）。既然分不清，
   *    缩容就是危险的：用户把卡片拉高到 800px 摆好版面，改一个字就被压回 200px，
   *    还没法撤销回来 —— 那才是真正的数据事故。溢出部分由内容区滚动兜住。
   * 2. **每次最多长 {@link AUTO_HEIGHT_MAX_STEP}**。量到 3000px 就真撑到 3000px，
   *    这张卡会盖住整块白板、连自己的手柄都跑到屏幕外。分批长高，用户看得见、能打断。
   * 3. **只在指纹变化后量**（本方法由 `renderContent` 调用，而它前面就是指纹闸门）。
   *    量布局会强制同步重排，把它放进 `sync()` 每帧跑一遍等于放弃 60fps。
   *
   * ★ 编辑态不量：编辑时内容槽里是输入框，高度由输入框自己撑，
   *   此刻写回高度会在用户打字过程中不断改模型（每敲一个字一次落盘）。
   */
  private measureContent(
    entry: MountedCard,
    content: HTMLElement,
    context: CardRenderContext,
    mode: CardViewMode,
  ): void {
    if (mode === 'edit' || entry.card.locked) return;

    const definition = this.options.registry.get(entry.card.type);
    if (!definition?.measure) return;

    const measured = definition.measure(content, entry.card, context);
    if (!Number.isFinite(measured) || measured <= 0) return;

    // 骨架占高（标题行 + 上下内边距）= 卡片高 − 内容区高。
    // 在无布局的环境（单测）里两者都是 0，于是 required === measured，逻辑照常成立
    const chrome = Math.max(entry.element.offsetHeight - content.offsetHeight, 0);
    const required = measured + chrome;
    if (required <= entry.card.height) return;

    const grown = Math.min(required, entry.card.height + AUTO_HEIGHT_MAX_STEP);
    // `ceil` 而不是四舍五入：舍掉小数会让"每次都差一点点"，反复量、反复提交
    const height = Math.max(Math.ceil(grown), MIN_CARD_SIZE.height);
    if (height <= entry.card.height) return;

    this.options.onAutoHeight?.(entry.card.id, height);
  }
}

/**
 * 内容序列化用于指纹比对。模型内容必须是可 JSON 化的纯数据（它本来就要写进 `.nboard`）。
 *
 * ★ 指纹必须覆盖 `render()` 读到的**每一个卡片级字段**，不只是 `content`：
 *   **仅标题卡**把 `titleStyle`（粗 / 斜 / 下划线 / **字色**）与 `icon` 直接画在内容槽里
 *   （`cards/titleCard.ts` 的 `applyTitleStyle` / 那一枚标记）。只序列化 `content` 时，
 *   在快捷操作栏里改字色 → 指纹不变 → `renderContent` 提前返回 → **卡面不重绘**，
 *   非要等下一次模式切换（双击进编辑）才借"模式变了"重画一次 —— 也就是用户报的
 *   "改字体颜色不立即生效，点开之后才生效"（2026-09-18）。
 *   便签 / 白板卡的标题格式走的是 `applyCard` 的 CSS 变量（不经指纹），所以它们没这个毛病。
 */
function stringifyContent(card: Card): string {
  return JSON.stringify([card.content, card.icon ?? '', card.titleStyle ?? null]);
}
