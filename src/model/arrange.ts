/**
 * 版面整理：`F5-06` 自动整理与 `F5-07` 按标签自动分栏（T6.07 / T6.08）。
 *
 * 两个操作的共同点：**只动"块"的位置，不动块里的东西**。分栏的标题 / 成员 / 尺寸、
 * 卡片的大小、`z`、`locked`、演示顺序，一个字节都不改。
 *
 * ── 三条贯穿全文件的纪律 ────────────────────────────────────
 *
 * 1. **必须幂等**：一块已经整齐的板子跑完不该有任何变化（返回 `false` → 不记历史 →
 *    `revision` 不动 → 不触发外部同步）。这是本文件最强的正确性信号 ——
 *    "整理"能毁掉的东西太多了（分组、间距意图、用户拖出来的尺寸），
 *    所以判断"要不要动"时一律**先比对再写**，与 `model/ops.ts` 同一条规矩。
 * 2. **不碰"派生几何"**：栏内成员的 `x/y/width` 由分栏算出来（`03 §2.6`），
 *    因此整理只移动分栏本身，成员交给 `relayoutColumns()` 兜底；
 *    `boardBlocks()` 也**只**收集栏外的卡片，从源头上不给"把成员拖出栏"的机会。
 * 3. **锁定 = 不要动**：`card.locked` 的散卡一律不参与（与 `alignCards` / `distributeCards`
 *    在 `model/ops.ts` 里跳过锁定卡片完全一致）。用户锁住一张卡就是在说
 *    "别碰它"，整理不该是例外。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM，可在 node 下单测。
 */

import { boundsOf, roundTo } from '../util/geometry';
import {
  COLUMN_LAYOUT,
  alignSiblingColumns,
  cardsInColumn,
  columnById,
  columnDisplayHeight,
  createColumnAt,
  growColumnToFit,
  insertCardsIntoColumn,
  relayoutColumns,
} from './columns';
import { applyCardRects, cardById, type CardRect } from './ops';
import type { BoardFile, Card } from './schema';
import { tagKeyOf, tagsOfCard } from './tags';

// ─────────────────────────────────────────────────────────────
// 版式常量
// ─────────────────────────────────────────────────────────────

/**
 * 整理版式。
 *
 * ★ 间距与 `COLUMN_LAYOUT.siblingGap` **取同一个数**（24）：用户在同一个画布上看到的
 *   "并排两块之间的空当"只该有一个数，为这个功能另发明一个 32 或 40 只会让排出来的
 *   板子在"分栏生成的排版"和"整理出来的排版"之间来回抖。
 * ★ 这个数还有一个硬约束：`areSiblings()`（`model/columns.ts`）判定同级关系的门限是
 *   `siblingGap * 2 = 48`。整理完的一排必须落在这个门限内 —— 否则用户接着按
 *   "对齐同级分栏"会得到"它们不是同级"，那等于整理把这个功能弄坏了。
 */
export const ARRANGE_LAYOUT = {
  /** 行内块之间、行与行之间的间距 */
  gap: COLUMN_LAYOUT.siblingGap,
} as const;

// ─────────────────────────────────────────────────────────────
// 自动整理（T6.07 / F5-06）
// ─────────────────────────────────────────────────────────────

/**
 * 整理的最小单位：**一个分栏**，或**一组要一起搬的散卡**。
 *
 * 分栏是一整块（它的成员、标题、尺寸都跟着它走）；散卡默认一张一块，
 * 但**成员全在栏外的编组**整块搬 —— 把编组拆散会让用户辛苦框出来的那组东西
 * 在视觉上散开，那不是"整理"。
 */
export interface ArrangeBlock {
  /** 稳定键（分栏 id / 编组 id / 卡片 id），只用于排序兜底与单测定位 */
  key: string;
  /** 分栏块才有值；非空时 `cardIds` 必为空 */
  columnId: string | null;
  /** 要一起平移的卡片；分栏块为空（成员几何由 `relayoutColumns` 兜） */
  cardIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 列出这块板上"能整块搬"的单位（见 {@link ArrangeBlock}）。
 *
 * ★ 栏内成员**不在**返回值里：它们的几何是派生状态，搬它们等于绕过分栏
 *   （而且整理完 `relayoutColumns` 会把它们弹回栏内，白改一场）。
 * ★ 锁定卡片不在返回值里：它们留在原处，因此整理后可能与别的块重叠 ——
 *   这是刻意接受的代价，"锁住还是能被整理挪走"比"整理结果略有重叠"严重得多。
 */
export function boardBlocks(board: BoardFile): ArrangeBlock[] {
  const blocks: ArrangeBlock[] = [];

  for (const column of board.columns) {
    blocks.push({
      key: column.id,
      columnId: column.id,
      cardIds: [],
      x: column.x,
      y: column.y,
      width: column.width,
      height: columnDisplayHeight(column),
    });
  }

  // 栏外且未锁定的卡片：编组整块搬，其余的各自成块
  const loose = new Map<string, Card>();
  for (const card of board.cards) {
    if (card.columnId !== null || card.locked) continue;
    loose.set(card.id, card);
  }

  for (const group of board.groups) {
    const members = group.cardIds
      .map((id) => loose.get(id))
      .filter((card): card is Card => card !== undefined);
    // 只处理"成员全都在栏外且没锁"的编组。有一个成员在栏里，它的几何就不是
    // 自己能定的 —— 整块搬会把它从栏里拖出来，正好违反约定 2
    if (members.length < 2 || members.length !== group.cardIds.length) continue;
    const rect = boundsOf(members);
    if (!rect) continue;

    blocks.push({
      key: group.id,
      columnId: null,
      cardIds: members.map((card) => card.id),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    for (const member of members) loose.delete(member.id);
  }

  for (const card of loose.values()) {
    blocks.push({
      key: card.id,
      columnId: null,
      cardIds: [card.id],
      x: card.x,
      y: card.y,
      width: card.width,
      height: card.height,
    });
  }

  return blocks;
}

/** 阅读顺序：上→下、左→右，最后用稳定键兜底 */
function byReadingOrder(
  a: { y: number; x: number; key: string },
  b: { y: number; x: number; key: string },
): number {
  return a.y - b.y || a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * 两块是否横向"压在一起"。
 *
 * 判据是"重叠超过较窄一块的**一半**"，不是"有没有重叠"：
 * 并排的两张卡稍微错开一点（重叠几十像素）在画布上是常态，那是"并排、没对齐"，
 * 左右拉开就行；而重叠过半就是"一张压在另一张上"，该上下分开。
 * 这条线是启发式，但它是分行判定的**唯一**模糊之处，所以写在这里、写在测试里。
 */
function overlapsHorizontally(a: ArrangeBlock, b: ArrangeBlock): boolean {
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return overlap > Math.min(a.width, b.width) / 2;
}

/** 两块纵向是否"挨着"：区间相交，或上下只隔 `slack` 以内 */
function verticallyAdjacent(a: ArrangeBlock, b: ArrangeBlock, slack: number): boolean {
  return a.y < b.y + b.height + slack && b.y < a.y + a.height + slack;
}

/**
 * 这块能不能并进这一行。
 *
 * ── 两条规则 ────────────────────────────────────────────────
 * 1. **横着挨着**才算并排：与行内某一块纵向挨着、且**没有**横向压在一起。
 *    上半条容得下"手抖没对齐"的一排（顶边差 30px 也还是同一排），
 *    下半条拦住"同一竖列里上下两张卡" —— 它们横向压在一起，是上下关系而不是并排。
 * 2. **不许跨过正上方那张卡**：如果这一行里已经有一张卡与它横向压在一起、
 *    且那张卡在它上面，那它属于**下一行**。少了这条，一块高卡旁边的下方卡片
 *    会被吸进同一行、横着跨过高卡，凭空改掉"谁在谁下面"。
 *
 * ★ 只与**当前行**比较（调用方传的就是最后一行）：块已按阅读顺序扫过，
 *   要并进的那一行必然是"刚扫出来的那一行"。
 */
function canJoinRow(row: readonly ArrangeBlock[], block: ArrangeBlock, slack: number): boolean {
  const beside = row.some(
    (member) => verticallyAdjacent(block, member, slack) && !overlapsHorizontally(block, member),
  );
  if (!beside) return false;

  return !row.some((member) => overlapsHorizontally(member, block) && member.y < block.y);
}

/**
 * 按"看不看得见地并排"分行（规则见 {@link canJoinRow}）。
 *
 * ── 为什么不能用更简单的两种判据 ────────────────────────────
 * - **"顶边差不超过 N"**：N 取小了，一排列整齐但错开 100px 的卡会被拆成两行；
 *   取大了，间距 100px 的两行会被并成一行。绝对像素值区分不了这两件事，
 *   因为区别不在"差多少"，而在**横向是不是压在一起**。
 * - **"纵向区间相交"**：一列上下紧挨着的卡（间距 20px）会横向摊成一排，
 *   而那些卡本来是"上下叠放"的。
 *
 * 行内只有一块时，整理的结果就是**竖着往下排**，间距统一 ——
 * 这正好落在"按分栏垂直重排"这句需求上。
 */
function groupRows(blocks: readonly ArrangeBlock[], slack: number): ArrangeBlock[][] {
  const sorted = [...blocks].sort(byReadingOrder);
  const rows: ArrangeBlock[][] = [];

  for (const block of sorted) {
    const row = rows[rows.length - 1];
    if (row && canJoinRow(row, block, slack)) row.push(block);
    else rows.push([block]);
  }

  return rows;
}

export interface TidyOptions {
  /** 行内 / 行间的间距，默认 {@link ARRANGE_LAYOUT.gap} */
  gap?: number;
}

/**
 * 把整块板子排成整齐的行列（T6.07 / `F5-06`，命令「自动整理」）。
 *
 * ── 它做什么 ────────────────────────────────────────────────
 * 1. 把所有"能整块搬"的单位（分栏、栏外的编组、栏外的单卡）按阅读顺序读进来；
 * 2. 按"看不看得见地并排"分成若干行（见 `groupRows` / `canJoinRow`）；
 * 3. 每一行内部：按左→右排开，**顶部对齐**，块与块之间统一 `gap`；
 * 4. 行与行之间：上一行最高的一块之下 `gap` 处另起一行，**左边全部对齐到同一条竖线**。
 *
 * ── 它不做什么（都是刻意的） ────────────────────────────────
 * - **不改块的尺寸**：分栏不会被压窄或拉宽，卡片不会被缩放（`alignSiblingColumns`
 *   那种"等宽"是分栏自己的命令，不是整理该顺手做的事）；
 * - **不动栏内成员的归属与顺序**：栏里是用户自己排的，整理只把栏搬到别处；
 * - **不动锁定卡片**：它们留在原地（因此可能与整理后的版面重叠）；
 * - **不重新排序**：行与行、行内的次序都跟着"原来在哪"走，
 *   用户的上下左右关系是意图，位置才是混乱。
 *
 * ★ 幂等：已经整齐的板子返回 `false`（见文件头约定 1）。最直观的验证是
 *   "连按两次自动整理，第二次不该产生历史记录"。
 *
 * @returns 是否真的改动了模型
 */
export function tidyBoard(board: BoardFile, options: TidyOptions = {}, digits = 2): boolean {
  const gap = options.gap ?? ARRANGE_LAYOUT.gap;
  const blocks = boardBlocks(board);
  // 一块没有什么可整的：返回 false 而不是"原地写一遍"，否则每次按都多一条历史记录
  if (blocks.length < 2) return false;

  // 整块版面**左上角不动**：整理只该让它变密、变齐，不该让它从画布的一头搬到另一头
  let cursorY = roundTo(Math.min(...blocks.map((block) => block.y)), digits);
  const originX = roundTo(Math.min(...blocks.map((block) => block.x)), digits);

  const cardRects: CardRect[] = [];
  let movedColumns = false;

  for (const row of groupRows(blocks, gap)) {
    let cursorX = originX;
    for (const block of row) {
      const targetX = cursorX;
      const targetY = cursorY;

      if (block.columnId !== null) {
        const column = columnById(board, block.columnId);
        if (column) {
          if (column.x !== targetX) {
            column.x = targetX;
            movedColumns = true;
          }
          if (column.y !== targetY) {
            column.y = targetY;
            movedColumns = true;
          }
        }
      } else {
        // 位移量由这一块自己的左上角算：编组整块搬，成员之间的相对位置一个像素都不变
        const dx = roundTo(targetX - block.x, digits);
        const dy = roundTo(targetY - block.y, digits);
        for (const id of block.cardIds) {
          const card = cardById(board, id);
          if (!card) continue;
          cardRects.push({
            id,
            x: roundTo(card.x + dx, digits),
            y: roundTo(card.y + dy, digits),
            width: card.width,
            height: card.height,
          });
        }
      }

      cursorX = roundTo(cursorX + block.width + gap, digits);
    }

    const rowHeight = Math.max(...row.map((block) => block.height));
    cursorY = roundTo(cursorY + rowHeight + gap, digits);
  }

  let changed = applyCardRects(board, cardRects, digits);
  if (movedColumns) changed = true;

  // 移动过的分栏：成员几何是派生状态，跟着栏走（与 `alignSiblingColumns` 同样的收尾）
  if (movedColumns && relayoutColumns(board, digits)) changed = true;
  return changed;
}

// ─────────────────────────────────────────────────────────────
// 按标签自动分栏（T6.08 / F5-07）
// ─────────────────────────────────────────────────────────────

/**
 * 一个标签至少要出现在几张卡上，才配单独开一栏。
 *
 * 取 2 而不是 1：一张卡一个标签的板子上，"一键分栏"会造出十几个只有一张卡的栏，
 * 比整理前更乱 —— 而用户按这个命令要的是"把同类的聚起来"。
 */
export const MIN_TAG_GROUP = 2;

/** 一个即将生成（或复用）的标签分栏 */
export interface TagColumnPlan {
  /** 归一化键（小写），分组用 */
  key: string;
  /** 栏标题用的写法：卡片里**第一次出现**的那个拼写 */
  label: string;
  /** 要收进这一栏的卡片 id，按阅读顺序（上→下、左→右） */
  cardIds: string[];
  /** 已经有同名分栏时填它的 id（收进去，不新建）；否则 `null` */
  columnId: string | null;
}

/** 分栏标题与标签的归一化：`#项目` / `项目` / ` ＃项目 ` 都算同一个 */
function titleKeyOf(title: string): string {
  return tagKeyOf(title.trim().replace(/^#+/, ''));
}

/**
 * 算出"按标签分栏"要做的事，**不改模型**（T6.08）。
 *
 * ── 归属规则（一张卡只能在一个栏里，因为 `card.columnId` 是单值） ──
 * - 一张卡有多个标签时，只认**第一个**：顺序是"标题里的标签优先，然后正文里先写的"
 *   （见 `tagsOfCard`）。标题是用户给这张卡下的定义，正文里可能只是随手提了一句。
 * - **只收栏外的卡片**：已经在你手划的分栏里的卡片一张都不动 ——
 *   拆掉用户自己设的分组，是"整理"里最不可逆的一种破坏。
 * - **锁定卡片不动**（文件头约定 3）。
 * - 已有同名分栏（`#项目` / `项目` 都认）就收进去，不新建：否则第二次按这个命令
 *   会得到一套重复的栏。
 *
 * @returns 按"卡片多的在前、同数按标签名"排好的计划；无可用标签时返回空数组
 */
export function planTagColumns(board: BoardFile): TagColumnPlan[] {
  const byKey = new Map<string, TagColumnPlan>();

  for (const card of board.cards) {
    if (card.columnId !== null || card.locked) continue;
    const primary = tagsOfCard(card)[0];
    if (primary === undefined) continue;

    const key = tagKeyOf(primary);
    const existing = byKey.get(key);
    if (existing) {
      existing.cardIds.push(card.id);
      continue;
    }
    byKey.set(key, { key, label: primary, cardIds: [card.id], columnId: null });
  }

  const groups = [...byKey.values()].filter((plan) => plan.cardIds.length >= MIN_TAG_GROUP);

  for (const plan of groups) {
    const match = board.columns.find((column) => titleKeyOf(column.title) === plan.key);
    if (match) plan.columnId = match.id;
  }

  const positionOf = new Map(board.cards.map((card) => [card.id, card] as const));
  const readingOrder = (a: string, b: string): number => {
    const left = positionOf.get(a);
    const right = positionOf.get(b);
    if (!left || !right) return 0;
    return left.y - right.y || left.x - right.x || (a < b ? -1 : a > b ? 1 : 0);
  };

  for (const plan of groups) plan.cardIds.sort(readingOrder);

  return groups.sort(
    (a, b) => b.cardIds.length - a.cardIds.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

export interface TagColumnsResult {
  /** 是否真的改动了模型 */
  changed: boolean;
  /** 新建的分栏数 */
  created: number;
  /** 收进**已有**同名分栏的组数 */
  reused: number;
  /** 每个受影响的栏：标签写法 + 收进去的卡片数（顺序同 `planTagColumns`） */
  groups: { label: string; count: number }[];
}

/** 现有内容的左边界与下边界（新栏放它们下面，见 `columnsByTag`） */
function contentBounds(board: BoardFile): { left: number; bottom: number } {
  let left = Number.POSITIVE_INFINITY;
  let bottom = 0;

  for (const card of board.cards) {
    left = Math.min(left, card.x);
    // 栏内成员的 y 在栏里，不参与下边界 —— 否则会把栏高之外的位置也算进来
    if (card.columnId === null) bottom = Math.max(bottom, card.y + card.height);
  }
  for (const column of board.columns) {
    left = Math.min(left, column.x);
    bottom = Math.max(bottom, column.y + columnDisplayHeight(column));
  }

  return { left: Number.isFinite(left) ? roundTo(left) : 0, bottom: roundTo(bottom) };
}

/** 新栏与既有内容的纵向间隔：取 `siblingGap * 2`，正好越过 `areSiblings` 的"相遇"判定 */
const NEW_ROW_GAP = COLUMN_LAYOUT.siblingGap * 2;

/**
 * 把散落的、带同一个标签的卡片收进分栏（T6.08 / `F5-07`，命令「按标签分栏」）。
 *
 * 新栏放在既有内容**下方**、横着排开：放右边要先算"右侧有没有空"，
 * 而下方的排布**永远不重叠**，而且一眼就能看出"这是刚生成的"。
 * 生成完顺手做一次 `alignSiblingColumns`（等宽 + 顶部对齐）——
 * 每栏的宽度是各自卡片算出来的，不做这一步这一排会参差不齐
 * （与 `splitIntoColumns` 同一个理由、同一个收尾）。
 *
 * @returns 摘要；无事可做时 `changed === false`
 */
export function columnsByTag(board: BoardFile, digits = 2): TagColumnsResult {
  const plan = planTagColumns(board);
  if (plan.length === 0) return { changed: false, created: 0, reused: 0, groups: [] };

  const { padding, minWidth, siblingGap } = COLUMN_LAYOUT;
  const bounds = contentBounds(board);
  const startY = roundTo(bounds.bottom + (bounds.bottom > 0 ? NEW_ROW_GAP : 0), digits);

  const fresh = plan.filter((item) => item.columnId === null);
  const createdIds: string[] = [];
  let cursorX = bounds.left;

  // ★ 先把所有新栏建完，再插卡片：`insertCardsIntoColumn` 会把成员提到"当前最上层"，
  //   期间若还夹着后面要建的分栏，成员就会被后建的分栏盖住（同 `splitIntoColumns`）
  for (const item of fresh) {
    const members = item.cardIds
      .map((id) => cardById(board, id))
      .filter((card): card is Card => card !== null);
    const widest = members.length > 0 ? Math.max(...members.map((card) => card.width)) : 0;
    const width = Math.max(roundTo(widest + padding * 2), minWidth);

    const column = createColumnAt(board, cursorX, startY, {
      width,
      // 高度按内容算，不猜（与 `groupIntoNewColumn` 同一套）
      height: 0,
      title: `#${item.label}`,
    });
    item.columnId = column.id;
    createdIds.push(column.id);
    cursorX = roundTo(cursorX + width + siblingGap, digits);
  }

  for (const item of plan) {
    const columnId = item.columnId;
    if (columnId === null) continue;
    // 追加到末尾：复用的那个栏里原有的顺序不该被这行命令改掉
    insertCardsIntoColumn(
      board,
      item.cardIds,
      columnId,
      cardsInColumn(board, columnId).length,
      digits,
    );
    growColumnToFit(board, columnId, 0, digits);
  }

  alignSiblingColumns(board, createdIds, digits);

  return {
    changed: true,
    created: createdIds.length,
    reused: plan.length - createdIds.length,
    groups: plan.map((item) => ({ label: item.label, count: item.cardIds.length })),
  };
}
