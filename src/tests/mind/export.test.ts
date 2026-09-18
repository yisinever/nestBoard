/**
 * 导出（`mind/export/`，`06 §7.3`）：树 → Markdown / SVG。
 *
 * 这两个渲染器都是**纯函数**（给字符串、不碰 DOM），所以能逐条钉住"层级怎么表达、
 * 附件怎么倒、空标题怎么兜"这类规则 —— 它们在导出物里错了要过很久才有人发现。
 */

import { describe, expect, it } from 'vitest';
import { mindToMarkdown } from '../../mind/export/toMarkdown';
import { MIND_SVG_BG_CLASS, mindToSvg } from '../../mind/export/toSvg';
import { layoutMind } from '../../mind/layout/tree';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';

/** 造一份脑图：`[标题, 正文, 父标题 | null, 附件路径?]` */
function mindOf(
  shape: readonly (readonly [string, string, string | null, string?])[],
  title = '产品脑暴',
): MindFile {
  const file = createMindFile({ title, now: () => 'T' });
  file.nodes = shape.map(([text, note, parentText, ref], index) =>
    createMindNode({
      id: `n_${text}`,
      text,
      note,
      parentId: parentText === null ? null : `n_${parentText}`,
      order: index,
      ...(ref ? { refs: [{ kind: ref.endsWith('.png') ? 'image' : 'note', path: ref }] } : {}),
    }),
  );
  file.rootId = `n_${shape[0]?.[0] ?? ''}`;
  return file;
}

describe('mindToMarkdown', () => {
  it('★ 深度 → 标题级别（文档标题是一级、根是二级）', () => {
    const md = mindToMarkdown(
      mindOf([
        ['中心', '', null],
        ['一层', '', '中心'],
        ['二层', '', '一层'],
      ]),
    );

    expect(md).toContain('# 产品脑暴');
    expect(md).toContain('## 中心');
    expect(md).toContain('### 一层');
    expect(md).toContain('#### 二层');
  });

  it('正文原样贴在标题下面（它本来就是 Markdown）', () => {
    const md = mindToMarkdown(mindOf([['中心', '**要点**\n- 一条', null]]));

    expect(md).toContain('**要点**');
    expect(md).toContain('- 一条');
  });

  it('★ 附件倒成 Obsidian 认的语法：图片嵌入、其余链接', () => {
    const md = mindToMarkdown(
      mindOf([
        ['中心', '', null, '图.png'],
        ['甲', '', '中心', '笔记.md'],
      ]),
    );

    expect(md).toContain('![[图.png]]');
    expect(md).toContain('[[笔记.md]]');
  });

  it('★ 折叠的、以及悬浮的节点**照样导出**（导出漏内容是最不可原谅的丢数据）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['藏起来的', '内容', '中心'],
    ]);
    const collapsed = file.nodes.find((node) => node.text === '中心');
    if (collapsed) collapsed.collapsed = true;
    file.nodes.push(
      createMindNode({ id: 'n_自由', text: '自由主题', note: '', parentId: null, order: 9 }),
    );

    const md = mindToMarkdown(file);

    expect(md).toContain('藏起来的');
    expect(md).toContain('自由主题');
  });

  it('六级标题之外退化成缩进列表（硬写七个 `#` 会被当成普通文本）', () => {
    const md = mindToMarkdown(
      mindOf([
        ['中心', '', null],
        ['一', '', '中心'],
        ['二', '', '一'],
        ['三', '', '二'],
        ['四', '', '三'],
        ['五', '', '四'],
      ]),
    );

    // 文档标题 1、根 2 …… 到「四」正好是六级标题（Markdown 的上限）
    expect(md).toContain('###### 四');
    // 再深一层就是列表项，而不是 `#######`
    expect(md).toContain('- 五');
    expect(md).not.toContain('#######');
  });

  it('空标题给一句占位（否则那一行只剩一个 `#`）', () => {
    expect(mindToMarkdown(mindOf([['', '', null]]))).toContain('（无标题）');
  });

  it('末尾一定有且只有一个换行（写文件时不该多出空行）', () => {
    const md = mindToMarkdown(mindOf([['中心', '正文', null]]));

    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });
});

describe('mindToSvg', () => {
  // ★ 走向用产品口径（`'right'`）：两侧模式下两个同层孩子会各占一边，
  //   "同方向共用一条延长线"这条规则就量不出来（那是另一套期望）
  const svgOf = (file: MindFile, options = {}): string =>
    mindToSvg(
      file,
      layoutMind(file, { sizeOf: () => ({ width: 100, height: 40 }), direction: 'right' }),
      options,
    );

  it('★ 标题带的高度只算一处：**没有内容的节点**四角都圆，不露直角', () => {
    // 用户报过：导出 PNG 里除根节点外，其他节点底下都露出一截**直角**（"贴了一小块方纸"）。
    // 成因是标题带高度与文字那行用了两个公式（带子是 `min(height, 44)`）——
    // 矮节点上带子会铺满整张卡，却只圆了上面两个角。
    // ★ 判据：那截"上面圆、下面直角"的带子是整份 SVG 里**唯一**用 `Q` 的地方，
    //   于是一张全是空节点的图里不该出现它（根节点够高，从前也看不出来）
    const svg = svgOf(
      mindOf([
        ['中心', '', null],
        ['甲', '', '中心'],
      ]),
    );

    expect(svg).not.toContain('Q ');
  });

  it('★ 有内容的节点：标题带只占上面一截（下面那截是圆角的底色）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
    ]);
    // 120 高的卡：标题带（≈40）只占上面一小截 ⇒ 必须走那条"上面圆、下面直角"的 path
    const svg = mindToSvg(
      file,
      layoutMind(file, { sizeOf: () => ({ width: 200, height: 120 }), direction: 'right' }),
    );

    expect(svg).toContain('Q ');
  });

  it('★ 输出一份能独立打开的 SVG（有 xmlns / viewBox / 尺寸）', () => {
    const svg = svgOf(mindOf([['中心', '', null]]));

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('viewBox=');
    expect(svg).toContain('width=');
    expect(svg).toContain('height=');
    expect(svg).toContain('</svg>');
  });

  it('★ 每个可见节点各有一块底 + 一行标题', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
    ]);
    const svg = svgOf(file);

    // 按节点分组的 class 数（连线那一组是另一个 `<g>`，见下一条）
    expect(svg.match(/class="nestboard-mind-svg-node"/g)).toHaveLength(2);
    expect(svg).toContain('>中心</text>');
    expect(svg).toContain('>甲</text>');
  });

  it('等级字号写进 SVG：根 30、一层 18（与屏幕同一组常量）', () => {
    const svg = svgOf(
      mindOf([
        ['中心', '', null],
        ['甲', '', '中心'],
      ]),
    );

    expect(svg).toContain('font-size="30"');
    expect(svg).toContain('font-size="18"');
  });

  it('连线数与父子对一致（含每个方向一条延长线）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
      ['乙', '', '中心'],
    ]);
    const svg = svgOf(file);

    // ★ 按描边颜色数**连线**：节点的标题带也是 `<path>`，按标签数会把它算进去。
    //   两条分支线 + 一条延长线（同方向共用）
    expect(svg.match(/stroke="#b8b8bd"/g)).toHaveLength(3);
  });

  it('★ 每个节点都有边框 + 一层阴影（导出后相邻节点不能糊成一片）', () => {
    const file = mindOf([
      ['中心', '', null],
      ['甲', '', '中心'],
    ]);
    const svg = svgOf(file);

    // 阴影滤镜一份（`<defs>`）
    expect(svg).toContain('feDropShadow');
    // 边框：每个节点一条（`stroke-width="1"` 只出现在边框上）
    expect(svg.match(/stroke-width="1"/g)).toHaveLength(2);
    // 底块挂着滤镜（节点数那么多份）
    expect(svg.match(/filter="url\(#nestboard-mind-node-shadow\)"/g)).toHaveLength(2);
    // ★ 边框要**压在标题带上面**：节点组里最后一条 `<rect … fill="none"` 就是它
    const lastRect = svg.slice(svg.lastIndexOf('<rect'));
    expect(lastRect.startsWith('<rect')).toBe(true);
  });

  it('★ 特殊字符被转义（标题里有 `<` 也不能把 SVG 写坏）', () => {
    const svg = svgOf(mindOf([['a < b & "c"', '', null]]));

    expect(svg).toContain('a &lt; b &amp;');
    expect(svg).not.toContain('a < b &');
  });

  it('★ 底色默认白、传 `null` 就透明（按**底色矩形**判，不是按白色判）', () => {
    const file = mindOf([['中心', '', null]]);

    // ★ 内容块的底色也是纯白（`BODY_SURFACE`），所以只能用 class 认那块画布底
    expect(svgOf(file)).toContain(`class="${MIND_SVG_BG_CLASS}"`);
    expect(svgOf(file, { background: null })).not.toContain(`class="${MIND_SVG_BG_CLASS}"`);
  });
});
