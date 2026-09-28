/**
 * `icon` 字段值的**唯一解析口**（用户 2026-09-28："支持标记选择的第二种图标类型，
 * 原有的 emoji 保留"）。
 *
 * ── 存储口径 ────────────────────────────────────────────────
 *
 * `icon` 还是一个字符串（不改 schema、老文件零迁移）：
 *
 * * `'🔴'` —— emoji（原有行为，一个字节都不变）；
 * * `'nb:0101'` —— **像素图标**（`nb:` + 4 位编号：前两位组号、后两位组内序号，
 *   共 7 个 UTF-16 码元，远在 `ICON_MAX_LENGTH = 16` 之内）；
 * * 链接卡的 `content.icon` 存的是**图片 URL**，`http` 开头天然与 `nb:` 不撞。
 *
 * ★ 为什么收拢在这里：卡面 / 快捷操作栏 / 选择器 / 导出兜底都问同一份 ——
 *   各写一份迟早出现"选择器里是像素图标、卡面上是 nb:0101 四个字"的难看分叉。
 */

import { PALETTE, PIXEL_ICON_GROUPS, type PixelIcon } from '../ui/icons/pixelIcons';

/** 像素图标值的前缀 */
export const PIXEL_ICON_PREFIX = 'nb:';

/** 解析结果：emoji（原样）或像素图标（编号） */
export type IconValue = { kind: 'emoji'; text: string } | { kind: 'pixel'; icon: PixelIcon } | null;

/** 编号 → 图标（模块加载时建一次表；96 个而已） */
const BY_ID = new Map<string, PixelIcon>();
for (const group of PIXEL_ICON_GROUPS) {
  for (const icon of group.icons) BY_ID.set(icon.id, icon);
}

/** 图标包的全部编号（`normalizeIcon` 校验 `nb:` 值用） */
export const PIXEL_ICON_IDS: ReadonlySet<string> = new Set(BY_ID.keys());

/** 解析一个 `icon` 字段值；认不出（空 / 越界的 `nb:`）= `null`（没有图标） */
export function parseIconValue(raw: string): IconValue {
  if (raw.startsWith(PIXEL_ICON_PREFIX)) {
    const icon = BY_ID.get(raw.slice(PIXEL_ICON_PREFIX.length));
    return icon ? { kind: 'pixel', icon } : null;
  }
  return raw.length > 0 ? { kind: 'emoji', text: raw } : null;
}

/** 组一个像素图标的值（选择器与写入共一处拼，免得两处拼法漂移） */
export function pixelIconValue(icon: PixelIcon): string {
  return `${PIXEL_ICON_PREFIX}${icon.id}`;
}

/**
 * 由 16×16 网格**合成**一份 SVG（`viewBox 0 0 16 16` + `crispEdges`）。
 *
 * ★ 不落第二份 SVG 字符串：网格是唯一事实来源；同一行连续同色格合并成
 *   `M{x} {y}h{w}v1H{x}z` 的矩形路径 —— 与图标包自带文件是同一种画法。
 */
export function composePixelIconSvg(icon: PixelIcon): string {
  const paths = pixelIconPaths(icon)
    .map(({ color, d }) => `<path fill="${color}" d="${d}"/>`)
    .join('');
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
    paths +
    '</svg>'
  );
}

/** 合成结果缓存：选择器一帧要摆几十个，同一图标只合成一次 */
const svgCache = new Map<string, string>();

/** 像素图标的 SVG（缓存）；`null` = 编号不认识 */
export function pixelIconSvg(id: string): string | null {
  const cached = svgCache.get(id);
  if (cached !== undefined) return cached;
  const icon = BY_ID.get(id);
  if (!icon) return null;
  const svg = composePixelIconSvg(icon);
  svgCache.set(id, svg);
  return svg;
}

/** 每个颜色键在网格里的**连续段**（DOM 与字符串合成共用这一条路径计算） */
function pixelIconPaths(icon: PixelIcon): Array<{ color: string; d: string }> {
  const paths: Array<{ color: string; d: string }> = [];
  for (const [colorKey, color] of Object.entries(PALETTE)) {
    let d = '';
    for (let y = 0; y < 16; y += 1) {
      const row = icon.grid[y] ?? '';
      let x = 0;
      while (x < 16) {
        if (row[x] === colorKey) {
          let width = 1;
          while (row[x + width] === colorKey) width += 1;
          d += `M${x} ${y}h${width}v1H${x}z`;
          x += width;
        } else {
          x += 1;
        }
      }
    }
    if (d.length > 0) paths.push({ color, d });
  }
  return paths;
}

/** 像素图标的 CSS 类（尺寸 / `image-rendering: pixelated` 都挂它） */
export const PIXEL_ICON_CLASS = 'nestboard-pixel-icon';

/**
 * 把一个 `icon` 值画进元素（**替换**其内容）：emoji 走文本，像素图标走
 * `createElementNS` 拼出来的 SVG —— 不经 `innerHTML`（`2.1.3` 那条审核意见的延续）。
 *
 * ★ 认不出的值（空 / 坏的 `nb:`）= **清空**：与"没设图标"同一个下场，而不是把
 *   `nb:xxxx` 四个字画在卡面上。
 */
export function renderIconInto(el: HTMLElement, value: string): void {
  const parsed = parseIconValue(value);
  // ★ 用 `textContent = ''` 清空而不是 `replaceChildren()`：单测的极简假 DOM 只实现
  //   了 textContent / appendChild 这一小撮（真实 DOM 里两者等价）
  el.textContent = '';
  if (!parsed) return;
  if (parsed.kind === 'emoji') {
    el.textContent = parsed.text;
    return;
  }
  const doc = el.ownerDocument;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.classList.add(PIXEL_ICON_CLASS);
  for (const { color, d } of pixelIconPaths(parsed.icon)) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', color);
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  el.appendChild(svg);
}

/**
 * **导出侧**（canvas / SVG）该画的那个字：像素图标暂时退回它自带的 emoji 兜底
 * （口径记在计划 §6），emoji 原样，认不出 = 空。
 */
export function iconExportText(value: string): string {
  const parsed = parseIconValue(value);
  if (!parsed) return '';
  return parsed.kind === 'emoji' ? parsed.text : parsed.icon.emoji;
}
