/**
 * 文本 ↔ 字节的小工具。
 *
 * 目前只有一件事：把一段文本编成 UTF-8 字节，好让它走"二进制落盘"那条路
 * （导出 SVG 的 `.svg`、导出 ZIP 里的 `.nboard`）。
 *
 * ★ 走 `TextEncoder`（Web API）而不是任何 Node 编解码：本插件承诺不 import
 *   Node 内置模块（`02 §6`），而 `TextEncoder` 在浏览器与 Obsidian（桌面 / 移动）里都在。
 * ★ 这里**显式切出**恰好等于内容长度的那一段 buffer，而不是直接把 `encode()` 的
 *   `buffer` 交出去 —— 后者依赖"实现总是分配等长 buffer"这一条不在类型里的约定，
 *   一旦某天不成立，写出去的文件就会在末尾拖一段垃圾。
 */
export function textToArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
