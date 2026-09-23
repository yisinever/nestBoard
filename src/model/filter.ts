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
 * ★ **脑图节点**（`2.2.0` 批 4）不在这条路上，而是 {@link dimmedMindNodeKeys}：
 *   卡片这一档仍然只扫 `board.cards`（调用方一行都不用改），节点那一档单独给 ——
 *   两者的**键**根本不是一套（卡片是自己的 id，节点是 `脑图id/节点id`），
 *   合并只能靠调用方拼，不如各给一个函数、各自说清自己的口径。
 */

import { cardMatchesTerms, mindNodeMatchesTerms, parseTerms } from './search';
import { CARD_TYPES, nodeEndpointKey } from './schema';
import type { BoardFile, Card, CardType, Mind } from './schema';
import type { MindFile } from '../mind/model/schema';

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

/**
 * 过滤面板列出的卡片类型（"老卡类型退出"的一部分，`2.2.0` 收尾）。
 *
 * ★ `2.2.0` 起 `mind` / `mindRef` **不再是会出现在板子上的卡片**：它们只在**读入口**
 *   存在（老文件进来时被转成白板级容器，见 `model/validate.mindFromLegacyCard`）。
 *   所以过滤条不该再列它们 —— 留着的效果是"两个永远筛不出任何东西的开关"。
 * ★ **不能**动 `CARD_TYPES` 本身：`isCardType` 同时把着读入口，从名册里删掉的话，
 *   老文件里的脑图卡会被当成"未知类型"丢弃（树就没了）。
 */
export const FILTERABLE_TYPES: readonly CardType[] = CARD_TYPES.filter(
  (type) => type !== 'mind' && type !== 'mindRef',
);

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
 * 算出**该变淡的脑图节点**（`2.2.0` 批 4），键是端点的几何键
 * （`脑图id/节点id`，`schema.nodeEndpointKey` —— 与连线那一侧同一把尺子）。
 *
 * ── 两条刻意的口径 ──────────────────────────────────────────────
 *
 * 1. **按节点，不按整棵树**。用户在一棵树里搜一个词，要的是"这棵树里哪个节点在说这件事"
 *    —— 整棵变淡 / 整棵留亮都答不了这个问题（而且"整棵留亮"等于过滤对脑图完全无效）。
 * 2. **只认文本维度**。`types` / `onlyBroken` 两个维度**不施加**于节点：
 *    节点没有类型、也没有链接，"拿它没有的属性去惩罚它"没有道理 —— 用户勾"只看待办"
 *    是想在卡片里找待办，不是想宣布脑图不存在。判据只有一条：**维度必须是这个对象
 *    真的有的属性**。于是只剩 0 个词条时（只勾了类型 / 断链）直接返回空集。
 *
 * ★ `mindModelOf` 与搜索面板用的是同一个来源（`BoardView.mindModelForMap`）：
 *   指向 `.nestmind` 的树，模型住在仓储里，白板文件本身没有 —— 读不到（文件没了 /
 *   还没读回来）就**这一棵不参与**（与缩略图 / 导出同一条口径：宁可少过滤一棵，
 *   也不要在这一层同步等一次读盘）。
 * ★ 返回"该变淡的"而不是"匹配的"：与 {@link filteredOutIds} 同一个理由 ——
 *   过滤的常态是"几百个里挑出几个"，该变淡的那一堆才是要逐节点去写 class 的。
 */
export function dimmedMindNodeKeys(
  board: BoardFile,
  filter: CardFilter,
  mindModelOf: (mind: Mind) => MindFile | null,
): Set<string> {
  const out = new Set<string>();
  if (!isFilterActive(filter)) return out;
  const terms = parseTerms(filter.query);
  // 没有文本词条（只勾了类型 / 断链）⇒ 脑图这一档不参与，见上面第 2 条
  if (terms.length === 0) return out;

  for (const mind of board.minds ?? []) {
    const model = mind.path.length === 0 ? (mind.mind ?? null) : mindModelOf(mind);
    if (!model) continue;
    for (const node of model.nodes) {
      if (!mindNodeMatchesTerms(node, terms)) out.add(nodeEndpointKey(mind.id, node.id));
    }
  }
  return out;
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
