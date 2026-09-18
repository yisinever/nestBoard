/**
 * 画布卡片过滤（T3.17 / T3.18 / `F8-04` / `F8-06`）。
 *
 * 与"搜索定位"（`model/search.ts`）是两件不同的事：
 *  * 搜索是**去找**一张卡 —— 找到就飞过去、高亮一下，其余卡片照旧；
 *  * 过滤是**缩小视野** —— 不匹配的卡片留在原地、只是变淡（见 `CardLayer.setDimmed`）。
 *    用户要的是"在这堆里，哪些是待办 / 哪些引用了那篇笔记"，而不是"把那几张抠走"。
 *
 * 三个维度可以叠加（AND）：文本、类型、是否断链。全部为空 = 不过滤。
 *
 * ★ 文本维度复用 `model/search.ts` 的字段与匹配规则：面板里搜得到的，画布上
 *   就必须留亮；两处各写一套匹配，迟早会出现"搜得到却是淡的"。
 * ★ 标签（T3.18）不需要单独的维度 —— 便签正文里的 `#标签` 本来就是文本的一部分，
 *   用户输入 `#周报` 走的正是文本匹配。多做一个"标签列表"只会多一份要维护的状态。
 */

import { cardMatchesTerms, parseTerms } from './search';
import { CARD_TYPES } from './schema';
import type { BoardFile, Card, CardType } from './schema';

/** 过滤器状态。**空态**见 {@link NO_FILTER} */
export interface CardFilter {
  /** 自由文本（AND 词条；`#标签` 也走这里） */
  query: string;
  /** 只看这些类型；**空集 = 不按类型过滤**（而不是"什么都不显示"） */
  types: ReadonlySet<CardType>;
  /** 只看有断链引用的卡片 */
  onlyBroken: boolean;
}

export const NO_FILTER: CardFilter = { query: '', types: new Set(), onlyBroken: false };

/** 全部卡片类型（过滤面板按这个顺序列开关） */
export const FILTERABLE_TYPES: readonly CardType[] = CARD_TYPES;

/** 过滤器是否真的在起作用（决定要不要给卡片加变淡的 class） */
export function isFilterActive(filter: CardFilter): boolean {
  return filter.query.trim().length > 0 || filter.types.size > 0 || filter.onlyBroken;
}

/**
 * 算出**被过滤掉**（不匹配）的卡片 id。
 *
 * 返回"被过滤掉"而不是"匹配的"：调用方要的是给这些卡加变淡 class，
 * 而"没被过滤掉"的集合在活跃过滤下往往远大于前者（几百张里挑出三张）。
 *
 * ★ 过滤器不活跃时返回**空集**（而不是全集）：这样调用方不必先判活跃性 ——
 *   空集喂给 `setDimmed` 正好等于"谁都不变淡"。
 */
export function filteredOutIds(
  board: BoardFile,
  filter: CardFilter,
  isBroken: (cardId: string) => boolean,
): Set<string> {
  const out = new Set<string>();
  if (!isFilterActive(filter)) return out;
  for (const card of board.cards) {
    if (!cardPassesFilter(card, filter, isBroken)) out.add(card.id);
  }
  return out;
}

/** 匹配数（面板上的"N / M"用它）。与 `filteredOutIds` 共用同一套判据 */
export function matchedCount(
  board: BoardFile,
  filter: CardFilter,
  isBroken: (cardId: string) => boolean,
): number {
  if (!isFilterActive(filter)) return board.cards.length;
  let count = 0;
  for (const card of board.cards) {
    if (cardPassesFilter(card, filter, isBroken)) count += 1;
  }
  return count;
}

/**
 * 单张卡片是否通过过滤（三个维度 AND）。
 *
 * ★ 每次调用都重新解析词条，看起来"浪费" —— 但 `parseTerms` 只是对一行输入
 *   split/lowercase（几微秒），而把解析结果当参数传来传去会让调用点扩散。
 *   过滤是**用户敲字才触发**的动作，不是每帧跑的路径，这点代价换更少的接口面值得。
 */
export function cardPassesFilter(
  card: Card,
  filter: CardFilter,
  isBroken: (cardId: string) => boolean,
): boolean {
  if (filter.types.size > 0 && !filter.types.has(card.type)) return false;
  if (filter.onlyBroken && !isBroken(card.id)) return false;
  const terms = parseTerms(filter.query);
  if (terms.length > 0 && !cardMatchesTerms(card, terms)) return false;
  return true;
}
