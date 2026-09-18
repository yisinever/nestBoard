/**
 * 「整理未使用附件」（T4.05 / `03 §4`）。
 *
 * 规格只有两句话，而第二句才是重点：
 *
 *   * 列出白板内已无引用的附件；
 *   * **只提示不自动删**（用户可能别处还在用）。
 *
 * ★ 所以这个模块只干一件事：**把"没人引用"这个事实算出来**，并且把"本板不再用、
 *   但别的白板 / 笔记还在用"的那些**单独分出来**。删除是用户自己的事 ——
 *   `03 §4` 把"绝不自动删除"写死了，这里连一个删除动作都不提供。
 * ★ 不 import `obsidian`：候选集、引用集、路径解析全由调用方注入。于是
 *   "什么算未使用"这条规则可以在 node 下被完整钉住（这是本任务唯一值得测的部分）。
 */

import { BOARD_EXT } from '../constants';

/** 把候选、本板引用、别处引用三份输入喂进来 */
export interface AttachmentAuditInput {
  /** 候选：附件目录里的文件（vault 路径）。调用方已用 `isAttachmentCandidate` 筛过 */
  candidates: readonly string[];
  /** **这块白板**引用到的原始路径（`collectRefs(board)` 的 `path`，可能是短名） */
  boardRefs: Iterable<string>;
  /** **除这块白板之外**还在用的原始路径（其他白板 + 笔记里的引用） */
  otherRefs: Iterable<string>;
  /**
   * 原始路径 → vault 路径（`getFirstLinkpathDest` 那套解析）。
   * 返回 `null` = 解析不出来。
   */
  resolve: (raw: string) => string | null;
}

/**
 * 三份互不重叠的清单。
 *
 * ★ 三者**恰好等于** `candidates`（可解析的那些）：这个不变式让"报告为什么这么长"
 *   永远解释得清 —— 少于期望值只可能是候选集没找全，不会是分类漏了一类。
 */
export interface AttachmentAuditResult {
  /** 这块白板还在引用的（正常情况下不给人看，只用来核对"报的数对不对"） */
  usedByBoard: string[];
  /** 本板不再引用，但**别处还在用** —— `03 §4` 那句"用户可能别处还在用"就是这一类 */
  usedElsewhere: string[];
  /** 谁都没引用。**仍然只提示不自动删** */
  unused: string[];
}

/** 排序用：`localeCompare` 在不同 ICU 下结果可能不同，这里要的是**确定性** */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 分类。
 *
 * ★ 优先级是"本板 > 别处 > 谁都没用"：同一个文件被本板和其他地方同时引用时算
 *   `usedByBoard`。反过来的话，本板唯一在用的那张图会被报成"别处还在用"，
 *   看起来像"你删了它别处就坏"—— 而事实是"这块板正靠它活着"。
 */
export function classifyAttachments(input: AttachmentAuditInput): AttachmentAuditResult {
  const byBoard = resolveAll(input.boardRefs, input.resolve);
  const elsewhere = resolveAll(input.otherRefs, input.resolve);

  const usedByBoard: string[] = [];
  const usedElsewhere: string[] = [];
  const unused: string[] = [];

  for (const candidate of input.candidates) {
    if (byBoard.has(candidate)) usedByBoard.push(candidate);
    else if (elsewhere.has(candidate)) usedElsewhere.push(candidate);
    else unused.push(candidate);
  }

  return {
    usedByBoard: usedByBoard.sort(byPath),
    usedElsewhere: usedElsewhere.sort(byPath),
    unused: unused.sort(byPath),
  };
}

function resolveAll(raw: Iterable<string>, resolve: (raw: string) => string | null): Set<string> {
  const out = new Set<string>();
  for (const item of raw) {
    const resolved = resolve(item);
    // ★ 解析不出来就**当它没引用**：宁可少报一个未使用文件（用户少一个可删项），
    //   也不要多报（用户可能因此删掉一个正在用的附件）。风险全压在"少报"这一侧。
    if (resolved !== null) out.add(resolved);
  }
  return out;
}

/**
 * 这个路径算不算"附件候选"。
 *
 * 排除三类，每一条都有理由：
 *
 *  * `.md`   —— 笔记不是附件。把它们列进"未使用附件"会让用户以为该删自己的笔记；
 *  * `.nboard` —— 白板也不是附件（何况子板被引用时本来就该出现在白板卡上）；
 *  * 任一路径段以 `.` 开头 —— `.obsidian/`、`.trash/`、`.nestboard-history/`
 *    全是插件自己或 Obsidian 的地盘。特别是**快照目录**：那里的副本一旦被列进
 *    "未使用"，用户删掉就等于毁掉回滚退路。
 */
export function isAttachmentCandidate(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith('.')) return false;
  if (path.includes('/.')) return false;

  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) return false;
  if (lower.endsWith(`.${BOARD_EXT}`)) return false;

  return true;
}

/**
 * `path` 是否落在 `folder` 里（`''` = 整个库）。
 *
 * ★ 必须按路径段判边界：朴素的前缀比较会让 `attachments-old/` 命中 `attachments`，
 *   于是"别的目录里的文件"混进本次报告 —— 用户按报告去删就删错了。
 */
export function isInFolder(path: string, folder: string): boolean {
  if (folder.length === 0) return true;
  return path === folder || path.startsWith(`${folder}/`);
}
