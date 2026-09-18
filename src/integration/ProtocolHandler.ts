/**
 * 白板 URI：`obsidian://nestboard?file=…&card=…`（T5.06 / `F10-06`）。
 *
 * ## 这东西解决什么问题
 *
 * `.nboard` 是普通文件，可以同步、可以 `git`、可以被任何笔记提到。但"**打开并定位到某一张卡**"
 * 在过去只能靠手：先打开板、再用搜索找那张卡。有了这条 URI，一块白板里的某张卡就变成了
 * 一个**可以写进任何笔记、任务列表、日程、外部 App 的地址** —— 这是"双链深化"里
 * 唯一一条能让**库外**的东西指回库内的通路（其余都是库内互指）。
 *
 * ## 本文件刻意是**纯逻辑**
 *
 * ★ 不 `import` 任何 `obsidian` 运行时值（连 `Notice` / `openBoardView` 都不引）。
 *   两个原因：
 *   1. 真正的风险在**解析与校验**（越界路径、非白板文件），那部分必须能被单测钉死；
 *   2. `node_modules/obsidian` 只有 `.d.ts`，运行期 import 它就等于这个模块在 node 下
 *      **加载即失败**（见 `04 §12.4`）。
 *   于是"弹什么提示""在哪个 leaf 里打开"这些**副作用**全留在 `main.ts` 的接线处 ——
 *   它们本来也只有在真机上才说得清。
 *
 * ## Obsidian 已经替我们做完的事（别重复做）
 *
 * - **参数已经解码过一次**。`registerObsidianProtocolHandler` 交上来的 `params` 里，
 *   `%20` 早就是空格了。所以这里**绝不做第二次 `decodeURIComponent`**：库里的文件名
 *   完全可能真的含 `%`（`100%完成.nboard`），再解一次轻则把路径弄错，重则
 *   `decodeURIComponent` 直接抛 `URIError`。双重编码那种写法（`%2520`）只能算调用方的 bug。
 * - **`vault` 参数由 Obsidian 自己处理**（它决定在哪个库里执行这次跳转），我们不碰。
 *   其余不认识的参数一律忽略 —— 协议要能向后兼容地加字段。
 */

import { normalizeBoardPath } from '../util/boardPath';
import type { BoardPathRejection } from '../util/boardPath';

/** 协议动作名。写在这里而不是 `constants.ts`：它是本模块的对外契约，只有它自己用得上 */
export const NESTBOARD_PROTOCOL = 'nestboard';

/** 一条解析成功的白板地址 */
export interface BoardUri {
  /** Vault 相对路径，已归一化（正斜杠、无前导斜杠），保证以 `.nboard` 结尾 */
  path: string;
  /** 要定位的卡片 id；没写 `card` 参数时为 `null`（= 只打开板，不动视口） */
  cardId: string | null;
}

/**
 * 拒绝的原因。
 *
 * ★ 做成**枚举**而不是一句现成的话：本模块不认识 i18n（那是 UI 层的事），
 *   由 `main.ts` 把原因翻成用户看得懂的一句话。这样文案能改、能加语言，
 *   而"为什么拒绝"的判断留在这里被测死。
 */
export type UriRejection =
  /** 没有 `file` 参数（或它是空白）—— 唯一一条"地址写残了" */
  | 'missing-file'
  /** `file` 指向的不是白板（扩展名不是 `.nboard`） */
  | 'not-a-board'
  /** `file` 里出现了 `..` —— 试图跳出库的路径一律拒绝 */
  | 'outside-vault';

export type UriParseResult = { ok: true; uri: BoardUri } | { ok: false; reason: UriRejection };

/** `file` 参数的候选名。`file` 是主名；后两个是"手写链接时顺手打的"宽容入口 */
const FILE_KEYS = ['file', 'path', 'board'] as const;

/** `card` 参数的候选名 */
const CARD_KEYS = ['card', 'cardId'] as const;

/**
 * 解析并校验协议参数。
 *
 * 宽容与严格的边界（这是本函数的全部设计）：
 * - **宽容**：`file` 可以写成 `Boards/A`（省掉扩展名，补 `.nboard`）、
 *   可以用反斜杠（Windows 的路径习惯）、可以带前导 `/`（`/Boards/A.nboard` 是最常见的写法）。
 *   这三件事都是"人写链接时会做的事"，为此弹一句"路径不合法"纯属刁难。
 * - **严格**：一旦**写出了别的扩展名**（`.md` / `.canvas`）就拒绝。这不是笔误，
 *   而是"指错东西了" —— 放它过去，用户会看到一块**名为某笔记的空板**（甚至更糟）。
 */
export function parseNestboardUri(params: Readonly<Record<string, unknown>>): UriParseResult {
  const raw = firstString(params, FILE_KEYS);
  if (raw === null) return { ok: false, reason: 'missing-file' };

  const normalized = normalizeBoardPath(raw);
  if (!normalized.ok) return { ok: false, reason: rejectionOf(normalized.reason) };

  return { ok: true, uri: { path: normalized.path, cardId: firstString(params, CARD_KEYS) } };
}

/**
 * `util/boardPath.ts` 的拒绝原因 → 本协议的拒绝原因。
 *
 * 唯一的差别是"空"：在设置面板里 `''` 是**合法值**（= 关掉 Home 白板），
 * 而在这里它只可能是"链接写残了"。
 */
function rejectionOf(reason: BoardPathRejection): UriRejection {
  return reason === 'empty' ? 'missing-file' : reason;
}

/** 按候选名顺序取第一个非空字符串；全都没有则 `null`。空白串等同于没写 */
function firstString(
  params: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * 生成一条白板 URI —— 与 {@link parseNestboardUri} 互为逆运算（有往返单测）。
 *
 * ★ 明明还没有 UI 入口，为什么现在就写：README 与用户说明书里要给出**可照抄**的链接格式，
 *   而"文档里手抄一遍 `encodeURIComponent`"正是最容易出错的一类文档（`Boards/My Board.nboard`
 *   少一个 `%20` 就指向不存在的文件，用户在别的设备上才发现）。让文档与代码共用这一个函数，
 *   格式就不可能两边漂。
 */
export function buildNestboardUri(path: string, cardId?: string | null): string {
  const query = `file=${encodeURIComponent(path)}`;
  const tail = cardId ? `&card=${encodeURIComponent(cardId)}` : '';
  return `obsidian://${NESTBOARD_PROTOCOL}?${query}${tail}`;
}
