/**
 * 节点配色（`06 §6.1` 的 `A`「撞色」）—— 主色 → **标题带 / 内容块 / 两处字色**。
 *
 * 三条取舍：
 *
 * 1. **不跟随 Obsidian 主题**：色是**存进文件的选择**（与深色便签 `O06` 同一条理由）——
 *    别人打开这块脑图该看到同一张图，导出 PNG / SVG 也就跟着变。所以这里推出来的四个值
 *    只依赖主色本身，不读任何主题变量。
 * 2. **纯函数、只吃色号**：主题色编号（`1`–`6`）→ 具体色号的解析**由渲染层注入**
 *    （只有 DOM 知道 `--color-red` 此刻是什么）。拿不到解析器时（单测 / 无宿主导出）
 *    回落一套**近似值**（见 `THEME_COLOR_FALLBACK`），并在注释里写明它是近似。
 * 3. **对比度用现成的**：`util/color.ts` 的 `swatchInkColor`（WCAG 挑深/浅）与 `mixSrgb`
 *    （sRGB 混合）已经为色板卡写好了一遍 —— 撞色要的是同一件事，不再写第二份。
 */

import { isThemeColor, type CardColor, type HexColor, type ThemeColor } from '../../model/schema';
import { mixSrgb, normalizeHex, swatchInkColor, THEME_COLOR_OPTIONS } from '../../util/color';
import type { MindNodeStyle } from './schema';

/**
 * 主题色编号的**近似**色号 —— 只在拿不到 DOM / CSS 变量的场合用（单测、无宿主导出）。
 *
 * ★ 取的是 Obsidian 默认深色主题那一套值。**不要**把它当成"主题色的真值"：
 *   真值只有 `getComputedStyle` 知道，渲染层必须在能解析时把真值传进来
 *   （与白板导出 PNG 时读一次 `readPngPalette` 是同一条思路）。
 */
const THEME_COLOR_FALLBACK: Record<ThemeColor, HexColor> = {
  '1': '#fb464c',
  '2': '#e9973f',
  '3': '#e0de71',
  '4': '#44cf6e',
  '5': '#53dfdd',
  '6': '#a882ff',
};

/**
 * 内容块底色里**主色掺进来的比例**（`mixSrgb` 的 `frontPercent`，`front` = 主色）。
 *
 * ★ **0 = 纯白**（用户 2026-09-16 定的）：撞色只上**标题带**，正文那块一律白底黑字 ——
 *   一眼能分清"这是这张卡的观点（标题）/ 这是它的细节（正文）"。
 * ★ 留着这个常量而不是直接写死白色：将来想调回"正文也带一点主色"时只改这一个数
 *   （`bodyInk` 是按底色算的，会跟着走）。
 * ★ 混的是**固定白**而不是主题色：导出（P6）要的是"同一主色永远同一套色"，不随主题变（§3）。
 * ★ **方向踩过一次**：`mixSrgb(front, back, frontPercent)` 的百分比是**第一个**参数的权重。
 *   原先写成 `mixSrgb(BODY_SURFACE, title, 16)`，得到的是"84% 主色"（正文与标题几乎一个色，
 *   整块红成一片），而文档与用例都写着"主色的浅色版" —— 那条用例是**自证式断言**
 *   （拿同一个表达式去比），所以从没逮住方向错。现在的写法把主色放在 `front`，
 *   比例的意思就是"主色掺多少"，读起来与常量名一致。
 */
export const MIND_BODY_MIX_PERCENT = 0;

/** 正文底色的"底"：白（白底 + 深字），保证任何主色下都读得清 */
const BODY_SURFACE: HexColor = '#ffffff';

/**
 * 撞色标题带上的**默认字色**：白（`06 §6.1`，用户 2026-09-17 定）。
 *
 * ★ 白板那边同一条口径：便签的标题带（`styles.css` 的
 *   `[data-card-type='note'] .nestboard-card-header`）默认也是白字 —— 两边都是"饱和色块上写字"，
 *   字色不该一个按对比度猜、一个写死。
 * ★ 它是**默认值**，不是铁律：用户从快捷操作栏挑过的字色（`style.ink`）照旧压过它。
 */
const TITLE_INK_ON_MAIN: HexColor = '#ffffff';

/**
 * 这一层的标题带用的是**饱和主色**吗（⇒ 默认白字）。
 *
 * ★ 就是"层级底色跟不跟主色走"的同一件事（{@link deepLevelTitleOf}）：根（0）与一层（1）
 *   是饱和主色，二层淡粉、三层及以下纯白 —— 那两档是浅底，白字会看不见。
 * ★ 判据只认**深度**，不认"`deep` 那一支有没有被走掉"：用户给三层节点显式挑过一个主色
 *   （`style.color`）时也会落到"按主色算"这一支，但那一层的浅底口径不该跟着变。
 */
function usesMainTitleInk(depth: number): boolean {
  return depth <= 1;
}

/** 没有 `style.color` 时的兜底主色（主题 1 号色） */
export const MIND_DEFAULT_COLOR: ThemeColor = '1';

export interface MindPalette {
  /** 标题带底色 = 主色（或用户手调过的那个） */
  title: HexColor;
  /** 标题带上的字色（按对比度在深/浅两档里挑） */
  titleInk: HexColor;
  /** 内容块底色 = 主色与近白的混合（同一主色下永远同一个值 ⇒ 导出稳定） */
  body: HexColor;
  /** 内容块上的字色 */
  bodyInk: HexColor;
}

/**
 * 各层级的**标题字号**（px）：根 30 / 一层 18 / 二层及以下 14（用户 2026-09-16 定的）。
 *
 * ★ 字号是**布局要用的数**（宽带估算）又**同时是样式**：写在这里一处，
 *   由 `applyNodePalette` 写成 CSS 变量给样式表 —— 两边各写一份迟早会漂。
 * ★ 索引就是深度：`MIND_TITLE_SIZES[depth]`，越界（第三层及以下）取最后一个。
 */
export const MIND_TITLE_SIZES: readonly number[] = [30, 18, 14];

/**
 * 从第几层起**不画盒子**，只留一条托底的线（`D3`，用户 2026-09-18："支持 4 级子节点
 * 隐藏外框，只保留下方托底的线"）。
 *
 * ★ 四层往上每一行还顶着"小方块 + 边框"时，整片看起来是噪声；一条贴住文字的细线
 *   仍然说得出"这是一条主题"，同时让深层退成一片**文字**。
 * ★ 判据用**深度**而不是"节点有多小"：层级感本来就是按深度分段的，而尺寸会随用户的
 *   样式选择变 —— 按尺寸判会出现"同一层里有的有盒子、有的没有"。
 * ★ 常量放在这里而不是样式表里：`render.ts` 的 `applyNodePalette` 要按它把那四个
 *   **行内**颜色变量改写成透明 / 正文色（行内样式压得住类规则，见那边的说明）。
 */
export const MIND_DEEP_DEPTH = 4;

/** 某个深度的标题字号（越界取最后一个 —— 那是"后续所有层级"） */
export function titleSizeOf(depth: number): number {
  const index = Math.min(Math.max(0, Math.floor(depth)), MIND_TITLE_SIZES.length - 1);
  return MIND_TITLE_SIZES[index] ?? 14;
}

/** 根节点是加粗的（其余层级不加粗 —— 层级靠字号与底色区分，不靠粗细堆） */
export function titleBoldOf(depth: number): boolean {
  return depth <= 0;
}

/**
 * 二层以上的标题底色**不跟主色走**（用户 2026-09-16 定的观感）：
 * 二层淡粉、三层及以下纯白。
 *
 * ★ 只有"手调覆盖"（`style.override`，P5 的属性面板）仍然能盖过它 —— 那是用户自己定的色。
 * ★ 用固定色而不是主题色：一深一浅两个底色在浅色/深色主题下都读得清（墨色按对比度算）。
 */
const DEEP_LEVEL_TITLE: readonly HexColor[] = ['#f9d8e2', '#ffffff'];

/** 深度 → 标题底色（`null` = 按主色走） */
function deepLevelTitleOf(depth: number): HexColor | null {
  if (depth < 2) return null;
  const index = Math.min(depth - 2, DEEP_LEVEL_TITLE.length - 1);
  return DEEP_LEVEL_TITLE[index] ?? null;
}

export interface MindPaletteOptions {
  /**
   * 节点在树上的**深度**（根 = 0）。
   *
   * ★ 二层及以下的标题底色由它决定（淡粉 / 白）；缺席时按"一层"处理，
   *   于是所有既有调用（含单测）行为不变。
   */
  depth?: number;
  /**
   * 主题色编号 → 具体色号。**渲染层注入**（读一次 CSS 变量即可）。
   * 不传 = 用 {@link THEME_COLOR_FALLBACK} 的近似值。
   */
  resolveTheme?: (color: ThemeColor) => HexColor;
  /** 没有 `style.color` 时的兜底主色 */
  fallback?: CardColor;
}

/**
 * 一个节点的配色。
 *
 * ── 优先级（`08 §3.2` 的那张表，必须写死在一处）──────────────
 *
 * 1. `style.override` 三色齐 —— 用户自己在调色板上定的撞色，我们再算一遍只会把它改掉；
 * 2. **`style.ink`**（快捷操作栏挑的标题字色）—— 只覆盖字色，底色照旧；
 * 3. `style.color` 主色 —— **用户显式设过就听它的**（不再被层级默认盖掉，见下）；
 * 4. 层级默认（二层淡粉 / 三层及以下纯白 / 其余按主色或默认色）。
 *
 * ★ **第 3 条是一次行为变更**（`08 §3.2`）：`§11.23` 那版里"层级规则会盖掉 `style.color`"
 *   （二层一律淡粉）。现在改成"显式设过的主色优先" —— 否则用户挑了底色却看不出变化，
 *   只会以为按钮坏了。
 * ★ 手调模式下 `ink` 一个值同时给标题与正文两处：由用户负责可读性（面板上提示对比度，`§6.3`）。
 */

/**
 * 一批节点在**快捷操作栏**上的"共同值"（`N2`：框选多个节点统一改样式）。
 *
 * ★ 语义是"**全一致才算**"：任何一项只要不一致，就给 `false` / `null` ——
 *   也就是栏上那一格**不亮**。刻意不做"半亮"的三态：一条窄栏里读不出来，
 *   用户只会以为那个按钮坏了（`09 §2.3`）。
 * ★ 于是"点一下"的语义自然就是 `全亮 ⇒ 全关，否则 ⇒ 全开` —— 混合态取 `false`，
 *   点一下把**全部**打开，正是"我要它们都一样"的直觉（不会把已有的翻掉）。
 * ★ 加粗取的是**生效值**（用户设过听用户的、否则按层级），与单选那条一致。
 */
export function commonTitleStyle(nodes: readonly { style?: MindNodeStyle; depth: number }[]): {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: CardColor | null;
  ink: HexColor | null;
  highlight: HexColor | null;
} | null {
  if (nodes.length === 0) return null;
  /** 全一致就给那个值，否则给 `fallback`（= "这一格不亮"） */
  const all = <T>(values: readonly T[], fallback: T): T =>
    values.length > 0 && values.every((value) => value === values[0]) ? values[0] : fallback;

  return {
    bold: all(
      nodes.map((node) => node.style?.bold ?? titleBoldOf(node.depth)),
      false,
    ),
    italic: all(
      nodes.map((node) => node.style?.italic === true),
      false,
    ),
    underline: all(
      nodes.map((node) => node.style?.underline === true),
      false,
    ),
    highlight: all(
      nodes.map((node) => node.style?.highlight ?? null),
      null,
    ),
    color: all(
      nodes.map((node) => node.style?.color ?? null),
      null,
    ),
    ink: all(
      nodes.map((node) => node.style?.ink ?? null),
      null,
    ),
  };
}

export function mindPaletteOf(
  style: MindNodeStyle | undefined,
  options: MindPaletteOptions = {},
): MindPalette {
  const override = style?.override;
  if (override) {
    const ink = normalizeHex(override.ink) ?? override.ink;
    return {
      title: normalizeHex(override.title) ?? override.title,
      titleInk: ink,
      body: normalizeHex(override.body) ?? override.body,
      bodyInk: ink,
    };
  }

  const explicitInk = style?.ink ? normalizeHex(style.ink) : null;
  const explicitColor = style?.color;

  // 层级默认只**在用户没显式挑过主色时**说话（见上面第 3 条）
  const deep = explicitColor === undefined ? deepLevelTitleOf(options.depth ?? 1) : null;
  if (deep !== null) {
    return {
      title: deep,
      titleInk: explicitInk ?? swatchInkColor(deep),
      body: BODY_SURFACE,
      bodyInk: swatchInkColor(BODY_SURFACE),
    };
  }

  const main = mainHexOf(explicitColor ?? options.fallback ?? MIND_DEFAULT_COLOR, options);
  const palette = mindPaletteOfHex(main);
  // ★ 根与一层：标题带是**饱和主色** ⇒ 字默认给**白**（用户 2026-09-17："脑图根节点和第一层
  //   子节点的字体颜色也默认是白色"）。与白板便签那条撞色标题带同一条口径。
  //   ★ **只改 `titleInk`**：正文那块永远是白底深字（`bodyInk` 照旧按对比度算）。
  //   ★ 二层及以下是浅底（淡粉 / 白）—— 白字会看不见 ⇒ 仍然按对比度挑（上面那一支）。
  //   ★ 用户**显式挑过**的字色（快捷操作栏那个「字色」）仍然压过它，见下面 `explicitInk`。
  const layered: MindPalette = usesMainTitleInk(options.depth ?? 1)
    ? { ...palette, titleInk: TITLE_INK_ON_MAIN }
    : palette;
  return explicitInk ? { ...layered, titleInk: explicitInk } : layered;
}

/** 主色（已解析成色号）→ 撞色三件套 */
export function mindPaletteOfHex(main: HexColor): MindPalette {
  const title = normalizeHex(main) ?? THEME_COLOR_FALLBACK[MIND_DEFAULT_COLOR];
  // 主色放在 `front`、比例 = "主色掺多少"（0 ⇒ 就是纯白）
  const body = mixSrgb(title, BODY_SURFACE, MIND_BODY_MIX_PERCENT) ?? BODY_SURFACE;
  return {
    title,
    titleInk: swatchInkColor(title),
    body,
    bodyInk: swatchInkColor(body),
  };
}

/**
 * 主题色编号 → **用来画色块的**色号（`08 §3.3`）。
 *
 * ★ 与 {@link mainHexOf} 同一套解析：注入了解析器就用真色、否则用近似值 ——
 *   快捷操作栏里的色块必须画成"用户主题里那个色"，否则点下去得到的东西
 *   与看到的不一样（那比不给色块还糟）。
 */
export function themeColorPreviewOf(
  color: ThemeColor,
  resolveTheme?: (color: ThemeColor) => HexColor,
): HexColor {
  return mainHexOf(color, { resolveTheme });
}

/** `CardColor`（编号或 HEX）→ 色号：HEX 直接规范化，编号问注入的解析器（缺省用近似表） */
export function mainHexOf(color: CardColor, options: MindPaletteOptions = {}): HexColor {
  if (isThemeColor(color)) {
    const resolved = options.resolveTheme?.(color);
    return normalizeHex(resolved ?? '') ?? THEME_COLOR_FALLBACK[color];
  }
  return normalizeHex(color) ?? THEME_COLOR_FALLBACK[MIND_DEFAULT_COLOR];
}

/**
 * 给"整理配色"用的预设主色序列（`06 §6.1` 的最后一条）。
 *
 * ★ 借 `THEME_COLOR_OPTIONS` 的顺序（1 红 / 2 橙 / …），不另立一套色板：
 *   两处色序不同的话，"按分支轮转"的结果在菜单里会显得毫无规律。
 */
export function branchColorAt(index: number): ThemeColor {
  const list = THEME_COLOR_OPTIONS;
  const size = list.length;
  return list[((index % size) + size) % size] ?? MIND_DEFAULT_COLOR;
}
