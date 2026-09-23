/**
 * 脑图节点的**系统剪贴板**（`N3-i`：`text/plain` 给人读、`text/html` 带自家标记）。
 *
 * ── 为什么单开一个模块（`2.2.0` 收尾 · 用户 2026-09-23）────────────────
 *
 * 从前只有 `.nestmind` 视图（`MindView`）在读写它。现在**白板**那一侧（卡片里的树、
 * 白板级脑图）复制节点时也要走同一套 —— 两处各写一份的话，"粘到别处是文字、粘回脑图
 * 是节点"这条口径迟早两边不一样（而且 `text/html` 里那个标记非得两边拼得一字不差，
 * 拼错的表现是"粘过去没反应"，最难查）。
 *
 * ★ 这一层只做**IO 与认亲**，不动模型：`MindView` 自己决定怎么落进它的撤销栈，
 *   白板那一侧走 `mutateMind`（内嵌改白板、文件树写 `.nestmind`）。
 * ★ 认亲（`text/html` 里的标记 / `text/plain` 的那段字）也只有这一处实现。
 */

import {
  getMindClipboard,
  isOwnClipboardText,
  mindClipboardHtml,
  mindClipboardText,
  parseMindClipboardHtml,
  setMindClipboard,
  type MindClipboard,
} from '../model/clipboard';

/** 从系统剪贴板读回来的一趟行李（**原样**两份，认亲交给 {@link nodeClipboardOf}） */
export interface MindClipboardLuggage {
  html: string;
  text: string;
}

/**
 * 认亲：这两份行李里是不是**我们自己复制的那一簇节点**。
 *
 * * `text/html` 带自家标记 ⇒ 就是它（跨窗口 / 跨库粘贴靠这一份；
 *   顺带**写回内存剪贴板**：接着按 `⌘V` 应当还能粘）。
 * * 只读到纯文本时（有些环境不给 `text/html`）再判一次"这段字是不是我们自己写出去的
 *   那一段"（`isOwnClipboardText`）—— 是就按节点粘，不是就说明用户已经复制了别的东西
 *   （调用方会把它当**文字**粘，那是另一条路）。
 *
 * @returns 认不出来给 `null`（**不是**"剪贴板是空的"——那由调用方按 `text` 判）
 */
export function nodeClipboardOf(html: string, text: string): MindClipboard | null {
  const parsed = html.length > 0 ? parseMindClipboardHtml(html) : null;
  if (parsed) {
    setMindClipboard(parsed);
    return parsed;
  }
  const memory = getMindClipboard();
  if (memory && text.trim().length > 0 && isOwnClipboardText(memory, text)) return memory;
  return null;
}

/**
 * 写内存剪贴板 + **尽力**写系统剪贴板（`text/plain` 给"人读的文字"、
 * `text/html` 带载荷 ⇒ 粘贴时按**格式**认亲；幕布 / 飞书也是这么做的）。
 *
 * ★ 返回值 = **系统那一份**写成功没有。写失败（没有用户手势 / 系统剪贴板被别的程序占着）
 *   不影响用：内存那一份才是 `⌘V` 的主路径（只有跨窗口粘贴才非要系统那一份）。
 */
export async function writeMindClipboard(payload: MindClipboard): Promise<boolean> {
  setMindClipboard(payload);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([mindClipboardText(payload)], { type: 'text/plain' }),
        'text/html': new Blob([mindClipboardHtml(payload)], { type: 'text/html' }),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读系统剪贴板（`navigator.clipboard.read()`）—— `MindView` 的 `⌘V` 走它。
 *
 * ★ 返回 `null` = **读不到**（没权限 / 剪贴板空 / 被拒绝）：调用方据此退回内存剪贴板；
 *   返回对象但两份都是空串 = "读到了，但里面没有我们能用的东西"（这时**不该**再退回内存，
 *   否则又会粘出用户早就换掉的那一份）。
 * ★ 遍历所有 `ClipboardItem` 找类型，而不是只取第一个：不同来源写进来的类型集合不一样
 *   （从浏览器复制的可能只有 `text/html`）。
 */
export async function readMindClipboard(): Promise<MindClipboardLuggage | null> {
  // ① 首选 `read()`：只有它能拿到 `text/html`（认亲靠它）
  try {
    const items = await navigator.clipboard.read();
    let html = '';
    let text = '';
    for (const item of items) {
      if (html.length === 0 && item.types.includes('text/html')) {
        html = await (await item.getType('text/html')).text();
      }
      if (text.length === 0 && item.types.includes('text/plain')) {
        text = await (await item.getType('text/plain')).text();
      }
    }
    return { html, text };
  } catch {
    // ② 退一步只要文字：有些环境不给 `read()`，但 `readText()` 可用 ——
    //    这一档靠 `nodeClipboardOf` 判"还是我们那次复制吗"
    try {
      return { html: '', text: await navigator.clipboard.readText() };
    } catch {
      return null;
    }
  }
}
