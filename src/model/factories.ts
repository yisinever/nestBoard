/**
 * 工厂函数（T1.08）：**创建合法对象的唯一入口**。
 *
 * 为什么不让各处 `{ ... } as Card` 手搓：
 * 新增字段时只改这里，所有创建点自动带上默认值 —— 否则会出现"某些入口少了字段"的隐性脏数据。
 *
 * ★ 本文件是纯逻辑：不 import `obsidian`、不碰 DOM。
 */

import { BOARD_SPEC, BOARD_VERSION, BOARD_REF_MINI_SIZE, ID_PREFIX } from '../constants';
import { createId } from '../util/id';
import { randomBoardIcon } from '../util/emoji';
// 内嵌脑图卡（`F4`）：卡片内容的初始形态由**脑图的工厂**造（`createMindFile` 那套
// "新加字段要接住"的纪律只该在脑图那一侧踩一次）
import { createMindFile } from '../mind/model/factories';
import type {
  BoardFile,
  BoardMeta,
  Card,
  CardColor,
  CardContentMap,
  CardOf,
  CardType,
  Column,
  Edge,
  EdgeEndpoint,
  Group,
  HexColor,
  Mind,
} from './schema';
import type { MindFile } from '../mind/model/schema';

export interface Size {
  width: number;
  height: number;
}

/**
 * 各类型卡片的默认尺寸。
 * 这是**临时基线**：Sprint 3 起由 `CardTypeDefinition.defaultSize`（03 §7.3）提供，
 * 届时本表删除，改从 `cards/registry.ts` 取。
 */
export const DEFAULT_CARD_SIZES: Record<CardType, Size> = {
  note: { width: 280, height: 180 },
  noteRef: { width: 280, height: 160 },
  image: { width: 320, height: 240 },
  file: { width: 280, height: 80 },
  link: { width: 280, height: 120 },
  todo: { width: 280, height: 200 },
  // ★ 3:4 竖版（用户 2026-09-18："色板卡默认尺寸改成 3:4 的长方形"）。色卡是"一块色"，
  //   竖着更像一张色票；横版在一屏里并排几张时会被压得很扁，看着不像色卡
  swatch: { width: 180, height: 240 },
  // 视频卡（`A1`）：**16:9**。视频图多是横构图，这个比例下绝大多数片子不用改尺寸；
  //   实际高度还会被 `measure` 按**文件的真实宽高比**重算一遍（竖屏视频也不会变形）
  video: { width: 320, height: 180 },
  // 音频卡（`A2`）：**9:10**（用户 2026-09-18）。唱片本身是圆的，但卡片略高于宽时
  //   下面那行控制条才有地方站 —— 正方形里唱片会顶到控制条上
  audio: { width: 198, height: 220 },
  // 仅标题卡（`A3`）：**一行字那么高**。它就是一枚"标签"，撑高了就不再像标签
  titleCard: { width: 200, height: 56 },
  // 图集卡（`A4`）：与图片卡同宽（一组图就该按图片的尺寸摆）
  gallery: { width: 320, height: 240 },
  // ★ 白板卡**只有迷你形式**（用户 2026-09-16），尺寸由形态钉死 ⇒ 默认值必须就是那个正方形。
  //   这里给 300×200 的话，新建出来是"迷你排版塞在大方块里"的四不像 ——
  //   而重开 Obsidian 时读入口把它掰成 87×87，表现就是"重载之后才变迷你"（真实报障）
  boardRef: BOARD_REF_MINI_SIZE,
  ink: { width: 400, height: 300 },
  // 地图图多是横构图（截图 / 导出的地图），4:3 比图片卡的 320×240 更合身一点点；
  // 图按 contain 缩放，尺寸差一点不影响正确性，只影响留白多少
  map: { width: 320, height: 240 },
  // 同步便签就是便签，尺寸与便签一致 —— 它在用户眼里"还是那张便签，只是摆了两处"
  syncNote: { width: 280, height: 180 },
  // 评论卡比便签略宽一点点：每条前面有一列时间戳，太窄的话正文只剩两三个字一行。
  // 高度按"三条短备注 + 一行输入框"估的，够用又不至于空一大片
  comment: { width: 300, height: 200 },
  // PDF 预览卡（`F8`）：**A4 竖版比例**（320×400 ≈ 1:1.25）—— 一页纸长什么样，
  //   卡片就长什么样；横版会把整页压成一条，字号小到读不出
  pdf: { width: 320, height: 400 },
  // `.canvas` 预览卡（`F6`）：横版 3:2 —— canvas 本身多半是"一屏摊开"的形状，
  //   竖着放会把内容压成一条
  canvas: { width: 360, height: 240 },
  // 脑图卡（`F3a`）：比预览卡大一圈 —— 它要装下"根 + 3 层"（`EMBED_MAX_DEPTH`），
  //   太小的话整张图会被缩放得看不清字（卡内不做平移缩放，只能整体缩小）
  mindRef: { width: 440, height: 320 },
  // 内嵌脑图卡（`F4`）：这里只是**兜底** —— 新建时按内容算（`sizeForContent` →
  //   `mindCardSizeFor`），用户要的"尺寸随内容自适应"就落在那一步
  mind: { width: 440, height: 300 },
};

export const DEFAULT_COLUMN_SIZE: Size = { width: 320, height: 500 };

/**
 * 新建白板卡的默认内容（`O18` / `O38`）—— **只有这一处**。
 *
 * ★ 为什么收成一个具名函数：它有两个调用者 ——
 *   ① `createCard`（走下面的 `CONTENT_FACTORIES`，**实际新建走的就是这条**）；
 *   ② 卡片类型定义自己的 `createDefaultContent`（`cards/boardRef.ts` 转发到这里）。
 *   两处各写一份正是上一版"改了却没用"的根源：档位 / 图标改了一处，
 *   另一处还在给 `thumb` 与空图标 —— 表现就是用户报的
 *   "新建时还不是迷你、也没有随机图标，重载之后才被读入口掰对"。
 *
 * ★ **迷你形式**：与读入口的归一同一档（那边把任何档位都读成 `mini`）⇒
 *   "新建的"与"打开旧文件读出来的"是同一个样子。
 * ★ **随机记号**（用户 2026-09-16："新建白板时请赋予随机 emoji 图标"）：
 *   一排迷你白板卡各有一个记号，扫一眼就能认出谁是谁；事后随时能在右键菜单里换或清。
 *   随机放在**创建**这一刻、不进读入口 —— 读入口必须确定性（同一份文件读两遍得一模一样）。
 */
export function newBoardRefContent(): CardContentMap['boardRef'] {
  return { path: '', preview: 'mini', showCount: true, icon: randomBoardIcon() };
}

/**
 * 内嵌脑图卡（`F4`）的初始内容：**中心主题 + 3 个空分支**（用户 2026-09-21 定的）。
 *
 * ★ 与 `newBoardRefContent` 同一条纪律：新建走的是**这里**（`CONTENT_FACTORIES`），
 *   卡片定义自己的 `createDefaultContent` 只是转发 —— 两处各写一份的下场，
 *   在 `O18` 那轮已经踩过一次（"新建出来不对、重载之后才对"）。
 * ★ 3 这个数写在这里（而不是卡片文件里）：它与"新建时该长什么样"是一件事，
 *   而 `cards/**` 只负责把内容画出来。
 */
export const INLINE_MIND_BRANCHES = 3;

export function newMindContent(): CardContentMap['mind'] {
  return { mind: createMindFile({ branches: INLINE_MIND_BRANCHES, title: '' }) };
}

/** 各类型的空 content。与 `03 §2.7` 一一对应 */
const CONTENT_FACTORIES: { [K in CardType]: () => CardContentMap[K] } = {
  note: () => ({ md: '', editorMode: 'markdown' }),
  noteRef: () => ({ path: '', subpath: null, mode: 'summary', excerptLines: 6 }),
  image: () => ({ path: '', caption: '', crop: { x: 0, y: 0, w: 1, h: 1 }, fit: 'cover' }),
  file: () => ({ path: '', showSize: true }),
  // 视频卡（`A1`）：`showSize` 不画（视频卡上没有"大小"那一行），所以给 `false`
  video: () => ({ path: '', showSize: false }),
  // 音频卡（`A2`）：同上（卡面是唱片，也不画大小）
  audio: () => ({ path: '', showSize: false }),
  // 仅标题卡（`A3`）：空文字 + 不写样式键（默认就是"纯圆角、指针朝下"）
  titleCard: () => ({ text: '' }),
  // 图集卡（`A4`）：空图集（一张图都没有时 `render` 画占位语）
  gallery: () => ({ paths: [] }),
  link: () => ({ url: '', title: '', description: '', image: '', fetchedAt: null }),
  todo: () => ({ title: '', items: [] }),
  swatch: () => ({ colors: [], pickedFrom: null }),
  boardRef: newBoardRefContent,
  ink: () => ({ paths: [] }),
  map: () => ({ path: '', label: '', pin: null }),
  // `key` 留空：新建的那一张先当独立便签用；"建一张同步副本"时才把同一个 key 写进两张
  syncNote: () => ({ key: '', md: '' }),
  // 空线程、未解决：新建的评论卡先是一张"等着写第一条"的空卡（与空便签同一种体面）
  comment: () => ({ entries: [], resolved: false }),
  // PDF 卡（`F8`）：空路径（卡面画"把 PDF 拖进来"那句引导）；大小那一格不画
  pdf: () => ({ path: '', showSize: false }),
  // `.canvas` 卡（`F6`）：空路径（卡面画"把 .canvas 拖进来"那句引导）
  canvas: () => ({ path: '', showSize: false }),
  // 脑图卡（`F3a`）：空路径（卡面画"把 .nestmind 拖进来"那句引导）
  mindRef: () => ({ path: '', showSize: false }),
  // 内嵌脑图卡（`F4`）：中心主题 + 3 个空分支（见 `newMindContent`）
  mind: newMindContent,
};

export function createDefaultContent<T extends CardType>(type: T): CardContentMap[T] {
  return CONTENT_FACTORIES[type]();
}

/** 卡片覆盖项：基础字段可选，`content` 可只写部分字段 */
export type CardOverrides<T extends CardType> = Partial<Omit<CardOf<T>, 'type' | 'content'>> & {
  content?: Partial<CardContentMap[T]>;
};

/**
 * 创建一张卡片。
 *
 * 联合类型的拼装只在这一处发生（唯一的 `as CardOf<T>`），
 * 调用方拿到的就是**已收窄**的类型：`createCard('noteRef', …)` 返回的 `content.path` 可直接访问。
 */
export function createCard<T extends CardType>(
  type: T,
  overrides: CardOverrides<T> = {},
): CardOf<T> {
  const { content: contentOverride, ...baseOverride } = overrides;

  // 泛型索引下的对象展开，TS 无法自行证明安全性；content 由 CONTENT_FACTORIES 保证形状正确
  const content = Object.assign(
    {},
    createDefaultContent(type),
    contentOverride,
  ) as CardContentMap[T];

  const card = Object.assign(
    {
      id: createId(ID_PREFIX.card),
      type,
      x: 0,
      y: 0,
      ...DEFAULT_CARD_SIZES[type],
      z: 1,
      columnId: null,
      order: 0,
      color: '1' as CardColor,
      accent: null as HexColor | null,
      locked: false,
      // 便签 / 同步便签默认就带标题行：双击进入编辑时先编标题、`Enter` 再进正文，
      // 与待办卡（标题在编辑态里）的编辑体验对齐（用户选项，2026-09-14）。
      // 其余类型（图片 / 文件 / 链接 / 待办…）仍默认不显示标题行 —— 它们的"标题"
      // 是 caption / 文件名 / 清单标题，不该平白多一条空标题带。
      showTitle: type === 'note' || type === 'syncNote',
      title: '',
      // 新卡默认**不在**演示路径里（J-07）：一建卡就编进演示顺序，"编过序"与
      // "没编过"就分不清了 —— 而"一张都没编时按阅读顺序讲全部"这条隐式回退
      // 已经把"零配置也能演示"覆盖掉（见 `model/presentation.ts`）
      presentStep: null,
    },
    baseOverride,
    { content },
  );

  return card as CardOf<T>;
}

export type BoardFileOverrides = {
  meta?: Partial<BoardMeta>;
  view?: Partial<BoardFile['view']>;
  settings?: Partial<BoardFile['settings']>;
  columns?: Column[];
  cards?: Card[];
  /**
   * 白板级脑图（`2.2.0` 收尾 · 模板对接）：模板也能带树 —— 在此之前
   * `createBoardFile` 的 overrides 里没有这一格，于是**内置模板无法包含脑图**
   * （只能靠外部 `board.minds = [...]` 事后补，模板那一路就没法读）。
   *
   * ★ **不传 = 这个键就不存在**（缺席 = 没有脑图，`mindContainers` 那条用例守着它）：
   *   它的缺省不是 `[]` 而是"不写" —— 空白板的文件里不该多一行空数组。
   */
  minds?: Mind[];
  edges?: Edge[];
  groups?: Group[];
  revision?: number;
};

/** 创建一块空白的合法白板（新建白板 / 模板 / 测试夹具都用它） */
export function createBoardFile(overrides: BoardFileOverrides = {}): BoardFile {
  const now = new Date().toISOString();
  const { meta, view, settings, ...rest } = overrides;

  return {
    spec: BOARD_SPEC,
    version: BOARD_VERSION,
    revision: 0,
    meta: {
      id: createId(ID_PREFIX.board),
      title: '',
      icon: null,
      createdAt: now,
      updatedAt: now,
      parent: null,
      tags: [],
      aliases: [],
      ...meta,
    },
    view: { x: 0, y: 0, zoom: 1, background: 'dots', ...view },
    settings: {
      snapToGrid: true,
      gridSize: 16,
      defaultCardColor: '1',
      readOnly: false,
      ...settings,
    },
    columns: [],
    cards: [],
    edges: [],
    groups: [],
    // ★ 这里**没有** `minds: []`：它由 `...rest` 在"传了才写"（见 overrides 的说明）
    ...rest,
  };
}

export type ColumnOverrides = Partial<Omit<Column, 'id'>>;

export function createColumn(overrides: ColumnOverrides = {}): Column {
  return {
    id: createId(ID_PREFIX.column),
    title: '',
    x: 0,
    y: 0,
    ...DEFAULT_COLUMN_SIZE,
    collapsed: false,
    // ★ 分栏默认白色（用户 2026-09-18："分栏要允许设置颜色，默认还是现在的白色"）
    color: '#ffffff',
    z: 1,
    ...overrides,
  };
}

export type EdgeOverrides = Partial<Omit<Edge, 'id' | 'from' | 'to'>>;

/** 创建连线。端点形状默认与 JSON Canvas 一致：`fromEnd: none` / `toEnd: arrow` */
export function createEdge(
  from: EdgeEndpoint,
  to: EdgeEndpoint,
  overrides: EdgeOverrides = {},
): Edge {
  return {
    id: createId(ID_PREFIX.edge),
    from,
    to,
    fromEnd: 'none',
    toEnd: 'arrow',
    style: 'solid',
    color: '1',
    label: '',
    routing: 'free',
    ...overrides,
  };
}

export function createGroup(cardIds: string[], label = ''): Group {
  return { id: createId(ID_PREFIX.group), cardIds: [...cardIds], label };
}

export type MindOverrides = Partial<Omit<Mind, 'id'>>;

/**
 * 在白板上放一棵脑图（`2.2.0`）。
 *
 * ★ 默认 `path: ''` + **不带模型**：真正的内容由调用方给（内嵌的塞 `mind`、
 *   文件的给 `path`）—— 工厂不猜"这一次是哪种"，与新建立即要一份空模型的地方
 *   （工具栏新建）分工清楚：那里显式传 `mind: newMindFile()`。
 * ★ `x/y` 是**根节点中心**（不是左上角）：脑图没有宽高，也就没有"左上角"这回事。
 */
export function createMind(overrides: MindOverrides = {}): Mind {
  return {
    id: createId(ID_PREFIX.mind),
    x: 0,
    y: 0,
    z: 1,
    path: '',
    ...overrides,
  };
}

/** 一份"刚新建"的内嵌脑图模型（中心主题 + `branches` 个空分支） */
export function newMindModel(branches = 3): MindFile {
  return createMindFile({ branches, title: '' });
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

/**
 * 画布上所有元素（含分栏、含脑图）的最大层级，用于新建元素时"放到最上层"。
 *
 * ★ `minds` 是**可选键**（`2.2.0`）：类型上收成 `Pick<…> & { minds?: … }` 之后，
 *   老调用点（只传 `cards`/`columns`）一个字都不用改，而传得全的地方也不会漏算脑图的层。
 */
export function maxZ(
  board: Pick<BoardFile, 'cards' | 'columns'> & Pick<Partial<BoardFile>, 'minds'>,
): number {
  let max = 0;
  for (const card of board.cards) max = Math.max(max, card.z);
  for (const column of board.columns) max = Math.max(max, column.z);
  for (const mind of board.minds ?? []) max = Math.max(max, mind.z);
  return max;
}

export function nextZ(
  board: Pick<BoardFile, 'cards' | 'columns'> & Pick<Partial<BoardFile>, 'minds'>,
): number {
  return maxZ(board) + 1;
}
