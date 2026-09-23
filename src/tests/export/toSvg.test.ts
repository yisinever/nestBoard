/**
 * 导出 SVG（T6.01 / `F9-06`）单测。
 *
 * 与 `toPng.test.ts` 同一套思路：把"会静默出错"的地方分三层盯住 ——
 *  1. **计划**（`planSvgExport`）：错了就是"少导一块内容 / 尺寸不对"，界面上看不出来；
 *  2. **落盘**（`SvgExporter`）：错了会覆盖用户文件 —— 不可逆，必须有覆盖用例；
 *  3. **绘制**（`renderBoardSvg`）：这里比 PNG 好测得多 —— 产物是**字符串**，
 *     可以直接断言"有没有这个元素、坐标是多少、顺序对不对"，不必像 canvas 那样
 *     用一个记录调用的假上下文去侧面猜。
 */

import { describe, expect, it } from 'vitest';
import {
  SvgExporter,
  clipText,
  escapeXml,
  estimateTextWidth,
  isWideChar,
  planSvgExport,
  renderBoardSvg,
  svgFileName,
} from '../../export/toSvg';
import type { SvgPlan, SvgRenderOptions } from '../../export/toSvg';
import {
  DEFAULT_PNG_PADDING,
  NOTE_DARK_FILL,
  NOTE_DARK_MUTED,
  NOTE_DARK_TEXT,
} from '../../export/toPng';
import type { PngPalette } from '../../export/toPng';
import {
  createBoardFile,
  createCard,
  createColumn,
  createEdge,
  createMind,
} from '../../model/factories';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { BoardFile } from '../../model/schema';
import { textToArrayBuffer } from '../../util/encoding';
import { t } from '../../util/i18n';
import { MemoryVaultIO } from '../helpers/memoryVault';

const palette: PngPalette = {
  background: '#ffffff',
  accent: '#7c3aed',
  pattern: '#dddddd',
  cardFill: '#f5f5f5',
  cardBorder: '#cccccc',
  cardText: '#222222',
  mutedText: '#888888',
  fontFamily: 'sans-serif',
  theme: {
    '1': '#ff0000',
    '2': '#ff8800',
    '3': '#ffcc00',
    '4': '#00aa00',
    '5': '#0066ff',
    '6': '#8800ff',
  },
};

function renderOptions(overrides: Partial<SvgRenderOptions> = {}): SvgRenderOptions {
  return { palette, background: 'plain', gridSize: 100, transparent: false, ...overrides };
}

function planOf(board: BoardFile): SvgPlan {
  return planSvgExport(board, {});
}

/** 一份只有一张卡片的最小可渲染输入 */
function oneCardBoard(): { board: BoardFile; plan: SvgPlan } {
  const board = createBoardFile({
    cards: [createCard('note', { x: 0, y: 0, width: 100, height: 100, content: { md: 'hi' } })],
  });
  return { board, plan: planOf(board) };
}

// ─────────────────────────────────────────────────────────────
// 计划
// ─────────────────────────────────────────────────────────────

describe('planSvgExport', () => {
  it('空板给空计划（调用方据此提示"没有可导出的内容"）', () => {
    const plan = planSvgExport(createBoardFile(), {});
    expect(plan.width).toBe(0);
    expect(plan.height).toBe(0);
  });

  it('板子还没加载出来（null）也给空计划，而不是抛错', () => {
    expect(planSvgExport(null, {}).width).toBe(0);
  });

  it('整块板：内容边界 + 默认留白', () => {
    const { plan } = oneCardBoard();
    expect(plan.bounds).toEqual({
      x: -DEFAULT_PNG_PADDING,
      y: -DEFAULT_PNG_PADDING,
      width: 100 + DEFAULT_PNG_PADDING * 2,
      height: 100 + DEFAULT_PNG_PADDING * 2,
    });
  });

  it('宽高等于边界尺寸：矢量不缩放，1:1 交给查看器', () => {
    const { plan } = oneCardBoard();
    expect(plan.width).toBe(plan.bounds.width);
    expect(plan.height).toBe(plan.bounds.height);
  });

  it('范围=视口：直接用视口矩形', () => {
    const plan = planSvgExport(
      oneCardBoard().board,
      { range: 'viewport' },
      { viewportRect: { x: 10, y: 20, width: 640, height: 480 } },
    );
    expect(plan.bounds).toEqual({ x: 10, y: 20, width: 640, height: 480 });
  });

  it('范围=选中：只包住选中的卡片', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', { id: 'a', x: 0, y: 0, width: 100, height: 100 }),
        createCard('note', { id: 'b', x: 500, y: 500, width: 100, height: 100 }),
      ],
    });
    const plan = planSvgExport(board, { range: 'selection' }, { selection: new Set(['b']) });
    expect(plan.bounds.x).toBe(500 - DEFAULT_PNG_PADDING);
    expect(plan.bounds.width).toBe(100 + DEFAULT_PNG_PADDING * 2);
  });

  it('边界向外对齐到整数（与 PNG 同一套规则，两种格式范围不差半个像素）', () => {
    const board = createBoardFile({
      cards: [createCard('note', { x: 0.4, y: 0.6, width: 100.4, height: 100.4 })],
    });
    const plan = planSvgExport(board, { padding: 0 });
    expect(plan.bounds).toEqual({ x: 0, y: 0, width: 101, height: 101 });
  });
});

// ─────────────────────────────────────────────────────────────
// 文字宽度估算
// ─────────────────────────────────────────────────────────────

describe('isWideChar / estimateTextWidth', () => {
  it('全角算一个字宽', () => {
    expect(isWideChar('中'.codePointAt(0) ?? 0)).toBe(true);
    expect(isWideChar('，'.codePointAt(0) ?? 0)).toBe(true);
    expect(isWideChar('あ'.codePointAt(0) ?? 0)).toBe(true);
  });

  it('半角不算全角', () => {
    expect(isWideChar('a'.codePointAt(0) ?? 0)).toBe(false);
    expect(isWideChar('1'.codePointAt(0) ?? 0)).toBe(false);
  });

  it('两个中文字正好两倍字号', () => {
    expect(estimateTextWidth('中文', 10)).toBe(20);
  });

  it('半角按比例估，比全角窄', () => {
    const narrow = estimateTextWidth('a', 10);
    expect(narrow).toBeGreaterThan(0);
    expect(narrow).toBeLessThan(estimateTextWidth('中', 10));
  });

  it('四个半角字符比两个全角字符宽（估算反映的是"宽度"，不是"个数"）', () => {
    expect(estimateTextWidth('abcd', 10)).toBeGreaterThan(estimateTextWidth('中文', 10));
  });

  it('空串宽度为 0', () => {
    expect(estimateTextWidth('', 10)).toBe(0);
  });

  it('随字号线性放大（估算不能只看字个数）', () => {
    expect(estimateTextWidth('中文', 20)).toBe(estimateTextWidth('中文', 10) * 2);
  });
});

describe('clipText', () => {
  const measure = (value: string): number => value.length * 10;

  it('放得下就原样返回', () => {
    expect(clipText('abc', 100, measure)).toBe('abc');
  });

  it('放不下就裁掉并加省略号', () => {
    expect(clipText('abcdef', 45, measure)).toBe('abc…');
  });

  it('只剩一个字也仍带省略号（与 fillClippedText 的边界一致）', () => {
    expect(clipText('abcdef', 5, measure)).toBe('a…');
  });

  it('宽度为 0 或空串返回空串', () => {
    expect(clipText('abc', 0, measure)).toBe('');
    expect(clipText('', 100, measure)).toBe('');
  });
});

describe('escapeXml', () => {
  it('五个敏感字符全部转义', () => {
    expect(escapeXml('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('普通文字不动', () => {
    expect(escapeXml('便签 1')).toBe('便签 1');
  });
});

// ─────────────────────────────────────────────────────────────
// 绘制
// ─────────────────────────────────────────────────────────────

describe('renderBoardSvg / 文档骨架', () => {
  it('是带 XML 声明的完整文档', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions());
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('根元素带 1:1 的尺寸与 viewBox（世界坐标直接当用户坐标）', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions());
    expect(svg).toContain('width="164"');
    expect(svg).toContain('height="164"');
    expect(svg).toContain('viewBox="-32 -32 164 164"');
  });

  it('有标题时写进 <title>，空标题不写', () => {
    const { plan } = oneCardBoard();
    const named = createBoardFile({ meta: { title: '我的板' } });
    expect(renderBoardSvg(named, plan, renderOptions())).toContain('<title>我的板</title>');

    const unnamed = createBoardFile({ meta: { title: '   ' } });
    expect(renderBoardSvg(unnamed, plan, renderOptions())).not.toContain('<title>');
  });

  it('板子标题里的敏感字符会被转义（否则整份文件打不开）', () => {
    const { plan } = oneCardBoard();
    const board = createBoardFile({ meta: { title: 'a&b' } });
    const svg = renderBoardSvg(board, plan, renderOptions());
    expect(svg).toContain('<title>a&amp;b</title>');
  });
});

describe('renderBoardSvg / 背景', () => {
  it('默认铺一层底色', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions());
    expect(svg).toContain(`fill="#ffffff"`);
  });

  it('背景透明时不铺底色', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions({ transparent: true }));
    expect(svg).not.toContain('<rect x="-32" y="-32" width="164" height="164"');
  });

  it('点阵：写一个 <pattern> 并让底图引用它', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions({ background: 'dots' }));
    expect(svg).toContain('<pattern id="nestboard-pattern"');
    expect(svg).toContain('<circle cx="0" cy="0" r="1.5"');
    expect(svg).toContain('fill="url(#nestboard-pattern)"');
  });

  it('网格：pattern 里画的是两条线，不是圆点', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions({ background: 'grid' }));
    expect(svg).toContain('M 0 0 H 100 M 0 0 V 100');
    expect(svg).not.toContain('<circle');
  });

  it('不再有一格一格画点的上限：图案只有一个元素（这正是 SVG 比 Canvas 省的地方）', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions({ background: 'dots', gridSize: 4 }));
    expect(svg.match(/<circle/g)).toHaveLength(1);
  });

  it('纯色背景不出图案', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions({ background: 'plain' }));
    expect(svg).not.toContain('<pattern');
  });

  it('格子小于 4px 时不画图案（画了也是噪点，与 PNG 同一道闸门）', () => {
    const { board, plan } = oneCardBoard();
    const svg = renderBoardSvg(board, plan, renderOptions({ background: 'dots', gridSize: 2 }));
    expect(svg).not.toContain('<pattern');
  });

  it('未指定背景时回落到板子自己的设置', () => {
    const board = createBoardFile({
      view: { background: 'grid' },
      cards: [createCard('note', { x: 0, y: 0, width: 100, height: 100 })],
    });
    const svg = renderBoardSvg(board, planOf(board), {
      palette,
      gridSize: 100,
    });
    expect(svg).toContain('<pattern id="nestboard-pattern"');
  });
});

describe('renderBoardSvg / 分栏', () => {
  it('画底板 + 标题栏分隔线 + 标题', () => {
    const board = createBoardFile({
      columns: [createColumn({ x: 0, y: 0, width: 300, height: 500, title: '待办' })],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('rx="8" ry="8"');
    expect(svg).toContain('M 0 24 H 300');
    expect(svg).toContain('>待办</text>');
  });

  it('空标题用占位文案（与画布上看到的一致）', () => {
    const board = createBoardFile({
      columns: [createColumn({ x: 0, y: 0, width: 300, height: 500, title: '  ' })],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain(t('column.title.placeholder'));
  });
});

describe('renderBoardSvg / 卡片', () => {
  it('三层：底板 → 主题色淡底 → 边框', () => {
    const board = createBoardFile({
      cards: [createCard('note', { x: 0, y: 0, width: 100, height: 100, color: '1' })],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('fill="#f5f5f5"');
    expect(svg).toContain('fill="#ff0000" fill-opacity="0.14"');
    expect(svg).toContain('fill="none" stroke="#ff0000" stroke-width="1"');
  });

  it('主题色号走调色板，自定义 hex 直接落进 SVG', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', { id: 'a', x: 0, y: 0, width: 100, height: 100, color: '5' }),
        createCard('note', { id: 'b', x: 200, y: 0, width: 100, height: 100, color: '#123456' }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('stroke="#0066ff"');
    expect(svg).toContain('stroke="#123456"');
  });

  it('锁定的卡片边框走虚线', () => {
    const board = createBoardFile({
      cards: [createCard('note', { x: 0, y: 0, width: 100, height: 100, locked: true })],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('stroke-dasharray="4 3"');
  });

  it('强调条是直角的（canvas 用 fillRect，不跟卡片一起圆角）', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', { x: 0, y: 0, width: 100, height: 100, color: '4', accent: '#abcdef' }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('width="4" height="100" fill="#abcdef"');
  });

  it('强调色非法时回退到主题色，而不是写出一个坏颜色', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          color: '3',
          accent: 'not-a-color',
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('width="4" height="100" fill="#ffcc00"');
  });

  it('showTitle 关掉时不出标题文字', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          title: '不该出现',
          showTitle: false,
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).not.toContain('不该出现');
  });

  it('showTitle 打开时标题写在卡片里', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          title: '标题',
          showTitle: true,
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('>标题</text>');
  });

  it('★ 深色便签（O06）：底色换成深色，且**不再铺那层主题色淡底**', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          color: '1',
          content: { md: 'hi', variant: 'dark' },
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    expect(svg).toContain(`fill="${NOTE_DARK_FILL}"`);
    // 14% 的主题色覆盖在近黑底上会把黑染成"深红"——屏幕上那张卡就是纯粹的黑
    expect(svg).not.toContain('fill="#ff0000" fill-opacity="0.14"');
    // 边框仍走卡片自己的颜色：深色只改"底有多暗"
    expect(svg).toContain('stroke="#ff0000"');
  });

  it('★ 深色便签：标题与正文换成浅色（否则近黑底上是黑字）', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          title: '标题',
          showTitle: true,
          content: { md: '正文', variant: 'dark' },
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    expect(svg).toContain(`fill="${NOTE_DARK_TEXT}"`);
    expect(svg).toContain(`fill="${NOTE_DARK_MUTED}"`);
    expect(svg).not.toContain(`fill="${palette.cardText}"`);
    expect(svg).not.toContain(`fill="${palette.mutedText}"`);
  });

  it('浅色便签一点都不受影响（`light` 与"没写过变体"同一条路）', () => {
    for (const content of [{ md: 'hi' }, { md: 'hi', variant: 'light' as const }]) {
      const board = createBoardFile({
        cards: [createCard('note', { x: 0, y: 0, width: 100, height: 100, color: '1', content })],
      });
      const svg = renderBoardSvg(board, planOf(board), renderOptions());
      expect(svg).toContain('fill="#ff0000" fill-opacity="0.14"');
      expect(svg).not.toContain(NOTE_DARK_FILL);
    }
  });

  it('正文受 maxLines 限制（不画到卡片外面去）', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `第 ${index} 行`);
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 400,
          height: 400,
          content: { md: lines.join('\n') },
        }),
      ],
    });
    const two = renderBoardSvg(board, planOf(board), renderOptions({ maxLines: 2 }));
    const six = renderBoardSvg(board, planOf(board), renderOptions());
    expect(two.match(/<text/g)?.length).toBe(2);
    expect(six.match(/<text/g)?.length).toBe(6);
  });

  it('卡片按 z 排序：后画的压在先画的上面', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          id: 'top',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z: 9,
          title: '在上',
          showTitle: true,
        }),
        createCard('note', {
          id: 'low',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z: 1,
          title: '在下',
          showTitle: true,
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg.indexOf('在下')).toBeLessThan(svg.indexOf('在上'));
  });

  it('图片卡降级为文字：不内嵌位图，但仍留下说明（见文件头的取舍）', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', {
          x: 0,
          y: 0,
          width: 320,
          height: 240,
          content: { path: 'assets/pic.png', caption: '一张图' },
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('base64');
    expect(svg).toContain('一张图');
  });

  it('地图卡同样降级为文字：不内嵌位图，地点名留着', () => {
    const board = createBoardFile({
      cards: [
        createCard('map', {
          x: 0,
          y: 0,
          width: 320,
          height: 240,
          content: { path: 'assets/map.png', label: '深圳湾' },
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('base64');
    expect(svg).toContain('深圳湾');
  });

  it('卡片文本里的尖括号与 & 被转义', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          content: { md: 'a < b & c > d' },
        }),
      ],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('a &lt; b &amp; c &gt; d');
  });
});

describe('renderBoardSvg / 连线', () => {
  function edgeBoard(overrides: Parameters<typeof createEdge>[2] = {}): BoardFile {
    return createBoardFile({
      cards: [
        createCard('note', { id: 'a', x: 0, y: 0, width: 100, height: 100 }),
        createCard('note', { id: 'b', x: 300, y: 0, width: 100, height: 100 }),
      ],
      edges: [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null }, overrides)],
    });
  }

  it('实线：一条 path，没有虚线样式', () => {
    const board = edgeBoard();
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('stroke-width="1.6"');
    expect(svg).not.toContain('stroke-dasharray="6 4"');
  });

  it('虚线：path 带 dasharray', () => {
    const board = edgeBoard({ style: 'dashed' });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('stroke-dasharray="6 4"');
  });

  it('箭头端画一个三角形（填充色与线同色）', () => {
    const board = edgeBoard({ toEnd: 'arrow', color: '2' });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('<polygon points=');
    expect(svg).toContain('fill="#ff8800"');
  });

  it('两端都是箭头时画两个三角形', () => {
    const board = edgeBoard({ fromEnd: 'arrow', toEnd: 'arrow' });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg.match(/<polygon/g)).toHaveLength(2);
  });

  it('两端都不带箭头时一个三角形都没有', () => {
    const board = edgeBoard({ fromEnd: 'none', toEnd: 'none' });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).not.toContain('<polygon');
  });

  it('★ 箭头尖端落在锚点上、两翼回在线的一侧（朝卡片里，不是朝回线里）', () => {
    // 锚点 (100,50) → (300,50)：箭头长 8、两翼半宽 3.6
    const to = edgeBoard({ toEnd: 'arrow' });
    expect(renderBoardSvg(to, planOf(to), renderOptions())).toContain(
      '<polygon points="300,50 292,53.6 292,46.4"',
    );

    const from = edgeBoard({ fromEnd: 'arrow', toEnd: 'none' });
    // 两端的箭头方向**相反**（各朝各自那张卡）；同向的话说明其中一端的符号反了
    expect(renderBoardSvg(from, planOf(from), renderOptions())).toContain(
      '<polygon points="100,50 108,46.4 108,53.6"',
    );
  });

  it('★ 带箭头的一端把线**收短**（不收的话线的末端会从箭头底下伸出去）', () => {
    const board = edgeBoard({ toEnd: 'arrow' });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    // 300 收到 300 - 8 = 292；符号写反的话这里会是 308
    expect(svg).toContain('d="M 100 50 L 292 50"');
  });

  it('端点取不到几何的连线被跳过（不在角落画一堆通往原点的乱线）', () => {
    const board = createBoardFile({
      cards: [createCard('note', { id: 'a', x: 0, y: 0, width: 100, height: 100 })],
      edges: [createEdge({ cardId: 'a', side: null }, { cardId: 'missing', side: null })],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).not.toContain('<path d="M ');
    expect(svg).not.toContain('<polygon');
  });

  it('★ 端点是**分栏**的连线照样画出来（`O21`：矩形查表里必须有分栏）', () => {
    const board = createBoardFile({
      columns: [{ ...createColumn({ x: 0, y: 300, width: 400, height: 200 }), id: 'col' }],
      cards: [createCard('note', { id: 'a', x: 0, y: 0, width: 100, height: 100 })],
      edges: [
        createEdge(
          { cardId: 'a', side: 'bottom' },
          { cardId: 'col', side: 'top' },
          {
            fromEnd: 'none',
            toEnd: 'none',
          },
        ),
      ],
    });
    // a 的下边中点 (50,100) → 分栏的上边中点 (200,300)。
    // 查表漏收分栏的话，这里连 `<path d="M ` 都不会有 —— 数据里有、导出物里没有
    expect(renderBoardSvg(board, planOf(board), renderOptions())).toContain(
      'd="M 50 100 L 200 300"',
    );
  });
});

describe('renderBoardSvg / 连线标签（T7.13）', () => {
  /** 两张左右并排的卡片：中点恰好落在 (200, 50)，断言起来不用心算 */
  function labeledBoard(overrides: Parameters<typeof createEdge>[2] = {}): BoardFile {
    return createBoardFile({
      cards: [
        createCard('note', { id: 'a', x: 0, y: 0, width: 100, height: 100 }),
        createCard('note', { id: 'b', x: 300, y: 0, width: 100, height: 100 }),
      ],
      edges: [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null }, overrides)],
    });
  }

  it('标签落在线段中点，文字用线的颜色，垫一块与背景同色的圆角底', () => {
    const board = labeledBoard({ label: '依赖', color: '2' });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    // 锚点 = a.right (100,50) 与 b.left (300,50) 的中点
    expect(svg).toContain(
      '<text x="200" y="50" fill="#ff8800" font-size="11" font-weight="400" dominant-baseline="central" text-anchor="middle">依赖</text>',
    );
    // 底块：高 = 字号 11 + 上下内边距 2×2 = 15，圆角 4，颜色取画布背景色
    expect(svg).toMatch(
      /<rect x="[\d.-]+" y="42.5" width="[\d.]+" height="15" rx="4" ry="4" fill="#ffffff"\/>/,
    );
    // ★ 顺序：标签压在自己的线上。底块盖不住线的话，与线重合的那一两个笔画会被线吃掉
    expect(svg.indexOf('stroke-width="1.6"')).toBeLessThan(svg.indexOf('依赖'));
  });

  it('★ 曲线标签落在曲线中点（`t = 0.5`）而不是弦中点', () => {
    const board = labeledBoard({ label: '弯', curve: { along: 0, perp: 0.2 } });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    // 弦长 200 × perp 0.2 = 40 → 控制点 (200, 90)，`t = 0.5` 处是 (200, 70)。
    // 按弦算会得到 (200, 50) —— 差 20px，标签会飘在曲线下方
    expect(svg).toContain('<text x="200" y="70"');
    expect(svg).not.toContain('<text x="200" y="50"');
  });

  it('空标签不画任何元素（`\'\'` 与"没有标签"在渲染上等价）', () => {
    const board = labeledBoard({ label: '' });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).not.toContain('text-anchor="middle"');
    // 线还是照画（只是没有标签），别把"没有标签"做成了"整条线不画"
    expect(svg).toContain('stroke-width="1.6"');
  });

  it('超长标签截断加省略号，不把整段写进去（否则压成一块方砖盖住线）', () => {
    const long = '非常长的连线标签'.repeat(6);
    const board = labeledBoard({ label: long });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('…</text>');
    expect(svg).not.toContain(long);
  });

  it('标签里的 `&` 被转义（漏掉一个就让整份文件打不开，而不是画错一笔）', () => {
    const board = labeledBoard({ label: 'a & b' });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    expect(svg).toContain('a &amp; b');
  });
});

describe('renderBoardSvg / 层次', () => {
  it('背景 → 分栏 → 连线 → 卡片，与画布上的压盖关系一致', () => {
    const board = createBoardFile({
      columns: [createColumn({ x: 0, y: 0, width: 300, height: 500, title: '栏' })],
      cards: [
        createCard('note', { id: 'a', x: 10, y: 10, width: 80, height: 60 }),
        createCard('note', { id: 'b', x: 200, y: 200, width: 80, height: 60 }),
      ],
      edges: [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null })],
    });
    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    const background = svg.indexOf('fill="#ffffff"');
    const column = svg.indexOf('>栏</text>');
    const edge = svg.indexOf('stroke-width="1.6"');
    const card = svg.indexOf('fill-opacity="0.14"');

    expect(background).toBeGreaterThanOrEqual(0);
    expect(background).toBeLessThan(column);
    expect(column).toBeLessThan(edge);
    expect(edge).toBeLessThan(card);
  });
});

/**
 * 白板级脑图进 SVG（`2.2.0` 批 4）。
 *
 * 与 PNG 那一组同一条理由：脑图不再是一张卡之后，导出图里那棵树必须**还在**。
 * ★ SVG 这里还能多钉一件事：分支线用的是脑图那边**原样的 `d` 字符串**
 *   （`edgePathOf`），所以断言"C 命令"就等于在说"导出与屏幕画的是同一条曲线"。
 */
describe('renderBoardSvg / 白板级脑图', () => {
  /** 一棵"根 + 2 个分支"的内嵌脑图，落脚 `(100, 100)` */
  function mindBoard(): { board: BoardFile; branchId: string } {
    const model = createMindFile({ rootText: '中心' });
    model.nodes.push(createMindNode({ parentId: model.rootId, text: '甲', order: 0 }));
    model.nodes.push(createMindNode({ parentId: model.rootId, text: '乙', order: 1 }));
    const board = createBoardFile();
    board.minds = [createMind({ x: 100, y: 100, path: '', mind: model })];
    return { board, branchId: model.nodes[1].id };
  }

  it('★★ 树画进去了：分支线（曲线）+ 节点文字，且整棵按锚点平移', () => {
    const { board } = mindBoard();
    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    // 父子连线：SVG 直接复用原样的 `d`（含三次贝塞尔）
    expect(svg).toContain(' C ');
    expect(svg).toContain('translate(');
    expect(svg).toContain('>中心</text>');
    expect(svg).toContain('>甲</text>');
  });

  it('★ 只有一棵树的板子也能导出（取景把它算进去了）', () => {
    const { board } = mindBoard();
    const plan = planOf(board);
    // 从前 `boardContentBounds` 只认卡片 / 分栏 ⇒ 这种板子会被判成"没有内容可导"
    expect(plan.width).toBeGreaterThan(0);
    expect(plan.height).toBeGreaterThan(0);
  });

  it('★ 文件脑图没给模型 ⇒ 不画（也不参与取景）', () => {
    const board = createBoardFile();
    board.minds = [createMind({ x: 100, y: 100, path: 'Minds/一份.nestmind' })];
    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    expect(svg).not.toContain('>中心</text>');
    expect(planOf(board).width).toBe(0);
  });

  it('★ 指着**节点**的连线也画得出来（端点表里有节点）', () => {
    const { board, branchId } = mindBoard();
    const mindId = board.minds![0].id;
    board.cards = [createCard('note', { id: 'c_1', x: 0, y: 0, width: 80, height: 60 })];
    board.edges = [
      createEdge({ cardId: 'c_1', side: null }, { cardId: mindId, nodeId: branchId, side: null }),
    ];

    const svg = renderBoardSvg(board, planOf(board), renderOptions());
    // 那条线的端点落在节点上（而不是落在整棵脑图的锚点某处）：线本身在 ≠ 说明不了，
    // 所以再给一块"端点指向不存在的节点"的板子做差集
    const ghost = createBoardFile();
    ghost.cards = board.cards;
    ghost.minds = board.minds;
    ghost.edges = [
      createEdge({ cardId: 'c_1', side: null }, { cardId: mindId, nodeId: 'n_不存在', side: null }),
    ];
    const without = renderBoardSvg(ghost, planOf(ghost), renderOptions());

    expect(svg.length).toBeGreaterThan(without.length);
  });
});

// ─────────────────────────────────────────────────────────────
// 落盘
// ─────────────────────────────────────────────────────────────

describe('svgFileName', () => {
  it('单文件命名', () => {
    expect(svgFileName('白板')).toBe('白板.svg');
  });
});

describe('textToArrayBuffer', () => {
  it('中文按 UTF-8 编码后可原样读回', () => {
    const svg = '<svg>便签</svg>';
    const buffer = textToArrayBuffer(svg);
    expect(new TextDecoder().decode(buffer)).toBe(svg);
  });

  it('字节长度按 UTF-8 计（一个中文 3 字节），不是字符数', () => {
    expect(textToArrayBuffer('中').byteLength).toBe(3);
  });
});

describe('SvgExporter', () => {
  it('写入 Vault 并返回实际路径', async () => {
    const vault = new MemoryVaultIO();
    const path = await new SvgExporter(vault).export('<svg/>', { folder: 'Boards', name: '白板' });
    expect(path).toBe('Boards/白板.svg');
    expect(vault.binaries.size).toBe(1);
    expect(new TextDecoder().decode(vault.binaries.get(path))).toBe('<svg/>');
  });

  it('根目录导出不带前导斜杠', async () => {
    const vault = new MemoryVaultIO();
    expect(await new SvgExporter(vault).export('<svg/>', { folder: '', name: '白板' })).toBe(
      '白板.svg',
    );
  });

  it('已存在同名文件时顺延编号，绝不覆盖', async () => {
    const vault = new MemoryVaultIO();
    // 先占住 `白板.svg`（可能是用户自己的图）
    await vault.createBinary('Boards/白板.svg', new ArrayBuffer(1));
    const path = await new SvgExporter(vault).export('<svg/>', { folder: 'Boards', name: '白板' });
    expect(path).toBe('Boards/白板 2.svg');
    // 原文件还在，且内容没被动过
    expect((vault.binaries.get('Boards/白板.svg') as ArrayBuffer).byteLength).toBe(1);
  });

  it('目录末尾多写的斜杠不会拼出双斜杠', async () => {
    const vault = new MemoryVaultIO();
    expect(await new SvgExporter(vault).export('<svg/>', { folder: 'Boards/', name: 'x' })).toBe(
      'Boards/x.svg',
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 卡片旋转（T7.06 / `F2-00-10`）
//
// 两种格式（PNG / SVG）必须长得一样，所以这里同时钉两件事：
//  1. 卡片整体**用一个 `<g>` 转**，而不是逐个元素算坐标（后者迟早与画布分岔）；
//  2. 连到转过卡片上的线，锚点跟着转（否则线会插进卡片里）。
// ─────────────────────────────────────────────────────────────

describe('renderBoardSvg · 卡片旋转', () => {
  it('没转过：一个 `<g>` 都不多套（存量白板的产物逐字节不变）', () => {
    const { board, plan } = oneCardBoard();

    expect(renderBoardSvg(board, plan, renderOptions())).not.toContain('<g transform="rotate(');
  });

  it('★ 转过：整张卡套进 `<g>`，绕**卡片中心**转（正方向是顺时针）', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 30,
          content: { md: 'hi' },
        }),
      ],
    });

    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    expect(svg).toContain('<g transform="rotate(30 50 50)">');
    expect(svg).toContain('</g>');
  });

  it('★ 布局几何一个数字都不改（转一下不该让卡片"变大"）', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 45,
          content: { md: 'hi' },
        }),
      ],
    });

    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    // 底板仍是 100×100：只有外面的 `<g>` 在转，没有把外接框写进几何
    expect(svg).toContain('width="100" height="100"');
  });

  it('★ 连到转过的卡片上的线：锚点跟着转（不是插进卡片里）', () => {
    const from = createCard('note', {
      id: 'a',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      rotation: 90,
    });
    const to = createCard('note', { id: 'b', x: 500, y: 400, width: 100, height: 100 });
    const edge = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' });
    const board = createBoardFile({ cards: [from, to], edges: [edge] });

    const svg = renderBoardSvg(board, planOf(board), renderOptions());

    // `a` 的 `right` 锚点 (200, 50) 绕中心 (100, 50) 转 90° → (100, 150)；
    // 不转的话是 (200, 50) —— 那条线会从卡片**内部**长出来。
    // 只断起点：终点那侧默认带箭头，`b.left` 会被箭头长度裁短（450 那端不是精确的 500 450）。
    expect(svg).toContain('d="M 100 150 L ');
  });
});
