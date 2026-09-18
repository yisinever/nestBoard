/**
 * 子树的复制 / 粘贴（`06 §4.1`，P3-b / P3-c）—— 纯函数。
 *
 * ── 为什么是"子树"而不是"节点" ──────────────────────────────
 *
 * 脑图里挪一支的意图几乎总是**连子孙一起**（"把这整块搬到那边去"）。只复制一个节点的话，
 * 用户还得自己重敲一遍三个孩子 —— 那还不如直接新建。
 *
 * ── 为什么是"一簇"而不是"一支"（P3-c）──────────────────────
 *
 * 多选之后按 `⌘C`，用户心里是"把这三支都记下来"。所以载荷是**一组入口 + 它们的全部后代**，
 * 粘贴时按同样的形状落下去 —— 而不是"把它们硬塞进某一个不存在的父节点下"。
 * 单支复制只是这一族的退化情形（`roots` 只有一个元素）。
 *
 * ── 为什么剪贴板是**深拷贝** ────────────────────────────────
 *
 * 剪贴板要活得比"当下的编辑"长：复制之后用户会接着改原节点（甚至撤销、删掉整支），
 * 粘贴时读到的必须还是**复制那一刻**的样子。留一堆引用的话，粘出来的会是"现在的样子"，
 * 甚至是被删掉的幽灵。
 *
 * ★ 粘贴出来的每个节点都拿**新 id**：id 是身份，重复的 id 会让 `validate` 判定成坏文件。
 * ★ `free` 一律丢掉：粘出来的位置由布局算（树上节点不落盘坐标，`06 §3` 纪律 1）。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM，可直接单测。
 */

import { ID_PREFIX } from '../../constants';
import { createId } from '../../util/id';
import type { MindFile, MindNode } from './schema';
import { childrenOf, nodeById, renumberSiblings, selectionRoots } from './ops';

export interface MindClipboard {
  /**
   * 这一簇的入口（粘贴时它们成为新的入口）。
   *
   * ★ 从"一个"变成"一组"是为了多选（P3-c）：复制三支散落的节点粘出来的就该是**三支**，
   *   而不是"把它们塞进一个不存在的父节点下"。单支复制时这个数组只有一个元素。
   */
  roots: string[];
  /** 这一簇的全部节点（深拷贝） */
  nodes: MindNode[];
}

// ─────────────────────────────────────────────────────────────
// 系统剪贴板的两份"行李"（`N3-i`：粘贴时按**格式**认亲）
// ─────────────────────────────────────────────────────────────

/**
 * 这一簇的**可读文字**（缩进表示层级）—— 写进系统剪贴板的 `text/plain`。
 *
 * ★ 用途：粘到笔记 / 微信 / 别的地方时，用户得到的是一段**像样的文字**，
 *   而不是一串 JSON（这也是"要不要碰系统剪贴板"那份顾虑的答案：**碰，但写人看得懂的那一面**）。
 * ★ 层次用两个空格缩进（Markdown 的无序列表惯例：一级 `- `、更深就缩进）。
 */
export function mindClipboardText(payload: MindClipboard): string {
  const children = new Map<string | null, MindNode[]>();
  for (const node of payload.nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

  const lines: string[] = [];
  const walk = (id: string, depth: number): void => {
    const node = payload.nodes.find((item) => item.id === id);
    if (!node) return;
    lines.push(`${'  '.repeat(depth)}- ${node.text}`);
    for (const child of children.get(id) ?? []) walk(child.id, depth + 1);
  };
  for (const root of payload.roots) walk(root, 0);
  return lines.join('\n');
}

/** 我们自己的格式标记（写在 `text/html` 的一个属性里；粘贴时按它认亲） */
const MIND_HTML_MARK = 'data-nestboard-mind-nodes';

/**
 * 这一簇的 `text/html`：一个**真正的嵌套列表**（贴到富文本里长得对），
 * 根元素上带一份我们自己的载荷（`encodeURIComponent(JSON)`，属性值里绝对安全）。
 *
 * ★ **不占 `text/plain`**：那一份留给"人读的文字"（见 `mindClipboardText`）——
 *   混在一起会让"粘到笔记"变成粘一串乱码。
 * ★ 用 `text/html` 而不是自定义 MIME：Chromium 只允许白名单里的类型写进系统剪贴板
 *   （自定义类型会直接抛 `NotAllowedError`）。
 */
export function mindClipboardHtml(payload: MindClipboard): string {
  const data = encodeURIComponent(JSON.stringify(payload));
  const children = new Map<string | null, MindNode[]>();
  for (const node of payload.nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const item = (id: string): string => {
    const node = payload.nodes.find((entry) => entry.id === id);
    if (!node) return '';
    const kids = (children.get(id) ?? []).map((child) => item(child.id)).join('');
    return `<li>${escape(node.text)}${kids.length > 0 ? `<ul>${kids}</ul>` : ''}</li>`;
  };
  const items = payload.roots.map((id) => item(id)).join('');
  return `<ul ${MIND_HTML_MARK}="${data}">${items}</ul>`;
}

/**
 * 从 `text/html` 里**认回**我们自己的载荷；不是我们写的就给 `null`。
 *
 * ★ 这是"粘贴时判定粘的是**节点**还是**文字**"的唯一依据（用户 2026-09-17 提的需求）——
 *   靠"当前是不是在编辑标题"去猜是猜不准的：用户既可能想粘文字，也可能想粘节点。
 * ★ 解析失败一律当"不是我们的"（外来 HTML 千奇百怪，宁可让浏览器自己粘）。
 */
export function parseMindClipboardHtml(html: string): MindClipboard | null {
  if (!html.includes(MIND_HTML_MARK)) return null;
  const match = new RegExp(`${MIND_HTML_MARK}="([^"]*)"`).exec(html);
  if (!match) return null;
  try {
    const raw: unknown = JSON.parse(decodeURIComponent(match[1] ?? ''));
    if (!isRecord(raw)) return null;
    const roots = raw.roots;
    const nodes = raw.nodes;
    if (!Array.isArray(roots) || !roots.every((id) => typeof id === 'string')) return null;
    if (!Array.isArray(nodes)) return null;
    return { roots: roots as string[], nodes: nodes as MindNode[] };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ─────────────────────────────────────────────────────────────
// 进程内的剪贴板（一份，跨视图共享）
// ─────────────────────────────────────────────────────────────

let shared: MindClipboard | null = null;

/**
 * 写剪贴板（`⌘C` / `⌘X`）。
 *
 * ★ 放在模块级而不是某个视图的字段上：**剪贴板天生是全局的** —— 两块脑图分屏时，
 *   "在左边复制一支、到右边粘上"是最自然的用法，挂在视图上就做不到。
 * ★ 这一份是**进程内**的主剪贴板（`⌘V` 走它）；`N3-i` 起**同时**往系统剪贴板写两份行李
 *   （`text/plain` 给人读、`text/html` 带自家标记）—— 于是"粘到别处是文字、粘回脑图是节点"，
 *   有了跨窗口 / 跨应用粘贴，也解决了"编辑器开着时 `⌘V` 到底该粘文字还是粘节点"
 *   （**按格式认亲**，见 `mindClipboardText` / `mindClipboardHtml` / `parseMindClipboardHtml`）。
 *   ★ 当初"刻意不碰系统剪贴板"的顾虑（写一串别人看不懂的 JSON 不礼貌）由 `text/plain`
 *     那一份解决了：**写人看得懂的那一面**。
 */
export function setMindClipboard(payload: MindClipboard | null): void {
  shared = payload;
}

export function getMindClipboard(): MindClipboard | null {
  return shared;
}

// ─────────────────────────────────────────────────────────────
// 复制
// ─────────────────────────────────────────────────────────────

/**
 * 复制一簇（`ids` 里"祖先也被选中"的那些会被自动剔掉 —— 见 `selectionRoots`）。
 *
 * 返回 `null` = 一个有效节点都没有。
 */
export function copyForest(mind: MindFile, ids: Iterable<string>): MindClipboard | null {
  const raw = new Set(ids);
  // ★ 选中了中心主题 = "复制整张图"：只复制它那一支（其余节点本来就长在里面），
  //   否则粘出来的会是"整张图 + 它每个孩子又各来一份"
  const roots = raw.has(mind.rootId) ? [mind.rootId] : selectionRoots(mind, raw);
  if (roots.length === 0) return null;

  // 广度遍历把每支的全部后代收进来（**不限折叠**：藏起来的子孙也要跟着走）
  const included = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const node of mind.nodes) {
      if (node.parentId !== current || included.has(node.id)) continue;
      included.add(node.id);
      queue.push(node.id);
    }
  }

  return {
    roots,
    nodes: mind.nodes.filter((node) => included.has(node.id)).map(cloneNode),
  };
}

/** 单支复制（多选那一套的退化情形；`MindView` 与单测都用得上） */
export function copySubtree(mind: MindFile, id: string): MindClipboard | null {
  return copyForest(mind, [id]);
}

// ─────────────────────────────────────────────────────────────
// 粘贴
// ─────────────────────────────────────────────────────────────

/**
 * 把这一簇粘到 `parentId` 下（各入口追加到末尾），返回**新入口**的 id 列表。
 *
 * `null` = 没粘成：剪贴板是空的 / 父节点不存在（例如粘之前它被删了）。
 */
export function pasteForest(
  mind: MindFile,
  clipboard: MindClipboard | null,
  parentId: string,
): string[] | null {
  if (!clipboard || clipboard.nodes.length === 0 || clipboard.roots.length === 0) return null;
  if (!mind.nodes.some((node) => node.id === parentId)) return null;

  const inPayload = new Set(clipboard.nodes.map((node) => node.id));
  // 旧的 id → 新的 id：先整表映射，再逐个接上父节点，免得边遍历边查表
  const remap = new Map<string, string>();
  for (const node of clipboard.nodes) remap.set(node.id, createId(ID_PREFIX.mindNode));

  const base = childrenOf(mind, parentId).length;
  const pasted: MindNode[] = clipboard.nodes.map((node) => {
    const copy = cloneNode(node);
    copy.id = remap.get(node.id) ?? createId(ID_PREFIX.mindNode);

    // 父节点也在这份载荷里 → 跟着新 id 走；否则它就是入口，落到目标下面
    const sourceParent = node.parentId;
    const remappedParent = sourceParent === null ? undefined : remap.get(sourceParent);
    copy.parentId = remappedParent ?? parentId;
    const parentInPayload = sourceParent !== null && inPayload.has(sourceParent);
    // 入口依次排在目标末尾（保持它们在剪贴板里的先后），子孙保持相对次序
    copy.order = parentInPayload ? node.order : base + clipboard.roots.indexOf(node.id);

    // ★ 树上节点不落盘坐标：粘出来的位置由布局给（`06 §3` 纪律 1）
    delete copy.free;
    return copy;
  });

  mind.nodes.push(...pasted);
  return clipboard.roots.map((id) => remap.get(id)).filter((id): id is string => id !== undefined);
}

/** 单支粘贴（返回新入口的 id；多选那一套的退化情形） */
export function pasteSubtree(
  mind: MindFile,
  clipboard: MindClipboard | null,
  parentId: string,
): string | null {
  return pasteForest(mind, clipboard, parentId)?.[0] ?? null;
}

// ─────────────────────────────────────────────────────────────
// 原地复制（右键菜单的「复制一份」，`08 §2.1`）
// ─────────────────────────────────────────────────────────────

/**
 * 把这一簇各支**复制一份，插在自己后面**（同一个父下），返回新支的入口 id。
 *
 * ★ 与"粘贴"共用同一套拷贝（`copyForest` + `pasteForest`）：两者的差别**只在落点** ——
 *   粘贴落在你选的那个节点下面（那是"我要放到这儿"），原地复制落在原节点的**下一个位置**
 *   （那是"再来一份一模一样的"）。
 * ★ 多个入口**逆序处理**：先插靠后的那些，前面那些的相对位置才不会被推走。
 * ★ **跳过中心主题**：复制整张图没有意义（菜单里那一项也是灰的，两道一起兜）。
 * ★ **跳过悬浮节点**：它不在树上，"同一个父下"对它是句空话（要复制它得连带位置一起想，
 *   那是另一件事）。
 * ★ 落点用 `order + 0.5` 这个中间值，紧接着 `renumberSiblings` 规整 ——
 *   直接写 `order + 1` 会与原来那个兄弟**撞号**，而撞号之后谁在前要看排序实现（不能靠）。
 */
export function duplicateNodes(mind: MindFile, ids: ReadonlySet<string>): string[] {
  const created: string[] = [];
  const roots = selectionRoots(mind, ids).filter((id) => id !== mind.rootId);

  for (const id of [...roots].reverse()) {
    const source = nodeById(mind, id);
    const payload = copyForest(mind, [id]);
    if (!source || source.parentId === null || !payload) continue;

    const parentId = source.parentId;
    // 先规整一次：`order` 里可能还留着上一次改动的中间值
    renumberSiblings(mind, parentId);
    const order = source.order + 0.5;

    const pasted = pasteForest(mind, payload, parentId);
    const rootCopy = pasted?.[0] ? nodeById(mind, pasted[0]) : null;
    if (!rootCopy || pasted === null) continue;

    // 粘出来默认落在**末尾**（那是"粘贴"的语义）—— 这里要的是"紧接着原节点"
    rootCopy.order = order;
    renumberSiblings(mind, parentId);
    created.unshift(rootCopy.id);
  }

  return created;
}

/**
 * 深拷贝一个节点。
 *
 * ★ 逐字段抄而不是 `structuredClone`：`refs` 是嵌套数组，浅拷贝会让"复制之后原节点加了附件"
 *   悄悄改到剪贴板里的那一份。写全字段**又**有个好处 —— 将来给节点加字段时，
 *   TypeScript 会在这里报错，提醒"复制粘贴也要跟着改"。
 */
function cloneNode(node: MindNode): MindNode {
  const copy: MindNode = {
    id: node.id,
    text: node.text,
    note: node.note,
    parentId: node.parentId,
    order: node.order,
  };
  // 可选键：**缺席就不补**（`06 §3` 纪律 2），值要深拷贝
  if (node.style) copy.style = { ...node.style };
  // ★ 标记也要抄（`08 §3.1`）：漏了它，复制 / 原地复制出来的那一支会**丢掉表情**，
  //   而"一模一样再来一份"正是原地复制承诺的事（这一条是被单测逮住的）
  if (node.icon !== undefined) copy.icon = node.icon;
  if (node.collapsed === true) copy.collapsed = true;
  if (node.refs) copy.refs = node.refs.map((ref) => ({ ...ref }));
  if (node.free) copy.free = { x: node.free.x, y: node.free.y };
  return copy;
}
