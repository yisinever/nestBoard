/**
 * 跨白板搜索侧栏的纯逻辑（T7.02 / `F8-08`）。
 *
 * 与 `ui/boardList.ts` 同一个理由：`ui/BoardSearchPanel.ts` 里的东西大多**没法测**
 * （`ItemView` 要 Obsidian 宿主），但侧栏真正容易写错的那几处恰恰又不碰 DOM ——
 * 状态行该说什么、片段怎么切、什么时候该重画。把它们放在这里，就能在 node 下钉住；
 * 面板那边只管把结果摆进 DOM。
 *
 * 拆出来的三件事，每一件都对应一类"错了不报错、只表现为怪"的 bug：
 *
 *  * `statusText` —— 把"正在索引"说成"没有结果"，用户会以为功能坏了；
 *  * `snippetParts` —— 切错位置就会**丢字或重复字**，而屏幕上看起来只是"片段有点怪"；
 *  * `boardSearchSignature` —— 指纹漏了字段会导致"内容变了却不重画"（或反过来狂闪）。
 */

import type { BoardMatch, BoardSearchHit, BoardSearchStatus } from '../model/boardSearch';
import { t } from '../util/i18n';

/**
 * 状态行文案。
 *
 * ★ 三种 `kind` 各自成句，**不拼接**：`"3 条结果" + "（仍在索引…）"` 这种拼法在
 *   英语里语序不一样、在日语里要接在动词后面 —— 一旦拼了就再也改不回来。
 */
export function statusText(status: BoardSearchStatus): string {
  switch (status.kind) {
    case 'hint':
      return t('boardSearch.hint');
    case 'empty':
      // ★ 扫描没走完时不能说"没有任何白板匹配"：那是把"还没找"说成"找不到"
      return status.scanning
        ? t('boardSearch.scanning', { scanned: status.scanned })
        : t('boardSearch.empty', { indexed: status.indexed });
    case 'count':
      return status.scanning
        ? t('boardSearch.countScanning', { hits: status.hits, boards: status.boards })
        : t('boardSearch.count', { hits: status.hits, boards: status.boards });
  }
}

/** 片段切成三段，中间那段是要加 `<mark>` 的 */
export interface SnippetParts {
  before: string;
  match: string;
  after: string;
}

/**
 * 把片段按命中位置切成三段。
 *
 * ★ 越界**夹住**而不是信任调用方：`matchStart` / `matchLength` 来自匹配层，看起来
 *   总是合法的；但一旦哪天不合法（片段被截断、规则改了），不夹住的结果是
 *   **静默丢字或重复字** —— 屏幕上只是"这句话读起来有点怪"，没人会去查。
 *   夹住之后有一条恒等式可以断言：`before + match + after === snippet`。
 */
export function snippetParts(
  snippet: string,
  matchStart: number,
  matchLength: number,
): SnippetParts {
  const start = clamp(matchStart, 0, snippet.length);
  const end = clamp(matchStart + matchLength, start, snippet.length);
  return {
    before: snippet.slice(0, start),
    match: snippet.slice(start, end),
    after: snippet.slice(end),
  };
}

/**
 * 内容指纹：查询词 + 状态 + 每条命中的身份。
 *
 * 面板拿它当"要不要重画"的判据。索引**每扫完一片**就会广播一次，而扫描几十块板的
 * 过程中可能连着好几片都只带回来"结果没变" —— 无条件重画会让列表在启动时不停闪，
 * 用户刚滚动到的位置每隔两秒被弹回顶部一次。
 *
 * ★ 用 `\u0000` 做字段分隔符（路径里不可能出现它），避免 `A + BC` 与 `AB + C`
 *   拼出同一个字符串这种经典误判。
 * ★ 状态里的**进度数字**也要进指纹：扫描往前走了，状态行那句"已索引 n 块"就得重写。
 */
export function boardSearchSignature(
  query: string,
  status: BoardSearchStatus,
  hits: readonly BoardSearchHit[],
  boards: readonly BoardMatch[],
): string {
  const hitParts = hits.map(
    (hit) =>
      `${hit.boardPath}\u0000${hit.cardId}\u0000${hit.field}\u0000` +
      `${hit.matchStart}\u0000${hit.matchLength}\u0000${hit.snippet}`,
  );
  return [
    query,
    statusKey(status),
    boards.map((board) => board.path).join('\u0001'),
    hitParts.join('\n'),
  ].join('\u0002');
}

/** 状态部分的指纹（与 `boardSearchSignature` 分开只是为了让那个函数读起来短一点） */
function statusKey(status: BoardSearchStatus): string {
  switch (status.kind) {
    case 'hint':
      return 'hint';
    case 'empty':
      return `empty\u0000${status.scanned}\u0000${status.indexed}\u0000${status.scanning}`;
    case 'count':
      return `count\u0000${status.hits}\u0000${status.boards}\u0000${status.scanning}`;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
