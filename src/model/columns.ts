/**
 * 分栏的模型层（T1.54–T1.60）—— `F2.7`，数据结构见 `03 §2.6`。
 *
 * 四条贯穿全文件的约定：
 *
 * 1. **栏内卡片的位置是"派生状态"**：成员的 `x/y/width` 由分栏几何 + `order` 算出来，
 *    不由用户直接摆放。所以任何可能影响堆叠的操作之后都要重新排一遍 ——
 *    成员卡片的高度会被自动高度（T1.38）改掉，它下面的卡必须跟着往下挪。
 *    这里提供 `relayoutColumns()` 做全量兜底，由 `BoardView.commit()` 在落盘前统一调，
 *    那是**唯一**能保证不漏的地方（散在各个操作里迟早会漏一条路径）。
 * 2. **成员必须画在自己那一栏之上**：`z` 是全画布共用的一套数
 *    （`factories.maxZ` 同时看 `cards` 与 `columns`），所以插入时**只在**
 *    "卡片的 z 不高于分栏 z"时才提升它。无脑提到最上层会让每次重排都写出新的 z，
 *    把 `.nboard` 的 diff 弄花（`02 §12` 手工回归里"文件仍可读"那条就是在说这件事）。
 * 3. **分栏不嵌套分栏**（`F2-7-9` / T1.60）：`Column` 上根本没有 `parentColumnId`，
 *    本文件也不提供任何"把分栏放进分栏"的入口 —— 非法状态在类型层面就写不出来。
 * 4. **空栏保留**（用户 2026-09-16 改的口径，**取代**原来的 `O04`"空栏不留空壳"）：
 *    一次改动把某一栏的成员**全部**带走时（把卡片全拖出去、删掉栏里最后一张卡），
 *    栏**留在原地** —— 空栏也是用户摆好的结构，他还得往里放东西；把最后一张卡拖出去
 *    就让栏凭空消失，他得重新建一栏、重新摆位置。
 *    ⇒ 只有**显式**的删除会让栏消失：栏菜单「删除」、`Delete` 键、「整栏转分组」
 *    （`BoardView.groupCore` 自己调 `releaseColumn`）、`splitIntoColumns` 拆完后的源头栏。
 *    而"右边的同级栏要不要合拢过来"取决于那块地方有没有被一个编组接着占住
 *    （`groupOccupyingColumn` / `releaseColumn` 的 `moveSiblings`）。
 * 5. **收起的编组不占栏内位置**（`O05`）：编组一收起，它的成员就从版式里"抽走"——
 *    不算进内容总高、不推进堆叠光标、也不计入标题栏的张数（`columnContentHeight` /
 *    `layoutRects` / `visibleCardsInColumn` 三处只认同一份"看得见的成员"）。
 *    它们仍是这一栏的成员（`order` 原样留着，展开时归位），只是**不占地方**：
 *    分开算的话，用户会看到"卡片收了，栏里却空出一截"。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM，可在 node 下单测。
 */

import { MIN_CARD_SIZE } from '../constants';
import {
  boundsOf,
  clamp,
  rectContainsPoint,
  roundTo,
  type Point,
  type Rect,
} from '../util/geometry';
import { createColumn, nextZ, type ColumnOverrides } from './factories';
import {
  applyCardRects,
  collapsedCardIds,
  groupBounds,
  pruneGroups,
  removeCards,
  type CardRect,
} from './ops';
import type { BoardFile, Card, Column, Group } from './schema';

// ─────────────────────────────────────────────────────────────
// 版式常量
// ─────────────────────────────────────────────────────────────

/**
 * 分栏版式。放在模型层而不是 CSS 里，因为**布局要参与命中测试与落盘**
 * （插入线的位置、成员卡片的坐标都得在这里算出来）。
 * CSS 只负责画，不负责算 —— 两边各算一遍必然漂移。
 */
export const COLUMN_LAYOUT = {
  /** 标题栏高度。折叠后剩下的就是这个高度（F2-7-11：折叠时标题仍可见） */
  headerHeight: 40,
  /** 标题栏与第一张卡之间的间距 */
  headerGap: 6,
  /** 栏内左右内边距（成员卡片的宽度 = 分栏宽 - 2×padding） */
  padding: 12,
  /** 栏内卡片之间的间距 */
  gap: 10,
  /** 折叠态总高（只留标题栏 + 计数徽标） */
  collapsedHeight: 40,
  /** 拖动下限。比卡片下限更宽松 —— 分栏只是个容器，窄栏也能用 */
  minWidth: 160,
  minHeight: 120,
  /** 批量生成同级分栏时的水平间距（F2-7-7） */
  siblingGap: 24,
  /**
   * 分栏下边界之外的落点容差。
   * ★ 没有它就没法把卡拖到**列表末尾**：最后一张卡下面的空隙只有 `gap` 那么高，
   *   窗口稍微一窄就点不中，用户会觉得"这个分栏装不进去东西"。
   */
  dropTolerance: 60,
  /**
   * 自动撑高的上限（T2.03）。
   *
   * 超过它就不再长高，多出来的部分改成**栏内滚动**（`model/columnScroll.ts`）。
   * 不封顶的话，一张 200 卡的栏会长到 9000px 高：滚动画布找东西变成体力活，
   * 而且它会把画布在纵向上撑成一个谁也不敢动的长条。
   *
   * ★ 只约束"按内容撑高"，不约束用户**手动拖出来**的高度 ——
   *   `growColumnToFit` 的 `minHeight` 参数照旧可以顶到任意值，
   *   否则用户拖高一个栏、再往里放一张卡，栏就会自己缩回去。
   *   `shrinkColumnToFit`（`O05`）照同一条纪律：收的是"内容少掉的那一截"，
   *   用户拖出来的余量原样留着。
   */
  maxAutoHeight: 1200,
} as const;

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

export function columnById(board: BoardFile, id: string): Column | null {
  return board.columns.find((column) => column.id === id) ?? null;
}

/**
 * 栏内卡片，按 `order` 升序。
 *
 * ★ `order` 相同时用 id 兜底：手改过的文件、并发写入都可能留下重复 order，
 *   没有兜底就会让渲染顺序、插入线位置、撤销快照在两次读取之间飘。
 */
export function cardsInColumn(board: BoardFile, columnId: string): Card[] {
  return board.cards
    .filter((card) => card.columnId === columnId)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 栏内**看得见**的成员，按 `order` 升序（收起的编组里的那些不算，`O05`）。
 *
 * ★ 版式、内容总高、标题栏张数只认这一份：收起一个编组之后，那几张卡
 *   仍然是这一栏的成员（`order` 留着，展开时归位），但**不该占地方**。
 *   于是"可见性"这件事在全文件里只有一个判据 —— `ops.collapsedCardIds`。
 */
export function visibleCardsInColumn(board: BoardFile, columnId: string): Card[] {
  const members = cardsInColumn(board, columnId);
  const hidden = collapsedCardIds(board);
  if (hidden.size === 0) return members;
  return members.filter((card) => !hidden.has(card.id));
}

/**
 * 分栏的"显示用统计"：每栏看得见的成员数 + 内容底边（T2.03 / `O05`）。
 *
 * 交给 `ColumnLayer` 算标题栏的张数徽标与栏内滚动条的高度。**放在模型层**是为了
 * 让"看得见的成员"只有一个判据（与 `visibleCardsInColumn` 同一份），也让它可单测 ——
 * 计数藏在 DOM 层的 `measure()` 里时，只有真机上点得出来"这里少了一张"。
 *
 * ★ 一次遍历算完（栏数 × 卡数只走一遍）：1000 张卡 + 20 个栏时，
 *   渲染时每栏 `cardsInColumn()` 扫一遍就是每次重绘 2 万次比较。
 */
export function measureColumns(board: BoardFile): {
  counts: Map<string, number>;
  bottoms: Map<string, number>;
} {
  const hidden = collapsedCardIds(board);
  const counts = new Map<string, number>();
  const bottoms = new Map<string, number>();
  for (const card of board.cards) {
    // 收起的编组既不占高度也不该出现在张数里：它们连"内容底边"都不该抬高，
    // 否则栏里会多出一截滚不到头的空白（滚动条比内容长）
    if (!card.columnId || hidden.has(card.id)) continue;
    counts.set(card.columnId, (counts.get(card.columnId) ?? 0) + 1);
    const bottom = roundTo(card.y + card.height);
    const previous = bottoms.get(card.columnId);
    if (previous === undefined || bottom > previous) bottoms.set(card.columnId, bottom);
  }
  return { counts, bottoms };
}

/** 给定卡片集合"共同所属"的那个分栏（没有 / 不唯一 → `null`）。用于 ⌘Enter 与 ⌘⇧[ 的语义判定 */
export function soleColumnOf(board: BoardFile, ids: ReadonlySet<string>): string | null {
  const found = new Set<string>();
  let seen = 0;
  for (const card of board.cards) {
    if (!ids.has(card.id)) continue;
    seen += 1;
    if (card.columnId) found.add(card.columnId);
  }
  // `seen !== ids.size` 说明选区里有幽灵 id（刚被删掉的卡）：宁可判不出来，也不要猜
  if (seen === 0 || seen !== ids.size) return null;
  return found.size === 1 ? [...found][0] : null;
}

/**
 * **收起**的分栏里的全部成员 id（`O16`）。
 *
 * ★ 与 `ops.collapsedCardIds` 刻意分开：那是**排版**判据（收起编组的成员不占地方，
 *   见 `layoutRects`），把分栏成员也塞进去会让栏内所有卡叠在同一个 y 上。
 *   而"收起分栏"要的是**渲染 / 命中**判据 —— 卡片层不挂载它们，框选与连线也当它们不存在
 *   （视图层把两份集合并起来用，见 `BoardView.hiddenCardIds`）。
 * ★ 一次遍历（不用每栏一遍 `cardsInColumn()` 的 filter + sort）：这份集合在框选期间
 *   每个 `pointermove` 都会被问到。
 * ★ 没有收起的栏时返回**空集**（不是 `null`）：这是绝大多数情况，调用方少一个分支。
 */
export function collapsedColumnCardIds(board: BoardFile): Set<string> {
  const hidden = new Set<string>();
  const collapsed = new Set<string>();
  for (const column of board.columns) {
    if (column.collapsed) collapsed.add(column.id);
  }
  if (collapsed.size === 0) return hidden;
  for (const card of board.cards) {
    if (card.columnId !== null && collapsed.has(card.columnId)) hidden.add(card.id);
  }
  return hidden;
}

/** 分栏的显示总高（折叠时只有标题栏） */
export function columnDisplayHeight(column: Column): number {
  return column.collapsed ? COLUMN_LAYOUT.collapsedHeight : column.height;
}

/** 成员卡片的可用区域（左边界 / 上边界 / 宽度）。`column` 可以是**假想**的分栏对象 */
export function columnContentBox(column: Column): { left: number; top: number; width: number } {
  const { padding, headerHeight, headerGap } = COLUMN_LAYOUT;
  return {
    left: roundTo(column.x + padding),
    top: roundTo(column.y + headerHeight + headerGap),
    // 宽度兜底到卡片下限：分栏窄到装不下一张卡时，卡片会被压成一根线而无法交互
    width: roundTo(Math.max(column.width - padding * 2, MIN_CARD_SIZE.width)),
  };
}

/**
 * 分栏需要多高才装得下现有内容（含底部内边距）。
 *
 * 空栏也要留出"能再放一张卡"的高度 —— 否则拖第一张卡进去时，
 * 插入线画在栏外，看起来像"这个栏不能放东西"。
 *
 * ★ 只数**看得见的**成员（`O05`）：一张看得见的都没有时（空栏，或者成员全在
 *   收起的编组里）按空栏算 —— 收起编组后栏要能矮下来，不然栏里空出一大截。
 */
export function columnContentHeight(board: BoardFile, column: Column): number {
  if (column.collapsed) return COLUMN_LAYOUT.collapsedHeight;

  const { headerHeight, headerGap, gap, padding } = COLUMN_LAYOUT;
  const members = visibleCardsInColumn(board, column.id);
  if (members.length === 0) return Math.max(headerHeight + headerGap + padding * 2, 160);

  // 标题栏 + 间距 + 各卡（卡之间才有 gap）+ 底部内边距
  let height = headerHeight + headerGap;
  members.forEach((card, index) => {
    height += card.height;
    if (index < members.length - 1) height += gap;
  });
  return roundTo(height + padding);
}

// ─────────────────────────────────────────────────────────────
// 堆叠（版式的唯一算法）
// ─────────────────────────────────────────────────────────────

/** 分栏的目标几何 + 它所有成员卡片的目标几何（预览与提交共用同一份数字） */
export interface ColumnRects {
  column: ColumnRect;
  cards: CardRect[];
}

/** 分栏的几何。与 `Column` 同形，单独取名是为了在 `ColumnRects` 里读起来更清楚 */
export type ColumnRect = Rect & { id: string };

/**
 * 一个**假想**分栏下，成员卡片的堆叠位置（不改模型）。
 *
 * ★ 预览与提交共用它：拖动时画的是这些数字，松手写进模型的也是这些数字。
 *   两处各算一遍，迟早在"折叠的栏"或"改过高度的成员"上分叉。
 */
export function layoutRects(board: BoardFile, column: Column, digits = 2): CardRect[] {
  const box = columnContentBox(column);
  const hidden = collapsedCardIds(board);
  const rects: CardRect[] = [];
  let y = box.top;

  for (const card of cardsInColumn(board, column.id)) {
    rects.push({
      id: card.id,
      x: box.left,
      y: roundTo(y, digits),
      width: box.width,
      height: roundTo(card.height, digits),
    });
    // ★ 收起编组里的成员**不推进光标**（`O05`）：它们照旧拿一个坐标（模型里每个成员
    //   都得有几何，展开时才能原样回来），但不占地方 —— 后面的卡直接叠上来。
    //   ★ 不能改成"跳过不写坐标"：那些坐标会停在原地，而"插入到第几位"是按 y 比出来的
    //   （`findDropTarget`），模型里留一段谁都不用的 y 空间会让插入线指到空处去。
    if (hidden.has(card.id)) continue;
    y += card.height + COLUMN_LAYOUT.gap;
  }
  return rects;
}

/**
 * 把某个分栏的成员按 `order` 重新堆叠一遍（写模型）。
 *
 * 同时把 `order` 压成 `0..n-1` 的密排：删掉中间一张卡后留下 `0,1,3` 这种空洞，
 * 虽然堆叠不受影响，但会让 `.nboard` 变得难读，也会让"插入到第几位"的调试变成猜谜。
 */
export function layoutColumn(board: BoardFile, columnId: string, digits = 2): boolean {
  const column = columnById(board, columnId);
  if (!column) return false;

  let changed = false;
  cardsInColumn(board, columnId).forEach((card, index) => {
    if (card.order !== index) {
      card.order = index;
      changed = true;
    }
  });

  if (applyCardRects(board, layoutRects(board, column, digits), digits)) changed = true;
  return changed;
}

/**
 * 全量重排。`BoardView.commit()` 在落盘前调它 —— 成员卡片的几何是派生状态，
 * 任何一次改动之后都可能过期（改高度、改归属、删卡片、外部同步）。
 */
export function relayoutColumns(board: BoardFile, digits = 2): boolean {
  let changed = false;
  for (const column of board.columns) {
    if (layoutColumn(board, column.id, digits)) changed = true;
  }
  return changed;
}

// ─────────────────────────────────────────────────────────────
// 新建 / 删除
// ─────────────────────────────────────────────────────────────

/** 在指定位置新建一个分栏（T1.54 / F2-7-1）。新栏永远在最上层 —— 被旧栏压住会让人以为没建成功 */
export function createColumnAt(
  board: BoardFile,
  x: number,
  y: number,
  overrides: ColumnOverrides = {},
): Column {
  const column = createColumn({
    x: roundTo(x),
    y: roundTo(y),
    // ★ 先算 z 再入数组：`nextZ` 读的是现有元素，推入之后再算就会和自己比
    z: nextZ(board),
    ...overrides,
  });
  board.columns.push(column);
  return column;
}

/**
 * 删除分栏。
 *
 * `release`（默认）= **卡片留在画布上**：它们的几何本来就是按栏内位置算好的，
 * 原地释放视觉上就是"栏没了、卡还在"，与 `03 §7.1` 里"非法状态优先保内容"一致。
 * `delete` = 连卡片一起删。
 *
 * ★ **指着这一栏的连线一并删掉**（`O21`）：分栏也是连线的合法端点，栏一消失，
 *   那些线就永远取不到端点矩形（`edgeEndpoints` 返回 `null`）—— 不清理的话文件里
 *   会留下一条谁也画不出来、也点不中的幽灵边（与 `ops.removeCards` 清悬空边同一个理由）。
 *   `release` 与 `delete` 两种模式都要清：前者**卡片**留在原地，但栏本身确实没了。
 * ★ 这一步必须与 `board.columns` 的过滤放在**同一次变更**里（同一个 `mutate`）：
 *   分两次落盘就会在撤销栈上留下"先删栏、再删线"两条记录，用户得按两下 ⌘Z。
 */
export function removeColumn(
  board: BoardFile,
  columnId: string,
  mode: 'release' | 'delete' = 'release',
  digits = 2,
): boolean {
  const column = columnById(board, columnId);
  if (!column) return false;

  const ids = cardsInColumn(board, columnId).map((card) => card.id);
  board.columns = board.columns.filter((candidate) => candidate.id !== columnId);
  board.edges = board.edges.filter(
    (edge) => edge.from.cardId !== columnId && edge.to.cardId !== columnId,
  );
  // ★ 栏没了 ⇒ 把它从所属编组里摘掉（用户 2026-09-16 起分栏也是编组成员）：
  //   不摘的话组里会留一个幽灵 id —— 包围框与"这一组有几员"都会跟着飘。
  //   摘完顺手 `pruneGroups`：一个"两栏成组"的组少了一栏就该解散（`MIN_GROUP_SIZE`），
  //   而 `commit` 收尾那几轮**不做**这件事。
  for (const group of board.groups) {
    if (group.columnIds) group.columnIds = group.columnIds.filter((id) => id !== columnId);
  }
  pruneGroups(board);

  if (mode === 'delete') {
    if (ids.length > 0) removeCards(board, ids);
    // 被删的卡不在任何栏里了，但**别的**栏的 order 可能因此出现空洞，仍要重排一次
    relayoutColumns(board, digits);
    return true;
  }

  detachCards(board, ids, digits);
  return true;
}

// ─────────────────────────────────────────────────────────────
// 成员归属（T1.55 / T1.56 / T1.59）
// ─────────────────────────────────────────────────────────────

/**
 * 把卡片放进分栏的第 `index` 个位置（插入线指示的那个位置）。
 *
 * 多选拖动时整批按 `index` 连续插入，**保持它们之间的相对次序** ——
 * 用户框选 3 张卡拖进栏里，期望的是"这三张按原来的上下关系排好"，
 * 而不是被倒序（`sort` 不稳定时真的会这样）。
 */
export function insertCardsIntoColumn(
  board: BoardFile,
  ids: readonly string[],
  columnId: string,
  index: number,
  digits = 2,
): boolean {
  const column = columnById(board, columnId);
  if (!column || ids.length === 0) return false;

  const moving = ids
    .map((id) => board.cards.find((card) => card.id === id))
    .filter((card): card is Card => card !== undefined);
  if (moving.length === 0) return false;

  const rest = cardsInColumn(board, columnId).filter((card) => !ids.includes(card.id));
  const at = clamp(Math.round(index), 0, rest.length);
  const ordered = [...rest.slice(0, at), ...moving, ...rest.slice(at)];

  let changed = false;

  // ★★ 进栏的卡片**角度归 0**（用户 2026-09-17："任何卡片，一旦拖动到分栏当中，旋转角度要改为 0"）。
  //   两个理由叠加：栏内位置由栏算出来（歪着的卡片会顶出栏外、插入线也算不准），
  //   而且栏里没有"歪着排队"这回事 —— 角度是自由摆放才需要的东西。
  //   ★ 与 `rotation` 的其它归一一样：**归零不留痕**（删掉这个键，而不是写 0）。
  //   ★ 只处理**这一次进来的**那些（`moving`）：栏内已有的卡片归它们自己的历史，
  //     要掰正用右键菜单的「重置角度」（见 `applyCardRotations` 那条）。
  for (const card of moving) {
    if ((card.rotation ?? 0) !== 0) {
      delete card.rotation;
      changed = true;
    }
  }

  let z = nextZ(board);
  ordered.forEach((card, order) => {
    if (card.columnId !== columnId) {
      card.columnId = columnId;
      changed = true;
    }
    if (card.order !== order) {
      card.order = order;
      changed = true;
    }
    // 只在"画不到栏上面"时提升，避免每次重排都写出新的 z（约定 2）
    if (card.z <= column.z) {
      card.z = z++;
      changed = true;
    }
  });

  // 来源栏的 order 会出现空洞，目标栏也可能需要按新成员重排 —— 一次全量兜底
  if (relayoutColumns(board, digits)) changed = true;
  return changed;
}

/** 把卡片移出分栏（拖到空白处）。几何原地保留，视觉上就是"拖出来放开" */
export function detachCards(board: BoardFile, ids: readonly string[], digits = 2): boolean {
  if (ids.length === 0) return false;
  const targets = new Set(ids);

  let changed = false;
  for (const card of board.cards) {
    if (!targets.has(card.id) || card.columnId === null) continue;
    card.columnId = null;
    card.order = 0;
    changed = true;
  }
  if (!changed) return false;

  // 原分栏少了一个成员，下面的卡片要往上收
  if (relayoutColumns(board, digits)) changed = true;
  return changed;
}

/**
 * 多选卡片 → 收进一个**新建**的分栏（T1.59 / F2-7-8 / `⌘⇧G`）。
 *
 * 新栏开在选中卡片的外接矩形上：用户的选区就是他们心里的"这一栏"，
 * 开在别处会让人第一眼找不到东西去哪了。
 *
 * @returns 新分栏 id；没有可收的卡片时返回 `null`
 */
export function groupIntoNewColumn(
  board: BoardFile,
  ids: readonly string[],
  digits = 2,
): string | null {
  const cards = board.cards.filter((card) => ids.includes(card.id));
  if (cards.length === 0) return null;

  const bounds = boundsOf(cards);
  if (!bounds) return null;

  const { padding, gap, headerHeight, minWidth } = COLUMN_LAYOUT;
  // 按当前视觉顺序（上→下）入栏：用户拖出来的是一片"看图得到"的区域
  const ordered = [...cards].sort((a, b) => a.y - b.y || a.x - b.x);

  const column = createColumnAt(board, bounds.x - padding, bounds.y - headerHeight - gap, {
    width: Math.max(roundTo(bounds.width + padding * 2), minWidth),
    // 高度交给 `growColumnToFit` 按内容算：先给 0，它就是"必须撑到 needed"的意思
    height: 0,
  });
  insertCardsIntoColumn(
    board,
    ordered.map((card) => card.id),
    column.id,
    0,
    digits,
  );
  growColumnToFit(board, column.id, 0, digits);
  return column.id;
}

/**
 * 把选中的卡片按"一卡一栏"拆成同级并排分栏（T1.58 / F2-7-7 / `⌘Enter`）。
 *
 * 两种用法是同一段代码：
 * - 选中若干散落的卡片 → 每张各开一栏、从左到右排开（"批量生成同级分栏"）；
 * - 选中某个分栏里的**全部**卡片 → 等价于把这个栏拆开（原栏会在最后被清掉，
 *   否则会留下一个空壳栏，用户还得手动删）。
 *
 * @returns 新建的分栏 id（可能为空数组）
 */
export function splitIntoColumns(board: BoardFile, ids: readonly string[], digits = 2): string[] {
  const cards = board.cards.filter((card) => ids.includes(card.id));
  if (cards.length === 0) return [];

  const sourceColumn = soleColumnOf(board, new Set(ids));
  const ordered = [...cards].sort((a, b) => a.y - b.y || a.x - b.x);

  const { padding, minWidth, siblingGap } = COLUMN_LAYOUT;
  let cursorX = Math.min(...ordered.map((card) => card.x));
  const topY = Math.min(...ordered.map((card) => card.y));

  // ★ 先把所有分栏建完再插卡片：`insertCardsIntoColumn` 会把成员的 z 提到"当前最上层"，
  //   期间若还夹着后面要建的分栏，成员就会被后建的分栏盖住。
  const columns: Column[] = [];
  for (const card of ordered) {
    const width = Math.max(roundTo(card.width + padding * 2), minWidth);
    columns.push(
      createColumnAt(board, cursorX, topY, {
        width,
        // 同 `groupIntoNewColumn`：高度按内容算，不猜
        height: 0,
        title: card.title,
      }),
    );
    cursorX += width + siblingGap;
  }

  columns.forEach((column, index) => {
    insertCardsIntoColumn(board, [ordered[index].id], column.id, 0, digits);
    growColumnToFit(board, column.id, 0, digits);
  });

  // 拆的如果是原来那个栏，它现在空了 —— 顺手清掉，别留空壳
  if (sourceColumn && cardsInColumn(board, sourceColumn).length === 0) {
    removeColumn(board, sourceColumn, 'release', digits);
  }

  // ★ 顺手对齐（T3.15 / `F5-01`）：上面每栏的宽度都是**各自卡片**的宽度算出来的，
  //   卡片宽窄不一时这一排会参差不齐。既然"同级分栏"就是这一次操作造出来的，
  //   那"顶部对齐 + 等宽"就该在这里一次性做掉，别指望用户再手动按一次对齐命令。
  alignSiblingColumns(
    board,
    columns.map((column) => column.id),
    digits,
  );

  return columns.map((column) => column.id);
}

// ─────────────────────────────────────────────────────────────
// 整栏转分组 / 空壳栏清理（O04）
// ─────────────────────────────────────────────────────────────

/**
 * 选区**恰好就是**某一栏的全部成员时，返回那一栏（`O04`）。
 *
 * "整栏转分组"的判据是**成员集合**，不是几何：一个栏里的卡片一张不落地都在选区里，
 * 就说这个选区"就是这一栏"。这么定有两个好处：
 *  * 收起编组的成员也算数（它们在 `cardsInColumn` 里）—— 于是"选区只框到看得见的
 *    那几张、栏目录里还藏着收起的一组"不会被误判成整栏；
 *  * 与栏的大小 / 位置无关，用户把栏拖过、缩小过都照样认得出。
 *
 * ★ 为什么还要"恰好"两个字：**覆盖**整栏是件很容易的事（多选几张别处的卡片照样
 *   覆盖得了），而那种时候用户的意思是"把这些东西收成一个组"，不是"把这一栏换成
 *   一个组"。少了这个条件，`⌘A` + `⌘G`（全选编组）会把板上所有分栏一次全拆掉。
 */
export function wholeColumnOf(board: BoardFile, ids: ReadonlySet<string>): Column | null {
  const covering = board.columns.filter((column) => {
    const members = cardsInColumn(board, column.id);
    return members.length > 0 && members.every((card) => ids.has(card.id));
  });
  if (covering.length !== 1) return null;
  const only = covering[0]!;
  return cardsInColumn(board, only.id).length === ids.size ? only : null;
}

/**
 * 一次"编组"（`⌘G`）该收哪些卡片。
 *
 * ★ 编组对象 = **选中的卡片** + **选中的整个分栏里的所有卡片**
 *   （用户 2026-09-16："框选中多个分栏，要求也可以编成分组"）。
 * ★ 为什么要把整栏的成员并进来：框选**框住一栏**时栏内卡片根本不在选区里
 *   （见 `MarqueeController` 的 `marqueeSelectableCards`）—— 只看 `cardIds` 的话，
 *   "框住两栏按 `⌘G`"会得到一句"什么都没选中"。
 * ★ 多栏合成**一个**组（与"多张卡片编成一个组"同一条语义）。
 *   "一栏一个组"是分栏菜单里「转成编组」那一项的事（一次只对一栏）。
 */
export function groupTargetsOf(
  board: BoardFile,
  cardIds: Iterable<string>,
  columnIds: Iterable<string>,
): string[] {
  const targets = new Set<string>();
  for (const id of cardIds) {
    if (board.cards.some((card) => card.id === id)) targets.add(id);
  }
  for (const id of columnIds) {
    // 指向不存在的分栏（手改过的文件 / 幽灵 id）跳过：它一张卡也带不出来
    if (columnById(board, id) === null) continue;
    for (const card of cardsInColumn(board, id)) targets.add(card.id);
  }
  return [...targets];
}

/**
 * 有哪个编组**正压在这一栏上**（`O04`）。
 *
 * ★ 为什么只能从几何问：编组没有 `columnId`（`03 §2.9`，组只存成员），
 *   所以"这个组算不算落在这一栏里"没有模型判据可用。判据取**成员包围盒的中心**
 *   落在栏的矩形内：一个横跨两栏的大组，说它"属于"哪一栏都站不住脚，中心至少唯一。
 * ★ 回答的是"这块地方空出来了吗"：整栏转分组之后那个组还在原地，右边的栏就不该
 *   合拢过来（会直接压在组上）；而"把卡片拖到别处去"之后这块地方是真空了。
 * ★ 用 `columnDisplayHeight` 而不是 `column.height`：折叠的栏在屏幕上只有标题栏那么高，
 *   拿它没收起来时的高度去判"组在不在里面"，会把一个明明压在标题条上的组判成不在。
 */
export function groupOccupyingColumn(board: BoardFile, columnId: string): Group | null {
  const column = columnById(board, columnId);
  if (!column) return null;
  const rect: Rect = {
    x: column.x,
    y: column.y,
    width: column.width,
    height: columnDisplayHeight(column),
  };
  for (const group of board.groups) {
    const bounds = groupBounds(board, group.id);
    if (bounds === null) continue;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    if (rectContainsPoint(rect, center)) return group;
  }
  return null;
}

/**
 * 把一个栏**释放掉**：成员留在原地（几何本来就是按栏内位置算好的），栏本身删掉。
 *
 * @param options.moveSiblings 右边的同级栏要不要往左挪、补上这块地方。
 *   ★ 由调用方决定而不是这里猜：同一个"栏没了"的动作，两种情形的正确观感是相反的 ——
 *     "整栏转成分组"时那块地方被新组接着占着（挪邻居会撞上去），
 *     "把卡片全拖走了"时那块地方真的空了（不挪邻居就留一道空档）。
 */
export function releaseColumn(
  board: BoardFile,
  columnId: string,
  options: { moveSiblings: boolean },
  digits = 2,
): boolean {
  const column = columnById(board, columnId);
  if (!column) return false;

  // ★ 同级判定必须在**删之前**做：`siblingColumnsOf` 是几何判据（横向紧邻 + 纵向重叠），
  //   栏一旦从数组里消失，"它右边那个还算不算同级"就再也问不出来了。
  const siblings = options.moveSiblings ? siblingColumnsOf(board, columnId) : [];
  if (!removeColumn(board, columnId, 'release', digits)) return false;
  if (siblings.length > 0) closeColumnGap(board, column, siblings, digits);
  return true;
}

/**
 * 清理**这一改才被清空**的栏（`O04`）—— **已按用户要求撤掉**（2026-09-16）。
 *
 * 从前的规矩是"空栏不留空壳"：一次改动把某一栏的成员全带走时连栏一起收掉。
 * 但用户的口径是：**"即使分栏最后一张卡被移出，分栏依然应该存在"** ——
 * 把最后一张卡拖出去之后栏凭空消失，他还得重新建一栏、重新摆位置，
 * 而空栏本身也是他摆好的结构（导出 / 打印 / 缩略图三处一直把它算进内容边界）。
 *
 * ⇒ 现在只有**显式**的删除会让栏消失：栏菜单「删除」、`Delete` 键、
 *   「整栏转分组」（`BoardView.groupCore` 自己调 `releaseColumn` —— 那是用户
 *   明确要求"把这一栏换成一个组"），以及 `splitIntoColumns` 拆栏之后那个源头栏。
 * ★ 这块地方有没有被一个编组接着占住（`groupOccupyingColumn`）仍然决定
 *   "右边的同级栏要不要合拢过来"，见 `releaseColumn` 的 `moveSiblings`。
 */

/**
 * 把被删掉的那一栏右边的同级栏往左挪，补上它占的位置（`O04`）。
 *
 * 位移量 = 被删栏的宽度 + **它到最近那个右侧同级的实际间隙**。
 * ★ 用实际间隙而不是 `COLUMN_LAYOUT.siblingGap`：栏是用户自己摆的，一排栏的间距
 *   本来就常常不是标准值；按标准值挪会在栏之间凭空造出一条缝，或者让两栏叠上。
 * ★ 挪完要 `relayoutColumns`：成员卡片的 x 是**派生**的，栏动了它们必须跟着动
 *   （`commit` 收尾还会再排一遍，这里是让"栏自己的位置"与"成员的位置"在同一步里
 *   就对得上 —— 单测直接调 `releaseColumn` 时不必记得补一次）。
 */
function closeColumnGap(
  board: BoardFile,
  removed: Column,
  siblings: readonly Column[],
  digits: number,
): boolean {
  const rightEdge = removed.x + removed.width;
  const right = siblings.filter((sibling) => sibling.x >= rightEdge / 2);
  if (right.length === 0) return false;

  const nearest = Math.min(...right.map((sibling) => sibling.x));
  const gap = Math.max(nearest - rightEdge, 0);
  const shift = removed.width + gap;
  for (const column of right) column.x = roundTo(column.x - shift, digits);
  return relayoutColumns(board, digits);
}

// ─────────────────────────────────────────────────────────────
// 折叠（T1.57 / F2-7-6）
// ─────────────────────────────────────────────────────────────

/**
 * 折叠 / 展开。
 *
 * ★ **不动 `height`**：折叠只是"显示成标题栏那么高"，用户之前拖出来的高度
 *   必须原样留着 —— 展开时如果回不到原来的高度，用户会觉得这个功能在捣乱。
 */
export function setColumnCollapsed(
  board: BoardFile,
  columnId: string,
  collapsed: boolean,
): boolean {
  const column = columnById(board, columnId);
  if (!column || column.collapsed === collapsed) return false;
  column.collapsed = collapsed;
  return true;
}

/**
 * 改分栏标题（T1.54）。
 *
 * 与 `setColumnCollapsed` 一样放在模型层：标题是**内容**，它决定历史记录里那一行
 * 显示什么、也决定 ⌘Enter 拆栏时新栏的标题。写在视图里会让"标题的合法值"散成两份。
 */
export function setColumnTitle(board: BoardFile, columnId: string, title: string): boolean {
  const column = columnById(board, columnId);
  // 原样提交（用户点开又原样关掉）不该产生历史记录，也不该递增 revision
  if (!column || column.title === title) return false;
  column.title = title;
  return true;
}

/**
 * 需要时把分栏撑高（**只增不减**，与 `growCard` 同一套哲学：不跟用户拖出来的尺寸打架）。
 *
 * ★ 按内容撑高的部分封顶在 `COLUMN_LAYOUT.maxAutoHeight`（T2.03）：再高就不撑了，
 *   多出来的内容靠栏内滚动看。但 `minHeight`（用户手动拖出来的高度）**不受这个上限约束** ——
 *   两者取 `max` 时先给内容封顶，再与 `minHeight` 比，语义才是"内容最多撑到这么高，
 *   但用户要的高度必须给到"。
 */
export function growColumnToFit(
  board: BoardFile,
  columnId: string,
  minHeight = 0,
  digits = 2,
): boolean {
  const column = columnById(board, columnId);
  if (!column) return false;

  const content = Math.min(columnContentHeight(board, column), COLUMN_LAYOUT.maxAutoHeight);
  const needed = Math.max(content, minHeight);
  if (needed <= column.height) return false;
  column.height = roundTo(needed, digits);
  return true;
}

/**
 * 内容变少时把分栏**收下来**（`O05`）—— `growColumnToFit` 的另一半。
 *
 * 只增不减的撑高能保证"用户拖高的栏不会自己缩回去"，但反过来那一半没人管：
 * 收起一个编组、把卡片拖出栏外、删掉几张卡之后，栏里就留着一截空白，
 * 而 `relayoutColumns` 只是重新堆叠成员 —— 它不动栏的高度。
 *
 * ★ 收多少按**"这次内容少了多少"**算，不按内容高度算：
 *   `column.height` 高出内容的那部分是**用户自己拖出来的**（想留一片空地），
 *   内容变化不该把它一起吃掉。于是两种极端都对：
 *   自动撑高的栏（高度 = 内容）→ 正好收到新的内容高度；
 *   用户拖高的栏（高度 = 内容 + 空地）→ 只收掉腾出来的那一截。
 *
 * ★ `previousContentHeight` 必须由调用方在**改动之前**量好传进来：改完之后
 *   模型里只剩"现在的样子"，"少了多少"就无从算起了（见 `BoardView.commit`）。
 *
 * ★ 它**只往下收，绝不往上长**：长高是 `growColumnToFit` 的活。
 *   两者按 `grow → shrink` 的顺序调用，语义才不重叠（都拿内容高度当基准，
 *   一个只管 `height < content`，一个只管 `height > content`）。
 *
 * ★ 折叠的栏不参与：它的显示高度是"标题栏那么高"（`columnDisplayHeight`），
 *   与内容无关 —— `setColumnCollapsed` 也刻意不动 `height`。
 */
export function shrinkColumnToFit(
  board: BoardFile,
  columnId: string,
  previousContentHeight: number,
  digits = 2,
): boolean {
  const column = columnById(board, columnId);
  if (!column || column.collapsed) return false;

  const content = Math.min(columnContentHeight(board, column), COLUMN_LAYOUT.maxAutoHeight);
  const freed = previousContentHeight - content;
  // 没变少（或者反而长了）不归它管；本来就不比内容高，也没有可收的
  if (freed <= 0 || column.height <= content) return false;

  const target = Math.max(column.height - freed, content, COLUMN_LAYOUT.minHeight);
  if (target >= column.height) return false;
  column.height = roundTo(target, digits);
  return true;
}

// ─────────────────────────────────────────────────────────────
// 整栏移动 / 缩放（F2-7-4 / F2-7-5）
// ─────────────────────────────────────────────────────────────

/** 整栏移动到 `(x, y)` 后的目标几何（预览与提交共用） */
export function columnMoveRects(
  board: BoardFile,
  column: Column,
  x: number,
  y: number,
  digits = 2,
): ColumnRects {
  const moved: Column = { ...column, x: roundTo(x, digits), y: roundTo(y, digits) };
  return {
    column: {
      id: column.id,
      x: moved.x,
      y: moved.y,
      width: moved.width,
      height: columnDisplayHeight(column),
    },
    cards: layoutRects(board, moved, digits),
  };
}

/** 整栏缩放到 `rect` 后的目标几何（预览与提交共用）。成员宽度跟着变，所以要重排 */
export function columnResizeRects(
  board: BoardFile,
  column: Column,
  rect: { x: number; y: number; width: number; height: number },
  digits = 2,
): ColumnRects {
  const next: Column = {
    ...column,
    x: roundTo(rect.x, digits),
    y: roundTo(rect.y, digits),
    width: roundTo(Math.max(rect.width, COLUMN_LAYOUT.minWidth), digits),
    height: roundTo(Math.max(rect.height, COLUMN_LAYOUT.minHeight), digits),
  };
  return {
    column: {
      id: column.id,
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.collapsed ? COLUMN_LAYOUT.collapsedHeight : next.height,
    },
    cards: layoutRects(board, next, digits),
  };
}

/** 把 `columnMoveRects` / `columnResizeRects` 的结果写进模型 */
export function applyColumnRects(board: BoardFile, rects: ColumnRects, digits = 2): boolean {
  const column = columnById(board, rects.column.id);
  if (!column) return false;

  let changed = false;
  const next = {
    x: roundTo(rects.column.x, digits),
    y: roundTo(rects.column.y, digits),
    width: roundTo(Math.max(rects.column.width, COLUMN_LAYOUT.minWidth), digits),
    height: roundTo(Math.max(rects.column.height, COLUMN_LAYOUT.minHeight), digits),
  };
  if (column.x !== next.x || column.y !== next.y) {
    column.x = next.x;
    column.y = next.y;
    changed = true;
  }
  // 折叠态下的"高"是显示值而不是用户设定值，不能写回去（会把展开高度永久压扁）
  if (!column.collapsed && column.height !== next.height) {
    column.height = next.height;
    changed = true;
  }
  if (column.width !== next.width) {
    column.width = next.width;
    changed = true;
  }

  if (applyCardRects(board, rects.cards, digits)) changed = true;
  return changed;
}

// ─────────────────────────────────────────────────────────────
// 同级分栏对齐（T3.15 / `F5-01`）
// ─────────────────────────────────────────────────────────────

/** 两个分栏的纵向区间是否有重叠（同处一个横带） */
function bandsOverlap(a: Column, b: Column): boolean {
  const aTop = a.y;
  const aBottom = a.y + columnDisplayHeight(a);
  const bTop = b.y;
  const bBottom = b.y + columnDisplayHeight(b);
  return aTop < bBottom && bTop < aBottom;
}

/**
 * 两个分栏是不是"同一排的兄弟"。
 *
 * 判据全是几何的，**因为 `Column` 上根本没有 parent / groupId 字段**（`03 §2.6`
 * 刻意如此：分栏是画布上的独立物件，不是树上的节点，也不嵌套分栏）。
 * 而"同组"在用户眼里本来就是"看起来排成一行"：
 *   * 纵向区间有重叠（同处一条横带）；
 *   * 水平方向要么紧挨着、要么重叠，间隙不超过 `siblingGap × 2`。
 *
 * ★ 容差取两倍 `siblingGap` 而不是一倍：手动拖动分栏时很难精确停在 24px 上，
 *   一倍容差会让"我明明推回去了"仍然不认账。
 */
function areSiblings(a: Column, b: Column): boolean {
  if (a.id === b.id) return false;
  if (!bandsOverlap(a, b)) return false;
  const gap = a.x <= b.x ? b.x - (a.x + a.width) : a.x - (b.x + b.width);
  return gap <= COLUMN_LAYOUT.siblingGap * 2;
}

/**
 * 与给定分栏并排的**全部**兄弟分栏（含它自己），按传递闭包取整块。
 *
 * 传递闭包是必须的：`⌘Enter` 批量生成的三栏里，第 1 栏与第 3 栏**并不相邻**
 * （中间隔着第 2 栏），只做两次两两比较会把它判成两组。
 */
export function siblingColumnsOf(board: BoardFile, columnId: string): Column[] {
  const seed = columnById(board, columnId);
  if (!seed) return [];

  const found = new Map<string, Column>([[seed.id, seed]]);
  const queue: Column[] = [seed];
  while (queue.length > 0) {
    const current = queue.pop() as Column;
    for (const candidate of board.columns) {
      if (found.has(candidate.id) || !areSiblings(current, candidate)) continue;
      found.set(candidate.id, candidate);
      queue.push(candidate);
    }
  }
  return [...found.values()];
}

/**
 * 同组分栏对齐：**顶部对齐 + 等宽**（`F5-01`）。
 *
 * * **顶**：统一到组内最靠上的那个 `y`。刻意不取"遍历到的第一个" ——
 *   `board.columns` 的顺序会被外部同步、导入、手动编辑改过，跟着它走等于随机挑一个基准。
 * * **宽**：统一到组内**最宽**的那个。往宽了取而不是往窄了取，因为变窄会让栏内卡片的
 *   可用宽度变小、正文重新折行、栏高跟着变 —— 用户会发现自己只是按了个"对齐"，
 *   版式却被改掉了。往宽只会多出右内边距，不伤内容。
 *
 * ★ **等宽之后必须把这一排横向重排**：加宽 A 而不动右邻 B 的 `x`，A 会直接压到 B 身上
 *   （`splitIntoColumns` 就是现成的例子：卡片宽 280 / 400 时两栏先被摆成 304 / 424，
 *   等宽到 424 后必然重叠 96px）。所以宽度一旦真的变了，就以最左边那栏为起点、
 *   按 `siblingGap` 重新排一遍 x —— 这也正是"同级分栏"该有的样子。
 *   反过来说：宽度没变时**绝不碰 x**，用户手动留出的间距不会被这行命令吃掉。
 *
 * ★ 只动分栏自己的 `y` / `width` / `x`，成员几何交给 `relayoutColumns()` 兜底重算：
 *   成员是派生状态（见文件头约定 1），在这里再算一遍就多了一处会漂移的实现。
 *
 * @param columnIds 种子分栏；它们的兄弟集合会取并集一起处理
 * @returns 是否真的改动了模型
 */
export function alignSiblingColumns(
  board: BoardFile,
  columnIds: readonly string[],
  digits = 2,
): boolean {
  if (columnIds.length === 0) return false;

  // 种子之间可能互为兄弟（框选中一整排）→ 用 Map 去重，避免同一组被处理多次
  const members = new Map<string, Column>();
  for (const id of columnIds) {
    for (const column of siblingColumnsOf(board, id)) members.set(column.id, column);
  }
  const group = [...members.values()];
  // 一张分栏没有"对齐"可言：返回 false 让它成为空操作（不记历史）
  if (group.length < 2) return false;

  const top = roundTo(Math.min(...group.map((column) => column.y)), digits);
  const width = roundTo(
    Math.max(Math.max(...group.map((column) => column.width)), COLUMN_LAYOUT.minWidth),
    digits,
  );

  // 横向重排（以及 x 的起点）用**当前的 x 顺序**：位置相同时用 id 兜底定序，
  // 免得同一份文件在两台机器上排成不同的左右关系
  const row = [...group].sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ★ 必须在改动**之前**判定"宽度要不要变"：循环跑完之后每栏的 width 都等于目标值，
  //   那时候再问就永远得到"没变"，横向重排会整段失效（等宽的分栏会悄悄互相重叠）
  const widthChanged = row.some((column) => column.width !== width);

  let changed = false;
  for (const column of row) {
    if (column.y !== top) {
      column.y = top;
      changed = true;
    }
    if (column.width !== width) {
      column.width = width;
      changed = true;
    }
  }

  // 只有宽度真的变了才重排 x（见上面那段"等宽之后必须横向重排"）
  if (widthChanged) {
    let cursor = roundTo(row[0].x, digits);
    for (const column of row) {
      if (column.x !== cursor) {
        column.x = cursor;
        changed = true;
      }
      cursor = roundTo(cursor + width + COLUMN_LAYOUT.siblingGap, digits);
    }
  }

  if (!changed) return false;

  // 宽度变了 → 成员的可用宽度也变了，必须重排（这里不看返回值：上面已经确定改了）
  relayoutColumns(board, digits);
  return true;
}

// ─────────────────────────────────────────────────────────────
// 落点（T1.55 插入线 / T1.56 栏内重排）
// ─────────────────────────────────────────────────────────────

/** 落点：插进哪个栏的第几位，以及插入线画在哪 */
export interface ColumnDropTarget {
  columnId: string;
  /** 插到第 `index` 张之前（`0..成员数`） */
  index: number;
  /** 插入线的世界坐标（一条水平线段） */
  line: Rect;
}

/**
 * 指针落在哪个分栏的哪个位置。
 *
 * ★ 命中用"可用区域"而不是"栏内卡片"：栏里的空白也是落点 ——
 *   只能插在卡片正上方的话，往空栏里放第一张卡就成了不可能完成的任务。
 *
 * 折叠的栏不接受落点：它连成员都不显示，插进去的东西会"消失"。
 *
 * ★ `scrollOf` 是"这一栏现在滚到哪了"（T2.03）。成员坐标是**未滚动**的模型值，
 *   而用户是照着屏幕上看到的位置往下放的 —— 不换算的话，在一个滚过的栏里，
 *   插入线会画在别处、卡片也会插到错的序号上（差多少全看滚了多远）。
 *   指针只有 `y` 需要换算（栏内滚动是纵向的）。
 */
export function findDropTarget(
  board: BoardFile,
  point: Point,
  exclude: ReadonlySet<string> = new Set(),
  scrollOf?: (columnId: string) => number,
): ColumnDropTarget | null {
  let best: Column | null = null;
  for (const column of board.columns) {
    if (column.collapsed) continue;
    // ★ 用**可见**高度算命中区（而不是内容高度）：T2.03 之后超出部分不再溢出栏外，
    //   多出来的内容也进不了"能放东西的地方"（否则能隔着 2000px 空白把卡丢进去）
    const content = Math.min(columnContentHeight(board, column), COLUMN_LAYOUT.maxAutoHeight);
    const height = Math.max(column.height, content) + COLUMN_LAYOUT.dropTolerance;
    if (!rectContainsPoint({ x: column.x, y: column.y, width: column.width, height }, point)) {
      continue;
    }
    // 同 `HitTest.hitTest`：z 大者胜。不假设数组有序 —— 它可能刚被 mutate 改过
    if (!best || column.z >= best.z) best = column;
  }
  if (!best) return null;

  const members = cardsInColumn(board, best.id).filter((card) => !exclude.has(card.id));
  const box = columnContentBox(best);
  const offset = Math.max(0, scrollOf?.(best.id) ?? 0);
  // 屏幕坐标 → 模型坐标（见文件头：视觉 = 模型 − offset）
  const probeY = point.y + offset;

  let index = 0;
  while (index < members.length && probeY > members[index].y + members[index].height / 2) {
    index += 1;
  }

  const line = insertLineAt(members, index, box, offset);
  // ★ 插入线必须留在**看得见**的地方：目标序号落在窗口之外时（栏滚过一段），
  //   线画在内容里就等于没画 —— 用户完全看不到"要插在这里"的提示。
  const windowBottom = roundTo(best.y + columnDisplayHeight(best) - COLUMN_LAYOUT.padding);
  line.y = Math.min(Math.max(line.y, box.top), Math.max(box.top, windowBottom - line.height));
  return { columnId: best.id, index, line };
}

/**
 * 插入线的位置：第 `index` 张卡**上方**的间隙中点。
 *
 * ★ 返回值必须换算回**视觉**坐标：插入线画在覆盖层上（世界坐标），
 *   直接用模型值的话，一个滚过的栏会把线画到栏外去。
 */
function insertLineAt(
  members: readonly Card[],
  index: number,
  box: { left: number; top: number; width: number },
  offset = 0,
): Rect {
  const { gap } = COLUMN_LAYOUT;
  const height = 1;
  // 成员坐标是模型值，插入线要的是视觉值
  const shift = (y: number): number => roundTo(y - offset);

  if (members.length === 0) {
    // 空栏：画在第一张卡该出现的地方，用户才知道"放进来会长这样"
    return { x: box.left, y: box.top, width: box.width, height };
  }
  if (index <= 0) {
    const first = members[0];
    return { x: box.left, y: shift(first.y - gap / 2), width: box.width, height };
  }
  const previous = members[Math.min(index, members.length) - 1];
  return {
    x: box.left,
    y: shift(previous.y + previous.height + gap / 2),
    width: box.width,
    height,
  };
}
