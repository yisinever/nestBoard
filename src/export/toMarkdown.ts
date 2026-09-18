/**
 * 导出 Markdown（T1.72 / `F9-01`）—— 把二维画布"拍平"成一篇按阅读顺序的笔记。
 *
 * 为什么需要它：`.nboard` 里的内容（尤其内联便签）**只有打开白板才看得见** ——
 * 搜不到、链不到、反向链接面板里也不出现。导出是把整块板子变成一篇
 * "能搜、能链、能发给别人"的 Markdown 的出口（与「提升为笔记」是两条路：
 * 那个改的是**模型**，这个只产出**一份副本**，画布一个字节都不动）。
 *
 * 线性化三条规则，都是为了"读起来像人写的笔记"：
 *
 * 1. **分栏优先**：分栏是用户亲手写下的结构，所以先按分栏成节，栏内按 `order`
 *    （也就是用户看到的上下顺序，而不是坐标 —— 卡片在栏内是自动排布的，
 *    坐标是结果不是意图）。
 * 2. **散卡殿后**：不属于任何分栏的卡片统一放在最后 —— 它们本来就没有结构，
 *    硬塞进某个分栏是替用户编造顺序。
 * 3. **按阅读顺序排**：分栏之间、散卡之间都按"先分行、行内从左到右"排。
 *    直接按 `y` 排会让并排的两栏因为差几像素而错序（手摆的坐标不可能严丝合缝）。
 *
 * 卡片片段由**卡片类型自己**贡献（`CardTypeRegistry.toMarkdown`）—— 导出层不认识
 * 任何具体类型，将来新增一种卡片时这里一行都不用改。
 */

import type { CardExportContext } from '../cards/registry';
import type { BoardFile, Card } from '../model/schema';
import { t } from '../util/i18n';

/**
 * 导出只需要"把卡片变成一段 Markdown"这**一件事**。
 *
 * 收窄成窄接口而不是直接用 `CardTypeRegistry`：单测里不必造出一整个注册表
 * （那需要实现卡片的全部钩子），传一个 `{ toMarkdown }` 就够了。
 * 生产实现（`CardTypeRegistry`）在结构上天然满足它。
 */
export interface MarkdownCardSource {
  toMarkdown(card: Card, ctx: CardExportContext): string;
}

export interface MarkdownExportOptions {
  /** 这块白板的 Vault 路径 —— 卡片片段可能要用它算相对路径（如 `![[]]`） */
  sourcePath: string;
  /** 是否输出 H1 标题（默认 `true`）；把全文塞进别人笔记里时可以关掉 */
  includeTitle?: boolean;
}

export interface MarkdownExportResult {
  markdown: string;
  /** 真正写进 Markdown 的卡片数 */
  exported: number;
  /** 被跳过的卡片数（类型未注册 / 片段为空） */
  skipped: number;
}

/** 片段之间固定隔一个空行。集中在这里，免得各处拼出 1 个或 3 个空行的差别 */
const BLOCK_GAP = '\n\n';

export function exportBoardToMarkdown(
  board: BoardFile,
  cards: MarkdownCardSource,
  options: MarkdownExportOptions,
): MarkdownExportResult {
  const context: CardExportContext = { sourcePath: options.sourcePath };
  const stats = { exported: 0, skipped: 0 };
  const blocks: string[] = [];

  if (options.includeTitle !== false) {
    // 标题为空是合法的（用户没命名），但导出物总得有个 H1，否则整篇像是缺了头
    blocks.push(`# ${board.meta.title.trim() || t('board.untitled')}`);
  }

  const { byColumn, loose } = bucketCards(board);

  // 分栏按阅读顺序成节。**空分栏也保留标题** —— 结构本身也是用户写下的信息，
  // 一个叫「待办」的空栏导出后凭空消失，用户会以为导出漏了东西。
  for (const column of byReadingOrder(board.columns)) {
    const members = (byColumn.get(column.id) ?? []).sort((a, b) => a.order - b.order);
    const heading = `## ${column.title.trim() || t('column.title.placeholder')}`;
    const body = renderCards(members, cards, context, stats);
    blocks.push(body.length > 0 ? `${heading}${BLOCK_GAP}${body}` : heading);
  }

  if (loose.length > 0) {
    const body = renderCards(byReadingOrder(loose), cards, context, stats);
    if (body.length > 0) {
      // 一块板子全是散卡时不必硬造一个"未分类"节：没有分栏就无所谓"未分类"
      blocks.push(
        board.columns.length > 0 ? `## ${t('export.looseCards')}${BLOCK_GAP}${body}` : body,
      );
    }
  }

  return {
    markdown: `${blocks.join(BLOCK_GAP)}\n`,
    exported: stats.exported,
    skipped: stats.skipped,
  };
}

/**
 * 按 `columnId` 分桶，并把"指向已不存在分栏"的卡片**归进散卡**。
 *
 * 后者是防静默丢失：分栏被删、或文件被外部工具改过时，可能出现 `columnId`
 * 指向一个不存在的分栏的卡片。若按"有 columnId 就不是散卡"处理，这些卡片
 * 既不会出现在任何分栏节里，也不会出现在散卡节里 —— 直接从导出物里消失，
 * 而这正是最难被发现的 bug（用户只会觉得"导出的笔记比白板少东西"）。
 */
function bucketCards(board: BoardFile): { byColumn: Map<string, Card[]>; loose: Card[] } {
  const byColumn = new Map<string, Card[]>();
  const loose: Card[] = [];

  for (const card of board.cards) {
    if (card.columnId === null) {
      loose.push(card);
      continue;
    }
    const bucket = byColumn.get(card.columnId);
    if (bucket) bucket.push(card);
    else byColumn.set(card.columnId, [card]);
  }

  const known = new Set(board.columns.map((column) => column.id));
  for (const [columnId, members] of [...byColumn]) {
    if (known.has(columnId)) continue;
    loose.push(...members);
    byColumn.delete(columnId);
  }

  return { byColumn, loose };
}

/**
 * 按"阅读顺序"排序：先自上而下分行，同一行内自左而右。
 *
 * 分行用**纵向重叠**判定，而不是"`y` 相等"：手摆的坐标不可能严丝合缝对齐，
 * 用相等判定会让并排的两栏因为差 3 像素而错序。单行排布（最常见）的结果
 * 与单纯按 `x` 排序一致，只有多行排布才体现差别。
 */
export function byReadingOrder<T extends { x: number; y: number; height: number }>(
  items: readonly T[],
): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];

  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const rowBottom =
      row === undefined ? Number.NEGATIVE_INFINITY : Math.max(...row.map((it) => it.y + it.height));
    if (row && item.y < rowBottom) row.push(item);
    else rows.push([item]);
  }

  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/**
 * 逐张取片段，空白片段跳过并计数。
 *
 * 「类型未注册」和「内容确实为空」在这里是同一件事（都返回空串）：两者都不该
 * 在导出物里留下一个空行占位。区分它们对用户没有意义，所以只报一个总数。
 */
function renderCards(
  cards: readonly Card[],
  source: MarkdownCardSource,
  context: CardExportContext,
  stats: { exported: number; skipped: number },
): string {
  const pieces: string[] = [];
  for (const card of cards) {
    const piece = source.toMarkdown(card, context).trim();
    if (piece.length === 0) {
      stats.skipped += 1;
      continue;
    }
    stats.exported += 1;
    pieces.push(piece);
  }
  return pieces.join(BLOCK_GAP);
}
