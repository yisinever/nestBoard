/**
 * 大纲 / 树两个视图的**切换图标**（`N3-a`；用户 2026-09-17 给的设计稿，内联进来）。
 *
 * ★ 内联而不是当资源文件分发：插件以 `main.js` 单文件分发，两个小图标内联最省事，
 *   也让"当前视图高亮换色"能用 `currentColor` 走 CSS。
 * ★ 原稿里写死的 `#9013fe` 全部换成了 `currentColor`：**当前视图**的那一格上主题强调色
 *   （默认主题正是蓝紫，与设计稿一致），另一格用正文色（CSS 管）。
 */

/** 大纲视图（三条横线 + 行首圆点 —— 就是幕布那份观感） */
export const OUTLINE_VIEW_ICON =
  '<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 14C10.2091 14 12 12.2091 12 10C12 7.79086 10.2091 6 8 6C5.79086 6 4 7.79086 4 10C4 12.2091 5.79086 14 8 14Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M8 26C9.10457 26 10 25.1046 10 24C10 22.8954 9.10457 22 8 22C6.89543 22 6 22.8954 6 24C6 25.1046 6.89543 26 8 26Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M8 40C9.10457 40 10 39.1046 10 38C10 36.8954 9.10457 36 8 36C6.89543 36 6 36.8954 6 38C6 39.1046 6.89543 40 8 40Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M20 24H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 38H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 10H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** 树视图（一根主干分出三叉 —— 关联/分支的形状） */
export const TREE_VIEW_ICON =
  '<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M26 24L42 24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 38H42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 10H42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 24L6 24C6 24 7.65685 24 10 24M18 38C12 36 16 24 10 24M18 10C12 12 16 24 10 24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
