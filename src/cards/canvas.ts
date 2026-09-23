/**
 * `.canvas` 预览卡（`F6`，用户 2026-09-21："支持.canvas 类型文件预览 —— 类似 ob 原生
 * canvas 嵌入 canvas 的效果"）。
 *
 * ── 它长什么样 ───────────────────────────────────────────────
 *
 * 卡面把那份 `.canvas` **按原样缩小画一遍**：方块（`text` / `file` / `link` / `group`）
 * 加连线，用**一张 `<svg>`** 表达。
 *
 * ★ 为什么是 SVG 而不是 DOM 盒子：`viewBox` 一项就能把"任意尺寸的 canvas 塞进任意尺寸的
 *   卡片"这件事交给浏览器 —— 不需要量卡片、不需要监听 resize、不需要自己算缩放。
 *   画布预览是只读的，跟着缩放的文字也够读（这与白板上可编辑的卡片是两回事）。
 *
 * ── 它是**只读**的 ──────────────────────────────────────────
 *
 * 卡面上不能编辑（用户 2026-09-21 定的：双击**在新标签打开**那份 `.canvas`，编辑去原生
 * 编辑器里做）。所以这张卡没有「编辑内容」菜单项，也不显示标题栏。
 *
 * ── 异步读文件 ──────────────────────────────────────────────
 *
 * `render` 是同步的，而读文件是异步的 ⇒ 先画"正在读"，读完再换。
 * ★ 元素会被**复用**（`CardLayer` 回收盒子），所以读完要先确认"这张卡还是当初那张"：
 *   比对元素上记的路径（`data-canvas-src`）。换成别的卡了就丢掉这次结果。
 */

import type { JsonCanvasFile, JsonCanvasNode } from '../export/jsonCanvas';
import { parseCanvasFile } from '../export/jsonCanvas';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 默认尺寸：横版 3:2（canvas 本身多半是"一屏摊开"的形状） */
export const CANVAS_CARD_DEFAULT_SIZE: Size = { width: 360, height: 240 };

const CANVAS_ROOT_CLASS = 'nestboard-canvas-ref';
const CANVAS_SVG_CLASS = 'nestboard-canvas-ref-svg';
const CANVAS_NOTE_CLASS = 'nestboard-canvas-ref-note';
const CANVAS_NODE_CLASS = 'nestboard-canvas-ref-node';
const CANVAS_LABEL_CLASS = 'nestboard-canvas-ref-label';
const CANVAS_EDGE_CLASS = 'nestboard-canvas-ref-edge';

/** 元素上记的"读的是哪个文件"（复用与竞态判据，见文件头） */
const CANVAS_SRC_ATTR = 'canvasSrc';
/** 双击监听只挂一次的记号（元素会被复用，重复挂会叠起来） */
const CANVAS_BOUND_ATTR = 'canvasBound';

/** 节点四周留白（用户单位）：不加的话边缘方块会贴着卡边 */
const CANVAS_PADDING = 24;
/** 标题最长显示几个字（SVG 文字不折行，超了只能截） */
const CANVAS_LABEL_MAX = 22;

/**
 * 元素 → 最近一次渲染的上下文。
 * ★ 双击的回调里拿不到 `ctx`，而"在新标签打开"要用 `app` ⇒ 渲染时记一笔。
 *   用 `WeakMap` 而不是 `dataset`：上下文里有 app / vault，不该落到 DOM 属性上。
 */
const lastContext = new WeakMap<HTMLElement, CardRenderContext>();

export const canvasCard: CardTypeDefinition<'canvas'> = {
  type: 'canvas',

  get displayName(): string {
    return t('card.type.canvas');
  },

  icon: 'layout-dashboard',
  defaultSize: CANVAS_CARD_DEFAULT_SIZE,

  /**
   * 只读预览：没有「编辑内容」（卡上没有可写的地方 —— 要换文件就重新拖一张），
   * 也不显示标题栏（卡面全给那张缩略图）。与 PDF 卡、仅标题卡同一条口径。
   */
  menuItems: { editContent: false, showTitle: false },

  createDefaultContent() {
    return { path: '', showSize: false };
  },

  render(el, card, ctx): void {
    el.classList.add(CANVAS_ROOT_CLASS);
    lastContext.set(el, ctx);

    const path = card.content.path;
    if (path.length === 0) {
      el.replaceChildren(noteOf(el, t('card.canvas.empty')));
      return;
    }

    // ★ 先记路径再读：读完用它确认"这张卡还是当初那张"（元素会被复用）
    el.dataset[CANVAS_SRC_ATTR] = path;
    el.replaceChildren(noteOf(el, ''));
    if (el.dataset[CANVAS_BOUND_ATTR] !== 'yes') {
      el.dataset[CANVAS_BOUND_ATTR] = 'yes';
      el.addEventListener('dblclick', openCanvasInTab);
    }
    void loadCanvas(el, path);
  },

  destroy(el): void {
    el.classList.remove(CANVAS_ROOT_CLASS);
    delete el.dataset[CANVAS_SRC_ATTR];
    delete el.dataset[CANVAS_BOUND_ATTR];
    el.removeEventListener('dblclick', openCanvasInTab);
    lastContext.delete(el);
    el.replaceChildren();
  },

  /** 导出成 Markdown 用 `![[…]]`：Obsidian 自己会把它嵌成 canvas 视图 */
  toMarkdown(card): string {
    return card.content.path.length > 0 ? `![[${card.content.path}]]` : '';
  },
};

/**
 * `.canvas` 的**外接框**（用户单位）。
 *
 * ★ 只算矩形本身，不含文字溢出：SVG 文字画在方块里，方块跟着缩放，
 *   所以外接框就是"所有方块的并集 + 一圈留白"。
 * ★ 纯函数、不碰 DOM，可直接单测。
 */
export function canvasBoundsOf(nodes: readonly JsonCanvasNode[]): {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
} {
  const drawable = nodes.filter(isDrawable);
  if (drawable.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1, fontSize: 16 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let smallest = Infinity;
  for (const node of drawable) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
    smallest = Math.min(smallest, node.height);
  }
  return {
    x: minX - CANVAS_PADDING,
    y: minY - CANVAS_PADDING,
    width: Math.max(1, maxX - minX + CANVAS_PADDING * 2),
    height: Math.max(1, maxY - minY + CANVAS_PADDING * 2),
    // 字号跟着"最小的那个方块"走：字号相对方块太大，字会溢出去压住邻居
    fontSize: Math.min(72, Math.max(8, smallest * 0.3)),
  };
}

/**
 * 方块上显示什么字。
 *
 * ★ 认的是 JSON Canvas 规范里各类型**自己那个字段**：`text` / `file` / `url` / `label`。
 *   取不到就退回类型名（如 `link`）—— 卡面上宁可写"这是什么"，也别留个空方块。
 * ★ 纯函数、可单测。
 */
export function canvasNodeLabelOf(node: JsonCanvasNode): string {
  const raw = textValueOf(node);
  if (raw.length === 0) return node.type;
  // 只取第一行：SVG 文字不折行，多行正文会用"…"占满整个方块
  const firstLine = raw.split('\n')[0]?.trim() ?? '';
  const single = firstLine.length > 0 ? firstLine : raw.trim();
  return single.length > CANVAS_LABEL_MAX ? `${single.slice(0, CANVAS_LABEL_MAX)}…` : single;
}

// ─────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────

/** 节点要能被画出来，至少得有四个数（坏文件里什么都有） */
function isDrawable(node: JsonCanvasNode): boolean {
  return (
    typeof node.x === 'number' &&
    typeof node.y === 'number' &&
    typeof node.width === 'number' &&
    typeof node.height === 'number' &&
    Number.isFinite(node.x) &&
    Number.isFinite(node.y) &&
    Number.isFinite(node.width) &&
    Number.isFinite(node.height)
  );
}

/** 各类型的正文字段（规范里它们就叫这几个名字） */
function textValueOf(node: JsonCanvasNode): string {
  const record = node as unknown as Record<string, unknown>;
  for (const key of ['text', 'file', 'url', 'label']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return '';
}

/** 异步读 + 画。读不到 / 解析不出都给一句说得清的话，不留白板 */
async function loadCanvas(el: HTMLElement, path: string): Promise<void> {
  const ctx = lastContext.get(el);
  if (!ctx) return;

  let raw = '';
  try {
    raw = await ctx.app.vault.adapter.read(path);
  } catch {
    if (stillWants(el, path)) el.replaceChildren(noteOf(el, t('card.canvas.missing')));
    return;
  }
  // ★ 元素可能已经被换成别的卡了（列表滚动、卡片被删）⇒ 结果丢掉
  if (!stillWants(el, path)) return;

  const parsed = parseCanvasFile(raw);
  if (!parsed.ok) {
    el.replaceChildren(noteOf(el, t('card.canvas.broken')));
    return;
  }
  paintCanvas(el, parsed.canvas);
}

/** 这张卡现在还是当初那张吗（路径没变、还在文档里） */
function stillWants(el: HTMLElement, path: string): boolean {
  return el.dataset[CANVAS_SRC_ATTR] === path && el.isConnected;
}

/** 把整张 canvas 画成一张 SVG（见文件头：缩放交给 `viewBox`） */
function paintCanvas(el: HTMLElement, canvas: JsonCanvasFile): void {
  const doc = el.ownerDocument;
  const nodes = canvas.nodes.filter(isDrawable);
  if (nodes.length === 0) {
    el.replaceChildren(noteOf(el, t('card.canvas.empty')));
    return;
  }

  const bounds = canvasBoundsOf(nodes);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('class', CANVAS_SVG_CLASS);
  svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const centerOf = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    centerOf.set(node.id, { x: node.x + node.width / 2, y: node.y + node.height / 2 });
  }

  // 连线先画：压在方块下面（canvas 原生也是这个层次）
  for (const edge of canvas.edges) {
    const from = centerOf.get(edge.fromNode);
    const to = centerOf.get(edge.toNode);
    if (!from || !to) continue;
    const line = doc.createElementNS(ns, 'line');
    line.setAttribute('class', CANVAS_EDGE_CLASS);
    line.setAttribute('x1', String(from.x));
    line.setAttribute('y1', String(from.y));
    line.setAttribute('x2', String(to.x));
    line.setAttribute('y2', String(to.y));
    svg.append(line);
  }

  for (const node of nodes) {
    const rect = doc.createElementNS(ns, 'rect');
    rect.setAttribute('class', `${CANVAS_NODE_CLASS} ${CANVAS_NODE_CLASS}--${node.type}`);
    rect.setAttribute('x', String(node.x));
    rect.setAttribute('y', String(node.y));
    rect.setAttribute('width', String(Math.max(1, node.width)));
    rect.setAttribute('height', String(Math.max(1, node.height)));
    rect.setAttribute('rx', String(Math.min(16, node.height / 6)));
    svg.append(rect);

    const label = doc.createElementNS(ns, 'text');
    label.setAttribute('class', CANVAS_LABEL_CLASS);
    label.setAttribute('x', String(node.x + Math.min(12, node.width / 8)));
    label.setAttribute('y', String(node.y + node.height / 2));
    label.setAttribute('dominant-baseline', 'middle');
    label.setAttribute('font-size', String(bounds.fontSize));
    label.textContent = canvasNodeLabelOf(node);
    svg.append(label);
  }

  el.replaceChildren(svg);
}

/** 卡面上的那句话（空串 = 还没读到，先什么都不显示） */
function noteOf(el: HTMLElement, text: string): HTMLElement {
  const note = el.ownerDocument.createElement('div');
  note.className = CANVAS_NOTE_CLASS;
  note.textContent = text;
  return note;
}

/** 双击：**在新标签打开原 `.canvas`**（用户 2026-09-21 定的；编辑去原生编辑器里做） */
function openCanvasInTab(event: Event): void {
  const el = event.currentTarget;
  if (!(el instanceof HTMLElement)) return;
  const path = el.dataset[CANVAS_SRC_ATTR] ?? '';
  const ctx = lastContext.get(el);
  if (path.length === 0 || !ctx) return;
  // 这一下不该顺带"选中卡片 / 进编辑"（那两件事由外层监听决定，别让它一起发生）
  event.stopPropagation();
  void ctx.app.workspace.openLinkText(path, '', true);
}
