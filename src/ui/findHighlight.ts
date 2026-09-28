/**
 * 查找命中的**高亮**（用户 2026-09-28："被找到的文本会高亮显示"）。
 *
 * ── 做法 ────────────────────────────────────────────────────
 *
 * 只动 DOM、**不碰模型**：在给定容器里遍历文本节点，把命中的片段包成
 * `<mark class="nestboard-find-hit">`；"当前那一处"再加一个 `.is-current`。
 * 重扫之前**先把自己包出来的 mark 还原**（`unwrap`），别人的 DOM 一根汗毛不动。
 *
 * ★ 为什么按文本节点逐个包、而不是"整段替换"：卡片正文是渲染过的 Markdown
 *   （`<strong>` / `<a>` 混在里面），整段替换会把渲染结果冲掉。逐个文本节点包裹时
 *   跨节点的命中只会高亮落在同一个节点里的那部分 —— 与原生在渲染态下的表现同档。
 * ★ 只高亮**已挂载**的元素（屏外的卡片没有 DOM）：计数由模型给（全板），
 *   "跳到某处"会把目标飞进视野，飞过去之后自然就高亮了。
 */

/** 我们自己包出来的命中标记（还原时只认它） */
export const FIND_HIT_CLASS = 'nestboard-find-hit';

/** 参与高亮的文本容器（卡片正文 / 标题 / 脑图节点标题 / 标题卡正文） */
const TEXT_HOSTS = [
  '.nestboard-note-preview',
  '.nestboard-card-title',
  '.nestboard-title-card-text',
  '.nestboard-mind-node-title-text',
  '.nestboard-mind-node-body',
];

/** 把一个 mark 还原成普通文本（就地） */
function unwrap(mark: HTMLElement): void {
  const parent = mark.parentNode;
  if (!parent) return;
  parent.replaceChild(mark.ownerDocument.createTextNode(mark.textContent ?? ''), mark);
  // 相邻文本节点合并：不合并的话反复扫描会让 DOM 越来越碎（文本节点的数量翻倍）
  parent.normalize();
}

/** 清掉容器里**我们包出来的**全部高亮（幂等；可重复调） */
export function clearFindHighlight(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>(`mark.${FIND_HIT_CLASS}`);
  for (const mark of Array.from(marks)) unwrap(mark);
}

/** 收集一批容器里的文本节点（跳过空白 / 已在 mark 里的） */
function textNodesOf(hosts: readonly HTMLElement[]): Text[] {
  const nodes: Text[] = [];
  for (const host of hosts) {
    const walker = host.ownerDocument.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
    let current = walker.nextNode();
    while (current) {
      const text = current as Text;
      const parent = text.parentElement;
      if (text.data.trim().length > 0 && !parent?.closest(`.${FIND_HIT_CLASS}`)) nodes.push(text);
      current = walker.nextNode();
    }
  }
  return nodes;
}

export interface ApplyFindHighlightOptions {
  /** 区分大小写；缺席 = 不区分（与模型层同一口径） */
  matchCase?: boolean;
  /**
   * 从容器**视角**数第几处算"当前"（0 起）；`-1` / 缺席 = 不标当前。
   *
   * ★ 容器里的命中序与模型里的命中序**不一定一致**（屏外那些没有 DOM）——
   *   调用方按"当前命中所在的元素"调它，浮条上的 n/m 仍以模型计数为准。
   */
  currentIndex?: number;
}

/** 把 `query` 的命中高亮出来；返回这次实际高亮了多少处（容器内） */
export function applyFindHighlight(
  root: HTMLElement,
  query: string,
  options: ApplyFindHighlightOptions = {},
): number {
  clearFindHighlight(root);
  if (query.length === 0) return 0;
  const doc = root.ownerDocument;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, options.matchCase ? 'g' : 'gi');
  const hosts = Array.from(root.querySelectorAll<HTMLElement>(TEXT_HOSTS.join(',')));
  if (hosts.length === 0) return 0;

  let order = 0;
  let currentMark: HTMLElement | null = null;
  for (const text of textNodesOf(hosts)) {
    const value = text.data;
    regex.lastIndex = 0;
    if (!regex.test(value)) continue;
    regex.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (const hit of value.matchAll(regex)) {
      const start = hit.index ?? 0;
      if (start > cursor) fragment.appendChild(doc.createTextNode(value.slice(cursor, start)));
      const mark = doc.createElement('mark');
      mark.className = FIND_HIT_CLASS;
      if (order === options.currentIndex) {
        mark.classList.add('is-current');
        currentMark = mark;
      }
      mark.textContent = hit[0];
      fragment.appendChild(mark);
      cursor = start + hit[0].length;
      order += 1;
    }
    if (cursor < value.length) fragment.appendChild(doc.createTextNode(value.slice(cursor)));
    text.parentNode?.replaceChild(fragment, text);
  }
  // 当前那一处若在视口外，把它滚进来（`scrollIntoView` 的 `block: 'center'` 最不晃眼）
  currentMark?.scrollIntoView?.({ block: 'center', inline: 'center' });
  return order;
}

/**
 * 编辑态（textarea）里标出当前命中：原生在源码模式下用的也是"选中它"。
 * 返回 false = 这段文字不在这个框里（调用方自己决定要不要飞视野）。
 */
export function selectMatchInTextarea(
  field: HTMLTextAreaElement | HTMLInputElement,
  query: string,
  matchCase: boolean,
  offsetInField = 0,
): boolean {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, matchCase ? 'g' : 'gi');
  const hits = Array.from(field.value.matchAll(regex));
  const hit = hits[offsetInField];
  if (!hit) return false;
  const start = hit.index ?? 0;
  field.focus();
  field.setSelectionRange(start, start + hit[0].length);
  return true;
}
