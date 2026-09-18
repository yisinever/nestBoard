/**
 * 从卡片文本里认标签（`F5-07` 按标签自动分栏的解析层）。
 *
 * 白板的 `Card` 上**没有** `tags` 字段：标签是用户写在正文里的 `#标签`
 * （与 Obsidian 的标签语法同源），所以"这张卡有哪些标签"这件事只能从文本里认。
 *
 * ── 三条判定规则（都朝"宁可少认，不可乱认"的方向收） ──────────
 *
 * 1. **`#` 前面必须是边界**：行首，或一个不是"字/数字/`_`/`#`/`/`"的字符。
 *    这条挡掉的是链接锚点（`https://x.com/#top`、`https://x.com/a#frag`）和
 *    Markdown 标题（`## 二级标题`）—— 它们天天出现在便签里，认错了就会平白
 *    多出一堆叫 `top` / `frag` / 标题第一个字的栏。
 * 2. **纯数字不算标签**（`#2026`）：Obsidian 自己也不把它当标签，而"#2026"
 *    几乎总是年份或期号 —— 认成标签会凭空造出一个栏。
 * 3. **大小写不同算同一个标签**：`#Idea` 与 `#idea` 在 Obsidian 里是同一个标签，
 *    分成两栏等于把同一件事拆开。分组用归一化键（小写），**显示用第一次出现的写法**
 *    —— 用户怎么写的，就怎么给他看回去。
 *
 * ★ 刻意**不跳过代码块**：搜索也搜得到代码块里的字（`model/search.ts` 不跳代码块），
 *   如果标签解析跳了，就会出现"搜得到却看不见"的矛盾。两边认同一份文本，
 *   比各自聪明更可靠。
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM。
 */

import type { Card } from './schema';
import { searchableTexts } from './search';

/**
 * 标签体的最大长度。
 *
 * 这个上限是防"吞字"的：没上限时，一段长得离谱的正文里某个孤零零的 `#`
 * 会把后面几百个字全吞进"标签"里，列标题跟着撑爆。取 100 是因为它已经远超
 * 任何人真的会写的标签长度 —— 这条线只用来兜底，不该在日常使用里生效。
 */
const MAX_TAG_LENGTH = 100;

/**
 * 扫描用正则（**每次调用现造**，不共享 `lastIndex`）。
 *
 * - `(^|[^\p{L}\p{N}_#/])`：`#` 前面必须是行首或一个"不是字/数字/`_`/`#`/`/`"的字符；
 * - `([\p{L}\p{N}_/-]{1,100})`：标签体；`\p{L}` 覆盖中日韩，`/` 是 Obsidian 的嵌套标签。
 */
function tagScanner(): RegExp {
  return new RegExp(String.raw`(^|[^\p{L}\p{N}_#/])#([\p{L}\p{N}_/-]{1,${MAX_TAG_LENGTH}})`, 'gu');
}

/**
 * 归一化键：比大小写用。
 *
 * 与显示用的写法分开，是因为这两件事的要求正好相反 ——
 * 分组要"宽"（`#Idea` / `#idea` 必须落在一起），显示要"原样"（用户写的是什么就显示什么）。
 */
export function tagKeyOf(tag: string): string {
  return tag.toLowerCase();
}

/**
 * 一段文本里的全部标签（按出现顺序，**不去重**）。
 *
 * 去重交给 `tagsOfCard`：那里才看得见"同一张卡的多个字段"，
 * 在这一层去重会把"标题里的 `#A` 与正文里的 `#A` 谁先出现"这个信息丢掉。
 */
export function tagsInText(text: string): string[] {
  const found: string[] = [];
  const scanner = tagScanner();
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    // 去掉尾部的 `-` / `/`：`写完了 #项目-` 里的短横是标点，不是标签的一部分
    const tag = match[2].replace(/[-/]+$/, '');
    // 纯数字 / 只剩符号 → 不是标签（规则 2）
    if (!/[\p{L}_]/u.test(tag)) continue;
    found.push(tag);
  }
  return found;
}

/**
 * 一张卡上的全部标签，按"卡片想被怎么读"的顺序：
 * 标题 → 正文（顺序即 `searchableTexts` 的字段顺序）。
 *
 * 标题在前是有意的：标题是用户给这张卡下的定义，正文里可能只是随手提了一句。
 * `columnsByTag` 正是拿这个顺序里的**第一个**标签决定卡片归属。
 *
 * ★ 复用 `searchableTexts` 而不是自己列一遍字段：两处各列一份的话，迟早出现
 *   "搜得到的标签，分栏却看不见"（或者反过来）。
 */
export function tagsOfCard(card: Card): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const text of searchableTexts(card)) {
    for (const tag of tagsInText(text)) {
      const key = tagKeyOf(tag);
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}
