/**
 * 把「设置」翻译成 CSS 变量（T3.24 / `F11-03`）。
 *
 * ★ 为什么走 CSS 变量而不是逐卡写内联样式：
 *   圆角 / 字号 / 字体要作用于**每一张**卡片 —— 包括此刻滚出屏外的、
 *   以及对象池里等着被复用的。逐卡写内联意味着"用户改一次设置 → 全量重写 N 个节点"，
 *   而且新建与回收的卡片都得记得补上这三个属性，漏一处就是"这张卡跟别的不一样"。
 *   把三个值写在**视图根容器**（`BoardView.contentEl`，卡片层 / 分栏层都在它里面）上，
 *   CSS 一次继承到所有卡片；改设置只改三个变量，**一个卡片节点都不用碰**。
 *
 * ★ 纯函数 + 一个薄薄的写入器：变量名与取值的推导可以脱离 DOM 单测，
 *   只有 `applyCardStyleVariables` 需要真实元素。
 */

import type { NestboardSettings } from '../settings/settings';

/** 三个外观变量名（与 `styles.css` 里的消费点一一对应） */
export const CARD_STYLE_VAR = {
  radius: '--nestboard-card-radius',
  fontSize: '--nestboard-card-font-size',
  fontFamily: '--nestboard-card-font',
} as const;

/** 卡片外观变量的名字清单，供"清理"与测试遍历 */
export const CARD_STYLE_VARS: readonly string[] = [
  CARD_STYLE_VAR.radius,
  CARD_STYLE_VAR.fontSize,
  CARD_STYLE_VAR.fontFamily,
];

/**
 * 设置 → CSS 变量表。
 *
 * ★ 字体留空时给出**空串**，由 {@link applyCardStyleVariables} 摘掉这个变量 ——
 *   于是 `var(--nestboard-card-font, <兜底>)` 里的兜底会生效。
 *   这一点很关键：`.nestboard-card` 的兜底是 `inherit`，而**便签 / 待办的编辑器**
 *   （`.nestboard-mde-input`）的兜底是 `--font-text` —— 编辑区本来就该用阅读字体。
 *   若在这里硬写成 `inherit`，编辑区会被迫跟着 UI 字体走（源码里那句
 *   `font-family: var(--font-text)` 就永远轮不到），用户一点开卡片正文就会看到
 *   字体"跳"一下。
 * ★ 空串只对**字体**成立：圆角 `0` 是合法取值（就是直角卡片），
 *   绝不能因为"看起来像空值"被吞掉 —— 见下面 `applyCardStyleVariables` 的写法。
 */
export function cardStyleVariables(settings: NestboardSettings): Record<string, string> {
  return {
    [CARD_STYLE_VAR.radius]: `${settings.cardCornerRadius}px`,
    [CARD_STYLE_VAR.fontSize]: `${settings.cardFontSize}px`,
    [CARD_STYLE_VAR.fontFamily]: settings.cardFontFamily,
  };
}

/**
 * 把外观变量写到容器上（幂等：同一个元素重复调用只是重复赋值）。
 *
 * ★ 按值分派 `setProperty` / `removeProperty`，而不是统一 `setProperty`：
 *   设置成空串的自定义属性会让消费它的那条声明"在计算值阶段失效"，
 *   那时属性变成继承值（而不是回落到 `var()` 的兜底）—— 编辑器就会用上错误的字体。
 *   摘掉变量，兜底才真的兜得住。
 */
export function applyCardStyleVariables(el: HTMLElement, settings: NestboardSettings): void {
  for (const [name, value] of Object.entries(cardStyleVariables(settings))) {
    if (value === '') el.style.removeProperty(name);
    else el.style.setProperty(name, value);
  }
}

/**
 * **拟物档的标记类**（`F2`）：写在视图根容器上。
 *
 * ★ 为什么用**类**而不是"再来一个 CSS 变量"：CSS 没法比较变量的值做分支 ——
 *   写一个 `--nestboard-card-style: neumorph` 在那儿没有任何规则能读它。
 *   类选择器就是最直接的开关。
 * ★ 更关键的是**原版档一个字节都不动**：不写这个类 = 所有既有规则照旧生效，
 *   于是"原版档与 2.1.3 逐像素一致"这条回归基线（`11 §7`）是**结构上**成立的，
 *   而不是靠"我逐条对照过"。
 */
export const BOARD_STYLE_CLASS = 'nestboard-neumorph';

/**
 * 把当前外观档写进根容器（与 {@link applyCardStyleVariables} 同一个咽喉点一起调用）。
 *
 * ★ 幂等：重复调用只是把同一个类再 toggle 一次；切回原版档时**摘掉类**，
 *   于是不需要任何"复位"代码。
 */
export function applyBoardStyleClass(el: HTMLElement, settings: NestboardSettings): void {
  el.classList.toggle(BOARD_STYLE_CLASS, settings.cardStyle === 'neumorph');
}

/** 移除外观变量（视图卸载 / 复用到别处时清干净，别把上一个用户的偏好留下） */
export function clearCardStyleVariables(el: HTMLElement): void {
  for (const name of CARD_STYLE_VARS) el.style.removeProperty(name);
}
