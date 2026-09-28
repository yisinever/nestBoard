/**
 * 设置开关「**所有层级的脑图节点都显示框**」（用户 2026-09-28）的**标记类**与读取器。
 *
 * ── 为什么是一个类、而且挂在 `body` 上 ──────────────────────
 *
 * 这一档要同时作用到：① 白板上的脑图（`EmbedMind`）② `.nestmind` 独立视图
 * ③ 卡内嵌的脑图 ④ canvas / SVG 导出与缩略图。它们的共同祖先只有 `body`，
 * 而且其中两条（导出）没有 `settings` 可用 —— 只能靠 `getComputedStyle` 读一个
 * CSS 变量（见 `styles.css` 里那条规则）。
 *
 * ★ 架构约束（`06 §2`）：脑图不许依赖白板的视图层 ⇒ 这个标记**只能住在 `util/`**，
 *   白板侧（`view/themeVars.ts` 的 `applyBoardStyleClass`）与脑图侧（`MindView` /
 *   `EmbedMind`）都从这里拿同一个名字，谁也不抄谁。
 * ★ 不写这个类 = 与 `2.1.4` 逐像素一致（与拟物档 `BOARD_STYLE_CLASS` 同一条纪律）。
 */

/** `body` 上的标记类：设置开关的**唯一**落点（`main.ts` 的 `applyStyleMode` 维护） */
export const MIND_BOX_ALL_CLASS = 'nestboard-mind-box-all-depths';

/** 供 canvas / SVG 导出读的那个 CSS 变量（由上面的类在样式表里定义，见 `styles.css`） */
export const MIND_BOX_ALL_CSS_VAR = '--nestboard-mind-deep-box';

/** 某个文档此刻是不是"脑图所有层级都画框" */
export function mindBoxAllDepthsOf(doc: Document): boolean {
  return doc.body?.classList.contains(MIND_BOX_ALL_CLASS) ?? false;
}
