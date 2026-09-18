/**
 * 跨白板搜索的合并与排序（T7.02 / `F8-08`）。
 *
 * `model/search.ts` 回答的是"**这一块**板上哪儿命中了"；本文件回答下一个问题：
 * "库里**每一块**板上哪儿命中了，而我该先看哪一条"。它只做合并、分层、截断三件事，
 * 匹配规则一个字都不重写 —— 字段表、片段坐标、大小写规则全部来自 `searchBoard`，
 * 所以"面板里搜得到、跨板搜索搜不到"这种没法向用户解释的偏差不会出现。
 *
 * ## 三层排序
 *
 * 结果顺序按 `[这块板的板名是不是你要找的] → [命中在哪一栏] → [先来后到]`：
 *
 * 1. **板名命中排最前**。用户敲"周报"时，那块**就叫**《周报》的板上的东西必须先出现 ——
 *    否则他会以为"跨板搜索找不到我的周报"。
 * 2. 其次看**命中在哪一栏**（标题 → 路径 / 链接 → 正文），权重表与板内搜索同一个
 *    理由：标题是用户自己起的名字，它命中意味着这张卡**就是**在说这件事。
 * 3. 最后是"先来后到"（板序 → 板内原有顺序）。**不按分数细排**：跨板搜索的每一层
 *    都可能有几十条并列，再排下去就成了"同样的查询两次结果顺序不一样"。
 *
 * ## 板名命中为什么不冒充成一条卡片结果
 *
 * 板名命中时**没有卡片可指**。硬凑一条 `cardId` 为空的结果，点下去就得先判断
 * "这条能不能跳" —— 界面上的每个按钮都得带一个自己用不上的例外。所以板名命中
 * **单列一组**（`boards`）：那一组的每一条就是"打开这块板"，语义干净且不骗人。
 *
 * 纯函数、零依赖：不 import `obsidian`、不碰 DOM，可直接在 node 下单测。
 */

import { splitName } from '../util/fileName';
import { MAX_SEARCH_HITS, parseTerms, searchBoard } from './search';
import type { SearchField, SearchHit } from './search';
import type { BoardFile } from './schema';

/** 一次跨板搜索最多给多少条卡片结果 */
export const MAX_BOARD_SEARCH_HITS = 100;

/**
 * 板名命中的白板最多列几块。
 *
 * ★ 比卡片结果的上限紧得多：这一组是"顺带告诉你哪块板叫这个名字"，它不是主体结果，
 *   而它在侧栏里**压在卡片结果上面**占地方。100 块板名符合查询时，列到第 30 块
 *   对谁都没用，却把真正的卡片命中全挤到折叠线以下。
 */
export const MAX_BOARD_MATCHES = 10;

/**
 * 单块板最多贡献几条。
 *
 * ★ 与白板内搜索同一个上限（`MAX_SEARCH_HITS`）：一块几千张卡的大板可能在正文里
 *   命中几百次，不压住的话"跨板"就成了"跨进那最大的一块板"。
 */
const PER_BOARD_HITS = MAX_SEARCH_HITS;

/** 一条跨板命中：板内命中的全部字段 + 它属于哪块板 */
export interface BoardSearchHit extends SearchHit {
  boardPath: string;
  boardTitle: string;
}

/** 板名命中的白板（没有卡片可指，只给"打开它"） */
export interface BoardMatch {
  path: string;
  title: string;
}

/** 参与搜索的一块板（索引层交给本模块的最小输入） */
export interface BoardSearchCandidate {
  path: string;
  title: string;
  board: BoardFile;
}

export interface CrossBoardSearchResult {
  /** 卡片命中，已按下面的三层规则排好序 */
  hits: BoardSearchHit[];
  /** 板名命中的白板，按输入顺序 */
  boards: BoardMatch[];
}

/**
 * 侧栏那一行状态该说什么。
 *
 * ★ 抽成纯函数是为了"**扫描没走完时不能说『没有』**"这条契约能被钉住：把
 *   "正在索引"与"确实没有"混成一句话，用户会以为功能坏了，而它只是还没扫完。
 */
export type BoardSearchStatus =
  | { kind: 'hint' }
  | { kind: 'empty'; scanned: number; indexed: number; scanning: boolean }
  | { kind: 'count'; hits: number; boards: number; scanning: boolean };

/** 索引层的当前进度（状态判定的输入；只读快照，不给调用方碰索引本身） */
export interface BoardSearchProgress {
  ready: boolean;
  /** 已扫完的板数 */
  scanned: number;
  /** 索引里现有的板数 */
  indexed: number;
}

/** 命中在哪一栏 → 排序层级。与 `model/search.ts` 的 `FIELD_WEIGHT` 同序 */
const FIELD_RANK: Record<SearchField, number> = { title: 0, path: 1, url: 1, text: 2 };

interface RankedHit {
  hit: BoardSearchHit;
  /** 0 = 这块板的板名命中了查询词 */
  boardRank: number;
  fieldRank: number;
  /** 全局插入序号（板序 → 板内原有顺序）。同层并列时用它做最后一道稳定键 */
  order: number;
}

/**
 * 在**多块板的快照**上搜索。
 *
 * ★ 与 `searchBoard` 同样只吃快照：调用方（侧栏）要能对着"打开这一刻的索引"反复查询，
 *   而这个函数可以脱离视图、脱离索引对象单独测。
 *
 * ★ 空查询返回**空结果**而不是"列出全部卡片"：与板内搜索同一条规矩 ——
 *   输入框还没敲字时，用户要的是一句"输入关键词开始搜索"，不是整个库。
 */
export function searchAcrossBoards(
  candidates: readonly BoardSearchCandidate[],
  query: string,
  limit: number = MAX_BOARD_SEARCH_HITS,
): CrossBoardSearchResult {
  const terms = parseTerms(query);
  if (terms.length === 0 || limit <= 0) return { hits: [], boards: [] };

  const boards: BoardMatch[] = [];
  const ranked: RankedHit[] = [];
  let order = 0;

  for (const candidate of candidates) {
    const matched = boardTitleMatches(candidate, terms);
    if (matched) boards.push({ path: candidate.path, title: candidate.title });

    const boardRank = matched ? 0 : 1;
    for (const hit of searchBoard(candidate.board, query, PER_BOARD_HITS)) {
      ranked.push({
        hit: { ...hit, boardPath: candidate.path, boardTitle: candidate.title },
        boardRank,
        fieldRank: FIELD_RANK[hit.field],
        order: order++,
      });
    }
  }

  ranked.sort(
    (a, b) => a.boardRank - b.boardRank || a.fieldRank - b.fieldRank || a.order - b.order,
  );

  return {
    hits: ranked.slice(0, limit).map((item) => item.hit),
    boards: boards.slice(0, MAX_BOARD_MATCHES),
  };
}

/**
 * 这块板的**板名**是否命中（词条已解析、AND 语义，与卡片搜索同一套 `parseTerms`）。
 *
 * ★ 板名为空时退回看**文件名**：`meta.title` 是可以被清空的，而侧栏在没有标题时
 *   显示的正是文件名 —— 用户看着屏幕上写着《周报》却搜不到它，是纯粹的坏体验。
 */
export function boardTitleMatches(
  candidate: { path: string; title: string },
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return false;
  const name = candidate.title.length > 0 ? candidate.title : splitName(candidate.path).base;
  const haystack = name.trim().toLowerCase();
  if (haystack.length === 0) return false;
  return terms.every((term) => haystack.includes(term));
}

/** 侧栏状态行说什么（见 `BoardSearchStatus`） */
export function boardSearchStatus(
  query: string,
  result: CrossBoardSearchResult,
  progress: BoardSearchProgress,
): BoardSearchStatus {
  if (parseTerms(query).length === 0) return { kind: 'hint' };

  const scanning = !progress.ready;
  if (result.hits.length === 0 && result.boards.length === 0) {
    return { kind: 'empty', scanned: progress.scanned, indexed: progress.indexed, scanning };
  }
  return { kind: 'count', hits: result.hits.length, boards: result.boards.length, scanning };
}
