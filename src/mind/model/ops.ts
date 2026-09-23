/**
 * 脑图的**树操作**（`06 §4.1`）—— 纯函数：进模型，出"改没改"。
 *
 * 视图的每一个编辑动作（`Tab` 加子节点 / `Enter` 加兄弟 / `Shift+Tab` 提升 / 删除 /
 * 拖拽改父 / `⌘A` 多选后的整簇操作）都落在这里的一个函数上，
 * 视图只负责"键位 → 调用哪一个"与"改完重画"。
 *
 * ── 三条纪律 ────────────────────────────────────────────────
 *
 * 1. **返回 `boolean` 表示"真的改了没有"**：`MindRepository.mutate` 靠它决定要不要
 *    递增 revision、标脏、排盘（`mutator` 返回 `false` 时整条链都跳过）。所以"什么都没做"
 *    必须诚实地返回 `false` —— 谎报的代价是撤销栈里多出一格"什么都没变"的空档。
 * 2. **兄弟次序永远连续**（`0..n-1`）：增删之后立刻重排，与 `validate` 的归一化同一口径。
 *    留着空洞不会立刻出错，但会让 `order` 的含义慢慢变成"随便一个数"。
 * 3. **根节点不可删、不可提升、不可挂到别人下面**（`06 §1` 第 9 条）：这几条是**兜底**，
 *    交互层（键位、菜单）已经先挡了一道。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM，可以直接单测。
 */

import { ID_PREFIX } from '../../constants';
import { createId } from '../../util/id';
import { normalizeIcon } from '../../util/emoji';
import type { Point } from '../../util/geometry';
import type { CardColor, HexColor, ThemeColor } from '../../model/schema';
import { MIND_IMAGE_MAX_WIDTH, MIND_IMAGE_MIN_WIDTH, sameRefs } from './refs';
import type { MindFile, MindLink, MindNode, MindNodeStyle, MindRef } from './schema';
import { normalizeLinkBend } from './schema';
import type { LinkBend } from './schema';

// ─────────────────────────────────────────────────────────────
// 查询（都是只读的，视图与布局都要用）
// ─────────────────────────────────────────────────────────────

export function nodeById(mind: MindFile, id: string): MindNode | null {
  return mind.nodes.find((node) => node.id === id) ?? null;
}

export function isRootNode(mind: MindFile, id: string): boolean {
  return mind.rootId === id;
}

/**
 * 某一层的孩子，按 `order` 排（再按 id 破平）。
 *
 * ★ `parentId === null` 取到的是"根 + 全部悬浮节点"这一层 —— 它们同属一个次序组
 *   （`validate` 的 `normalizeOrder` 就是这么分的）。
 */
export function childrenOf(mind: MindFile, parentId: string | null): MindNode[] {
  return mind.nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

export function parentOf(mind: MindFile, id: string): MindNode | null {
  const node = nodeById(mind, id);
  if (!node || node.parentId === null) return null;
  return nodeById(mind, node.parentId);
}

export function siblingIds(mind: MindFile, id: string): string[] {
  const node = nodeById(mind, id);
  if (!node) return [];
  return childrenOf(mind, node.parentId).map((item) => item.id);
}

/** 根 = 0；悬浮节点也是 0（它不是任何人的孩子） */
/**
 * 祖先里有**完成**节点的那些节点 id（`N3-g`）。
 *
 * ★ 语义：**只有"自己完成"写在那一位上**，祖先完成只是让子孙"看起来"属于那一支 ——
 *   画布、SVG 导出、PNG 导出三处都靠这一份判断（各写一遍的话，导出图与屏幕上
 *   就会出现"这一支淡了、那一处没淡"的两套样子）。
 * ★ 纯查询：不改模型，可以在任何一侧调用。
 */
export function dimmedByDoneAncestor(file: MindFile): Set<string> {
  const byId = new Map<string, MindNode>();
  for (const node of file.nodes) byId.set(node.id, node);

  const dimmed = new Set<string>();
  for (const node of file.nodes) {
    let cursor = node.parentId === null ? null : (byId.get(node.parentId) ?? null);
    // 上限只是个护栏：文件被手改坏成环时不要在这里转不出来
    let guard = 0;
    while (cursor && guard < 512) {
      if (cursor.done === true && node.done !== true) {
        dimmed.add(node.id);
        break;
      }
      cursor = cursor.parentId === null ? null : (byId.get(cursor.parentId) ?? null);
      guard += 1;
    }
  }
  return dimmed;
}

export function depthOf(mind: MindFile, id: string): number {
  let depth = 0;
  let cursor = parentOf(mind, id);
  // 上限只是个保险：`validate` 保证无环，但这里不该因为一份坏数据把主线程转死
  while (cursor && depth < mind.nodes.length) {
    depth += 1;
    cursor = parentOf(mind, cursor.id);
  }
  return depth;
}

/** 自己 + 全部后代（含被折叠藏起来的 —— 它们仍在文件里） */
export function subtreeIds(mind: MindFile, id: string): Set<string> {
  const ids = new Set<string>();
  const walk = (nodeId: string): void => {
    if (ids.has(nodeId)) return;
    ids.add(nodeId);
    for (const child of mind.nodes) {
      if (child.parentId === nodeId) walk(child.id);
    }
  };
  walk(id);
  return ids;
}

/** `maybe` 是不是 `ancestor` 的后代（拖拽时防环要用它） */
export function isDescendant(mind: MindFile, ancestorId: string, maybeId: string): boolean {
  if (ancestorId === maybeId) return false;
  let cursor = nodeById(mind, maybeId)?.parentId ?? null;
  let guard = 0;
  while (cursor && guard <= mind.nodes.length) {
    if (cursor === ancestorId) return true;
    cursor = nodeById(mind, cursor)?.parentId ?? null;
    guard += 1;
  }
  return false;
}

/**
 * **可见顺序**（前序遍历，折叠的子树跳过；悬浮节点的子树接在主树之后）。
 *
 * ★ 键盘导航（`↑` `↓`）走的就是这一份顺序：用户心里的"下一个"是**眼前能看见的下一个**，
 *   而不是文件里的数组顺序。
 */
export function visibleIds(mind: MindFile): string[] {
  const root = nodeById(mind, mind.rootId);
  if (!root) return [];

  const out: string[] = [];
  const walk = (node: MindNode): void => {
    out.push(node.id);
    if (node.collapsed === true) return;
    for (const child of childrenOf(mind, node.id)) walk(child);
  };
  walk(root);
  // 悬浮节点（含它们的子树）排在主树之后：它们没有"在哪个分支下"的位置，
  // 但用户按 ↓ 一路走到底时也该走到它们
  for (const free of childrenOf(mind, null)) {
    if (free.id !== root.id) walk(free);
  }
  return out;
}

/**
 * 每个节点的**整支总数**（子孙总数，**不含自己**）。
 *
 * ★ 一次遍历算全表：折叠手柄每次重画都要读它（`MindView.paintHandles`），
 *   逐节点递归会变成 O(n²) —— 而 `paint` 是**每帧**都可能跑的（拖动相机时）。
 * ★ 不含自己：手柄写在圆圈里的是"这一支里藏了多少个"，而按下手柄的那张卡
 *   本来就摆在眼前（含自己的话，任何节点收起来至少显示 1，反而读不出信息）。
 * ★ 悬浮节点的子树也算（它们不在根的子树里，得单独走一遍）。
 */
export function subtreeSizes(mind: MindFile): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const node of mind.nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node.id);
    else children.set(node.parentId, [node.id]);
  }

  const sizes = new Map<string, number>();
  const walk = (id: string): number => {
    if (sizes.has(id)) return sizes.get(id) ?? 0;
    let total = 0;
    for (const child of children.get(id) ?? []) total += 1 + walk(child);
    sizes.set(id, total);
    return total;
  };

  walk(mind.rootId);
  for (const node of mind.nodes) {
    if (node.parentId === null) walk(node.id);
  }
  return sizes;
}

/** 可见顺序里的前一个 / 后一个 */
export function nextVisibleId(mind: MindFile, id: string, step: 1 | -1): string | null {
  const order = visibleIds(mind);
  const index = order.indexOf(id);
  if (index < 0) return null;
  return order[index + step] ?? null;
}

/**
 * `←` / `→` 的落点（`06 §4.1`）。
 *
 * ★ 按**展开方向**判：挂在右边的那一支，`→` 往孩子走、`←` 往父走；挂在左边的镜像。
 *   不这么做的话，左侧那一支按 `→` 会往父节点跑，手感是反的。
 */
export function horizontalTargetId(
  mind: MindFile,
  id: string,
  direction: -1 | 1,
  side: -1 | 0 | 1,
): string | null {
  // 根与悬浮节点（`side === 0`）按"孩子在右"处理，与布局的默认观感一致
  const rightward = side !== -1 ? direction === 1 : direction === -1;
  if (rightward) {
    return childrenOf(mind, id)[0]?.id ?? null;
  }
  return parentOf(mind, id)?.id ?? null;
}

/**
 * 方向键的**落点**（`06 §4.1`）—— 箭头跟着轴走。
 *
 * * **横向布局**（向右 / 向左 / 八爪鱼）：**上下**走**可见顺序**（深度优先的下一行 —— 它可能是
 *   孩子，也可能真是兄弟，与"看到的就是这个次序"对齐），**左右**往父 / 孩子走；
 * * **纵向布局**（组织结构图）：两级关系长在 **y** 上、可见顺序铺在 **x** 上 ⇒ 上下与左右**互换** ——
 *   不换的话按"下"会跑到兄弟那儿、按"右"什么都不发生，用户只会觉得方向键坏了；
 * * `side < 0`（孩子挂在**左边**的那一支）：左右镜像（见 {@link horizontalTargetId}）。
 *
 * ★ 抽成纯函数并且**两个宿主共用**（`.nestmind` 视图与白板上的脑图，`2.2.0` 收尾 ·
 *   用户 2026-09-23："nestmind 里面的操作搬过来就行"）：两处各写一份的话，"同一个方向键在
 *   两个宿主上意思不一样"迟早发生，而且只在其中一边复现（最难查的那一类）。
 *
 * ★ 判据全在模型上（可见顺序 / 父子关系），**不碰布局** —— 纵向那一档靠调用方递进来的
 *   `vertical`，而"孩子在左还是在右"靠 `side`（视图从布局里取，见 `MindLayer.sideOf`）。
 */
export function neighborByArrow(
  mind: MindFile,
  id: string,
  direction: 'up' | 'down' | 'left' | 'right',
  options: { vertical?: boolean; side?: -1 | 0 | 1 } = {},
): string | null {
  const vertical = options.vertical === true;
  // 兄弟轴：横向布局按上下，纵向布局按左右（见上面那条"互换"）
  const siblingStep: 1 | -1 | null = vertical
    ? direction === 'right'
      ? 1
      : direction === 'left'
        ? -1
        : null
    : direction === 'down'
      ? 1
      : direction === 'up'
        ? -1
        : null;
  if (siblingStep !== null) return nextVisibleId(mind, id, siblingStep);

  // `+1` = 朝孩子那一侧，`-1` = 朝父节点那一侧（`side` 告诉它孩子长在哪边）
  const along: 1 | -1 = vertical ? (direction === 'down' ? 1 : -1) : direction === 'right' ? 1 : -1;
  return horizontalTargetId(mind, id, along, options.side ?? 0);
}

// ─────────────────────────────────────────────────────────────
// 多选（`06 §4.1` 的 `⌘A` / `⇧`+点击，P3-c）
// ─────────────────────────────────────────────────────────────

/** 把选区收干净：不存在的 id（刚被删掉 / 撤销撤掉）一律剔除 */
export function sanitizeSelection(mind: MindFile, ids: ReadonlySet<string>): Set<string> {
  const clean = new Set<string>();
  for (const id of ids) {
    if (nodeById(mind, id)) clean.add(id);
  }
  return clean;
}

/**
 * 选区的"入口"：把**祖先也在选区里**的节点剔掉，返回剩下的（按可见顺序排）。
 *
 * ── 为什么每次操作都要先问这一句 ────────────────────────────
 *
 * 同时选中"甲 + 甲一"时，用户想做的是**一件事**：删掉这一支，而不是"删甲、再删甲一"
 * （后者那时候已经不存在了）。同理，把这一簇拖走时只有"甲"需要换父 —— 甲一跟着走。
 *
 * ★ 排序用可见顺序而不是 `Set` 的插入顺序：拖到别处时"谁在前面"应当由**用户看到的样子**
 *   决定（`Set` 的顺序取决于点选的先后，那与画面无关）。
 * ★ 藏着（折叠里）的选中节点**照样算**：它们是选区的一部分，只是此刻看不见。
 * ★ **根节点不当"吞掉别人的祖先"**：它是整张图的祖先，要是它算数，
 *   `⌘A`（必然包含根）之后选区就只剩根一个 —— 删也删不掉、挪也挪不动，
 *   "全选再删除"这条最常用的路会直接失灵（这个坑测试逮到过一次）。
 *   根自己仍在返回值里（如果它被选中），怎么处置由调用方决定：
 *   `removeNodes` / `moveNodes` 会跳过它，`copyForest` 则只复制它那一支。
 */
/**
 * 一个节点**连同它的后代**（子树），按**原来的顺序**（父在前、兄弟按 `order`）。
 *
 * ★ 顺序必须保持（`2.2.0` · O6）：布局按 `order` 摆兄弟，打乱了复出来的那棵树就歪。
 * ★ 节点对象是**原样引用**（浅拷贝由调用方决定）：本函数只回答"有哪些节点"。
 */
export function subtreeOf(mind: MindFile, rootId: string): MindNode[] | null {
  const root = mind.nodes.find((node) => node.id === rootId);
  if (!root) return null;

  const childrenOf = new Map<string | null, MindNode[]>();
  for (const node of mind.nodes) {
    const bucket = childrenOf.get(node.parentId) ?? [];
    bucket.push(node);
    childrenOf.set(node.parentId, bucket);
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const result: MindNode[] = [];
  const walk = (node: MindNode): void => {
    result.push(node);
    for (const child of childrenOf.get(node.id) ?? []) walk(child);
  };
  walk(root);
  return result;
}

export function selectionRoots(mind: MindFile, ids: ReadonlySet<string>): string[] {
  const selected = sanitizeSelection(mind, ids);
  if (selected.size === 0) return [];

  const roots = new Set(selected);
  for (const id of selected) {
    for (const other of selected) {
      if (other === id || other === mind.rootId) continue;
      // 只要有任何一个祖先也被选中，这个节点就不是"入口"
      if (isDescendant(mind, other, id)) {
        roots.delete(id);
        break;
      }
    }
  }

  const rank = new Map(visibleIds(mind).map((id, index) => [id, index]));
  return [...roots].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}

// ─────────────────────────────────────────────────────────────
// 改字段
// ─────────────────────────────────────────────────────────────

export function setText(mind: MindFile, id: string, text: string): boolean {
  const node = nodeById(mind, id);
  if (!node || node.text === text) return false;
  node.text = text;
  return true;
}

export function setNote(mind: MindFile, id: string, note: string): boolean {
  const node = nodeById(mind, id);
  if (!node || node.note === note) return false;
  node.note = note;
  return true;
}

/**
 * 写节点标记（一个 emoji，`08 §3.1`）。
 *
 * ★ 传空串 = **摘掉标记** ⇒ 删掉这个键（纪律 2：缺席即"没有标记"，不留空串）。
 * ★ 归一化走 `util/emoji.ts` 的 `normalizeIcon`（与白板卡片共用一份）：写进来的
 *   与读回来的必须是同一个东西，两处各写一份迟早不是一个。
 * ★ 值没变返回 `false`：不写盘、不占撤销栈。
 */
export function setIcon(mind: MindFile, id: string, icon: string): boolean {
  const node = nodeById(mind, id);
  if (!node) return false;

  const next = normalizeIcon(icon);
  if ((node.icon ?? '') === next) return false;
  if (next.length === 0) delete node.icon;
  else node.icon = next;
  return true;
}

/** 快捷操作栏能改的那几项（`08 §3.2` / `§3.3`）；字段**缺席 = 这一项不动** */
export interface MindStylePatch {
  /** 主色（标题底色）；`null` = 回到层级默认 */
  color?: CardColor | null;
  /** 标题**字色**；`null` = 回到"按底色对比度推" */
  ink?: HexColor | null;
  /** 标题**文字背后的高亮色**（`N3-f`）；`null` = 去掉高亮 */
  highlight?: HexColor | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/**
 * 改节点的**外观**（快捷操作栏那一排按钮的唯一入口）。
 *
 * ★ 一个入口而不是五个 setter：每个都牵涉"值为缺省时删键"与"`style` 空了就连它一起删"
 *   这两条纪律，五处各写一遍迟早漏一处 —— 漏掉的那处会让文件里留下 `"style":{}` 这种噪声。
 * ★ 删键的判据分两档：`color` / `ink` / `italic` / `underline` 的缺省是**常量**
 *   （无主色 / 由对比度推 / 不斜不加线）⇒ 传 `null` / `false` 就删键；
 *   `bold` 的缺省**取决于层级**（根是加粗的）⇒ `false` 是有意义的值、**留住它**。
 * ★ 值没变返回 `false`：不写盘、不占撤销栈。
 */
export function setNodeStyle(mind: MindFile, id: string, patch: MindStylePatch): boolean {
  return setNodeStyles(mind, [id], patch);
}

/**
 * **批量**改一批节点的外观（`N2`：框选多个节点统一改底色 / 字色 / 粗斜下划线）。
 *
 * ★ 逐条走与单选**完全同一套**删键纪律（`applyStylePatch` 一处实现）——
 *   批量版本要是自己再写一遍"什么时候删键"，迟早两边不一样。
 * ★ 只要有一条真的改了就给 `true`（调用方据此记一步 `⌘Z`）：**一次操作一步撤销**，
 *   而不是"改了 5 个节点留 5 条历史"。
 */
export function setNodeStyles(
  mind: MindFile,
  ids: readonly string[],
  patch: MindStylePatch,
): boolean {
  let changed = false;
  for (const id of ids) {
    if (applyStylePatch(mind, id, patch)) changed = true;
  }
  return changed;
}

/** 单个节点的那套删键纪律（`setNodeStyle` 与 `setNodeStyles` 共用） */
function applyStylePatch(mind: MindFile, id: string, patch: MindStylePatch): boolean {
  const node = nodeById(mind, id);
  if (!node) return false;

  const style: MindNodeStyle = { ...(node.style ?? {}) };
  const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);
  let changed = false;

  if (patch.color !== undefined && !same(patch.color, node.style?.color)) {
    if (patch.color === null) delete style.color;
    else style.color = patch.color;
    changed = true;
  }
  // 高亮（`N3-f`）：缺省是"没有高亮"这个**常量** ⇒ 传 `null` 就删键（与 `ink` 同一条）
  if (patch.highlight !== undefined && !same(patch.highlight, node.style?.highlight)) {
    if (patch.highlight === null) delete style.highlight;
    else style.highlight = patch.highlight;
    changed = true;
  }
  if (patch.ink !== undefined && !same(patch.ink, node.style?.ink)) {
    if (patch.ink === null) delete style.ink;
    else style.ink = patch.ink;
    changed = true;
  }
  for (const key of ['bold', 'italic', 'underline'] as const) {
    const value = patch[key];
    if (value === undefined || same(value, node.style?.[key])) continue;
    if (value === false && key !== 'bold') delete style[key];
    else style[key] = value;
    changed = true;
  }

  if (!changed) return false;
  if (Object.keys(style).length === 0) delete node.style;
  else node.style = style;
  return true;
}

/**
 * 折叠 / 展开。
 *
 * ★ `collapsed` 是**可选键**（`06 §3` 纪律 2）：收起时写 `true`，展开时**删掉这个键** ——
 *   写 `false` 会让"读一遍写回去逐字节不变"多出一堆噪声键。
 */
export function setCollapsed(mind: MindFile, id: string, collapsed: boolean): boolean {
  const node = nodeById(mind, id);
  if (!node) return false;
  const current = node.collapsed === true;
  if (current === collapsed) return false;

  if (collapsed) node.collapsed = true;
  else delete node.collapsed;
  return true;
}

/** 有没有孩子可折（折叠空节点没有意义，键位会先问这一句） */
export function hasChildren(mind: MindFile, id: string): boolean {
  return mind.nodes.some((node) => node.parentId === id);
}

/**
 * 完成 / 取消完成（`N3-g`）。
 *
 * ★ 与 `setCollapsed` 逐条同构：可选键、值没变给 `false`、取消时**删键**（纪律 2）。
 * ★ 只改**这一个节点**：它下面的子孙一位都不动 —— "整支变淡"是渲染层看出来的
 *   （见 `render.ts` 的 `is-done-dim`），不是把每个子孙都标一遍。
 *   ⇒ 撤销也因此是干净的一步："取消完成"不会把子孙里本来完成过的那些弄丢。
 */
export function setDone(mind: MindFile, id: string, done: boolean): boolean {
  const node = nodeById(mind, id);
  if (!node) return false;
  const current = node.done === true;
  if (current === done) return false;

  if (done) node.done = true;
  else delete node.done;
  return true;
}

/**
 * 删掉这个节点，**但把它的子节点留下**（用户规格第 8 条里那两种删法中的一种）。
 *
 * ★ 子节点挂到它的父下、接在**它原来的位置**上（不是追加到末尾）——
 *   否则"删掉中间那一层"会把下面的顺序打乱，用户还得再整理一遍。
 * ★ 根与悬浮节点不给删：根删了就不是脑图了（`06 §1` 第 9 条），
 *   悬浮节点没有"父"可接。
 * ★ 次序随后由这一层重新编号归一（`0..n-1` 连续）。
 */
export function removeNodeKeepChildren(mind: MindFile, id: string): boolean {
  const node = nodeById(mind, id);
  if (!node || node.parentId === null) return false;

  const parentId = node.parentId;
  const children = childrenOf(mind, id);
  const index = childrenOf(mind, parentId).findIndex((item) => item.id === id);

  mind.nodes = mind.nodes.filter((item) => item.id !== id);
  for (const child of children) child.parentId = parentId;

  // 按"原来的那一层 + 被删位置"重排次序：留下的孩子插回它原来的地方
  const promoted = new Set(children.map((child) => child.id));
  const rest = childrenOf(mind, parentId).filter((item) => !promoted.has(item.id));
  let order = 0;
  for (const item of rest.slice(0, index)) item.order = order++;
  for (const child of children) child.order = order++;
  for (const item of rest.slice(index)) item.order = order++;
  return true;
}

/**
 * **折叠所有** / **展开所有**（用户 2026-09-17 参考飞书思维笔记补的）。
 *
 * ★ 飞书的"折叠所有节点"折完之后**只留中心节点和第一层子节点** —— 所以这里不是
 *   "把每一层都折上"，而是**把第 `keepDepth` 层及更深的、有孩子的节点折起来**：
 *   传入 `keepDepth = 1` 时，根与第一层照常展开，第一层下面的全部收起来。
 * ★ 没有孩子的节点不动（折了也没有可见的效果，却会白白写一个键）。
 * ★ 值没变给 `false`：不写盘、不占撤销栈（与 `setCollapsed` 同一条）。
 */
export function setCollapsedFromDepth(
  mind: MindFile,
  keepDepth: number,
  collapsed: boolean,
): boolean {
  let changed = false;
  for (const node of mind.nodes) {
    if (!hasChildren(mind, node.id)) continue;
    // 浅的那几层在"折叠所有"时不折（飞书：中心 + 第一层留着）
    if (collapsed && depthOf(mind, node.id) < keepDepth) continue;
    if (collapsed) {
      if (node.collapsed === true) continue;
      node.collapsed = true;
    } else {
      if (node.collapsed !== true) continue;
      delete node.collapsed;
    }
    changed = true;
  }
  return changed;
}

/**
 * 整批替换节点上的**引用**（`B`：拖进来的文件 / 图片 / 笔记）。
 *
 * ★ 内容一模一样时返回 `false`：`edit()` 那边据此不写盘、不占撤销栈
 *   （与 `setText` / `setCollapsed` 同一条纪律）。
 * ★ 去重与 `kind` 的推导在 `refs.ts`（那边是纯函数、单独测）；这里只管写进去。
 */
export function setRefs(mind: MindFile, id: string, refs: readonly MindRef[]): boolean {
  const node = nodeById(mind, id);
  if (!node) return false;
  if (sameRefs(node.refs, refs)) return false;

  if (refs.length === 0) {
    // 纪律 2：可选键**缺席就不补** —— 摘空了就删掉这个键，而不是留一个空数组
    delete node.refs;
    return true;
  }
  node.refs = refs.map((ref) => ({ ...ref }));
  return true;
}

/**
 * 摘掉一条引用。
 *
 * ★ 界面上"删除附件"将来放在**右键菜单**里（`06 §4.1`），所以这个函数暂时没有调用方 ——
 *   留着它是为了让那一步只差一个菜单项，而不是还要再想一遍"按什么摘"。
 * ★ 按**路径**摘而不是按下标：下标会随着别的操作变，而"摘掉那个文件"是用户看得见的事实。
 */
export function removeRef(mind: MindFile, id: string, path: string): boolean {
  const node = nodeById(mind, id);
  const refs = node?.refs;
  if (!node || !refs) return false;
  const next = refs.filter((ref) => ref.path !== path);
  if (next.length === refs.length) return false;
  return setRefs(mind, id, next);
}

/**
 * 改**图片附件**的显示宽度（拖四个角定下来的那个数）。
 *
 * ★ 宽度会被夹进 `MIND_IMAGE_MIN_WIDTH` ~ `MIND_IMAGE_MAX_WIDTH`：下限太小看不清、
 *   上限太大一张图能占满整屏（夹在**写入处**而不是渲染处 —— 落盘的数字才可信）。
 * ★ 不是图片的引用不写宽度（写了也没人看，还会让文件里出现无意义的键）。
 * ★ 值没变（夹完还是原值）返回 `false`：不写盘、不占撤销栈。
 */
export function setRefWidth(mind: MindFile, id: string, width: number): boolean {
  const node = nodeById(mind, id);
  const ref = node?.refs?.[0];
  if (!node || !ref || ref.kind !== 'image') return false;

  const clamped = Math.round(Math.min(MIND_IMAGE_MAX_WIDTH, Math.max(MIND_IMAGE_MIN_WIDTH, width)));
  if (ref.width === clamped) return false;
  ref.width = clamped;
  return true;
}

// ─────────────────────────────────────────────────────────────
// 增
// ─────────────────────────────────────────────────────────────

/** 把一个新节点追加到某个父节点下（返回新节点 id） */
export function addChild(
  mind: MindFile,
  parentId: string,
  options: { index?: number } = {},
): string | null {
  const parent = nodeById(mind, parentId);
  if (!parent) return null;

  const siblings = childrenOf(mind, parentId);
  // `index` 省略 = 追加到末尾（老行为，落盘的 `order` 也是老写法，不动）；
  // 给了 `index` = 插到第几个孩子（`0` = 变成**第一个**子节点 —— `N3-i` 的幕布规则②要用）
  const at =
    options.index === undefined
      ? siblings.length
      : Math.max(0, Math.min(siblings.length, Math.round(options.index)));
  const anchor = siblings[at];
  const node: MindNode = {
    id: createId(ID_PREFIX.mindNode),
    text: '',
    note: '',
    parentId,
    order: anchor ? anchor.order - 0.5 : siblings.length,
  };
  mind.nodes.push(node);
  // 插在中间 / 开头才需要把次序重排成整数（追加那条与从前字节一致）
  if (anchor) renumberSiblings(mind, parentId);
  return node.id;
}

/**
 * 在某个节点后面加一个兄弟节点。
 *
 * ★ 根节点上 = 加一个**子节点**（`XMind` 同一条）：根没有兄弟，"在根后面加一个兄弟"
 *   在数据结构上就是把整个图变成森林 —— 那不是用户按 `Enter` 想要的东西。
 * ★ 悬浮节点同理（它没有兄弟）：加子节点。
 */
export function addSibling(mind: MindFile, id: string): string | null {
  const node = nodeById(mind, id);
  if (!node) return null;
  if (node.parentId === null) return addChild(mind, id);

  const created: MindNode = {
    id: createId(ID_PREFIX.mindNode),
    text: '',
    note: '',
    parentId: node.parentId,
    order: node.order + 0.5, // 先插到中间，随后统一重排成整数
  };
  mind.nodes.push(created);
  renumberSiblings(mind, node.parentId);
  return created.id;
}

/**
 * **回车拆行**（`N3-i`，用户 2026-09-17）：把这一行的文字按光标切成两半。
 *
 * 用户原话："以光标之前的文字为一个节点，以光标之后的文字为原节点（子节点都跟随这个节点）"。
 * 于是拆完是 `[前半截的新兄弟]` + `[原节点（后半截文字 + 它原来的子节点）]` ——
 * **顺序**照读到的文字来（前半截在前），**子节点**照原话留给原节点。
 *
 * ★★ **调用方必须先把编辑器里的草稿写回模型**（`setText`）：编辑器不是实时落盘的
 *   （`input` 只驱动影子与重排），而这个操作会把编辑器拆掉重建 ⇒
 *   不先写回去，用户刚敲的字就没了。
 * @param index 光标位置（按字符计；越界会夹进 `[0, text.length]`）
 * @returns **接着该编辑哪一个节点**；`null` = 根 / 节点不在（没什么可拆的）
 *   * 光标在**文字中间** ⇒ 还是**原节点**（调用方把编辑器落在它后半截的最前面）；
 *   * 光标在**末尾**（或这行本来就是空的）⇒ "后半截"没有文字；这时若照字面把空文字塞回
 *     原节点，用户接着打字就会**莫名当上原来那些子节点的爹** ⇒ 这一档**退化成
 *     "新建一个空兄弟"**（Workflowy 的手感），返回的也是那个新节点。
 */
export function splitNodeAt(mind: MindFile, id: string, index: number): string | null {
  if (isRootNode(mind, id)) return null;
  const node = nodeById(mind, id);
  if (!node) return null;

  const text = node.text;
  const at = Math.max(0, Math.min(text.length, Math.round(index)));
  const before = text.slice(0, at);
  const after = text.slice(at);

  // 光标在末尾 / 空行：没有"后半截"可留 ⇒ 走幕布那三条（`enterAtEnd`）
  if (after.length === 0) return enterAtEnd(mind, id);

  const created: MindNode = {
    id: createId(ID_PREFIX.mindNode),
    text: before,
    note: '',
    parentId: node.parentId,
    order: node.order - 0.5, // 先插到它**前面**，随后统一重排成整数
  };
  mind.nodes.push(created);
  node.text = after;
  renumberSiblings(mind, node.parentId);
  return node.id;
}

/**
 * **这一行是不是同一层里的最后一个**（`enterAtEnd` 的规则③要用）。
 *
 * ★ 用 `childrenOf` 排出来的次序（与界面上看到的顺序同一套），不自己比 `order`。
 * ★ 悬浮节点也在 `parentId === null` 那一组里（`validate` 就是这么分的），跟着这一套走即可。
 */
function isLastSibling(mind: MindFile, node: MindNode): boolean {
  const siblings = childrenOf(mind, node.parentId);
  return siblings[siblings.length - 1]?.id === node.id;
}

/**
 * **光标在文字末尾**（或这一行本来就是空的）按下 `⏎` 该做什么 —— 幕布那三条
 * （`N3-i`；用户 2026-09-17 原话给的规则，这里照抄）：
 *
 * 1. **收起状态 / 叶子节点** ⇒ 在下方新建一个**同级**（"直接在下方新增一行"）；
 * 2. **展开状态**（下方正显示着子节点）⇒ 给自己建一个**空子节点**、且排在所有子节点的
 *    **第一个** —— "相当于新建了一个空行，但是是缩进的"；
 * 3. **叶子 + 空 + 排在最末** ⇒ 把它**提升**成父节点的同级（"相当于取消缩进"，就是 `promote`）。
 *
 * ★ 判定顺序：③ 是 ① 的例外（两者都要求"叶子"）⇒ **先看 ③**；② 要求"子节点正显示着"
 *   ⇒ 收起状态落回 ①。
 * ★ 末尾那一档**不能**照字面把空文字塞回原节点：那样用户接着打字就会莫名当上原来那些
 *   子节点的爹（子节点跟着原节点走）—— 这是本功能里唯一一处"按意图而不是按字面"的地方。
 *
 * @returns **接着该编辑哪一个节点**；`null` = 根 / 节点不在（调用方保持原样开回去）
 */
export function enterAtEnd(mind: MindFile, id: string): string | null {
  if (isRootNode(mind, id)) return null;
  const node = nodeById(mind, id);
  if (!node) return null;

  const children = childrenOf(mind, id);

  // ③ 空叶子 + 最末 ⇒ 提升一级（与 `⇧Tab` 同一个操作）
  //   ★★ 但**提升动不了**的时候不能就此打住：父节点就是中心主题时 `promote` 会返回 `false`，
  //      照旧返回 `id` 就等于"按了回车什么都没发生"（真实报障："新建一个子节点，回车，
  //      再回车无法创建其兄弟节点" —— 新建的子节点正是"空的、最末的叶子"，而它的父节点
  //      常常就是中心主题 ⇒ 一头撞进这一档）。
  //   ⇒ 提升不成就**退回规则 ①（新建同级）**：保证每一次 `⏎` 都有看得见的结果。
  if (children.length === 0 && node.text.length === 0 && isLastSibling(mind, node)) {
    if (promote(mind, id)) return id;
  }

  // ② 展开着 ⇒ 建一个**第一个**子节点，接着编辑它
  if (children.length > 0 && node.collapsed !== true) return addChild(mind, id, { index: 0 });

  // ① 叶子 / 收起 ⇒ 下方新建一个同级
  return addSibling(mind, id);
}

// ─────────────────────────────────────────────────────────────
// 提升 / 移动 / 删除
// ─────────────────────────────────────────────────────────────

/**
 * `Shift+Tab`：挂到**父节点的父节点**下，插在父节点之后。
 *
 * ★ 直接挂在根下的那一层不动（退无可退 —— 再往上就是"没有父节点的森林"）。
 */
export function promote(mind: MindFile, id: string): boolean {
  const node = nodeById(mind, id);
  if (!node || node.parentId === null) return false;

  const parent = nodeById(mind, node.parentId);
  if (!parent || parent.parentId === null) return false;

  const grandParentId = parent.parentId;
  const order = parent.order + 0.5;

  node.parentId = grandParentId;
  node.order = order;
  // 提升之后它就是树上节点了：坐标归布局，旧坐标删掉（`06 §3` 纪律 1）
  delete node.free;

  renumberSiblings(mind, grandParentId);
  renumberSiblings(mind, parent.id);
  return true;
}

/**
 * **`Tab` 缩进**（`N3-i`，用户 2026-09-17）：变成**上一个兄弟**的最后一个子节点。
 *
 * ★ 这是"文本编辑习惯"那一套里的一档（`Tab` 缩进 / `⇧Tab` 提升）：没有上一个兄弟就
 *   **什么都不做**（第一个孩子往哪儿缩？）—— 与 `promote` 那条"退无可退"正好对称。
 * ★ 实现走 `moveNode` 而**不是**自己改 `parentId` / `order`：那边已经有一整套
 *   "改完再逐项比一遍、位置其实没变就返回 `false`"的判据（`N3-d` 拖拽那一轮加的），
 *   自己再写一份迟早会与它分叉。这也是"缩进"能被撤销栈正确记账的前提。
 */
export function indent(mind: MindFile, id: string): boolean {
  const node = nodeById(mind, id);
  if (!node || isRootNode(mind, id)) return false;

  const siblings = childrenOf(mind, node.parentId);
  const index = siblings.findIndex((item) => item.id === id);
  const previous = index > 0 ? siblings[index - 1] : null;
  if (!previous) return false;

  // 不给 `index` ⇒ 追加到那个兄弟的**最后一个子节点**后面（`moveNode` 里那条"换父 + 不指定位置 = 追加"）
  return moveNode(mind, id, previous.id);
}

/**
 * 删一个节点**连同它的整棵子树**。
 *
 * ★ 根节点删不得（`06 §1` 第 9 条）：一份脑图没有中心主题就不是脑图了。
 *   返回 `false` 而不是抛错 —— 交互层已经挡过，这里是兜底。
 */
export function removeSubtree(mind: MindFile, id: string): boolean {
  if (isRootNode(mind, id)) return false;
  const node = nodeById(mind, id);
  if (!node) return false;

  const doomed = subtreeIds(mind, id);
  mind.nodes = mind.nodes.filter((item) => !doomed.has(item.id));
  // ★ 节点没了 ⇒ 挂在它身上的**关联线**（`N1`）也一起走：留一条半截线只会逼渲染层
  //   去防一个不存在的框（`validate` 读盘时也会丢掉它，但内存里先干净一点）
  if (mind.links) {
    mind.links = mind.links.filter((link) => !doomed.has(link.from) && !doomed.has(link.to));
    if (mind.links.length === 0) delete mind.links;
  }
  renumberSiblings(mind, node.parentId);
  return true;
}

/**
 * 删掉**一整簇**（多选删除，P3-c）。
 *
 * ★ 只删"选区的入口"：子孙会跟着它们一起走（`removeSubtree` 本来就删整棵）。
 * ★ 根节点在选区里时跳过它，其余照删 —— 与"逐条删"的手感一致。
 */
/**
 * 根节点的文字（**去掉首尾空白**；根节点不在 / 没写字 ⇒ 空串）。
 *
 * ★ 用途是"导出 `.nestmind` 时拿它当文件名"（用户 2026-09-22）：白板新建的树里
 *   `meta.title` 是空串，只有根节点上有用户写的字 —— 文件名该跟着**看得见的那行字**走。
 */
export function rootTextOf(mind: MindFile): string {
  return (mind.nodes.find((node) => node.id === mind.rootId)?.text ?? '').trim();
}

export function removeNodes(mind: MindFile, ids: ReadonlySet<string>): boolean {
  let changed = false;
  for (const id of selectionRoots(mind, ids)) {
    if (removeSubtree(mind, id)) changed = true;
  }
  return changed;
}

/**
 * 加一条**关联线**（`N1-b`）：返回新线的 id；加不上给 `null`。
 *
 * ★ 自连、端点不存在都在这里挡掉：交互层也会挡，但模型自己是最后一道
 *   （`validate` 读盘时同样会丢掉这两种 —— 三处同一个口径）。
 * ★ **允许**同一对节点之间有多条（不同标签），所以不做"已存在就复用"。
 * ★ `label` / `arrow` 都**不写**（纪律 2：没有就是没有）——
 *   刚拉出来的线就是一条干净的曲线，标签与箭头是之后编辑出来的。
 */
export function addLink(mind: MindFile, from: string, to: string): string | null {
  if (from === to) return null;
  if (!nodeById(mind, from) || !nodeById(mind, to)) return null;

  const id = createId(ID_PREFIX.mindLink);
  mind.links ??= [];
  mind.links.push({ id, from, to });
  return id;
}

/** 按 id 找一条关联线（模型层的小工具，几个 op 都用它） */
function linkById(mind: MindFile, id: string): MindLink | null {
  return mind.links?.find((link) => link.id === id) ?? null;
}

/**
 * 改一条关联线的**标签**（`N1-c`）。
 *
 * ★ 归一化后为空 ⇒ **删掉这个键**（纪律 2：缺席即"没有标签"，不留空串）——
 *   "把标签清空"与"从来没写过标签"在文件里必须是同一个样子。
 * ★ 值没变返回 `false`：不写盘、不占撤销栈（与 `setIcon` 同一条）。
 */
export function setLinkLabel(mind: MindFile, id: string, label: string): boolean {
  const link = linkById(mind, id);
  if (!link) return false;

  const next = label.trim();
  if ((link.label ?? '') === next) return false;
  if (next.length === 0) delete link.label;
  else link.label = next;
  return true;
}

/** 写箭头：`null` = 没有箭头 ⇒ 删键（纪律 2）。值没变返回 `false` */
export function setLinkArrow(mind: MindFile, id: string, arrow: MindLink['arrow'] | null): boolean {
  const link = linkById(mind, id);
  if (!link) return false;
  if ((link.arrow ?? null) === (arrow ?? null)) return false;
  if (arrow === null || arrow === undefined) delete link.arrow;
  else link.arrow = arrow;
  return true;
}

/**
 * 写线型（`N1` 后续：默认虚线，用户可改实线）。
 *
 * ★ `false` = **回到默认的虚线** ⇒ 删键（纪律 2：默认值不落盘），
 *   而不是写一个 `solid: false` —— 那样"读一遍写回去逐字节不变"会立刻失效。
 */
export function setLinkSolid(mind: MindFile, id: string, solid: boolean): boolean {
  const link = linkById(mind, id);
  if (!link) return false;
  if ((link.solid === true) === solid) return false;
  if (solid) link.solid = true;
  else delete link.solid;
  return true;
}

/**
 * **调弯折**（`N1-d`）：把那根线上的手柄拉到 `bend`（相对"不弯时的中点"的位移）。
 *
 * ★ `null` / 太小 / 非数 ⇒ **删键**（= 回到不弯；纪律 2：默认值不落盘）——
 *   "把这个手柄拉回原处"与"从来没弯过"在文件里必须是同一个样子。
 * ★ 太大 ⇒ 夹进 `MIND_LINK_BEND_MAX`（手一抖拉出十万八千里的值不该落盘）。
 * ★ 归一化只此一处（`schema.normalizeLinkBend`），读盘那边也走它。
 * ★ 值没变返回 `false`：一次点选、或者拖回原地的最后一帧，都不该占撤销栈一格。
 */
export function setLinkBend(mind: MindFile, id: string, bend: LinkBend | null): boolean {
  const link = linkById(mind, id);
  if (!link) return false;

  const next = normalizeLinkBend(bend ?? undefined);
  const current = link.bend ?? null;
  const same =
    (next === null && current === null) ||
    (next !== null &&
      current !== null &&
      Math.abs(next.x - current.x) < 0.01 &&
      Math.abs(next.y - current.y) < 0.01);
  if (same) return false;

  if (next === null) delete link.bend;
  else link.bend = next;
  return true;
}

/**
 * **改线条颜色**（`N1-e`，用户 2026-09-17："脑图的连接线应该也要支持改颜色"）。
 *
 * ★ `null` ⇒ **删键**（回到默认那条灰线；纪律 2：默认值不落盘）——
 *   "把颜色改回默认"与"从来没改过"在文件里必须是同一个样子。
 * ★ 值没变返回 `false`：不写盘、不占撤销栈。
 */
export function setLinkColor(mind: MindFile, id: string, color: ThemeColor | null): boolean {
  const link = linkById(mind, id);
  if (!link) return false;
  if ((link.color ?? null) === (color ?? null)) return false;
  if (color === null) delete link.color;
  else link.color = color;
  return true;
}

/** 删一条关联线。删掉了给 `true`（`links` 空了就把这个键收掉，纪律 2） */
export function removeLink(mind: MindFile, id: string): boolean {
  const links = mind.links;
  if (!links) return false;

  const next = links.filter((link) => link.id !== id);
  if (next.length === links.length) return false;
  if (next.length === 0) delete mind.links;
  else mind.links = next;
  return true;
}

export interface MoveNodeOptions {
  /** 插到第几个孩子（省略 = 追加到末尾） */
  index?: number;
  /** 变成悬浮节点时的落点（**只在这一步**由视图按当前几何给出来） */
  free?: Point;
}

/**
 * 改父（拖拽改父子 / 拖到空白变成悬浮节点）。
 *
 * 挡掉四种情况：根 / 挂到自己身上 / 挂到自己的后代下（会成环）/ 目标不存在。
 * 变成悬浮节点时补上 `free`（世界坐标，原点 = 中心主题的中心）；
 * 从悬浮挂回树上时删掉 `free`（纪律 1：坐标只有悬浮节点有）。
 */
export function moveNode(
  mind: MindFile,
  id: string,
  newParentId: string | null,
  options: MoveNodeOptions = {},
): boolean {
  if (isRootNode(mind, id)) return false;
  const node = nodeById(mind, id);
  if (!node) return false;
  if (newParentId === id) return false;
  if (newParentId !== null) {
    if (!nodeById(mind, newParentId)) return false;
    if (isDescendant(mind, id, newParentId)) return false;
    // ★ 已经在目标下面、又没指定插到第几个 → **什么都不做**。
    //   "追加到末尾"在这里是个陷阱：它会把这个节点从原来的位置挤到最后
    //   （多选拖动时"已经在目标下的那一支"就会莫名其妙跳到末尾）。
    if (node.parentId === newParentId && options.index === undefined) return false;
  }

  // 改之前的身份：父 + 次序 + 坐标。改完之后逐项比一遍 —— 拖回原处、或者"重排之后
  // 还在同一个位置"，都该诚实地返回 `false`（否则一次白拖也在撤销栈里占一格）
  const previousParent = node.parentId;
  const previousOrder = node.order;
  const previousFree = node.free ? { x: node.free.x, y: node.free.y } : null;

  node.parentId = newParentId;

  if (newParentId === null) {
    // 挂在空白处 = 变成悬浮节点：坐标是**数据**，必须给一个
    node.free = options.free ? { x: options.free.x, y: options.free.y } : { x: 0, y: 0 };
    node.order = childrenOf(mind, null).filter(
      (item) => item.id !== id && item.id !== mind.rootId,
    ).length;
  } else {
    delete node.free;
    const siblings = childrenOf(mind, newParentId).filter((item) => item.id !== id);
    const index = options.index ?? siblings.length;
    const before = siblings[index];
    if (before) {
      node.order = before.order - 0.5;
    } else {
      node.order = (siblings[siblings.length - 1]?.order ?? -1) + 1;
    }
  }

  // 重排也可能改到**别的**兄弟（补上空洞）：那也是一次真实的改动，不能算"没动"
  const renumbered = renumberSiblings(mind, previousParent) || renumberSiblings(mind, newParentId);

  const sameFree =
    previousFree === null
      ? node.free === undefined
      : node.free !== undefined && previousFree.x === node.free.x && previousFree.y === node.free.y;

  if (node.parentId === previousParent && node.order === previousOrder && sameFree && !renumbered) {
    return false;
  }
  return true;
}

/**
 * 把**一整簇**挪到同一个父节点下（多选拖动，P3-c）。
 *
 * ★ 先整体判一次"能不能挪"，再动手：**不做部分成功** —— 三支里挪过去两支、
 *   留下那一支还在原地，用户看到的是"我明明选了三支"。
 * ★ 只有"选区的入口"需要换父（`selectionRoots` 已经剔掉了祖先也在选区里的那些），
 *   它们的子孙跟着走。
 * ★ 选区里有根节点时它会被 `moveNode` 挡掉，其余照常 —— 与逐条移动的手感一致，
 *   不必为它让整簇失败。
 */
export function moveNodes(
  mind: MindFile,
  ids: ReadonlySet<string>,
  newParentId: string,
  options: { index?: number } = {},
): boolean {
  if (!nodeById(mind, newParentId)) return false;
  const roots = selectionRoots(mind, ids);
  if (roots.length === 0) return false;
  // 目标是选中项本身、或选中项的后代 → 成环，整簇不动
  for (const id of roots) {
    if (id === newParentId) return false;
    if (isDescendant(mind, id, newParentId)) return false;
  }

  // 按**可见顺序**排：拖过去之后"谁在前"应当由用户看到的样子决定，而不是点选的先后
  const rank = new Map(visibleIds(mind).map((id, index) => [id, index]));
  const ordered = [...roots].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

  let changed = false;
  let index = options.index;
  for (const id of ordered) {
    const moved = moveNode(mind, id, newParentId, index === undefined ? {} : { index });
    if (moved) {
      changed = true;
      // 插进去一个之后，下一个要插在它后面
      if (index !== undefined) index += 1;
    }
  }
  return changed;
}

/**
 * 把同一父节点下的 `order` 重排成 `0..n-1`。
 *
 * ★ 增删移动之后**立刻**调用（`order` 带小数的中间值只在一次改动之内存在）：
 *   留着空洞不会立刻出错，但下一次比较"谁在前"时就得看运气了。
 */
export function renumberSiblings(mind: MindFile, parentId: string | null): boolean {
  const siblings = childrenOf(mind, parentId);
  let changed = false;
  siblings.forEach((node, index) => {
    if (node.order === index) return;
    node.order = index;
    changed = true;
  });
  return changed;
}
