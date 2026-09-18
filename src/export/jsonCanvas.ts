/**
 * `.nboard` ↔ JSON Canvas 1.0（`.canvas`）互转（T4.11 / T4.12 / T4.13，`F9-04`、`F9-05`、`03 §7.4`）。
 *
 * 为什么值得做：`.canvas` 是 Obsidian 自带、别的插件与别的工具都认识的中转格式。
 * 有了它，"把这块板子给别人看"不必要求对方也装 Nestboard；反过来，别人给的
 * `.canvas` 也能进来变成一块真白板（而不是一张截图）。
 *
 * ── 四条刻意设计 ──────────────────────────────────────────
 *
 * 1. **本文件不 import obsidian 的运行时导出**（只用 `import type`），
 *    于是互转规则能在 node 下单测 —— 而这里的规则恰恰是最需要单测的部分：
 *    它要处理的是"别人写的文件"，那种文件不会按我们的期望长。
 * 2. **卡片侧只依赖一个窄接口** `{ toMarkdown(card, ctx) }`（与 `export/toMarkdown.ts`
 *    同一约定）。于是"JSON Canvas 没有对应类型"的卡片能用**卡片自己的** Markdown
 *    形态降级，而不是在这一层另编一套 —— 将来新增卡片类型，这里一行都不用改。
 * 3. **`color` 直接原样传递**：`ThemeColor` 就是 `'1'..'6'`，与 JSON Canvas 的
 *    `color` 同语义（见 `util/color.ts` 的文件头），十六进制也两边都合法。
 *    真正没有对应物的是 `accent`（左侧强调色条）、`rotation`（卡片旋转，T7.06）、
 *    `style: dashed`、`routing`，它们只能丢 —— 这属于**必须被说出来的损失**（见 `plan.dropped`）。
 * 4. **双向都"宁可少要，不可错认"**：认不出的节点/连线一律跳过并计数报给用户，
 *    绝不猜（例如未知 `type` 不当成便签卡）。导入端尤其如此：它面对的是
 *    别人写的数据，一个猜错的映射比少导入一张卡难查得多。
 */

import { CARD_TYPE_LABEL_KEY } from '../cards/registry';
import { COLUMN_LAYOUT, growColumnToFit, insertCardsIntoColumn } from '../model/columns';
import { dropKindForPath } from '../model/drop';
import { createBoardFile, createCard, createColumn, createEdge } from '../model/factories';
import type {
  BoardFile,
  Card,
  CardColor,
  CardType,
  Column,
  Edge,
  EdgeEnd,
  EdgeSide,
  ThemeColor,
} from '../model/schema';
import { THEME_COLORS } from '../model/schema';
import { t } from '../util/i18n';

// ─────────────────────────────────────────────────────────────
// JSON Canvas 1.0 的类型（自足定义）
// ─────────────────────────────────────────────────────────────

// ★ 自己定义而不是引第三方包：互转是插件的核心能力之一，不该因为上游包改名、
//   改协议、或不再维护就跟着坏掉。这里用到的字段总共二十来个，也不值得引一个包。

export type JsonCanvasSide = 'top' | 'right' | 'bottom' | 'left';

export type JsonCanvasEnd = 'none' | 'arrow';

export type JsonCanvasGroupStyle = 'cover' | 'ratio' | 'repeat';

export interface JsonCanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `"1"`~`"6"` 或 `#RRGGBB` */
  color?: string;
}

export interface JsonCanvasTextNode extends JsonCanvasNodeBase {
  type: 'text';
  text: string;
}

export interface JsonCanvasFileNode extends JsonCanvasNodeBase {
  type: 'file';
  file: string;
  subpath?: string;
}

export interface JsonCanvasLinkNode extends JsonCanvasNodeBase {
  type: 'link';
  url: string;
}

export interface JsonCanvasGroupNode extends JsonCanvasNodeBase {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: JsonCanvasGroupStyle;
}

export type JsonCanvasNode =
  JsonCanvasTextNode | JsonCanvasFileNode | JsonCanvasLinkNode | JsonCanvasGroupNode;

export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: JsonCanvasSide;
  fromEnd?: JsonCanvasEnd;
  toNode: string;
  toSide?: JsonCanvasSide;
  toEnd?: JsonCanvasEnd;
  color?: string;
  label?: string;
}

export interface JsonCanvasFile {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
}

// ─────────────────────────────────────────────────────────────
// 公共小工具
// ─────────────────────────────────────────────────────────────

const THEME_COLOR_SET: ReadonlySet<string> = new Set(THEME_COLORS);

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** 合法的卡面颜色（`ThemeColor` 或十六进制）。认不出就回落到默认色，不抛错 */
function colorOf(value: unknown, fallback: CardColor = '1'): CardColor {
  if (typeof value !== 'string') return fallback;
  if (THEME_COLOR_SET.has(value)) return value as ThemeColor;
  if (HEX_COLOR_RE.test(value)) return value.toLowerCase();
  return fallback;
}

/** 画布上的整数尺寸。★ 下限 1：0 或负数的节点在 `.canvas` 里没法选中，等于丢了一张卡 */
function sizeOf(value: number): number {
  return Math.max(1, Math.round(value));
}

/** z 升序（下标相同时按 id）—— **必须可复现**：同一块板子导出两次要给出一模一样的文件 */
function byZ(a: { z: number; id: string }, b: { z: number; id: string }): number {
  if (a.z !== b.z) return a.z - b.z;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
// 导出：`.nboard` → `.canvas`（T4.11 / T4.13）
// ─────────────────────────────────────────────────────────────

/** 卡片侧只需要这一个能力（与 `export/toMarkdown.ts` 的 `MarkdownCardSource` 同一约定） */
export interface CanvasCardSource {
  toMarkdown(card: Card, ctx: { sourcePath: string }): string;
}

/**
 * 降级计数：卡片 → `text` 节点。
 *
 * `03 §7.4` 点名了四种"JSON Canvas 没有对应类型"的卡片 —— **待办 / 色板 / 白板卡 / 手绘**；
 * 此外**内容为空**的卡片（没路径的图片卡、没 URL 的链接卡）也只能变成一段文字。
 * 两种都记在同一个表里：对用户来说它们是同一件事（"这张卡不会以原样过去"），
 * 而 `type` 字段已经说清是哪一种了。
 *
 * `ink` 单独说一句：它的 `toMarkdown` **恒为空串**（矢量笔迹没有 Markdown 形态，
 * 见 `cards/ink.ts` 的注释），所以它总会落到"占位文本"那一支 —— 这是诚实的：
 * 画布上会出现一个写着"手绘卡"的方框，而不是一个看不见的空框。
 */
export interface CanvasDegradation {
  type: CardType;
  count: number;
}

export interface CanvasExportPlan {
  canvas: JsonCanvasFile;
  /** 序列化后的成品（含结尾换行），视图直接拿去写文件 */
  text: string;
  /** 卡片 → 节点 */
  nodes: number;
  /** 分栏 → group */
  groups: number;
  edges: number;
  /**
   * 因**自由端**被丢掉的连线（`03 §7.4` 列举的损失之一）。
   *
   * JSON Canvas 的端点必须指向某个节点，而我们允许"一头悬空"（`cardId === ''`），
   * 这种线在画布上是有意义的（"这里还要接点什么"），但 `.canvas` 表达不了。
   */
  droppedEdges: number;
  /** 类型降级（四种），按**数量降序**，数量相同按类型名排列（顺序稳定可测） */
  degraded: readonly CanvasDegradation[];
  /** 内容为空、只能留一句占位文本的节点数 */
  placeholders: number;
  /**
   * 折叠着的分栏数（`03 §7.4` 明写的"已知有损"）：`.canvas` 的 `group` 没有折叠概念，
   * 对面打开时这些分栏是展开的。
   */
  collapsedColumns: number;
  /**
   * 纯外观修饰的处数：卡片的强调色条（`accent`）+ 虚线连线 / 智能走线。
   *
   * ★ 这一类**没有**对应物（规范里既没有 `accent`，也没有 line style / routing），
   *   所以只能丢。列出来是因为"我特意选的颜色没了"是用户会察觉、也会在意的变化 ——
   *   但它是**外观**损失，不是内容损失，所以排在清单最末、合成一行。
   * ★ 内容以外的编辑器元数据（卡片锁定、标题显示开关、编辑器模式）**不进这份清单**：
   *   它们描述的是"我们自己的编辑器怎么对待这张卡"，不是画布上的东西 ——
   *   一句"导出会丢锁定"只会让人以为导出不安全（真正影响安全的只有"绝不覆盖原文件"）。
   */
  cosmetic: number;
}

export interface CanvasExportOptions {
  /** 所属白板的 Vault 路径（卡片算相对路径要用，与 Markdown 导出同一个上下文） */
  sourcePath: string;
}

/**
 * 摆出导出计划（不碰文件系统）。
 *
 * ★ 节点顺序 = z 序，且**所有 group 在前**。不是随手定的：在我们的渲染里分栏是
 *   独立一层、永远画在卡片之下（`ColumnLayer` 与 `CardLayer` 是两层），
 *   而 JSON Canvas 用数组下标表达 z 序 —— "先 group 后卡片"才是对板上观感的忠实表达。
 */
export function planCanvasExport(
  board: BoardFile,
  source: CanvasCardSource,
  options: CanvasExportOptions,
): CanvasExportPlan {
  const ctx = { sourcePath: options.sourcePath };
  const degradations = new Map<CardType, number>();
  const counts = { placeholders: 0 };

  const nodes: JsonCanvasNode[] = [
    ...[...board.columns].sort(byZ).map((column): JsonCanvasGroupNode => ({
      id: column.id,
      type: 'group',
      x: Math.round(column.x),
      y: Math.round(column.y),
      width: sizeOf(column.width),
      height: sizeOf(column.height),
      ...(column.title.length > 0 ? { label: column.title } : {}),
      ...(column.color ? { color: column.color } : {}),
    })),
    ...[...board.cards]
      .sort(byZ)
      .map((card) => nodeForCard(card, source, ctx, degradations, counts)),
  ];

  let droppedEdges = 0;
  const edges: JsonCanvasEdge[] = [];
  // ★ 连线**不排序**：模型里的数组顺序就是用户连线的先后，而 `.canvas` 的连线也没有 z 序，
  //   照原样写出去既保序又稳定（同一块板子导出两次给出一模一样的文件）
  for (const edge of board.edges) {
    const canvasEdge = edgeForCanvas(edge);
    if (!canvasEdge) {
      droppedEdges += 1;
      continue;
    }
    edges.push(canvasEdge);
  }

  const canvas: JsonCanvasFile = { nodes, edges };

  return {
    canvas,
    text: serializeCanvas(canvas),
    nodes: board.cards.length,
    groups: board.columns.length,
    edges: edges.length,
    droppedEdges,
    degraded: [...degradations.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
    placeholders: counts.placeholders,
    collapsedColumns: board.columns.filter((column) => column.collapsed).length,
    cosmetic:
      board.cards.filter((card) => card.accent !== null).length +
      // 转过的卡片（T7.06）：JSON Canvas 的节点只有 x/y/width/height，没有角度这回事 ——
      // 转 45° 的卡片在对面是正的。归在"纯外观"而不是"内容降级"：文字、颜色、
      // 连线一条不少，丢掉的只是一个姿态，用户重摆一下就有。
      // ★ 不要试图用外接框（`rotatedBoundsOf`）糊过去：那会让对面的卡片**变大**
      //   而不是变斜 —— 用一个错误换掉另一个错误，比老实丢掉更糟。
      board.cards.filter((card) => (card.rotation ?? 0) !== 0).length +
      // 默认是 `solid` + `free` + 直线，所以"不是默认"就是真的会被丢掉的形态。
      // ★ 弧度（T7.12）也在这一份里：`.canvas` 的连线是直线段，没有控制点可写 ——
      //   一条弯着的线到对面会变直。同理，`label` **不**算损失（规范里有这个字段，
      //   `edgeForCanvas` 已经原样写出去了）。
      board.edges.filter(
        (edge) =>
          edge.style === 'dashed' ||
          edge.routing === 'smart' ||
          // 「曲线」走线也落在这一份里：`.canvas` 的连线是直线段，
          // 自动弧过去会变直（与手工弧度是同一类损失）
          edge.routing === 'curve' ||
          edge.curve != null,
      ).length,
  };
}

/** 序列化。★ 与 Obsidian 自己写的 `.canvas` 对齐（Tab 缩进 + 结尾换行）：导出的文件多半要进 git */
export function serializeCanvas(canvas: JsonCanvasFile): string {
  return `${JSON.stringify(canvas, null, '\t')}\n`;
}

/**
 * 把 {@link CanvasExportPlan} 里的损失翻成**给用户看的一行行话**（T4.13）。
 *
 * ★ 抽成纯函数放在这里、而不是写在对话框里：这是"损失清单"这个功能的全部内容 ——
 *   对话框只负责把它摆出来。它也能在 node 下单测，而对话框不能（那要 Obsidian 运行时）。
 * ★ 顺序固定，按"用户有多该在意"排：类型降级 → 占位文本 → 悬空连线（**内容**的损失）
 *   → 折叠分栏（状态） → 外观修饰。内容排在最前，是因为外观损失看得见、能重做，
 *   内容损失往往要到对面用起来才发现。
 * ★ 返回空数组 = **没有损失**，调用方据此显示那句"不会有损失"。
 */
export function describeCanvasLosses(plan: CanvasExportPlan): string[] {
  const lines: string[] = [];

  for (const item of plan.degraded) {
    lines.push(
      t('modal.exportCanvas.degraded', {
        count: item.count,
        type: t(CARD_TYPE_LABEL_KEY[item.type]),
      }),
    );
  }
  if (plan.placeholders > 0) {
    lines.push(t('modal.exportCanvas.placeholders', { count: plan.placeholders }));
  }
  if (plan.droppedEdges > 0) {
    lines.push(t('modal.exportCanvas.droppedEdges', { count: plan.droppedEdges }));
  }
  if (plan.collapsedColumns > 0) {
    lines.push(t('modal.exportCanvas.collapsedColumns', { count: plan.collapsedColumns }));
  }
  if (plan.cosmetic > 0) {
    lines.push(t('modal.exportCanvas.cosmetic', { count: plan.cosmetic }));
  }

  return lines;
}

function nodeForCard(
  card: Card,
  source: CanvasCardSource,
  ctx: { sourcePath: string },
  degradations: Map<CardType, number>,
  counts: { placeholders: number },
): JsonCanvasNode {
  const base: JsonCanvasNodeBase = {
    id: card.id,
    x: Math.round(card.x),
    y: Math.round(card.y),
    width: sizeOf(card.width),
    height: sizeOf(card.height),
    color: card.color,
  };

  switch (card.type) {
    case 'note':
      return { ...base, type: 'text', text: noteText(card) };
    // 同步便签（T7.04）在画布上也是文本节点；标题下沉规则与便签完全一致
    case 'syncNote':
      return { ...base, type: 'text', text: noteText(card) };
    // 评论卡（T7.05）同理：整条线程按顺序落成一段文字（条目之间空一行），
    // 并复用 `noteText` 的"标题下沉"规则 —— 卡片上看得见的标题必须跟着走
    case 'comment':
      return {
        ...base,
        type: 'text',
        text: noteText({
          ...card,
          content: { md: card.content.entries.map((entry) => entry.text).join('\n\n') },
        }),
      };
    case 'noteRef': {
      const path = card.content.path.trim();
      if (path.length > 0) {
        const subpath = card.content.subpath;
        return {
          ...base,
          type: 'file',
          file: path,
          ...(subpath !== null && subpath.length > 0 ? { subpath } : {}),
        };
      }
      break;
    }
    // 地图卡（T7.03）与图片卡同理：落到画布上就是那张图。
    // ★ 图钉会丢 —— JSON Canvas 的 `file` 节点没有第二个位置放"标注"，与图片卡的裁剪同待遇
    //   （那条也没进 `cosmetic`：画布上那张图本身是完整的，丢的是我们这一层附加的东西）。
    case 'map':
    case 'image':
    case 'file': {
      const path = card.content.path.trim();
      if (path.length > 0) return { ...base, type: 'file', file: path };
      // ★ O08：贴过链接的地图卡（还没取到图 / 服务商回错）在画布上给一个 `link` 节点，
      //   而不是"降级成一段文字"。它**完整地**表达了这张卡 —— 有什么可降级的。
      //   这也是 JSON Canvas 本来就有的形态，不需要发明新东西。
      if (card.type === 'map') {
        const url = (card.content.sourceUrl ?? '').trim();
        if (url.length > 0) return { ...base, type: 'link', url };
      }
      break;
    }
    case 'link': {
      const url = card.content.url.trim();
      if (url.length > 0) return { ...base, type: 'link', url };
      break;
    }
    default:
      break;
  }

  // ── 降级成文本节点 ──────────────────────────────────────
  // 走到这里有两种情况：**类型本身没有对应物**（`DEGRADED_TYPES` 那四种），
  // 或者**该类型必需的内容是空的**（没路径的图片卡、没 URL 的链接卡）。
  // 两种都算"降级"并计数：它们在画布上都会变成一段文字，用户得知道。
  degradations.set(card.type, (degradations.get(card.type) ?? 0) + 1);

  let text = source.toMarkdown(card, ctx);
  if (text.trim().length === 0) {
    // ★ 空节点在画布上是个选中不了的隐形方框 —— 宁可写一句"这是什么卡"，
    //   至少用户能看见"这里本来有东西"，而不是以为导出漏了一张
    text = t('canvas.node.placeholder', { type: t(CARD_TYPE_LABEL_KEY[card.type]) });
    counts.placeholders += 1;
  }

  return { ...base, type: 'text', text };
}

/**
 * 便签卡的文本。
 *
 * ★ 卡片上**看得见**的标题必须跟着走（`showTitle` 为真时）：`content.md` 里没有它，
 *   而"导出后标题凭空消失"属于当场发现不了的损失 —— 画布上多一张没名字的卡，
 *   用户只会以为是自己当初就没写。`showTitle` 为假时标题是元数据（画布上根本没显示），
 *   不该凭空长出来。
 */
function noteText(card: { content: { md: string }; title: string; showTitle: boolean }): string {
  const md = card.content.md;
  const title = card.title.trim();
  if (!card.showTitle || title.length === 0) return md;
  return md.trim().length > 0 ? `# ${title}\n\n${md}` : `# ${title}`;
}

/** 连线 → `.canvas` 连线。**返回 `null` = 这条线表达不了，只能丢**（自由端） */
function edgeForCanvas(edge: Edge): JsonCanvasEdge | null {
  if (edge.from.cardId.length === 0 || edge.to.cardId.length === 0) return null;

  return {
    id: edge.id,
    fromNode: edge.from.cardId,
    toNode: edge.to.cardId,
    // ★ `side: null`（自动选边）在 JSON Canvas 里就是**省略该字段** —— 语义一致，
    //   照实省略才能让"卡片挪到对方左边时连线自动翻面"这个行为在往返后仍然成立
    ...(edge.from.side !== null ? { fromSide: edge.from.side } : {}),
    ...(edge.to.side !== null ? { toSide: edge.to.side } : {}),
    // 端点形状两边语义完全相同（见 `schema.ts` 的注释），原样传
    fromEnd: edge.fromEnd,
    toEnd: edge.toEnd,
    color: edge.color,
    ...(edge.label.length > 0 ? { label: edge.label } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// 导入：`.canvas` → `.nboard`（T4.12）
// ─────────────────────────────────────────────────────────────

export interface CanvasImportReport {
  /** 造出来的卡片数 */
  cards: number;
  /** `group` → 分栏的个数 */
  columns: number;
  edges: number;
  /** 认不出的节点（缺字段 / 未知 `type`） */
  skippedNodes: number;
  /** 端点找不到节点的连线，以及自由端（`.canvas` 里没有"一头悬空"这种东西） */
  skippedEdges: number;
  /** 出现过的未知节点类型（去重、保持出现顺序），用来在提示里点名 */
  unknownTypes: readonly string[];
}

export type CanvasParseResult =
  { ok: true; canvas: JsonCanvasFile } | { ok: false; reason: 'json' | 'shape' };

export type CanvasImportResult =
  { ok: true; board: BoardFile; report: CanvasImportReport } | { ok: false; reason: 'empty' };

/**
 * 解析 `.canvas` 文本。**只保证"语法 + 顶层形状"**，逐个节点的校验在导入时做。
 *
 * ★ 分成两步是为了让两种失败说得出区别：`json` 是文件坏了（打不开、被截断），
 *   `shape` 是"这压根不是一张 canvas"（比如把 `.json` 改了扩展名）。
 *   两者给用户的提示不一样 —— 前者建议重新导出，后者建议检查文件。
 */
export function parseCanvasFile(raw: string): CanvasParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: 'json' };
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'shape' };
  }

  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.nodes)) return { ok: false, reason: 'shape' };

  return {
    ok: true,
    canvas: {
      nodes: record.nodes as JsonCanvasNode[],
      edges: Array.isArray(record.edges) ? (record.edges as JsonCanvasEdge[]) : [],
    },
  };
}

/**
 * 把一张 `.canvas` 变成一块白板（不碰文件系统，返回模型）。
 *
 * 映射规则（`03 §7.4` 那张表的落地，几条重要的写在下面）：
 *
 * - `text` → 便签卡（正文就是 `text`，**不把 `# 标题` 行抠出来当卡片标题**：
 *   那只是 Markdown 正文的一行，抠掉就改了用户的内容）；
 * - `file` → 按扩展名分派（图片 → 图片卡、`.md` → 引用卡、`.nboard` → 白板卡、
 *   其余 → 文件卡），与"把文件拖进白板"用的是**同一张表**（`model/drop.ts`）；
 * - `link` → 链接卡（只带 URL，不替用户联网抓标题）；
 * - `group` → **分栏**。成员判定用"卡片中心点落在 group 矩形内"，嵌套时取最内层
 *   （我们的分栏不允许嵌套）。
 *
 * ★ 已知的两处形变，都是分栏模型带来的，不是 bug：
 *   成员的精确坐标会被分栏布局重排（栏内是自动堆叠的），且同一栏的成员宽度
 *   会被统一成"最宽的那张"。所以导入后的板子**不该期望像素级还原**。
 */
export function importCanvas(
  canvas: JsonCanvasFile,
  options: { title: string },
): CanvasImportResult {
  const cards: Card[] = [];
  const columns: Column[] = [];
  const edges: Edge[] = [];
  const report = {
    skippedNodes: 0,
    skippedEdges: 0,
    unknownTypes: [] as string[],
  };

  /**
   * 节点 id → **端点 id**（卡片或分栏，`O21`）。
   *
   * ★ 分栏也要进这张表：JSON Canvas 的 `group` 本来就是一个节点，连到 group 上的线
   *   在规范里完全合法。我们自己的导出（`edgeForCanvas`）现在就能写出这样的线，
   *   导入时不认就是**自产自销都往返不了** —— 圆桌一圈回来少一条线，最难归因的一类。
   */
  const endpointIdOfNode = new Map<string, string>();
  /** group 节点 id → 分栏，以及它的矩形（成员判定要用） */
  const groups: { column: Column; rect: Rect }[] = [];

  let z = 0;
  // ★ 逐条按 `unknown` 处理：`canvas.nodes` 的类型只是"我们声明的形状"，
  //   真实的 `.canvas` 可能是手改的 / 别的工具生成的，字段缺一半是常态
  for (const raw of canvas.nodes as unknown[]) {
    z += 1;

    if (!isValidNode(raw)) {
      report.skippedNodes += 1;
      // ★ 只有"类型本身没听说过"才点名。`type: 'text'` 但缺 `height` 的节点同样是跳过，
      //   但那不是"未知类型"—— 把它算进去会让提示说着"未知类型 text"，用户一头雾水
      const type = typeOfNode(raw);
      if (type !== null && !KNOWN_NODE_TYPES.has(type) && !report.unknownTypes.includes(type)) {
        report.unknownTypes.push(type);
      }
      continue;
    }
    const node = raw;

    if (node.type === 'group') {
      const column = createColumn({
        title: typeof node.label === 'string' ? node.label : '',
        x: Math.round(node.x),
        y: Math.round(node.y),
        width: sizeOf(node.width),
        height: sizeOf(node.height),
        z,
      });
      columns.push(column);
      groups.push({
        column,
        rect: { x: node.x, y: node.y, width: node.width, height: node.height },
      });
      // 连到这一栏上的线（`O21`）：与卡片同一个理由，端点 id 进同一张表
      endpointIdOfNode.set(node.id, column.id);
      continue;
    }

    const card = cardForNode(node, z);
    if (!card) {
      report.skippedNodes += 1;
      continue;
    }
    cards.push(card);
    endpointIdOfNode.set(node.id, card.id);
  }

  if (cards.length === 0 && columns.length === 0) return { ok: false, reason: 'empty' };

  // ── 成员归属：按中心点落进哪个 group（嵌套时取最内层） ──
  const membersOf = new Map<string, Card[]>();
  for (const card of cards) {
    const container = innermostGroupOf(card, groups);
    if (!container) continue;
    const members = membersOf.get(container);
    if (members) members.push(card);
    else membersOf.set(container, [card]);
  }

  // ── 连线 ────────────────────────────────────────────────
  for (const raw of canvas.edges as unknown[]) {
    const edge = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const from =
      typeof edge.fromNode === 'string' ? endpointIdOfNode.get(edge.fromNode) : undefined;
    const to = typeof edge.toNode === 'string' ? endpointIdOfNode.get(edge.toNode) : undefined;
    // 指向认不出的节点的线、指向不存在的节点的线 —— 都只能说"跳过"，
    // 而且要点出条数：用户会去 `.canvas` 里数"我明明连了 5 条，怎么只过来 3 条"
    // ★ 指向 `group` 的线**不算**这一堆（`O21`）：它在规范里合法，也被算作端点
    if (!from || !to) {
      report.skippedEdges += 1;
      continue;
    }

    edges.push(
      createEdge(
        { cardId: from, side: sideOf(edge.fromSide) },
        { cardId: to, side: sideOf(edge.toSide) },
        {
          fromEnd: endOf(edge.fromEnd, 'none'),
          toEnd: endOf(edge.toEnd, 'arrow'),
          color: colorOf(edge.color),
          label: typeof edge.label === 'string' ? edge.label : '',
          // 环回自身（from === to）在 `.canvas` 里合法、模型也允许，照建
        },
      ),
    );
  }

  const board = createBoardFile({
    meta: { title: options.title },
    cards,
    columns,
    edges,
  });

  // ── 入栏 + 排布 ─────────────────────────────────────────
  for (const [columnId, members] of membersOf) {
    // 栏内顺序按画布上的 y（再 x、再 id）：那才是用户在 `.canvas` 里看到的上下关系
    members.sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));

    // ★ 顺序要紧：必须**先量宽度、再入栏**。栏内成员的宽度会被统一成"栏宽 - 2×内边距"，
    //   所以一旦入栏，成员原本的宽度就没了（被压成栏宽）—— 那时再量就只能量到压过的值，
    //   分栏永远撑不到"装得下原来的卡"。
    //   分栏得装得下最宽的成员：`.canvas` 里的 group 常常是贴着卡片画的，很容易偏窄。
    const widest = Math.max(...members.map((card) => card.width), 0);
    if (widest > 0) {
      const column = columnOf(board, columnId);
      column.width = Math.max(
        column.width,
        widest + COLUMN_LAYOUT.padding * 2,
        COLUMN_LAYOUT.minWidth,
      );
    }

    // ★ 用模型自己的插入函数（它会处理 `order`、以及"卡的 z 画不到栏上面"时的提升），
    //   不手写这三个字段 —— 那三个字段之间的约定散在 `columns.ts` 的注释里
    insertCardsIntoColumn(
      board,
      members.map((card) => card.id),
      columnId,
      0,
    );
    // 高度只能按入栏后的内容量（`columnContentHeight` 读的是成员的实际排列）
    growColumnToFit(board, columnId, 0);
  }

  return {
    ok: true,
    board,
    report: {
      cards: cards.length,
      columns: columns.length,
      edges: edges.length,
      skippedNodes: report.skippedNodes,
      skippedEdges: report.skippedEdges,
      unknownTypes: report.unknownTypes,
    },
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 造卡片。`file` 节点按扩展名分派；认不出的 → `null` */
function cardForNode(node: JsonCanvasNode, z: number): Card | null {
  const base = {
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: sizeOf(node.width),
    height: sizeOf(node.height),
    z,
    color: colorOf(node.color),
  };

  switch (node.type) {
    case 'text':
      // 导入的纯文本节点不带标题行：它不是"用户新建的便签"，只是把 canvas 文本搬进来；
      // 标题行那条带留给真正的新建路径（createCardAt / createSyncNoteAt，见 factories.ts 默认）
      return createCard('note', { ...base, showTitle: false, content: { md: node.text } });
    case 'link': {
      if (typeof node.url !== 'string' || node.url.trim().length === 0) return null;
      return createCard('link', { ...base, content: { url: node.url.trim() } });
    }
    case 'file': {
      if (typeof node.file !== 'string' || node.file.trim().length === 0) return null;
      const path = node.file.trim();
      const kind = dropKindForPath(path);
      if (kind === 'noteRef') {
        const subpath = typeof node.subpath === 'string' ? node.subpath : '';
        return createCard('noteRef', {
          ...base,
          content: {
            path,
            // ★ 只认规范里的写法（`#` 开头）。没写 `#` 的一律当"没有子路径"，
            //   不去猜用户想指的是"标题"还是"块" —— 猜错了会指向完全不同的位置
            subpath: subpath.startsWith('#') ? subpath : null,
          },
        });
      }
      if (kind === 'image') return createCard('image', { ...base, content: { path } });
      if (kind === 'boardRef') return createCard('boardRef', { ...base, content: { path } });
      return createCard('file', { ...base, content: { path } });
    }
    default:
      return null;
  }
}

/** 中心点落在哪个 group 里（嵌套时取**最内层**，也就是面积最小的那个） */
function innermostGroupOf(
  card: Card,
  groups: readonly { column: Column; rect: Rect }[],
): string | null {
  const centerX = card.x + card.width / 2;
  const centerY = card.y + card.height / 2;

  let best: { id: string; area: number } | null = null;
  for (const { column, rect } of groups) {
    const inside =
      centerX >= rect.x &&
      centerX <= rect.x + rect.width &&
      centerY >= rect.y &&
      centerY <= rect.y + rect.height;
    if (!inside) continue;

    const area = Math.abs(rect.width * rect.height);
    if (!best || area < best.area || (area === best.area && column.id < best.id)) {
      best = { id: column.id, area };
    }
  }
  return best?.id ?? null;
}

function columnOf(board: BoardFile, columnId: string): Column {
  const column = board.columns.find((candidate) => candidate.id === columnId);
  // 分栏是我们刚建的，找不到就是代码错（宁可当场炸，也不要静默算错宽度）
  if (!column) throw new Error(`imported column missing: ${columnId}`);
  return column;
}

/** JSON Canvas 1.0 认识的节点类型（其余一律算"未知类型"，只跳过、不猜） */
const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set(['text', 'file', 'link', 'group']);

/** 取节点声明的类型（只用于"点名未知类型"，不参与校验） */
function typeOfNode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as Record<string, unknown>).type;
  return typeof type === 'string' ? type : null;
}

/** 结构化校验：**不认识的形状一律拒绝**，而不是"尽力而为"地读出一半 */
function isValidNode(value: unknown): value is JsonCanvasNode {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Record<string, unknown>;
  if (typeof node.id !== 'string' || node.id.length === 0) return false;
  if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) return false;
  if (!isFiniteNumber(node.width) || !isFiniteNumber(node.height)) return false;

  switch (node.type) {
    case 'text':
      return typeof node.text === 'string';
    case 'file':
      return typeof node.file === 'string';
    case 'link':
      return typeof node.url === 'string';
    case 'group':
      return true;
    default:
      return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSide(value: unknown): value is JsonCanvasSide {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
}

/** 认不出的选边一律当"自动"（`null`）—— 比猜一个方向安全：自动选边永远画得对 */
function sideOf(value: unknown): EdgeSide {
  return isSide(value) ? value : null;
}

function endOf(value: unknown, fallback: EdgeEnd): EdgeEnd {
  return value === 'none' || value === 'arrow' ? value : fallback;
}
