/**
 * 白板内搜索（T2.09 / `F8-01`：便签文本 + 卡片标题 + 文件名）。
 *
 * 纯函数、零依赖，因此可以直接对着"10k 卡片 ≤ 200ms"（`F8-01` 的验收线）跑单测 ——
 * 搜索是**每敲一个字就重算一次**的东西，把它的代价锁在模型层是最省事的办法：
 * UI 层无论怎么优化（防抖、增量），天花板都由这里决定。
 *
 * 三条设计约定：
 *
 * 1. **AND 语义 + 子串匹配**，不做模糊/拼音/分词。用户在白板上搜的是"我写下的那句话
 *    里的词"，子串已经是他们期待的语义；上模糊匹配只会让"搜 A 却排在最前面的是 B"
 *    这种结果出现。多个词之间是 AND（`"图 表格"` = 同时含这两个字），
 *    因为空格在中文输入里是**分隔意图**，不是"要搜一个空格"。
 * 2. **标题命中永远优先于正文命中**（见 `FIELD_WEIGHT`）。用户搜 "周报"，
 *    标题叫《周报》的那张卡必须排在"正文里提了一句周报"的卡前面 ——
 *    否则结果列表第一屏全是噪音，搜索等于没用。
 * 3. **返回的是"片段"而不是整段文本**：便签可能有几千字，把全文甩给面板会让
 *    渲染与 DOM 都变重，而用户要的只是"我为什么搜到它"。
 */

import type { BoardFile, Card, CardType } from './schema';

/** 命中在卡片的哪个字段上（面板据此显示标签，也参与排序权重） */
export type SearchField = 'title' | 'text' | 'path' | 'url';

export interface SearchHit {
  cardId: string;
  type: CardType;
  field: SearchField;
  /** 卡片自己的标题；空串 = 这张卡没标题（面板不该显示一行空白） */
  title: string;
  /** 命中处附近的一小段原文，两端可能带 `…` */
  snippet: string;
  /** 命中片段在 `snippet` 中的起点（`<mark>` 从这里开始） */
  matchStart: number;
  /** 命中片段的长度（原文长度，不含 `…`） */
  matchLength: number;
}

/** 最多给多少条结果。再多用户也不会翻，而面板每多一条就多一次 DOM 构造 */
export const MAX_SEARCH_HITS = 50;

/** 片段命中处前后各留多少字符 */
const SNIPPET_PAD = 24;

/**
 * 字段权重，**数值越小越优先**。
 *
 * 权重之间隔了 `1e6`（见 `scoreOf`），所以"标题里第 5000 个字命中"也仍然排在
 * "正文第一个字命中"的前面 —— 这是刻意的：标题是用户自己起的名字，
 * 它命中意味着这张卡**就是**在说这件事；正文命中可能只是一句无关的引用。
 */
const FIELD_WEIGHT: Record<SearchField, number> = { title: 0, path: 1, url: 1, text: 2 };

/** 权重之间的间隔，必须大于"文本长度"能取到的最大值 */
const WEIGHT_STRIDE = 1e6;

/**
 * 在**已经拿到的**白板快照上搜索。
 *
 * ★ 传快照而不是"自己去取当前白板"：面板开着的时候用户可能撤销、删卡、切换白板，
 *   只有调用方知道"此刻该搜哪一份"。而且这使得本函数可以脱离视图单测。
 */
export function searchBoard(
  board: BoardFile,
  query: string,
  limit: number = MAX_SEARCH_HITS,
): SearchHit[] {
  const terms = parseTerms(query);
  if (terms.length === 0 || limit <= 0) return [];

  const hits: { hit: SearchHit; score: number }[] = [];
  for (const card of board.cards) {
    const match = bestMatchOf(card, terms);
    if (match) hits.push(match);
  }

  // `Array#sort` 在 V8 里是稳定的 → 同分结果保持 `board.cards` 的原有顺序，
  // 不会出现"两次搜同一个词，顺序不一样"这种让人怀疑搜索结果在乱跳的现象
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, limit).map((item) => item.hit);
}

/** 把用户输入切成 AND 词条（小写、去空、折掉多余空白） */
export function parseTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * 一张卡是否命中给定的**已解析**词条（AND 语义）。
 *
 * ★ 给画布过滤（T3.17 / T3.18）复用：搜索面板与画布过滤必须用**同一套**字段与
 *   匹配规则 —— 两处各写一套的话，用户会遇到"面板里搜得到、画布上却不变淡"
 *   这种没法解释的不一致。所以字段枚举（`searchableFields`）与折空白（`collapse`）
 *   都留在本文件，只在外面开这一个口子。
 *
 * ★ 空词条 = 全部命中（不是"全不命中"）：过滤词还没敲时不该把整块板变淡。
 */
export function cardMatchesTerms(card: Card, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  return searchableFields(card).some((field) => {
    const haystack = collapse(field.text).toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

// ── 内部 ──────────────────────────────────────────────────────

interface SearchableField {
  field: SearchField;
  text: string;
}

/**
 * 一张卡上所有**人能搜到的文本**，顺序与内部字段表一致（标题永远在最前）。
 *
 * ★ 导出它是为了"别再列第二份字段表"：`F5-07` 按标签自动分栏要从卡片文本里认 `#标签`，
 *   它认的字段必须与搜索认的完全一致 —— 分两处各写一遍的话，迟早出现
 *   "搜索搜得到的标签，分栏却看不见"（或者反过来），而那种不一致用户根本没法解释。
 */
export function searchableTexts(card: Card): string[] {
  return searchableFields(card).map((field) => field.text);
}

/** 一张卡上所有可被搜到的字段。第一个永远是标题 */
function searchableFields(card: Card): SearchableField[] {
  const fields: SearchableField[] = [{ field: 'title', text: card.title }];

  switch (card.type) {
    case 'note':
      fields.push({ field: 'text', text: card.content.md });
      break;
    // 同步便签（T7.04）的正文就是便签的正文：同组里每一张各存一份，于是"搜这块板"
    // 会在它出现的每一处都命中 —— 那正是它们在板上真实的样子（与画布过滤同一份字段表）
    case 'syncNote':
      fields.push({ field: 'text', text: card.content.md });
      break;
    case 'noteRef':
      fields.push({ field: 'path', text: card.content.path });
      break;
    case 'image':
      fields.push({ field: 'path', text: card.content.path });
      // 说明文字也是用户写的，理应搜得到
      fields.push({ field: 'text', text: card.content.caption });
      break;
    case 'file':
      fields.push({ field: 'path', text: card.content.path });
      break;
    case 'link':
      fields.push({ field: 'url', text: card.content.url });
      fields.push({ field: 'text', text: card.content.description });
      break;
    case 'todo':
      fields.push({ field: 'text', text: card.content.title });
      for (const item of card.content.items) fields.push({ field: 'text', text: item.text });
      break;
    // 评论卡（T7.05）：线程里每一条都是用户写下的字，逐条进搜 ——
    // "搜这块板"能把"上周那条关于 X 的备注"捞出来，那正是备注存在的意义
    case 'comment':
      for (const entry of card.content.entries) fields.push({ field: 'text', text: entry.text });
      break;
    case 'boardRef':
      fields.push({ field: 'path', text: card.content.path });
      break;
    case 'map':
      fields.push({ field: 'path', text: card.content.path });
      // 地点名是这张卡上唯一由用户写下的文字，理应搜得到（同图片卡的说明文字）
      fields.push({ field: 'text', text: card.content.label });
      break;
    case 'swatch':
    case 'ink':
      // 色板只有色号、手绘只有坐标 —— 都不是人能"搜"的东西
      break;
    // 视频卡（`A1`）：内容就是一个路径 ⇒ 能搜的是**文件名**（与文件卡同一条）
    case 'video':
      fields.push({ field: 'text', text: card.content.path });
      break;
    // 音频卡（`A2`）：同上
    case 'audio':
      fields.push({ field: 'text', text: card.content.path });
      break;
    // 仅标题卡（`A3`）：能搜的那行字**已经在最前面的标题里**（`{ field: 'title' }`）——
    // 那行字 = `card.title`（用户 2026-09-18 起），不必再塞一份重复的
    case 'titleCard':
      break;
    // 图集卡（`A4`）：这一组图的路径都放进去 —— 搜其中任何一个文件名都该命中它
    case 'gallery':
      for (const path of card.content.paths) fields.push({ field: 'text', text: path });
      break;
    default:
      assertNever(card);
      break;
  }

  return fields;
}

/**
 * 编译期穷举检查。
 *
 * ★ 将来加第 10 种卡片类型时，`switch` 少一个 `case` 会让这一行**编译不过**，
 *   逼着实现者想清楚"新类型的哪段文本该被搜到"。不做这个检查的话，新类型会
 *   静默地只搜标题 —— 用户搜不到它的正文，只会以为索引坏了。
 */
function assertNever(value: never): void {
  void value;
}

/** 找出一张卡上**最优**的那处命中（分越高越差，取最小） */
function bestMatchOf(
  card: Card,
  terms: readonly string[],
): { hit: SearchHit; score: number } | null {
  let best: { hit: SearchHit; score: number } | null = null;

  for (const candidate of searchableFields(card)) {
    const text = collapse(candidate.text);
    if (text.length === 0) continue;
    const haystack = text.toLowerCase();

    // 所有词都要出现（AND）。命中位置取**最早**的那个词 —— 列表里显示的是
    // 片段开头，太靠后的命中会让片段看起来"跟搜索词没关系"
    let first = -1;
    let firstLength = 0;
    let all = true;
    for (const term of terms) {
      const at = haystack.indexOf(term);
      if (at < 0) {
        all = false;
        break;
      }
      if (first < 0 || at < first) {
        first = at;
        firstLength = term.length;
      }
    }
    if (!all) continue;

    const score = FIELD_WEIGHT[candidate.field] * WEIGHT_STRIDE + first;
    if (best && best.score <= score) continue;

    best = {
      hit: {
        cardId: card.id,
        type: card.type,
        field: candidate.field,
        title: card.title,
        ...snippetOf(text, first, firstLength),
      },
      score,
    };
  }

  return best;
}

/**
 * 折掉换行与连续空白。
 *
 * ★ 必须在**匹配之前**做：便签是多行 Markdown，`indexOf` 在原始文本上算出的位置，
 *   放进折过空白的片段里会错位（高亮标到别的字上）。先折再匹配，两边才是同一把尺子。
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 取命中处前后各 `SNIPPET_PAD` 个字符，两端按需补 `…` */
function snippetOf(
  text: string,
  index: number,
  length: number,
): { snippet: string; matchStart: number; matchLength: number } {
  const start = Math.max(0, index - SNIPPET_PAD);
  const end = Math.min(text.length, index + length + SNIPPET_PAD);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';

  return {
    snippet: `${prefix}${text.slice(start, end)}${suffix}`,
    // 前缀省略号也要算进去，否则高亮会整体左移一格
    matchStart: prefix.length + (index - start),
    matchLength: length,
  };
}
