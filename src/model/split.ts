/**
 * 拆分白板（T2.16 / `02 §8.3`：> 5000 卡「拆分白板」向导的模型层）。
 *
 * 拆板是**破坏性最强的操作**（一次改动动辄几千张卡），所以三件事必须在模型层做死：
 *
 * 1. **计划与实际改造同源**：`splitBoardPlan` 算出来要迁走什么，`applySplitToSource`
 *    就照着删什么。若向导自己再算一遍"哪些卡属于这栏"，两处一旦不一致，
 *    就会写出"卡片既在新板里、又在原板里"这种双份数据。
 * 2. **绝不共享对象引用**：子板与原板是两个独立会话，共用同一个 `Card` 对象会让
 *    改子板顺手改掉原板（`duplicateCards` 踩过同一个坑，见 `ops.ts` 的注释）。
 *    所以子板内容一律深拷贝。
 * 3. **拆完不留悬空引用**：删卡片走 `removeCards`（它连带清理连线与编组成员），
 *    删分栏走 `removeColumn` —— 不自己 `filter` 数组。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM、不读磁盘。落盘与命名由调用方负责。
 */

import { DEFAULT_CARD_SIZES, createBoardFile, createCard, nextZ } from './factories';
import { removeColumn } from './columns';
import { removeCards } from './ops';
import type { BoardFile, Card, Column, Edge, Group } from './schema';
import { roundTo, type Point } from '../util/geometry';

/** 没有分栏可依据时，每块子板收纳多少张卡 */
export const SPLIT_CHUNK_SIZE = 800;

/** 至少能拆成这么多组，拆板才有意义 */
export const SPLIT_MIN_GROUPS = 2;

/** 子板内容的左上留白（世界像素） */
const ORIGIN_PADDING = 40;

/** 多张白板卡挤在同一个位置时依次错开的高度（世界像素） */
const REF_STAGGER = DEFAULT_CARD_SIZES.boardRef.height + 24;

export interface SplitChild {
  /** 子板标题（分栏名；分栏没标题时用调用方给的兜底名） */
  title: string;
  /** 迁走的原分栏 id；按块切分时为 `null` */
  columnId: string | null;
  /** 迁走的卡片 id（按原板顺序） */
  cardIds: string[];
  /** 这批内容在原板上的位置：拆完后在这里插一张指向子板的白板卡 */
  anchor: Point;
}

export interface SplitBoardPlan {
  /** 能拆成 ≥2 组时才为 `true`；`false` 时 UI 要解释原因，而不是给一个空计划 */
  ready: boolean;
  children: SplitChild[];
  /** 留在原板的卡片 id */
  remainingCardIds: string[];
}

export interface SplitPlanOptions {
  /** 分栏没标题 / 按块切分时的兜底名。i18n 由调用方提供 —— 模型层不碰文案 */
  fallbackTitle: (index: number) => string;
}

/**
 * 生成拆板计划。
 *
 * 优先**按分栏拆**：分栏是用户自己划出来的语义分组，拆出来的板天然有名字、有边界。
 * 一块分栏都没有（或全是空栏）时才退化为**按固定块大小切**，保证再大的板也有出路。
 *
 * 只切得出 1 块时 `ready = false`："把整块板原样搬到另一块板"不是拆分，是多此一举。
 *
 * ★ 「该不该主动提拆板」（`02 §8.3` 的 5000 卡线）是策略问题，由 `view/scale.ts`
 *   的档位表决定；这里只回答「能不能拆」，于是 2000~5000 卡的白板也能用同一个向导。
 */
export function splitBoardPlan(board: BoardFile, options: SplitPlanOptions): SplitBoardPlan {
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

  const children: SplitChild[] = [];
  const columns = [...board.columns].sort((a, b) => a.z - b.z);
  for (const column of columns) {
    const members = byColumn.get(column.id);
    // 空栏不迁：迁出去只会多一个空文件，而栏本身没有内容价值
    if (!members || members.length === 0) continue;
    children.push({
      title: column.title.trim() || options.fallbackTitle(children.length),
      columnId: column.id,
      cardIds: members.map((card) => card.id),
      anchor: { x: column.x, y: column.y },
    });
  }

  if (children.length === 0) {
    for (let index = 0; index < loose.length; index += SPLIT_CHUNK_SIZE) {
      const chunk = loose.slice(index, index + SPLIT_CHUNK_SIZE);
      children.push({
        title: options.fallbackTitle(children.length),
        columnId: null,
        cardIds: chunk.map((card) => card.id),
        anchor: topLeftOf(chunk),
      });
    }
  }

  const moved = new Set(children.flatMap((child) => child.cardIds));
  return {
    ready: children.length >= SPLIT_MIN_GROUPS,
    children,
    remainingCardIds: board.cards.filter((card) => !moved.has(card.id)).map((card) => card.id),
  };
}

/**
 * 能拆出多少组 —— 只数不建计划。
 *
 * 命令可用性（`view.canSplitBoard`）每次打开命令面板都会被问到，
 * 为此把 5000 张卡的 id 数组铺一遍纯属浪费；这里只数分栏与非分栏卡的数量。
 */
export function splitGroupCount(board: BoardFile): number {
  const columns = new Set<string>();
  let loose = 0;
  for (const card of board.cards) {
    if (card.columnId === null) loose += 1;
    else columns.add(card.columnId);
  }
  // 有非空分栏就按分栏拆（`columns.size` 即"有成员的栏数"）；否则退化成按块切
  if (columns.size > 0) return columns.size;
  return loose === 0 ? 0 : Math.ceil(loose / SPLIT_CHUNK_SIZE);
}

/**
 * 把一块子板的内容装进一个**全新的** `BoardFile`。
 *
 * 几何整体平移到原点附近：原板上那个坐标可能远在几万像素之外，
 * 直接照抄的话新板一打开是一片空白，用户会以为拆出来的板是空的。
 *
 * `parentPath` 是**源板**路径，写进子板的 `meta.parent`（T1.61 / `F2-8-4`）：
 * 子板就是从源板里分出去的，进子板时面包屑该显示「源板 → 子板」、`⌘U` 该回得去。
 * 源板上那张指向它的白板卡已经把这段关系说给用户看了，模型这边不写就只走了一半。
 *
 * ★ 这个参数**不给默认值**：拆板是唯一知道源板是谁的地方，漏传等于层级链路空转，
 *   而那种 bug 没有任何症状 —— 只是面包屑永远只有一层。
 */
export function buildSplitChildBoard(
  board: BoardFile,
  child: SplitChild,
  title: string,
  parentPath: string | null,
): BoardFile {
  const included = new Set(child.cardIds);
  const cards = clone(board.cards.filter((card) => included.has(card.id)));

  const dx = ORIGIN_PADDING - child.anchor.x;
  const dy = ORIGIN_PADDING - child.anchor.y;
  for (const card of cards) {
    card.x += dx;
    card.y += dy;
  }

  const columns: Column[] = [];
  if (child.columnId !== null) {
    const source = board.columns.find((column) => column.id === child.columnId);
    if (source) {
      const column = clone([source])[0] as Column;
      column.x += dx;
      column.y += dy;
      column.z = 1;
      // ★ 不继承退化态：原板可能因为"太大"被默认折叠，子板是小板，打开就该看到内容
      column.collapsed = false;
      columns.push(column);
    }
  }

  // 连线：自由端点（`cardId` 为空）不算悬空，只要另一端留在子板里就保留
  const kept = (cardId: string): boolean => cardId === '' || included.has(cardId);
  const edges = clone(
    board.edges.filter((edge: Edge) => kept(edge.from.cardId) && kept(edge.to.cardId)),
  );

  // 编组：只保留**整组**都在子板里的。成员被拆散就整组丢掉 ——
  // 半个编组在两边各显示一半，比没有编组更让人困惑
  const groups = clone(
    board.groups.filter((group: Group) => group.cardIds.every((id) => included.has(id))),
  );

  return createBoardFile({ meta: { title, parent: parentPath }, cards, columns, edges, groups });
}

/** 一块已落盘的子板：计划 + 目标路径 */
export interface SplitMove extends SplitChild {
  path: string;
}

/**
 * 按计划改造原板：迁走的卡片与分栏删掉，原位插上指向子板的白板卡。
 *
 * 只在**所有子板都写盘成功之后**调用 —— 否则会删掉内容却找不到它去了哪儿。
 */
export function applySplitToSource(board: BoardFile, moves: readonly SplitMove[]): void {
  // ① 先删卡片：`removeCards` 会连带清掉悬空连线与编组成员（别自己 filter 数组）
  removeCards(
    board,
    moves.flatMap((move) => move.cardIds),
  );

  // ② 再删已经空掉的分栏（卡片已不在，`release` 模式不会误伤）
  for (const move of moves) {
    if (move.columnId !== null) removeColumn(board, move.columnId, 'release');
  }

  // ③ 在每块内容的原位插一张白板卡：用户在原板上看到的位置，就是他刚才看到的那些内容
  const used = new Set<string>();
  let z = nextZ(board);
  for (const move of moves) {
    const position = freeAnchor(move.anchor, used);
    board.cards.push(
      createCard('boardRef', {
        x: position.x,
        y: position.y,
        z: z++,
        width: DEFAULT_CARD_SIZES.boardRef.width,
        height: DEFAULT_CARD_SIZES.boardRef.height,
        title: move.title,
        showTitle: true,
        content: { path: move.path },
      }),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────

/** 深拷贝：子板与原板必须是两套对象，共用引用会互相串改（见文件头 §2） */
function clone<T>(value: readonly T[]): T[] {
  return JSON.parse(JSON.stringify(value)) as T[];
}

/** 一组卡片的左上角（`x`/`y` 的最小值）；空数组退化为原点 */
function topLeftOf(cards: readonly Card[]): Point {
  if (cards.length === 0) return { x: 0, y: 0 };
  let x = cards[0].x;
  let y = cards[0].y;
  for (const card of cards) {
    x = Math.min(x, card.x);
    y = Math.min(y, card.y);
  }
  return { x, y };
}

/** 找一个没被占用的落点：重复就往下错开，避免白板卡完全叠在一起 */
function freeAnchor(anchor: Point, used: Set<string>): Point {
  const x = roundTo(anchor.x);
  let y = roundTo(anchor.y);
  for (;;) {
    const key = `${x}|${y}`;
    if (!used.has(key)) {
      used.add(key);
      return { x, y };
    }
    y = roundTo(y + REF_STAGGER);
  }
}
