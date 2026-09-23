/**
 * **大纲视图**（`N3-a`）：同一份 `.nestmind` 的第二种呈现。
 *
 * ── 两条边界（都在 `09 §3` 里定过）──────────────────────────
 *
 * 1. **只走主树**：悬浮节点（`parentId === null` 但不是根）**不出现** ——
 *    用户明确"大纲里只编辑主树信息"；它本来就不属于任何层级，
 *    硬塞进缩进列表只能造一个假层级。
 * 2. **折叠的行还在，它的子孙不在**：那正是"折叠"在大纲里的意思
 *    （与导图里把一支收起来是同一件事），行尾显示这一支一共几个节点。
 *
 * ★ 文件分两半：`outlineRowsOf` 是**纯函数**（模型 → 行，能单测），
 *   下面那半个 `buildOutlinePanel` 只管把行画成 DOM。分开是因为
 *   前者才是"大纲到底是什么"的地方，后者换一套 DOM 也不该影响它。
 */

import { t } from '../../util/i18n';
import { rectsIntersect, type Rect } from '../../util/geometry';
import { childrenOf, isDescendant, isRootNode, nodeById } from '../model/ops';
import type { MindFile, MindNode } from '../model/schema';

/**
 * 大纲里**行**的字号（照幕布 + 飞书两份参考件对齐）。
 *
 * ★ 幕布的大纲里**正文一律 16px / 行高 24**；放大只发生在用户自己标了标题级别的行上
 *   （`heading1/2/3` = 24 / 21 / 19）。我们没有"每行标题级别"这个字段（见 `09 §3.6.1`），
 *   于是用**层级**做一份**很轻**的递减：第一层 18 / 更深深 16。
 * ★ **根不在行里**：它是顶上那一行标题（用户 2026-09-17 的①），字号由样式表管
 *   （26px / 500 字重 / 带一条下边线 —— 与幕布导出件里的 `.title` 同值）。
 * ★ "一眼看出第几层"主要交给**缩进 + 竖线**，字号只是辅助 —— `09 §3.4` 原来写的是
 *   "与导图同一套 `titleSizeOf`"，那套递减到十几 px 还层层加粗，摆在列表里像小字报。
 */
const OUTLINE_LEVEL_SIZE = 18;
const OUTLINE_BASE_SIZE = 16;

/**
 * 正文**收起时显示几行**（`O2`，用户 2026-09-21 定的 **6**）。
 *
 * ★ 样式表里那一句 `max-height: 132px` 就是"6 × 22px 行高"，两处**必须是同一个数** ——
 *   将来改这里，记得一起改（写在样式表的注释里了）。
 */
export const OUTLINE_NOTE_FOLD_LINES = 6;

/**
 * 正文要不要给「展开 / 收起」那枚把手。
 *
 * ★ 判据只能是**估算**：建行的时候这一行还没挂到 DOM 上，量不出真实行数。
 *   两个口径**任一够长**就算：
 *   ① 它本来就有 7 行以上（`\n` 是真的换行）；
 *   ② 显示宽度超过"6 行 × 20 个单位"—— 20 是"大纲正文那一列大约放得下多少英文单位"的粗估
 *      （正文 14px，面板正文列约 300px）。中文按 2 折算（`displayWidthOf`）。
 * ★ 宁可**多给**这枚把手：多一个暂时没用的按钮，也远好过"正文被折了却展不开"。
 * ★ 纯函数、不碰 DOM，可直接单测。
 */
export function noteFoldNeeded(note: string): boolean {
  if (note.split('\n').length > OUTLINE_NOTE_FOLD_LINES) return true;
  return displayWidthOf(note) > OUTLINE_NOTE_FOLD_LINES * 20;
}
// ★ `HexColor` 住在**白板那一份** schema 里（颜色是跨两个文档类型共用的词汇，
//   脑图只借用，见 `model/palette.ts` 的同一句）
import type { HexColor } from '../../model/schema';
import { displayWidthOf } from '../layout/measure';
import { MIND_NODE_ID_ATTR } from './render';

/** 大纲里的一行（`N3-a`）：**已经算好"长什么样"**，面板只管照着画 */
export interface OutlineRow {
  id: string;
  /** 0 = 根 */
  depth: number;
  text: string;
  /** 标记 emoji（空串 = 没有） */
  icon: string;
  /** 正文（`note`）；空串 = 不画那一块 */
  note: string;
  /**
   * 正文是否**展开**（`O2`，用户 2026-09-21：正文超过 6 行要能折叠）。
   *
   * ★ 缺席 = 收起（默认只显示 6 行）。
   * ★ 这个状态由**视图**保管、在这里贴上来（纯视图状态：与"滚到哪"同级 ——
   *   不进模型、不进撤销栈、不落盘）。
   */
  noteExpanded?: boolean;
  collapsed: boolean;
  /** 直接子节点数（**有孩子才画折叠三角**） */
  childCount: number;
  /** 这一支一共几个节点（★ **与导图手柄同一个数字**）；没孩子时是 0 */
  subtreeSize: number;
  /** 下面五项是"**生效值**"：用户设过听用户的，否则按层级推 —— 与画布同一套 */
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /**
   * 用户显式设过的**字色**；`null` = 用主题的正文色。
   *
   * ★ 这里与画布**刻意不一样**：画布上 `ink` 的缺省是"按标题底色算对比度"，
   *   而大纲里没有那块底色 —— 把 `titleInk` 搬过来会在浅色主题下得到一片看不清的字。
   */
  ink: HexColor | null;
  /**
   * 用户显式设过的**文字高亮色**（`N3-f`）；`null` = 没有高亮。
   *
   * ★ 它落在**文字那一块**背后（与画布上 `.nestboard-mind-node-title-text` 同一条语义）：
   *   大纲里这一行没有"标题带"，高亮于是特别显眼 —— 正是这个视图里最实用的一档格式。
   */
  highlight: HexColor | null;
  /**
   * **这一行自己**完成了（`N3-g`）：标题画删除线 + 变灰。
   *
   * ★ 与 `dimmed` 是两档：**祖先**完成只让这一行变淡，不会给它加删除线 ——
   *   "我做完的那一条"与"它是某条已完成分支里的"要能一眼分开。
   */
  done: boolean;
  /** 祖先里有完成的 ⇒ 整行画淡一点（自己完成的那一行**不**额外变淡） */
  dimmed: boolean;
}

/** 父 id → 孩子（按 `order`，与 `childrenOf` 同一个口径），一次建好反复用 */
function childrenIndex(mind: MindFile): Map<string | null, MindNode[]> {
  const index = new Map<string | null, MindNode[]>();
  for (const node of mind.nodes) {
    const bucket = index.get(node.parentId);
    if (bucket) bucket.push(node);
    else index.set(node.parentId, [node]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }
  return index;
}

/**
 * 把一份脑图摊成**大纲的行**（前序遍历，折叠的子树跳过；悬浮节点不出现）。
 *
 * ★ 纯函数：不碰 DOM、不读 CSS —— 于是"根在最上、孩子跟在后面、折叠的不展开"
 *   这几条能在 node 下单测（这类规则最容易被一次重构悄悄改坏）。
 */
export function outlineRowsOf(mind: MindFile, focusId?: string): OutlineRow[] {
  // ★ **聚焦**（`N3-e`）：从**这一支**走，而不是从根 —— 它自己变成顶上那行标题
  //   （见 `outlineTitleOf`），于是"根不进列表"那条规矩自动延伸到它身上：
  //   进来的这一支没有行、也没有手柄（要改它自己的文字，按 `⌘[` 回上一级改）。
  //   ★ 找不到就**退回根**：不与"没聚焦"分叉，调用方不必自己判
  const root =
    (focusId ? mind.nodes.find((node) => node.id === focusId) : undefined) ??
    mind.nodes.find((node) => node.id === mind.rootId);
  if (!root) return [];

  const index = childrenIndex(mind);

  /** 这一支一共几个节点（含自己）—— 与导图手柄读的是同一个数 */
  const sizes = new Map<string, number>();
  const sizeOf = (id: string): number => {
    const cached = sizes.get(id);
    if (cached !== undefined) return cached;
    const children = index.get(id) ?? [];
    const total = 1 + children.reduce((sum, child) => sum + sizeOf(child.id), 0);
    sizes.set(id, total);
    return total;
  };

  const rows: OutlineRow[] = [];
  /**
   * ★ **根不进列表**（用户 2026-09-17 的第①条）：它在这个视图里是**标题**
   *   （见 `outlineTitleOf`）—— 于是"只有子节点才有展开 / 收起"自动成立：
   *   根没有行，也就没有它的手柄，更没法"直接改根节点"。
   * ★ 行自己的 `depth` 从 **0** 起（= 根的直接孩子）：缩进与竖向引导线按它算；
   *   而字号按**绝对层深**推（第一层 18、更深深 16 —— 见上面那两档常量）。
   */
  const walk = (node: MindNode, depth: number, doneAncestor: boolean): void => {
    const children = index.get(node.id) ?? [];
    // ★ 聚焦的那一支**忽略它自己的 `collapsed`**（`N3-e`）：都走进来了还只看到一行标题
    //   说不过去。那个标记是给画布与"上一级"看的；这里只是换了个镜头，**模型一个字节都没动**
    const collapsed = node.collapsed === true && node.id !== root.id;

    if (depth > 0) {
      rows.push({
        id: node.id,
        depth: depth - 1,
        text: node.text,
        icon: node.icon ?? '',
        note: node.note.trim(),
        collapsed,
        childCount: children.length,
        subtreeSize: children.length > 0 ? sizeOf(node.id) : 0,
        size: depth === 1 ? OUTLINE_LEVEL_SIZE : OUTLINE_BASE_SIZE,
        // ★ **只有显式设过才加粗**：这个视图的正文是常规字重，加粗是用户自己刷的格式
        //   （按层级推粗会让一列字全变成黑体，层次反而糊了）
        bold: node.style?.bold === true,
        italic: node.style?.italic === true,
        underline: node.style?.underline === true,
        ink: node.style?.ink ?? null,
        highlight: node.style?.highlight ?? null,
        // 完成（`N3-g`）：`done` = 这一行自己完成；`dimmed` = 祖先里有完成的
        // ★ 自己完成的那一行**不额外变淡** —— 它已经有删除线 + 灰，再压一层就分不出来了
        done: node.done === true,
        dimmed: doneAncestor && node.done !== true,
      });
    }

    // 折叠的那一支：行留着，子孙不出现（展开时自然回来，模型一个字节都没变）
    if (collapsed) return;
    for (const child of children) walk(child, depth + 1, doneAncestor || node.done === true);
  };

  walk(root, 0, false);
  return rows;
}

/**
 * 大纲**标题** = 根节点的文字（用户 2026-09-17："根节点变成单独标题，
 * 这个模式下无法直接改根节点"）。
 *
 * ★ 取根节点的 `text` 而不是 `meta.title`：这个视图呈现的是**树**，
 *   顶上那一行就是这棵树的根；`meta.title` 是文件名（Obsidian 页签上已经有了）。
 * ★ 它**只读**（不是输入框）——"无法直接改根节点"是**这个视图的规矩**：
 *   要改根节点就回导图里改（那边它是个普通节点，双击即可）。这条规矩让"根"在这里
 *   彻底退出键盘操作的范围：`Enter` / `Tab` / `⌫` 都只作用在**行**上。
 * ★ **聚焦**（`N3-e`）时它就是**进来的那一支**的文字 —— 标题与"现在这棵树是谁"永远一致；
 *   同一套"只读"规矩也就一起延伸过去了（要改它，按 `⌘[` 回上一级，它在那儿是一行）。
 */
export function outlineTitleOf(mind: MindFile, focusId?: string): string {
  const focus = focusId ? mind.nodes.find((node) => node.id === focusId) : undefined;
  return focus?.text ?? mind.nodes.find((node) => node.id === mind.rootId)?.text ?? '';
}

/** 面包屑的一格（`N3-e`）：从根一路到**当前聚焦的那一支** */
export interface OutlineCrumb {
  id: string;
  text: string;
}

/**
 * 面包屑（`N3-e`）：`根 → … → 聚焦的那一支`；**没聚焦时给空数组**（面板不画那条）。
 *
 * ★ 从**聚焦节点往上走**（而不是从根往下找）：往上走只需要 `parentId`，链长就是深度，
 *   不必递归整棵树。
 * ★ 悬浮节点（`parentId === null` 但不是根）**返回空**：它不是"某一支"，大纲里根本没有
 *   它那一行 —— 面包屑给它留一格会让人以为"点一下能回去"。
 * ★ `guard` 是防环的兜底（`validate` 会拆环，但这里不该指望上游）。
 */
export function outlinePathOf(mind: MindFile, focusId?: string): OutlineCrumb[] {
  if (!focusId) return [];
  const crumbs: OutlineCrumb[] = [];
  let cursor = nodeById(mind, focusId);
  let guard = 0;
  while (cursor && guard < 512) {
    crumbs.unshift({ id: cursor.id, text: cursor.text });
    if (cursor.parentId === null) break;
    cursor = nodeById(mind, cursor.parentId);
    guard += 1;
  }
  // 链的顶端必须是**根**：不是的话说明这一支挂在悬浮节点下面（那种东西不进大纲）
  if (crumbs[0]?.id !== mind.rootId) return [];
  return crumbs;
}

// ─────────────────────────────────────────────────────────────
// 框选（`N3-h`）：一个矩形框住了哪些行
// ─────────────────────────────────────────────────────────────

/**
 * 一个矩形**框住了哪些行**（用户 2026-09-17："如果框选，可以框选住多行，
 * 实际上会变成选中多个节点"）。
 *
 * ★ **纯函数**（矩形进、id 出）：面板 DOM 只负责把行的矩形量出来 ——
 *   于是"框选判定"能在单测里跑（本仓库不引 jsdom，DOM 相关的判定尽量外推到纯函数）。
 * ★ 判定用**相交**而不是"完全包含"：从行中间划过去也该选上它
 *   （与画布框选、白板框选同一条口径）。
 * ★ 顺序照传进来的顺序（= 面板里的可见顺序）⇒ 选择集的次序与眼睛看到的一致。
 */
export function outlineIdsInBox(boxes: readonly { id: string; rect: Rect }[], box: Rect): string[] {
  return boxes.filter((item) => rectsIntersect(item.rect, box)).map((item) => item.id);
}

/**
 * 这一拖算"**选字**"还是"**框选**"（`N3-h`）。
 *
 * ★ 纯函数（三个数进、布尔出）：**方向定生死** —— **横着**拖 = 选字（选一段文字的自然动作）、
 *   **竖着**拖 / 斜着往下 = 框选（"框住下面几行"就是这么拖的）。
 * ★ 只在**起手落在文字列上**时才需要这个判断；其余落点（竖线格 / 行尾空白 / 面板空白）
 *   本来就没人和我们抢 ⇒ 一律框选。
 * ★ 判据用 `|dx| > |dy|` 而不是角度阈值：斜着拖也能得到一个明确归属，
 *   写角度反而会在 45° 附近抖来抖去。
 * ★ 为什么非要靠方向分：两个手势都从"在某一行上按下去"开始 —— 第一版按**落点**分
 *   （文字列 = 选字、其余 = 框选），用户根本找不到框选（真实报障："现在没有框选机制"）。
 */
export function outlineDragIsText(dx: number, dy: number, startsOnText: boolean): boolean {
  return startsOnText && Math.abs(dx) > Math.abs(dy);
}

// ─────────────────────────────────────────────────────────────
// 拖拽调整结构（`N3-d`）：落点怎么算
// ─────────────────────────────────────────────────────────────

/** 落点的三档：插到这一行**前 / 后**（同级），或**变成它的子节点** */
export type OutlineDropZone = 'before' | 'after' | 'child';

/** 这一拖最终要写成什么（`null` = 落不下去） */
export interface OutlineDropPlan {
  /** 新父节点 */
  parentId: string;
  /** 插到第几个孩子（省略 = 追加到末尾） */
  index?: number;
}

/**
 * 指针落在这一行的哪一档 —— **纯函数**，只吃三个数。
 *
 * ★ 上 28% / 下 28% = 插到这一行前 / 后，中间 44% = 变成它的子节点。
 *   这是各家大纲（Workflowy / 幕布 / 飞书）通行的那套"三段式"，好处是**看提示就知道结果**：
 *   一条横线 = 插在那一行旁边，整行描边 = 装进它肚子里。
 * ★ 用**比例**而不是固定像素：行高会随字号 / 有没有正文预览变，
 *   固定 px 在矮行上会把"中间那一档"整个挤掉。
 */
export function outlineDropZoneOf(top: number, height: number, clientY: number): OutlineDropZone {
  const ratio = height > 0 ? (clientY - top) / height : 0.5;
  if (ratio < 0.28) return 'before';
  if (ratio > 0.72) return 'after';
  return 'child';
}

/**
 * 这一拖会改成什么样 —— **纯函数**，只读模型。
 *
 * ★ 四种落不下去的情况全部在这里挡掉（视图照它画"禁止"的样子）：
 *   ① 拖的东西 / 目标不在（刚被删）、② 目标是它自己、③ 目标是它的**后代**（会成环）、
 *   ④ 拖的是**根** —— 与 `ops.moveNode` 里那几道闸门**同一个口径**
 *   （那边是最后一道，这里只是提前把结果说清楚）。
 * ★ 插到第几个孩子，要**先把"被拖的那一支"从兄弟里剔掉**再数：`moveNode` 内部就是这么算的
 *   （`childrenOf(...).filter(≠ id)`）。这里不跟着剔的话，"往后挪一位"会被算成两位
 *   （`06 §11.46` 记了这个坑，单测里钉着一条）。
 */
export function outlineDropPlanOf(
  mind: MindFile,
  draggingId: string,
  targetId: string,
  zone: OutlineDropZone,
): OutlineDropPlan | null {
  if (!nodeById(mind, draggingId) || !nodeById(mind, targetId)) return null;
  if (isRootNode(mind, draggingId)) return null;
  if (draggingId === targetId) return null;
  if (isDescendant(mind, draggingId, targetId)) return null;

  if (zone === 'child') return { parentId: targetId };

  const parentId = nodeById(mind, targetId)?.parentId ?? null;
  // 大纲里每一行都在**主树**上 ⇒ 目标一定有父（根不是一行）；`parentId === null` 只可能是
  // 悬浮节点，而它本来就不出现在列表里 —— 兜一道，别从这里把"挂到空白"那条路打开
  if (parentId === null) return null;

  const siblings = childrenOf(mind, parentId).filter((item) => item.id !== draggingId);
  const index = siblings.findIndex((item) => item.id === targetId);
  if (index < 0) return null;
  return { parentId, index: zone === 'after' ? index + 1 : index };
}

/** 面板交给视图的回调（`N3-a` 只要两件：折叠一行、点中一行） */
export interface OutlineHandlers {
  /** 点折叠三角 */
  onToggle(id: string): void;
  /**
   * 点正文末尾那枚「展开 / 收起」（`O2`）。
   *
   * ★ 可选：没接这一路时（单测 / 只用面板做别的事）**整枚把手不出现** ——
   *   免得点了一个没有回音的按钮。
   */
  onToggleNote?(id: string): void;
  /**
   * 点这一行。
   *
   * ★ `event` 会一路传到视图，用来把**光标落在用户点到的那个字之间**
   *   （用户 2026-09-17 的第⑤条："感觉就是在一个大文本块中点了一下文字中间"）——
   *   不传的话光标只能落在行尾，"点哪儿改哪儿"就断了。
   */
  onPick(id: string, event: MouseEvent): void;
  /** 双击这一行 = 就地改文本（`N3-b`） */
  onEdit(id: string): void;
  /**
   * 点**行首圆点** = 打开这一行的菜单（照飞书：单击行首圆点打开节点工具栏）。
   *
   * ★ 分工：文字是"内容"、圆点是"结构" —— 于是点圆点不会打断正在输入的那一行。
   */
  /**
   * **这一行的菜单**（`N3-e` 起由**右键**触发；用户 2026-09-17 定的分工：
   * "直接把单击出菜单功能砍掉，单击就进入这一层。至于菜单，右键出现我觉得也可以。"）
   *
   * ★ 挂在**行**上而不是圆点上：文字 / 圆点 / 三角上右键都算（它们都在行里），
   *   而行上的右键**不会**启动拖拽（拖拽只由圆点上的**左键**启动）⇒ 没有指针捕获，
   *   这个 `contextmenu` 照常派发到行上 —— 与"圆点上的 `click` 收不到"正好相反。
   */
  onMenu(id: string, event: MouseEvent): void;
  /**
   * 点**面包屑**（`N3-e`）：`null` = 回到整棵树（退出聚焦）。
   *
   * ★ 面包屑是**这个视图的导航**，所以归面板自己画、由视图决定"点一格意味着什么" ——
   *   面板不碰 `view.focus`（与"面板不碰模型"那条分界一致）。
   */
  onCrumb(id: string | null): void;
}

export interface OutlinePanel {
  readonly element: HTMLElement;
  /**
   * 整块重画（行的数量级很小：一份脑图的节点数）。
   *
   * ★ `title` 是**可选**的（实现里默认空串）：**根节点的文字**在这个视图里是顶上那行标题，
   *   它不属于"任何一行"（没有手柄、也不能就地改），所以单独立在这里。
   */
  render(
    rows: readonly OutlineRow[],
    selected: ReadonlySet<string>,
    handlers: OutlineHandlers,
    title?: string,
    /** **聚焦**时的层级导航（`N3-e`）：`根 → … → 这一支`；空数组 = 没聚焦、不画那条 */
    path?: readonly OutlineCrumb[],
  ): void;
  /**
   * 某一个 id 的**行元素**（就地改文本时往里插输入框；不在了给 `null`）。
   *
   * ★ 用 `MIND_NODE_ID_ATTR` 查：这与画布上"这个元素是谁"用的是**同一个属性**，
   *   于是视图那边查行、查节点是同一套写法，不必再记一套 class 名。
   */
  rowOf(id: string): HTMLElement | null;
  /**
   * 一个矩形**框住了哪些行**（`N3-h` 框选）。
   *
   * ★ 纯判定外推给 `outlineIdsInBox`：面板只负责把行的矩形量出来 —— 于是这条规则
   *   能在单测里跑（本仓库不引 jsdom）。
   * ★ 坐标是**视口坐标**（矩形与行都用 `getBoundingClientRect()`），与滚动无关。
   */
  idsInBox(box: Rect): string[];
  /** 只刷新"哪些行是高亮的"（框选拖动中每帧都调 —— 不能整列重画） */
  setSelection(ids: ReadonlySet<string>): void;
  /**
   * 指针（的纵坐标）底下那一行 + 落在哪一档（`N3-d`）。
   *
   * ★ 拖到列表上下的**空白**处时**夹到最近的一行**（上面 = 第一行的 `before`，
   *   下面 = 最后一行的 `after`）：不然"想把这一支挪到最末尾"得精确压在那最后一行上。
   * ★ 返回 id + 档位，**不返回元素**：视图拿它去算落点（`outlineDropPlanOf`）——
   *   面板自己不碰模型（与"上半个文件是纯逻辑、下半个只管画"同一条分界）。
   */
  dropAt(clientY: number): { targetId: string; zone: OutlineDropZone } | null;
  /** 画 / 收**落点提示**（`null` = 收干净）；`invalid` = 这一拖落不下去（画成"禁止"的样子） */
  setDropHint(hint: { targetId: string; zone: OutlineDropZone; invalid: boolean } | null): void;
  /** 标记**正在被拖的那一行**（`null` = 收掉） */
  setDraggingRow(id: string | null): void;
}

/** 行里那个标题元素的 class（就地改文本时要把它藏起来、换上输入框） */
export const OUTLINE_TITLE_CLASS = 'nestboard-mind-outline-title';
/** 行里"标题 + 正文"那一列（就地改正文的文本域挂在它下面 ⇒ 与标题对齐） */
export const OUTLINE_MAIN_CLASS = 'nestboard-mind-outline-main';
/** 顶上那一行**根标题**的 class（它不是"一行"，没有手柄也不能就地改） */
export const OUTLINE_HEADING_CLASS = 'nestboard-mind-outline-heading';
/**
 * 一行的 class / 行首那两件的 class。
 *
 * ★ 提成常量是因为**视图也要用**：拖拽的 `pointerdown` 是**事件委托**在面板上的
 *   （面板每次 `render` 都换一批行，挂在行上的监听器留不住）——
 *   那边要 `closest('.' + OUTLINE_BULLET_CLASS)` 才找得到抓手。
 */
export const OUTLINE_ROW_CLASS = 'nestboard-mind-outline-row';
export const OUTLINE_BULLET_CLASS = 'nestboard-mind-outline-bullet';
export const OUTLINE_CARET_CLASS = 'nestboard-mind-outline-caret';
/** 顶上那条**层级导航**（`N3-e`；只在聚焦时出现） */
export const OUTLINE_CRUMBS_CLASS = 'nestboard-mind-outline-crumbs';

/**
 * 建大纲面板（`N3-a`）。
 *
 * ★ 行上带 `MIND_NODE_ID_ATTR`（与画布上那些节点元素**同一个属性**）：
 *   视图里的 `nodeIdOfEvent` 于是对大纲也一样好使 —— "点到了谁"只有一处判据，
 *   将来给大纲挂右键菜单、拖放都直接复用。
 * ★ 用 `role="tree"` / `treeitem` + `aria-expanded`：屏幕阅读器能把缩进读成层级，
 *   而这件事**只有 DOM 能表达**（画布那边是靠坐标画出来的）。
 */
export function buildOutlinePanel(doc: Document): OutlinePanel {
  const element = doc.createElement('div');
  element.className = 'nestboard-mind-outline';
  element.tabIndex = 0;
  // ★ 顶上那一行**根标题**（用户 2026-09-17 的第①条）：与列表分开一个元素 ——
  //   它不是"一行"，没有手柄、也不能就地改（"无法直接改根节点"是这视图的规矩）
  const heading = doc.createElement('div');
  heading.className = OUTLINE_HEADING_CLASS;
  // ★ 层级导航（`N3-e`）：只在**聚焦**时出现（没聚焦时它整条 `is-empty` 隐掉）——
  //   放在标题**上面**：先回答"我在哪一支里"，再回答"这一支是什么"（与飞书同序）
  const crumbs = doc.createElement('div');
  crumbs.className = OUTLINE_CRUMBS_CLASS;
  crumbs.setAttribute('aria-label', t('mind.outline.crumbs'));
  const list = doc.createElement('ul');
  list.className = 'nestboard-mind-outline-list';
  list.setAttribute('role', 'tree');
  element.append(crumbs, heading, list);

  const render = (
    rows: readonly OutlineRow[],
    selected: ReadonlySet<string>,
    handlers: OutlineHandlers,
    title = '',
    path: readonly OutlineCrumb[] = [],
  ): void => {
    heading.textContent = title;
    // 根标题为空是合法状态：那种时候别在顶上留一条空白
    heading.classList.toggle('is-empty', title.length === 0);

    // ── 层级导航（`N3-e`）────────────────────────────────
    // 第一格永远是"整棵树"（点它 = 退出聚焦），后面跟着 根 → … → 当前这一支；
    // 最后一格是"你现在就在这儿"，点它没有意义（不可点、`aria-current`）。
    const crumbParts: HTMLElement[] = [];
    if (path.length > 0) {
      crumbParts.push(crumbChip(t('mind.outline.allTree'), () => handlers.onCrumb(null), false));
      const currentId = path[path.length - 1]?.id;
      for (const crumb of path) {
        const separator = doc.createElement('span');
        separator.className = 'nestboard-mind-outline-crumb-sep';
        separator.textContent = '›';
        const isCurrent = crumb.id === currentId;
        crumbParts.push(
          separator,
          crumbChip(crumb.text, () => handlers.onCrumb(crumb.id), isCurrent),
        );
      }
    }
    crumbs.replaceChildren(...crumbParts);
    crumbs.classList.toggle('is-empty', crumbParts.length === 0);
    const parts: HTMLElement[] = [];

    for (const row of rows) {
      const item = doc.createElement('li');
      item.className = OUTLINE_ROW_CLASS;
      item.setAttribute(MIND_NODE_ID_ATTR, row.id);
      item.setAttribute('role', 'treeitem');
      item.classList.toggle('is-selected', selected.has(row.id));
      // 完成（`N3-g`）：两档分开（与画布同一套语义，样式表各画各的）
      item.classList.toggle('is-done', row.done);
      item.classList.toggle('is-done-dim', row.dimmed);
      if (row.collapsed && row.childCount > 0) item.classList.add('is-collapsed');

      const line = doc.createElement('div');
      line.className = 'nestboard-mind-outline-line';

      // ★ **缩进 = 每一级一条竖线**（幕布那份导出件里 `.children::before` 画的就是
      //   一条 1px 竖线，左移 17px）。这里换成"每一级一个 28px 的格子、左边框当线"：
      //   平铺的 `li` 里画不出嵌套的 `::before`，而这样线是**逐行接起来**的 ——
      //   看着与"贯穿整个子级块的一条线"一样，还顺带把缩进也定了（不必再算 padding）
      for (let level = 0; level < row.depth; level += 1) {
        const guide = doc.createElement('span');
        guide.className = 'nestboard-mind-outline-guide';
        line.append(guide);
      }

      // 行首两件（用户 2026-09-17 的第②③条）：`[三角手柄][小圆点]`
      //   * **三角**只在**有子节点**时才建，而且**平时完全不显示** —— 鼠标移到这一行才现身
      //     （样式表按 `.row:hover .caret` 控制），点它 = 折叠 / 展开；
      //   * **小圆点**每行都有，**不可点**（它不是把手）：★ 它身上**没有任何底色 / 外圈**
      //     （用户追加的第 1 条：叶子节点与完全展开的节点上，"小黑点无底，不要包在外圈的那个圆"）
      //     —— "这一行能不能展开"由前面那个三角回答，圆点只承担"这一行的把手"。
      //
      // ★★ 两件都用 `<span role="button" tabindex="-1">`，**不用 `<button>`**（真实报障换来的）：
      //   Obsidian 自带的 `app.css` 里有
      //     `button:not(.clickable-icon) { background-color: var(--interactive-normal); box-shadow: var(--input-shadow) }`
      //     `button:hover { background-color: var(--interactive-hover); … }`
      //   特异性 **(0,1,1) 压过**插件里 `.nestboard-mind-outline-caret` 的 (0,1,0) ⇒ 常态就顶着一层
      //   底色 + 阴影，而它们又是 `border-radius: 50%` ⇒ 看着就是"小黑点包在一个圈里"。
      //   ⇒ 与画布那个折叠手柄（`render.buildHandleElement`）同一个手法：语义给读屏（`role`）、
      //     样式上**根本不被主题的 `button` 规则命中**。
      // ★★ **这一格每一行都有**（有子节点才是手柄，没有就是**占位**）。
      //   从前是"只有有子节点才建"⇒ 一行**刚当上爹**时（`Tab` 缩进 / 拖进来一个孩子 /
      //   新建第一个子节点）会凭空多出 18px ⇒ **整行文字右跳小半格**（真实报障：
      //   "按 tab 键有时会把父节点也一起缩进一点，虽然实际层级没变，但显示上缩进了小半格"
      //   —— "有时"正是"那个目标原本没有孩子"）。
      //   ⇒ 位置**恒定**：有没有孩子都占这 18px，空的时候只是不显形、不接事件。
      //     这也顺手兑现了"叶子行与非叶子行的文字左边界一致"（同一列的圆点/文字对齐）。
      const hasChildren = row.childCount > 0;
      const caret = doc.createElement('span');
      caret.className = hasChildren ? OUTLINE_CARET_CLASS : `${OUTLINE_CARET_CLASS} is-empty`;
      if (hasChildren) {
        caret.setAttribute('role', 'button');
        // 用 `setAttribute` 而不是 `tabIndex = -1`：两者在真 DOM 里等价（那个 IDL 属性是
        // 反射的），但这里写成属性更直白，测试也能直接读到（画布那个手柄就是这么写的）
        caret.setAttribute('tabindex', '-1');
        caret.textContent = row.collapsed ? '▸' : '▾';
        caret.setAttribute('aria-expanded', row.collapsed ? 'false' : 'true');
        caret.setAttribute(
          'aria-label',
          t(row.collapsed ? 'menu.mindExpand' : 'menu.mindCollapse'),
        );
        caret.addEventListener('click', (event) => {
          // 三角是"折这一支"，不是"点这一行" —— 不让它冒泡到行上
          event.stopPropagation();
          handlers.onToggle(row.id);
        });
      }

      // ★ 小圆点不是装饰，是这个节点的**把手**（照飞书）：点它 = 打开这一行的菜单。
      //   语义上仍是按钮（`role` 给读屏），但**不是 `<button>` 元素**（原因见上面那一段：
      //   主题的 `button` 规则会压过我们的类，给它糊上一层底）。
      //   键盘够得着不成问题：整块面板是 `tabIndex = 0`，方向键 / `⏎` 都在那边。
      const bullet = doc.createElement('span');
      bullet.className = OUTLINE_BULLET_CLASS;
      bullet.setAttribute('role', 'button');
      bullet.setAttribute('tabindex', '-1');
      bullet.setAttribute('aria-haspopup', 'menu');
      bullet.setAttribute('aria-label', t('mind.outline.rowMenu'));
      // ★★ 圆点上**刻意不挂 `click` / `dblclick`**（用户 2026-09-17 的最终分工：
      //   **单击圆点 = 进入这一层**、**右键 = 这一行的菜单**）。
      //   为什么不挂 `click`：按在圆点上会启动拖拽（`setPointerCapture` 抓在**面板**上），
      //   而指针一旦被捕获，后续那个 `click` 会被派发到**捕获元素**上 —— 挂在这里的监听器
      //   根本收不到。用户的实测正是这个形状：拖拽好用（pointer 事件）、单击 / 双击全死（click 事件）。
      //   ⇒ 圆点上的一切都在视图的**指针状态机**里判（见 `MindView.onOutlinePointerUp`）。

      const main = doc.createElement('div');
      main.className = 'nestboard-mind-outline-main';

      const head = doc.createElement('div');
      head.className = 'nestboard-mind-outline-head';

      if (row.icon.length > 0) {
        const mark = doc.createElement('span');
        mark.className = 'nestboard-mind-outline-mark';
        mark.textContent = row.icon;
        head.append(mark);
      }

      const title = doc.createElement('span');
      title.className = OUTLINE_TITLE_CLASS;
      title.textContent = row.text;
      title.style.fontSize = `${row.size}px`;
      if (row.bold) title.classList.add('is-bold');
      if (row.italic) title.classList.add('is-italic');
      if (row.underline) title.classList.add('is-underline');
      if (row.ink !== null) title.style.color = row.ink;
      // 文字高亮（`N3-f`）：直接写在标题这一格上 —— 大纲里标题是**行内的一格**，
      // 背景只铺在文字后面（画布那边多一层 `.nestboard-mind-node-title-text` 是
      // 因为回形针与图标也在标题里，两个视图的"文字那一块"因此是同一个概念）
      if (row.highlight !== null) title.style.backgroundColor = row.highlight;
      head.append(title);

      // ★ **行尾不再报数**（用户 2026-09-17 的第 1 条："不要在收起的行后面显示数字"）：
      //   收起与否改由**圆点下面那层底**表达（第 4、5 条），行尾干干净净。
      //   于是这一行的宽度永远只由文字决定，折来折去也不会左右跳。
      main.append(head);

      // 正文（`O2`，用户 2026-09-21："如果有内容，应该全展示，超过一定行，加个折叠"）：
      // 从前是"一行灰字 + 省略号"，现在**按内容折行**；超过 `OUTLINE_NOTE_FOLD_LINES`
      // 行就收起，并在末尾给一枚「展开 / 收起」。
      if (row.note.length > 0) {
        const expanded = row.noteExpanded === true;
        const note = doc.createElement('div');
        note.className = expanded
          ? 'nestboard-mind-outline-note is-expanded'
          : 'nestboard-mind-outline-note';
        note.textContent = row.note;
        main.append(note);

        // ★ 把手只在"正文真的可能超长"、且视图愿意接这一路时才建（见 `noteFoldNeeded`）
        if (noteFoldNeeded(row.note) && handlers.onToggleNote) {
          const more = doc.createElement('span');
          more.className = 'nestboard-mind-outline-note-more';
          more.setAttribute('role', 'button');
          more.setAttribute('tabindex', '-1');
          more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          more.textContent = t(expanded ? 'menu.mindCollapse' : 'menu.mindExpand');
          more.addEventListener('click', (event) => {
            // 这一下是"折 / 展正文"，不是"点这一行"（不拦的话会顺手进编辑）
            event.stopPropagation();
            handlers.onToggleNote?.(row.id);
          });
          main.append(more);
        }
      }

      // 顺序就是眼睛看到的顺序：竖线格 → 三角手柄（含占位）→ 小圆点 → 标题（+ 正文）
      line.append(caret, bullet, main);
      item.append(line);

      item.addEventListener('click', (event) => handlers.onPick(row.id, event));
      item.addEventListener('dblclick', () => handlers.onEdit(row.id));
      // ★ **右键 = 这一行的菜单**（`N3-e` 起菜单从这里出；单击已经让给"进入这一层"）。
      //   挂在**行**上：文字 / 圆点 / 三角上右键都算 —— 而右键**不会**启动拖拽
      //   （拖拽只认圆点上的左键）⇒ 没有指针捕获，这个事件照常派发到行上
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        handlers.onMenu(row.id, event);
      });
      parts.push(item);
    }

    list.replaceChildren(...parts);
  };

  const rowOf = (id: string): HTMLElement | null =>
    element.querySelector<HTMLElement>(`[${MIND_NODE_ID_ATTR}="${id}"]`);

  // ── 框选（`N3-h`）────────────────────────────────────

  const rowBoxes = (): { id: string; rect: Rect }[] => {
    const boxes: { id: string; rect: Rect }[] = [];
    for (const row of rowsIn()) {
      const id = row.getAttribute(MIND_NODE_ID_ATTR);
      if (!id) continue;
      const rect = row.getBoundingClientRect();
      boxes.push({
        id,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
    }
    return boxes;
  };

  const idsInBox = (box: Rect): string[] => outlineIdsInBox(rowBoxes(), box);

  const setSelection = (ids: ReadonlySet<string>): void => {
    for (const row of rowsIn()) {
      const id = row.getAttribute(MIND_NODE_ID_ATTR);
      row.classList.toggle('is-selected', id !== null && ids.has(id));
    }
  };

  /**
   * 面包屑里的一格（`N3-e`）。
   *
   * ★ 与行首圆点同一个手法：`<span role="button" tabindex="-1">` 而**不是 `<button>`**
   *   （Obsidian 自带的 `button` 规则会给它糊上一层底色，见样式表那段说明）；
   * ★ 空的标题给一个占位（"（无标题）"）：空白的一格点不下去，看着像坏了。
   */
  const crumbChip = (text: string, onPick: () => void, isCurrent: boolean): HTMLElement => {
    const chip = doc.createElement('span');
    chip.className = 'nestboard-mind-outline-crumb';
    chip.textContent = text.length > 0 ? text : t('mind.outline.untitled');
    if (isCurrent) {
      chip.classList.add('is-current');
      chip.setAttribute('aria-current', 'true');
      return chip;
    }
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '-1');
    chip.addEventListener('click', (event) => {
      // 点导航不是"点这一行"（不让它冒泡到行上）
      event.stopPropagation();
      onPick();
    });
    return chip;
  };

  // ── 拖拽的落点（`N3-d`）──────────────────────────────────

  /** 面板里现在画着的行（顺序 = 看得见的顺序；每次都现查 —— `render` 会整批换掉） */
  const rowsIn = (): HTMLElement[] => [
    ...element.querySelectorAll<HTMLElement>(`.${OUTLINE_ROW_CLASS}`),
  ];

  const dropAt = (clientY: number): { targetId: string; zone: OutlineDropZone } | null => {
    const rows = rowsIn();
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return null;

    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const id = row.getAttribute(MIND_NODE_ID_ATTR);
      if (id) return { targetId: id, zone: outlineDropZoneOf(rect.top, rect.height, clientY) };
    }

    // 落在行**之外**的空白上 ⇒ 夹到最近的那一头（上 = 第一行之前，下 = 最后一行之后）
    const above = clientY < first.getBoundingClientRect().top;
    const edge = above ? first : last;
    const id = edge.getAttribute(MIND_NODE_ID_ATTR);
    return id ? { targetId: id, zone: above ? 'before' : 'after' } : null;
  };

  const setDropHint = (
    hint: { targetId: string; zone: OutlineDropZone; invalid: boolean } | null,
  ): void => {
    const targetId = hint?.targetId ?? null;
    const zone = hint?.zone;
    const invalid = hint?.invalid === true;

    for (const row of rowsIn()) {
      const hit = targetId !== null && row.getAttribute(MIND_NODE_ID_ATTR) === targetId;
      row.classList.toggle('is-drop-invalid', hit && invalid);
      // ★ 落不下去时**不画**那三档："插到这儿"与"落不下去"同时出现会互相打脸
      row.classList.toggle('is-drop-before', hit && !invalid && zone === 'before');
      row.classList.toggle('is-drop-after', hit && !invalid && zone === 'after');
      row.classList.toggle('is-drop-into', hit && !invalid && zone === 'child');
    }
  };

  const setDraggingRow = (id: string | null): void => {
    for (const row of rowsIn()) {
      row.classList.toggle(
        'is-dragging',
        id !== null && row.getAttribute(MIND_NODE_ID_ATTR) === id,
      );
    }
  };

  return { element, render, rowOf, idsInBox, setSelection, dropAt, setDropHint, setDraggingRow };
}
