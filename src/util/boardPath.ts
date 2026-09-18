/**
 * 白板路径的归一化（T5.06 / T5.07）。
 *
 * 两处入口需要**同一套规则**：
 * - 白板 URI 的 `?file=` 参数（`integration/ProtocolHandler.ts`）；
 * - Home 白板路径设置（`settings/settings.ts`，`F11-09`）。
 *
 * 这两处面对的是同一类输入 —— **人手打的路径**：可能带反斜杠、可能多打一个前导 `/`、
 * 可能省掉扩展名。规则抄成两份的话，"省扩展名要不要补"这种问题会在两个地方
 * 给出不同答案，而用户看到的是"设置里能填、链接里不行"。
 *
 * ★ 纯逻辑，零 `obsidian` 依赖（`constants.ts` 是零依赖文件，可以安全引用）。
 */

import { BOARD_EXT } from '../constants';

/**
 * 归一化失败的原因。
 *
 * ★ 做成枚举而不是一句成话：本模块不认识 i18n，由调用方翻成用户看得懂的一句话。
 *   `ProtocolHandler` 把 `'empty'` 映成"地址写残了"，设置面板把它映成"回落默认值"。
 */
export type BoardPathRejection =
  /** 空白（连一个字符都没有，或只有斜杠） */
  | 'empty'
  /** 扩展名是别的（`.md` / `.canvas`）—— 这不是笔误，是指错东西了 */
  | 'not-a-board'
  /** 路径里出现了 `..` —— 试图跳出库 */
  | 'outside-vault';

export type BoardPathResult =
  { ok: true; path: string } | { ok: false; reason: BoardPathRejection };

/**
 * 把任意来源的输入收敛成一个**可用的 Vault 相对白板路径**。
 *
 * 宽容与严格的边界：
 * - **宽容**（人手写链接 / 填设置时会做的事）：反斜杠、多打的前导 `/`、前后空白、
 *   省掉扩展名、扩展名大小写。这些都不是"错误"，据此报错纯属刁难。
 * - **严格**：一旦写出了**别的**扩展名就拒绝 —— 放它过去，用户会看到一块名为某笔记的
 *   空板（甚至覆盖掉别的东西）。`..` 也一律拒绝，这是安全底线。
 */
export function normalizeBoardPath(raw: unknown): BoardPathResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };

  // Windows 习惯的反斜杠 + 常见的多打前导斜杠，先一起收拾掉；
  // 首尾空白也去掉：从聊天软件里粘过来的路径常常带一个尾空格
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // ★ 越界判定放在**归一化之后**：`Boards/../私密/A.nboard` 与 `./../A.nboard` 是同一件事，
  //   只看开头是不是 `..` 会漏掉前一种。这类输入必须在写盘 / 开视图之前被挡住
  //   （`getAbstractFileByPath` 虽然也规范化，但**依赖下游兜底**不是安全设计）。
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, reason: 'outside-vault' };
  }

  const tail = segments[segments.length - 1] ?? '';
  const suffix = `.${BOARD_EXT}`;

  if (tail.toLowerCase().endsWith(suffix)) {
    // 大小写照收（`.NBOARD`），但**统一按小写返回**：vault 路径是大小写敏感的字面量，
    // "扩展名大小写不敏感"是我们自己的规则，不该让它动到路径的其余部分
    return { ok: true, path: trimmed.slice(0, trimmed.length - suffix.length) + suffix };
  }

  // 最后一段**完全没写扩展名** → 补上（`Boards/A` → `Boards/A.nboard`）。
  // ★ 用"最后一段里有没有点"来判，而不是"整串里有没有点"：目录名带点的很常见
  //   （`我的笔记 v1.2/A`），拿整串去判会把它误当成"写错了扩展名"
  if (!tail.includes('.')) return { ok: true, path: `${trimmed}${suffix}` };

  return { ok: false, reason: 'not-a-board' };
}
