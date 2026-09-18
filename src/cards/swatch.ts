/**
 * 色板卡（T3.04 / `F2.6` / `O07` / `O19`）—— **一卡一色**：卡面就是那一格色，上面写色号、点一下复制。
 *
 * ── 两种呈现（`02 §3` 的显示态 / 编辑态） ────────────────────
 *
 * | 模式 | 渲染 | 交互 |
 * |---|---|---|
 * | `display` | 整卡铺满第一格色 + 一行色号（`#RRGGBB` / `linear-gradient(...)`） | 点那行 = 复制该色号 / 那行 CSS |
 * | `edit` | 同一片底色 + 一块 textarea（一行一格） | 粘贴多行、`⌘↵` 保存、`Esc` 放弃 |
 *
 * ── 一卡一色（`O19`）───────────────────────────────────────
 *
 * `T3.04` 那一版是"一卡多格"：预览里一行一行排开（一行一个 18px 的小色块）。真用起来
 * 才发现要的是**一张色卡就是一块颜色** —— 它得能被一眼认出来，才能跟别的色卡并排摆成一组。
 * 于是预览不再排列表：**第一格色铺满整张卡**，色号居中写在色上面。
 *
 * `colors` 仍是数组、**文件形状一个字没改**：一张几张色的旧色卡只画第一格，其余留在文件里，
 * 但卡面上会带一个 `+N` 的小字 —— 这与下面第 3 条是同一条规矩（在用户眼里，
 * "藏起来看不见"和"被丢掉了"没有区别）。取色（吸管）与编辑保存都是**替换**，
 * 所以多格数据只会越来越少；要当场清理就双击进编辑态删掉那几行。
 *
 * ── 一格 = 纯色**或**渐变（`O07`） ──────────────────────────
 *
 * 渐变（`linear-gradient(90deg, #f00 0%, #00f 100%)`）与纯色共用同一套行语法：
 * 一行就是一格，`colors` 的长度仍然是"几格"。于是老文件不用迁移，
 * **编辑态仍然是"源码回显"** —— 用户粘进来的那行 CSS 存下去、再点开还是那一句话
 * （不拆成 stops 让用户对着表单改）。
 *
 * ── 四个刻意的决定 ──────────────────────────────────────────
 *
 * 1. **底色画在一片"逃出内容槽"的绝对定位层上**（`.nestboard-swatch-fill`）。
 *    要的是"整张卡都是这个色"，而内容槽之外还有卡片自己的边框与内边距那一圈；
 *    所以这一层的**包含块必须是卡片**（内容槽本身不定位，于是 `inset: 0` 就等于
 *    卡片的整个内盒）。顺带一个好处：内容槽自己的 `overflow: hidden` 裁不到它
 *    （裁剪只对"包含块落在裁剪元素之内"的后代生效），不必为了铺满而把裁剪关掉
 *    —— 关掉会牵连长色号那行省略号。`z-index: -1` 让它落在**卡片底色之上、
 *    所有内容之下**：色卡于是不必知道卡片是怎么画底色的。
 *    ★ 于是"这一格色"只写在**内容槽的两个变量**上，外壳那边一个字都不用改。
 * 2. **不用 `renderMarkdown`、也不复用 `MiniMarkdownEditor`**。前者不认识色号；
 *    后者的 `Enter` 续行 / `Tab` 缩进是 Markdown 行语法，套到色号上只会添乱，
 *    而且它在 `onSubmit` 里**提交即收摊**，表达不了下面第 3 条的"拒绝提交"。
 * 3. **校验是原子的：只要有一行认不出来，就一个字都不写。**
 *    另一种做法是"认出多少存多少、把坏行丢掉"，但用户是**粘贴**进来的 ——
 *    他不会逐行核对，只会在几天后偶然发现色板少了两格，而那两格去了哪、
 *    有没有别的损失，谁都说不清。宁可当场把坏行指出来（`card.swatch.invalid`）。
 *    ★ 渐变也吃这一条：提到 `linear-gradient` 却解析不出来的行**判错**，
 *      绝不悄悄降级成"它的第一个色标"（那正是上面那种"少了一格、几天后才发现"）。
 *    ★ 同一把尺子也量到了显示态：多格色卡必须带 `+N`（见上"一卡一色"）。
 * 4. **撤销时整块恢复原文**（`Esc` 不写模型），保存时按"改过才写"判断 ——
 *    点进点出不该把文件标脏（与便签卡 / 待办卡同一条）。
 *
 * ★ 不 import `obsidian`：剪贴板走 `CardRenderContext.clipboard`（`ClipboardBridge`），
 *   DOM 全用 `ownerDocument.createElement`，于是"哪一行算色号""失败长什么样"
 *   都能在 node 下直接单测。
 */

import type {
  HexColor,
  SwatchContent,
  SwatchEntry,
  SwatchGradient,
  SwatchStop,
} from '../model/schema';
// ★ `swatchEntryToText` / `swatchInkColor` 住在 `util/color`（不是本文件）：`export/toPng.ts`
//   也要用前者，而 `cards/` 经 registry → boardRef 绕回了导出层 —— 放在本文件会形成循环依赖。
//   见 `util/color.ts` 里那两个函数的说明
import { normalizeHex, swatchEntryToText, swatchInkColor } from '../util/color';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import type { CardRenderContext, CardTypeDefinition, CardTypeMenuItem } from './registry';

/**
 * 默认尺寸：**3:4 竖版**（用户 2026-09-18："色板卡默认尺寸改成 3:4 的长方形"），
 * 与 `DEFAULT_CARD_SIZES.swatch` 对齐（不另立第二个真相）。
 *
 * ★ 3:4 与白板卡那个正方形一样是"**形态**"：色卡就是一张色票，竖着摆一排才像色板。
 *   老卡片不受影响 —— 尺寸是数据，改的只是新建时的默认值。
 */
export const SWATCH_DEFAULT_SIZE: Size = { width: 180, height: 240 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（复用池里的节点会串味） */
const SWATCH_CLASSES = [
  'nestboard-swatch',
  'nestboard-swatch-preview',
  'nestboard-swatch-edit',
  'is-invalid',
  'is-solid',
] as const;

/**
 * 本定义写在槽位元素上的行内自定义属性，`destroy()` 同样要摘干净。
 *
 * ★ 骨架的 `resetNode` 只认识那两个**卡片外壳**变量（`--nestboard-card-color` 等），
 *   内容槽上的东西按约定归各自的卡片类型管 —— 漏掉一个，复用出去的节点上就留着
 *   上一张色卡的底色，"新建一张空色板却是别人的颜色"。
 */
const SWATCH_STYLE_VARS = [
  '--nestboard-swatch-color',
  '--nestboard-swatch-gradient',
  '--nestboard-swatch-ink',
] as const;

/** 复制反馈在色块上停留的时长（毫秒）：够看清，又不至于让用户等它消失 */
export const COPY_FEEDBACK_MS = 1200;

/** 收起时把这一格色铺在**卡片外壳**上的标记类（`O33`，样式表按它挑规则） */
const SHELL_SURFACE_CLASS = 'has-swatch-color';

// ─────────────────────────────────────────────────────────────
// 纯逻辑（可单测）
// ─────────────────────────────────────────────────────────────

/**
 * 带 `#` 的色号：`#abc` / `#AABBCC`。
 * 尾部的 `(?![0-9a-zA-Z])` 是必须的 —— 少了它，`#1234567`（多打一位）
 * 会被从中间截出一段当色号，用户看到的是一个"没写过的颜色"。
 */
const HASH_HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?![0-9a-zA-Z])/;

/**
 * 不带 `#` 的 6 位色号（`4C8DFF`）：从设计软件 / 网页里复制出来的常常没有 `#`。
 *
 * ★ 只认 6 位。3 位的裸串太容易是普通单词（`fee` / `cab` / `bad`），
 *   认成颜色就成了"我明明写的是备注，怎么多出一格色"。
 * ★ 前面那个 `(?:^|[^0-9a-zA-Z#])` 不是装饰：它排除"紧跟在 `#` 之后"的位置，
 *   否则 `#12345`（少一位的残号）会被截成 `12345` + 丢掉一个字符这种荒唐结果。
 */
const BARE_HEX_RE = /(?:^|[^0-9a-zA-Z#])([0-9a-fA-F]{6})(?![0-9a-zA-Z])/;

/**
 * 整行的 `linear-gradient(...)`（`O07`）。
 *
 * ★ `^...$` 锚定**整行**：色板卡一行的语义就是"一格色"，行里还夹着别的话时
 *   逗号切分立刻就乱了。认不出来就走下面的"提到渐变即判错"。
 * ★ `[\s\S]*` 而不是 `.*`：`（`…`）` 里换行是可能的（多行粘贴），
 *   不过真走到那里 `parseGradientBody` 也会因为切分出的色标带换行而失败 —— 无妨。
 */
const GRADIENT_RE = /^linear-gradient\s*\(([\s\S]*)\)$/i;

/**
 * CSS 的"方向关键词 → 角度"（0 = 向上、顺时针）。
 *
 * ★ 对角线取 45 的倍数。严格说 CSS 的 `to top right` 角度是**盒子宽高比**的函数，
 *   但色板里的色块是 18px 的正方形，45 的倍数在这里就是精确值。
 */
const GRADIENT_DIRECTIONS: Record<string, number> = {
  'to top': 0,
  'to top right': 45,
  'to right': 90,
  'to bottom right': 135,
  'to bottom': 180,
  'to bottom left': 225,
  'to left': 270,
  'to top left': 315,
};

export interface SwatchParseResult {
  /** 规范化后的一格格色（纯色小写 `#RRGGBB` / 渐变），已按出现顺序去重 */
  colors: SwatchEntry[];
  /** 一行都没认出来的行，**原样**带回来 —— 报"第 3 行写错了"比报"有错"有用得多 */
  rejected: string[];
}

/** 角度收进 `[0, 360)`：负角度、`540deg` 都是合法输入，但存进文件里只留一个等价写法 */
function normalizeGradientAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/** 渐变的第一个参数：`90deg` / `to bottom right` */
function parseGradientAngle(token: string): number | null {
  const value = token.trim().toLowerCase();
  const deg = /^(-?\d+(?:\.\d+)?)deg$/.exec(value);
  if (deg) {
    const angle = Number(deg[1]);
    return Number.isFinite(angle) ? normalizeGradientAngle(angle) : null;
  }
  return GRADIENT_DIRECTIONS[value] ?? null;
}

/** 一个色标：`#4c8dff` 或 `#4c8dff 25%`（位置可省 = 均分） */
function parseGradientStop(token: string): SwatchStop | null {
  const text = token.trim();
  const match = HASH_HEX_RE.exec(text) ?? BARE_HEX_RE.exec(text);
  // 抓到的永远是"十六进制本体"（不带 `#`），补上 `#` 再交给 `normalizeHex`：
  // 它负责小写化并把 `#abc` 展开成 `#aabbcc`
  const color = match ? normalizeHex(`#${match[1]}`) : null;
  if (color === null) return null;

  const stop: SwatchStop = { color };
  const position = /(-?\d+(?:\.\d+)?)%/.exec(text);
  if (position) {
    const value = Number(position[1]);
    // 位置超界**不丢这一格**（颜色还在，CSS 自己也会夹）：夹到 0~100 存下来
    if (Number.isFinite(value)) stop.position = Math.min(100, Math.max(0, value));
  }
  return stop;
}

/**
 * `linear-gradient(...)` 的**参数部分** → 渐变对象。
 *
 * 逗号切分在这里是安全的：参数里只可能出现 `#rrggbb` 色标与百分比，
 * 不会出现 `rgb(...)` / `hsl(...)` 那种带括号的东西（它们本来就不进色板）。
 */
function parseGradientBody(body: string): SwatchGradient | null {
  const tokens = body.split(',');
  if (tokens.length < 3) return null; // 角度 + 至少两个色标
  const angle = parseGradientAngle(tokens[0]);
  if (angle === null) return null;

  const stops: SwatchStop[] = [];
  for (const token of tokens.slice(1)) {
    const stop = parseGradientStop(token);
    if (stop !== null) stops.push(stop);
  }
  // 少于 2 个色标不构成渐变（CSS 也会当这条声明无效）
  if (stops.length < 2) return null;
  return { type: 'linear', angle, stops };
}

/**
 * 行首的无序列表记号（`- ` / `* ` / `+ `）。
 *
 * ★ 必须有：`toMarkdown` 导出的一行就是 `- linear-gradient(...)`，而"导出去的原样粘得回来"
 *   是那边许下的承诺。纯色那半边靠 `HASH_HEX_RE` 的"行内任意位置"天然成立，
 *   渐变这半边因为 `GRADIENT_RE` 整行锚定，必须把记号显式剥掉。
 */
const LIST_MARKER_RE = /^[-*+]\s+/;

/** 一行 → 一格色。整行渐变优先，其余退回"行内第一个色号" */
function parseSwatchLine(line: string): SwatchEntry | null {
  const body = line.replace(LIST_MARKER_RE, '');
  const gradient = GRADIENT_RE.exec(body);
  if (gradient) return parseGradientBody(gradient[1]);
  // ★ 提到 `linear-gradient` 却不是一个能解析的整行渐变 → 判错，**不退回去取色号**：
  //   把渐变悄悄降级成它的第一个色标，正是文件头第 2 条警告的那种
  //   "少了一格、几天后才发现"的静默损失
  if (/linear-gradient/i.test(body)) return null;

  const match = HASH_HEX_RE.exec(body) ?? BARE_HEX_RE.exec(body);
  return match ? normalizeHex(`#${match[1]}`) : null;
}

/**
 * 多行文本 → 一格格的色（T3.04 的"批量粘贴"）。
 *
 * 每行取**第一个**色号，容忍行尾的多余文字（`#4C8DFF` 后面跟一句"主色"）——
 * 用户是从别处粘贴过来的，不该被要求先清理干净。
 * 空行跳过；重复的格**静默去重**（色板本来就是一组不重复的色，写两遍没有第二种意思）。
 */
export function parseSwatchText(text: string): SwatchParseResult {
  const colors: SwatchEntry[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const entry = parseSwatchLine(line);
    if (entry === null) {
      rejected.push(line);
      continue;
    }
    // 去重的键用"文本形态"：纯色就是色号本身，渐变就是那行 CSS —— 两种都天然可比
    const key = swatchEntryToText(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push(entry);
  }

  return { colors, rejected };
}

/** 一格格的色 → 编辑框里的文本（一行一格），{@link parseSwatchText} 的反函数 */
export function swatchToText(colors: readonly SwatchEntry[]): string {
  return colors.map(swatchEntryToText).join('\n');
}

// ─────────────────────────────────────────────────────────────
// 吸管取到一个色之后（T3.05 / `O19`）
// ─────────────────────────────────────────────────────────────

/**
 * 吸管取到 `color` 之后这张卡的新 `colors`，`null` = **不用改**（卡上本来就是这一个色）。
 *
 * ★ 语义是**替换**，不是追加。`O19` 之前这里返回 `[...colors, color]`（一卡多格，
 *   一行一行往下加）；一张色卡现在就是一块颜色，吸到的色只能是**这张卡的颜色**本身 ——
 *   再往下加一格，用户看到的是"卡面还是上一个色，文件里却悄悄多了一格"。
 * ★ 判重只认"**卡上就这一个色、而且正是它**"：那种情况下写下去只是白白递增一次
 *   revision、把文件标脏。旧多格卡里那些**非第一格**的颜色不算重复 —— 吸到它是有意义的
 *   一步，它会成为新的第一格，也就是卡面。
 * ★ 做成纯函数是因为这个判断**只有真点上去才看得到差别**：留在视图里就只能靠手点验证，
 *   而"重不重要"恰恰是最容易写错、也最容易被静默掉的一处。
 */
export function swatchColorsAfterPick(
  content: SwatchContent,
  color: HexColor,
): SwatchEntry[] | null {
  if (content.colors.length === 1 && content.colors[0] === color) return null;
  return [color];
}

// ─────────────────────────────────────────────────────────────
// 卡片定义
// ─────────────────────────────────────────────────────────────

export const swatchCard: CardTypeDefinition<'swatch'> = {
  type: 'swatch',

  get displayName(): string {
    return t('card.type.swatch');
  },

  icon: 'palette',
  defaultSize: SWATCH_DEFAULT_SIZE,

  createDefaultContent(): SwatchContent {
    return { colors: [], pickedFrom: null };
  },

  contextMenu(card, ctx): CardTypeMenuItem[] {
    return [
      {
        id: 'swatch-pick',
        title: t('menu.card.pickFromImage'),
        icon: 'pipette',
        // 多选说不通（往哪一张加？），锁定的卡本来就不该改内容。
        // 置灰而不是隐藏：用户看得见这个能力，也知道它为什么点不动
        disabled: ctx.multiple || card.locked,
        action: 'pickFromImage',
      },
      // 「编辑内容」（`O35`）：通用菜单里那一项对色卡**不出现**了（双击被调色板接走，
      // 通用那项点下去是弹调色板，名不副实），但"改色号文本"这条路必须留着 ——
      // 多行 / 渐变色号只有这里能改（`O07` / `O29`）。
      // ★ `editContent` 动作走 `editCard(id, true, 'raw')`，**跳过** `activate`，
      //   于是它老老实实进编辑态，不会被调色板截走。
      {
        id: 'swatch-edit',
        title: t('menu.card.editContent'),
        icon: 'pencil',
        disabled: ctx.multiple || card.locked,
        action: 'editContent',
      },
    ];
  },

  /**
   * 双击色卡 = **弹调色板**（`O29`）。
   *
   * ★ 用的是右键「卡片颜色 → 自定义颜色」那一个组件（`CardActionContext.pickColor`）：
   *   同一个需求不该在插件里有两套取色器。
   * ★ 选中的色**替换** `colors`（与吸管同一口径 `swatchColorsAfterPick`）：色卡是"一卡一色"。
   * ★ 想改**色号文本**（多行 / 渐变）走右键「编辑内容」—— `editEntry: 'raw'` 那条不经过这里。
   * ★ 没有取色能力（单测 / 嵌入视图）时不接管，让视图按通用行为处理。
   */
  onDoubleClick(card, ctx): boolean {
    if (card.locked) return false;
    const pick = ctx.pickColor;
    if (!pick) return false;
    const first = card.content.colors[0];
    pick(typeof first === 'string' ? first : null, (color) => {
      const next = swatchColorsAfterPick(card.content, color);
      if (next !== null) ctx.applyContent({ colors: next });
    });
    return true;
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-swatch');
    el.classList.remove('nestboard-swatch-preview', 'nestboard-swatch-edit', 'is-invalid');
    delete el.dataset.placeholder;
    applySurface(el, card.content);
    // 收起时内容槽整个被藏起来（连同底色层），这一格色改铺在卡片外壳上（`O33`）
    syncShellSurface(el, card);

    if (ctx.mode === 'edit') renderEditor(el, card.content, ctx);
    else renderPreview(el, card.content, ctx);
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...SWATCH_CLASSES);
    for (const name of SWATCH_STYLE_VARS) el.style.removeProperty(name);
    clearShellSurface(el);
    delete el.dataset.placeholder;
    el.replaceChildren();
  },

  toMarkdown(card): string {
    // 一行一格的无序列表：既能在导出的笔记里被 grep 到，
    // 也能原样复制回卡片编辑框（`parseSwatchText` 认 `- #4C8DFF` / `- linear-gradient(...)`）
    const { colors } = card.content;
    if (colors.length === 0) return '';
    return colors.map((entry) => `- ${swatchEntryToText(entry)}`).join('\n');
  },
};

// ─────────────────────────────────────────────────────────────
// 底色（两种模式共用）
// ─────────────────────────────────────────────────────────────

/**
 * 把"这一格色"写进内容槽的变量、并挂上 `is-solid`。
 *
 * ★ 上卡面的是**第一格**（`O19`）。`colors` 仍是数组，而卡面只有一片颜色，
 *   第一格之后的交给 `+N` 小字交代（见文件头"一卡一色"）。
 * ★ 纯色与渐变各写一个变量、另一个**摘掉**（不是留着上一次的值）：样式表那边靠
 *   "变量在不在"判这一格是纯色还是渐变（`O07` 的约定）。留着上一次的变量，
 *   用户把渐变改成纯色之后卡面上会同时有底色和渐变。
 * ★ 没有颜色（空色板）时**连 `is-solid` 一起摘掉**：留着它，下一帧的空状态
 *   会顶着上一格的色。
 */
function applySurface(el: HTMLElement, content: SwatchContent): void {
  if (content.colors.length === 0) {
    el.classList.remove('is-solid');
    for (const name of SWATCH_STYLE_VARS) el.style.removeProperty(name);
    return;
  }

  const entry = content.colors[0];
  el.classList.add('is-solid');
  if (typeof entry === 'string') {
    el.style.setProperty('--nestboard-swatch-color', entry);
    el.style.removeProperty('--nestboard-swatch-gradient');
  } else {
    el.style.setProperty('--nestboard-swatch-gradient', swatchEntryToText(entry));
    el.style.removeProperty('--nestboard-swatch-color');
  }
  el.style.setProperty('--nestboard-swatch-ink', swatchInkColor(entry));
}

/**
 * 把 `el` 所在卡片的外壳恢复干净（两个变量 + 那个标记类）。
 *
 * ★ 复用池里的节点随时会被派给别的类型：外壳上留着上一张色卡的底色，
 *   下一张卡（哪怕不是色卡）出场就顶着别人的颜色。
 */
function clearShellSurface(el: HTMLElement): void {
  const shell = el.parentElement;
  // 认 class 而不是认"有没有父节点"：槽位在池子里时结构还在，但身份得由 class 说了算
  if (!shell || !shell.classList.contains('nestboard-card')) return;
  for (const name of SWATCH_STYLE_VARS) shell.style.removeProperty(name);
  shell.classList.remove(SHELL_SURFACE_CLASS);
}

/**
 * 收起时把这一格色**同时写到卡片外壳**上（`O33`）。
 *
 * ★ 为什么需要：收起 = 内容槽 `display:none`（`styles.css` 的 `.is-collapsed` 规则），
 *   而底色层 `.nestboard-swatch-fill` 是内容槽的孩子 —— 色卡一收起就成了一条**白条**，
 *   可"这一格色"是它**唯一**的信息（`O19` 一卡一色）。
 *   CSS 反选也不行：变量写在内容槽上，而外壳不是它的后代。
 * ★ 只在收起时写：展开态照旧由内容槽里那层铺满。两处都写的话，"这张卡是什么色"
 *   就有了两个来源，改色时迟早只改到一处。
 * ★ 纯色 / 渐变各写一个变量，由样式表按"变量在不在"挑（与 `applySurface` 同一套约定）。
 */
function syncShellSurface(
  el: HTMLElement,
  card: { collapsed?: boolean; content: SwatchContent },
): void {
  clearShellSurface(el);
  if (card.collapsed !== true || card.content.colors.length === 0) return;

  const shell = el.parentElement;
  if (!shell || !shell.classList.contains('nestboard-card')) return;

  const entry = card.content.colors[0];
  shell.classList.add(SHELL_SURFACE_CLASS);
  if (typeof entry === 'string') shell.style.setProperty('--nestboard-swatch-color', entry);
  else shell.style.setProperty('--nestboard-swatch-gradient', swatchEntryToText(entry));
}

/**
 * 铺满整卡的底色层，内容槽的**第一个孩子**。
 *
 * ★ 自己不装任何颜色：两个变量都继承自内容槽 —— 于是"这张卡是什么色"
 *   仍然只有一处答案（`applySurface`）。
 * ★ `aria-hidden`：纯装饰，读屏读到"一个空 div"没有意义。
 * ★ **得在两种模式下都挂**：编辑态里用户正对着这块色改它的色号，
 *   底色中途消失会让卡"白一下"，看着像没保存上。
 */
function createFill(doc: Document): HTMLElement {
  const fill = doc.createElement('div');
  fill.className = 'nestboard-swatch-fill';
  fill.setAttribute('aria-hidden', 'true');
  return fill;
}

// ─────────────────────────────────────────────────────────────
// 显示态
// ─────────────────────────────────────────────────────────────

function renderPreview(el: HTMLElement, content: SwatchContent, ctx: CardRenderContext): void {
  el.classList.add('nestboard-swatch-preview');
  const doc = el.ownerDocument;

  if (content.colors.length === 0) {
    el.dataset.placeholder = 'true';
    // 直接写 `textContent`：它同时把子节点清掉（真 DOM 与假 DOM 语义一致），
    // 而 `replaceChildren(createTextNode(...))` 在假 DOM 里读不回文本
    el.textContent = t('card.swatch.empty');
    return;
  }

  el.replaceChildren(createFill(doc), buildChip(doc, content, ctx));
}

/**
 * 卡面上那一行：点它 = 复制第一格的色号（渐变格复制的是那行 CSS）。
 *
 * ★ `+N` 与色号在**同一个 button** 里：它们说的是同一件事（"这张卡上写着什么"），
 *   拆成两个可点的东西只会让人猜哪个才是"复制"。
 */
function buildChip(doc: Document, content: SwatchContent, ctx: CardRenderContext): HTMLElement {
  const entry = content.colors[0];
  // 显示文本、`title`、`aria-label`、剪贴板内容**共用这一份** ——
  // "看上去是那行 CSS"与"复制到的是那行 CSS"于是不可能不一致
  const text = swatchEntryToText(entry);

  const chip = doc.createElement('button');
  chip.type = 'button';
  chip.className = 'nestboard-swatch-chip';
  chip.title = t('card.swatch.copy', { color: text });
  chip.setAttribute('aria-label', t('card.swatch.copy', { color: text }));

  const label = doc.createElement('span');
  label.className = 'nestboard-swatch-hex';
  label.textContent = text;
  chip.appendChild(label);

  // 一卡一色之前的旧数据（`T3.04` 的"一卡多格"）：卡面只画第一格，
  // 但**必须说出来** —— 见文件头第 3 条
  const rest = content.colors.length - 1;
  if (rest > 0) {
    const more = doc.createElement('span');
    more.className = 'nestboard-swatch-more';
    more.textContent = t('card.swatch.more', { count: rest });
    chip.appendChild(more);
  }

  // 按一下不该被卡片层当成"开始拖这张卡"（与链接卡的按钮同一条）
  chip.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  chip.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    void copyColor(chip, text, ctx);
  });

  return chip;
}

/**
 * 每个色块上现挂着的反馈（定时器 + 那个小标签）。
 *
 * ★ 记下来而不是回头 `querySelector` 找：连点两次时要先撤掉上一份，
 *   而"我自己刚才挂了什么"本来就该自己知道 —— 少一次 DOM 查询，也少一条
 *   "标签被别处删过"的隐式前提。
 */
const feedbacks = new WeakMap<
  HTMLElement,
  { timer: ReturnType<typeof setTimeout>; status: HTMLElement }
>();

/**
 * 复制一格色（纯色 = 色号，渐变 = 那行 CSS），并在色块上就地反馈（成功 / 失败）。
 *
 * ★ 反馈画在**点的那一块**上，而不是弹全局 Notice：一次复制的影响范围就是这一行，
 *   而且手机上没有"右下角"可以看（`F11` 的移动端目标）。
 * ★ 异步回来时不再检查"这块还在不在文档里"：卡片的色块是每次重绘**新建**的，
 *   从不被复用，所以给一块已被丢弃的色块加个类不会串到别的卡上，
 *   而补一句 `isConnected` 判断在假 DOM 下又正好测不到（得不偿失）。
 */
async function copyColor(chip: HTMLElement, text: string, ctx: CardRenderContext): Promise<void> {
  const ok = (await ctx.clipboard?.writeText(text)) === true;
  flashStatus(
    chip,
    t(ok ? 'card.swatch.copied' : 'card.swatch.copyFailed'),
    ok ? 'is-copied' : 'is-copy-failed',
  );
}

/** 在色块上显示一条一次性反馈，`COPY_FEEDBACK_MS` 后自己收掉 */
function flashStatus(chip: HTMLElement, message: string, cls: string): void {
  const previous = feedbacks.get(chip);
  if (previous) {
    clearTimeout(previous.timer);
    previous.status.remove();
  }
  chip.classList.remove('is-copied', 'is-copy-failed');

  const status = chip.ownerDocument.createElement('span');
  status.className = 'nestboard-swatch-status';
  status.textContent = message;
  chip.appendChild(status);
  chip.classList.add(cls);

  const timer = setTimeout(() => {
    status.remove();
    chip.classList.remove(cls);
    feedbacks.delete(chip);
  }, COPY_FEEDBACK_MS);
  feedbacks.set(chip, { timer, status });
}

// ─────────────────────────────────────────────────────────────
// 编辑态
// ─────────────────────────────────────────────────────────────

function renderEditor(el: HTMLElement, content: SwatchContent, ctx: CardRenderContext): void {
  el.classList.add('nestboard-swatch-edit');
  const doc = el.ownerDocument;

  const area = doc.createElement('textarea');
  area.className = 'nestboard-swatch-input';
  // 色号不需要拼写检查：满屏红波浪线比错字更干扰（与便签 / 待办编辑框同一条）
  area.spellcheck = false;
  area.placeholder = t('card.swatch.placeholder');
  const initial = swatchToText(content.colors);
  area.value = initial;

  const hint = doc.createElement('div');
  hint.className = 'nestboard-swatch-hint';
  hint.textContent = t('card.swatch.hint');

  /** 提交只认第一次：`Esc` 之后 DOM 被换掉还会补一个 blur 上来 */
  let finished = false;
  const exit = (): void => {
    if (finished) return;
    finished = true;
    ctx.setMode('display');
  };

  const commit = (): void => {
    if (finished) return;
    // 没改就不写：否则每次点进点出都会递增 revision、把文件标脏
    if (area.value === initial) {
      exit();
      return;
    }

    const { colors, rejected } = parseSwatchText(area.value);
    if (rejected.length > 0) {
      // 见文件头第 2 条：**一个字都不写**，把坏行指出来，留在编辑态等用户改
      el.classList.add('is-invalid');
      hint.textContent = t('card.swatch.invalid', { line: rejected[0] });
      return;
    }

    finished = true;
    ctx.updateContent({ colors });
    ctx.setMode('display');
  };

  // 只让输入框吃掉指针：不拦的话按一下会先被卡片层的拖动接管
  area.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  area.addEventListener('blur', commit);
  area.addEventListener('keydown', (event: Event) => {
    const key = (event as KeyboardEvent).key;
    // 输入法组词中：此刻的按键不代表最终文本（`Esc` 会直接把候选词吞掉）
    if ((event as KeyboardEvent).isComposing) return;

    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      exit();
      return;
    }
    if (key === 'Enter' && ((event as KeyboardEvent).metaKey || (event as KeyboardEvent).ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      commit();
      return;
    }
    // 其余按键全归输入框：漏出去的话画布会把方向键 / Delete 当成"移动 / 删除这张卡"
    event.stopPropagation();
  });

  // 底色照旧铺着（编辑态也 `is-solid`），只是让它在输入框底下：
  // 内容顺序 = 底色 → 输入框 → 提示
  const nodes: HTMLElement[] = content.colors.length === 0 ? [] : [createFill(doc)];
  nodes.push(area, hint);
  el.replaceChildren(...nodes);
  area.focus();
}
