/**
 * 脑图数据模型（`06 §3`）—— `.nestmind` 的类型定义与运行时取值清单。
 *
 * 字段与白板的 `BoardFile` **逐字对齐**（`spec` / `version` / `revision` / `meta` / `view`），
 * 只有内容部分是脑图自己的：一棵**用户看得见结构的树**，外加若干个**悬浮节点**。
 *
 * ── 三条纪律（与 `model/schema.ts` 同源）────────────────────────
 *
 * 1. **树上节点的坐标不落盘**：位置由布局算出来（`mind/layout/`）。落盘的话，每次重排都要写盘、
 *    撤销栈会被"布局噪声"塞满，而且"结构是唯一事实"这条就不成立了。
 *    ★ **只有悬浮节点**（`parentId === null` 且不是根）才有 `free` —— 它不参与布局，坐标就是数据。
 * 2. **可选键缺席不补默认值**：`collapsed` / `style` / `props` / `refs` / `free` 缺席即默认。
 *    规范化时不许"顺手补 `false` / `[]`" —— 存量文件读一遍写回去必须**逐字节不变**
 *    （与 `Card.rotation` / `Group.collapsed` 同一条纪律）。
 * 3. **信封严格、条目宽松**：整体不像脑图就判定失败（上层进只读保护态、绝不写回），
 *    单个节点坏掉只丢那一个并留痕。判据全在 `validate.ts`。
 *
 * ★ 纯类型 + 常量：**不 import `obsidian`、不碰 DOM、不 import 白板的任何运行时模块**
 *   （`06 §2` 的边界）。白板那两个**类型**（`BoardBackground` / `CardColor`）是刻意复用的：
 *   "背景四档"与"主题色编号或自定义 HEX"在两边的语义完全一样，各抄一份只会漂移。
 */

import type { BoardBackground, CardColor, HexColor, ThemeColor } from '../../model/schema';
import type { Point } from '../../util/geometry';

// ─────────────────────────────────────────────────────────────
// 节点：属性（`C`，蓝图层）与引用（`B`，拖进来的文件）
// ─────────────────────────────────────────────────────────────

/**
 * 属性值（`06 §6.3`）：v1 只三档 —— 文本 / 数字 / 布尔。
 *
 * ★ 枚举与颜色留到 v1.1：它们要多带一份"可选值 / 色板"的元数据，
 *   而 `MindProp` 现在只有 `key` / `value` 两个位置 —— 先别把元数据塞进值里
 *   （那会让"值是什么类型"这件事有两个来源：`typeof value` 与一个自建的 `type` 字段）。
 */
export type MindPropValue = string | number | boolean;

/** 一条节点属性 */
export interface MindProp {
  id: string;
  key: string;
  value: MindPropValue;
}

/** 属性值的类型名（面板选类型用；运行时数组与类型写在一起，见 `BOARD_BACKGROUNDS` 的理由） */
export const MIND_PROP_VALUE_TYPES = ['string', 'number', 'boolean'] as const;
export type MindPropValueType = (typeof MIND_PROP_VALUE_TYPES)[number];

/** 节点上挂的一份引用（`B`：从文件浏览器拖进来的东西） */
export type MindRefKind = 'file' | 'image' | 'note';

export const MIND_REF_KINDS: readonly MindRefKind[] = ['file', 'image', 'note'];

/**
 * 一份引用 = 一条 Vault 路径。
 *
 * ★ 与白板的 `CardRef` 不同：这里**不存标题**。节点上的回形针只显示文件名，
 *   而文件名能从 `path` 推出来；存一份就多一处要在改名时同步的地方
 *   （`LinkIndex` 那条"能推导出来的数据不值得维护两次"的注释说的就是这件事）。
 * ★ **一个节点一个附件**（用户 2026-09-16 定的）：字段仍是数组（与 `Card.refs` 同构、
 *   存量文件不用改），但界面只认第一条 —— 拖新的进来是**替换**，见 `model/refs.ts`。
 */
export interface MindRef {
  kind: MindRefKind;
  path: string;
  /**
   * **图片的显示宽度**（px，可缺席）。
   *
   * ★ 为什么尺寸要落盘、而其他几何不落盘：它是**用户拖了四个角定下来的**，
   *   不是布局算出来的 —— 与悬浮节点的 `free` 同一条理由（能算出来的不存，
   *   用户定下来的必须存）。高度由原图长宽比推出来，所以只存一个数。
   * ★ 只有 `kind === 'image'` 时有意义；其他类型留着它会被忽略（不为它们写入）。
   */
  width?: number;
}

// ─────────────────────────────────────────────────────────────
// 节点
// ─────────────────────────────────────────────────────────────

/**
 * 节点配色（`A` 撞色）。
 *
 * ★ **不跟随 Obsidian 主题**：色是**存进文件的选择**（与 `O06` 深色便签同一条理由）——
 *   别人打开这块脑图该看到同一张图，导出 PNG / SVG 也就跟着变。
 * ★ 常规路径只写 `color`（主色），标题底 / 内容底 / 字色三档由 `util/color.ts` 按对比度推出来；
 *   `override` 是"用户手调过撞色"时的**整组覆盖**（三色要么都写、要么都不写 ——
 *   部分覆盖会让"这一组色到底长什么样"没有唯一答案）。
 */
export interface MindNodeStyle {
  color?: CardColor;
  override?: { title: HexColor; body: HexColor; ink: HexColor };
  /**
   * 标题的**整条**格式（`08 §3.2`）。
   *
   * ★ **作用对象是整条标题，不是选区**：标题是**一行纯文本**（`06 §1` 第 10 条），
   *   局部加粗需要把标题改成"富文本 run 模型" —— 那会动到标题的存储形态，
   *   并牵动就地输入 / 导出 / 搜索的每一处。**刻意不做**（`08 §8`）。
   * ★ 缺席 = 按**层级规则**（根加粗、其余不加粗）；用户显式设过就听用户的
   *   （含"把根节点的加粗关掉"）。
   */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /**
   * 标题的**字色**。
   *
   * ★ 与 `color`（**主色 = 标题底色**）不是一回事：主色决定"这块卡是什么色系"，
   *   字色决定"标题那几个字什么颜色"。默认由底色按对比度推出来（保证读得清），
   *   这里只在用户显式挑过时覆盖它。
   */
  ink?: HexColor;
  /**
   * 标题**文字背后的高亮色**（`N3-f`；差距清单第 3 件，幕布 / 飞书都有）。
   *
   * ★ 与 `color`（整张卡的**主色 = 标题带底色**）、`ink`（**字的颜色**）是**三件不同的事**：
   *   它只画在**文字那一块**背后，像用荧光笔划过去 —— 所以快捷栏给的是另一支**浅色**取值表
   *   （`MIND_TITLE_HIGHLIGHTS`），字色照旧由对比度推 / 用户自己挑。
   * ★ 存**色号**而不是主题色编号（与 `ink` 同一条）：主题色编号会跟着主题变，
   *   而"我划过哪一段"是**存进文件的选择** —— 换主题不该让它变色。
   * ★ 缺席 = 没有高亮（纪律 2：不补 `null`，也不写空串）。
   */
  highlight?: HexColor;
}

export interface MindNode {
  id: string;
  /** 标题：**一行文本**（空串 = 还没写；不落盘 `title` 之外的任何排版信息） */
  text: string;
  /** 内容：**一块 Markdown**（空串 = 没有内容） */
  note: string;
  /** 父节点；`null` = 根节点或悬浮节点（两者靠 `MindFile.rootId` 区分） */
  parentId: string | null;
  /** 同一父节点下的次序（0 起、连续；见 `validate` 的归一化） */
  order: number;
  /** 折叠（缺席 = 展开，与 `Group.collapsed` 同一条纪律：**不补 `false`**） */
  collapsed?: boolean;
  /** 悬浮节点的位置（`06 §3` 纪律 1）：**只有它才有** */
  free?: Point;
  style?: MindNodeStyle;
  props?: MindProp[];
  refs?: MindRef[];
  /**
   * 节点标记（一个 emoji，`08 §3.1`）：**放在标题最前面**，一个节点最多一个。
   *
   * ★ 存的是 **emoji 字符本身**（与白板卡片的 `O10` 同一条纪律）而不是"图标名"：
   *   换主题、换版本、换机器看到的都还是同一个表情。
   * ★ 缺席 = 没有标记（纪律 2：不补空串）。
   */
  icon?: string;
  /**
   * **完成**（`N3-g`：差距清单第 4 件；幕布 `.node.finished`、飞书"完成"两家都有）。
   *
   * ★ 语义分两层，别混：
   *   ① **这一行自己**完成 ⇒ 标题**加删除线 + 变灰**（`is-done`）；
   *   ② 它**下面整支**跟着变淡（`is-done-dim`）—— 但那是**看出来的**，不是写下来的：
   *      子孙节点自己的 `done` 一位都不动（"这一支做完了"是父节点上的一件事）。
   * ★ 缺席 = 未完成（纪律 2：不补 `false`，与 `collapsed` / `icon` 同一条）。
   */
  done?: boolean;
}

// ─────────────────────────────────────────────────────────────
// 文件
// ─────────────────────────────────────────────────────────────

// （关联线的 `bend` / `color` 见 `MindLink` 上的字段说明）

/**
 * 一条**关联线**（`N1`，用户 2026-09-16）：两个节点之间的额外关联。
 *
 * * **只有一种画法**：曲线（用户明确"这个连线只有曲线样式"）—— 没有线型字段；
 * * **允许 A→B 之间有多条**（不同标签），不做去重（用户 2026-09-16 确认）；
 * * `from` / `to` 是**松散引用**：指向不存在的节点时整条丢掉（`validate` 兜底）。
 */
export interface MindLink {
  id: string;
  /** 起点节点 id */
  from: string;
  /** 终点节点 id */
  to: string;
  /** 标签（`N1-c`）。缺席 = 没有标签（纪律 2：不补空串） */
  label?: string;
  /**
   * 箭头（用户 2026-09-16：**可以手动编辑**）：`'end'` = 终点一个、`'both'` = 两端各一个。
   * ★ **缺席 = 无箭头**（纪律 2：不补 `'none'`）—— 默认干净，想要方向再自己点出来。
   * ★ 它是**每一条线自己**的字段，与"树的分支线"无关（分支线永远没有箭头）。
   */
  arrow?: 'end' | 'both';
  /**
   * **实线**（用户 2026-09-16：关联线默认虚线，可以让用户自己改成实线）。
   *
   * ★ 只认 `true`：**缺席 = 虚线**（默认那一档），写 `false` 与缺席是同一个意思，
   *   读盘时会被丢掉（纪律 2：默认值不落盘）—— 于是"读一遍写回去逐字节不变"照旧。
   * ★ 存正反哪一档按"默认值不落盘"来定：默认是虚线 ⇒ 落盘的只能是"实线"这件事本身。
   */
  solid?: boolean;
  /**
   * **弯折**（`N1-d`，用户 2026-09-17："脑图的连线功能，上面加个手柄，可以调节连线的弯折程度和方向"）。
   *
   * ★ 存的是**曲线中点相对"不弯时那个中点"的位移**（世界坐标 px），不是控制点坐标 ——
   *   节点一挪，线必须跟着走；存绝对值会让线留在原地（那就成了一条飘着的线）。
   * ★ **缺席 = 不弯**（= 这条线从前的样子；纪律 2：默认值不落盘）⇒
   *   存量文件读一遍写回去仍逐字节不变、画出来也一个像素不变。
   */
  bend?: LinkBend;
  /**
   * **线条颜色**（`N1-e`，用户 2026-09-17："脑图的连接线应该也要支持改颜色"）。
   *
   * ★ 存**主题色编号**（`'1'`–`'6'`）而不是色号：与分支线（`branchColorAt`）同一套词汇，
   *   于是"用户换了主题，线也跟着换"是免费的；写进文件里的也只是一个字符。
   * ★ 缺席 = **用默认那条灰线**（`--background-modifier-border`，纪律 2：默认值不落盘）。
   */
  color?: ThemeColor;
}

/** 关联线的**弯折**：曲线中点相对"不弯时那个中点"的位移（世界坐标 px）—— 见 `MindLink.bend` */
export type LinkBend = { x: number; y: number };

/**
 * 一次拖动能把关联线拉多远（世界坐标 px，从"不弯时的中点"算起）。
 *
 * ★ 夹在**写入处**（与图片宽度 `setRefWidth` 同一条纪律）：手一抖拉出十万八千里的值
 *   既画不出来（跑到框外），也不该落盘。
 */
export const MIND_LINK_BEND_MAX = 1200;

/**
 * 弯折小到这个程度就当作**没弯**（世界坐标 px）。
 *
 * ★ 纪律 2：`bend` 缺席 = 不弯 ⇒ 用户把线**拉回原处**时应当干净地回到"缺席"，
 *   而不是在文件里留一个 `{x: 0.4, y: -1.2}`（那样"读一遍写回去逐字节不变"立刻失效）。
 */
export const MIND_LINK_BEND_MIN = 2;

/**
 * 把弯折夹进合法范围；`null` = **不该写进文件**。
 *
 * ★ 读盘（`validate`）与写盘（`ops`）**共用这一个**口径：两处各写一份，
 *   "读出来的"与"写下去的"迟早不是同一个东西。
 */
export function normalizeLinkBend(
  bend: { x: number; y: number } | undefined,
): { x: number; y: number } | null {
  if (!bend) return null;
  const { x, y } = bend;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const length = Math.hypot(x, y);
  if (length < MIND_LINK_BEND_MIN) return null;
  if (length <= MIND_LINK_BEND_MAX) return { x, y };
  const k = MIND_LINK_BEND_MAX / length;
  return { x: x * k, y: y * k };
}

export interface MindMeta {
  /** 稳定 ID：跨重命名不变（快照 / 未来的分享链接都靠它） */
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 总体结构（`08 §1.2`）：树往哪长、兄弟怎么排。
 *
 * ★ 它是**这一眼怎么看**，与缩放 / 平移同一类 ⇒ 住在 `view` 里、**不进撤销栈**、不递增 `revision`
 *   （用户 2026-09-16 确认过这条取舍）。要能撤销就得把它变成内容字段 —— 那会让"看的角度"
 *   成为文档内容的一部分。
 * ★ **`fishbone`（鱼骨图）已砍掉**（用户 2026-09-16：体验一般、脑图里也不常用）：
 *   它不在这一组里，文件里若手写了它，`validate` 会**丢掉这个键** ⇒ 回落到默认的
 *   `logic-right`（不报错、也不改文件里的其它东西）。
 */
export const MIND_STRUCTURES = ['logic-right', 'logic-left', 'octopus', 'org-down'] as const;
export type MindStructure = (typeof MIND_STRUCTURES)[number];

/** 分支线形态（`08 §1.3`）：同样住在 `view` 里 */
export const MIND_EDGE_STYLES = ['curve', 'line', 'elbow', 'rounded'] as const;
export type MindEdgeStyle = (typeof MIND_EDGE_STYLES)[number];

/** 缺省结构 / 缺省线型（`view` 里没写这两个键时用它） */
export const MIND_DEFAULT_STRUCTURE: MindStructure = 'logic-right';
export const MIND_DEFAULT_EDGE_STYLE: MindEdgeStyle = 'curve';

/**
 * 视口是**界面状态**而非内容：只改视口**不递增** `revision`（与 `BoardViewState` 同一条）。
 *
 * ★ `structure` / `edge` 也住在这里，理由同上（`08 §1.2`）：它们是"换个角度看同一棵树"，
 *   不是"这棵树变了"。缺席 = 用 {@link MIND_DEFAULT_STRUCTURE} / {@link MIND_DEFAULT_EDGE_STYLE}
 *   —— 纪律 2 照旧：**缺席不补键**（存量文件读一遍写回去逐字节不变）。
 */
export interface MindViewState {
  x: number;
  y: number;
  zoom: number;
  background: BoardBackground;
  structure?: MindStructure;
  edge?: MindEdgeStyle;
  /**
   * **大纲视图**（`N3-a`，用户 2026-09-16："增加脑图的大纲笔记视图"）。
   *
   * ★ 与 `structure` / `edge` 同一类：它是"换个角度看**同一棵树**"，不是内容 ——
   *   切换**不进撤销栈**（`updateView` 那条路）。
   * ★ 缺席 = **树视图**（默认那一档）；写 `false` 也是有意义的值（用户明确切回了树），
   *   所以读盘时**照原样留着**（不像 `arrow` 那样只认一个真值）——
   *   否则"读一遍写回去逐字节不变"会失效。
   */
  outline?: boolean;
  /**
   * **聚焦**（`N3-e`）：只显示这一支、把它当作"根"（幕布 `⌘]` 进入 / `⌘[` 返回；
   * 飞书：双击行首圆点 + 顶部面包屑返回）。
   *
   * ★ 与 `outline` / `structure` / `edge` 同一类 —— "换个角度看**同一棵树**"，不是内容：
   *   进出聚焦走 `updateView`（**不进撤销栈、不递增 `revision`**）。
   * ★ 缺席 = **没聚焦**（看整棵树）。
   * ★ 它只在**这棵树上**有意义：读盘时那个节点不在就丢掉（与 `links` 的端点同一口径 ——
   *   指着一个不存在的节点，比"没聚焦"糟得多）。
   * ★ 它是**大纲视图**的镜头：画布那边照旧显示整棵树（`09 §3.6.1` 把聚焦列为 v2，
   *   这里只做大纲这一半）。
   */
  focus?: string;
}

export interface MindFile {
  spec: string;
  version: number;
  /** 单调递增修订号，用于冲突检测 */
  revision: number;
  meta: MindMeta;
  view: MindViewState;
  /**
   * 中心主题的节点 id。
   *
   * ★ **必定存在、不可删**（`06 §1` 第 9 条）：它不是"第一个父节点为空的节点"这种推导出来的东西，
   *   而是文件里写死的一个引用 —— 删掉中心主题这种事在交互层就不该发生，`validate` 再兜一道底。
   */
  rootId: string;
  /** 扁平节点表（`06 §3.2`）：与 `.nboard` 的 `cards[]` 同构，`parentId` 表达树 */
  nodes: MindNode[];
  /**
   * **关联线**（`N1`）：两个节点之间的**额外**关联，用户手画的。
   *
   * ★ 与"分支线"是两回事：分支线是父子关系（**就是**树的形状，由布局算出来），
   *   关联线**不参与布局** —— 画一条线不会让任何节点挪位置，它只是叠在图上的一层。
   * ★ 缺席 = 一条都没有（纪律 2：不补空数组 ⇒ 存量文件逐字节不变）。
   * ★ 字段名**故意不叫 `edges`**：这个仓库里 `edges` 已经指白板的连线
   *   （`BoardFile.edges`），脑图里再叫 `edges` 会让人以为"改的是树的连法"。
   */
  links?: MindLink[];
}

// ─────────────────────────────────────────────────────────────
// 判据（纯函数，读盘与面板共用一份）
// ─────────────────────────────────────────────────────────────

export function isMindStructure(value: unknown): value is MindStructure {
  return typeof value === 'string' && (MIND_STRUCTURES as readonly string[]).includes(value);
}

export function isMindEdgeStyle(value: unknown): value is MindEdgeStyle {
  return typeof value === 'string' && (MIND_EDGE_STYLES as readonly string[]).includes(value);
}

export function isMindRefKind(value: unknown): value is MindRefKind {
  return typeof value === 'string' && (MIND_REF_KINDS as readonly string[]).includes(value);
}

export function isMindPropValue(value: unknown): value is MindPropValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * 是不是**悬浮节点**（`06 §1` 第 9 条）—— 只有它才带着坐标、也只有它不参与布局。
 *
 * ★ 判据只有一处：`parentId === null && id !== rootId`。写成 helper 而不是各处现拼，
 *   是因为"根"也是 `parentId === null`，漏掉后半句会把中心主题当成一个可以被随手拖走的自由主题。
 */
export function isFreeNode(node: Pick<MindNode, 'id' | 'parentId'>, rootId: string): boolean {
  return node.parentId === null && node.id !== rootId;
}
