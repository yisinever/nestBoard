import type { ClipboardBridge } from '../cards/registry';

/**
 * `ClipboardBridge` 的生产实现（T3.04 色板卡"点击复制"）。
 *
 * 两条路，按优先级：
 *
 *  1. `navigator.clipboard.writeText` —— 现代浏览器 / Electron 的正路，手机上也支持；
 *  2. 临时 textarea + `document.execCommand('copy')` —— 异步剪贴板 API 在
 *     **非安全上下文**或**文档没有焦点**时会直接拒绝（弹出窗口、部分移动端 WebView），
 *     这时退回老办法。
 *
 * 两条都失败才返回 `false`。与其它桥同一条铁律：**任何情况都不抛异常** ——
 * 它跑在卡片点击路径上，一次抛错会带走整屏卡片。
 *
 * ★ 不在这里弹 `Notice`：措辞归调用方（见 `ClipboardBridge` 的说明）。
 */
export class ObsidianClipboardBridge implements ClipboardBridge {
  async writeText(text: string): Promise<boolean> {
    if (text.length === 0) return false;

    try {
      // `navigator.clipboard` 在旧内核里可能整个不存在，所以要连它一起探测
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard) {
        await clipboard.writeText(text);
        return true;
      }
    } catch {
      // 权限被拒 / 文档失焦 / 非安全上下文：都落到下面的兜底，而不是让用户白点一下
    }

    return copyViaTextarea(text);
  }

  /**
   * 读剪贴板里的纯文本（`O08` 地图卡"粘贴分享链接"）。
   *
   * ★ **没有兜底**，读不到就是 `null`：`execCommand('paste')` 在现代浏览器里
   *   一律被禁（写在工具栏上的那种"看看剪贴板里是什么"是安全问题），
   *   所以这里只有一条路。调用方拿到 `null` 时退回到"让用户自己粘一次"
   *   （见 `BoardView.pasteMapLink`）—— 那是**正常路径**，不是错误。
   * ★ 空串与 `null` 合并成 `null`：调用方对这两者的处理完全一样（都当"没读到"），
   *   分两种返回值只会让每个调用方都写一遍 `if (text === null || text === '')`。
   */
  async readText(): Promise<string | null> {
    try {
      const clipboard = globalThis.navigator?.clipboard;
      // `readText` 在部分内核里不存在，所以要连方法一起探测
      if (typeof clipboard?.readText !== 'function') return null;
      const text = await clipboard.readText();
      return typeof text === 'string' && text.length > 0 ? text : null;
    } catch {
      // 权限被拒 / 文档失焦 / 非安全上下文：一律当"读不到"
      return null;
    }
  }
}

/**
 * 兜底：临时 textarea + `execCommand('copy')`。
 *
 * ★ 临时节点必须**真的排进布局**才选得中 —— `display: none` 或 `visibility: hidden`
 *   的节点没有选区，`execCommand` 会返回 `false`。所以样式表里那一条是把它挪到
 *   屏幕外，而不是藏起来（见 `styles.css` 的 `.nestboard-clipboard-temp`）。
 * ★ `readonly` 是为了不在 iPad / 手机上弹出虚拟键盘（选区照样成立）。
 */
function copyViaTextarea(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.className = 'nestboard-clipboard-temp';
    area.value = text;
    area.setAttribute('readonly', 'true');
    document.body.appendChild(area);

    try {
      area.select();
      return document.execCommand('copy');
    } finally {
      // 无论成败都要摘掉：留着它迟早会被下一次布局 / 截图带上
      area.remove();
    }
  } catch {
    return false;
  }
}
