/**
 * 脑图视图（`.nestmind`，`06 §2` / `§9`）。
 *
 * 已落地：建 DOM、经仓储读写、按布局摆节点与连线、平移缩放、裁剪、**XMind 式键盘编辑**、
 * **鼠标拖拽改父 / 拖到空白变悬浮（带辅助线）**、**子树复制粘贴**。
 * 刻意不做：多选（`⌘A`）与整体拖动、内容 Markdown 渲染与编辑（P4）、属性面板（P5）。
 *
 * ── DOM 结构（与白板同一个思路：**只有一个世界容器做变换**）────────
 *
 * ```
 * contentEl (.nestboard-mind)
 *   canvasEl (.nestboard-mind-canvas)   ← 手势表面 + 裁剪窗口 + **键盘焦点**（tabindex）
 *     worldEl (.nestboard-mind-world)   ← translate3d + scale（唯一被变换的元素）
 *       svg  (.nestboard-mind-edges)    ← 连线（世界坐标里的 1×1 锚点 + overflow: visible）
 *       div  (.nestboard-mind-nodes)    ← 节点（只写 left/top）
 *       svg  (.nestboard-mind-guide)    ← 拖拽辅助线（**只在拖拽中出现**，不落盘）
 * ```
 *
 * ── 编辑的接线（`06 §4.1`）──────────────────────────────────
 *
 * * **键位判据是纯函数**（`keys.ts`）：视图只做"动作 → 调哪个函数"；
 * * **落点判定同样是纯函数**（`dragDrop.ts`）：视图只提供"盒子 + 指针 + 谁是自己的后代"；
 * * **每个改动都走 `commit()`**（与白板 `BoardView.commit` 同一条）：它在 `mutate` 前后
 *   各取一份快照交给 `HistoryStack`，`⌘Z` / `⌘⇧Z` 于是对脑图也成立；
 * * **撤销由命令表提供**（`mind/commands.ts` 带 `Mod+Z` / `Mod+Shift+Z`）：Obsidian 不会
 *   替自定义视图兜底，不登记这两条命令就是"按了没反应"（与白板 `O25` 同一条结论）。
 *
 * ★ 平移缩放**只改世界容器的 transform**；节点写世界坐标、一直不动（`02 §8.2` 的纪律）。
 * ★ 尺寸**量出来**而不是写死：布局先按估算摆一遍，量到真尺寸之后再摆一遍。
 */

// `TFile` 是**值**导入（`openRef` 里要 `instanceof TFile` 判"引用还在不在"）
import { Component, FileView, MarkdownRenderer, Menu, Notice, TFile, View } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_MIND } from '../../constants';
import { Viewport } from '../../canvas/Viewport';
import { NavigationController } from '../../canvas/NavigationController';
import { HistoryStack } from '../../model/history';
// ★ 拖拽文本的解析**复用白板那份**（`model/drop.ts` 的 `parseDropPaths`）：它是纯函数、
//   已经跑通并带 25 条单测，而且它认识 `obsidian://open?file=…` 这种文件浏览器形态 ——
//   自己再写一份"按行当路径"的解析，症状就是环亮了、松手没反应（真实报障）。`model/` 是共享层。
import { parseDropPaths } from '../../model/drop';
import { t } from '../../util/i18n';
// 主题色词汇表（`N1-e` 的线条颜色与分支线共用一套）：`themeColorVar` 给 CSS 值、
// `colorLabel` 给右键菜单里那一行的名字
import { THEME_COLOR_OPTIONS, colorLabel, themeColorVar } from '../../util/color';
import { debounce, type Debounced } from '../../util/debounce';
import { describeError } from '../../util/errors';
import { MiniMarkdownEditor } from '../../editor/MiniMarkdownEditor';
import { uniqueExportPath } from '../../export/toPng';
// `.xmind` 是个 zip：编码器与白板导出 ZIP 共用（`export/toZip`）
import { buildZip } from '../../export/toZip';
import { appendMenuItems } from '../../ui/ContextMenus';
import { textToArrayBuffer } from '../../util/encoding';
import { attachMarkdownLinkHandler } from '../../integration/markdownLinks';
import { splitName } from '../../util/fileName';
import { mindToFreeMind } from '../export/toFreeMind';
import { mindToMarkdown } from '../export/toMarkdown';
import { mindToOutlineMarkdown } from '../export/toOutlineMarkdown';
import { mindToXmindEntries } from '../export/toXmind';
import { mindToSvg } from '../export/toSvg';
import { svgToPngBytes } from './svgToPng';
import {
  rectCenter,
  rectContainsPoint,
  rectFromPoints,
  rectsIntersect,
  roundTo,
  type Point,
  type Rect,
  type Size,
} from '../../util/geometry';
import type { HexColor, ThemeColor } from '../../model/schema';
import { MIND_DEFAULT_EDGE_STYLE, MIND_DEFAULT_STRUCTURE } from '../model/schema';
import type {
  MindEdgeStyle,
  MindFile,
  MindLink,
  MindNode,
  MindRef,
  MindStructure,
} from '../model/schema';
import { normalizeLinkBend } from '../model/schema';
import { titleSizeOf } from '../model/palette';
import { restoreMindContent, serializeMindContent } from '../model/history';
import {
  addChild,
  addSibling,
  childrenOf,
  depthOf,
  enterAtEnd,
  hasChildren,
  horizontalTargetId,
  moveNode,
  moveNodes,
  nextVisibleId,
  nodeById,
  promote,
  removeNodes,
  removeRef,
  sanitizeSelection,
  setRefWidth,
  setRefs,
  selectionRoots,
  setCollapsed,
  setNote,
  indent,
  setText,
  splitNodeAt,
  subtreeIds,
  subtreeSizes,
  visibleIds,
} from '../model/ops';
import {
  copyForest,
  duplicateNodes,
  getMindClipboard,
  mindClipboardHtml,
  mindClipboardText,
  parseMindClipboardHtml,
  pasteForest,
  setMindClipboard,
  type MindClipboard,
} from '../model/clipboard';
import {
  MIND_IMAGE_DEFAULT_WIDTH,
  MIND_IMAGE_MAX_WIDTH,
  MIND_IMAGE_MIN_WIDTH,
  firstRefOf,
  pickRef,
  refLabelOf,
  sameRef,
} from '../model/refs';
import { MIND_TITLE_FONT_SIZE, MIND_TITLE_MAX_WIDTH, estimateNodeSize } from '../layout/measure';
import {
  directionForStructure,
  layoutMind,
  type MindLayout,
  type MindLayoutOptions,
  type NodeBox,
} from '../layout/tree';
import { linkHitTest, linkMidpointOf } from '../layout/links';
import {
  applyHandleBox,
  applyHandleState,
  applyNodeBox,
  buildEdgeLayer,
  buildViewToggle,
  buildGuideLayer,
  buildHandleElement,
  buildLinkLayer,
  buildLinkPreviewLayer,
  buildNodeElement,
  buildTitleEditor,
  paintEdges,
  paintLinkPreview,
  paintLinks,
  renderSignatureOf,
  type GuideLayer,
  type LinkPaintItem,
  type TitleEditorHandle,
  MIND_BODY_CLASS,
  MIND_HANDLE_ATTR,
  MIND_IMAGE_CLASS,
  MIND_IMAGE_RESIZE_ATTR,
  MIND_LINK_HANDLE_CLASS,
  MIND_NODE_ID_ATTR,
  MIND_REF_ATTR,
} from './render';
import { resolveDrop, type MindDropTarget } from './dragDrop';
import { mindMinimapShapes } from './minimapShapes';
import {
  MIND_PENDING_STRUCTURES,
  buildCanvasControls,
  type CanvasControls,
} from './CanvasControls';
// 快捷操作栏搬到了共享层（白板便签也用同一份），这里只换导入路径
import { buildNodeToolbar, type NodeToolbar, type QuickBarFeature } from '../../ui/QuickBar';
import { Minimap } from '../../ui/MinimapPanel';
import {
  addLink,
  removeLink,
  removeNodeKeepChildren,
  setCollapsedFromDepth,
  setDone,
  setIcon,
  setLinkArrow,
  setLinkBend,
  setLinkColor,
  setLinkLabel,
  setLinkSolid,
  setNodeStyles,
} from '../model/ops';
import { commonTitleStyle, themeColorPreviewOf, titleBoldOf } from '../model/palette';
import type { CardColor } from '../../model/schema';
import { boxesWithin } from './marquee';
import {
  OUTLINE_BULLET_CLASS,
  OUTLINE_CRUMBS_CLASS,
  OUTLINE_HEADING_CLASS,
  OUTLINE_MAIN_CLASS,
  OUTLINE_ROW_CLASS,
  OUTLINE_TITLE_CLASS,
  buildOutlinePanel,
  outlineDragIsText,
  outlineDropPlanOf,
  outlinePathOf,
  outlineRowsOf,
  outlineTitleOf,
  type OutlineDropPlan,
  type OutlineDropZone,
  type OutlinePanel,
  type OutlineRow,
} from './outline';
import { outlineKeyActionOf } from './outlineKeys';
import { mindKeyActionOf, titleCommitActionOf, titleEditKeyOf } from './keys';
import { mindMenuItems } from './mindMenu';
import type { MindMenuActions, MindMenuItemSpec } from './mindMenu';
import type NestboardPlugin from '../../main';

/**
 * **多选**时快捷栏上画哪几件（`N2`，用户 2026-09-16）。
 *
 * ★ 只留"对一堆节点**有唯一含义**"的：粗 / 斜 / 下划线 / 字色 / 底色。
 *   「标记」（一个节点一个）、「编辑内容」「插入图片」（目标只有一个）**不画** ——
 *   不是置灰：一排灰按钮只会让人以为坏了（与 `08 §3` 同一条规矩）。
 */
const MULTI_NODE_FEATURES: ReadonlySet<QuickBarFeature> = new Set<QuickBarFeature>([
  'bold',
  'italic',
  'underline',
  'ink',
  'color',
]);

/** 本视图往容器上加的 class（`styles.css` 里那几条都以它开头） */
const VIEW_CLASS = 'nestboard-mind';
/** 选中节点的 class */
const SELECTED_CLASS = 'is-selected';
/** 拖拽中的节点 class（跟着手走的那个） */
const DRAGGING_CLASS = 'is-dragging';
/**
 * 点线身的**屏幕**容差（px，`N1-c`）。
 *
 * ★ 按屏幕给、不按世界坐标：写死世界里 6px 的话，画布放大到 200% 之后
 *   用户得**精确点在 3px 内**才点得中（而他看见的线有 2px 宽 + 一圈余量）。
 */
const LINK_HIT_TOLERANCE_PX = 8;
/** 改关联线标签时输入框的 class（挂在世界容器里、摆在线中点） */
const LINK_LABEL_EDIT_CLASS = 'nestboard-mind-link-label-editor';
/**
 * 大纲里就地编辑时，那个输入框**至少**给这么宽（px，`N3-b`）。
 *
 * ★ 宽度取的是**标题原来的框**：一个字的标题只有十几像素宽，接着打字就只剩一条缝在看。
 *   大纲这一行的右边本来就是空的（正文在**下一行**），往右多铺一些不会盖住任何东西。
 */
const OUTLINE_TITLE_EDIT_MIN_WIDTH = 220;
/** 拖到大纲面板上下边缘这么多像素以内就开始自动滚（`N3-d`） */
const OUTLINE_DRAG_EDGE_PX = 28;
/** 每来一条 `pointermove` 自动滚多少像素（按住不动不会自己滚，够用了） */
const OUTLINE_DRAG_SCROLL_STEP = 10;
/**
 * 两次"进入这一层"之间的最短间隔（`N3-e`）。
 *
 * ★ 为什么要它：进入之后**整列换了一批行**，紧接着的第二次点击会落在**别的行**上 ——
 *   手快连点两下就会连进两层（"我只想进这一支，怎么又进去了"）。
 *   400ms 差不多是"人的双击"的上限，够拦住连点，又不会挡掉"想连着进两层"的正常操作
 *   （那种情况下两次点击之间总要看一眼）。
 */
const OUTLINE_ENTER_GUARD_MS = 400;

/**
 * 正在**拖一行**（`N3-d`：按住行首圆点拖）。
 *
 * ★ 与画布的拖拽（`DragState`）刻意**不复用一套状态**：那套围绕"世界坐标 + 落点几何 +
 *   悬停展开"转，大纲这边是"行的矩形 + 三档落点"，地址都不一样；
 *   共用一个 `pending` 反而会让两边的判据互相污染。
 * ★ 只记 **id**，不记元素：`render` 会把整批行换掉（被别处改了文件、撤销），
 *   而 id 一直有效 —— 每次算落点现查 DOM（`panel.dropAt`）。
 */
interface OutlineDragState {
  /** 被拖的那一行的节点 id（根不在行里 ⇒ 天然拖不到根） */
  id: string;
  pointerId: number;
  /** 按下时的屏幕坐标（算阈值用） */
  start: Point;
  /** 过没过阈值（没过 = 这一下还是"点击"） */
  moved: boolean;
  /** 落点（`null` = 在列表之外 / 还没算） */
  target: { targetId: string; zone: OutlineDropZone } | null;
  /** 落点算出来的写法（`null` = 落不下去：自己 / 自己的后代） */
  plan: OutlineDropPlan | null;
}
/**
 * 正在**拖关联线的弯折手柄**（`N1-d`）。
 *
 * ★ 拖动期间模型**一个字节都不动**：预览值只存在这里，`paintLinks` 用它画
 *   （线 / 箭头 / 标签 / 手柄一起跟手），松手才走**一次** `edit()` ⇒
 *   一次拖动 = 一步 `⌘Z`（与拖拽改父子、拉角改宽度同一条）。
 * ★ `mid` = **不弯时**的曲线中点（世界坐标）：弯折的定义就是"当前指针 − 它"，
 *   存下来省得每帧从布局重算（拖动期间节点不会动）。
 */
interface LinkBendDragState {
  linkId: string;
  pointerId: number;
  /** 当前预览值（`null` = 已经拉回"不弯"） */
  bend: { x: number; y: number } | null;
  /** 不弯时的曲线中点 */
  mid: Point;
}

/**
 * 大纲里正在**框选**（`N3-h`，用户 2026-09-17："如果框选，可以框选住多行，
 * 实际上会变成选中多个节点；此时 `⌘C` 再选中任意节点 `⌘V`，就是把这些节点复制到它的子节点下"）。
 *
 * ★ 只认**非文字区**起手：行里的文字列要留给浏览器**选字**（"通用的 `⌘C`"那条需求）——
 *   两个手势都从"在某一行上按下去"开始，只能靠落点区分。
 * ★ 没过 `DRAG_THRESHOLD_PX` 不算框选，否则"点一行进编辑"会被它吃掉。
 */
interface OutlineMarqueeState {
  pointerId: number;
  /** 起点（**面板内容坐标**：`client − 面板矩形 + 滚动量`），虚线框按它摆 */
  start: Point;
  current: Point;
  /** 起点（**视口坐标**）：判"这一拖往哪个方向走"用 */
  startClient: Point;
  /** 按下去时已有的选区（`⇧` 时保留 —— 与画布框选的加选规则一致） */
  base: ReadonlySet<string>;
  /**
   * 起手是不是落在**文字列**上。
   *
   * ★ 文字列上要等"方向"定了才能决定这一拖归谁（见 `updateOutlineMarquee`）；
   *   非文字区（竖线格 / 行尾空白 / 面板空白）没人跟它抢 ⇒ 直接就是框选。
   */
  startsOnText: boolean;
  /**
   * 这一拖归谁：`none` = 还没过阈值；`marquee` = 我们框选；`text` = 让给浏览器选字。
   *
   * ★ 为什么需要它：**必须等动起来才知道**（按下去那一瞬间分不出"我要框几行"还是
   *   "我要选这段字"）—— 这也是第一版"只在非文字区起手框选"被用户报"没有框选机制"的原因。
   */
  decided: 'none' | 'marquee' | 'text';
  /**
   * 按下去那一下是不是落在**某一行**里。
   *
   * ★ 只在"没过阈值就松手"（= 一次普通点击）时用：落在行里 ⇒ 交给行自己的 `click`
   *   （进编辑、按点击位置落光标）；落在**空白**（列表下方 / 两侧 / 标题行）⇒
   *   由我们**清空选区**（与画布"点空白 = 清空选区"同一条手感）。
   */
  onRow: boolean;
}

/** 视口落盘的防抖（W3：只改视口不递增 revision，但也不必每帧写一次盘） */
const VIEWPORT_SAVE_MS = 400;
/**
 * 指针要动过这么多像素才算"拖拽"。
 *
 * ★ 没有这道闸门，"点一下选中"也会走一遍拖拽的收尾（落点判定 + 可能的改父）——
 *   用户只是想把焦点移过来，却把节点挪走了，是最容易挨骂的一类误操作。
 */
const DRAG_THRESHOLD_PX = 4;
/**
 * 脑图自己接管的组合键（`MindView.onWindowKeyDown`）。
 *
 * ★ 小写、单个 `event.key`；`⌘⇧Z` 与 `⌘Z` 共用 `z`（靠 `event.shiftKey` 分）。
 * ★ 加一个键之前先问一句"**输入框里也这么用吗**"：如果焦点在输入框里也成立，
 *   那就该让它冒泡过去（例如 `⌘B` 加粗），别往这里塞。
 */
const OWN_KEYS = new Set(['c', 'x', 'v', 'a', 'z', 'enter', '=', '+', '-', '0', 'b', 'i', 'u']);
/** 拖到**折叠着**的节点上停这么久，就替用户展开它（`06 §4.1` 的"悬停展开"） */
const HOVER_EXPAND_MS = 800;

/** 拖拽状态（`null` = 没在拖） */
interface DragState {
  /** 按下的那一个（落点判定与辅助线都以它为准） */
  nodeId: string;
  pointerId: number;
  /** 指针相对节点中心的偏移（世界坐标）：让节点"跟着手"，而不是"跳到指针底下" */
  offset: Point;
  /** 预览中的中心（世界坐标）—— 松手落位就用它 */
  center: Point;
  /** 当前落点（松手照它改模型） */
  target: MindDropTarget;
  /**
   * 跟着手走的那些节点（被拖那一支 / 那一簇的**全部**节点）。
   *
   * ★ 单支拖动时也把它的子孙一起带上：不然"父亲飘走了、孩子还在原地"，
   *   松手又一起跳过去 —— 多选（P3-c）把这件事放大了，顺手统一。
   */
  nodeIds: string[];
  /** 模型里真正要换父的那些（多选时是"入口"，单选时就是一个） */
  rootIds: string[];
}

/**
 * 图片拉角的状态（`null` = 没在拉）。
 *
 * ★ `center` / `startDistance` **在开始时定死**：缩放过程中图片自己在长大，
 *   每帧重算中心就会形成反馈回路（越拉越飞）。
 */
interface ImageResizeState {
  nodeId: string;
  pointerId: number;
  /** 开始时节点盒子的中心（世界坐标，全程不动） */
  center: Point;
  startWidth: number;
  /** 开始时指针到中心的距离（等比的基准） */
  startDistance: number;
  /** 拖动中的宽度（松手才写进模型） */
  width: number;
}

/** 按下但还没超过阈值的"可能是拖拽" */
interface PendingDrag {
  nodeId: string;
  pointerId: number;
  /** 屏幕坐标（判阈值用，与相机无关） */
  start: Point;
}

/**
 * 正在框选（左键在空白处拖出一个矩形，`06 §4.2`）。
 *
 * ★ 起止点都存**屏幕坐标**（画那个框用），选谁则换算成世界坐标再判
 *   （屏幕上同样大小的一块，在不同缩放下对应的世界范围完全不同）。
 */
interface MarqueeState {
  pointerId: number;
  /** 画布坐标（容器左上角为原点）：画框用 */
  start: Point;
  current: Point;
  /**
   * 按下那一刻的选区（一份拷贝）。
   *
   * ★ 两个用途都用它：`⇧` 加选时的**底子**、`Esc` 取消时的**还原点**。
   *   存拷贝而不是"事后合并"：框选过程中选区一直在跟着矩形变，
   *   事后拿到的"已有选区"已经被自己改过了。
   */
  base: Set<string>;
  /** `⇧` 按下 = 在 `base` 之上加选；否则以矩形里框到的为准 */
  additive: boolean;
}

/**
 * 正在**连线**（`N1-b`）。
 *
 * ★ 这是一次"点击 → 移动 → 再点击"的手势（用户原话：点「连线」→ 线跟着鼠标走 →
 *   左键落线），**不是按住拖**：起点在**工具栏**上，那里的 `pointerdown` 会被
 *   `isOverlayTarget` 整条让开（见那一处的说明）—— 所以这一态里没有指针捕获。
 * ★ 所有东西都是**预览**：`Esc` / 右键走开等于没来过，模型一个字节都不动。
 */
interface LinkingState {
  /** 起点节点 id */
  from: string;
  /** 指针当前位置（世界坐标）—— 还没吸附到目标时线头就跟着它 */
  current: Point;
  /** 吸附到的目标节点；`null` = 还没吸上（这一档不给落线） */
  target: string | null;
}

export class MindView extends FileView {
  private readonly plugin: NestboardPlugin;
  /** 相机：世界坐标 ↔ 屏幕坐标（与白板共用 `canvas/Viewport`） */
  private readonly viewport = new Viewport();
  /** 撤销栈：`HistoryStack` 本来就是文档中立的，脑图零改动直接用 */
  private readonly history = new HistoryStack();

  private canvasEl: HTMLElement | null = null;
  private worldEl: HTMLElement | null = null;
  private nodeLayerEl: HTMLElement | null = null;
  private edgeLayerEl: SVGSVGElement | null = null;
  /** 关联线层（`N1`，独立一层，见 `buildLinkLayer`） */
  private linkLayerEl: SVGSVGElement | null = null;
  /** 「正在拉的那条线」的预览层（`N1-b`）：每帧都在变，所以独立一层 */
  private linkPreviewEl: SVGSVGElement | null = null;
  /** 连线态（`N1-b`）：`null` = 没在连线 */
  private linking: LinkingState | null = null;
  /** 大纲里正在拖的那一行（`N3-d`）：`null` = 没在拖 */
  private outlineDrag: OutlineDragState | null = null;
  /** 关联线的**弯折手柄**（`N1-d`）：世界坐标里那个小圆点，选中一条线时出现 */
  private linkHandleEl: HTMLElement | null = null;
  /** 大纲框选（`N3-h`）正在进行的那个手势：`null` = 没在框选 */
  private outlineMarquee: OutlineMarqueeState | null = null;
  /** 框选那个虚线框（面板的绝对定位子元素，跟着内容滚） */
  private outlineMarqueeEl: HTMLElement | null = null;
  /** 正在拖弯折手柄（`N1-d`）：`null` = 没在拖 */
  private linkBendDrag: LinkBendDragState | null = null;
  /** 上一次"进入这一层"的时刻（连点保护；见 `OUTLINE_ENTER_GUARD_MS`） */
  private lastEnterAt = 0;
  /**
   * 拖完之后要**吞掉**的那一次 `click`（`N3-d`）。
   *
   * ★ 为什么需要它：浏览器在 `pointerup` 之后还会补一个 `click`，而那个 `click` 的落点
   *   可能是**圆点**（会弹菜单）或**行**（会进编辑）—— 用户心里那一下是"我把这一行拖过来"，
   *   不是"点了一下它"。`pointerup` 里置位，`onPick` / `onMenu` 进来先问一句。
   */
  private suppressRowClick = false;
  private guideLayer: GuideLayer | null = null;
  /** 折叠手柄层（世界坐标，挂在世界容器里） */
  private handleLayerEl: HTMLElement | null = null;
  /** 框选框（屏幕坐标里的那个虚线矩形） */
  private marqueeEl: HTMLElement | null = null;
  private navigationController: NavigationController | null = null;
  private observer: ResizeObserver | null = null;

  /** 当前这份脑图；保护态 / 读不到时是 `null`（原因画在画布上，**绝不写回文件**） */
  private mind: MindFile | null = null;
  private nodesById = new Map<string, MindNode>();
  private layout: MindLayout | null = null;
  private readonly measured = new Map<string, Size>();
  private readonly mounted = new Map<string, HTMLElement>();
  /** 已挂载的折叠手柄（按节点 id） */
  private readonly handles = new Map<string, HTMLElement>();
  /**
   * 每个节点的**整支总数**（`ops.subtreeSizes`）。
   *
   * ★ 在 `render()` 里算一次、`paintHandles` 里只读：手柄是**每帧**都可能重画的
   *   （拖动相机时），逐节点现场数一遍会变成 O(n²)。
   */
  private subtreeSizes = new Map<string, number>();
  /**
   * 每个已挂载元素"画的是哪一版"（`renderSignatureOf`）。
   *
   * ★ 有它才能"改完标题当场看见"：`paint` 对已挂载的节点只改几何，从不动内容 ——
   *   不比较这一下的结果是"打完字要重开一次才显示"（这个 bug 真的出现过）。
   */
  private readonly rendered = new Map<string, string>();

  /** 选中的**锚点**：单节点动作（加子节点 / 加兄弟 / 改标题 / 方向键）都作用在它身上 */
  private selectedId: string | null = null;
  /**
   * 多选出来的那一批（P3-c）。**一定包含锚点**；只有一个时就是常见的单选。
   *
   * ★ 两个字段而不是一个 `Set`：锚点是"键盘现在站在哪"，多选是"这一簇是哪几个" ——
   *   按方向键时前者变、后者不变（方向键会把多选收成单选），混成一个字段读起来会打架。
   */
  private selectedIds = new Set<string>();
  /**
   * 正在改标题的那个输入组件（有它时键位归输入框）。
   *
   * ★ `titleEl` 允许为 `null`：画布那条路插在节点的标题带里（要把原标题藏起来），
   *   而**大纲那条路**（`N3-b`）插在行里，藏的是行里那一段标题 —— 两处共用这一个状态，
   *   于是提交 / 取消 / "组字中的 `Enter` 不算提交"全都是同一份实现。
   */
  private editing: {
    nodeId: string;
    editor: TitleEditorHandle;
    titleEl: HTMLElement | null;
  } | null = null;
  /**
   * 选中的**关联线**（`N1-c`）。
   *
   * ★ 与节点选区**互斥**（选中线时节点选区清空）：与白板"线 / 卡互斥"同一条 ——
   *   两样都留着时，`Delete` 删什么要靠猜。
   */
  private selectedLinkId: string | null = null;
  /**
   * 正在改**关联线标签**的输入组件（`N1-c`）。
   *
   * ★ 与改标题（`editing`）分开一个字段：两者的宿主、写回目标、收尾动作都不同 ——
   *   合成一个"富状态"只会让每个分支都多问一句"现在是哪一种"（与 `noteEdit` 同一条）。
   */
  private linkEdit: { linkId: string; editor: TitleEditorHandle } | null = null;
  /** 大纲面板（`N3-a`）：与画布二选一显示，整块重建（节点数量级很小） */
  private outlinePanel: OutlinePanel | null = null;
  /** 正在**行内改正文**的那一格（`N3-b`；与改标题分开一个字段，理由同 `noteEdit`） */
  private outlineNote: { nodeId: string; area: HTMLTextAreaElement } | null = null;
  /**
   * 大纲滚到哪（`N3-c`）—— **按文件路径记**。
   *
   * ★ **纯视图状态、不落盘**：与 `guidesOn` 同一条（"这一刻我看到哪儿"属于人，
   *   不属于这份脑图文件，也不进撤销栈）。
   * ★ 按路径而不是一个裸数字：一个视图实例可以先后打开好几份脑图，
   *   用裸数字会出现"换了一份图，滚动条停在上一次的深度"。
   */
  private readonly outlineScroll = new Map<string, number>();
  /** 右上角那个「大纲 / 树」切换按钮（挂在视图容器上，见 `onOpen` 里的说明） */
  private outlineToggleEl: HTMLElement | null = null;
  /**
   * 正在编辑**内容区**的那个节点（`⌘⏎` 进出）。
   *
   * ★ 与 `editing`（改标题）分开两个字段：两者的键位归属、进出时机、写回目标都不同，
   *   合成一个"富状态"只会让每个分支都要多问一句"现在是哪一种"。
   * ★ `editor` / `body` 要等 DOM 建出来才挂得上（见 `paint`）—— 所以它们可以是 `null`：
   *   这一段是"状态已进入、DOM 还没到"的窗口期。
   */
  private noteEdit: {
    nodeId: string;
    editor: MiniMarkdownEditor | null;
    body: HTMLElement | null;
  } | null = null;
  /**
   * 节点内容块里嵌进来的那些组件（`MarkdownRenderer` 把内嵌笔记 / 图片挂到它上面）。
   *
   * ★ 节点 DOM 被回收时必须跟着卸掉，否则内嵌内容会一直挂在内存里 ——
   *   与白板 `BoardView` 为卡片正文新建 / 释放 `Component` 是同一条。
   * ★ 键是**内容块**元素（渲染能力拿到的就是它）。
   */
  private readonly embedded = new WeakMap<HTMLElement, Component>();
  /** 撤销写回期间为 `true`：那一下本身不该再记一步（与白板 `applyingHistory` 同一条） */
  private applyingHistory = false;

  /** 左下角的画布调节浮层（`08 §1`；`onOpen` 建、`onClose` 随画布一起没） */
  private controls: CanvasControls | null = null;
  /**
   * 缩略图导航器（`P2-c` / `F1-06`）。
   *
   * ★ 与白板**共用同一个组件**（`ui/MinimapPanel.ts`）与**同一份设置**（`settings.minimap`）：
   *   "我要一个缩略图导航器"是一个偏好，不是两份 —— 在任意一边打开，两边都亮。
   * ★ 显隐**不是**它自己的状态，而是"设置 + 当前视图"的投影：命令、面板上的 `×`、
   *   设置面板三个入口改的都是那一份设置（`toggleMinimap`）。
   */
  private minimap: Minimap | null = null;

  /**
   * 树视图的面包屑（用户 2026-09-18："脑图树视图，进入当前主题后，也要出现面包屑导航"）。
   *
   * ★ 与**大纲**那条**同一个数据来源**（`outlinePathOf`）：两边看到的路径永远是同一条
   *   —— 各算一遍的话，迟早出现"大纲说在这儿、树视图说在那儿"。
   * ★ 只在**有聚焦**时出现（没聚焦 = 看整棵树，路径没有意义）。
   */
  private crumbsEl: HTMLElement | null = null;

  /** 按当前的聚焦状态重算面包屑（每次渲染都会走到，见 `syncOutlineChrome`） */
  private syncMindCrumbs(): void {
    const el = this.crumbsEl;
    if (!el) return;
    const mind = this.mind;
    // 大纲视图里不画（那边有自己的一条）；没聚焦时也整条收起
    const crumbs = mind && !this.outlineMode ? outlinePathOf(mind, this.focusId ?? undefined) : [];
    el.classList.toggle('is-hidden', crumbs.length === 0);
    if (crumbs.length === 0) {
      el.replaceChildren();
      return;
    }
    el.replaceChildren(...this.buildCrumbChips(crumbs));
  }

  /**
   * 面包屑的每一格（照大纲那条的手法）。
   *
   * ★ 用 `<span role="button">` 而**不是 `<button>`**：Obsidian 自带的 `button` 规则会给它
   *   糊上一层底色（大纲那条的注释里写着同一件事）；类名也沿用大纲那几个
   *   （`nestboard-mind-outline-crumb` / `-crumb-sep`）—— 两处的面包屑长得一样，
   *   样式只该有一份。
   * ★ 空标题给占位（"（无标题）"）：空白的一格点不下去，看着像坏了。
   * ★ 点一格 = `setFocus(id)` —— 与大纲那条、与画布上的 `⌘[` 是同一条路。
   */
  private buildCrumbChips(crumbs: readonly { id: string; text: string }[]): HTMLElement[] {
    const doc = this.contentEl.ownerDocument;
    const nodes: HTMLElement[] = [];
    crumbs.forEach((crumb, index) => {
      if (index > 0) {
        const separator = doc.createElement('span');
        separator.className = 'nestboard-mind-outline-crumb-sep';
        separator.textContent = '›';
        separator.setAttribute('aria-hidden', 'true');
        nodes.push(separator);
      }

      const chip = doc.createElement('span');
      chip.className = 'nestboard-mind-outline-crumb';
      chip.textContent = crumb.text.length > 0 ? crumb.text : t('mind.outline.untitled');
      // 最后那一格就是"现在这一支"：它是当前所在，不是可点的目的地
      if (index === crumbs.length - 1) {
        chip.classList.add('is-current');
        chip.setAttribute('aria-current', 'true');
      } else {
        chip.setAttribute('role', 'button');
        chip.setAttribute('tabindex', '-1');
        // ★★ 用 `pointerdown` 而不是 `click`（用户 2026-09-18："面包屑导航点击没效果"）：
        //   这条面包屑是**画布的子节点**，而画布在 `pointerdown` 上开始平移 / 框选，
        //   那一下里带 `preventDefault()` ⇒ 浏览器**不再派发后续的 `click`**
        //   ⇒ 挂在 `click` 上的处理函数永远收不到（看着就是"点了没反应"）。
        //   改在 `pointerdown` 上接，并且**先挡住冒泡**，画布就不会把这当成一次拖拽。
        chip.addEventListener('pointerdown', (event) => {
          event.stopPropagation();
          event.preventDefault();
          this.setFocus(crumb.id);
        });
      }
      nodes.push(chip);
    });
    return nodes;
  }
  /** 底部居中的节点快捷操作栏（`08 §3`；同上，随画布一起没） */
  private toolbar: NodeToolbar | null = null;
  /** 正在拖（`null` = 没在拖） */
  private drag: DragState | null = null;
  /** 正在拉图片的角（`null` = 没在拉） */
  private imageResize: ImageResizeState | null = null;
  /** 等着被定位的节点（视图刚建、内容还没到位时先记着，见 `revealNodeById`） */
  private pendingReveal: string | null = null;
  /** 按下但还没超过阈值 —— 超过就真的开始拖 */
  private pendingDrag: PendingDrag | null = null;
  /** 正在框选（左键在空白处拖） */
  private marquee: MarqueeState | null = null;
  /** 悬停展开的计时器（挂在哪个折叠节点上 + 到点展开） */
  private hoverExpand: { nodeId: string; timer: number } | null = null;
  /**
   * 辅助线开关（`D`，`06 §4.1`）。
   *
   * ★ **纯视图状态，不落盘**：它是"这一刻想不想看见参考线"，属于人而不属于这份脑图文件。
   * ★ 关掉之后拖拽照旧能用（落点判定与松手落位都在），只是不再画环与虚线。
   */
  private guidesOn = true;

  private cameraFrame: number | null = null;
  /** 打字时的"只重排"帧任务（见 `scheduleRelayout`） */
  private relayoutFrame: number | null = null;
  private viewportSave: Debounced | null = null;
  private messageEl: HTMLElement | null = null;
  private disposers: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, plugin: NestboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_MIND;
  }

  override getDisplayText(): string {
    return this.mind?.meta.title || this.file?.basename || t('view.mind.name');
  }

  override getIcon(): string {
    return 'git-fork';
  }

  // ── 命令层的可用条件（`commands.ts` 只读这些，不自己碰模型） ──

  private get writable(): boolean {
    return !this.editing && this.mindWritable;
  }

  /**
   * 与 `writable` 的唯一区别：**不含 `!this.editing`**（`06 §11.56`）。
   *
   * ★ `writable` 是给**命令层**的可用条件用的（`canAddChild` / 菜单置灰…）：
   *   编辑器开着时，别处不该再往模型里塞东西 —— 那时键位归输入框。
   *   而**编辑态里的那几个键**（`⏎` 拆行 / `Tab` 缩进 / `⌥⏎`）恰恰**只在编辑器开着时**
   *   才有机会跑 —— 用 `writable` 当闸门，等于"只在门锁着的时候才让人进门"
   *   （真实报障：编辑态按 `⏎` / `Tab` 全部静默无效；构建戳确认包是新的、控制台无报错，
   *   最后靠读 `writable` 的定义才定案）。
   * ★ 调用方仍须先把编辑器**收掉**再走 `edit()`（`commitTitleEdit` 就是这个顺序）：
   *   `edit()` 自己也查 `writable`，那时 `editing` 已是 `null`，闸门是开的。
   */
  private get mindWritable(): boolean {
    const path = this.file?.path;
    if (!path || !this.mind) return false;
    return !this.plugin.mindRepository.isReadOnly(path);
  }

  get canUndo(): boolean {
    return this.writable && this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.writable && this.history.canRedo;
  }

  get canAddChild(): boolean {
    return this.writable && this.selectedId !== null;
  }

  get canAddSibling(): boolean {
    return this.writable && this.selectedId !== null;
  }

  /**
   * 根节点删不得（`06 §1` 第 9 条）：命令面板里那一条于是自动置灰。
   *
   * ★ 多选时看的是"**入口**里有没有非根的"：同时选中根与它下面的三支时，
   *   那三支照删（根自己会被跳过），所以这一条仍然可用。
   */
  get canDeleteSelection(): boolean {
    const mind = this.mind;
    if (!this.writable || !mind) return false;
    return selectionRoots(mind, this.selectedIds).some((id) => id !== mind.rootId);
  }

  get canEditSelection(): boolean {
    return this.writable && this.selectedId !== null;
  }

  /** `⌘A`：至少有两个可见节点才谈得上"全选" */
  get canSelectAll(): boolean {
    const mind = this.mind;
    if (!this.writable || !mind) return false;
    return visibleIds(mind).length > 1;
  }

  get canPromoteSelection(): boolean {
    const mind = this.mind;
    const id = this.selectedId;
    if (!this.writable || !mind || !id) return false;
    const parent = nodeById(mind, id)?.parentId ?? null;
    if (parent === null) return false;
    return nodeById(mind, parent)?.parentId !== null;
  }

  get canToggleCollapse(): boolean {
    const mind = this.mind;
    if (!this.writable || !mind) return false;
    // 多选时"只要有一个能折"就可用：其余没孩子的会被跳过（见 `toggleSelectionCollapse`）
    return selectionRoots(mind, this.selectedIds).some((id) => hasChildren(mind, id));
  }

  /** 「适应脑图内容」的可用条件：这份脑图已经读进来了（没有内容时它无意义） */
  get mindLoaded(): boolean {
    return this.mind !== null;
  }

  get canCopySelection(): boolean {
    return this.writable && this.selectedIds.size > 0;
  }

  /**
   * 剪切：与"删除"同一条门槛 —— **根节点剪不掉**。
   *
   * ★ 剪掉中心主题，这份脑图就没有根了（`06 §1` 第 9 条）。要复制它当然可以，
   *   所以 `⌘X` 在根上仍然把整棵树放进剪贴板（见 `cutSelection`），只是不删。
   */
  get canCutSelection(): boolean {
    return this.canDeleteSelection;
  }

  get canPaste(): boolean {
    return this.writable && getMindClipboard() !== null;
  }

  // ── 命令层入口（动作） ──────────────────────────────────

  /** ⌘Z */
  undo(): void {
    this.applyHistory('undo');
  }

  /** ⌘⇧Z */
  redo(): void {
    this.applyHistory('redo');
  }

  /** 适到屏幕里（「适应脑图内容」命令） */
  fitContent(): void {
    this.viewport.fit(this.layout?.bounds ?? null);
  }

  // ── 视图「…」菜单（`onPaneMenu`，用户 2026-09-17）────────────────
  //
  // 用户原话："相同的导出能力，脑图也要做一遍。也是注入到 obisidian 原生的菜单中。"
  // ★ 与白板那条（`BoardView.onPaneMenu`）逐字同一条做法：先 `super`（Obsidian 自己
  //   在「…」里铺了"左右分屏 / 上下分屏"），再把自己的几项接在后面。

  /**
   * 注入 Obsidian 自己的「…」菜单。
   *
   * ★★ `super.onPaneMenu(...)` **必须先调**：那两项分屏是基类铺的，覆写时忘了调
   *   就等于把它们删掉（白板那边踩过一次，见 `04 §66.1`）。
   * ★ 只接 `'more-options'`：`'tab-header'` 是标签页右键菜单，塞八项会把
   *   "重命名 / 关闭标签"挤得很乱。
   */
  override onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);

    if (source !== 'more-options') return;
    const items = this.mindMenuItems();
    if (items.length === 0) return;
    menu.addSeparator();
    appendMenuItems(menu, items);
  }

  /**
   * 「…」菜单里的清单（`ui/ContextMenus.appendMenuItems` 消费）。
   *
   * ★ 每一项都指向**已有的通路**（`exportAs(kind)` / `fitContent()` / `toggleOutline()`），
   *   标题复用 `command.*.name` —— 与命令面板不可能措辞漂移。
   * ★ 每次点开现取一遍：`mindLoaded` 是**此刻**的事实（板子刚打开、还没读完时不该能导出）。
   */
  private mindMenuItems(): MindMenuItemSpec[] {
    const actions: MindMenuActions = {
      exportPng: () => void this.exportAs('png'),
      exportSvg: () => void this.exportAs('svg'),
      exportOutlineMarkdown: () => void this.exportAs('outlineMarkdown'),
      exportMarkdown: () => void this.exportAs('markdown'),
      exportFreeMind: () => void this.exportAs('freemind'),
      exportXmind: () => void this.exportAs('xmind'),
      toggleOutline: () => this.toggleOutline(),
      fit: () => this.fitContent(),
    };
    return mindMenuItems(actions, { loaded: this.mindLoaded });
  }

  addChildToSelection(): void {
    const id = this.selectedId;
    if (!id) return;
    const created = this.edit(t('history.mindAddChild'), (mind) => addChild(mind, id));
    if (created) this.selectAndEdit(created);
  }

  addSiblingToSelection(): void {
    const id = this.selectedId;
    if (!id) return;
    const created = this.edit(t('history.mindAddSibling'), (mind) => addSibling(mind, id));
    if (created) this.selectAndEdit(created);
  }

  promoteSelection(): void {
    const id = this.selectedId;
    if (!id) return;
    this.edit(t('history.mindPromote'), (mind) => promote(mind, id));
  }

  /**
   * `⏎`（选中一行、**没在改字**时）= 与"光标在**文字末尾**按 `⏎`"**同一套规则**（`N3-i`）。
   *
   * ★ 为什么两条路必须一样（这是"没生效"那一轮换来的教训）：`⏎` 的结果不该取决于
   *   "编辑器开着没有"。点击一行会**直接进编辑态**（`onPick`），而"光标在文字末尾"与
   *   "只是选中了这一行"在用户心里是**同一个位置**（他还没往中间插过字）⇒ 两条路必须落到
   *   幕布那三条规则上（`ops.enterAtEnd`）：叶子 / 收起 ⇒ 下方新建同级；展开 ⇒ 建第一个子节点；
   *   空叶子且最末 ⇒ 提升一级。
   * ★ 行的**右键菜单**里那个"新建同级"仍然走 `addSiblingToSelection()`（菜单是明确点名的动作，
   *   不该被这三条规则改写）。
   */
  endEnterOnSelection(): void {
    const id = this.selectedId;
    if (!id) return;
    let target: string | null = null;
    this.edit(t('history.mindAddSibling'), (mind) => {
      target = enterAtEnd(mind, id);
      return target !== null;
    });
    // ★ 新建 / 提升完**就地进编辑态**（与编辑器那条路同一个结果：按完 `⏎` 就能接着打字）。
    //   从前这里只是改完模型就收工 ⇒ 新节点没拿到光标，用户得再点一下它
    //   （真实报障："必须点一下这个创建的新节点，再回车，才能创建兄弟节点"）。
    if (target !== null) this.selectAndEdit(target);
  }

  /**
   * `Tab`（选中一行、**没在改字**时）= **缩进一层**（`N3-i`）。
   *
   * ★ 与编辑器里那一档（`shiftOutlineRow('indent')`）是**同一个动作** ——
   *   `Tab` 不能因为"光标在不在字里"而换个意思。
   */
  indentSelection(): void {
    const id = this.selectedId;
    if (!id) return;
    this.edit(t('history.mindMove'), (mind) => indent(mind, id));
  }

  deleteSelection(): void {
    const mind = this.mind;
    if (!mind) return;
    const id = this.selectedId;
    const fallbackId = id ? (nodeById(mind, id)?.parentId ?? mind.rootId) : mind.rootId;
    // 删之前数一遍：用户需要知道"这一下删了多少"（`06 §4.1`）。
    // ★ 提示放在**删之后**而不是之前：删之前那一句既不能撤回、也没给任何选择，
    //   只是挡在动作前面的一句话；删之后说"删了 3 个，⌘Z 可撤销"才是有用的信息。
    // ★ 多选时按**入口**合计：同时选中甲与甲一时，甲一已经被算在甲那一支里了。
    const count = selectionRoots(mind, this.selectedIds).reduce(
      (total, root) => total + subtreeIds(mind, root).size,
      0,
    );
    if (!this.edit(t('history.mindDelete'), (current) => removeNodes(current, this.selectedIds))) {
      return;
    }
    // 只删一个叶子不必报数（节点本来就在眼前消失了）；删掉一整支才值得说一声
    if (count > 1) new Notice(t('notice.mindDeleted', { count: String(count) }));
    this.selectNode(this.mind ? fallbackId : null);
  }

  /**
   * `Space`：折叠 / 展开。
   *
   * ★ 多选时"一次全折"或"一次全开"，判据是**有没有还开着的**（有一个开着就全折）——
   *   这也是各家大纲 / 脑图的通行手感：按一次 `Space` 期望看到"都收起来"。
   * ★ 没孩子的节点跳过（折叠它对谁都没意义）。
   */
  toggleSelectionCollapse(): void {
    const mind = this.mind;
    if (!mind) return;
    const roots = selectionRoots(mind, this.selectedIds).filter((id) => hasChildren(mind, id));
    if (roots.length === 0) return;
    const anyExpanded = roots.some((id) => nodeById(mind, id)?.collapsed !== true);

    this.edit(t('history.mindToggleCollapse'), (current) => {
      let changed = false;
      for (const id of roots) {
        if (setCollapsed(current, id, anyExpanded)) changed = true;
      }
      return changed;
    });
  }

  /**
   * `⌘A`：全选**可见**节点（折叠藏起来的不算）。
   *
   * ★ 只选可见的：藏起来的节点被选中时，用户既看不见也没法取消 —— 而删除会把它们
   *   一起带走。这里的取舍是"宁可少选，不要选到看不见的东西"。
   */
  selectAllNodes(): void {
    const mind = this.mind;
    if (!mind || !this.writable) return;
    // ★ 大纲视图里"全选"只能选**看得见的行**：画布那份 `visibleIds` 含悬浮节点，
    //   而悬浮节点在大纲里没有行 —— 选中它们，用户既看不见也取消不掉
    const ids = this.outlineMode ? this.outlineRows().map((row) => row.id) : visibleIds(mind);
    this.selectedIds = new Set(ids);
    // 锚点尽量不动（用户可能正站在某一支上按方向键）
    this.selectedId =
      this.selectedId && this.selectedIds.has(this.selectedId) ? this.selectedId : (ids[0] ?? null);
    this.syncSelection();
    if (ids.length > 1) new Notice(t('notice.mindSelected', { count: String(ids.length) }));
  }

  editSelectionTitle(): void {
    const id = this.selectedId;
    if (id) this.beginTitleEdit(id);
  }

  /**
   * `⌘C`：复制这一支（连子孙一起，见 `model/clipboard`）。
   *
   * ★ 复制**不改模型**，所以不进撤销栈；给一句 `Notice` 是为了让用户确认"复制到了什么"
   *   （脑图上没有卡片那种可见的复制反馈）。
   */
  copySelection(): void {
    const mind = this.mind;
    if (!mind) return;
    const payload = copyForest(mind, this.selectedIds);
    if (!payload) return;
    setMindClipboard(payload);
    // ★★ 同时写一份**系统剪贴板**（用户 2026-09-17）：`text/plain` 给"人读的文字"、
    //   `text/html` 里带我们自己的载荷 ⇒ 粘贴时按**格式**认亲（幕布 / 飞书就是这么做的）。
    //   ★ 写失败（没焦点 / 系统拒绝）不影响用：内存剪贴板照旧有效。
    void this.writeSystemClipboard(payload);
    if (payload.roots.length === 1) {
      new Notice(t('notice.mindCopied', { text: clipboardLabelOf(payload) }));
      return;
    }
    new Notice(t('notice.mindCopiedMany', { count: String(payload.roots.length) }));
  }

  /** `⌘X`：复制 + 删掉（根节点只复制：它删不得） */
  cutSelection(): void {
    const id = this.selectedId;
    if (!id) return;
    this.copySelection();
    if (!this.canCutSelection) return;
    this.deleteSelection();
  }

  /**
   * `⌘V`：粘成**选中节点的子节点**（没选中就粘到中心主题下）。
   *
   * ★ 粘的位置是"子级"而不是"兄弟级"：脑图里"粘到某一支下面"是最常见的意思，
   *   而粘成兄弟需要先想清楚"和谁同级"，反而绕。
   */
  pasteClipboard(): void {
    const mind = this.mind;
    if (!mind) return;
    const payload = getMindClipboard();
    if (!payload) {
      // ★ 节点剪贴板是空的 ⇒ 试试**系统剪贴板里的文字**（"通用 ⌘V"：
      //   从别处复制一段字，选中一个节点按 `⌘V` ⇒ 每行变成一个子节点）。
      //   两条路都不成时，`pasteTextClipboard` 里那句提示会把话说清楚。
      void this.pasteTextClipboard();
      return;
    }
    this.pastePayload(payload, this.selectedId ?? mind.rootId);
  }

  /**
   * 把一簇节点粘到 `parentId` 下面（`⌘V` 与"编辑器里认出自家格式"两条路共用）。
   *
   * ★ 抽出来是因为调用方多了一处（粘贴事件里认亲那一路）—— 两处各写一份的话，
   *   "粘完要不要一起选中""粘不下要不要说话"迟早长成两个样子。
   */
  private pastePayload(payload: MindClipboard, parentId: string): void {
    // 从系统剪贴板认回来的那一份也**写回内存剪贴板**：接着按 `⌘V` 应当还能粘
    setMindClipboard(payload);
    const created = this.edit(t('history.mindPaste'), (current) =>
      pasteForest(current, payload, parentId),
    );
    // 粘出来的可能是好几支：把它们**一起选中**（接着拖走 / 删掉都顺理成章）
    if (!created || created.length === 0) return;
    this.selectedIds = new Set(created);
    this.selectedId = created[0] ?? null;
    this.syncSelection();
  }

  /**
   * 复制时**同时**写系统剪贴板（`text/plain` + `text/html`）。
   *
   * ★ `text/plain` = 缩进的可读文字（粘到笔记 / 别处得到的是"像样的文字"）；
   *   `text/html` = 真正的嵌套列表 + 我们自己的载荷（粘贴时按它认亲）。
   * ★ 失败的两种常见情形都不致命：没有用户手势 / 系统剪贴板被别的程序占着
   *   —— 内存剪贴板仍然是完整的，`⌘V` 照旧能用。
   */
  private async writeSystemClipboard(payload: MindClipboard): Promise<void> {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([mindClipboardText(payload)], { type: 'text/plain' }),
          'text/html': new Blob([mindClipboardHtml(payload)], { type: 'text/html' }),
        }),
      ]);
    } catch {
      // 写不进去就算了：内存那一份才是 `⌘V` 的主路径
    }
  }

  /**
   * 右键菜单里的「原地复制」：复制一份，紧挨着原节点（`08 §2.1`）。
   *
   * ★ 与粘贴共用一套拷贝，差别只在落点（见 `clipboard.duplicateNodes`）。
   * ★ 复制出来的那几支**一起选中** —— "再来一份"之后接着要做的多半就是挪它 / 改它。
   */
  duplicateSelection(): void {
    const mind = this.mind;
    if (!mind || !this.writable) return;
    const created = this.edit(t('history.mindDuplicate'), (current) =>
      duplicateNodes(current, this.selectedIds),
    );
    if (!created || created.length === 0) return;
    this.selectedIds = new Set(created);
    this.selectedId = created[0] ?? null;
    this.syncSelection();
  }

  // ── 生命周期 ────────────────────────────────────────────

  override async onOpen(): Promise<void> {
    this.contentEl.addClass(VIEW_CLASS);
    const doc = this.contentEl.ownerDocument;

    const canvas = doc.createElement('div');
    canvas.className = 'nestboard-mind-canvas';
    // 键盘焦点落在画布上：`Tab` / `Enter` / 方向键才有主
    canvas.tabIndex = 0;
    const world = doc.createElement('div');
    world.className = 'nestboard-mind-world';
    const edges = buildEdgeLayer(doc);
    // 关联线（`N1`）：独立一层 —— 连线的层每次整层重画，两条数据源混在一层里会互相擦掉
    const links = buildLinkLayer(doc);
    // 「正在拉的那条线」的预览（`N1-b`）：又一独立层（它每帧都在变）
    const linkPreview = buildLinkPreviewLayer(doc);
    const nodes = doc.createElement('div');
    nodes.className = 'nestboard-mind-nodes';
    const handles = doc.createElement('div');
    handles.className = 'nestboard-mind-handles';
    // 关联线的**弯折手柄**（`N1-d`，用户 2026-09-17："连线上加个手柄，可以调节连线的
    // 弯折程度和方向"）：选中一条线时出现在曲线中点上，拖它调弯折。
    // ★ 挂在**世界容器**里（与折叠手柄同一个选择）：它必须跟着相机缩放平移，
    //   而位置就是"曲线中点"那个世界坐标点（`syncLinkHandle` 每帧摆一次）。
    // ★ `<span>` 而不是 `<button>`：Obsidian 自带规则会给 `button` 糊一层底色
    //   （大纲那对圆点 / 三角就是这么返工的）。
    const linkHandle = doc.createElement('span');
    linkHandle.className = MIND_LINK_HANDLE_CLASS;
    linkHandle.setAttribute('role', 'button');
    linkHandle.setAttribute('tabindex', '-1');
    linkHandle.setAttribute('aria-label', t('mind.linkHandle.label'));
    const guide = buildGuideLayer(doc);
    // 层次：连线 → 节点 → **手柄** → 辅助线。
    // 手柄压在节点之上（它骑在节点的边上），辅助线再压在一切之上
    // 关联线压在**分支线之上、节点之下**：既盖住分支线（它是用户手画的重点），
    // 又不遮节点（线进到框下面去）
    world.append(edges, links, nodes, handles, linkHandle, linkPreview, guide.svg);
    canvas.appendChild(world);

    // 框选框：挂在**画布**上（屏幕坐标）而不是世界容器里 —— 它的大小就是屏幕上那块，
    // 与世界坐标的缩放无关，挂世界容器反而要反算一遍
    const marquee = doc.createElement('div');
    marquee.className = 'nestboard-mind-marquee';
    marquee.setAttribute('aria-hidden', 'true');
    marquee.setCssStyles({ display: 'none' });
    canvas.appendChild(marquee);
    this.marqueeEl = marquee;
    this.contentEl.replaceChildren(canvas);

    this.canvasEl = canvas;
    this.worldEl = world;
    this.edgeLayerEl = edges;
    this.linkLayerEl = links;
    this.linkPreviewEl = linkPreview;
    this.guideLayer = guide;
    this.handleLayerEl = handles;
    this.linkHandleEl = linkHandle;
    this.nodeLayerEl = nodes;
    world.style.transform = this.viewport.transform();

    this.navigationController = new NavigationController({
      host: canvas,
      viewport: this.viewport,
      // ★ 指针底下**有节点就不算空白**（P3-b）：在节点上左键拖动是"挪这一支"，
      //   不是把相机拽走。判据与选中读同一个属性，不另立一套。
      isBackground: (target) => this.nodeIdOfTarget(target) === null,
      // ★ 空白处左键拖动**不平移**（`06 §4.2`）：那是**框选**。
      //   平移留给中键与 `Space`+拖动（`shouldStartPan` 里那两条不受此参数影响）——
      //   与白板是同一套手感（白板也不传这一项）。
    });

    this.observer = new ResizeObserver(() => {
      // ★ 大纲视图里画布是 `display: none` ⇒ `clientWidth` 是 0。不挡的话视口会被
      //   置成 0×0，切回树视图时 `visibleBounds()` 只是原点附近一小块 ⇒ 什么都画不出来、
      //   也量不到尺寸 ⇒ 整棵树塌成最小宽度（这类"切回来全乱了"最难查）
      if (this.outlineMode) return;
      this.viewport.setSize(canvas.clientWidth, canvas.clientHeight);
      this.applyCamera();
    });
    this.observer.observe(canvas);

    // 左下角那条浮层（`08 §1`）：缩放 / 总体结构 / 分支线形态。
    // ★ 挂在**画布**上而不是世界容器里 ⇒ 不随缩放变形（与白板的工具栏同一条）
    this.controls = buildCanvasControls(doc, {
      zoomIn: () => this.zoomStep(1),
      zoomOut: () => this.zoomStep(-1),
      zoomReset: () => this.zoomReset(),
      fit: () => this.fitContent(),
      structure: this.structure,
      onStructure: (structure) => this.applyStructure(structure),
      edge: this.edgeStyle,
      onEdge: (edge) => this.applyEdgeStyle(edge),
    });
    this.controls.setZoom(this.viewport.zoom);
    canvas.appendChild(this.controls.element);

    // 快捷操作栏（`08 §3`）：**画布下方居中**，选中单个节点时出现。
    // ★ 与左下角那条浮层同一层（都挂在画布上、都不随世界缩放）
    this.toolbar = buildNodeToolbar(doc, {
      onIcon: (icon) => this.applyNodeStyle({ icon }),
      onBold: () => this.toggleTitleFlag('bold'),
      onItalic: () => this.toggleTitleFlag('italic'),
      onUnderline: () => this.toggleTitleFlag('underline'),
      onColor: (color) => this.applyNodeStyle({ color }),
      onInk: (ink) => this.applyNodeStyle({ ink }),
      // 「文字高亮」（`N3-f`）：与字色同一路，只是落在**文字那一块**背后
      onHighlight: (highlight) => this.applyNodeStyle({ highlight }),
      onEditNote: () => {
        const id = this.selectedId;
        if (id) this.beginNoteEdit(id);
      },
      onInsertImage: () => {
        const id = this.selectedId;
        if (id) this.pickImageFor(id);
      },
      // 「连线」（`N1-b`）：正在连的时候再点一下 = 放弃（与点空白处一个意思）
      onLink: () => (this.linking ? this.cancelLink() : this.beginLink()),
      // 色块画成**用户主题里那个色**：解析不出真色时才退回近似值
      resolveTheme: (color) => this.resolveTheme?.(color) ?? themeColorPreviewOf(color),
    });
    canvas.appendChild(this.toolbar.element);

    // ── 大纲视图（`N3-a`）──────────────────────────────────
    // 右上角那个「大纲 / 树」切换（用户 2026-09-16 定：右上角按钮）。
    // ★ 挂在**视图容器**（`contentEl`）上而不是画布上：切到大纲时画布整个隐了，
    //   挂在画布上就跟着一起消失 —— 用户再也切不回树视图（最糟的一种"卡死"）。
    // 大纲 / 树的**切换器**（用户 2026-09-17 定稿：左上角、竖排两格、白卡片、
    // 图标用他给的两份设计稿）。点哪格去哪边；点当前那一格是空操作。
    const toggle = buildViewToggle(
      doc,
      {
        onOutline: () => {
          if (!this.outlineMode) this.toggleOutline();
        },
        onTree: () => {
          if (this.outlineMode) this.toggleOutline();
        },
      },
      { outline: t('mind.outline.toOutline'), tree: t('mind.outline.toTree') },
    );
    this.contentEl.appendChild(toggle);
    this.outlineToggleEl = toggle;

    const outline = buildOutlinePanel(doc);
    // 面板也挂 `contentEl`：它与画布**二选一**，谁都不在对方里面
    this.contentEl.appendChild(outline.element);
    // ★ 键位挂在**面板**上（画布那份监听器此刻收不到键：它 `display: none`）——
    //   两份监听器指向同一个 `onKeyDown`，里面再按 `outlineMode` 分流
    outline.element.addEventListener('keydown', this.onKeyDown);
    // 拖拽调整结构（`N3-d`）：事件**委托**在面板上（`render` 每次换一批行，
    // 挂在行上的监听器留不住）—— `pointerdown` 认抓手，move/up 靠指针捕获收在这里
    outline.element.addEventListener('pointerdown', this.onOutlinePointerDown);
    outline.element.addEventListener('pointermove', this.onOutlinePointerMove);
    outline.element.addEventListener('pointerup', this.onOutlinePointerUp);
    outline.element.addEventListener('pointercancel', this.onOutlinePointerUp);
    this.outlinePanel = outline;
    // 框选那个虚线框（`N3-h`）：挂在**面板**里（绝对定位、跟着内容滚）
    const outlineMarquee = doc.createElement('div');
    outlineMarquee.className = 'nestboard-mind-outline-marquee';
    outline.element.append(outlineMarquee);
    this.outlineMarqueeEl = outlineMarquee;

    // 剪贴板三键挂窗口捕获阶段（见 `onWindowKeyDown` 上的说明）
    window.addEventListener('keydown', this.onWindowKeyDown, true);
    canvas.addEventListener('keydown', this.onKeyDown);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('dblclick', this.onCanvasDoubleClick);
    // 拖文件进来（`06 §4.1` 的 `B`）：挂在画布上，"拖到画布之外"根本不会触发 ——
    // 靠**监听范围**而不是坐标判断（分屏 / 弹出窗口里坐标判断迟早算错，白板那边同一条）
    // ★ `dragenter` 与 `dragover` 同一个处理函数：前者是许多实现**真正决定**
    //   "这里能不能放"的时机，只在 `dragover` 上 `preventDefault` 会有人放不进来
    //   （白板那条注释的原话，照抄）
    canvas.addEventListener('dragenter', this.onCanvasDragOver);
    canvas.addEventListener('dragover', this.onCanvasDragOver);
    canvas.addEventListener('dragleave', this.onCanvasDragLeave);
    canvas.addEventListener('drop', this.onCanvasDrop);
    canvas.addEventListener('contextmenu', this.onCanvasContextMenu);

    // 附件被删 / 被移到库外 ⇒ 回形针那一枚"失效"标记要**当场**刷新（`06 §6` 的断链态）；
    // 改名则相反 —— 引用由 `RenameWatcher` 跟着改掉，这里只是把那一枚标记重算一遍。
    // ★ `registerEvent` 是 Obsidian 的组件级订阅：视图关闭时自动退订（不必手动收）
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) this.refreshRefState(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.refreshRefState(oldPath);
        this.refreshRefState(file.path);
      }),
    );

    // 缩略图导航器（`P2-c` / `F1-06`）：与白板的工具条同理，挂在**画布**里（屏幕坐标的浮层，
    // 画布本身 `position: relative`）—— 进世界容器会跟着缩放平移跑掉。
    this.createMinimap(canvas);

    // 树视图的面包屑（用户 2026-09-18）：与工具条 / 缩略图一样是**屏幕坐标的浮层**，
    // 挂在画布里（画布本身 `position: relative`）；进世界容器会跟着缩放平移跑掉。
    // 内容由 `syncMindCrumbs()` 在每次渲染时重算（与缩略图同一个节奏）。
    // ★ 一开始就带 `is-hidden`：没聚焦时那条路径没有意义，不该闪一下再消失。
    this.crumbsEl = canvas.createDiv({ cls: 'nestboard-mind-crumbs is-hidden' });

    this.viewportSave = debounce(() => this.persistViewport(), VIEWPORT_SAVE_MS);
    this.disposers.push(
      this.viewport.onChange(() => this.scheduleCamera()),
      this.plugin.mindRepository.on('changed', ({ path, mind }) => {
        if (path !== this.file?.path) return;
        this.mind = mind;
        // 撤销写回也会走到这里（`mutate` 发 `changed`）—— 那时不要重画两次
        this.render();
      }),
      // ★ 外部改动换了模型 ⇒ 旧快照指向的是上一份内容，撤销栈必须清掉
      this.plugin.mindRepository.on('reloaded', ({ path }) => {
        if (path !== this.file?.path) return;
        this.history.clear();
      }),
      this.plugin.mindRepository.on('protected', ({ path }) => {
        if (path !== this.file?.path) return;
        this.history.clear();
        this.renderMessage(t('mind.loadFailed'));
      }),
    );
  }

  override async onClose(): Promise<void> {
    const path = this.file?.path;
    if (path) await this.plugin.mindRepository.flush(path);
    // ★ 冲突未决时关标签 = 内存里那份改动**随后就没了**（仓储不再自动重试，`03 §3.4` 的规矩）。
    //   用户很可能只是把对话框随手关掉（"暂不处理"），这里必须说一句 ——
    //   不然他只会看到"关了个弹窗"，而改动悄无声息地消失。
    if (path && this.plugin.mindRepository.getState(path) === 'conflict') {
      new Notice(t('notice.mindConflictOnClose', { path }), 8000);
    }
    this.persistViewport();
    this.cancelTitleEdit();
    // 关视图时正在编辑内容：**不提交**（与白板卡片的取舍一致），只把状态收干净
    this.endNoteEdit(false);
    // 关视图时正在拖 / 正在框 / 正在拉角：**什么都不改**（松手才算数），只把预览收干净
    this.cancelDrag();
    this.cancelImageResize();
    this.clearMarquee();

    this.observer?.disconnect();
    this.observer = null;
    this.navigationController?.dispose();
    this.navigationController = null;
    const canvas = this.canvasEl;
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    canvas?.removeEventListener('keydown', this.onKeyDown);
    canvas?.removeEventListener('pointerdown', this.onPointerDown);
    canvas?.removeEventListener('pointermove', this.onPointerMove);
    canvas?.removeEventListener('pointerup', this.onPointerUp);
    canvas?.removeEventListener('pointercancel', this.onPointerUp);
    canvas?.removeEventListener('dblclick', this.onCanvasDoubleClick);
    canvas?.removeEventListener('dragenter', this.onCanvasDragOver);
    canvas?.removeEventListener('dragover', this.onCanvasDragOver);
    canvas?.removeEventListener('dragleave', this.onCanvasDragLeave);
    canvas?.removeEventListener('drop', this.onCanvasDrop);
    canvas?.removeEventListener('contextmenu', this.onCanvasContextMenu);
    if (this.cameraFrame !== null) window.cancelAnimationFrame(this.cameraFrame);
    this.cameraFrame = null;
    if (this.relayoutFrame !== null) window.cancelAnimationFrame(this.relayoutFrame);
    this.relayoutFrame = null;
    this.viewport.dispose();
    this.history.clear();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.mounted.clear();
    this.measured.clear();
    this.rendered.clear();
    this.handles.clear();
    this.mind = null;
    this.selectedId = null;
    this.selectedIds = new Set();
    this.minimap?.dispose();
    this.minimap = null;
    this.controls = null;
    this.toolbar = null;
    this.canvasEl = null;
    this.worldEl = null;
    this.nodeLayerEl = null;
    this.edgeLayerEl = null;
    this.linkLayerEl = null;
    this.linkPreviewEl = null;
    this.linking = null;
    this.linkEdit = null;
    this.selectedLinkId = null;
    this.outlinePanel = null;
    this.outlineToggleEl = null;
    this.outlineDrag = null;
    this.outlineMarquee = null;
    this.outlineMarqueeEl = null;
    this.linkHandleEl = null;
    this.linkBendDrag = null;
    this.suppressRowClick = false;
    this.outlineNote = null;
    this.guideLayer = null;
    this.handleLayerEl = null;
    this.marqueeEl = null;
  }

  override async onLoadFile(file: TFile): Promise<void> {
    const mind = await this.plugin.mindRepository.open(file.path);
    if (!mind) {
      this.renderMessage(t('mind.loadFailed'));
      return;
    }
    this.mind = mind;
    // 换了文件：撤销栈里的快照指向的是上一份脑图，一条都不能留
    this.history.clear();
    // 默认选中中心主题：打开就能按 `Tab`（"不碰鼠标从空图敲出一棵树"的起点）
    this.selectedId = mind.rootId;
    this.selectedIds = new Set([mind.rootId]);
    this.viewport.applyState(mind.view);
    this.viewport.setSize(this.canvasEl?.clientWidth ?? 0, this.canvasEl?.clientHeight ?? 0);
    // ★ 新建的脑图（只有中心主题）：把它摆在**视口正中** —— 文件里那套视口是默认值，
    //   而画布尺寸这次才知道（`setSize` 就在上一行），不摆正的话中心主题可能落在屏幕角落，
    //   用户第一眼看到的是"一片空白"（`06 §4.1`：创建新脑图时根节点居中）
    if (mind.nodes.length <= 1) this.viewport.centerOn({ x: 0, y: 0 });
    this.applyCamera();
    // 换了文件：左下角那三个"现在是什么"跟着换（结构与线型是**文件里**的状态）
    this.controls?.setStructure(this.structure);
    this.controls?.setEdge(this.edgeStyle);
    this.render();
    // 反链面板可能在视图**刚建**时就要求定位某个节点（那时还没有模型）——
    // 现在模型与布局都齐了，补上那一次（`revealNodeById` 的注释）
    if (this.pendingReveal !== null) this.applyReveal(this.pendingReveal);
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    await this.plugin.mindRepository.flush(file.path);
    this.cancelTitleEdit();
    this.endNoteEdit(false);
    this.cancelDrag();
    this.cancelImageResize();
    this.cancelRelayoutFrame();
    this.clearMarquee();
    this.history.clear();
    this.mind = null;
    this.selectedId = null;
    this.selectedIds = new Set();
    this.layout = null;
    this.clearCanvas();
  }

  // ── 键盘 ────────────────────────────────────────────────

  /**
   * 画布键位（`06 §4.1`）。
   *
   * ★ 正在改标题时**整段不接**：那时键位归输入框自己（它有自己的 `keydown`）。
   * ★ `preventDefault()` 是必须的：不挡 `Tab`，焦点会跑出画布；不挡方向键，
   *   画布会被浏览器滚走（而且 Obsidian 自己也在监听方向键）。
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // 正在输入（改标题 / 改内容）：键位归输入框。★ 这一句是**必须**的 ——
    // 编辑器是画布的后代，它的 `Enter` / `Tab` 会冒泡到这里来，
    // 不挡的话"在内容里换行"会变成"加一个兄弟节点"。
    // ★ 改标签时整段不接（与改标题同理）：`Enter` / `Esc` 归那个输入框自己
    if (this.editing || this.noteEdit || this.linkEdit) return;
    // ★ 大纲视图的键位（`N3-b`）：整套归 `outlineKeys` 那张表（主口径对齐幕布），
    //   而动作落到与画布**同一批**方法上 —— 于是"大纲里按 `Tab`"与"画布上按 `Tab`"
    //   不可能出现两套结果（`09 §3.3` 那张表就是这条）
    if (this.outlineMode && this.handleOutlineKey(event)) {
      event.preventDefault();
      return;
    }
    // ★ 选中一条线时 `⏎` = 改它的标签（`N1-c`）—— 排在键位表之前：键位表里
    //   `Enter` 是"加兄弟节点"，而此刻用户选中的是一条线，加兄弟无从谈起
    if (event.key === 'Enter' && this.selectedLinkId !== null) {
      event.preventDefault();
      this.beginLinkLabelEdit(this.selectedLinkId);
      return;
    }
    // 拖弯折手柄时 `Esc` = 放弃这一拖（模型一个字节都没动过，把预览收掉就行）——
    // ★ 排在连线之前：它是**最近**开始的那个手势
    if (event.key === 'Escape' && this.linkBendDrag) {
      event.preventDefault();
      this.cancelLinkBendDrag();
      return;
    }
    // 连线态 `Esc` = 放弃这条线（模型一个字节都没动过，收干净就走）——
    // ★ 排在框选 / 拖拽 / 拉角之前：连线是**最近**开始的那个手势，`Esc` 该收的是它
    if (event.key === 'Escape' && this.linking) {
      event.preventDefault();
      this.cancelLink();
      return;
    }
    // 框选中 `Esc` = 放弃这次框选：选区回到按下之前
    if (event.key === 'Escape' && this.marquee) {
      event.preventDefault();
      this.cancelMarquee();
      return;
    }

    // 拖拽中 `Esc` = 放弃这一拖：节点回到原位，**模型一个字节都不动**
    if (event.key === 'Escape' && this.drag) {
      event.preventDefault();
      this.cancelDrag();
      return;
    }
    // 拉角中 `Esc` 同理：图片回到原来的大小
    if (event.key === 'Escape' && this.imageResize) {
      event.preventDefault();
      this.cancelImageResize();
      return;
    }

    const action = mindKeyActionOf(event);
    if (action.kind === 'none') return;
    event.preventDefault();
    event.stopPropagation();

    switch (action.kind) {
      case 'add-child':
        this.addChildToSelection();
        return;
      case 'add-sibling':
        this.addSiblingToSelection();
        return;
      case 'promote':
        this.promoteSelection();
        return;
      case 'edit-title':
        this.editSelectionTitle();
        return;
      case 'delete':
        // ★ 选中一条**关联线**时 `Delete` 删的是那条线（`N1-c`）——
        //   与"选中节点时删节点"同一个道理（线 / 节点互斥，见 `selectedLinkId`）
        if (this.selectedLinkId !== null) this.removeSelectedLink();
        else this.deleteSelection();
        return;
      case 'toggle-collapse':
        this.toggleSelectionCollapse();
        return;
      case 'toggle-guides':
        this.toggleGuides();
        return;
      case 'move':
        this.moveSelection(action.direction);
        return;
      default:
        return;
    }
  };

  /**
   * 方向键：箭头**跟着轴走**（`08 §1.2`）。
   *
   * * 横向布局（向右 / 向左 / 八爪鱼）：**上下**走可见顺序（兄弟），**左右**往父 / 孩子走；
   * * **纵向布局**（组织结构图）：两级关系长在 **y** 上、兄弟长在 **x** 上 ⇒ **上下与左右互换** ——
   *   不换的话按"下"会跑到兄弟那儿，按"右"什么都不发生，用户只会觉得方向键坏了。
   */
  private moveSelection(direction: 'up' | 'down' | 'left' | 'right'): void {
    const mind = this.mind;
    const id = this.selectedId;
    if (!mind || !id) return;

    const vertical = this.isVerticalLayout();
    const siblingStep: 1 | -1 | null = vertical
      ? direction === 'right'
        ? 1
        : direction === 'left'
          ? -1
          : null
      : direction === 'down'
        ? 1
        : direction === 'up'
          ? -1
          : null;

    if (siblingStep !== null) {
      const next = nextVisibleId(mind, id, siblingStep);
      if (next) this.selectNode(next);
      return;
    }

    // `+1` = 朝孩子那一侧，`-1` = 朝父节点那一侧（`side` 告诉它孩子长在哪边）
    const side = this.layout?.boxes.get(id)?.side ?? 0;
    const along: 1 | -1 = vertical
      ? direction === 'down'
        ? 1
        : -1
      : direction === 'right'
        ? 1
        : -1;
    const target = horizontalTargetId(mind, id, along, side);
    if (target) this.selectNode(target);
  }

  /** 现在这份布局是纵向的吗（方向键与手柄方向都要问这一句） */
  private isVerticalLayout(): boolean {
    return directionForStructure(this.structure) === 'down';
  }

  // ── 指针：选中 + 拖拽改父（P3-b） ────────────────────────

  /**
   * 按下：选中 + 记下"可能是拖拽"。
   *
   * ★ 用 `pointerdown` 而不是 `mousedown`：拖拽要 `pointerId`（`setPointerCapture` 认它），
   *   而 `MouseEvent` 上没有这个字段。
   * ★ 这里**不立刻开始拖**：先把起点记下来，等指针动过 `DRAG_THRESHOLD_PX` 才算 ——
   *   否则"点一下选中"每次都会走一遍拖拽的收尾（落点判定 + 可能的改父）。
   */
  private readonly onPointerDown = (event: PointerEvent): void => {
    // 正在改标题：这一下点击属于输入框（放光标 / 选词）。画布**不许**抢焦点 ——
    // 抢了就会让输入框失焦，标题被"改完了"提交掉，用户只是想挪一下光标。
    if (this.editing) return;

    // 同理：点在内容区编辑器里的那一下属于编辑器（放光标 / 选词）——
    // 抢焦点会让它失焦提交，而开始拖动还会顺手把节点挪走
    if (this.noteEdit?.body?.contains(event.target as Node) === true) return;

    // ★ 两条浮层（左下角画布调节 + 底部快捷操作栏）上的按下：**整条让开**。
    //   两个原因，缺一不可：
    //   ① 它们挂在画布**里面**，不平息的话这一下会同时被当成"点空白"（清选区 / 起框选）；
    //   ② 更要紧：弹层里的按钮在 `pointerdown` 之后才轮到 `click` ——
    //      这里若顺手 `closePopovers()`，按钮会在 click 之前被拆掉，**点下去永远没反应**。
    if (this.isOverlayTarget(event)) return;
    // ★ 连线态（`N1-b`）：这一次左键就是"落线"（右键走 `contextmenu` 那条路 = 放弃）。
    //   放在这里、**在 `button !== 0` 那一句之前**：右键也要能把连线态收掉，
    //   而下面那条对非左键是直接 `return` 的
    if (this.linking) {
      event.preventDefault();
      if (event.button === 0) this.commitLink();
      else this.cancelLink();
      return;
    }
    // 点到别处 ⇒ 收起弹层（点浮层自己不算"别处"，上面已经让开了）
    this.toolbar?.closePopovers();
    this.controls?.closeMenus();

    this.canvasEl?.focus();
    // 中键 / 右键只留给平移与菜单：**不碰选区**（点一下不该把辛苦选好的那一簇清掉）
    if (event.button !== 0) return;

    // ★ 回形针（`06 §4.1`）：**点一下就打开文件**。必须放在最前面 ——
    //   它挂在标题带里，不先认它的话这一下会变成"选中节点 + 开始拖这一支"
    const refPath = this.attrOfEvent(event, MIND_REF_ATTR);
    if (refPath !== null) {
      event.preventDefault();
      event.stopPropagation();
      void this.openRef(refPath);
      return;
    }

    // ★ 弯折手柄（`N1-d`）：它压在节点与线之上，点到它就是"要调这条线" ——
    //   所以排在节点 / 手柄 / 框选之前（那几档都会先把这一下吃掉）
    if (this.hitsLinkHandle(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      this.beginLinkBendDrag(event);
      return;
    }

    // ★ 图片块的四个角：拉角改尺寸（等比）。同样不动选区、不开始拖动 ——
    //   用户是在调这张卡的长相，不是在挪它
    const corner = this.attrOfEvent(event, MIND_IMAGE_RESIZE_ATTR);
    if (corner !== null) {
      const nodeId = this.nodeIdOfEvent(event);
      // ★ 拉角也一样：`pointerdown` 早于失焦提交 ⇒ 编辑器开着时也要能拉（用只读闸门）
      if (nodeId && this.mindWritable) {
        event.preventDefault();
        event.stopPropagation();
        this.beginImageResize(nodeId, event);
        return;
      }
    }

    // ★ 连接处的折叠手柄（`06 §11.14`）：点它只折叠 / 展开，**不动选区** ——
    //   用户是在"整理画面"，不是"选中这一支"。`preventDefault` 顺手挡掉焦点转移，
    //   这样键盘还留在画布上（`Tab` / `Enter` 全在那边）。
    const handleId = this.handleIdOfEvent(event);
    if (handleId !== null) {
      event.preventDefault();
      this.toggleCollapseOf(handleId);
      return;
    }

    const id = this.nodeIdOfEvent(event);

    if (id === null) {
      // ★ 没点中节点：先问"是不是点在一条**关联线**上"（`N1-c`）——
      //   线画在节点**下面**，所以能走到这一句就说明没有节点挡着它。
      //   点中了 ⇒ 选中那条线（节点选区随之清空），这一下**不落框选**。
      const linkId = this.linkAt(event);
      if (linkId !== null) {
        event.preventDefault();
        this.selectLink(linkId);
        return;
      }

      // 空白处按下 = **框选**的准备动作（`06 §4.2`）。
      // ★ 这里**先不清选区**：只有"按下去又原样松开"（没拖动过）才算"点空白 → 清空" ——
      //   与白板同一条（框选途中改主意、随手松开，不该把选区弄丢）
      const start = this.canvasPointOf(event);
      this.marquee = {
        pointerId: event.pointerId,
        start,
        current: start,
        base: new Set(this.selectedIds),
        additive: event.shiftKey,
      };
      this.capturePointer(event.pointerId);
      return;
    }

    // `⇧`+点击 = 补选 / 取消补选（P3-c）
    if (event.shiftKey) {
      this.toggleInSelection(id);
    } else if (!this.selectedIds.has(id) || this.selectedIds.size === 1) {
      // ★ 点在**已经在多选里的**节点上时**不清选区**：那是"我要拖这一簇"的准备动作
      //   （各家编辑器的通行手感）。点别的节点才收成单选。
      this.selectNode(id);
    } else {
      this.selectedId = id;
    }

    // ★ 同上：`pointerdown` 比失焦提交早 ⇒ 编辑器开着时"点另一个节点继续拖"也要能用
    if (!this.mindWritable) return;
    this.pendingDrag = {
      nodeId: id,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
    };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    // ★ 弯折手柄最优先（`N1-d`）：拖动中它是**最近**开始的那个手势（与 `Esc` 那条同一条口径）
    const bendDrag = this.linkBendDrag;
    if (bendDrag) {
      if (bendDrag.pointerId !== event.pointerId) return;
      this.updateLinkBendDrag(bendDrag, event);
      return;
    }

    // 连线态优先（`N1-b`）：它不涉及指针捕获，每一条 move 都算数
    if (this.linking) {
      this.updateLink(this.linking, event);
      return;
    }
    const marquee = this.marquee;
    if (marquee) {
      if (marquee.pointerId !== event.pointerId) return;
      marquee.current = this.canvasPointOf(event);
      this.updateMarquee(marquee);
      return;
    }

    const resize = this.imageResize;
    if (resize) {
      if (resize.pointerId !== event.pointerId) return;
      this.updateImageResize(resize, event);
      return;
    }

    const pending = this.pendingDrag;
    if (!this.drag) {
      if (!pending || pending.pointerId !== event.pointerId) return;
      const travelled = Math.hypot(
        event.clientX - pending.start.x,
        event.clientY - pending.start.y,
      );
      if (travelled < DRAG_THRESHOLD_PX) return;
      if (!this.beginDrag(pending, event)) {
        this.pendingDrag = null;
        return;
      }
    }
    const drag = this.drag;
    if (drag) this.updateDrag(drag, event);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.linkBendDrag?.pointerId === event.pointerId) {
      this.finishLinkBendDrag();
      return;
    }

    if (this.imageResize?.pointerId === event.pointerId) {
      this.finishImageResize();
      return;
    }

    if (this.pendingDrag?.pointerId === event.pointerId) this.pendingDrag = null;

    const marquee = this.marquee;
    if (marquee && marquee.pointerId === event.pointerId) {
      const moved =
        Math.abs(marquee.current.x - marquee.start.x) >= DRAG_THRESHOLD_PX ||
        Math.abs(marquee.current.y - marquee.start.y) >= DRAG_THRESHOLD_PX;
      const additive = marquee.additive;
      this.clearMarquee();
      // 没拖动 = "点了一下空白" → 清空选区（`⇧` 时不动：那是加选的手势）
      if (!moved && !additive) this.selectNode(null);
      return;
    }

    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.finishDrag();
  };

  // ── 框选（`06 §4.2`：左键在空白处拖出一个矩形） ──────────

  /**
   * 跟手更新：画框 + 实时改选区。
   *
   * ★ **实时改**而不是松手才算：用户拖的过程中就得看见"这一下会选中谁"，
   *   松手才发现多选了三个是最扫兴的一种交互（白板那边也是实时的）。
   * ★ 选谁按**世界坐标**算：屏幕上同样大小的一块，在不同缩放下对应的世界范围完全不同。
   */
  private updateMarquee(state: MarqueeState): void {
    const screenRect = rectFromPoints(state.start, state.current);
    this.paintMarquee(screenRect);

    const boxes = this.layout?.boxes;
    if (!boxes) return;
    const worldRect = rectFromPoints(
      this.viewport.toWorld(state.start),
      this.viewport.toWorld(state.current),
    );
    const hit = boxesWithin(boxes, worldRect);
    const next = state.additive ? new Set([...state.base, ...hit]) : new Set(hit);

    // 每帧都调：真的变了才同步 DOM（挂着的节点不多，但没必要白刷一趟）
    if (sameSet(next, this.selectedIds)) return;
    this.selectedIds = next;
    if (!this.selectedId || !next.has(this.selectedId)) this.selectedId = hit[0] ?? null;
    this.syncSelection();
  }

  private paintMarquee(rect: Rect): void {
    const el = this.marqueeEl;
    if (!el) return;
    el.setCssStyles({ display: 'block' });
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }

  /** 收掉框（松手 / `Esc` 都走它；是否还原选区由调用方决定） */
  private clearMarquee(): void {
    const marquee = this.marquee;
    this.marquee = null;
    if (this.marqueeEl) this.marqueeEl.setCssStyles({ display: 'none' });
    if (marquee) this.releasePointer(marquee.pointerId);
  }

  /** `Esc`：放弃这次框选，选区回到按下之前 */
  private cancelMarquee(): void {
    const marquee = this.marquee;
    if (!marquee) return;
    const base = marquee.base;
    this.clearMarquee();
    this.selectedIds = new Set(base);
    if (!this.selectedId || !base.has(this.selectedId)) {
      this.selectedId = [...base][0] ?? this.mind?.rootId ?? null;
    }
    this.syncSelection();
  }

  private readonly onCanvasDoubleClick = (event: MouseEvent): void => {
    // 浮层上的双击（连点两下"加粗"）不是"双击节点"：让开，别顺手推进改标题态
    if (this.isOverlayTarget(event)) return;
    // 回形针上的双击：那一下已经在 `pointerdown` 里当"打开文件"处理过了，
    // 这里必须让开 —— 否则会顺手把节点推进改标题态（文件开了、节点也在编辑，两件事一起发生）
    if (this.attrOfEvent(event, MIND_REF_ATTR) !== null) return;
    if (this.attrOfEvent(event, MIND_IMAGE_RESIZE_ATTR) !== null) return;

    const id = this.nodeIdOfEvent(event);
    if (!id) {
      // ★ 双击**线身** = 改这条线的标签（`N1-c`）—— 与"双击节点改标题"同一套手感
      const linkId = this.linkAt(event);
      if (linkId !== null) {
        event.preventDefault();
        this.selectLink(linkId);
        this.beginLinkLabelEdit(linkId);
      }
      return;
    }

    // ★ 图片附件：**双击图片就是打开那个文件**（`06 §4.1`）—— 图片这一层没有回形针，
    //   而单击要留给"选中这个节点"（单击就打开的话，图片节点永远选不中）
    if (this.isImageTarget(event)) {
      const ref = this.refOf(id);
      if (ref) {
        event.preventDefault();
        void this.openRef(ref.path);
        return;
      }
    }

    this.beginTitleEdit(id);
  };

  /** 事件目标是图片块里的东西吗（含那张 `<img>` 与四个角） */
  private isImageTarget(event: Event): boolean {
    const target = event.target;
    return target instanceof Element && target.closest(`.${MIND_IMAGE_CLASS}`) !== null;
  }

  /**
   * 事件目标往上找带某个属性的元素。
   *
   * ★ 判据是 **`Element` 而不是 `HTMLElement`**：回形针里那颗图标是 **SVG**
   *   （`<svg>` / `<path>`），而 SVG 元素**不是** `HTMLElement` —— 用后者判会把
   *   "点在回形针上"整个认成"点在空白处"，症状就是**悬停有文件名、点下去没反应**
   *   （真实报障，见 §11.22）。`closest` 在 `Element` 上就有，不必绕。
   */
  /**
   * 事件落在两条浮层（或其弹层）里吗。
   *
   * ★ 判据是 **`Element`** 而不是 `HTMLElement`（回形针那颗 SVG 曾经吃过这个亏，`§11.22`）。
   * ★ 用 `closest` 而不是 `contains`：浮层的弹层有时会挂在自己里面（色块、emoji），
   *   一层 `contains` 足以覆盖；但用 `closest` 还能顺手挡掉"浮层内部更深一层"的元素。
   */
  private isOverlayTarget(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    return (
      target.closest('.nestboard-mind-toolbar') !== null ||
      target.closest('.nestboard-mind-controls') !== null
    );
  }

  private attrOfEvent(event: Event, attr: string): string | null {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const holder = target.closest(`[${attr}]`);
    return holder instanceof Element ? holder.getAttribute(attr) : null;
  }

  // ── 图片拖角（`06 §4.1`：四个角等比缩放）────────────────────

  /**
   * 拉角开始。
   *
   * ★ **等比**（只存宽度、高度随原图长宽比）：图片被拉扁是最常见的"手一抖就毁了"，
   *   而"只存一个数"让落盘与校验都少一半事情。
   * ★ 基准是**到图片中心的距离**：四个角于是行为完全一致（不必为每个角推一遍符号），
   *   而节点在布局里本来就居中 —— 缩放在观感上就是"以中心为基准长大/缩小"。
   */
  private beginImageResize(nodeId: string, event: PointerEvent): void {
    const box = this.layout?.boxes.get(nodeId);
    const ref = this.refOf(nodeId);
    if (!box || !ref || ref.kind !== 'image') return;

    const center = rectCenter(box);
    const world = this.worldPointOf(event);
    const startWidth = ref.width ?? MIND_IMAGE_DEFAULT_WIDTH;
    this.imageResize = {
      nodeId,
      pointerId: event.pointerId,
      center,
      startWidth,
      startDistance: Math.max(1, Math.hypot(world.x - center.x, world.y - center.y)),
      width: startWidth,
    };
    this.canvasEl?.classList.add('is-resizing');
    this.capturePointer(event.pointerId);
  }

  /** 拉角中：改**预览**（一个 CSS 变量 + 一次合并后的重排），模型一动不动 */
  private updateImageResize(resize: ImageResizeState, event: PointerEvent): void {
    const world = this.worldPointOf(event);
    const distance = Math.hypot(world.x - resize.center.x, world.y - resize.center.y);
    const width = clamp(
      Math.round(resize.startWidth * (distance / resize.startDistance)),
      MIND_IMAGE_MIN_WIDTH,
      MIND_IMAGE_MAX_WIDTH,
    );
    if (width === resize.width) return;
    resize.width = width;
    this.applyImageWidth(resize.nodeId, width);
    this.scheduleRelayout();
  }

  /** 松手：把宽度写进模型（**一次拖动 = 一步撤销**） */
  private finishImageResize(): void {
    const resize = this.imageResize;
    if (!resize) return;
    this.imageResize = null;
    this.canvasEl?.classList.remove('is-resizing');
    this.releasePointer(resize.pointerId);
    this.cancelRelayoutFrame();

    this.edit(t('history.mindImageResize'), (mind) =>
      setRefWidth(mind, resize.nodeId, resize.width),
    );
    // ★ 写完之后**按模型再对一遍**：宽度可能被夹过、也可能这次改动静默失败（值没变），
    //   不对一遍的话卡上会留着拖动时的那个预览值，与文件里存的对不上。
    const settled = this.refOf(resize.nodeId)?.width;
    this.applyImageWidth(resize.nodeId, settled ?? MIND_IMAGE_DEFAULT_WIDTH);
    this.relayout();
  }

  /** 放弃这次拉角（`Esc` / 关视图 / 换文件）：模型一个字节都不动 */
  private cancelImageResize(): void {
    const resize = this.imageResize;
    if (!resize) return;
    this.imageResize = null;
    this.canvasEl?.classList.remove('is-resizing');
    this.releasePointer(resize.pointerId);
    this.cancelRelayoutFrame();
    const settled = this.refOf(resize.nodeId)?.width;
    this.applyImageWidth(resize.nodeId, settled ?? MIND_IMAGE_DEFAULT_WIDTH);
    this.relayout();
  }

  /** 把图片宽度写进节点元素上的 CSS 变量（样式表按它给 `<img>` 定宽） */
  private applyImageWidth(nodeId: string, width: number): void {
    this.mounted.get(nodeId)?.style.setProperty('--nestboard-mind-image-width', `${width}px`);
  }

  /**
   * 撤掉还没执行的那一帧重排（关视图 / 换文件 / 拉角收尾时用）。
   *
   * ★ 排队的帧是"打字时只重排"那条路共用的（`scheduleRelayout`）：留着一个悬空的
   *   帧任务，它会在视图已经拆掉之后回调进来。
   */
  private cancelRelayoutFrame(): void {
    if (this.relayoutFrame === null) return;
    window.cancelAnimationFrame(this.relayoutFrame);
    this.relayoutFrame = null;
  }

  // ── 引用（`B`：拖文件到节点上 / 回形针打开）──────────────────

  /**
   * 拖到画布上：`dragover` 只做反馈，`drop` 才真的挂上去。
   *
   * ★ `dragover` 里**必须** `preventDefault()`：浏览器规定"不 preventDefault 就不许 drop"，
   *   而且不挡的话拖进来的文件会被浏览器**打开**（整页跳到一个图片上）。
   *   于是这里对**整个画布**都挡（哪怕指针不在节点上），只是"圈住目标"仅在节点上出现 ——
   *   那种时刻松手什么都不会发生，正是期望行为。
   * ★ 反馈直接复用**拖拽辅助线**那圈环：语义一样（"松手会挂到它下面"），
   *   用户不必再学一套新的视觉语言。
   */
  private readonly onCanvasDragOver = (event: DragEvent): void => {
    event.preventDefault();
    // ★ 也要挡住冒泡：工作区自己也在听拖放，不拦就会"附件挂上了，
    //   同时那个文件还在新标签页里被打开了一次"（白板 `F6-06` 的验收点，同一条）
    event.stopPropagation();
    // `copy` 而不是跟随 `effectAllowed`：源是文件浏览器，`move` 万一被当成
    // "这个文件被移走了"就麻烦了；而 `copy` 在两种拖拽下都讲得通
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    // ★ 拖放不走焦点 ⇒ 编辑器开着时拖文件进来也必须能亮起落点（只读闸门）
    if (!this.mindWritable) return;

    const id = this.nodeIdOfEvent(event);
    const ring = id ? (this.layout?.boxes.get(id) ?? null) : null;
    this.guideLayer?.set(this.guidesOn && ring ? { ring } : null);
  };

  private readonly onCanvasDragLeave = (): void => {
    this.guideLayer?.set(null);
  };

  private readonly onCanvasDrop = (event: DragEvent): void => {
    // 先挡住浏览器的默认行为（打开那个文件），再决定自己要不要接
    event.preventDefault();
    event.stopPropagation();
    this.guideLayer?.set(null);

    const id = this.nodeIdOfEvent(event);
    // ★ 同 `onCanvasDragOver`：拖放不经过焦点，编辑器开着也要能接
    if (!id || !this.mindWritable) return;
    void this.collectDroppedPaths(event.dataTransfer).then((paths) => {
      if (paths.length > 0) this.attachTo(id, paths);
    });
  };

  /**
   * 拖进来的东西 → **库内路径**列表（三种来源，按可靠性排）。
   *
   * ① 文本里的库内路径（Obsidian 内部拖拽 / 复制笔记链接走的都是这条）：库里已经有了，
   *   不该再复制一份 —— 这也是白板 `DragDropBridge` 的第一条判据。
   * ② 系统文件（`dataTransfer.files`）：先落库（走**插件级**的附件导入，
   *   附件目录、命名、去重都跟着用户在 Obsidian 里的设置走），才有库内路径可挂。
   * ③ 只给了 `file://` 绝对路径（macOS Finder 常见）：按路径读盘落库。
   *
   * ★ 刻意**不 import 白板的 `model/drop.ts`**（eslint 的边界）：它的产物是"白板卡片"，
   *   与"脑图引用"不是一回事；共用的那部分（附件导入）本来就在插件级。
   */
  private async collectDroppedPaths(transfer: DataTransfer | null): Promise<string[]> {
    if (!transfer) return [];

    // ★ 读**所有**能当字符串读的类型，而不是只读 `text/plain`：内部拖文件时用的类型
    //   没有文档保证（`text/plain` 之外还可能有 Obsidian 自己的私有类型），
    //   只认一种的后果与上面那条一样 —— 什么都收不到、一声不响。
    const texts: string[] = [];
    for (const type of Array.from(transfer.types ?? [])) {
      if (type === 'Files') continue; // 不是字符串，读它会抛
      try {
        const data = transfer.getData(type);
        if (data.length > 0) texts.push(data);
      } catch {
        // 某些类型在某些平台上读不出来：跳过，别让一个类型拖垮整次拖入
      }
    }
    const known = new Set(texts.flatMap((text) => this.vaultPathsOf(text)));
    if (known.size > 0) return [...known];

    const files = [...(transfer.files ?? [])];
    if (files.length > 0) {
      new Notice(t('notice.importing', { count: String(files.length) }));
      const imported: string[] = [];
      const failed: string[] = [];
      for (const file of files) {
        const path = await this.plugin.importDroppedFile(file);
        if (path) imported.push(path);
        else failed.push(file.name);
      }
      if (failed.length > 0) {
        new Notice(t('notice.attachmentFailed', { error: failed.join('、') }));
      }
      return imported;
    }

    // ③ 只有 `file://` 绝对路径的兜底
    const uri = transfer.getData('text/uri-list');
    if (uri.startsWith('file://')) {
      const path = await this.plugin.importDroppedUri(decodeURIComponent(uri.slice(7)));
      return path ? [path] : [];
    }
    return [];
  }

  /**
   * 一段拖拽文本 → 库内路径（能认出来的那些）。
   *
   * ★ 走 Obsidian 自己的链接解析器兜底短名：拖文件浏览器 / 笔记链接时 `text/plain`
   *   常常只有文件名（`子板.md`），直接精确匹配会失败 —— 存进节点里的必须是
   *   **能打开、能失效跟踪**的完整路径。
   * ★ 认不出来的（外链、已删除的文件、别的软件给的无意义字符串）静默丢掉：
   *   往节点上拖一份网页链接什么都不发生，正是期望行为（不抓外部内容，`03 §7.5`）。
   */
  private vaultPathsOf(text: string): string[] {
    const paths: string[] = [];
    // ★ 解析交给 `model/drop.ts` 的 `parseDropPaths`（白板那条**已经跑通**的路上用的同一个）：
    //   Obsidian 文件浏览器拖出来的文本是 **`obsidian://open?file=…`**（不是裸路径！），
    //   另外还会遇到 `![[…]]` / `[[Note#标题|别名]]` / `[标题](a%20b.md)` 这几种形态。
    //   自己写一份"只按行当路径"的解析，症状就是**环圈住了、松手却没反应**（真实报障）。
    //   ★ 它是**纯函数**（不 import obsidian、不碰 DOM），mind 复用不越界。
    for (const candidate of parseDropPaths(text)) {
      const path = this.resolveVaultPath(candidate);
      if (path) paths.push(path);
    }
    return paths;
  }

  private resolveVaultPath(raw: string): string | null {
    const direct = this.app.vault.getAbstractFileByPath(raw);
    if (direct) return direct.path;
    const resolved = this.app.metadataCache.getFirstLinkpathDest(raw, this.file?.path ?? '');
    return resolved?.path ?? null;
  }

  /**
   * 把拖进来的东西挂到某个节点上。
   *
   * ★ **一个节点一个附件**（`06 §4.1`）：已经有附件时是**替换**，不是并列第二条。
   *   多个文件一起拖进来时取第一个，被舍掉几条**单独提示一句** ——
   *   悄悄丢掉两个文件、用户还以为三张图都挂上了，那才是真糟糕。
   * ★ 拖的是已经挂着的那一个（或一条可用路径都没有）⇒ 什么都不做：
   *   不写盘、不进撤销栈、不提示。
   */
  private attachTo(nodeId: string, paths: readonly string[]): void {
    const mind = this.mind;
    const node = mind ? nodeById(mind, nodeId) : null;
    if (!node) return;

    const existing = firstRefOf(node);
    const { ref, extras } = pickRef(paths);
    if (!ref || sameRef(existing, ref)) return;

    this.edit(t('history.mindAttach'), (current) => setRefs(current, nodeId, [ref]));
    const name = refLabelOf(ref.path);
    new Notice(existing ? t('notice.mindReplaced', { name }) : t('notice.mindAttached', { name }));
    if (extras > 0) new Notice(t('notice.mindAttachOne'));
  }

  /**
   * 定位到某个节点（反链面板 / 图谱点一条命中时调它，`06 §7.2` 第 3 条）。
   *
   * ★ 与 `BoardView.revealCardById` 同一条做法：调用方**只保证视图被 open 过**
   *   （`openMindView` 返回时文件可能还没加载完），所以认不出节点时先记下来，
   *   等内容到位（`onLoadFile`）再补 —— 否则"点了一条反链，视图开了但没定位"
   *   会是个只在冷启动时复现的问题。
   * ★ 节点被**折叠**藏起来时只选中、并在界面上说一句：展开是改文件（要写盘），
   *   一次"跳过去看看"不该顺手动用户的折叠状态。
   */
  revealNodeById(nodeId: string): void {
    const mind = this.mind;
    if (!mind || !nodeById(mind, nodeId)) {
      this.pendingReveal = nodeId;
      return;
    }
    this.applyReveal(nodeId);
  }

  private applyReveal(nodeId: string): void {
    const mind = this.mind;
    if (!mind || !nodeById(mind, nodeId)) return;
    this.pendingReveal = null;
    this.selectNode(nodeId);

    const box = this.layout?.boxes.get(nodeId);
    if (!box) {
      // 排不进布局 = 它在某个折叠起来的子树里
      new Notice(t('notice.mindHiddenNode'));
      return;
    }
    this.viewport.centerOn(rectCenter(box));
    this.applyCamera();
  }

  // ── 导出（`06 §7.3`）──────────────────────────────────────

  /**
   * 导出成 Markdown / SVG / PNG / FreeMind（`.mm`），落在**脑图旁边**。
   *
   * ★ 几何取**当前这份布局**（`this.layout`）—— 那是屏幕上正在用的那一份，
   *   所以导出结果与画布长得一样；视图没排过版时（罕见）现排一次兜底。
   * ★ 名字**顺延**（`名字 2.svg`）而不是覆盖：覆盖是不可逆的，而顺延只是多一个文件。
   * ★ 失败只提示、不抛：一次导出失败不该把视图带进异常态。
   */
  async exportAs(kind: MindExportKind): Promise<void> {
    const mind = this.mind;
    const path = this.file?.path;
    if (!mind || !path) return;

    const layout = this.layout ?? layoutMind(mind, this.layoutOptions());
    const { base } = splitName(path);
    const folder = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/` : '';

    try {
      if (kind === 'markdown') {
        await this.writeExport(`${base}.md`, mindToMarkdown(mind), folder);
        return;
      }
      // 大纲式 Markdown（用户 2026-09-17）：与上面那份**并存** —— 两种口味各有用处
      //（一份保住"图的样子"，一份就是大纲那句话本身）。名字顺延不会覆盖
      if (kind === 'outlineMarkdown') {
        await this.writeExport(`${base}.md`, mindToOutlineMarkdown(mind), folder);
        return;
      }
      if (kind === 'xmind') {
        // `.xmind` 本质是个 zip：**内容**由纯函数给（`mindToXmindEntries`），
        // 打包用与白板导出 ZIP 同一个编码器（store 不压缩，XMind 那边的标准 zip 读取器认）
        const entries = mindToXmindEntries(mind, {
          creator: { name: 'Nestboard', version: this.plugin.manifest.version },
        }).map((entry) => ({ path: entry.path, data: textToArrayBuffer(entry.content) }));
        await this.writeExport(`${base}.xmind`, buildZip(entries, new Date()), folder);
        return;
      }
      if (kind === 'freemind') {
        // ★ 左右分布取自**当前布局**的 `side`：打开 `.mm` 看到的左右与画布上一致，
        //   而不是"按次序交替"那种猜出来的摆法（`06 §11.51` 的映射表）
        await this.writeExport(
          `${base}.mm`,
          mindToFreeMind(mind, {
            positionOf: (id) => {
              const box = layout.boxes.get(id);
              if (!box) return null;
              return box.side === -1 ? 'left' : 'right';
            },
          }),
          folder,
        );
        return;
      }
      const svg = mindToSvg(mind, layout);
      if (kind === 'svg') {
        await this.writeExport(`${base}.svg`, svg, folder);
        return;
      }
      await this.writeExport(`${base}.png`, await svgToPngBytes(svg, MIND_PNG_SCALE), folder);
    } catch (error) {
      console.warn('[nestboard] 脑图导出失败', describeError(error));
      new Notice(t('notice.mindExportFailed', { error: describeError(error) }));
    }
  }

  /** 真的写盘（顺延取名 + 文本走 `create` / 二进制走 `createBinary`） */
  private async writeExport(
    name: string,
    data: string | ArrayBuffer,
    folder: string,
  ): Promise<void> {
    const sink = {
      exists: (path: string): Promise<boolean> =>
        Promise.resolve(this.app.vault.getAbstractFileByPath(path) !== null),
    };
    const target = await uniqueExportPath(sink, folder, name);
    if (typeof data === 'string') await this.app.vault.create(target, data);
    else await this.app.vault.createBinary(target, data);
    new Notice(t('notice.mindExported', { path: target }));
  }

  /** 某个节点当前那一条附件 */
  private refOf(nodeId: string): MindRef | null {
    const mind = this.mind;
    const node = mind ? nodeById(mind, nodeId) : null;
    return node ? firstRefOf(node) : null;
  }

  /**
   * 库内路径 → 能直接放进 `<img src>` 的地址。
   *
   * ★ 只有宿主知道这件事（`vault.adapter.getResourcePath`），所以渲染层拿的是注入进来的函数。
   * ★ **先确认文件还在**：文件被删 / 改名之后 `getResourcePath` 仍会拼出一个地址，
   *   而那会渲染成一张破图（标题上那个回形针反而更诚实：它点得开、也说得清"文件不在了"）。
   */
  /**
   * 这条附件的文件**还在不在**（`06 §6` 的断链态：回形针变灰 + 说清原因）。
   *
   * ★ 与 `resourcePathOf` 分开：那个回答"能不能画成图"（一条 PDF 永远画不成图），
   *   这个回答"这份文件还在不在"—— 后者才决定回形针灰不灰。
   * ★ 改名 / 移动**不算断链**：`RenameWatcher` 会把引用路径跟着改掉（见那一处接线），
   *   这里管的是"被删掉 / 被移到库外"那一类（库外的东西没有路径可跟随）。
   */
  private readonly refMissing = (path: string): boolean =>
    !(this.app.vault.getAbstractFileByPath(path) instanceof TFile);

  /**
   * 某个路径的"在不在"变了（`vault.on('delete' / 'rename')`）⇒ 该重画就重画一次。
   *
   * ★ **只在引用过它时**才 `render()`：库里删掉一个与这份脑图无关的文件时，重画一次
   *   意味着重新量一遍尺寸、重排整棵树 —— 那是白白的开销。
   * ★ 判据就是**路径字符串**：节点上的引用只存路径（`model/refs.ts` 那条"不存标题"），
   *   所以"引用过没有"不必去问 Vault。改名那一档要**旧新两条都问**：
   *   引用此刻还指着旧路径（`RenameWatcher` 随后才把它改成新路径）。
   */
  private refreshRefState(path: string): void {
    const referenced = (this.mind?.nodes ?? []).some((node) =>
      (node.refs ?? []).some((ref) => ref.path === path),
    );
    if (referenced) this.render();
  }

  private readonly resourcePathOf = (path: string): string | null => {
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) return null;
    try {
      return this.app.vault.adapter.getResourcePath(path);
    } catch (error) {
      console.warn('[nestboard] 图片地址解析失败', describeError(error));
      return null;
    }
  };

  /**
   * 右键：**节点菜单**（`08 §2`）。
   *
   * ★ 右键的语义是"对**谁**操作"：目标不在选区里时先把它选成单选 ——
   *   否则菜单里的"删除附件""原地复制"到底作用于谁，用户只能猜。
   * ★ **不出现"点了没反应的项"**：不能做的**置灰**、不做的不出现
   *   （「编辑属性」要等 P5 的属性面板，所以现在压根不放它）。
   * ★ 多选时只有单个节点才说得通的项（编辑内容 / 附件 / 原地复制 / 加节点）置灰，
   *   整簇说得通的（剪切 / 拷贝 / 删除 / 折叠）作用于**整簇**（`08 §2` 的规矩）。
   */
  private readonly onCanvasContextMenu = (event: MouseEvent): void => {
    // 连线态里的右键 = 放弃（这一次右键的语义就是"算了"，不再弹节点菜单）
    if (this.linking) {
      event.preventDefault();
      this.cancelLink();
      return;
    }
    const nodeId = this.nodeIdOfEvent(event);
    const mind = this.mind;
    if (!mind) return;
    if (!nodeId) {
      // ★ 没点中节点：可能是右键在一条**关联线**上（`N1-c`）——
      //   那条菜单只有几项（改标签 / 箭头 / 删除），与节点菜单不是一回事
      const linkId = this.linkAt(event);
      if (linkId !== null) {
        event.preventDefault();
        this.selectLink(linkId);
        this.showLinkMenu(event, linkId);
        return;
      }

      // ★ 空白处的右键 = **画布菜单**（用户 2026-09-17 参考飞书思维笔记补的：
      //   飞书把"折叠所有节点"与"定位到中心节点"都放在空白右键里）。
      //   这两件事的宾语本来就是"整张图"，不是某一张卡
      this.showCanvasMenu(event);
      return;
    }

    event.preventDefault();
    this.canvasEl?.focus();
    if (!this.selectedIds.has(nodeId)) this.selectNode(nodeId);

    const single = this.selectedIds.size === 1;
    const node = nodeById(mind, nodeId);
    const ref = single ? this.refOf(nodeId) : null;
    const isRoot = nodeId === mind.rootId;
    const mayCollapse = single && hasChildren(mind, nodeId);
    // ★ 右键**不移动焦点** ⇒ 编辑器可能还开着；菜单项的启用态要看"文件能不能写"，
    //   而不是"此刻有没有在改字"（点菜单项之前那一下失焦会先提交）
    const writable = this.mindWritable;
    // 悬浮节点不在树上 ⇒ "插在同一个父下"对它没有意义（`clipboard.duplicateNodes` 也跳过它）
    const mayDuplicate =
      single && !isRoot && node?.parentId !== null && node?.parentId !== undefined;
    const clipboard = getMindClipboard();

    const menu = new Menu();

    // 聚焦（`D1`，用户 2026-09-18："树视图也支持进入当前主题"）：
    // 与 `⌘]` / `⌘[` 是同一件事，菜单里再给一遍 —— 那两键在部分键盘布局上并不好按。
    // ★ 排在最前：它管的是"我现在看哪一支"，与下面那些"改这一支"的动作不是一类。
    // ★ 根节点没有"进入"这一说（它已经是当前的根）；没在聚焦时也没有"返回上一层"。
    const focusId = mind.view.focus ?? null;
    const canFocusIn = single && !isRoot;
    if (canFocusIn || focusId !== null) {
      if (canFocusIn) {
        menu.addItem((item) =>
          item
            .setTitle(t('menu.mindFocusIn'))
            .setIcon('crosshair')
            .onClick(() => this.setFocus(nodeId)),
        );
      }
      if (focusId !== null) {
        menu.addItem((item) =>
          item
            .setTitle(t('menu.mindFocusOut'))
            .setIcon('undo-2')
            .onClick(() => this.focusOutLevel()),
        );
      }
      menu.addSeparator();
    }

    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindCut'))
        .setIcon('scissors')
        .setDisabled(!writable || (single && isRoot))
        .onClick(() => this.cutSelection()),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindCopy'))
        .setIcon('copy')
        .onClick(() => this.copySelection()),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindDuplicate'))
        .setIcon('copy-plus')
        .setDisabled(!writable || !mayDuplicate)
        .onClick(() => this.duplicateSelection()),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindPaste'))
        .setIcon('clipboard-paste')
        .setDisabled(!writable || clipboard === null)
        .onClick(() => this.pasteClipboard()),
    );

    menu.addSeparator();
    // 完成 / 取消完成（`N3-g`）：只对**单个**节点有意义（多选时"完成谁"没有唯一答案）
    menu.addItem((item) =>
      item
        .setTitle(t(node?.done === true ? 'menu.mindUndone' : 'menu.mindDone'))
        .setIcon(node?.done === true ? 'undo-2' : 'check')
        .setDisabled(!writable || !single)
        .onClick(() => {
          if (nodeId) this.toggleDone(nodeId);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindEditNote'))
        .setIcon('pencil')
        .setDisabled(!writable || !single)
        .onClick(() => this.beginNoteEdit(nodeId)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindDelete'))
        .setIcon('trash')
        .setDisabled(!writable || (single && isRoot))
        .onClick(() => this.deleteSelection()),
    );
    menu.addItem((item) =>
      item
        .setTitle(node?.collapsed === true ? t('menu.mindExpand') : t('menu.mindCollapse'))
        .setIcon('chevrons-down-up')
        .setDisabled(!writable || !mayCollapse)
        .onClick(() => this.toggleSelectionCollapse()),
    );

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindOpenAttachment'))
        .setIcon('file-symlink')
        .setDisabled(ref === null)
        .onClick(() => {
          if (ref) void this.openRef(ref.path);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindRemoveAttachment'))
        .setIcon('trash-2')
        .setDisabled(ref === null || !writable)
        .onClick(() => {
          if (ref) this.detachRef(nodeId, ref.path);
        }),
    );

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindAddChild'))
        .setIcon('plus')
        .setDisabled(!writable || !single)
        .onClick(() => this.addChildToSelection()),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindAddSibling'))
        .setIcon('plus-square')
        .setDisabled(!writable || !single || isRoot)
        .onClick(() => this.addSiblingToSelection()),
    );

    menu.showAtMouseEvent(event);
  };

  /** 摘掉一条附件（走 `edit()`：可 `⌘Z` 退回） */
  private detachRef(nodeId: string, path: string): void {
    this.edit(t('history.mindDetach'), (mind) => removeRef(mind, nodeId, path));
  }

  /** 点回形针 / 菜单里"打开附件"：打开那个文件；引用失效（被删 / 改名）时明确说一句 */
  private async openRef(path: string): Promise<void> {
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
      new Notice(t('notice.mindRefMissing', { path }));
      return;
    }
    // ★ **开在新页**（第三个参数 `newLeaf`）：用户的意图是"看看这是什么"，
    //   不该把脑图标签顶掉（白板 `ui/attachmentActions.ts` 同一条，原话照抄）
    await this.app.workspace.openLinkText(path, this.file?.path ?? '', true);
  }

  /**
   * 脑图自己的**组合键**：`⌘C` / `⌘X` / `⌘V` / `⌘A` / `⌘⏎` / `⌘Z` / `⌘⇧Z`
   * —— 全部挂在 **window 的捕获阶段**。
   *
   * ★ 为什么不在画布上接（上一版就是这么写的，实测"依然无效"）：那要求**焦点正好在画布上**。
   *   点了节点再按键当然没问题，但"打开视图就直接按"（焦点还在标签头 / 侧栏）时，
   *   事件根本走不到画布 —— 表现就是一声不响地什么都不做。
   * ★ 为什么是 `capture`：Obsidian 的全局热键、核心复制粘贴、核心撤销都压在 `document` 上，
   *   而捕获阶段是 window → document → … → target。挂在 window 捕获阶段是**最早**
   *   能拿到事件的位置；拿到就 `stopPropagation`，一次按键只会有一个人处理。
   * ★ **撤销（`⌘Z`）也必须走这里**：它原先挂在命令的默认热键上，实测"按了没反应" ——
   *   与 `⌘C` 当初的毛病一模一样（命令热键与 Obsidian 的核心键抢，谁赢不确定）。
   *   命令仍然登记着（命令面板里点得到），只是不再声明默认键。
   * ★ 门槛必须硬，否则会抢别人的键：
   *   ① 只有这几个组合键；② 正在改标题 / 改内容 / 焦点在输入框里时**一律放行**
   *   （那些键属于输入框 —— 包括它自己的撤销）；
   *   ③ **本视图必须是当前活动的那个 leaf**（分屏另一半在看别的文档时不许抢）。
   */
  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (!event.metaKey && !event.ctrlKey) return;

    // ★ **聚焦两键**（`N3-e`：`⌘]` 进入当前主题 / `⌘[` 返回上一级）也走这一道 ——
    //   理由与剪贴板三键一模一样：**Obsidian 自己也压着 `⌘[` / `⌘]`**（标签页前进 / 后退），
    //   挂在画布 / 面板上的监听器那时可能根本收不到 ⇒ 表现就是"按了没反应"。
    //   ★ 这一句排在 `isEditableTarget` **之前**，但只在"焦点不在输入框里"时生效 ——
    //     正在改某一行时让给编辑器自己那个监听器（见 `beginOutlineTitleEdit`），
    //     两边合起来是"编辑器开着也能按"。两者都 `stopPropagation` ⇒ 一次按键只处理一次。
    if (
      !event.altKey &&
      !event.shiftKey &&
      (event.key === ']' || event.key === '[') &&
      this.mind !== null &&
      this.app.workspace.getActiveViewOfType(View) === this &&
      !this.isEditableTarget(event.target)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const id = this.selectedId;
      if (event.key === ']') {
        // 画布上按它也认：切进大纲并聚焦（幕布在导图视图里就是这个键）
        if (id === null) return;
        if (!this.outlineMode) this.toggleOutline();
        this.setFocus(id);
      } else if (this.outlineMode) {
        // `⌘[` 只在大纲里做事：画布上"退出去"没有看得见的结果
        this.focusOutLevel();
      }
      return;
    }

    const key = event.key.toLowerCase();
    if (!OWN_KEYS.has(key)) return;
    if (!this.mind) return;
    if (this.isEditableTarget(event.target)) return;
    if (this.app.workspace.getActiveViewOfType(View) !== this) return;

    // ★★ 选中的是**文字**（大纲里用鼠标划过一段）⇒ 复制 / 剪切**让给浏览器**：
    //   用户要的是"把这段字复制走"，而不是"把这一行当节点复制走"
    //   （用户 2026-09-17："大纲视图不支持文字的复制黏贴，需要支持一下"）。
    //   ★ 判据只在**有非折叠的文字选区、且选区落在本视图里**时成立 ——
    //     别的视图（笔记 / 侧栏）里选中的字不该影响脑图的剪贴板键。
    if ((key === 'c' || key === 'x') && this.hasTextSelection()) return;

    event.preventDefault();
    event.stopPropagation();
    if (key === 'c') this.copySelection();
    else if (key === 'x') this.cutSelection();
    else if (key === 'v') this.pasteClipboard();
    // `⌘A` 也归这里：它同样与 Obsidian 的"全选"压在同一组键上（P3-c）
    else if (key === 'a') this.selectAllNodes();
    // `⌘Z` / `⌘⇧Z`：撤销 / 重做
    else if (key === 'z') {
      if (event.shiftKey) this.redo();
      else this.undo();
    }
    // 缩放三键：与左下角那排按钮**同一个函数**（`08 §5`）。
    // ★ `⌘+` 在多数键盘上要按 `⇧=`，`event.key` 于是是 `'+'` —— 两个都接
    // `⌘B` / `⌘I` / `⌘U`：选中节点的**整条标题**加粗 / 斜体 / 下划线（`08 §3.2`）。
    // ★ 焦点在输入框里时走不到这里（上面 `isEditableTarget` 已经让给编辑器自己的加粗）
    else if (key === 'b') this.toggleTitleFlag('bold');
    else if (key === 'i') this.toggleTitleFlag('italic');
    else if (key === 'u') this.toggleTitleFlag('underline');
    else if (key === '=' || key === '+') this.zoomStep(1);
    else if (key === '-') this.zoomStep(-1);
    else if (key === '0') this.zoomReset();
    else {
      // `⌘⏎`：打开选中节点的内容区（P4）。★ 编辑进行中时走不到这里 ——
      // 上面那句 `isEditableTarget` 已经让路给编辑器自己的 `⌘⏎`（= 提交并收起）
      const id = this.selectedId;
      if (id) this.beginNoteEdit(id);
    }
  };

  /** 事件目标是不是"正在输入"的地方（输入框里的复制粘贴归它自己） */
  private isEditableTarget(target: EventTarget | null): boolean {
    if (this.editing || this.noteEdit) return true;
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /**
   * 现在有没有**选中的文字**、而且选区落在本视图里（`⌘C` / `⌘X` 让路的判据）。
   *
   * ★ 大纲里的行是**普通文字**（不是输入框）：用户用鼠标划过一段字之后按 `⌘C`，
   *   期望是"复制这段字"。而 `onWindowKeyDown` 是挂在 window 捕获阶段的 ——
   *   不让路的话这一下会被我们自己吃掉，变成"复制整行节点"。
   * ★ 只认落在 `contentEl` 里的选区：别的视图里选中的文字与我们无关
   *   （分屏另一半在看笔记时，`⌘C` 该是它自己的事）。
   */
  private hasTextSelection(): boolean {
    const selection = this.contentEl.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    const node = selection.anchorNode;
    return node !== null && this.contentEl.contains(node);
  }

  /**
   * 把**系统剪贴板里的文字**贴成节点（`⌘V` 的"通用"那一档）。
   *
   * ★ 一行 = 一个节点，贴在**当前选中节点**下面（没选中就贴到中心主题下）——
   *   与"粘一支子树"同一套落点规则，用户不必学第二套。
   * ★ 空行丢掉（不然满屏空节点）；整段只有一行就只建一个节点。
   * ★ 读剪贴板是**异步**的，且可能没权限 / 剪贴板里不是文字 ⇒ 读不到就给一句明确提示，
   *   不能"按了没反应"。
   */
  private async pasteTextClipboard(): Promise<void> {
    const mind = this.mind;
    if (!mind) return;

    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = '';
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      new Notice(t('notice.mindPasteEmpty'));
      return;
    }

    const parentId = this.selectedId ?? mind.rootId;
    const created = this.edit(t('history.mindPaste'), (current) => {
      const ids: string[] = [];
      for (const line of lines) {
        const id = addChild(current, parentId);
        if (!id) break;
        setText(current, id, line);
        ids.push(id);
      }
      return ids;
    });
    if (!created || created.length === 0) return;
    // 粘出来的**一起选中**（与"粘一支子树"同一手感：接着就能拖走 / 再复制）
    this.selectedIds = new Set(created);
    this.selectedId = created[0] ?? null;
    this.syncSelection();
  }

  /** 同上：`Element` 而不是 `HTMLElement` —— 点在回形针的图标上时目标就是个 SVG 元素 */
  private nodeIdOfTarget(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const holder = target.closest(`[${MIND_NODE_ID_ATTR}]`);
    return holder instanceof Element ? holder.getAttribute(MIND_NODE_ID_ATTR) : null;
  }

  private nodeIdOfEvent(event: Event): string | null {
    return this.nodeIdOfTarget(event.target);
  }

  /**
   * 点的是哪个节点的**折叠手柄**（`null` = 没点在手柄上）。
   *
   * ★ 手柄**不带** `data-mind-node-id`（它带的是 `data-mind-handle`），于是
   *   "点节点"那条路（选中 / 拖动）与"点手柄"这条路在 DOM 上就是分开的 ——
   *   不必靠"先问手柄再问节点"的先后顺序去救。
   */
  private handleIdOfEvent(event: Event): string | null {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return null;
    const holder = target.closest(`[${MIND_HANDLE_ATTR}]`);
    return holder instanceof HTMLElement ? holder.getAttribute(MIND_HANDLE_ATTR) : null;
  }

  /**
   * 折叠 / 展开**某一个**节点（连接处那个圆圈点出来的）。
   *
   * ★ **不动选区**：用户是在"把这一支收起来"，不是"选中它" ——
   *   顺手改选区的话，点完手柄再按 `Enter` 会作用到刚被收起来的那一支上。
   * ★ 与 `Space` 分开（`toggleSelectionCollapse`）：那条作用在**整个选区**上，
   *   而手柄天生只认一个节点。
   */
  private toggleCollapseOf(id: string): void {
    const mind = this.mind;
    // ★ 用 `mindWritable`：三角 / 画布手柄都是 `tabindex="-1"` 的 `<span>`，
    //   点它们**不会让输入框失焦** ⇒ 编辑器可能还开着 ⇒ 用 `writable` 会让折叠静默失效
    if (!mind || !this.mindWritable) return;
    const collapsed = nodeById(mind, id)?.collapsed === true;
    this.edit(t('history.mindToggleCollapse'), (current) => setCollapsed(current, id, !collapsed));
  }

  /** 指针位置 → **画布坐标**（容器左上角为原点）—— 画框、判阈值都用它 */
  private canvasPointOf(event: { clientX: number; clientY: number }): Point {
    const rect = this.canvasEl?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  }

  /** 指针位置 → **世界坐标**（先减掉画布左上角，再经相机换算） */
  private worldPointOf(event: { clientX: number; clientY: number }): Point {
    return this.viewport.toWorld(this.canvasPointOf(event));
  }

  /** 捕获指针：拖出画布（甚至拖出窗口）也能收到 move / up，松手才抓得住 */
  private capturePointer(pointerId: number): void {
    try {
      this.canvasEl?.setPointerCapture(pointerId);
    } catch {
      // 指针已经消失（触屏被系统打断）：不影响后续交互，只是可能收不到 up
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      this.canvasEl?.releasePointerCapture(pointerId);
    } catch {
      // 没捕获过（或指针已经消失）时 release 会抛，忽略
    }
  }

  // ── 拖拽（P3-b） ────────────────────────────────────────

  /**
   * 真的开始拖了（指针已超过阈值）。
   *
   * @returns `false` = 这个节点没有 DOM / 不在布局里（例如拖的瞬间它被删了），这一拖不成立
   */
  private beginDrag(pending: PendingDrag, event: PointerEvent): boolean {
    const mind = this.mind;
    const box = this.layout?.boxes.get(pending.nodeId);
    const el = this.mounted.get(pending.nodeId);
    if (!mind || !box || !el) return false;

    // 这个节点在不在"多选的这一簇"里？在 —— 整个簇一起走（P3-c）
    const multi = this.selectedIds.size > 1 && this.selectedIds.has(pending.nodeId);
    const rootIds = multi ? selectionRoots(mind, this.selectedIds) : [pending.nodeId];
    const nodeIds = [...new Set(rootIds.flatMap((id) => [...subtreeIds(mind, id)]))];

    this.cancelTitleEdit();
    const world = this.worldPointOf(event);
    const center = rectCenter(box);
    this.drag = {
      nodeId: pending.nodeId,
      pointerId: pending.pointerId,
      offset: { x: world.x - center.x, y: world.y - center.y },
      center,
      target: { kind: 'none' },
      nodeIds,
      rootIds,
    };
    this.pendingDrag = null;
    for (const id of nodeIds) this.mounted.get(id)?.classList.add(DRAGGING_CLASS);
    this.canvasEl?.classList.add('is-dragging');
    // 连线压暗：拖动期间**模型没动**，连着它的那些线还停在旧位置 ——
    // 不压暗的话，用户看到的是"节点已经飘走了，线还拴在原地"，像坏了
    if (this.edgeLayerEl) this.edgeLayerEl.setCssStyles({ opacity: '0.25' });
    // 关联线同理（`N1`）：模型没动，线还拴在节点原来的位置上
    if (this.linkLayerEl) this.linkLayerEl.setCssStyles({ opacity: '0.25' });
    this.capturePointer(pending.pointerId);
    this.updateDrag(this.drag, event);
    return true;
  }

  /**
   * 预览 + 落点判定（**每帧都算**：辅助线要跟着指针实时改）。
   *
   * ★ 拖拽期间**模型一动不动**：节点跟手靠的是 `transform`（预览），松手才改模型
   *   （与白板拖卡片同一条：拖动中重排会让"手底下的东西"一直跳）。
   */
  private updateDrag(drag: DragState, event: PointerEvent): void {
    const mind = this.mind;
    const box = this.layout?.boxes.get(drag.nodeId);
    const boxes = this.layout?.boxes;
    if (!mind || !box || !boxes) return;

    const world = this.worldPointOf(event);
    drag.center = { x: world.x - drag.offset.x, y: world.y - drag.offset.y };
    const preview: Rect = {
      x: drag.center.x - box.width / 2,
      y: drag.center.y - box.height / 2,
      width: box.width,
      height: box.height,
    };

    // 整簇一起跟手（同一段位移）
    const offsetX = roundTo(preview.x - box.x);
    const offsetY = roundTo(preview.y - box.y);
    for (const id of drag.nodeIds) {
      const nodeEl = this.mounted.get(id);
      if (nodeEl) nodeEl.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
    }

    drag.target = resolveDrop({
      boxes,
      childBoxesOf: (parentId) => this.childBoxesOf(parentId),
      draggedId: drag.nodeId,
      // ★ 传**出发时**那个盒子（`box`），不是上面那个跟着指针走的 `preview`：
      //   预览盒永远含指针，拿它判"原地放下"会把每一次拖拽都作废
      ownBox: box,
      // 这一簇里的任何一个节点（含子孙）都不能当父：挂上去就成环
      forbidden: new Set(drag.nodeIds),
      pointer: world,
    });

    this.paintDropGuide(drag);
    this.scheduleHoverExpand(drag);
  }

  /** 某个节点的子盒子（按次序）—— 落点判定用它算"插到第几个" */
  private childBoxesOf(parentId: string): NodeBox[] {
    const mind = this.mind;
    const boxes = this.layout?.boxes;
    if (!mind || !boxes) return [];
    return childrenOf(mind, parentId)
      .map((node) => boxes.get(node.id))
      .filter((box): box is NodeBox => box !== undefined);
  }

  /**
   * 画辅助线（`D` 关掉时什么都不画，但**拖拽照旧**）。
   *
   * | 落点 | 画什么 |
   * | --- | --- |
   * | 某个节点 | 圈住它 + 一条从它中心到落点的虚线 |
   * | 空白 | 圈住**预览中的自己**（"就落这儿"，没有父可连，所以不画线） |
   * | 原地 / 自己的后代 | 什么都不画 —— 让用户一眼看出"松手不会发生任何事" |
   */
  private paintDropGuide(drag: DragState): void {
    const guide = this.guideLayer;
    if (!guide) return;
    if (!this.guidesOn) {
      guide.set(null);
      return;
    }

    const box = this.layout?.boxes.get(drag.nodeId);
    const preview: Rect | null = box
      ? {
          x: drag.center.x - box.width / 2,
          y: drag.center.y - box.height / 2,
          width: box.width,
          height: box.height,
        }
      : null;

    if (drag.target.kind === 'child') {
      const parent = this.layout?.boxes.get(drag.target.parentId) ?? null;
      guide.set({
        ring: parent,
        line: parent ? [rectCenter(parent), drag.center] : null,
      });
      return;
    }
    if (drag.target.kind === 'free') {
      guide.set({ ring: preview, line: null });
      return;
    }
    if (drag.target.kind === 'blocked') {
      // 落在自己的子孙上：**画红环**而不是什么都不画 —— 用户要能分清
      // "这儿放不了"（红）与"还在原地"（什么都没画）
      guide.set({ ring: this.layout?.boxes.get(drag.target.nodeId) ?? null, invalid: true });
      return;
    }
    guide.set(null);
  }

  /**
   * 悬停展开：拖到**折叠着**的节点上停 `HOVER_EXPAND_MS`，替用户把它展开。
   *
   * ★ 不这么做的话，想挂到"某个被折叠起来的节点"的下面只能松手 → 按空格 → 再拖一次。
   * ★ 展开也是**一次真实的改动**（要写进文件、要能 `⌘Z`），所以走 `edit()`；
   *   同一个 `mergeKey` 让"连拖过几个折叠节点"合并成一步撤销，不至于把撤销栈刷满。
   */
  private scheduleHoverExpand(drag: DragState): void {
    const id = drag.target.kind === 'child' ? drag.target.parentId : null;
    if (id === null || this.hoverExpand?.nodeId === id) {
      if (id === null) this.clearHoverExpand();
      return;
    }

    this.clearHoverExpand();
    const mind = this.mind;
    if (!mind || nodeById(mind, id)?.collapsed !== true) return;

    const timer = window.setTimeout(() => {
      this.hoverExpand = null;
      this.edit(
        t('history.mindExpandHover'),
        (current) => setCollapsed(current, id, false),
        'mind-hover-expand',
      );
    }, HOVER_EXPAND_MS);
    this.hoverExpand = { nodeId: id, timer };
  }

  private clearHoverExpand(): void {
    if (this.hoverExpand) window.clearTimeout(this.hoverExpand.timer);
    this.hoverExpand = null;
  }

  /** 松手：照落点改模型（**一次拖动 = 一步撤销**） */
  private finishDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    const target = drag.target;
    // 先把预览与辅助线收干净：改完模型之后还停在旧位置一帧，看起来就是"松手后弹一下"
    this.clearDragView(drag);

    if (target.kind === 'child') {
      // 整簇：只换"入口"的父，子孙跟着走（`moveNodes` 内部就是这么算的）
      const roots = drag.rootIds;
      this.edit(t('history.mindMove'), (mind) =>
        roots.length > 1
          ? moveNodes(mind, new Set(roots), target.parentId, { index: target.index })
          : moveNode(mind, drag.nodeId, target.parentId, { index: target.index }),
      );
      return;
    }
    if (target.kind === 'free' && drag.rootIds.length === 1) {
      // 落到空白 = 变成悬浮节点，落点就是预览中的那个中心
      this.edit(t('history.mindMove'), (mind) =>
        moveNode(mind, drag.nodeId, null, { free: target.point }),
      );
    }
    // ★ 多选拖到空白**什么都不做**：三支散落的节点"一起飘到空白处"没有明确的样子
    //   （各自落哪、谁跟谁相对如何摆，全是猜）。想做的话得先定坐标规则 —— 见 `06 §11.11`。
  }

  /** 放弃这一拖（`Esc` / 关视图 / 换文件）：模型一个字节都不动 */
  private cancelDrag(): void {
    const drag = this.drag;
    this.pendingDrag = null;
    if (!drag) {
      this.clearHoverExpand();
      return;
    }
    this.clearDragView(drag);
  }

  private clearDragView(drag: DragState): void {
    this.drag = null;
    this.pendingDrag = null;
    this.clearHoverExpand();
    this.guideLayer?.set(null);
    this.canvasEl?.classList.remove('is-dragging');
    if (this.edgeLayerEl) this.edgeLayerEl.setCssStyles({ opacity: '' });
    if (this.linkLayerEl) this.linkLayerEl.setCssStyles({ opacity: '' });
    for (const id of drag.nodeIds) {
      const el = this.mounted.get(id);
      if (!el) continue;
      el.classList.remove(DRAGGING_CLASS);
      el.setCssStyles({ transform: '' });
    }
    this.releasePointer(drag.pointerId);
  }

  /** 辅助线开关（`D`）：留着拖拽的全部行为，只是不再画环与虚线 */
  private toggleGuides(): void {
    this.guidesOn = !this.guidesOn;
    if (this.drag) this.paintDropGuide(this.drag);
    else this.guideLayer?.set(null);
  }

  // ── 选中 ────────────────────────────────────────────────

  /** 单选：锚点与选区都收成一个（★ 顺手放开关联线的选中，两样互斥） */
  private selectNode(id: string | null): void {
    this.selectedLinkId = null;
    this.selectedId = id;
    this.selectedIds = id === null ? new Set() : new Set([id]);
    this.syncSelection();
    this.refreshLinks();
  }

  /**
   * `⇧`+点击：把这个节点加入 / 移出选区（锚点跟着走到它身上）。
   *
   * ★ 锚点总是跟着最后点的那一个：用户"补选"之后接着按 `Tab`，期望的是"给刚点的那个
   *   加个子节点"，而不是"给最早点的那个加"。
   */
  private toggleInSelection(id: string): void {
    this.selectedLinkId = null;
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
    this.selectedId = id;
    this.syncSelection();
    this.refreshLinks();
  }

  // ── 连线（`N1-b`）─────────────────────────────────────────

  // ── 大纲视图（`N3-a`）────────────────────────────────────

  /** 现在是不是大纲视图（`view.outline`；缺席 = 树视图） */
  private get outlineMode(): boolean {
    return this.mind?.view.outline === true;
  }

  /**
   * 现在**聚焦**在哪一支上（`N3-e`；`null` = 看整棵树）。
   *
   * ★ 它住在 `view.focus` 里（与 `outline` / `structure` 同一类）：关掉重开还停在这一支，
   *   而**进出它不进撤销栈、不递增 `revision`**（`updateView` 那条路）。
   * ★ 它是**大纲视图的镜头**：画布那边照旧显示整棵树（`09 §3.6.1` 把聚焦列为 v2，
   *   这一段只做大纲这一半）。
   */
  private get focusId(): string | null {
    return this.mind?.view.focus ?? null;
  }

  /**
   * 大纲里**看得见的那些行**（`N3-e` 起跟着聚焦走）。
   *
   * ★ 三处调用（渲染 / 方向键导航 / 全选）必须用**同一份**行：一处按整棵树、
   *   一处按聚焦那一支的话，"按一下方向键高亮凭空消失"就会回来
   *   （`moveOutlineSelection` 上面那段注释说的同一种毛病）。
   */
  private outlineRows(): OutlineRow[] {
    const mind = this.mind;
    return mind ? outlineRowsOf(mind, this.focusId ?? undefined) : [];
  }

  /**
   * 进出**聚焦**（`N3-e`）：`null` = 回到整棵树。
   *
   * ★ 走 `updateView` ⇒ 不进撤销栈、不递增 `revision`（"这一眼怎么看"不是内容）；
   * ★ 写进**文件**里 ⇒ 关掉重开还停在这一支（`N3-c` 那条"切换记忆"的延伸）；
   * ★ 进来之后**把焦点交给面板**并**滚回顶部**：不然方向键 / `Cmd+[` 都得先点一下，
   *   而"进来第一眼该看到这一支的开头"也是这个视图的基本预期。
   */
  setFocus(id: string | null): void {
    const path = this.file?.path;
    const mind = this.mind;
    if (!path || !mind) return;
    const previous = this.focusId ?? null;
    if (previous === id) return;

    // ★ 飞行动效的**起点**必须在重排之前抓：这一行的 DOM 马上就要被换成
    //   "以它为根"的新列表（见下面 `playFocusFlight`）
    const flightFrom = this.outlineRowElementOf(id);
    // 只在**往里走**时飞：往回退 / 跳到不相干的一支时，那行字飞向标题反而莫名其妙。
    // 判据是"新聚焦的节点是原来那个的子孙" —— 那正是用户眼里"这一行进到顶上去当根"。
    const flyingIn = id !== null && (previous === null || this.isWithinBranch(mind, id, previous));

    this.plugin.mindRepository.updateView(path, { focus: id ?? undefined });
    this.outlineScroll.set(path, 0);
    this.render();
    this.outlinePanel?.element.scrollTo({ top: 0 });
    this.outlinePanel?.element.focus();

    // 过渡动效（`D2`，用户 2026-09-18："大纲视图，进入当前主题加动效"）：
    // 切进 / 切出主题时行列表来一段"淡入 + 轻微下落"（160ms），让"我换了一支"看得见。
    // ★ 先摘类、读一次 `offsetWidth` 强制重排、再加回去 —— 否则**连续**换支（`⌘]` 连按）
    //   里第二次不会再播：类名没变过，浏览器认为这支动画已经跑完了。
    // ★ 只动 `opacity` / `transform`（样式表那边），长列表也不掉帧。
    const outline = this.outlinePanel?.element;
    if (outline) {
      outline.classList.remove('is-refocusing');
      void outline.offsetWidth;
      outline.classList.add('is-refocusing');
    }

    // 飞行（`D2` 续，用户 2026-09-18）：那一行**飞**到它变成根之后的落点（顶部那个标题）
    if (flyingIn) this.playFocusFlight(flightFrom);
  }

  /** 大纲里某一行的 DOM 外壳（`MIND_NODE_ID_ATTR` 认它，与画布是同一个属性） */
  private outlineRowElementOf(id: string | null): HTMLElement | null {
    if (id === null) return null;
    const row = this.outlinePanel?.element.querySelector(`[${MIND_NODE_ID_ATTR}="${id}"]`);
    return row instanceof HTMLElement ? row : null;
  }

  /** `id` 是不是 `ancestor` 的子孙（顺着 `parentId` 往上走 —— 深度就是树高） */
  private isWithinBranch(mind: MindFile, id: string, ancestor: string): boolean {
    let cursor = nodeById(mind, id);
    while (cursor && cursor.parentId !== null) {
      if (cursor.parentId === ancestor) return true;
      cursor = nodeById(mind, cursor.parentId);
    }
    return false;
  }

  /**
   * 进入这一支时的**飞行动效**（`D2` 续，用户 2026-09-18："进入节点的动效还要增加
   * 节点文字向对应展开根节点飞行的动效"）。
   *
   * 做法：复制那一行的外壳、钉在它**原来的位置**上，再 `transform` 到顶部那个标题的位置
   * 并淡出 —— 眼睛跟着它走，就明白"这一行成了新的根"。
   *
   * ★ 飞的是**克隆出来的幽灵**，不动真节点：真节点要跟着列表一起重排，
   *   让它参与动画会与列表那段过渡打架（而且动画一结束它就该消失）。
   * ★ 落点取**大纲标题**（`OUTLINE_HEADING_CLASS`）而不是列表里某一行：
   *   标题就是"当前这一支的根"，正是用户要看到的落点。
   * ★ `prefers-reduced-motion` 下不飞（与列表那段过渡同一条）；
   *   拿不到 `getBoundingClientRect` / `animate`（单测、极老的环境）也直接跳过；
   *   动画被取消（切走 / 视图关闭）时同样把幽灵收掉 —— 否则页面上会留一个"贴着的残影"。
   */
  private playFocusFlight(source: HTMLElement | null): void {
    if (!source || this.prefersReducedMotion()) return;
    const target = this.outlinePanel?.element.querySelector(`.${OUTLINE_HEADING_CLASS}`);
    if (!(target instanceof HTMLElement)) return;
    if (
      typeof source.animate !== 'function' ||
      typeof source.getBoundingClientRect !== 'function'
    ) {
      return;
    }

    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    if (from.width === 0 || from.height === 0 || to.height === 0) return;

    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.addClass('is-flying');
    ghost.setCssStyles({ position: 'fixed' });
    ghost.style.left = `${from.left}px`;
    ghost.style.top = `${from.top}px`;
    ghost.style.width = `${from.width}px`;
    ghost.setCssStyles({ margin: '0' });
    ghost.setCssStyles({ pointerEvents: 'none' });
    ghost.setCssStyles({ zIndex: '1000' });
    source.ownerDocument.body.appendChild(ghost);

    const animation = ghost.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 0.95 },
        {
          transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(0.85)`,
          opacity: 0.1,
        },
      ],
      { duration: 240, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    );
    const cleanup = (): void => ghost.remove();
    animation.addEventListener('finish', cleanup);
    animation.addEventListener('cancel', cleanup);
  }

  /** 用户是不是把系统动画关了（`prefers-reduced-motion`）—— 两处动效共用这一条判据 */
  private prefersReducedMotion(): boolean {
    const win = this.contentEl.ownerDocument.defaultView;
    return win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  }

  /**
   * 返回**上一级**（`⌘[` / 行菜单）。
   *
   * ★ 当前聚焦节点的父**就是根**时 ⇒ **退出聚焦**：`⌘[` 到这里再往上，
   *   本可以"聚焦到根"，但那与"看整棵树"是同一件事 —— 多一层空壳徒增困惑。
   * @returns 有没有真的动（没聚焦 = 这一下不归它）
   */
  private focusOutLevel(): boolean {
    const mind = this.mind;
    const focus = this.focusId;
    if (!mind || focus === null) return false;

    const parentId = nodeById(mind, focus)?.parentId ?? null;
    this.setFocus(parentId !== null && parentId !== mind.rootId ? parentId : null);
    return true;
  }

  /**
   * 完成 / 取消完成（`N3-g`）。一步 `⌘Z` 可退；值没变时 `edit` 不记历史、也不重画。
   *
   * ★ 只改**这一个**节点：它下面的子孙一位都不动 —— "整支变淡"是渲染层看出来的
   *   （`hasDoneAncestor` / `OutlineRow.dimmed`），不是把每个子孙都标一遍。
   *   ⇒ 于是"取消完成"不会把子孙里本来完成过的那些弄丢，撤销也是干净的一步。
   */
  private toggleDone(id: string): void {
    const mind = this.mind;
    const node = mind ? nodeById(mind, id) : null;
    if (!mind || !node || !this.writable) return;

    const next = node.done !== true;
    this.edit(t('history.mindDone'), (draft) => setDone(draft, id, next));
  }

  /**
   * 这个节点的**祖先**里有没有完成的（`N3-g`：整支变淡）。
   *
   * ★ 沿 `parentId` 往上走，**不递归子树**：画布一帧要问几十个节点，
   *   往下走是 O(子树)（同一批节点被反复数），往上走是 O(深度)。
   */
  private hasDoneAncestor(node: MindNode): boolean {
    const mind = this.mind;
    if (!mind) return false;
    let cursor = node.parentId === null ? null : nodeById(mind, node.parentId);
    let guard = 0;
    while (cursor && guard < 512) {
      if (cursor.done === true) return true;
      cursor = cursor.parentId === null ? null : nodeById(mind, cursor.parentId);
      guard += 1;
    }
    return false;
  }

  /**
   * **单击行首圆点 = 进入这一层**（`⌘]` 的鼠标版；用户 2026-09-17 定的分工）。
   *
   * ★ 判在**指针**这一层，不挂 `click`：按在圆点上会启动拖拽（指针捕获在面板上），
   *   捕获之后浏览器把 `click` 派发给**捕获元素** —— 挂在圆点上的监听器收不到
   *   （用户实测："双击没效果，单击也没菜单"，而拖拽好用，正是这个形状）。
   * ★ 连点保护：进入之后**整列换了一批行**，紧接着的第二次点击落在别的行上 ——
   *   不挡的话手快连点两下会连进两层（见 `OUTLINE_ENTER_GUARD_MS`）。
   * ★ 正在改某一行时先**提交**它：不提交 `renderOutline` 会因 `editing` 整帧不画，
   *   面包屑要等下一次才出现（`⌘]` 那条踩过同一个坑）。
   */
  private enterOutlineRow(id: string): void {
    const now = Date.now();
    if (now - this.lastEnterAt < OUTLINE_ENTER_GUARD_MS) return;
    this.lastEnterAt = now;

    if (this.editing !== null) this.commitTitleEdit();
    // ★ 顺手把选区落到这一支上：进来之后它就是顶上的标题（不是一行），但键盘
    //   （`Enter` / `Tab` / `⌫`）总得有个明确的作用对象 —— 否则它们会作用在
    //   "进来之前选中的那个、现在看不见了的节点"上
    this.selectNode(id);
    this.setFocus(id);
  }

  /**
   * 大纲 ↔ 树（右上角按钮与命令面板都走它）。
   *
   * ★ 走 `updateView` ⇒ **不进撤销栈、不递增 `revision`**：与结构 / 线型 / 缩放同一类
   *   （"这一眼怎么看"），不是内容。
   * ★ 切完**显式** `render()`：里面那串 `syncOutlineChrome` + 早退/重排的分支
   *   就是"切过去 / 切回来"的全部动作（见 `render`）。
   */
  toggleOutline(): void {
    const path = this.file?.path;
    if (!path || !this.mind) return;
    // ★ 切走之前先把"滚到哪"记下来（`N3-c`）：切回来还得停在同一处 ——
    //   在长文档里翻到一半、切去导图看一眼再切回来，滚动条回到顶端是很烦的一件事
    if (this.outlineMode) {
      this.outlineScroll.set(path, this.outlinePanel?.element.scrollTop ?? 0);
    }

    this.plugin.mindRepository.updateView(path, { outline: !this.outlineMode });
    this.render();

    if (this.outlineMode) {
      // 切进大纲：滚回上次的位置，并**把焦点交给面板**
      //（不交焦点的话键位得先点一下才生效，用户会以为"按了没反应"）
      this.outlinePanel?.element.scrollTo({ top: this.outlineScroll.get(path) ?? 0 });
      this.outlinePanel?.element.focus();
    } else {
      // ★★ 切回树 = **看全景**（用户 2026-09-17："回到树视图之后，不要聚焦某个节点。
      //   而应该是查看树的全景"）。
      //   从前这里是 `refocusSelectionOnCanvas()`：把镜头**居中到"刚才在改的那个节点"**上
      //   —— 而用户心里那一下是"我回来看这棵树"，不是"被塞到某一行跟前"
      //   （在大纲里连着改了十几行之后，这个区别尤其明显）。
      // ★ 选区照旧留着（`selectedIds` 是**共用的一个字段**）：变的只是镜头 ——
      //   回来就能直接按方向键 / `Tab` 接着改，只是第一眼看的是整棵树。
      // ★ 只在**从大纲切回树**这一下发生：一直在树里的人，镜头一位都不动。
      this.fitContent();
      // ★★ 相机一变，**可见集合**也跟着变，而"刚进入视野"的那批节点手里只有**估算**尺寸
      //   （`paint` 只挂视野内的节点，也只有挂上的才量得到；`applyCamera` 只 `paint` —— 不量、不重排）
      //   ⇒ 不补这一下，切回来的第一眼就是"树是乱的"，直到下一次 `render()`
      //   （比如点开某个节点）才恢复。就在这儿主动量一次 + 重排一次，与图片异步加载后
      //   走的那条路同源（`relayout` = 量 → 算 → 画）。
      //   ★ 用同步的 `relayout()` 而不是 rAF 版 `scheduleRelayout()`：后者会先闪一帧估算尺寸。
      this.relayout();
    }
  }

  /** 重画大纲的行（模型变了 / 选区变了 / 切进来） */
  private renderOutline(): void {
    const mind = this.mind;
    const panel = this.outlinePanel;
    if (!mind || !panel) return;
    // ★ 正在**就地改文本 / 改正文**时绝不重建：`render` 走的是 `replaceChildren`，
    //   会把输入框连同用户敲了一半的字一起拆掉。打字期间模型不会变（变的是输入框自己），
    //   提交之后这两个状态已经清空了，那一次 `render()` 才轮到重建。
    if (this.editing !== null || this.outlineNote !== null) return;

    // ★ 聚焦的那一支可能已经不在了（被删 / 撤销 / 别处改了这份文件）⇒ **就地回到整棵树**：
    //   把那个键收掉（不递归调 `render`），然后用"没聚焦"接着画这一帧。
    //   不清的话用户会停在一个空列表上，而且那个不存在的 id 会一直写回文件里。
    const focus = this.focusId;
    const activeFocus =
      focus !== null && mind.nodes.some((node) => node.id === focus) ? focus : null;
    if (focus !== null && activeFocus === null) {
      const path = this.file?.path;
      if (path) this.plugin.mindRepository.updateView(path, { focus: undefined });
    }

    panel.render(
      this.outlineRows(),
      this.selectedIds,
      {
        // 折叠写的是**模型**（`node.collapsed`）⇒ 重开还在，且与导图里那个手柄是同一件事
        onToggle: (id) => this.toggleCollapseOf(id),
        // ★ 点这一行的**文字** = **直接进编辑**（用户 2026-09-17 的第④条：
        //   "任意点击位置直接出现光标，类似在文本框里可以直接编辑这一行文字"）——
        //   不必先选中再按 `F2`，更不必双击
        onPick: (id, event) => {
          // ★ 刚拖完的那一下 `click` 不算"点了一行"（否则松手就地进编辑）
          if (this.consumeRowClick()) return;
          // ★★ `⇧`+点击 = **范围多选**（与画布 ⇧+点击同一条手感）—— **不进编辑**。
          //   用户 2026-09-17："我的节点单选的操作还是要框选，因为点击就是直接编辑节点标题了。"
          //   ⇒ 大纲里"点一下就进编辑"是用户自己定的规矩，那"只想选、不想改字"就得另给一条；
          //     ⇧+点在**同一行**上就是"只选中这一行"（范围 = 自己），
          //     点另一行则是"从上次那一行到这里"（与画布 / 大纲的 ⇧↑↓ 同一套）。
          if (event.shiftKey) {
            this.extendOutlineSelection(id);
            return;
          }
          this.selectNode(id);
          // 点一行也把键盘交给面板（点完接着按 `Enter` 是新用户的第一反应）
          panel.element.focus();
          // 光标落在**他点的那个字之间**（第⑤条），不是行尾
          this.beginOutlineTitleEdit(id, undefined, event.clientX);
        },
        onEdit: (id) => this.beginOutlineTitleEdit(id),
        onMenu: (id, event) => {
          // ★ 同上：拖完那一下不该顺手弹出菜单
          if (this.consumeRowClick()) return;
          this.showOutlineRowMenu(id, event);
        },
        // ★ 右键这一行 = 这一行的菜单（`N3-e` 起菜单从这儿出；单击已经让给"进入这一层"）
        // ★ 点层级导航（`N3-e`）：`null` = 整棵树（退出聚焦），否则聚焦到那一格
        onCrumb: (id) => this.setFocus(id),
      },
      // 顶上那一行 = 根节点的文字（用户第①条："根节点变成单独标题"，且不可直接改）；
      // 聚焦时它就是**进来的那一支**的文字（标题与"现在这棵树是谁"永远一致）
      outlineTitleOf(mind, activeFocus ?? undefined),
      // 层级导航（`N3-e`）：没聚焦时是空数组 ⇒ 面板不画那条
      outlinePathOf(mind, activeFocus ?? undefined),
    );

    // 选中的那一行滚进视野：方向键走出屏幕之后，"高亮跑去哪了"得有个交代
    if (this.selectedId !== null) {
      panel.rowOf(this.selectedId)?.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * 两套外壳的**幂等**同步：谁显谁隐、按钮上写什么。
   *
   * ★ 幂等是硬要求：`render()` 每帧都会叫它（切进来、换文件、撤销之后都得对）——
   *   写成"只在切换那一刻做一次"迟早漏掉某条路径，最典型的是**打开一份存着大纲状态的图**：
   *   那一刻根本没有"切换"这个动作，只有一次 `render()`。
   */
  private syncOutlineChrome(): void {
    const on = this.outlineMode;
    this.outlinePanel?.element.classList.toggle('is-hidden', !on);
    this.canvasEl?.classList.toggle('is-hidden', on);
    // ★ 缩略图跟着视图走（`P2-c`）：进大纲它退场、回树它回来。
    //   放在这里而不是 `applyOutlineMode`：这一句每次 `render()` 都会走到（幂等、极便宜），
    //   于是"从别处改了设置 / 切了视图"这两种来路都不必各自记得叫它。
    this.syncMinimap();
    // ★ 面包屑跟着视图与聚焦走（用户 2026-09-18）：同样每次 `render()` 都会走到
    this.syncMindCrumbs();

    const toggle = this.outlineToggleEl;
    if (!toggle) return;
    // ★★ 这里**绝不能**改 `textContent`：切换器现在是"白卡片里两格图标"，
    //    一写文字就把两个 `<button>` 整段抹掉 ⇒ 结果就是"只剩文字、而且点不了"
    //    （真实报障）。当前视图只靠这两个类换图标颜色（CSS 里 `is-outline` / `is-tree`）。
    toggle.classList.toggle('is-outline', on);
    toggle.classList.toggle('is-tree', !on);
  }

  // ── 缩略图导航器（`P2-c` / `F1-06`）──────────────────────────
  //
  // 与白板**共用同一个组件**（`ui/MinimapPanel.ts`）与**同一份设置**（`settings.minimap`）：
  // 几何 / "点哪儿跳哪儿" / 视口框 / 键盘路径全都白拿，两边只差一个"格子从哪儿来"
  // （`mindMinimapShapes`）。★ 三个回调都在本视图里落地：面板不认识 `Viewport`、
  // 不认识设置、不认识模型（于是它能被假 DOM 单测）。

  /**
   * 建地图（`onOpen` 里叫一次）。
   *
   * ★ 挂在**画布**里：它是屏幕坐标的浮层，而画布本身是 `position: relative`
   *   （样式表里那一条）⇒ 右下角那套定位直接生效，且不与大纲面板打架。
   */
  private createMinimap(parent: HTMLElement): void {
    this.minimap = new Minimap(parent, {
      shapes: () => mindMinimapShapes(this.mind, this.layout),
      camera: () => ({
        x: this.viewport.x,
        y: this.viewport.y,
        zoom: this.viewport.zoom,
        width: this.viewport.width,
        height: this.viewport.height,
      }),
      // "点哪儿去哪儿"：把视口中心挪到那个世界坐标（与 `⌘0`「适应全部内容」同一个归宿）
      onNavigate: (world) => {
        this.viewport.centerOn(world);
      },
      // 面板上的 `×` 与命令走同一个入口：显隐只有一个真源（设置）
      onRequestHide: () => this.setMinimapVisible(false),
    });
    this.syncMinimap();
  }

  /**
   * 显隐的唯一入口（面板上的 `×` / 命令 / 设置面板三条路都落到这里）。
   *
   * ★ 先**就地**生效、再去落设置：等 `updateSettings` 回来才变的话，点一下要过一帧才看见
   *   （中间还要写一次盘）。其它已打开的视图由 `main.ts` 在设置落定后推给
   *   `applyMinimapSetting` —— 重入一次 `setVisible` 是幂等的（同值直接返回）。
   */
  private setMinimapVisible(visible: boolean): void {
    this.showMinimap(visible);
    void this.plugin.updateSettings({ minimap: visible });
  }

  /** 按**当前设置 + 当前视图**重算该不该显示（视图状态或设置任一变都要重算） */
  private syncMinimap(): void {
    this.showMinimap(this.plugin.settings.minimap);
  }

  /**
   * "要不要显示"的**唯一判据**。
   *
   * ★ **大纲视图里一律不显示**：大纲是"一行一行往下读"的导航，而地图回答的是
   *   "这张图长什么样" —— 那个问题在大纲里没有意义（而且大纲里画布是 `display: none`，
   *   量出来的尺寸全是 0，地图只会画出一团错东西）。
   */
  private showMinimap(wanted: boolean): void {
    this.minimap?.setVisible(wanted && !this.outlineMode);
  }

  /** 命令面板「切换缩略图导航器」（与白板同一个命令，`run` 落到这里） */
  toggleMinimap(): void {
    this.setMinimapVisible(!this.plugin.settings.minimap);
  }

  /** 设置变更后由 `main.ts` 推过来（与白板那份同签名，`main.ts` 可以一视同仁地推） */
  applyMinimapSetting(visible: boolean): void {
    this.showMinimap(visible);
  }

  /**
   * 大纲视图的键位分派（`N3-b`）。
   *
   * 返回 `true` = 这一下归大纲（调用方 `preventDefault` 并收工）。
   * ★ 绝大多数动作**直接调画布那几个同名方法**（新建同级 / 子级 / 提升 / 删除 /
   *   折叠 / 换序）：语义只有一处实现，两套视图就不会分叉。
   */
  // ── 大纲里拖拽调整结构（`N3-d`）────────────────────────

  /**
   * 按住**行首圆点**开始（`N3-d`）。
   *
   * ★ 事件**委托**在面板上（`render` 每次换一批行，挂在行上的监听器留不住）——
   *   这里 `closest` 找抓手，再从行上读 `MIND_NODE_ID_ATTR`（与画布"点到了谁"同一套判据）。
   * ★ **不立刻开始拖**：先记下起点，等指针动过 `DRAG_THRESHOLD_PX` 才算 ——
   *   否则"点一下圆点开菜单"每次都要走一遍拖拽的收尾（与画布那条同一个理由）。
   */
  private readonly onOutlinePointerDown = (event: PointerEvent): void => {
    // ★★ 闸门必须是 `mindWritable`（**真实报障**）：回车 / `Tab` 之后编辑器是**开着的**
    //   （那正是"接着编辑"的意思），而 `writable` 含 `!this.editing` ⇒ 按圆点直接被拒 ⇒
    //   "回车和 tab 多操作几次之后，点前方小黑点进入节点会失效"。
    //   ★ 这一下按在圆点上要**先于**失焦提交发生（`pointerdown` 早于 `blur`）⇒
    //     不能用"反正马上会提交"来兜。这里只**记状态**，不改模型 ⇒ 用只读闸门是对的。
    if (!this.mindWritable || !this.outlineMode || event.button !== 0) return;
    // ★ 上一次拖完那个"吞 click"的标记在这里**自愈**：万一那一下 `click` 没来
    //   （指针在面板外松开等），不清的话它会吞掉**下一次正常点击**
    this.suppressRowClick = false;
    // ★★ 面板里的**界面 chrome**（面包屑那条、根标题行）不归框选管、也不归"点空白清空选区"管。
    //   真实报障："大纲视图的面包屑坏了，点击无效果" —— 成因正是"点空白 ⇒ 清空选区"那条路
    //   先把面板**整列重画**了，于是那一下 `click` 落不到原来的面包屑上（元素已经被换掉）。
    //   ★ 判据是"落点在不在 chrome 里"，不是"要不要放行" —— chrome 上的点击原样交给它们自己。
    if (this.hitsOutlineChrome(event.target)) return;
    // ★★ 框选（`N3-h`）：**不是圆点、也不是文字列**就起手 ——
    //   文字列留给浏览器选字（用户要的"通用 ⌘C"），圆点留给"拖这一行"那套。
    //   竖线格 / 行尾空白 / 列表下方的面板空白都算框选区。
    const bullet0 = (event.target as Element | null)?.closest(`.${OUTLINE_BULLET_CLASS}`) ?? null;
    if (!bullet0) {
      // ★ 起手位置只决定"要不要等方向"，不再决定"能不能框选"：
      //   文字列上起手 ⇒ 等动起来看方向（竖着拖框选 / 横着拖选字）；
      //   其余落点 ⇒ 直接框选。
      this.beginOutlineMarquee(event, this.hitsOutlineTextColumn(event.target));
      return;
    }
    const bullet = bullet0;
    const row = bullet?.closest(`.${OUTLINE_ROW_CLASS}`) ?? null;
    const id = row?.getAttribute(MIND_NODE_ID_ATTR) ?? null;
    if (!id) return;

    this.outlineDrag = {
      id,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      moved: false,
      target: null,
      plan: null,
    };
    this.captureOutlinePointer(event.pointerId);
  };

  /** 拖动中：过阈值 → 算落点 → 画提示（模型一动不动） */
  private readonly onOutlinePointerMove = (event: PointerEvent): void => {
    // ★ 框选最优先（`N3-h`）：它是**最近**开始的那个手势（与 `Esc` 那条同一条口径）
    const marquee = this.outlineMarquee;
    if (marquee) {
      if (marquee.pointerId !== event.pointerId) return;
      this.updateOutlineMarquee(marquee, event);
      return;
    }

    const drag = this.outlineDrag;
    const panel = this.outlinePanel;
    if (!drag || !panel || drag.pointerId !== event.pointerId) return;

    if (!drag.moved) {
      const travelled = Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y);
      if (travelled < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      panel.setDraggingRow(drag.id);
    }

    this.autoScrollOutlinePanel(panel, event.clientY);

    const mind = this.mind;
    const target = panel.dropAt(event.clientY);
    drag.target = target;
    drag.plan =
      mind && target ? outlineDropPlanOf(mind, drag.id, target.targetId, target.zone) : null;
    panel.setDropHint(target ? { ...target, invalid: drag.plan === null } : null);
    event.preventDefault();
  };

  /**
   * 松手：照落点改模型（**一次拖动 = 一步 `⌘Z`**）；落不下去就什么都不做。
   *
   * ★ 没动过阈值 ⇒ 这一下还是"点击"：圆点照旧开菜单、行照旧进编辑（什么都不拦）。
   * ★ 动过 ⇒ 置 `suppressRowClick`：把浏览器随后补的那个 `click` 吞掉
   *   （否则松手会顺手弹菜单 / 进编辑）。
   */
  private readonly onOutlinePointerUp = (event: PointerEvent): void => {
    if (this.outlineMarquee?.pointerId === event.pointerId) {
      this.endOutlineMarquee();
      return;
    }

    const drag = this.outlineDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { id, moved, plan } = drag;
    this.endOutlineDrag();

    if (!moved) {
      // ★ 这一下按在**圆点**上（只有圆点会走进这个状态机）⇒ 单击 = **进入这一层**
      //   （用户 2026-09-17 定的分工："直接把单击出菜单功能砍掉，单击就进入这一层"）。
      //   ★ 必须在**指针**这一层判：按在圆点上会启动拖拽（捕获在面板上），
      //     而捕获之后浏览器会把 `click` 派发给**捕获元素** —— 挂在圆点上的 `click`
      //     监听器根本收不到（这正是"单击没菜单、双击没效果、拖拽却好用"的根因）。
      //   ★ 行里别处那一下仍然走行自己的 `click`（那边没有捕获，照旧好用）。
      this.enterOutlineRow(id);
      return;
    }

    this.suppressRowClick = true;
    if (!plan) return;
    const changed = this.edit(t('history.mindMove'), (mind) =>
      moveNode(mind, id, plan.parentId, plan.index === undefined ? {} : { index: plan.index }),
    );
    // 挪成了 ⇒ 顺手选中它（与画布拖完一样）：接着就能 `Enter` / `Tab` 继续整理这一段
    if (changed) this.selectNode(id);
  };

  /**
   * 拖到面板上下边缘时**自动滚**（`N3-d`）。
   *
   * ★ 每来一条 `pointermove` 滚一小步（不做 `requestAnimationFrame` 的常驻循环）：
   *   长列表里"往上看不到的地方挪"确实会慢一点，但按住不动时**不会**自己一直滚 ——
   *   那种失控的滚动比慢更烦人。真嫌慢，挪一下指针就多滚一步。
   */
  private autoScrollOutlinePanel(panel: OutlinePanel, clientY: number): void {
    const rect = panel.element.getBoundingClientRect();
    if (clientY < rect.top + OUTLINE_DRAG_EDGE_PX) {
      panel.element.scrollTop -= OUTLINE_DRAG_SCROLL_STEP;
    } else if (clientY > rect.bottom - OUTLINE_DRAG_EDGE_PX) {
      panel.element.scrollTop += OUTLINE_DRAG_SCROLL_STEP;
    }
  }

  /** 收干净这一拖（提示、被拖行的样式、指针捕获）—— 模型一个字节都没动过 */
  private endOutlineDrag(): void {
    const drag = this.outlineDrag;
    if (!drag) return;
    this.outlineDrag = null;
    this.outlinePanel?.setDropHint(null);
    this.outlinePanel?.setDraggingRow(null);
    try {
      this.outlinePanel?.element.releasePointerCapture(drag.pointerId);
    } catch {
      // 没捕获过（或指针已经消失）时 release 会抛，忽略
    }
  }

  /** 放弃这一拖（`Esc` / 换文件）：已经动过的话，那一下 `click` 也要一起收掉 */
  private cancelOutlineDrag(): void {
    const moved = this.outlineDrag?.moved === true;
    this.endOutlineDrag();
    if (moved) this.suppressRowClick = true;
  }

  /** 收掉"拖拽之后紧跟的那一次点击"（`onPick` / `onMenu` 进来先问一句） */
  private consumeRowClick(): boolean {
    if (!this.suppressRowClick) return false;
    this.suppressRowClick = false;
    return true;
  }

  private captureOutlinePointer(pointerId: number): void {
    try {
      this.outlinePanel?.element.setPointerCapture(pointerId);
    } catch {
      // 指针已经消失（触屏被系统打断）：不影响后续交互，只是可能收不到 up
    }
  }

  // ── 大纲**框选**（`N3-h`，用户 2026-09-17）────────────────────────
  //
  // 用户原话："如果框选，可以框选住多行，实际上会变成选中多个节点。此时 ⌘C 再选中任意
  // 节点 ⌘V，就相当于把这些节点的复制，添加到选中的子节点下。"
  // ⇒ 框选只负责"选中多个"；复制 / 粘贴走**已有的** `copySelection` / `pasteClipboard`
  //   （它们本来就支持多支 ⇒ 贴到选中节点下面），这里一行都不用重写。

  /**
   * 落点在不在面板的**界面 chrome** 上（面包屑那条 / 根标题行）。
   *
   * ★ 这两处不是"内容"：在那儿起手既不该框选，也不该触发"点空白 = 清空选区" ——
   *   后者会**整列重画**，把用户正要点的那一格面包屑换掉（`click` 随之落空）。
   * ★ 判的是**祖先里有没有它**（`closest`）：点 chip 里的文字 / 那根分隔线都算。
   */
  private hitsOutlineChrome(target: EventTarget | null): boolean {
    const el = target as Element | null;
    if (!el?.closest) return false;
    return (
      el.closest(`.${OUTLINE_CRUMBS_CLASS}`) !== null ||
      el.closest(`.${OUTLINE_HEADING_CLASS}`) !== null
    );
  }

  /** 落点在不在**文字列**里（那一列留给浏览器选字，框选绕开它） */
  private hitsOutlineTextColumn(target: EventTarget | null): boolean {
    const el = target as Element | null;
    return el?.closest?.(`.${OUTLINE_MAIN_CLASS}`) != null;
  }

  /** 指针位置 → **面板内容坐标**（虚线框是面板的绝对定位子元素，跟着内容滚） */
  private outlineContentPoint(event: { clientX: number; clientY: number }): Point | null {
    const panel = this.outlinePanel;
    if (!panel) return null;
    const rect = panel.element.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + panel.element.scrollLeft,
      y: event.clientY - rect.top + panel.element.scrollTop,
    };
  }

  /**
   * 开始框选（`N3-h`）。
   *
   * ★ 起手位置是**非文字区**（见 `onOutlinePointerDown` 那句）：文字列上拖拽要留给
   *   浏览器**选字** —— 两个手势都从"在行上按下去"开始，只能靠落点区分。
   * ★ 起点存**面板内容坐标**（那个虚线框是面板的绝对定位子元素，用视口坐标的话
   *   一滚就飘）；命中判定另用**视口坐标**（行的矩形就是视口坐标，见 `updateOutlineMarquee`）。
   * ★ 只**记状态**，不改模型 ⇒ 与拖行一样，`Esc` 收掉即可，没有任何"回滚"要写。
   */
  private beginOutlineMarquee(event: PointerEvent, startsOnText: boolean): void {
    const point = this.outlineContentPoint(event);
    if (!point || !this.outlineMarqueeEl) return;
    const onRow =
      ((event.target as Element | null)?.closest(`.${OUTLINE_ROW_CLASS}`) ?? null) !== null;
    this.outlineMarquee = {
      pointerId: event.pointerId,
      start: point,
      current: point,
      startClient: { x: event.clientX, y: event.clientY },
      // `⇧` = 加选（与画布框选、⇧+点击同一套手感）：按下去时已有的选区先留着
      base: event.shiftKey ? new Set(this.selectedIds) : new Set<string>(),
      startsOnText,
      decided: 'none',
      onRow,
    };
    // ★★ **这里不抓指针捕获**（真实报障换来的）：一抓，浏览器就把随后的 `click`
    //   派发给**捕获元素**（面板）⇒ 行的 `click`（进编辑 + 按点击位置落光标）与
    //   面包屑的 `click`（回上一层）全都收不到 ⇒ 表现为"点文字光标不落在点的地方""没法回上一层"。
    //   ⇒ 等这一拖**真的变成框选**那一刻再抓（见 `updateOutlineMarquee`）：
    //     普通点击必然收不到捕获，一切照旧；框选照样能拖出手指/面板之外。
  }

  /** 框选中：画那个虚线框 + 把框住的行选中（没过阈值之前什么都不做，免得吃掉"点一行进编辑"） */
  private updateOutlineMarquee(marquee: OutlineMarqueeState, event: PointerEvent): void {
    const panel = this.outlinePanel;
    const box = this.outlineMarqueeEl;
    const point = this.outlineContentPoint(event);
    if (!panel || !box || !point) return;
    marquee.current = point;

    if (marquee.decided === 'none') {
      const dx = event.clientX - marquee.startClient.x;
      const dy = event.clientY - marquee.startClient.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      // ★★ 方向定生死：**竖着**拖 = 框选（"框住下面几行"就是这么拖的）；
      //   **横着**拖 = 选字（选一段文字的自然动作）⇒ 这一拖交还给浏览器。
      //   ★ 只有"起手在文字列上"才需要判方向：其余落点（竖线格 / 行尾空白 / 面板空白）
      //     本来就没人和我们抢 —— 直接框选。
      //   ★ 为什么必须这么分：两个手势都从"在某一行上按下去"开始，靠落点分（第一版的做法）
      //     用户根本找不到 —— 真实报障："现在没有框选机制"。
      if (outlineDragIsText(dx, dy, marquee.startsOnText)) {
        marquee.decided = 'text';
        return;
      }
      marquee.decided = 'marquee';
      // ★ 定了框选 ⇒ 现在才**抓指针捕获**（早抓会把普通点击的 `click` 一起吃掉，见 `beginOutlineMarquee`）
      this.captureOutlinePointer(marquee.pointerId);
      // ★ 定了框选 ⇒ 把浏览器已经开始的那点文字选区**清掉**：不清的话紧接着按 `⌘C`
      //   会走"复制文字"那条路（`hasTextSelection`），而用户想复制的是**节点**
      this.contentEl.ownerDocument.getSelection()?.removeAllRanges();
      box.classList.add('is-on');
    }
    if (marquee.decided === 'text') return;

    const left = Math.min(marquee.start.x, point.x);
    const top = Math.min(marquee.start.y, point.y);
    const width = Math.abs(point.x - marquee.start.x);
    const height = Math.abs(point.y - marquee.start.y);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;

    // 命中判定：把内容坐标 + 滚动量还回**视口坐标**（行的矩形就是视口坐标）
    const panelRect = panel.element.getBoundingClientRect();
    const hits = panel.idsInBox({
      x: panelRect.left + left - panel.element.scrollLeft,
      y: panelRect.top + top - panel.element.scrollTop,
      width,
      height,
    });
    this.selectedIds = new Set([...marquee.base, ...hits]);
    // "主选中"跟着框里第一条走（方向键 / 结构键都作用在它身上）
    if (hits.length > 0) this.selectedId = hits[0] ?? null;
    // ★ 拖动中**只改哪几行高亮**（`setSelection`）：整列重画留到松手那一下 ——
    //   每帧重建一列 DOM 在长列表里会明显卡
    panel.setSelection(this.selectedIds);
    event.preventDefault();
  }

  /**
   * 松手 / `Esc`：收掉虚线框。
   *
   * ★ 动过阈值 ⇒ 置 `suppressRowClick`（复用"拖完吞一次 click"那套）：松手那一下
   *   `click` 不该顺手进编辑。
   * ★ 收尾做完整的一次 `syncSelection()`（此时才整列重画；拖动中每帧只改类）。
   */
  private endOutlineMarquee(): void {
    const marquee = this.outlineMarquee;
    if (!marquee) return;
    this.outlineMarquee = null;
    this.outlineMarqueeEl?.classList.remove('is-on');
    this.releasePointer(marquee.pointerId);
    // 定过方向（框选 / 选字）⇒ 吞掉随后那一次 `click`：
    // 拖完松手不该顺手进编辑（选字那一路同理 —— 选完字接着进来改，不是用户的意思）
    if (marquee.decided !== 'none') this.suppressRowClick = true;
    if (marquee.decided === 'marquee') {
      this.syncSelection();
      return;
    }
    // ★ 没过阈值就松手 = 一次**普通点击**：
    //   · 落在行里 ⇒ 什么都不做（交给行自己的 `click`：进编辑 + 按点击位置落光标）；
    //   · 落在**空白**（列表下方 / 两侧 / 标题行）⇒ **清空选区** ——
    //     用户原话："点空白处也不取消多选"（与画布"点空白 = 清空选区"同一条手感）。
    if (marquee.decided === 'none' && !marquee.onRow) this.selectNode(null);
  }

  private handleOutlineKey(event: KeyboardEvent): boolean {
    // 框选中时 `Esc` = 收掉框（选区留着不动 —— 框只是"怎么选"，不是内容）
    if (event.key === 'Escape' && this.outlineMarquee) {
      this.endOutlineMarquee();
      return true;
    }
    // ★ 正在拖一行时 `Esc` = 放弃这一拖（模型没动过，收干净就走）——
    //   排在键位表**之前**：拖动是**最近**开始的那个手势，`Esc` 该收的是它
    if (event.key === 'Escape' && this.outlineDrag) {
      this.cancelOutlineDrag();
      return true;
    }
    const action = outlineKeyActionOf(event);
    switch (action.kind) {
      case 'navigate':
        this.moveOutlineSelection(action.delta, action.extend);
        return true;
      case 'structure':
        if (action.to === 'sibling') this.endEnterOnSelection();
        else if (action.to === 'child') this.addChildToSelection();
        else this.promoteSelection();
        return true;
      // 缩进一层（`N3-i`：`Tab`）—— 与编辑器里那个 `Tab` 同一个动作
      case 'indent':
        this.indentSelection();
        return true;
      case 'remove': {
        const id = this.selectedId;
        if (id === null) return false;
        // ★ 删除的两种语义（用户规格第 8 条）：
        //   `⌘⇧⌫`（带 `⌘`）= 连整支一起删；
        //   光秃秃的 `⌫` = **只在这一行是空的时候**删，且**把子节点留下来**
        //   （提到它的位置）—— 于是"退格"是"把这一层抹掉"，
        //   绝不会因为手抖把一整支抹了（非空的行按 ⌫ 什么都不做）
        if (event.metaKey || event.ctrlKey) {
          this.selectNode(id);
          this.deleteSelection();
          return true;
        }
        const mind = this.mind;
        const node = mind ? nodeById(mind, id) : null;
        if (!node || node.parentId === null || node.text.length > 0) return false;
        this.removeRowKeepChildren(id);
        return true;
      }
      case 'reorder':
        this.reorderSelection(action.delta);
        return true;
      case 'toggle-collapse':
        this.toggleSelectionCollapse();
        return true;
      // 完成 / 取消完成（`N3-g`）：`⌘⇧⏎`
      case 'toggle-done': {
        const id = this.selectedId;
        if (id === null) return false;
        this.toggleDone(id);
        return true;
      }
      // 聚焦（`N3-e`）：`⌘]` 进入当前这一行、`⌘[` 返回上一级
      case 'focus-in': {
        const id = this.selectedId;
        if (id === null) return false;
        this.setFocus(id);
        return true;
      }
      case 'focus-out':
        return this.focusOutLevel();
      case 'edit-title': {
        const id = this.selectedId;
        if (id) this.beginOutlineTitleEdit(id, action.seed);
        return true;
      }
      case 'edit-note': {
        const id = this.selectedId;
        if (id) this.beginOutlineNoteEdit(id);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * `⇧`+点击（大纲里的行）= **范围多选**，且**不进编辑**（`N3-h`）。
   *
   * ★ 为什么需要它：大纲里"点一下就行内编辑"是用户定的规矩 ⇒ "只想选、不想改字"必须另给一条。
   *   与画布的 ⇧+点击、大纲的 `⇧↑↓` 是**同一套**：以当前选中的那行为锚点，扩展到点中的那一行；
   *   点在**同一行**上就是"只选中这一行"（范围 = 自己）。
   * ★ 顺序一律按**看得见的行序**取（`outlineRows()`），与 `⌘C` 复制出来的次序一致。
   */
  private extendOutlineSelection(id: string): void {
    const rows = this.outlineRows().map((row) => row.id);
    const anchor = this.selectedId ?? id;
    const from = rows.indexOf(anchor);
    const to = rows.indexOf(id);
    if (from < 0 || to < 0) {
      this.selectNode(id);
      return;
    }
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    this.selectedIds = new Set(rows.slice(start, end + 1));
    this.selectedId = id;
    this.syncSelection();
    // 键盘交给面板：接着 `⇧↑↓` / `⌘C` / `Tab` 都作用在这段选区上
    this.outlinePanel?.element.focus();
  }

  /**
   * 上下走一行（顺序 = **大纲里看得见的那些行**）。
   *
   * ★ 用 `outlineRowsOf` 而不是画布那份 `visibleIds`：后者**含悬浮节点**（它们在大纲里
   *   根本没有行）—— 拿它导航会出现"按一下方向键，高亮凭空消失"（选中了一个看不见的节点）。
   * ★ `⇧` = 加选 / 往回缩一行（列表里那一套手感）：往下加、往上把锚点收回来。
   */
  private moveOutlineSelection(delta: -1 | 1, extend: boolean): void {
    const mind = this.mind;
    if (!mind) return;
    const rows = this.outlineRows();
    if (rows.length === 0) return;

    const current = this.selectedId;
    const index = current === null ? -1 : rows.findIndex((row) => row.id === current);
    const next = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + delta));
    const target = rows[next];
    if (!target) return;

    if (!extend) {
      this.selectNode(target.id);
      // ★ 上下走一行 = **把光标搬过去**：这个视图里"当前在哪一行"就是靠光标表示的
      //   （行没有背景也没有边框 —— 用户 2026-09-17 的第④条），所以顺手开编辑；
      //   按 `Esc` 立刻退出，模型一个字节都不会动
      this.beginOutlineTitleEdit(target.id);
      return;
    }

    if (delta > 0) {
      this.selectedIds.add(target.id);
    } else if (this.selectedIds.size > 1 && current !== null) {
      this.selectedIds.delete(current);
    }
    this.selectedId = target.id;
    if (this.selectedIds.size === 0) this.selectedIds.add(target.id);
    this.syncSelection();
  }

  /**
   * 同级内换序（大纲的 `⌥↑↓` / `⌘⇧↑↓`；幕布用的是后者）。
   *
   * ★ 直接**互换这一对兄弟的 `order`**，不走 `moveNode`：同一个父下的 `order` 是一组
   *   连续的 `0..n-1`（`validate` 保证），互换之后仍是那一组 —— 排序结果正确，而
   *   "挂在同一个父下"本来就成立（不涉及环、不涉及悬浮节点，那条路上的防护都用不上）。
   * ★ 到顶 / 到底**什么都不做**：越界挪一位没有意义，`edit` 也不会记一步空历史。
   */
  private reorderSelection(delta: -1 | 1): void {
    const mind = this.mind;
    if (!mind) return;
    const id = this.selectedId;
    const node = id === null ? null : nodeById(mind, id);
    // 根没有兄弟可换；悬浮节点（大纲里看不到）也跳过
    if (!node || node.parentId === null) return;

    this.edit(t('history.mindMove'), (draft) => {
      const siblings = childrenOf(draft, node.parentId);
      const index = siblings.findIndex((item) => item.id === node.id);
      const self = siblings[index];
      const other = siblings[index + delta];
      if (!self || !other) return false;
      const swap = self.order;
      self.order = other.order;
      other.order = swap;
      return true;
    });
  }

  // ── 大纲里"像改文本一样"改结构（`N3-i`，用户 2026-09-17）────────────
  //
  // 用户要的是**文本编辑器的习惯**：`⏎` 按光标拆行、`Tab` / `⇧Tab` 缩进 / 提升。
  // ★ 这一组与"选中一行时"那张键位表**共用同一批模型操作**（`splitNodeAt` / `indent` /
  //   `promote`）—— 差别只有一处：编辑态下还要**把编辑器接着开在同一个节点上**。
  // ★★ 两件事必须记牢：
  //   ① **编辑器不是实时落盘的**（`input` 只驱动影子与重排，见 `buildTitleEditor` 那条）
  //      ⇒ 每次做结构改动前，都得先把当前那份**草稿**用 `setText` 写回模型，
  //      否则用户刚敲的字会在编辑器被拆掉时一起消失；
  //   ② 草稿 + 结构改动放在**同一个 `edit`** 里 ⇒ 一次按键只占**一步撤销**。

  /** 编辑器里那一份（还没提交的草稿）：文本 + 光标位置（`null` = 现在没在编辑） */
  private outlineDraftOf(): { id: string; text: string; caret: number } | null {
    const editing = this.editing;
    if (!editing) return null;
    const input = editing.editor.input;
    const text = input.value;
    // `selectionStart` 在带选区时是**锚点**，正合"光标之前 / 之后"这个说法
    return { id: editing.nodeId, text, caret: input.selectionStart ?? text.length };
  }

  /**
   * 编辑态下大纲特有的那几个键（`N3-i`）：接住了返回 `true`。
   *
   * ★ 只接**不带 `⌘`** 的那几档：`⌘⏎` / `⇧⏎`（改正文）、`⌘]` / `⌘[`（聚焦）、
   *   `⌘⇧⏎`（完成）照旧走原来那些路（聚焦那两键在本函数之后、由另一个监听器接）。
   */
  private handleOutlineEditKey(event: KeyboardEvent): boolean {
    if (event.isComposing === true || event.keyCode === 229) return false;
    const mod = event.metaKey === true || event.ctrlKey === true;
    const alt = event.altKey === true;
    const shift = event.shiftKey === true;
    if (mod) return false;

    // `⌥⏎` = 新建**子**节点（原来是 `Tab`；`Tab` 让给"缩进"了 —— `outlineKeys.ts` 里那段有说明）
    if (event.key === 'Enter' && alt) {
      event.preventDefault();
      this.addChildFromOutlineEdit();
      return true;
    }
    if (event.key === 'Enter' && !shift) {
      event.preventDefault();
      this.splitOutlineRow();
      return true;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      this.shiftOutlineRow(shift ? 'outdent' : 'indent');
      return true;
    }
    return false;
  }

  /**
   * **`⏎` = 按光标拆行**（`N3-i`）。
   *
   * 用户原话："以光标之前的文字为一个节点，以光标之后的文字为原节点（子节点都跟随这个节点）
   * 光标会在这个后半截文字节点的最前方并且是一种可编辑状态。"
   * ⇒ 拆完接着编辑**哪一个**节点由 `splitNodeAt` 的返回值说了算（中间插字 = 原节点；
   *   在末尾回车 = 新建的那个空兄弟），这里只负责把编辑器开在它身上、光标落到最前面。
   */
  private splitOutlineRow(): void {
    const draft = this.outlineDraftOf();
    if (!draft || !this.mindWritable) return;
    // 下面要重画 + 重开编辑器 ⇒ 先把这一个收掉（不然它指向的行已经被换掉了）
    this.closeTitleEdit();

    let target: string | null = null;
    this.edit(t('history.mindSplit'), (mind) => {
      const wrote = setText(mind, draft.id, draft.text);
      target = splitNodeAt(mind, draft.id, draft.caret);
      return target !== null || wrote;
    });

    // ★ 拆成了 ⇒ 编辑"后半截那个节点"的最前面；没拆成（根 / 节点不在）⇒ 原样开回去
    if (target !== null) this.beginOutlineTitleEdit(target, undefined, undefined, 0);
    else this.beginOutlineTitleEdit(draft.id, undefined, undefined, draft.caret);
  }

  /**
   * **`Tab` / `⇧Tab` = 缩进 / 提升**（`N3-i`）。
   *
   * ★ 光标位置**照旧**：缩进只是把这一行挪了一层，"光标在哪个字之间"与它无关 ⇒
   *   结构改完再把编辑器开回同一行、同一个位置（所以要先量下 `caret`）。
   */
  private shiftOutlineRow(how: 'indent' | 'outdent'): void {
    const draft = this.outlineDraftOf();
    if (!draft || !this.mindWritable) return;
    this.closeTitleEdit();

    this.edit(how === 'indent' ? t('history.mindMove') : t('history.mindPromote'), (mind) => {
      const wrote = setText(mind, draft.id, draft.text);
      const moved = how === 'indent' ? indent(mind, draft.id) : promote(mind, draft.id);
      return moved || wrote;
    });

    this.beginOutlineTitleEdit(draft.id, undefined, undefined, draft.caret);
  }

  /** `⌥⏎`（编辑态）= 新建一个子节点并接着编辑它（草稿先写回） */
  private addChildFromOutlineEdit(): void {
    const draft = this.outlineDraftOf();
    if (!draft || !this.mindWritable) return;
    this.closeTitleEdit();

    let created: string | null = null;
    this.edit(t('history.mindAddChild'), (mind) => {
      const wrote = setText(mind, draft.id, draft.text);
      created = addChild(mind, draft.id);
      return created !== null || wrote;
    });

    if (created !== null) this.beginOutlineTitleEdit(created, undefined, undefined, 0);
    else this.beginOutlineTitleEdit(draft.id, undefined, undefined, draft.caret);
  }

  /**
   * 就地改**大纲里某一行的标题**（`N3-b`）。
   *
   * ★ 与画布那条（`beginTitleEdit`）共用同一个 `editing` 状态与同一套提交：区别只有
   *   "输入框插在哪儿"—— 这条插在**行里**。于是 `commitTitleEdit` / `cancelTitleEdit` /
   *   `titleEditKeyOf`（含"组字中的 `Enter` 不算提交"）全都白拿 —— 两处各写一份的话，
   *   中文用户迟早在其中一处被切词。
   * ★ `seed` = "直接打字"的那个字（幕布 / Workflowy 的手感）：带着它打开、光标落在末尾。
   * ★ **不**重排整棵树：行的宽度由 CSS 的 flex 撑，与画布那边"节点宽度撑出来"不是一回事。
   */
  private beginOutlineTitleEdit(
    nodeId: string,
    seed?: string,
    caretX?: number,
    caretIndex?: number,
  ): void {
    const mind = this.mind;
    const panel = this.outlinePanel;
    // ★ 这里用 `mindWritable` 而不是 `writable`：从一行**点进另一行**（或改标题改到一半
    //   去改正文）时，旧编辑器还开着 ⇒ `writable` 恒为 false ⇒ 点击静默没反应。
    //   下面紧接着就会把旧编辑器收掉，所以"编辑器开着"不构成拒绝打开的理由
    if (!mind || !panel || !this.mindWritable) return;
    const node = nodeById(mind, nodeId);
    if (!node) return;
    // ★ 已经在这一行上编辑了就别重开：双击的第二次 `click` 会再叫一次，
    //   重开一次会闪一下（提交 → 再打开），光标位置也丢了
    if (this.editing?.nodeId === nodeId) return;

    this.cancelTitleEdit();
    this.cancelLinkLabelEdit();
    this.cancelOutlineNoteEdit();
    // ★ 先确保**这一行真的在 DOM 里**：刚新建的节点可能还没轮到重画（仓库那边是异步通知）
    if (panel.rowOf(nodeId) === null) this.renderOutline();
    const row = panel.rowOf(nodeId);
    const title = row?.querySelector<HTMLElement>(`.${OUTLINE_TITLE_CLASS}`);
    if (!row || !title) return;

    // ★ 先把**标题原来的框**量下来 —— 下一步输入框要一模一样地盖上去。
    //   量的是**行内坐标**：两个 `getBoundingClientRect()` 都是视口坐标，相减即得，
    //   于是面板滚动 / 摆放位置都不影响。
    const rowBox = row.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();

    const editor = buildTitleEditor(
      this.contentEl.ownerDocument,
      seed !== undefined ? `${node.text}${seed}` : node.text,
      t('mind.nodeTitle.label'),
    );
    // ★ 输入框要"长得与这一行一模一样"：字号 / 字重 / 斜体 / 颜色全从**那一行的标题**量过来
    //   （字号是视图按行内联写在标题上的，样式表里拿不到）。样式表再去掉边框 / 底色 /
    //   内边距 ⇒ 用户看到的只是"光标落进了这段文字里"，不是"弹出一个输入框"
    //   （用户 2026-09-17 的第⑤条）。
    const view = this.contentEl.ownerDocument.defaultView;
    const computed = view ? view.getComputedStyle(title) : null;
    if (computed) {
      // ★ 逐项写，不用 `font:` 简写 —— 简写在 `getComputedStyle` 上各家行为不齐
      //   （有的浏览器返回空串），拿不到就等于没设，字会突然变小。
      // ★ **外层与输入框都要写**：里面那个"影子"（撑宽度用）从外层继承字体；
      //   只写输入框的话影子还在用组件自带的 `line-height: 1.35`，
      //   于是进出编辑态时行高差一点 —— 用户第 3 条看到的"文字往下跳"有一部分就是它。
      const faces = [editor.element.style, editor.input.style];
      for (const face of faces) {
        face.fontFamily = computed.fontFamily;
        face.fontSize = computed.fontSize;
        face.fontWeight = computed.fontWeight;
        face.fontStyle = computed.fontStyle;
        face.lineHeight = computed.lineHeight;
        face.color = computed.color;
      }
    }
    // ★ 标题**不是** `display: none`，而是 `visibility: hidden`：它仍然占着原来的位置 ⇒
    //   这一行的高度、缩进、后面元素的左右边界**一个像素都不会变**（用户反复报的
    //   "光标进去时文字向下动了"这一条，就是靠"不参与布局的输入框 + 继续占位的标题"
    //   从结构上排除掉的 —— 而不是靠对齐属性去凑，那条路已经试过、没用）
    title.setCssStyles({ visibility: 'hidden' });
    title.after(editor.element);
    // ★ 输入框**绝对定位盖在那块位置上**、尺寸照抄（宽度另给一个下限）：它不参与布局，
    //   于是"进出编辑态这一行动不动"不再取决于 `<input>` 的基线 / 主题给的 `min-height`
    //   那些我们管不到的量（样式表里有这一段的两条弯路记录）
    // ★ 万一量到 0 高（面板此刻不可见 / 字体还没落位）就兜一个行高：一个 0 高的输入框
    //   等于"文字完全看不见"，比"位置差两个像素"糟得多
    const titleHeight = titleBox.height > 0 ? titleBox.height : 24;
    editor.element.style.left = `${titleBox.left - rowBox.left}px`;
    editor.element.style.top = `${titleBox.top - rowBox.top}px`;
    editor.element.style.width = `${Math.max(titleBox.width, OUTLINE_TITLE_EDIT_MIN_WIDTH)}px`;
    editor.element.style.height = `${titleHeight}px`;
    this.editing = { nodeId, editor, titleEl: title };

    editor.input.addEventListener('keydown', (event: KeyboardEvent) => {
      // 输入框里的键位不再往下传（与画布那条同一条：`Enter` 不该去加节点）
      event.stopPropagation();
      // ★★ 大纲特有的那几档（`N3-i`：`⏎` 拆行 / `Tab` 缩进 / `⇧Tab` 提升 / `⌥⏎` 新建子节点）
      //   **必须排在下面之前**：`titleEditKeyOf` 把 `⏎` 当成"提交"，先走一步就把编辑器关了，
      //   这里再也接不到（画布那条路要保持"提交即结束"，所以只能在**大纲这条监听器**里接）
      if (this.handleOutlineEditKey(event)) return;

      const verdict = titleEditKeyOf(event);
      if (verdict === 'commit') {
        event.preventDefault();
        this.commitTitleEdit();
        // ★ `⌘⏎`（提交）之后把焦点交回**面板**（`N3-j`）：输入框被移除 ⇒ 焦点掉回 `<body>`
        //   ⇒ 接下来的 `⏎` / `Tab` / 方向键一个都收不到（大纲的键位挂在面板上）
        this.refocusView();
      } else if (verdict === 'cancel') {
        event.preventDefault();
        this.cancelTitleEdit();
        this.refocusView();
      }
    });
    editor.input.addEventListener('blur', () => this.commitTitleEdit());
    editor.input.addEventListener('mousedown', (event: MouseEvent) => event.stopPropagation());
    // ★★ **剪贴板认亲**（用户 2026-09-17："我复制一堆节点然后黏贴，就会把文本黏贴到节点标题上，
    //   而不是把节点贴到节点下。黏贴的时候有办法判定是黏贴过来的节点还是文字吗？"）。
    //   复制节点时我们往系统剪贴板同时写了 `text/plain`（人读的文字）与 `text/html`（带自家标记）
    //   ⇒ 这里问一句剪贴板"这是不是我们自己那一簇"：
    //     · 是 ⇒ 抢下这一下，贴成**这一行的子节点**（先把这一行提交掉，与"失焦即提交"同一口径）；
    //     · 不是 ⇒ 原样放行，普通文字粘贴仍归浏览器 / 输入框。
    //   ★ 用**格式**判定而不是"当前在不在编辑"，才是幕布 / 飞书那套 —— 猜"用户想粘什么"永远猜不准。
    editor.input.addEventListener('paste', (event: ClipboardEvent) => {
      const payload = parseMindClipboardHtml(event.clipboardData?.getData('text/html') ?? '');
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      const nodeId = this.editing?.nodeId ?? null;
      if (nodeId === null) return;
      this.commitTitleEdit();
      this.pastePayload(payload, nodeId);
    });
    // ★★ 聚焦两键（`N3-e`）**即使正开着这一行的编辑器也要能按**（真实报障：
    //   "面包屑没出现" —— 在大纲里**点一行文字就进编辑态**，而编辑态的键位被上面那个
    //   监听器截住 ⇒ `⌘]` 被吞掉，聚焦压根没发生）。
    //   ★ 单开一个监听器，而不是塞进上面那个：`stopPropagation` 只挡冒泡、
    //     **不挡同一个元素上的其它监听器** ⇒ 这个照样会跑到，也不必去动那段很绕的分支。
    //   ★ 先**提交**这一行再进 / 退（与"失焦即提交"同一个口径：按 `⌘]` 时心里那行字是
    //     "就这些了，进去看"）。
    editor.input.addEventListener('keydown', (event: KeyboardEvent) => {
      const isFocusKey =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === ']' || event.key === '[');
      if (!isFocusKey) return;

      event.preventDefault();
      const target = this.editing?.nodeId ?? null;
      this.commitTitleEdit();
      if (event.key === ']') this.setFocus(target);
      else this.focusOutLevel();
    });

    editor.input.focus();
    // ★ 落点两档（用户 2026-09-17 追加的第 2 条之后，**没有"全选"这一档了**）：
    //   ① **点进来的**（给了 `caretX`）⇒ 光标落在**他点的那个字之间**（像在大文本块里戳一下）；
    //   ② 其余（直接打字 / `F2` / 双击 / 方向键）⇒ 落在**末尾**。
    //   ★ 从前 ② 里的"`F2` / 双击"那份是全选 —— 用户明确不要："出现了淡紫色的选中效果，
    //     完全不需要这个选中效果"（全选的落点就是浏览器/主题的选区高亮，一进来就是一片紫）。
    if (caretIndex !== undefined) {
      // ★ 拆行 / 缩进之后**接着编辑**：落点由调用方指定 ——
      //   用户规格原话："光标会在这个后半截文字节点的最前方并且是一种可编辑状态"
      const at = Math.max(0, Math.min(editor.input.value.length, caretIndex));
      editor.input.setSelectionRange(at, at);
    } else if (caretX !== undefined) {
      const index = this.caretIndexFromX(editor.input, caretX);
      editor.input.setSelectionRange(index, index);
    } else {
      const end = editor.input.value.length;
      editor.input.setSelectionRange(end, end);
    }
    row.scrollIntoView({ block: 'nearest' });
  }

  /**
   * 点在哪 → 光标落在哪个字之间（用户第⑤条："感觉就是在一个大文本块里点了一下文字中间，
   * 切换了光标而已"）。
   *
   * ★ 为什么不能直接用浏览器给的落点：这一行平时是 `<span>`，点它那一下是**行**收到的；
   *   等我们把 `<input>` 建出来、交进焦点时那一下已经过去了 —— 只能自己算。
   * ★ 用 `canvas.measureText` 逐字量"前 n 个字有多宽"（字体取输入框自己的），
   *   取最接近点击处的那一个边界。标题都很短，逐字量一遍的开销可以忽略。
   * ★ 算不出来时兜底是**末尾**（与本功能原来的行为一致），不会更糟。
   */
  private caretIndexFromX(input: HTMLInputElement, clientX: number): number {
    const text = input.value;
    if (text.length === 0) return 0;

    const style = input.ownerDocument.defaultView?.getComputedStyle(input);
    const ctx = input.ownerDocument.createElement('canvas').getContext('2d');
    if (!style || !ctx) return text.length;

    const rect = input.getBoundingClientRect();
    const inner = clientX - rect.left - (Number.parseFloat(style.paddingLeft) || 0);
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

    let best = text.length;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let index = 0; index <= text.length; index += 1) {
      const delta = Math.abs(ctx.measureText(text.slice(0, index)).width - inner);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = index;
      }
    }
    return best;
  }

  /**
   * 就地改**正文**（`N3-b`；幕布管它叫"描述区"，`⇧Enter` 进出）。
   *
   * ★ 大纲里用**纯 `textarea`**，不复用画布那套 Markdown 编辑器：大纲这一半的性格是
   *   "快写结构"，而带排版的 Markdown 在行里会把行高撑得七零八落。两点说明：
   *   ① 写进去的是**同一个 `node.note`**（回画布就能看到排版）；
   *   ② 想要排版就去画布那边改 —— 这里刻意只提供纯文本。
   * ★ 提交：`⇧Enter` / `⌘⏎` / 失焦；`Esc` 放弃（与改标题同一套手感）。
   */
  private beginOutlineNoteEdit(nodeId: string): void {
    const mind = this.mind;
    const panel = this.outlinePanel;
    // ★ 这里用 `mindWritable` 而不是 `writable`：从一行**点进另一行**（或改标题改到一半
    //   去改正文）时，旧编辑器还开着 ⇒ `writable` 恒为 false ⇒ 点击静默没反应。
    //   下面紧接着就会把旧编辑器收掉，所以"编辑器开着"不构成拒绝打开的理由
    if (!mind || !panel || !this.mindWritable) return;
    const node = nodeById(mind, nodeId);
    if (!node) return;

    this.cancelTitleEdit();
    this.cancelOutlineNoteEdit();
    if (panel.rowOf(nodeId) === null) this.renderOutline();
    const row = panel.rowOf(nodeId);
    if (!row) return;

    const area = this.contentEl.ownerDocument.createElement('textarea');
    area.className = 'nestboard-mind-outline-note-edit';
    area.value = node.note;
    area.rows = 3;
    area.setAttribute('aria-label', t('mind.outline.noteLabel'));
    area.addEventListener('keydown', (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.isComposing === true || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelOutlineNoteEdit();
        return;
      }
      // `⇧Enter`（幕布）与 `⌘⏎`（本仓库的既有键）都提交
      if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.commitOutlineNoteEdit();
      }
    });
    area.addEventListener('blur', () => this.commitOutlineNoteEdit());
    area.addEventListener('mousedown', (event: MouseEvent) => event.stopPropagation());

    // ★ 挂在**标题那一列**下面（不是整行上）：文本域的左边界因此与标题对齐，
    //   跟着缩进走 —— 挂整行上的话它会顶到最左边，看着不属于这一行
    const main = row.querySelector<HTMLElement>(`.${OUTLINE_MAIN_CLASS}`) ?? row;
    main.appendChild(area);
    this.outlineNote = { nodeId, area };
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  private commitOutlineNoteEdit(): void {
    const state = this.outlineNote;
    if (!state) return;
    const value = state.area.value;
    // 与标题那条同一顺序：先收状态再写模型（摘 DOM 会触发 `blur`，不先清就会递归）
    this.cancelOutlineNoteEdit();
    this.edit(t('history.mindNote'), (mind) => setNote(mind, state.nodeId, value));
  }

  private cancelOutlineNoteEdit(): void {
    const state = this.outlineNote;
    if (!state) return;
    this.outlineNote = null;
    state.area.remove();
  }

  // ── 关联线的选中 / 标签 / 箭头 / 删除（`N1-c`）─────────────

  /**
   * 指针底下那条关联线（`null` = 没点在线上）。
   *
   * ★ 容差按**屏幕像素**给（÷ 缩放）：屏幕上 8px 的余量，画布放大到 200% 之后
   *   世界里只剩 4px —— 写死世界坐标的话，放大之后就得"精确压在线上"才点得中。
   * ★ 判据在 `layout/links.ts`（纯函数、能单测）：把曲线采样成折线逐段量距离。
   */
  private linkAt(event: { clientX: number; clientY: number }): string | null {
    const boxes = this.layout?.boxes;
    const mind = this.mind;
    const links = mind?.links ?? [];
    if (!boxes || links.length === 0) return null;
    const world = this.worldPointOf(event);
    return linkHitTest(links, boxes, world, LINK_HIT_TOLERANCE_PX / this.viewport.zoom);
  }

  /**
   * 选中一条关联线。
   *
   * ★ 节点选区**清空**（两样都留着，"`Delete` 删什么"就要靠猜 —— 与白板
   *   "线 / 卡互斥"同一条）；
   * ★ 栏跟着收起：`syncSelection` 里没有节点被选中 ⇒ `node` 给 `null`。
   */
  private selectLink(id: string): void {
    this.selectedId = null;
    this.selectedIds = new Set();
    this.selectedLinkId = id;
    this.syncSelection();
    this.refreshLinks();
  }

  /** 只重画关联线那一层（选中态变了 / 改完标签；几何与节点都没动，不必重排） */
  private refreshLinks(): void {
    if (this.layout) this.paintLinks(this.layout);
  }

  // ── 关联线的**弯折手柄**（`N1-d`，用户 2026-09-17）──────────────────

  /** 这一次指针落点是不是那个弯折手柄 */
  private hitsLinkHandle(target: EventTarget | null): boolean {
    const el = target as Element | null;
    return el?.closest?.(`.${MIND_LINK_HANDLE_CLASS}`) !== null && el !== null;
  }

  /**
   * 按住弯折手柄开始拖（`N1-d`）。
   *
   * ★ 拖动期间模型**一个字节都不动**：预览值只存在 `linkBendDrag` 里，`paintLinks`
   *   用它当这条线的弯折（线 / 箭头 / 标签 / 手柄一起跟手），松手才写一次
   *   ⇒ 一次拖动 = 一步 `⌘Z`（与拖拽改父子、拉角改宽度同一条）。
   * ★ 记下**不弯时的中点**：弯折的定义就是"指针 − 它"。拖动期间节点不会挪，存下来够用。
   */
  private beginLinkBendDrag(event: PointerEvent): void {
    const link = this.selectedLink;
    const layout = this.layout;
    if (!link || !layout || !this.mindWritable) return;
    const from = layout.boxes.get(link.from);
    const to = layout.boxes.get(link.to);
    if (!from || !to) return;

    this.linkBendDrag = {
      linkId: link.id,
      pointerId: event.pointerId,
      bend: link.bend ?? null,
      mid: linkMidpointOf(from, to),
    };
    this.capturePointer(event.pointerId);
  }

  /** 拖动中：指针位置 → 弯折值（夹进合法范围），然后只重画关联线那一层 */
  private updateLinkBendDrag(drag: LinkBendDragState, event: PointerEvent): void {
    const point = this.worldPointOf(event);
    drag.bend = normalizeLinkBend({ x: point.x - drag.mid.x, y: point.y - drag.mid.y });
    // 只重画关联线：布局 / 节点几何都没变（拖动期间也不该变）
    this.refreshLinks();
  }

  /** 松手：写**一次**模型（一步撤销）；"拉回原处"由 `setLinkBend` 归一成删键 ⇒ 不占历史 */
  private finishLinkBendDrag(): void {
    const drag = this.linkBendDrag;
    if (!drag) return;
    this.linkBendDrag = null;
    this.releasePointer(drag.pointerId);

    // 线可能已经被删了（别处改了这份文件）：那就只收干净预览
    const alive = (this.mind?.links ?? []).some((link) => link.id === drag.linkId);
    if (alive) {
      this.edit(t('history.mindLinkBend'), (mind) => setLinkBend(mind, drag.linkId, drag.bend));
    }
    // 预览值已经清掉 ⇒ 重画一次（画的是模型里的值）
    this.refreshLinks();
  }

  /** `Esc`：放弃这一拖（模型本来就一个字节都没动过 ⇒ 收掉预览就回到原样） */
  private cancelLinkBendDrag(): void {
    const drag = this.linkBendDrag;
    if (!drag) return;
    this.linkBendDrag = null;
    this.releasePointer(drag.pointerId);
    this.refreshLinks();
  }

  /**
   * 改一条线的**颜色**（`N1-e`）：`null` = 回到默认那条灰线（删键，纪律 2）。
   *
   * ★ 写完只重画**关联线那一层**（`refreshLinks`）：几何一个字节都没变，不必重排。
   */
  private setLinkColor(id: string, color: ThemeColor | null): void {
    this.edit(t('history.mindLinkColor'), (mind) => setLinkColor(mind, id, color));
    this.refreshLinks();
  }

  /** 把线**拉直**（行菜单那一项）：删掉弯折键（纪律 2：缺席 = 不弯） */
  private straightenLink(id: string): void {
    this.edit(t('history.mindLinkBend'), (mind) => setLinkBend(mind, id, null));
    this.refreshLinks();
  }

  /** `Delete`：删掉选中的那条线（一次 `edit` ⇒ 一步 `⌘Z`） */
  private removeSelectedLink(): void {
    const id = this.selectedLinkId;
    if (id === null) return;
    this.cancelLinkLabelEdit();
    this.selectedLinkId = null;
    this.edit(t('history.mindLinkRemove'), (mind) => removeLink(mind, id));
    this.refreshLinks();
  }

  /**
   * 一条关联线的右键菜单（`N1-c`）：改标签 / 箭头（三档直选）/ 删除。
   *
   * ★ 箭头给**三档直选**（当前那档打勾）而不是"点一下循环"：三档全摆出来，
   *   用户一眼看到"还能变成什么"，不必点两下试出来。
   * ★ 用 `Menu` 而不是自建浮层：节点菜单、白板的卡片菜单都是它 ——
   *   定位、主题、键盘可达性都不必自己再想一遍。
   */
  private showLinkMenu(event: MouseEvent, linkId: string): void {
    const mind = this.mind;
    const link = (mind?.links ?? []).find((item) => item.id === linkId);
    if (!link) return;

    const current = link.arrow ?? 'none';
    const arrowOptions = [
      ['none', 'menu.mindLink.arrow.none'],
      ['end', 'menu.mindLink.arrow.end'],
      ['both', 'menu.mindLink.arrow.both'],
    ] as const;

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindLink.editLabel'))
        .setIcon('pencil')
        .setDisabled(!this.mindWritable)
        .onClick(() => this.beginLinkLabelEdit(linkId)),
    );
    // 线条颜色（`N1-e`，用户 2026-09-17："脑图的连接线应该也要支持改颜色"）：
    // 主题色六个 + 「默认」—— 与**分支线**同一套词汇（换主题时线也跟着走）。
    // ★ 颜色那一档与箭头 / 线型同一套手感：直选 + 当前那项打勾。
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindLink.colorDefault'))
        .setIcon('palette')
        .setChecked(link.color === undefined)
        .setDisabled(!this.mindWritable)
        .onClick(() => this.setLinkColor(linkId, null)),
    );
    for (const color of THEME_COLOR_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(colorLabel(color))
          .setChecked(link.color === color)
          .setDisabled(!this.mindWritable)
          .onClick(() => this.setLinkColor(linkId, color)),
      );
    }

    // 弯折（`N1-d`）：**只在这条线确实弯着**的时候给这一项 ——
    // "拉直"这个动作只有在弯着的时候才有意义（与"行菜单只放这里真能做的"同一条）
    if (link.bend) {
      menu.addItem((item) =>
        item
          .setTitle(t('menu.mindLink.straighten'))
          .setIcon('minus')
          .setDisabled(!this.mindWritable)
          .onClick(() => this.straightenLink(linkId)),
      );
    }
    for (const [state, key] of arrowOptions) {
      menu.addItem((item) =>
        item
          .setTitle(t(key))
          .setChecked(current === state)
          .setDisabled(!this.mindWritable)
          .onClick(() => this.applyLinkArrow(linkId, state === 'none' ? null : state)),
      );
    }

    // 线型（用户 2026-09-16：关联线**默认虚线**，可以自己改成实线）——
    // 与箭头同一套手感：两档都摆出来、当前那档打勾
    menu.addSeparator();
    for (const [solid, key] of [
      [false, 'menu.mindLink.dashed'],
      [true, 'menu.mindLink.solid'],
    ] as const) {
      menu.addItem((item) =>
        item
          .setTitle(t(key))
          .setChecked((link.solid === true) === solid)
          .setDisabled(!this.mindWritable)
          .onClick(() => this.applyLinkSolid(linkId, solid)),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindLink.remove'))
        .setIcon('trash')
        .setDisabled(!this.mindWritable)
        .onClick(() => this.removeSelectedLink()),
    );
    menu.showAtMouseEvent(event);
  }

  /** 写箭头（三档直选；`null` = 没有箭头）。值没变时 `edit` 不记历史也不重画 */
  private applyLinkArrow(linkId: string, arrow: 'end' | 'both' | null): void {
    if (this.edit(t('history.mindLinkArrow'), (mind) => setLinkArrow(mind, linkId, arrow))) {
      this.refreshLinks();
    }
  }

  /** 写线型（`false` = 回到默认的**虚线** ⇒ 删键，纪律 2） */
  private applyLinkSolid(linkId: string, solid: boolean): void {
    if (this.edit(t('history.mindLinkSolid'), (mind) => setLinkSolid(mind, linkId, solid))) {
      this.refreshLinks();
    }
  }

  /**
   * 就地改**关联线标签**（`N1-c`）。
   *
   * ★ 输入框挂在**世界容器**里、摆在线中点：标签本来就画在那儿，浮层贴在别处
   *   会变成"在角落里改着一条中间的线"。
   * ★ 与改标题共用 `buildTitleEditor`（"组字中的 `Enter` 不算提交"那条也在里面）。
   */
  private beginLinkLabelEdit(linkId: string): void {
    const mind = this.mind;
    const world = this.worldEl;
    const boxes = this.layout?.boxes;
    if (!mind || !world || !boxes || !this.writable) return;

    const link = (mind.links ?? []).find((item) => item.id === linkId);
    const from = link ? boxes.get(link.from) : undefined;
    const to = link ? boxes.get(link.to) : undefined;
    if (!link || !from || !to) return;

    this.cancelTitleEdit();
    this.cancelLinkLabelEdit();

    const editor = buildTitleEditor(
      this.contentEl.ownerDocument,
      link.label ?? '',
      t('mind.linkLabel.label'),
    );
    const mid = linkMidpointOf(from, to);
    editor.element.classList.add(LINK_LABEL_EDIT_CLASS);
    editor.element.style.left = `${roundTo(mid.x)}px`;
    editor.element.style.top = `${roundTo(mid.y)}px`;
    world.appendChild(editor.element);
    this.linkEdit = { linkId, editor };

    editor.input.addEventListener('keydown', (event: KeyboardEvent) => {
      // 输入框里的键位不再往下传（与改标题同一条：`Enter` 不该去加兄弟节点）
      event.stopPropagation();
      const verdict = titleEditKeyOf(event);
      if (verdict === 'commit') {
        event.preventDefault();
        this.commitLinkLabelEdit();
      } else if (verdict === 'cancel') {
        event.preventDefault();
        this.cancelLinkLabelEdit();
      }
    });
    // ★ 打字时把内容**同步给影子**（`sync`）：输入框的宽度是靠影子那段文字撑出来的
    //   （见 `buildTitleEditor` 顶上那段"为什么不是铺满的 input"）。不同步的话，
    //   输入框永远停在打开那一刻的宽度上 —— 用户报的就是"写着写着它不跟着长"。
    //   ★ 这里**不** `scheduleRelayout`：标签画在 SVG 里（节点几何与它无关），
    //   改标题那边要重排是因为节点宽度由标题撑出来
    editor.input.addEventListener('input', () => editor.sync());
    // 失焦 = 改完（点了别处那一下也算）—— 与改标题同一个口径
    editor.input.addEventListener('blur', () => this.commitLinkLabelEdit());
    editor.input.focus();
    editor.input.select();
  }

  /** 提交标签（空串 = 摘掉标签，`setLinkLabel` 里删键 —— 纪律 2） */
  private commitLinkLabelEdit(): void {
    const state = this.linkEdit;
    if (!state) return;
    const value = state.editor.input.value;
    // ★ 先收状态再写模型：`cancelLinkLabelEdit` 会把输入框从 DOM 上摘下来，
    //   那一下会触发 `blur` —— 不先清 `linkEdit` 就会递归回来（栈里刷满自己）
    this.cancelLinkLabelEdit();
    if (this.edit(t('history.mindLinkLabel'), (mind) => setLinkLabel(mind, state.linkId, value))) {
      this.refreshLinks();
    }
  }

  /** 放弃改标签（`Esc` / 换文件 / 拆视图）：把输入框摘掉，模型一个字节都没动 */
  private cancelLinkLabelEdit(): void {
    const state = this.linkEdit;
    if (!state) return;
    this.linkEdit = null;
    state.editor.element.remove();
  }

  // ── 行菜单：点行首圆点出来的那一排（用户 2026-09-17 的规格：圆点 = 节点把手）─────

  /**
   * 点**行首圆点**弹出来的行菜单（照飞书：单击行首圆点打开节点工具栏）。
   *
   * ★ 与"点文字 = 进编辑"分工：**文字是内容、圆点是结构** ——
   *   于是点圆点不会打断正在输入的那一行。
   * ★ 只放**这里真能做的**：描述走正文编辑、删除给两种（留子节点 / 连整支一起），
   *   有子节点的才给折叠那一项。
   */
  private showOutlineRowMenu(id: string, event: MouseEvent): void {
    const mind = this.mind;
    const node = mind ? nodeById(mind, id) : null;
    if (!mind || !node) return;

    const canDelete = this.writable && node.parentId !== null;

    const menu = new Menu();
    // 聚焦（`N3-e`）：这两项是**看**的动作 —— 与"定位到中心节点"同一类，
    // 只读时照旧可用（`this.writable` 不参与这两条）
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindFocusIn'))
        .setIcon('zoom-in')
        .onClick(() => this.setFocus(id)),
    );
    // 完成 / 取消完成（`N3-g`）：跟着**当前状态**换文案与图标（写的那一步要能撤销）
    menu.addItem((item) =>
      item
        .setTitle(t(node.done === true ? 'menu.mindUndone' : 'menu.mindDone'))
        .setIcon(node.done === true ? 'undo-2' : 'check')
        .setDisabled(!this.mindWritable)
        .onClick(() => this.toggleDone(id)),
    );
    if (this.focusId !== null) {
      menu.addItem((item) =>
        item
          .setTitle(t('menu.mindFocusOut'))
          .setIcon('zoom-out')
          .onClick(() => this.focusOutLevel()),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindEditNote'))
        .setIcon('pencil')
        .setDisabled(!this.mindWritable)
        .onClick(() => this.beginOutlineNoteEdit(id)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindRemoveKeepChildren'))
        .setIcon('trash-2')
        .setDisabled(!canDelete)
        .onClick(() => this.removeRowKeepChildren(id)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindDelete'))
        .setIcon('trash')
        .setDisabled(!canDelete)
        .onClick(() => {
          this.selectNode(id);
          this.deleteSelection();
        }),
    );
    if (hasChildren(mind, id)) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(t(node.collapsed === true ? 'menu.mindExpand' : 'menu.mindCollapse'))
          .setIcon('chevrons-down-up')
          .setDisabled(!this.mindWritable)
          .onClick(() => this.toggleCollapseOf(id)),
      );
    }
    menu.showAtMouseEvent(event);
  }

  /** 删这一行、**留下它的子节点**（提到它原来的位置） */
  private removeRowKeepChildren(id: string): void {
    this.edit(t('history.mindDelete'), (mind) => removeNodeKeepChildren(mind, id));
  }

  // ── 画布菜单：折叠所有 / 定位到中心（用户 2026-09-17 参考飞书补的）─────

  /**
   * 空白处的右键菜单：整张图上的那几件事（照飞书：**折叠所有** / **定位到中心**）。
   *
   * ★ 这里**要** `preventDefault`：不挡浏览器会弹自己的菜单 —— 用户在这个画布上右键，
   *   要的是脑图的菜单（与节点菜单同一条）。
   * ★ 只读时：**定位**照旧可用（那是"看"），折叠不可用（那是"改"，要写盘）。
   * ★ 飞书把这两件事放在**空白右键**里是有道理的：它们的宾语是"整张图"，
   *   不是某一张卡 —— 挂在节点菜单里会让人以为"只折叠这一支"。
   */
  private showCanvasMenu(event: MouseEvent): void {
    event.preventDefault();
    this.canvasEl?.focus();

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindCollapseAll'))
        .setIcon('chevrons-down-up')
        .setDisabled(!this.mindWritable)
        .onClick(() => this.setAllCollapsed(true)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindExpandAll'))
        .setIcon('chevrons-up-down')
        .setDisabled(!this.mindWritable)
        .onClick(() => this.setAllCollapsed(false)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t('menu.mindCenterRoot'))
        .setIcon('crosshair')
        .onClick(() => this.centerOnRoot()),
    );
    menu.showAtMouseEvent(event);
  }

  /**
   * 折叠 / 展开**所有**节点（飞书那次「折叠所有节点」的口径：折完**只留中心与第一层**）。
   *
   * ★ 一次 `edit` ⇒ 一步 `⌘Z`：逐个节点各提交一次的话，撤回去要按 N 下。
   */
  private setAllCollapsed(collapsed: boolean): void {
    this.edit(t(collapsed ? 'history.mindCollapseAll' : 'history.mindExpandAll'), (mind) =>
      setCollapsedFromDepth(mind, 1, collapsed),
    );
  }

  /** 把**中心主题**摆回屏幕中央（飞书左下角那条"定位到中心节点"） */
  private centerOnRoot(): void {
    const mind = this.mind;
    const box = mind ? this.layout?.boxes.get(mind.rootId) : undefined;
    if (!box) return;
    this.viewport.centerOn(rectCenter(box));
    this.applyCamera();
  }

  /**
   * 进入**连线态**：从当前选中的那个节点拉一条跟手的虚线出去。
   *
   * ★ 这是一次"点击 → 移动 → 再点击"的手势（用户原话：点「连线」→ 线跟着鼠标走 →
   *   左键落线），**不是按住拖**：起点在**工具栏**上，那里的 `pointerdown` 会被
   *   `isOverlayTarget` 整条让开（见那一处）—— 所以这一态里没有指针捕获。
   * ★ **必须把焦点抢回画布**：`Esc` 是绑在**画布**上的（`canvas.addEventListener('keydown')`），
   *   刚点完工具栏按钮时焦点还在那个按钮上 —— 不抢的话"Esc 放弃"按下去毫无反应。
   * ★ 一个字节都不写模型：这一态里全是预览。
   */
  private beginLink(): void {
    const from = this.selectedId;
    const mind = this.mind;
    if (!this.writable || !mind || from === null) return;
    if (this.selectedIds.size !== 1) return; // 单选才有那一格（这里再兜一道底）

    this.toolbar?.closePopovers();
    this.endLink();
    const box = this.layout?.boxes.get(from) ?? null;
    this.linking = {
      from,
      // 起点先落在自己身上：第一次 move 来之前，虚线是"贴着节点的一小段"，
      // 比"从画布原点射出来"像话
      current: box ? rectCenter(box) : { x: 0, y: 0 },
      target: null,
    };
    this.canvasEl?.classList.add('is-linking');
    this.canvasEl?.focus();
    this.guideLayer?.set(box ? { ring: box } : null);
    this.paintLinkPreviewNow();
  }

  /**
   * 指针动了：更新线头与吸附（`N1-b`）。
   *
   * ★ 吸附用**几何**（`layout.boxes` + `rectContainsPoint`）而不是 DOM 命中：
   *   预览线画在**世界坐标**里，判据必须是同一套坐标系 —— 两套混用会在缩放 / 平移
   *   之后开始"明明指着它却吸不上"。
   * ★ 取**最深**的那个框：压在别的节点上的那个才是用户觉得"我指着它"的那个。
   */
  private updateLink(state: LinkingState, event: PointerEvent): void {
    const world = this.worldPointOf(event);
    state.current = world;

    let hitId: string | null = null;
    let hitBox: Rect | null = null;
    let hitDepth = -1;
    for (const box of this.layout?.boxes.values() ?? []) {
      if (box.id === state.from) continue; // 自连不吸附（与 `addLink` / `validate` 同一口径）
      if (!rectContainsPoint(box, world)) continue;
      if (box.depth <= hitDepth) continue;
      hitDepth = box.depth;
      hitId = box.id;
      hitBox = box;
    }
    state.target = hitId;

    // 吸附反馈复用**拖拽落点**那个环：那是"松手就挂到这里"的既有语言，一眼认得
    this.guideLayer?.set(hitBox ? { ring: hitBox } : null);
    this.paintLinkPreviewNow();
  }

  /** 画"正在拉的那条线"（不在连线态 / 拿不到起点框就把它收掉） */
  private paintLinkPreviewNow(): void {
    const layer = this.linkPreviewEl;
    if (!layer) return;

    const state = this.linking;
    const from = state ? (this.layout?.boxes.get(state.from) ?? null) : null;
    if (!state || !from) {
      paintLinkPreview(layer, null, null);
      return;
    }

    // 吸上了 → 用目标那个框（与落笔之后**完全一致**的几何）；没吸上 → 一个**退化的框**
    // （零尺寸、落在指针上）：`linkPathOf` 眼里它就只是一个点 ⇒ "跟手"不用另写一套几何
    const to = state.target
      ? (this.layout?.boxes.get(state.target) ?? null)
      : { x: state.current.x, y: state.current.y, width: 0, height: 0 };
    paintLinkPreview(layer, from, to);
  }

  /**
   * 落线：把这条关联写进模型（一次 `edit` ⇒ 一步 `⌘Z`）。
   *
   * ★ 没吸到目标就**什么都不做**（留在连线态里等下一次点击）：连到"空白处"是刻意不做的
   *   （`09 §1.7`），此时把线丢掉比"连到空气上"更符合预期。
   */
  private commitLink(): void {
    const state = this.linking;
    const to = state?.target ?? null;
    if (!state || !to) return;

    const from = state.from;
    this.endLink();
    // `addLink` 给 `null`（自连 / 端点不在）时 `edit` 不会记历史，也不会重画
    let created: string | null = null;
    this.edit(t('history.mindLink'), (mind) => {
      created = addLink(mind, from, to);
      return created !== null;
    });
    // ★ 新落的线**顺手选中**它（`09 §1.4` 第 4 步）：接着就能 `⏎` 改标签、双击改标签、
    //   `Delete` 删掉 —— 刚画完一条线，用户下一件事十有八九就是给它写个名字
    if (created !== null) this.selectLink(created);
  }

  /** 放弃这次连线（`Esc` / 右键 / 再点一下那一格）：模型从来没动过，收干净就走 */
  private cancelLink(): void {
    this.endLink();
  }

  /** 退出连线态（落线与放弃都走它）：预览与吸附环一起收干净 */
  private endLink(): void {
    if (!this.linking) return;
    this.linking = null;
    this.canvasEl?.classList.remove('is-linking');
    this.guideLayer?.set(null);
    this.paintLinkPreviewNow();
  }

  /** 挂载的节点不多（视口内那几十个），逐个 toggle 类名最省事也最不容易漏 */
  private syncSelection(): void {
    for (const [id, el] of this.mounted) {
      el.classList.toggle(SELECTED_CLASS, this.selectedIds.has(id));
    }
    this.syncToolbar();
    // 大纲里也有一份"选中高亮"（`N3-a`）：它不在 `mounted` 那张表里，得单独刷一遍
    if (this.outlineMode) this.renderOutline();
  }

  /**
   * 把"当前选中的那个节点"回灌给快捷操作栏（`08 §3`）。
   *
   * ★ **多选时给 `null`**（整条收起）：多选能做的事与单节点差别太大，
   *   把两套按钮挤在一条栏里只会让人点错（`08 §3` 的口径）。
   * ★ 加粗给的是**生效值**（用户设过就听用户的，否则按层级）—— 于是"点一下"的语义
   *   永远是"把它变成另一个样子"，而不是"写一个与眼前相反的键"。
   */
  private syncToolbar(): void {
    const node = this.singleSelectedNode();
    if (node) {
      this.toolbar?.setState({
        writable: this.writable,
        node: {
          id: node.id,
          icon: node.icon ?? '',
          bold: node.style?.bold ?? titleBoldOf(this.depthOfNode(node)),
          italic: node.style?.italic === true,
          underline: node.style?.underline === true,
          color: node.style?.color ?? null,
          ink: node.style?.ink ?? null,
          highlight: node.style?.highlight ?? null,
        },
      });
      return;
    }

    // ★ **多选**（`N2`，用户 2026-09-16）：换成缩减版的按钮集（见 `MULTI_NODE_FEATURES`），
    //   值取"**全一致才算**"（`commonTitleStyle`）—— 混合态那一格不亮。
    //   `id` 给空串：栏内部靠它判断"换人了就收弹层"，空串与任何真实 id 都不同 ⇒ 会收一下 ✓。
    const nodes = this.selectedNodes();
    const common =
      nodes.length > 1
        ? commonTitleStyle(
            nodes.map((item) => ({ style: item.style, depth: this.depthOfNode(item) })),
          )
        : null;
    this.toolbar?.setState({
      writable: this.writable,
      features: MULTI_NODE_FEATURES,
      node: common ? { id: '', icon: '', ...common } : null,
    });
  }

  /** 选区里的节点（按文件顺序取 —— 稳定、可预测；`selectedIds` 是 Set，顺序不该外泄） */
  private selectedNodes(): MindNode[] {
    const mind = this.mind;
    if (!mind) return [];
    return mind.nodes.filter((node) => this.selectedIds.has(node.id));
  }

  /** 样式类操作的目标：单选时是它自己、多选时是**整簇**（`N2`） */
  private styleTargets(): string[] {
    return this.selectedNodes().map((node) => node.id);
  }

  /** 恰好选中一个节点时的那个节点（多选 / 没选 = `null`） */
  private singleSelectedNode(): MindNode | null {
    const mind = this.mind;
    const id = this.selectedId;
    if (!mind || !id || this.selectedIds.size !== 1) return null;
    return nodeById(mind, id);
  }

  // ── 快捷操作栏那几项（`08 §3`）────────────────────────────

  /** 标记 / 字色 / 底色：一个入口（`ops.setNodeStyles` / `ops.setIcon` 各自管删键纪律） */
  private applyNodeStyle(patch: {
    icon?: string;
    color?: CardColor | null;
    ink?: HexColor | null;
    /** 文字高亮（`N3-f`）；`null` = 去掉高亮 */
    highlight?: HexColor | null;
  }): void {
    const ids = this.styleTargets();
    if (ids.length === 0 || !this.writable) return;

    // 标记只对**单个**节点有意义（一个节点一个标记）⇒ 多选时栏里压根不画这一格
    if (patch.icon !== undefined) {
      const icon = patch.icon;
      const id = ids[0] ?? '';
      this.edit(t('history.mindMark'), (mind) => setIcon(mind, id, icon));
      return;
    }
    const label =
      patch.highlight !== undefined
        ? t('history.mindHighlight')
        : patch.ink !== undefined
          ? t('history.mindInk')
          : t('history.mindColor');
    this.edit(label, (mind) =>
      setNodeStyles(mind, ids, {
        color: patch.color,
        ink: patch.ink,
        highlight: patch.highlight,
      }),
    );
  }

  /**
   * 加粗 / 斜体 / 下划线：**整条标题**的开关（`08 §3.2`）。
   *
   * ★ 判据是**当前生效值取反**（不是"把 `style.bold` 取反"）：中心主题默认就是加粗的，
   *   按"键取反"的话第一次点它反而会写一个 `true`，看起来像没反应。
   */
  private toggleTitleFlag(flag: 'bold' | 'italic' | 'underline'): void {
    const nodes = this.selectedNodes();
    const ids = nodes.map((node) => node.id);
    if (ids.length === 0 || !this.writable) return;

    // ★ 判据是"**整体现在是不是全亮**"（`N2`）：全亮 ⇒ 全关，否则 ⇒ **全开** ——
    //   混合态（有的加粗有的不）点一下是"都加粗"，而不是"各翻各的"（那会翻成一锅粥，
    //   与白板那条多选折叠同一条规矩）。
    const common = commonTitleStyle(
      nodes.map((node) => ({ style: node.style, depth: this.depthOfNode(node) })),
    );
    const next = common?.[flag] !== true;
    this.edit(t('history.mindFormat'), (mind) =>
      setNodeStyles(mind, ids, flag === 'bold' ? { bold: next } : { [flag]: next }),
    );
  }

  /**
   * 插入图片（`08 §3.4`）：走**同一个**落库管线（`plugin.importDroppedFile`），
   * 于是"插入的图"与"拖进来的图"结果一模一样。
   *
   * ★ 用隐藏的 `<input type="file">` 而不是 Obsidian 的文件选择弹窗：后者是"选一个**库内**
   *   文件"，而这一栏要的是"从我电脑上挑一张图" —— 那种图得先落库（附件目录、命名、去重
   *   都跟着用户在 Obsidian 里的设置走）。
   */
  private pickImageFor(nodeId: string): void {
    if (!this.writable) return;
    const input = this.contentEl.createEl('input', { cls: 'nestboard-mind-file-input' });
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      void this.plugin
        .importDroppedFile(file)
        .then((path) => {
          if (path) this.attachTo(nodeId, [path]);
        })
        .catch((error: unknown) => {
          console.warn('[nestboard] 插图失败', describeError(error));
          new Notice(t('notice.attachmentFailed', { error: describeError(error) }));
        });
    });
    // 挂在视图里再点开（挂在 `document.body` 上会被 Obsidian 的样式当成浮层）
    this.contentEl.appendChild(input);
    input.click();
  }

  /**
   * 选中某个节点并**立刻进编辑态**（菜单里的"新建子节点 / 同级"等收尾用）。
   *
   * ★★ 编辑器**必须按当前视图挑**：从前这里写死画布那个 `beginTitleEdit` ——
   *   在大纲里它落不到行上（画布那套是往节点卡片的标题带里插输入框），于是
   *   "在大纲里新建一个子节点"之后**光标不在新节点里** ⇒ 用户得先**点一下**它才能接着打字
   *   （真实报障："必须点一下这个创建的新节点，再回车，才能创建兄弟节点"）。
   */
  private selectAndEdit(id: string): void {
    this.selectNode(id);
    if (this.outlineMode) this.beginOutlineTitleEdit(id);
    else this.beginTitleEdit(id);
  }

  // ── 改标题（就地输入） ──────────────────────────────────

  /**
   * 就地改标题。
   *
   * ★ 输入框**插在标题带里**（把标题元素暂时藏起来），而不是另起一个浮层：
   *   脑图的节点大小是由内容撑出来的，浮层一出现就会看起来"和节点脱开"。
   * ★ 提交时机：`Enter` / 失焦（点了别处也算改完）；`Esc` 放弃。
   *   ★ **组字中的 `Enter` 不算提交**（`titleEditKeyOf`）：中文 / 日文用户选词那一下
   *     会被当成"改完了"，标题就会变成半截词。
   * ★ 标题为空**不删节点**：空标题是合法状态（`validate` 允许），只是卡面上少一行字。
   */
  private beginTitleEdit(nodeId: string): void {
    // ★ 大纲视图里"就地改标题"落在**行**上（见 `beginOutlineTitleEdit`）：
    //   画布此刻是 `display: none`，把输入框插进节点里用户根本看不见
    if (this.outlineMode) {
      this.beginOutlineTitleEdit(nodeId);
      return;
    }

    const mind = this.mind;
    if (!mind || !this.writable) return;
    const node = nodeById(mind, nodeId);
    const holder = this.mounted.get(nodeId);
    if (!node || !holder) return;

    this.cancelTitleEdit();
    const titleEl = holder.querySelector<HTMLElement>('.nestboard-mind-node-title');
    if (!titleEl) return;

    const editor = buildTitleEditor(holder.ownerDocument, node.text, t('mind.nodeTitle.label'));
    titleEl.setCssStyles({ display: 'none' });
    titleEl.after(editor.element);
    this.editing = { nodeId, editor, titleEl };

    editor.input.addEventListener('keydown', (event: KeyboardEvent) => {
      // ★ 输入框里的键位**不再往下传**：`Tab` / `Enter` 在编辑期间不该去加节点
      event.stopPropagation();
      const verdict = titleCommitActionOf(event);
      if (verdict === 'commit-and-next') {
        event.preventDefault();
        // ★★ **树视图里 `⏎` = 提交 + 新建同级 + 光标接到新节点**（`N3-j`，见那个方法的说明）。
        //   从前这里只提交 ⇒ 用户得再按一次，而**提交之后焦点已经丢了** ⇒ 那一次收不到。
        this.commitAndAddSibling();
      } else if (verdict === 'commit') {
        event.preventDefault();
        // `⌘⏎` / `⌃⏎` = 只提交（"改完就走"那一档，与大纲里的 `⌘⏎` 对齐）
        this.commitTitleEdit();
        this.refocusView();
      } else if (verdict === 'cancel') {
        event.preventDefault();
        this.cancelTitleEdit();
        // ★ 取消（`Esc`）也要把焦点交回画布：输入框被移除 ⇒ 之后的键位全落空
        this.refocusView();
      }
    });
    editor.input.addEventListener('input', () => {
      // 影子跟着走（节点宽度由它算），然后**重排一次**：宽度变了，位置就得跟着变 ——
      // 不重排的话，往左延伸的那一支会长进父节点里（实测就是这么报的）
      editor.sync();
      this.scheduleRelayout();
    });
    editor.input.addEventListener('blur', () => this.commitTitleEdit());
    editor.input.addEventListener('mousedown', (event: MouseEvent) => event.stopPropagation());

    editor.input.focus();
    editor.input.select();
    // ★ 进入编辑那一下**立刻重排一次**：编辑态与显示态是两套 DOM（影子 vs 标题带），
    //   宽度难免差几个像素（甚至是"空标题"那 4px）—— 不重排的话，往左延伸的那一支
    //   会按旧宽度摆着，看起来"压住父节点"，直到你敲第一个字才跳一下（实测就是这么报的）
    this.relayout();
  }

  private commitTitleEdit(): void {
    const editing = this.editing;
    if (!editing) return;
    const text = editing.editor.input.value;
    this.closeTitleEdit();
    this.edit(t('history.mindEditTitle'), (mind) => setText(mind, editing.nodeId, text));
  }

  private cancelTitleEdit(): void {
    if (!this.editing) return;
    this.closeTitleEdit();
  }

  /**
   * **`⏎`（**树视图**里改标题时）= 提交 + 新建一个同级，并把光标接到新节点上**（`N3-j`，2026-09-17）。
   *
   * ★ 用户原话："我现在新建一个子节点，回车。再回车无法创建起兄弟节点。必须点一下这个创建的新节点，
   *   再回车，才能创建兄弟节点。" —— 这在**树视图**里是两件事叠出来的：
   *   ① 从前 `⏎` 只"提交"，光标停在原地 ⇒ 想接着往下写还得再来一次；
   *   ② 更要命的是**提交之后焦点丢了**：输入框是临时的，一移除焦点就掉回 `<body>`，而画布键位
   *      是绑在 `canvas`（`tabindex=0`）上的 ⇒ 那"再来一次"**根本不会响应**，非得先用鼠标点一下画布
   *      （他说的"必须点一下这个创建的新节点"点的正是这件事）。
   * ⇒ 这一档把两件事一起解决：一次 `⏎` 就"这一行落定 + 紧接着开下一行"（幕布 / Workflowy 的
   *   导图视图就是这个手感），**且提交与新节点在同一个 `edit` 里** ⇒ 一步撤销。
   * ★ 只想"改完就走"：`⌘⏎` 或 `Esc`（`titleEditKeyOf` 那两条路照旧）。
   * ★ 根节点没有同级 ⇒ 退化成"只提交"，并把焦点交回画布（`refocusView`）。
   */
  private commitAndAddSibling(): void {
    const editing = this.editing;
    if (!editing) return;
    const nodeId = editing.nodeId;
    const text = editing.editor.input.value;
    this.closeTitleEdit();

    let created: string | null = null;
    this.edit(t('history.mindAddSibling'), (mind) => {
      const wrote = setText(mind, nodeId, text);
      created = addSibling(mind, nodeId);
      return created !== null || wrote;
    });

    if (created !== null) this.selectAndEdit(created);
    else this.refocusView();
  }

  /**
   * 把键盘焦点交回**当前视图**（`N3-j`）。
   *
   * ★ 为什么非得有这么一下：画布键位挂在 `canvas` 上（`tabindex=0`）、大纲键位挂在大纲面板上 ⇒
   *   **焦点不在它们身上时，按键一个都收不到**。而"就地改标题"那个输入框是临时的：提交 / 取消
   *   一收，被移除的输入框就把焦点丢回 `<body>` ⇒ 用户接着敲的 `⏎` / `Tab` / 方向键全部石沉大海
   *   （真实报障："再回车无法创建兄弟节点，必须点一下那个新节点" —— 点那一下干的就是这件事）。
   * ★ **只**在"键盘引起的收尾"里叫它：失焦（点了别处）那条路不能抢焦点，否则用户点工具栏 /
   *   搜索框时会被硬拽回画布。
   */
  private refocusView(): void {
    if (this.outlineMode) this.outlinePanel?.element.focus();
    else this.canvasEl?.focus();
  }

  private closeTitleEdit(): void {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    editing.editor.element.remove();
    // ★ 两条路藏标题的手法不同，两个属性都复位一遍：
    //   * 画布：`display: none`（节点宽度由影子重算，不再需要这块地方）；
    //   * 大纲：`visibility: hidden`（标题**必须继续占位**，否则行会跳 —— 见那一段的说明）。
    if (editing.titleEl) {
      editing.titleEl.setCssStyles({ display: '' });
      editing.titleEl.setCssStyles({ visibility: '' });
    }
    // 同一件事的另一半：编辑态收掉之后宽度也会变（用户可能打了一半又 Esc），
    // 原地重排一次。走 `commit` 那条路时后面还有一次 `render()`，多这一趟不碍事。
    this.relayout();
  }

  // ── 改动与撤销 ──────────────────────────────────────────

  /**
   * 改 + 记一步历史（与白板 `BoardView.commit` 同一条）。
   *
   * 三个关键点（逐条对齐白板那份）：
   *  * 快照在 `mutate` **之前**取 —— 之后模型已经被就地改过了；
   *  * `applyingHistory` 期间不记 —— 否则"撤销"本身会成为新的一步；
   *  * `mutate` 返回 `false` 时不记 —— "什么都没改"的操作不该在撤销栈里占一格。
   *
   * @returns `mutator` 的返回值（新节点 id / 改没改），调用方常要用它决定"要不要选中新节点"
   */
  private edit<T extends string | boolean | null | readonly string[]>(
    label: string,
    mutator: (mind: MindFile) => T,
    mergeKey?: string,
  ): T | null {
    const path = this.file?.path;
    const mind = this.mind;
    if (!path || !mind || !this.writable) return null;

    const recording = !this.applyingHistory;
    const before = recording ? serializeMindContent(mind) : null;
    let result: T | null = null;

    const changed = this.plugin.mindRepository.mutate(path, (draft) => {
      result = mutator(draft);
      // `false` = 版型操作没改动；`null` = 目标不存在（`ops` 那套约定）
      return result !== false && result !== null;
    });

    if (!changed || before === null) return result;
    this.history.submit({ label, before, after: serializeMindContent(mind), mergeKey });
    return result;
  }

  /**
   * 撤销 / 重做。
   *
   * ★ 顺序不可换：**先写内容、再动栈**。快照写不回去（文件被外部改坏过）时栈必须原样保留，
   *   否则用户按一次 `⌘Z` 就永久失去了那一步（与白板 `applyHistory` 同一条）。
   */
  private applyHistory(direction: 'undo' | 'redo'): void {
    const path = this.file?.path;
    const mind = this.mind;
    if (!path || !mind || !this.writable) return;

    const entry = direction === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
    if (!entry) {
      new Notice(t(direction === 'undo' ? 'notice.undoEmpty' : 'notice.redoEmpty'));
      return;
    }

    const restored =
      direction === 'undo'
        ? restoreMindContent(mind, entry.before)
        : restoreMindContent(mind, entry.after);
    if (!restored) return;

    this.applyingHistory = true;
    try {
      // 快照是**就地替换** `nodes` / `rootId` 的，必须过一遍 `mutate` 才会递增 revision、
      // 通知渲染层、排盘 —— 直接改对象等于白改
      this.plugin.mindRepository.mutate(path, () => true);
    } finally {
      this.applyingHistory = false;
    }

    if (direction === 'undo') this.history.commitUndo();
    else this.history.commitRedo();

    // 撤销可能把选中的节点一起撤没了：按现模型收一遍选区，锚点跟着回落 ——
    // 键位不至于"没有主"，而多选也尽量留着（撤销一次不该顺手把选区也清了）
    this.selectedIds = sanitizeSelection(mind, this.selectedIds);
    if (this.selectedIds.size === 0) this.selectedIds = new Set([mind.rootId]);
    if (!this.selectedId || !this.selectedIds.has(this.selectedId)) {
      this.selectedId = [...this.selectedIds][0] ?? mind.rootId;
    }
    this.syncSelection();
    new Notice(t(direction === 'undo' ? 'notice.undone' : 'notice.redone', { label: entry.label }));
  }

  // ── 渲染 ────────────────────────────────────────────────

  /**
   * 只重排、**不碰模型**（改标题时节点宽度在变，位置就得跟着变）。
   *
   * ★ 与 `render()` 的区别：`render()` 是"换过模型之后"的重画（估算 → 量 → 再排两遍）；
   *   这里模型一动没动，只是某个节点的 DOM 尺寸变了（输入框在打字）—— 量一次、排一次就够。
   * ★ 按帧节流：打字是连续事件，不节流会把整套布局按每个键算一遍。
   * ★ 不重排的后果实测过：往**左**延伸的那一支，节点会往右长进父节点里
   *   （布局还以为它是最小宽度，而 DOM 已经宽出去了）。
   */
  private scheduleRelayout(): void {
    if (this.relayoutFrame !== null) return;
    this.relayoutFrame = window.requestAnimationFrame(() => {
      this.relayoutFrame = null;
      this.relayout();
    });
  }

  private relayout(): void {
    const mind = this.mind;
    if (!mind) return;
    // ★ 大纲视图里不重排（同 `render()` 的理由：画布隐着，量出来的尺寸是 0）。
    //   进大纲之前那次排的结果还留着，切回来 `render()` 会重排一遍
    if (this.outlineMode) return;
    this.measureMounted();
    const layout = layoutMind(mind, this.layoutOptions());
    this.paint(layout);
    this.layout = layout;
  }

  /**
   * 布局的两处固定口径（三处调用共用一份，免得哪一处漏了）。
   *
   * ★ `direction: 'right'`：**统一向右**（大纲式）—— 用户 2026-09-16 定的观感。
   *   布局层保留两侧模式不删：将来做「切换方向」的命令时它就是那个开关。
   */
  private layoutOptions(): MindLayoutOptions {
    return {
      sizeOf: (node) => this.sizeOf(node),
      direction: directionForStructure(this.structure),
      // 聚焦（`D1`）：树视图里"进入当前主题"= 把那一支当根重排（与大纲看到的是同一支）。
      // ★ 三处 `layoutMind` 调用共用这一份口径（渲染 / 重排 / 初次挂载），
      //   只给其中一处传的话，会出现"刚进来是全树、动一下才变成聚焦那一支"。
      focusId: this.focusId ?? undefined,
    };
  }

  /**
   * 现在的**总体结构**（`08 §1.2`）。
   *
   * ★ 文件里没写 = 缺省（向右）；写了**还没实现的档位**（组织结构图 / 鱼骨图）⇒
   *   回落到向右：那些档位在下拉里是"待做"、不可选，但**文件是纯文本**——
   *   手改进去的值不该让视图崩掉或画出半成品。
   */
  private get structure(): MindStructure {
    const value = this.mind?.view.structure ?? MIND_DEFAULT_STRUCTURE;
    return MIND_PENDING_STRUCTURES.has(value) ? MIND_DEFAULT_STRUCTURE : value;
  }

  /** 现在的**分支线形态**（`08 §1.3`）；文件里没写 = 曲线 */
  private get edgeStyle(): MindEdgeStyle {
    return this.mind?.view.edge ?? MIND_DEFAULT_EDGE_STYLE;
  }

  /**
   * 换总体结构。
   *
   * ★ 走 `updateView` ⇒ **不进撤销栈、不递增 `revision`**（用户 2026-09-16 确认）：
   *   它与缩放 / 平移是同一类东西（"这一眼怎么看"），不是内容。
   * ★ 结构变了**位置全变** ⇒ 必须 `render()` 重排；线型只改连线的 `d` ⇒ 重画连线就够。
   */
  private applyStructure(structure: MindStructure): void {
    const path = this.file?.path;
    if (!path || !this.mind || this.structure === structure) {
      this.controls?.setStructure(this.structure);
      return;
    }
    this.controls?.setStructure(structure);
    this.plugin.mindRepository.updateView(path, { structure });
    this.render();
  }

  private applyEdgeStyle(edge: MindEdgeStyle): void {
    const path = this.file?.path;
    if (!path || !this.mind || this.edgeStyle === edge) {
      this.controls?.setEdge(this.edgeStyle);
      return;
    }
    this.controls?.setEdge(edge);
    this.plugin.mindRepository.updateView(path, { edge });
    if (this.layout) this.paintEdgesNow(this.layout);
  }

  /** 缩放一档（左下角的 `+` / `−` 与 `⌘=` / `⌘-` 走同一个函数） */
  private zoomStep(direction: 1 | -1): void {
    this.viewport.zoomStep(direction);
  }

  /** 回到 100%（左下角的百分比按它做） */
  private zoomReset(): void {
    this.viewport.zoomToActualSize();
  }

  private render(): void {
    const mind = this.mind;
    if (!mind || !this.worldEl) return;

    // ★ 两套外壳先对齐（幂等，见 `syncOutlineChrome`）
    this.syncOutlineChrome();
    // ★ 大纲视图（`N3-a`）：**到此为止** —— 下面的量 / 排 / 画是给画布用的，
    //   而画布此刻 `display: none`（量出来的尺寸全是 0）。大纲只重画"行"这一层。
    //   ★ 这条早退也是"切回树视图会重排"的**唯一**保证：出大纲时 `applyOutlineMode`
    //   会再叫一次 `render()`，那时才走下面那一整套（此时画布已经重新可见）
    if (this.outlineMode) {
      this.renderOutline();
      return;
    }

    if (this.canvasEl) this.canvasEl.dataset.background = mind.view.background;
    this.clearMessage();
    this.nodesById = new Map(mind.nodes.map((node) => [node.id, node]));
    // 整支总数：一次遍历算全表（手柄每次重画都要读，见字段上的说明）
    this.subtreeSizes = subtreeSizes(mind);

    const first = layoutMind(mind, this.layoutOptions());
    this.paint(first);
    this.layout = first;

    if (!this.measureMounted()) {
      // 量不到尺寸（视图还没显示 / 在后台标签里）也要让地图跟上：它按**估算尺寸**画一版，
      // 总比停在上一份骨架（甚至一片空白）强 —— 下次 `render` 会把真尺寸补上去
      this.minimap?.syncContent();
      return;
    }
    const refined = layoutMind(mind, this.layoutOptions());
    this.paint(refined);
    this.layout = refined;
    // 缩略图（`P2-c`）：内容与**尺寸**都在这一版里定了，地图到这儿再同步。
    // ★ 它内部先比指纹（几何 + 盒子尺寸），没变就一个 DOM 都不碰 ⇒ 放在每帧都会走到的
    //   `render` 末尾是安全的（白板那边也是这么放的）
    this.minimap?.syncContent();
  }

  /**
   * 估算 or 量到的真尺寸 —— 这一个函数就是"两档尺寸"的全部分界线。
   *
   * ★ 估算要带上**这个节点的层级字号**（根 30 / 一层 18 / 其余 14）：拿同一套字号去估，
   *   中心主题第一帧会明显偏小，量完之后再跳一下。字号与上限都从 `palette.ts` 那组常量来，
   *   于是"估算"与"样式表"说的是同一个数。
   */
  private sizeOf(node: MindNode): Size {
    const measured = this.measured.get(node.id);
    if (measured) return measured;

    const size = titleSizeOf(this.depthOfNode(node));
    return estimateNodeSize(node, {
      fontSize: size,
      titleLineHeight: Math.round(size * 1.35),
      titleMaxWidth: Math.round(MIND_TITLE_MAX_WIDTH * (size / MIND_TITLE_FONT_SIZE)),
    });
  }

  /**
   * 节点在树上的深度（根 = 0）。
   *
   * ★ 悬浮节点**当一层看**：它确实不挂在任何人下面（`depthOf` 给 0），但它也不该长得
   *   像中心主题（30px 加粗）—— 它是"一张普通的自由卡片"。
   */
  private depthOfNode(node: MindNode): number {
    const mind = this.mind;
    if (!mind) return 1;
    if (node.parentId === null && node.id !== mind.rootId) return 1;
    return depthOf(mind, node.id);
  }

  private paint(layout: MindLayout): void {
    const layer = this.nodeLayerEl;
    const edges = this.edgeLayerEl;
    if (!layer || !edges) return;

    const visible = this.viewport.visibleBounds();
    const keep = new Set<string>();

    for (const box of layout.boxes.values()) {
      if (!boxIntersects(box, visible)) continue;
      keep.add(box.id);
      const node = this.nodesById.get(box.id);
      if (!node) continue;

      // ★ 内容变了就**重建这一个元素**：几何那一半 `applyNodeBox` 管得住，
      //   但标题 / 正文 / 附件 / 配色 / 折叠这些它管不着 —— 不比较这一下，
      //   "打完字要重开一次才显示"就会回来（这个 bug 真的出现过）。
      // ★ 指纹里带上"这个节点是不是正在编辑内容"：进出内容区也要重建一次
      //   （编辑态的内容块是 `forceBody` 强制建出来的，两者 DOM 不同）。
      const editingNote = this.noteEdit?.nodeId === box.id;
      // ★ 指纹里要带上**层级**：层级变了配色与字号都得跟着变（一层是主色、二层淡粉、
      //   三层以上白），不带的话"缩进一层"之后卡面还是旧颜色 —— 那正是这个指纹要防的事
      const depth = box.free ? 1 : box.depth;
      // ★ 完成（`N3-g`）：祖先里有完成的 ⇒ 这一块画淡。沿父链算（最多几跳），
      //   而且**必须进指纹** —— 祖先一改完成，子孙不重建的话，"淡不淡"就留在旧样子上了
      const doneBranch = this.hasDoneAncestor(node);
      // ★ 指纹里带上**附件还在不在**（`06 §6` 的断链态）：那一枚灰只改回形针的类名，
      //   不进指纹的话"删掉附件之后回形针不变灰"（见 `renderSignatureOf` 那一处）
      const signature = `${renderSignatureOf(node, this.refMissing)}|${editingNote ? 'edit' : ''}|d${depth}|${doneBranch ? 'dim' : ''}`;
      let el = this.mounted.get(box.id);
      if (el && this.rendered.get(box.id) !== signature) {
        this.discardNodeElement(box.id, el);
        el = undefined;
      }
      if (!el) {
        el = buildNodeElement(layer.ownerDocument, node, {
          resolveTheme: this.resolveTheme,
          forceBody: editingNote,
          doneBranch,
          renderMarkdown: this.renderNodeMarkdown,
          // 图片：库内路径 → 能放进 `<img src>` 的地址（只有宿主知道这件事）
          resolveResource: this.resourcePathOf,
          // 附件失效（`06 §6`）：文件被删 / 移到库外 ⇒ 回形针变灰 + 悬停说清
          refMissing: this.refMissing,
          // 图片是**异步**加载的：加载完必须重排一次 —— 否则节点一直按估算的高度摆着，
          // 图一出现就又歪又挤（`06 §4.1` 的图片块）
          onImageLoad: this.scheduleRelayout,
          // 层级决定标题字号与底色（`palette.ts` 那组常量）
          depth,
        });
        this.mounted.set(box.id, el);
        this.rendered.set(box.id, signature);
        layer.appendChild(el);
      }
      // 编辑态的内容块要挂上编辑器（重建过 / 刚进入状态时都会走到这里）
      if (editingNote && this.noteEdit?.editor === null) this.mountNoteEditor(el);
      applyNodeBox(el, box);
      el.classList.toggle(SELECTED_CLASS, this.selectedIds.has(box.id));
    }

    for (const [id, el] of [...this.mounted]) {
      // ★ 正在编辑内容的那一个**不回收**：它手里握着焦点和半截草稿，
      //   滚出视野就把它拆掉的话，用户回来会发现"编辑器没了"。
      if (keep.has(id) || this.noteEdit?.nodeId === id) continue;
      this.discardNodeElement(id, el);
    }

    this.paintHandles(layout, keep);
    paintEdges(edges, this.edgePairsOf(layout, keep), this.edgeStyle);
    // 关联线（`N1`）跟着这一帧重画：几何直接取布局给的框 ⇒ 节点一动线就走
    this.paintLinks(layout, keep);
    // 快捷操作栏的"现在按着哪个态"（加粗 / 斜体 / 标记 / 色块）跟着这一帧走：
    // 改了样式之后节点会重画，而选区可能没变 —— 只靠 `syncSelection` 会漏掉这一种（`08 §3`）
    this.syncToolbar();
  }

  /**
   * 要从哪儿连到哪儿（父 → 子）。
   *
   * ★ 收成一个函数是因为它有两个调用方：`paint`（给了 `keep` 就只画看得见的那些）
   *   与"只换线型"时的重画（`paintEdgesNow`，那时全部重画）。两处各写一份的话，
   *   "裁剪条件写反"这种错会在两条路上长得不一样 —— 最难查的一类。
   */
  private edgePairsOf(
    layout: MindLayout,
    keep?: ReadonlySet<string>,
  ): Array<readonly [NodeBox, NodeBox]> {
    const pairs: Array<readonly [NodeBox, NodeBox]> = [];
    for (const [id, box] of layout.boxes) {
      const node = this.nodesById.get(id);
      if (!node?.parentId) continue;
      const parent = layout.boxes.get(node.parentId);
      if (!parent) continue;
      if (keep && !keep.has(id) && !keep.has(parent.id)) continue;
      pairs.push([parent, box] as const);
    }
    return pairs;
  }

  /**
   * 画关联线（`N1`）。
   *
   * ★ 几何**直接取布局给的框**（`layout.boxes`）：节点一动、折叠一收，线自然跟着走 ——
   *   关联线不参与布局，但它的两端由布局决定，于是"跟着端点走"是免费的。
   * ★ 裁剪与分支线同一条：**一端**在视野里就画（两端都在视野外才跳过）——
   *   只按"两端都可见"判的话，拖着节点跨过屏幕边界时线会凭空消失。
   */
  private paintLinks(layout: MindLayout, keep?: ReadonlySet<string>): void {
    const layer = this.linkLayerEl;
    const mind = this.mind;
    if (!layer || !mind) return;

    // ★ 选中的那条线可能已经不在了（`⌘Z` 撤掉、删了端点节点、别的窗口改了这份文件）
    //   —— 在这里顺手校验一次：指着一个不存在的 id 比"没选中"糟得多
    //   （用户接着按 `Delete`，删掉的是他看不见的东西）
    if (
      this.selectedLinkId !== null &&
      !(mind.links ?? []).some((link) => link.id === this.selectedLinkId)
    ) {
      this.selectedLinkId = null;
    }

    const items: LinkPaintItem[] = [];
    for (const link of mind.links ?? []) {
      const from = layout.boxes.get(link.from);
      const to = layout.boxes.get(link.to);
      // 两端框都在才画：节点刚删、或还没量到尺寸时不画一根悬空的线
      if (!from || !to) continue;
      if (keep && !keep.has(from.id) && !keep.has(to.id)) continue;
      items.push({
        id: link.id,
        from,
        to,
        arrow: link.arrow,
        label: link.label,
        solid: link.solid,
        // ★ 颜色（`N1-e`）：主题色编号换成 `var(--color-…)`（换主题时线跟着走）
        color: link.color ? themeColorVar(link.color) : undefined,
        // ★ 弯折（`N1-d`）：拖动中的那条用**预览值**（模型还没写，见 `LinkBendDragState`）
        bend: this.bendForPaint(link),
      });
    }

    const selected = this.selectedLinkId === null ? undefined : new Set([this.selectedLinkId]);
    paintLinks(layer, items, selected);
    // ★ 弯折手柄跟着这一帧摆（选中一条线时才出现；节点一动 / 相机一动都得走一遍）
    this.syncLinkHandle(layout);
  }

  /** 画那一帧该用哪个弯折：拖动中的那条用预览值，其余用模型里的值 */
  private bendForPaint(link: MindLink): { x: number; y: number } | undefined {
    const drag = this.linkBendDrag;
    if (drag && drag.linkId === link.id) return drag.bend ?? undefined;
    return link.bend;
  }

  /** 现在选中的那条关联线（`null` = 没选中 / 已经不在了） */
  private get selectedLink(): MindLink | null {
    const id = this.selectedLinkId;
    if (id === null) return null;
    return (this.mind?.links ?? []).find((link) => link.id === id) ?? null;
  }

  /**
   * 把**弯折手柄**摆到选中那条线的**曲线中点**上（`N1-d`）；没选中 / 线不在 ⇒ 收起来。
   *
   * ★ 摆在中点上而不是另找一个位置：有弯折时"曲线中点"**就等于**"不弯的中点 + bend"
   *   ⇒ 手柄拖到哪儿、线就弯到哪儿，用户看到的与手上做的永远是同一个点（`links.ts` 里
   *   那个 `4/3` 的控制点换算就是为保证这一条）。
   * ★ 每帧都摆（`paintLinks` 里叫它）：节点挪了、相机动了、折叠展收了，手柄都得跟着走。
   */
  private syncLinkHandle(layout: MindLayout): void {
    const handle = this.linkHandleEl;
    if (!handle) return;

    const link = this.selectedLink;
    const from = link ? layout.boxes.get(link.from) : undefined;
    const to = link ? layout.boxes.get(link.to) : undefined;
    if (!link || !from || !to) {
      handle.classList.remove('is-shown');
      return;
    }

    const mid = linkMidpointOf(from, to, this.bendForPaint(link));
    handle.style.left = `${roundTo(mid.x)}px`;
    handle.style.top = `${roundTo(mid.y)}px`;
    handle.classList.toggle('is-bending', this.linkBendDrag !== null);
    handle.classList.add('is-shown');
  }

  /** 只重画连线（换线型时用：几何一个字节都没变，不必重排） */
  private paintEdgesNow(layout: MindLayout): void {
    const edges = this.edgeLayerEl;
    if (!edges) return;
    paintEdges(edges, this.edgePairsOf(layout), this.edgeStyle);
  }

  /**
   * **连接处的折叠手柄**（`06 §11.14`）。
   *
   * ★ 只有**有孩子**的节点才画：没孩子的节点上那个圆圈点了也没反应。
   * ★ 收起时圆圈里是**直接**子节点数（"其中的子节点数量"就是它，与 XMind 一致）；
   *   超过 99 用省略号 —— 三位数会把 20px 的圆圈撑破。
   * ★ 手柄挂在**世界容器**里（跟内容一起缩放平移），不放进节点元素：节点有
   *   `overflow: hidden`，骑在边上的手柄会被裁掉一半。
   */
  private paintHandles(layout: MindLayout, keep: ReadonlySet<string>): void {
    const layer = this.handleLayerEl;
    const mind = this.mind;
    if (!layer || !mind) return;

    const drawn = new Set<string>();
    for (const [id, box] of layout.boxes) {
      if (!keep.has(id)) continue;
      // 没有子孙的节点不画手柄：点了也没反应
      const count = this.subtreeSizes.get(id) ?? 0;
      if (count === 0) continue;
      drawn.add(id);

      let el = this.handles.get(id);
      if (!el) {
        el = buildHandleElement(layer.ownerDocument);
        this.handles.set(id, el);
        layer.appendChild(el);
      }
      const collapsed = nodeById(mind, id)?.collapsed === true;
      applyHandleState(el, {
        nodeId: id,
        collapsed,
        count,
        label: collapsed
          ? t('mind.handle.expand', { count: String(count) })
          : t('mind.handle.collapse'),
      });
      applyHandleBox(el, box);
    }

    for (const [id, el] of [...this.handles]) {
      if (drawn.has(id)) continue;
      el.remove();
      this.handles.delete(id);
    }
  }

  /** 回收一个节点元素：内嵌组件（`MarkdownRenderer` 挂上去的那些）跟着卸掉 */
  private discardNodeElement(id: string, el: HTMLElement): void {
    const body = el.querySelector<HTMLElement>(`.${MIND_BODY_CLASS}`);
    if (body) this.embedded.get(body)?.unload();
    el.remove();
    this.mounted.delete(id);
    this.rendered.delete(id);
  }

  // ── 内容区（`⌘⏎` 进出，P4）──────────────────────────────

  /**
   * `⌘⏎`：打开选中节点的**内容区**。
   *
   * ★ 收起由编辑器自己负责（它的 `Esc` / `⌘⏎` 都会走 `onSubmit` + `onExit`）：
   *   编辑期间那两下键**属于编辑器** —— 窗口捕获那一道会让路（见 `isEditableTarget`）。
   */
  private beginNoteEdit(nodeId: string): void {
    const mind = this.mind;
    if (!mind || !this.writable || !nodeById(mind, nodeId)) return;
    if (this.noteEdit?.nodeId === nodeId) return;

    this.cancelTitleEdit();
    this.endNoteEdit(false);
    this.noteEdit = { nodeId, editor: null, body: null };
    // 指纹里带上了"正在编辑" ⇒ 这一次重排会把它重建出内容块，再把编辑器挂上去
    this.relayout();
  }

  /**
   * 节点内容块的 Markdown 渲染（注入给 `render.ts`）。
   *
   * ★ 每次渲染新建一个 `Component` 并登记在 `embedded` 上：`MarkdownRenderer` 会把
   *   内嵌笔记 / 图片的组件挂到它上面，节点 DOM 回收（`discardNodeElement`）时得跟着卸掉。
   * ★ 异常自己消化并**回落到纯文本**：渲染失败不该让这块内容变成空白。
   */
  private readonly renderNodeMarkdown = (markdown: string, el: HTMLElement): void => {
    this.embedded.get(el)?.unload();
    const component = new Component();
    component.load();
    this.embedded.set(el, component);
    // ★ 链接的点击**自己接**：`MarkdownRenderer.render` 只把 `<a class="internal-link"
    //   data-href="…">` 渲染出来，"点它跳到哪"那一步是**视图**的事 —— 宿主对自定义视图
    //   不兜底（与 `⌘Z` 要自己登记命令同一条教训）。不接的症状就是：
    //   链接看着像链接、点下去什么都不发生（真实报障，见 §11.25）。
    //   ★ 白板卡片同病，所以这一段抽成了共享助手（`integration/markdownLinks.ts`）。
    attachMarkdownLinkHandler(el, this.app, this.file?.path ?? '');
    void MarkdownRenderer.render(this.app, markdown, el, this.file?.path ?? '', component).catch(
      (error: unknown) => {
        console.warn('[nestboard] 脑图节点内容渲染失败', describeError(error));
        el.textContent = markdown;
      },
    );
  };

  /** 把编辑器挂进内容块（`paint` 建好 DOM 之后调） */
  private mountNoteEditor(el: HTMLElement): void {
    const state = this.noteEdit;
    const mind = this.mind;
    if (!state || !mind) return;
    const node = nodeById(mind, state.nodeId);
    const body = el.querySelector<HTMLElement>(`.${MIND_BODY_CLASS}`);
    if (!node || !body) return;

    // 编辑器接管这一块（它是"源码视图"）：先把渲染好的内容清掉
    body.replaceChildren();
    body.classList.add('is-editing');
    state.body = body;

    const editor = new MiniMarkdownEditor({
      host: body,
      value: node.note,
      onSubmit: (value) => this.writeNodeNote(state.nodeId, value),
      onExit: () => this.endNoteEdit(),
    });
    state.editor = editor;
    this.growNoteEditor(body);
    editor.focus();
  }

  /**
   * 让输入框跟着内容长高，并顺带重排（节点高度变了，兄弟们要让位）。
   *
   * ★ 编辑器本身没有"输入中"这个钩子（它的回调只有提交 / 退出），
   *   所以在这里直接挂在它建出来的 `<textarea>` 上 —— 与标题输入框同一套做法。
   */
  private growNoteEditor(body: HTMLElement): void {
    const textarea = body.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) return;

    const grow = (): void => {
      textarea.setCssStyles({ height: 'auto' });
      textarea.style.height = `${textarea.scrollHeight}px`;
      this.scheduleRelayout();
    };
    textarea.addEventListener('input', grow);
    grow();
  }

  /** 内容区收口（编辑器提交完 / 取消 / 视图销毁都走它） */
  private endNoteEdit(rebuild = true): void {
    const state = this.noteEdit;
    if (!state) return;
    this.noteEdit = null;
    state.body?.classList.remove('is-editing');
    state.body?.replaceChildren();
    // 指纹里的"正在编辑"没了 ⇒ 这一次重排会把它重建回显示态（富文本重新渲染）
    if (rebuild) this.relayout();
  }

  /** 写回节点正文：与标题、树操作一样走 `edit()` —— **进撤销栈** */
  private writeNodeNote(nodeId: string, note: string): void {
    this.edit(t('history.mindNote'), (mind) => setNote(mind, nodeId, note));
  }

  private measureMounted(): boolean {
    let changed = false;
    for (const [id, el] of this.mounted) {
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      if (size.width <= 0 || size.height <= 0) continue;
      const previous = this.measured.get(id);
      this.measured.set(id, size);
      if (!previous || previous.width !== size.width || previous.height !== size.height) {
        changed = true;
      }
    }
    return changed;
  }

  // ── 相机与持久化 ────────────────────────────────────────

  private scheduleCamera(): void {
    if (this.cameraFrame !== null) return;
    this.cameraFrame = window.requestAnimationFrame(() => {
      this.cameraFrame = null;
      this.applyCamera();
    });
  }

  private applyCamera(): void {
    const world = this.worldEl;
    if (!world) return;
    world.style.transform = this.viewport.transform();
    if (this.layout) this.paint(this.layout);
    // 左下角那个百分比跟着视口走（滚轮缩放也算"视口变了"）
    this.controls?.setZoom(this.viewport.zoom);
    // 缩略图里的视野框（`P2-c`）：每帧只挪一个矩形（`syncCamera` 内部不碰内容）
    this.minimap?.syncCamera();
    this.viewportSave?.();
  }

  /** 视口落盘：**不递增 revision**（`03 §3.2` W3 的同一口径） */
  private persistViewport(): void {
    const path = this.file?.path;
    if (!path || !this.mind) return;
    this.plugin.mindRepository.updateView(path, this.viewport.toState());
  }

  /** 主题色编号 → 色号：只有 DOM 知道 CSS 变量，所以在这一层解析后注入配色（`06 §6.1`） */
  private readonly resolveTheme = (color: ThemeColor): HexColor => {
    const raw = getComputedStyle(this.contentEl).getPropertyValue(
      `--color-${THEME_VAR_SUFFIX[color]}`,
    );
    const value = raw.trim();
    return value.length > 0 ? value : FALLBACK_THEME_HEX[color];
  };

  private renderMessage(message: string): void {
    this.mind = null;
    this.layout = null;
    this.selectedId = null;
    this.selectedIds = new Set();
    this.clearCanvas();

    const canvas = this.canvasEl;
    if (!canvas) return;
    const box = canvas.ownerDocument.createElement('div');
    box.className = 'nestboard-mind-error';
    box.textContent = message;
    canvas.appendChild(box);
    this.messageEl = box;
  }

  private clearMessage(): void {
    this.messageEl?.remove();
    this.messageEl = null;
  }

  private clearCanvas(): void {
    this.clearMessage();
    // 画布整个清掉时编辑器也一并没了：状态跟着收，别留一个"在编辑一个不存在的节点"
    this.noteEdit = null;
    this.mounted.clear();
    this.rendered.clear();
    this.handles.clear();
    this.subtreeSizes.clear();
    this.nodeLayerEl?.replaceChildren();
    this.handleLayerEl?.replaceChildren();
    if (this.edgeLayerEl) {
      paintEdges(this.edgeLayerEl, []);
      this.edgeLayerEl.setCssStyles({ opacity: '' });
    }
    if (this.linkLayerEl) {
      paintLinks(this.linkLayerEl, []);
      this.linkLayerEl.setCssStyles({ opacity: '' });
    }
    // 连线态与标签编辑也一并收掉（换文件 / 关视图时不该留一条拉了一半的线、
    // 或一个还挂着的输入框）
    this.linking = null;
    this.cancelLinkLabelEdit();
    this.selectedLinkId = null;
    // 拖了一半的大纲行也一并收掉（换文件 / 关视图时不该留一行"提在半空"的样子）
    this.cancelOutlineDrag();
    this.canvasEl?.classList.remove('is-linking');
    if (this.linkPreviewEl) paintLinkPreview(this.linkPreviewEl, null, null);
  }
}

/** 两个集合是不是同一批 id（框选每帧都算，用它挡掉多余的一次 DOM 同步） */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/** 导出的格式（视图上的几个入口共用一条路） */
export type MindExportKind =
  | 'markdown'
  /** **大纲式 Markdown**（`toOutlineMarkdown.ts`，用户 2026-09-17）：与上面那份是两种口味 */
  | 'outlineMarkdown'
  | 'svg'
  | 'png'
  | 'freemind'
  /** `.xmind`（`toXmind.ts`）：包内三个 json，打包走 `export/toZip` */
  | 'xmind';

/** PNG 的像素倍率（二倍图：投屏与文档里贴图都够清晰） */
const MIND_PNG_SCALE = 2;

/** 夹到区间里（拉角与图片宽度的上下限共用） */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 剪贴板里那一支的名字（`Notice` 里那句"复制了什么"；空标题给一句占位） */
function clipboardLabelOf(payload: MindClipboard): string {
  const root = payload.nodes.find((node) => node.id === payload.roots[0]);
  const text = root?.text.trim() ?? '';
  return text.length > 0 ? text : t('mind.nodeTitle.empty');
}

/** 主题色编号 → CSS 变量名的后缀（Obsidian 的命名：`--color-red` / `--color-purple`） */
const THEME_VAR_SUFFIX: Record<ThemeColor, string> = {
  '1': 'red',
  '2': 'orange',
  '3': 'yellow',
  '4': 'green',
  '5': 'cyan',
  '6': 'purple',
};

/** 取不到 CSS 变量时的兜底（近似值：见 `palette.ts` 的同一张表） */
const FALLBACK_THEME_HEX: Record<ThemeColor, HexColor> = {
  '1': '#fb464c',
  '2': '#e9973f',
  '3': '#e0de71',
  '4': '#44cf6e',
  '5': '#53dfdd',
  '6': '#a882ff',
};

function boxIntersects(
  box: NodeBox,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return rectsIntersect(box, rect);
}
