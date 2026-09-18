/**
 * 卡片配色（T1.39，`F2-00-5`）—— 主题 6 色与自定义 HEX → CSS。
 *
 * 存在的理由：**色值有两套语义，只有一份映射**。
 *  * `"1"`~`"6"` 是**编号**（`03 §7.4`：与 JSON Canvas 的 `canvasColor` 同语义，
 *    便于互转），具体色值由应用映射到 Obsidian 主题变量 —— 文件里**永不写死色值**，
 *    否则深色主题下必然瞎眼（`02 §5.1` 的❌示例）；
 *  * `#RRGGBB` 是用户手填的自定义色，只有它才允许落进文件。
 *
 * 卡片层、右键菜单、将来的 `.canvas` 导出三处都要用这张表 —— 各写一份必然漂移。
 *
 * ★ 零依赖（只 import 类型与 i18n），可在 node 下单测。
 */

import { isHexColor, isThemeColor, THEME_COLORS } from '../model/schema';
import type { CardColor, HexColor, SwatchEntry, ThemeColor } from '../model/schema';
import { t, type MessageKey } from './i18n';

/**
 * 编号 → Obsidian 主题变量名（不带 `var()`）。
 * 顺序与 JSON Canvas 约定一致：1 红 / 2 橙 / 3 黄 / 4 绿 / 5 青 / 6 紫。
 */
export const THEME_COLOR_VAR: Record<ThemeColor, string> = {
  '1': '--color-red',
  '2': '--color-orange',
  '3': '--color-yellow',
  '4': '--color-green',
  '5': '--color-cyan',
  '6': '--color-purple',
};

const THEME_COLOR_LABEL: Record<ThemeColor, MessageKey> = {
  '1': 'color.red',
  '2': 'color.orange',
  '3': 'color.yellow',
  '4': 'color.green',
  '5': 'color.cyan',
  '6': 'color.purple',
};

/** 菜单里列出 6 色的顺序（与 `THEME_COLORS` 同源，避免两处顺序不一致） */
export const THEME_COLOR_OPTIONS = THEME_COLORS;

/** 主题色 → `var(--color-red)` 形式，可直接赋值给 CSS 属性 */
export function themeColorVar(color: ThemeColor): string {
  return `var(${THEME_COLOR_VAR[color]})`;
}

/** 色号的本地化名称（右键菜单用） */
export function colorLabel(color: ThemeColor): string {
  return t(THEME_COLOR_LABEL[color]);
}

/**
 * 规范化手填色：`#RGB` 展开成 `#RRGGBB`、统一小写。
 * 非法输入返回 `null` —— 由调用方决定是拒绝还是回退，本函数不猜。
 */
export function normalizeHex(value: string): HexColor | null {
  const raw = value.trim().toLowerCase();
  if (!isHexColor(raw)) return null;
  if (raw.length === 4) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return raw;
}

/**
 * 三个 RGB 通道 → `#rrggbb`（小写，与 {@link normalizeHex} 同一套写法）。
 *
 * 通道按 0~255 四舍五入后夹取：像素来源（`getImageData` 之外的通道、将来可能的
 * 压缩取样）可能给小数或越界值，而**色号只有一种写法** —— 多出来第二种写法，
 * 去重、比较、落盘就都得跟着写两遍。
 */
export function toHexColor(r: number, g: number, b: number): HexColor {
  const channel = (value: number): string => clampChannel(value).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** 是不是一个能落进文件的卡片色（编号或合法 HEX） */
export function isValidCardColor(value: unknown): value is CardColor {
  return isThemeColor(value) || (typeof value === 'string' && isHexColor(value));
}

/**
 * 卡片色 → 可直接写进 CSS 的值。
 * 主题色给 `var(…)`（跟随主题），自定义色给规范化十六进制。
 * 脏数据（比如手工改坏了文件）回落到主题 1 色，**绝不产出非法 CSS**。
 */
export function cardColorValue(color: CardColor): string {
  if (isThemeColor(color)) return themeColorVar(color);
  return normalizeHex(color) ?? themeColorVar('1');
}

/**
 * 左侧强调色条的颜色。`accent === null` = **不显示色条**（`03 §2.7` 的约定），
 * 所以这里返回 `null` 而不是回落到卡片色 —— 回落的后果是"每张卡都有色条"，
 * 用户设了 `accent: null` 却看到一条色，会以为没保存上。
 */
export function accentColorValue(accent: HexColor | null): string | null {
  if (!accent) return null;
  return normalizeHex(accent);
}

// ── 色板卡的一格色 → CSS 文本（`O07`）────────────────────────────

/**
 * 色板卡里**一格色** → 一个字面量：纯色就是色号，渐变就是那行 CSS。
 *
 * ★ 放在 `util/color.ts` 而不是 `cards/swatch.ts`，是为了**打断一条循环依赖**：
 *   `export/toPng.ts` 需要它（色板导出时一行一格），而 `cards/` 那一侧经
 *   `cards/registry → cards/boardRef → export/toPng` 又绕回了导出层。
 *   放在这里两边都能 import，且本文件零依赖（只 import 类型与 i18n）。
 *   ★ 与之相对，"**多行文本 ⇄ 一格格的色**"（粘贴 / 回显）留在 `cards/swatch.ts`：
 *     那是色板卡自己的编辑语法，不属于"色值 → CSS"。
 *
 * ★ **位置缺席的不补 `0%`** —— 补上就把"由 stops 顺序均分"钉死成"从 0% 开始"了。
 * ★ 这个函数同时是**显示文本**、**复制内容**、**导出文本**与 **Markdown 导出**，
 *   于是"看上去是那行 CSS"与"导出去的是那行 CSS"永远是同一份。
 */
export function swatchEntryToText(entry: SwatchEntry): string {
  if (typeof entry === 'string') return entry;
  const stops = entry.stops
    .map((stop) => (stop.position === undefined ? stop.color : `${stop.color} ${stop.position}%`))
    .join(', ');
  return `linear-gradient(${entry.angle}deg, ${stops})`;
}

// ── 对比度（T3.26 / `02 §7`）──────────────────────────────────────

/**
 * `#rgb` / `#rrggbb` → `[r, g, b]`（0~255）。认不出来给 `null`。
 *
 * ★ 同时接受 3 位缩写：渲染层的输入可能来自用户手填（`#f00`），
 *   而"能算对比度"不该比"能当颜色用"要求更严。
 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

/**
 * WCAG 2.1 的**相对亮度**（0 = 纯黑，1 = 纯白）。
 *
 * ★ 必须按 sRGB 的传递函数先反 gamma 再线性加权 —— 直接拿 `(r+g+b)/3`
 *   当亮度是个常见的错，算出来的对比度会明显偏乐观（尤其对蓝紫色）。
 */
export function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.1 对比度（1 ~ 21）。任一色认不出来给 `null`
 * —— 让调用方去决定"算不出来"该怎么处理，而不是给一个看起来像结论的 1。
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 是否达到 WCAG **AA**（T3.26）。
 *
 * `large` 用 3:1 而不是 4.5:1 —— 这是标准本身对"大字号"（≥18.66px 粗体或 ≥24px）
 * 的放宽，卡片标题正落在这个区间里。默认按正文的 4.5:1 判。
 */
export function meetsWcagAA(a: string, b: string, large = false): boolean {
  const ratio = contrastRatio(a, b);
  if (ratio === null) return false;
  return ratio >= (large ? 3 : 4.5);
}

// ── 色板卡铺满整卡时的墨色（`O19`）──────────────────────────────

/** 浅底上的墨色（深色字）。与深色便签（`O06`）的正文色是**两个概念**：那个是"便签的一种配色"，这个是"底色数据的函数" */
export const SWATCH_INK_ON_LIGHT: HexColor = '#1f1f1f';

/** 深底上的墨色（浅色字） */
export const SWATCH_INK_ON_DARK: HexColor = '#f5f5f5';

/**
 * 色板卡里**一格色铺满整张卡**时，卡面上那行色号该用哪种墨色 —— 两个候选里挑**对比度更高**的那个。
 *
 * ★ 存在的理由：`O19` 之后色板卡的卡面底色就是这一格色本身（不再是"卡片色 14% 的淡底"），
 *   于是 `--text-muted` 这种"永远偏灰"的颜色在深底上（比如 `#1e293b`）基本看不见。
 *   这与 `02 §7` 的"淡底 + 深字"是同一个诉求，只是底色从**主题变量**变成了**数据**，
 *   CSS 那边再也猜不出来 —— 只能算一次、写成变量。
 * ★ 渐变取**第一个色标**：那是一眼看过去最先撞上的颜色。按"平均色"算要先定义怎么平均
 *   （各色标等权？按位置加权？），而那个定义在这里换不来任何东西。
 * ★ 两个候选的色值不取纯黑 / 纯白：卡片底色本身就够饱和了，纯黑纯白这种极值会把
 *   整张卡压得很硬（与 `O06` 深色便签同一个观感取向）。
 * ★ 认不出来的色（手改坏的文件）算不出对比度，回落**浅底墨色**：两个候选里更保守的那个
 *   —— 深色字放在浅底上一定读得清，反过来不一定。
 */
export function swatchInkColor(entry: SwatchEntry): HexColor {
  const base = typeof entry === 'string' ? entry : (entry.stops[0]?.color ?? '');
  const onLight = contrastRatio(base, SWATCH_INK_ON_LIGHT) ?? 0;
  const onDark = contrastRatio(base, SWATCH_INK_ON_DARK) ?? 0;
  return onDark > onLight ? SWATCH_INK_ON_DARK : SWATCH_INK_ON_LIGHT;
}

/**
 * 在 gamma 编码的 sRGB 空间里按比例混两色，**与 CSS `color-mix(in srgb, A p%, B)` 同算法**。
 *
 * ★ 存在的理由是让"淡底 + 深字"这条可读性设计**可以被测试**：卡片底色是
 *   `color-mix(cardColor 14%, background-secondary)`（`styles.css`），
 *   而这段逻辑在 CSS 里，测试够不着 —— 手抄一份同样的混合算法，才能把
 *   "把 14% 调到 60% 会不会让正文读不清"变成一条会失败的断言。
 *
 * `frontPercent` 是**百分比数值**（`14` 表示 14%），越界会被夹到 0~100。
 */
export function mixSrgb(front: string, back: string, frontPercent: number): HexColor | null {
  const a = hexToRgb(front);
  const b = hexToRgb(back);
  if (!a || !b) return null;
  const p = Math.min(100, Math.max(0, frontPercent)) / 100;
  return toHexColor(
    a[0] * p + b[0] * (1 - p),
    a[1] * p + b[1] * (1 - p),
    a[2] * p + b[2] * (1 - p),
  );
}
