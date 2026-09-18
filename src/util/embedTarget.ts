/**
 * 白板嵌入的目标解析（T3.16 / `F10-04` / `F1-10`、T7.09 / `F7-10`）。
 *
 * 从"用户在代码块里写的字"里取出白板路径（T7.09 起还包括小窗高度），
 * 以及判断一个 `![[…]]` 该不该被我们接管。纯逻辑、零 DOM、零 Obsidian ——
 * 渲染那层（`integration/BoardEmbed.ts`）只负责把它接上 Vault 与 canvas，
 * 于是"路径怎么认"这件事可以脱离宿主单测。
 *
 * ★ 与 `model/` 分开：这里既不是白板数据模型，也不产生任何卡片/几何，只是"文本 → 规格"，
 *   和 `util/linkPreview.ts` 同属"外部语法的解析"这一类。放在 `util/` 也让 model 层
 *   继续守着"不许 import obsidian"的边界（本文件只 import 一个常量）。
 */

import { BOARD_EXT } from '../constants';

/**
 * 嵌入的完整规格（T7.09）。
 *
 * ★ `height` 是"这扇窗多高"，不是"内容多高"：给了它，嵌入就变成**固定高度的只读小窗**
 *   （内容缩放着装进去、背景铺满整扇窗）；不给，高度仍随内容走（T3.16 的老行为）。
 *   两者都在，是为了让存量的 `![[x.nboard]]` 逐字不动 —— 想用小窗的人显式写一行。
 */
export interface EmbedSpec {
  /** 目标板路径；`null` = 没给出可用路径 */
  path: string | null;
  /** `height:` 指定的 CSS 像素高度；`null` = 没给（= 高度随内容） */
  height: number | null;
}

/** `height:` 的可用范围。写在文件里的数字有可能是手滑（`height: 0` / `height: 100000`） */
export const EMBED_MIN_HEIGHT = 120;
export const EMBED_MAX_HEIGHT = 2000;

/**
 * 认得出「标识符 + 冒号」这种键行（`file: x.nboard` / `height: 480`）。
 *
 * ★ 这里匹配的是**任意**键名，而不只是 `file` / `height`：认不出来的是"多写的字"，
 *   不是"用户写错的那块板" —— 将来规格里加了 `mode:` 之类，不能让它在老版本里
 *   退化成"去查一块叫 `mode:` 的白板"。所以键名交出去、由下面按名字分派，
 *   不认识的**整行丢掉**。
 * ★ 键名要求以字母开头（`[A-Za-z][A-Za-z0-9_-]*`）：`2024: 计划/A.nboard` 这种
 *   带冒号的真路径仍被当成裸路径，而不是被误当成键行丢掉。
 * 冒号**半角全角都收**（中文输入法下顺手打出的 `：` 不该让整行失效）；前后随意空格。
 */
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*[:：]\s*(.*)$/;

/**
 * 解析嵌入规格。
 *
 * 认得出：
 *  * `file: 板.nboard`（**官方推荐的写法**，T3.16 只支持裸路径，写了这个键反而会
 *    把 `file:` 当成路径的一部分去查 Vault，然后显示"白板不存在"）；
 *  * `height: 480`（只读小窗的高度，见 `EmbedSpec`）；
 *  * 裸路径（`![[x.nboard]]` 与代码块里的老写法）—— 任何**非键行**都当作裸路径，
 *    而且只在还没认到路径时采纳。
 *
 * ★ 不认识的键（比如规格里提过的 `mode:`）**直接忽略**，不报错也不猜：
 *   多写一行不会让整块嵌入失效。宽进严出 —— 认不出来的是"多写的字"，
 *   不是"用户写错的那块板"。
 */
export function parseEmbedSpec(source: string): EmbedSpec {
  const spec: EmbedSpec = { path: null, height: null };

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const match = KEY_LINE.exec(line);
    if (match) {
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (key === 'file') {
        if (spec.path === null) spec.path = cleanTarget(value);
      } else if (key === 'height') {
        spec.height = readHeight(value);
      }
      // 其余键（规格里提过的 `mode:` / 用户手写的注释行）**整行丢掉**：
      // 落在下面那条裸路径分支上会被当成路径，于是去查一块叫 "mode:" 的白板
      continue;
    }

    if (spec.path === null) spec.path = cleanTarget(line);
  }

  return spec;
}

/**
 * 从嵌入源文本里取出白板路径（= `parseEmbedSpec().path`）。
 *
 * 认得出用户可能写的几种形态：
 *  * ` ```nestboard ` 里的裸路径（可能带前后空行、可能写了好几行）；
 *  * 手滑把 `![[x.nboard]]` 也写进了代码块 —— 剥掉包装，不要因为多了两个方括号就说"没给路径"；
 *  * `x.nboard|别名` / `x.nboard#小节` —— 别名与区块引用与"是哪块板"无关，取前段。
 *
 * 返回 `null` = 没有可用的路径（渲染层据此显示"没有给出白板路径"）。
 * **不做扩展名补全**：补成什么由调用方决定（只有它知道该不该补 `.nboard`）。
 */
export function parseEmbedPath(source: string): string | null {
  return parseEmbedSpec(source).path;
}

/** 一处剥掉 `[[…]]` 包装、`|别名`、`#锚点` —— 三种写法的清理完全一样，路径与 `file:` 值共用 */
function cleanTarget(text: string): string | null {
  let value = text;
  const wrapped = /^!?\[\[([^\]]+)\]\]$/.exec(value);
  if (wrapped) value = wrapped[1];

  // 别名（`|`）与区块（`#`）都从这一处切掉：它们描述"显示什么"，不描述"是哪块板"。
  // 两者取**更靠前**的那个；都没有时 `Math.min()` 得到 `Infinity`，下面的 `isFinite` 会拦住
  const cuts = [value.indexOf('|'), value.indexOf('#')].filter((index) => index >= 0);
  const cut = cuts.length > 0 ? Math.min(...cuts) : -1;
  if (cut >= 0) value = value.slice(0, cut);

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 读 `height:` 的值。
 *
 * ★ 离谱的值**夹到可用范围**，而不是拒绝整行：用户写 `height: 100000` 想要的是
 *   "高一点"，不是"报错"；而真的按 100000 去建画布会当场把内存打爆。
 *   `NaN` / `0` / 负数则是"这一行没写成"，返回 `null` 让它退回老行为。
 */
function readHeight(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, Math.round(parsed)));
}

/** 路径是否指向白板文件（`![[…]]` 的拦截判定用；大小写不敏感，兼容 `.NBOARD`） */
export function isBoardPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith(`.${BOARD_EXT}`);
}
