/**
 * 导出 PNG（T2.11 / `F9-02`）单测。
 *
 * 分成三层，各自盯一类会静默出错的地方：
 *  1. **几何**（`boardContentBounds` / `resolveExportBounds` / `planPngExport`）：
 *     错了就是"少导一块内容"或"导出图尺寸不对"，但界面上完全看不出来；
 *  2. **落盘**（`PngExporter`）：错了会覆盖用户文件 —— 不可逆，必须有覆盖用例；
 *  3. **绘制**（`renderTile`）：用假的 2D 上下文记录调用，保证"不抛 + 该画的都画了"。
 *     node 下没有 canvas，真像素没法断言，但"漏画背景/漏裁剪"这类结构性错误抓得住。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PNG_PADDING,
  DEFAULT_PNG_SCALE,
  DEFAULT_PNG_TILE_SIZE,
  HARD_MAX_CANVAS_SIDE,
  NOTE_DARK_FILL,
  PngExporter,
  boardContentBounds,
  boundsOfCard,
  cardPreview,
  NOTE_LIGHT_FILL,
  isDarkNoteCard,
  planPngExport,
  pngFileName,
  rectOfCard,
  rectOfColumn,
  renderTile,
  resolveExportBounds,
  wrapText,
} from '../../export/toPng';
import type { PngPalette, PngRenderOptions } from '../../export/toPng';
import { createBoardFile, createCard, createColumn, createEdge } from '../../model/factories';
import type { BoardFile, Card } from '../../model/schema';
import { MemoryVaultIO } from '../helpers/memoryVault';

// ─────────────────────────────────────────────────────────────
// 假 2D 上下文：只记录调用，不做像素
// ─────────────────────────────────────────────────────────────

class FakeContext {
  readonly ops: string[] = [];
  /** `drawImage` 的实参（九参形式时用来断言"裁的是哪一块"） */
  readonly images: unknown[][] = [];
  /** `arc` 的实参（目前只有地图卡图钉用它：底 + 点两圈） */
  readonly arcs: unknown[][] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  globalAlpha = 1;
  lineCap = '';

  /** 画布变换的实参（卡片旋转，T7.06）：断言"绕哪个点转、转了多少" */
  readonly transforms: string[] = [];

  /**
   * 每次 `fill()` 当时用的填充色。
   *
   * ★ 卡片底色是"三层叠出来"的（底板 → 主题色淡底 → 边框），而 `ops` 只看得到
   *   "填了几次" —— 深色便签（`O06`）要钉的恰恰是"底是深色**且少了一层**"，
   *   所以这一串色值本身就是断言对象。
   */
  readonly fills: string[] = [];

  save(): void {
    this.ops.push('save');
  }
  restore(): void {
    this.ops.push('restore');
  }
  translate(x: number, y: number): void {
    this.ops.push('translate');
    this.transforms.push(`translate(${x}, ${y})`);
  }
  rotate(angle: number): void {
    this.ops.push('rotate');
    this.transforms.push(`rotate(${angle})`);
  }
  beginPath(): void {
    this.ops.push('beginPath');
  }
  closePath(): void {
    this.ops.push('closePath');
  }
  rect(): void {
    this.ops.push('rect');
  }
  clip(): void {
    this.ops.push('clip');
  }
  setTransform(): void {
    this.ops.push('setTransform');
  }
  fill(): void {
    this.ops.push('fill');
    this.fills.push(String(this.fillStyle));
  }
  stroke(): void {
    this.ops.push('stroke');
  }
  fillRect(): void {
    this.ops.push('fillRect');
  }
  arc(...args: unknown[]): void {
    this.ops.push('arc');
    this.arcs.push(args);
  }
  moveTo(): void {
    this.ops.push('moveTo');
  }
  lineTo(): void {
    this.ops.push('lineTo');
  }
  arcTo(): void {
    this.ops.push('arcTo');
  }
  setLineDash(): void {
    this.ops.push('setLineDash');
  }
  drawImage(...args: unknown[]): void {
    this.ops.push('drawImage');
    this.images.push(args);
  }
  fillText(text: string): void {
    this.ops.push(`fillText:${text}`);
  }
  measureText(text: string): { width: number } {
    // 等宽近似即可：折行/裁切只需要一个稳定的宽度
    return { width: text.length * 6 };
  }
}

function fakeContext(): {
  ctx: CanvasRenderingContext2D;
  ops: string[];
  images: unknown[][];
  arcs: unknown[][];
  transforms: string[];
  fills: string[];
} {
  const fake = new FakeContext();
  return {
    ctx: fake as unknown as CanvasRenderingContext2D,
    ops: fake.ops,
    images: fake.images,
    arcs: fake.arcs,
    transforms: fake.transforms,
    fills: fake.fills,
  };
}

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
    '5': '#00aaaa',
    '6': '#8800ff',
  },
};

function renderOptions(overrides: Partial<PngRenderOptions> = {}): PngRenderOptions {
  return {
    scale: 1,
    transparent: false,
    background: 'dots',
    gridSize: 100,
    palette,
    ...overrides,
  };
}

/** 单张卡片的板，卡片从 (0,0) 起 */
function oneCardBoard(): BoardFile {
  return createBoardFile({
    cards: [createCard('note', { content: { md: 'hello' }, width: 100, height: 100 })],
  });
}

// ─────────────────────────────────────────────────────────────
// 几何
// ─────────────────────────────────────────────────────────────

describe('rectOfCard / rectOfColumn', () => {
  it('分栏折叠时用显示高度（与画布上看到的保持一致）', () => {
    const expanded = createColumn({ x: 10, y: 20, width: 300, height: 500 });
    expect(rectOfColumn(expanded)).toEqual({ x: 10, y: 20, width: 300, height: 500 });

    const collapsed = createColumn({ x: 10, y: 20, width: 300, height: 500, collapsed: true });
    // 折叠态只留标题栏，导出时也必须只有标题栏那么高
    expect(rectOfColumn(collapsed).height).toBeLessThan(500);
  });

  it('卡片矩形直接取字段', () => {
    const card = createCard('note', { x: 5, y: 6, width: 7, height: 8 });
    expect(rectOfCard(card)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });
});

describe('boardContentBounds', () => {
  it('空板返回 null（调用方据此给"没内容可导"）', () => {
    expect(boardContentBounds(createBoardFile())).toBeNull();
  });

  it('并集同时覆盖卡片与分栏', () => {
    const board = createBoardFile({
      cards: [createCard('note', { x: 100, y: 100, width: 100, height: 100 })],
      columns: [createColumn({ x: 0, y: 0, width: 50, height: 50 })],
    });
    expect(boardContentBounds(board)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });
});

describe('resolveExportBounds', () => {
  it('范围=整块板：内容边界 + 默认留白', () => {
    const bounds = resolveExportBounds(oneCardBoard(), { range: 'all' });
    expect(bounds).toEqual({
      x: -DEFAULT_PNG_PADDING,
      y: -DEFAULT_PNG_PADDING,
      width: 100 + DEFAULT_PNG_PADDING * 2,
      height: 100 + DEFAULT_PNG_PADDING * 2,
    });
  });

  it('范围=视口：原样返回视口矩形，不额外留白', () => {
    const viewport = { x: -1000, y: -1000, width: 800, height: 600 };
    expect(
      resolveExportBounds(oneCardBoard(), { range: 'viewport' }, { viewportRect: viewport }),
    ).toEqual(viewport);
  });

  it('范围=视口但没有视口时退化为整块板', () => {
    expect(resolveExportBounds(oneCardBoard(), { range: 'viewport' })).toEqual(
      resolveExportBounds(oneCardBoard(), { range: 'all' }),
    );
  });

  it('范围=选中：只包住选中的卡片（含留白）', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', { id: 'a', x: 0, y: 0, width: 100, height: 100 }),
        createCard('note', { id: 'b', x: 500, y: 500, width: 100, height: 100 }),
      ],
    });
    const bounds = resolveExportBounds(
      board,
      { range: 'selection' },
      { selection: new Set(['b']) },
    );
    expect(bounds).toEqual({
      x: 500 - DEFAULT_PNG_PADDING,
      y: 500 - DEFAULT_PNG_PADDING,
      width: 100 + DEFAULT_PNG_PADDING * 2,
      height: 100 + DEFAULT_PNG_PADDING * 2,
    });
  });

  it('范围=选中但选区为空：退化为整块板，而不是报错', () => {
    const board = oneCardBoard();
    expect(resolveExportBounds(board, { range: 'selection' }, { selection: new Set() })).toEqual(
      resolveExportBounds(board, { range: 'all' }),
    );
  });
});

describe('planPngExport', () => {
  it('空边界 → 没有 tile', () => {
    const plan = planPngExport(null, {});
    expect(plan.tiles).toEqual([]);
    expect(plan.columns).toBe(0);
    expect(plan.rows).toBe(0);
  });

  it('内容装得下时只有一块', () => {
    const plan = planPngExport({ x: 0, y: 0, width: 1000, height: 800 }, { scale: 2 });
    expect(plan.tiles).toHaveLength(1);
    expect(plan.columns).toBe(1);
    expect(plan.rows).toBe(1);
    // 4096 / 2 = 每块世界边长 2048，1000 宽只需一块
    expect(plan.scale).toBe(2);
  });

  it('超宽内容按网格切页，且每块像素边长不超过目标值', () => {
    const plan = planPngExport(
      { x: 0, y: 0, width: 10000, height: 100 },
      { scale: 2, maxTileSize: DEFAULT_PNG_TILE_SIZE },
    );
    expect(plan.columns).toBe(5);
    expect(plan.rows).toBe(1);
    expect(plan.tiles).toHaveLength(5);
    for (const tile of plan.tiles) {
      expect(Math.round(tile.width * plan.scale)).toBeLessThanOrEqual(DEFAULT_PNG_TILE_SIZE);
      expect(Math.round(tile.height * plan.scale)).toBeLessThanOrEqual(DEFAULT_PNG_TILE_SIZE);
    }
  });

  it('相邻 tile 重叠或严丝合缝，绝不留下缝隙', () => {
    const plan = planPngExport({ x: 0, y: 0, width: 10000, height: 5000 }, { scale: 2 });
    const row = (r: number) =>
      plan.tiles.filter((tile) => tile.row === r).sort((a, b) => a.x - b.x);
    for (let r = 0; r < plan.rows; r += 1) {
      const line = row(r);
      for (let i = 0; i + 1 < line.length; i += 1) {
        expect(line[i].x + line[i].width).toBeGreaterThanOrEqual(line[i + 1].x);
      }
    }
    const columnTiles = plan.tiles.filter((tile) => tile.column === 0).sort((a, b) => a.y - b.y);
    for (let i = 0; i + 1 < columnTiles.length; i += 1) {
      expect(columnTiles[i].y + columnTiles[i].height).toBeGreaterThanOrEqual(columnTiles[i + 1].y);
    }
  });

  it('倍率被钳制到 1–4', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    expect(planPngExport(bounds, { scale: 99 }).scale).toBe(4);
    expect(planPngExport(bounds, { scale: 0 }).scale).toBe(1);
    expect(planPngExport(bounds, {}).scale).toBe(DEFAULT_PNG_SCALE);
  });

  it('单页全景：只有一块', () => {
    const plan = planPngExport(
      { x: 0, y: 0, width: 3000, height: 2000 },
      { paginate: false, scale: 2 },
    );
    expect(plan.tiles).toHaveLength(1);
    expect(plan.columns).toBe(1);
    expect(plan.rows).toBe(1);
    expect(plan.scale).toBe(2);
  });

  it('单页全景：内容过大时反过来压低倍率（绝不给出超过硬上限的画布）', () => {
    const plan = planPngExport(
      { x: 0, y: 0, width: 100000, height: 100 },
      { paginate: false, scale: 4 },
    );
    expect(plan.scale).toBeLessThan(4);
    expect(plan.tiles[0].width * plan.scale).toBeLessThanOrEqual(HARD_MAX_CANVAS_SIDE + 1);
  });

  it('tile 带页序下标（命名与提示要用）', () => {
    const plan = planPngExport({ x: 0, y: 0, width: 10000, height: 5000 }, { scale: 2 });
    expect(plan.tiles.map((tile) => tile.index)).toEqual(plan.tiles.map((_, index) => index));
    expect(plan.tiles[0].index).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 落盘
// ─────────────────────────────────────────────────────────────

describe('pngFileName', () => {
  it('单张不带编号，多张带编号', () => {
    expect(pngFileName('白板', 0, 1)).toBe('白板.png');
    expect(pngFileName('白板', 0, 3)).toBe('白板 1.png');
    expect(pngFileName('白板', 2, 3)).toBe('白板 3.png');
  });
});

describe('PngExporter', () => {
  it('多张按页序命名并写入 Vault', async () => {
    const vault = new MemoryVaultIO();
    const paths = await new PngExporter(vault).export(
      [new ArrayBuffer(4), new ArrayBuffer(4), new ArrayBuffer(4)],
      { folder: 'Boards', name: '白板' },
    );
    expect(paths).toEqual(['Boards/白板 1.png', 'Boards/白板 2.png', 'Boards/白板 3.png']);
    expect(vault.binaries.size).toBe(3);
    expect(await vault.exists('Boards/白板 2.png')).toBe(true);
  });

  it('根目录导出不带前导斜杠', async () => {
    const vault = new MemoryVaultIO();
    const paths = await new PngExporter(vault).export([new ArrayBuffer(4)], {
      folder: '',
      name: '白板',
    });
    expect(paths).toEqual(['白板.png']);
  });

  it('已存在同名文件时顺延，绝不覆盖', async () => {
    const vault = new MemoryVaultIO();
    // 先占住 `白板.png`（可能是用户自己的图）
    await vault.createBinary('Boards/白板.png', new ArrayBuffer(1));
    const paths = await new PngExporter(vault).export([new ArrayBuffer(4)], {
      folder: 'Boards',
      name: '白板',
    });
    expect(paths).toEqual(['Boards/白板 2.png']);
    // 原文件还在，且内容没被动过
    expect((vault.binaries.get('Boards/白板.png') as ArrayBuffer).byteLength).toBe(1);
  });

  it('没有图片时不写任何文件', async () => {
    const vault = new MemoryVaultIO();
    expect(await new PngExporter(vault).export([], { folder: 'Boards', name: '白板' })).toEqual([]);
    expect(vault.binaries.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 文本与预览
// ─────────────────────────────────────────────────────────────

describe('wrapText', () => {
  const measure = (text: string) => text.length * 10;

  it('按可用宽度折行', () => {
    expect(wrapText(measure, 'abcdef', 30)).toEqual(['abc', 'def']);
  });

  it('放不下时仍保留超长单字符（不会死循环）', () => {
    expect(wrapText(measure, 'x', 1)).toEqual(['x']);
  });

  it('空文本与零宽度返回空数组', () => {
    expect(wrapText(measure, '', 100)).toEqual([]);
    expect(wrapText(measure, 'abc', 0)).toEqual([]);
  });
});

describe('cardPreview', () => {
  it('便签按行输出正文', () => {
    const card = createCard('note', { content: { md: 'first\n\nsecond' } });
    expect(cardPreview(card).lines).toEqual(['first', '', 'second']);
  });

  it('引用卡标签含子路径', () => {
    const card = createCard('noteRef', {
      content: { path: 'Notes/a.md', subpath: '#Head' },
    });
    expect(cardPreview(card).label).toBe('Notes/a.md#Head');
  });

  it('待办把勾选状态画进文本', () => {
    const card = createCard('todo', {
      content: {
        title: 'T',
        items: [
          { text: 'done', done: true },
          { text: 'todo', done: false },
        ],
      },
    });
    const preview = cardPreview(card);
    expect(preview.lines).toEqual(['[x] done', '[ ] todo']);
  });

  it('★ 色板把每一格写成文本（`O07`：渐变就是那行 CSS，导出图里仍可读可 grep）', () => {
    const card = createCard('swatch', {
      content: {
        colors: [
          '#4c8dff',
          {
            type: 'linear',
            angle: 90,
            stops: [
              { color: '#ff0000', position: 0 },
              { color: '#0000ff', position: 100 },
            ],
          },
        ],
      },
    });
    expect(cardPreview(card).lines).toEqual([
      '#4c8dff',
      'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)',
    ]);
  });

  it('每种卡片类型都能给出非空预览（穷举不遗漏）', () => {
    const cards: Card[] = [
      createCard('note', { content: { md: 'x' } }),
      createCard('noteRef', { content: { path: 'a.md' } }),
      createCard('image', { content: { path: 'i.png' } }),
      createCard('file', { content: { path: 'f.pdf' } }),
      createCard('link', { content: { url: 'https://x.y' } }),
      createCard('todo', { content: { title: 't', items: [] } }),
      createCard('swatch', { content: { colors: ['#112233'] } }),
      createCard('boardRef', { content: { path: 'b.nboard' } }),
      createCard('ink', { content: { paths: [] } }),
      createCard('map', { content: { path: 'm.png', label: '地点' } }),
      // 同步便签（T7.04）：预览与便签同一套（正文都是 `md`）
      createCard('syncNote', { content: { key: 'sy_1', md: '同一份正文' } }),
      // 评论卡（T7.05）：一条一行，没有"空到画不出东西"的余地
      createCard('comment', {
        content: {
          entries: [{ id: 'cmt_1', text: '一条备注', at: 1_756_000_000_000 }],
          resolved: false,
        },
      }),
    ];
    expect(cards).toHaveLength(12);
    for (const card of cards) {
      const preview = cardPreview(card);
      expect(preview.label.length + preview.lines.length).toBeGreaterThan(0);
    }
  });
});

describe('isDarkNoteCard', () => {
  it('只有"便签 + variant: dark"才算（浅色 / 缺席都不算）', () => {
    expect(isDarkNoteCard(createCard('note', { content: { md: 'x', variant: 'dark' } }))).toBe(
      true,
    );
    expect(isDarkNoteCard(createCard('note', { content: { md: 'x', variant: 'light' } }))).toBe(
      false,
    );
    expect(isDarkNoteCard(createCard('note', { content: { md: 'x' } }))).toBe(false);
  });

  it('★ 同步便签不参与：变体是单张卡的观感，而它没有单张的正文', () => {
    const card = createCard('syncNote', { content: { key: 'sy_1', md: 'x' } });
    expect(isDarkNoteCard(card)).toBe(false);
  });

  it('别的卡片类型本来就没有变体（判据只认便签，不看内容里有没有那个键）', () => {
    const card = createCard('todo', { content: { title: 't', items: [] } });
    expect(isDarkNoteCard(card)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 绘制
// ─────────────────────────────────────────────────────────────

describe('renderTile', () => {
  const tile = { x: 0, y: 0, width: 200, height: 200, index: 0, column: 0, row: 0 };

  it('先裁剪再绘制，并画出卡片与连线', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', { id: 'a', x: 10, y: 10, width: 80, height: 60, content: { md: 'hi' } }),
        createCard('note', { id: 'b', x: 120, y: 120, width: 80, height: 60 }),
      ],
      edges: [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null })],
    });
    const { ctx, ops } = fakeContext();
    renderTile(ctx, board, tile, renderOptions());

    expect(ops[0]).toBe('save');
    expect(ops).toContain('clip');
    expect(ops).toContain('setTransform');
    expect(ops).toContain('stroke'); // 连线描边
    expect(ops.some((op) => op.startsWith('fillText:'))).toBe(true);
    expect(ops[ops.length - 1]).toBe('restore');
  });

  /** 两条线的标签不同的同一块板子（其余完全一样，好做差集） */
  function labeledBoard(label: string): BoardFile {
    return createBoardFile({
      cards: [
        createCard('note', { id: 'a', x: 10, y: 10, width: 80, height: 60, content: { md: 'hi' } }),
        createCard('note', { id: 'b', x: 120, y: 120, width: 80, height: 60 }),
      ],
      edges: [createEdge({ cardId: 'a', side: null }, { cardId: 'b', side: null }, { label })],
    });
  }

  it('连线标签画出文字（T7.13）：有标签比没标签多一次 `fillText`', () => {
    const count = (label: string): number => {
      const { ctx, ops } = fakeContext();
      renderTile(ctx, labeledBoard(label), tile, renderOptions());
      return ops.filter((op) => op.startsWith('fillText:')).length;
    };
    expect(count('依赖')).toBe(count('') + 1);
  });

  it('超长标签截断加省略号（画布上量不下就截，而不是硬压成一块方砖）', () => {
    const { ctx, ops } = fakeContext();
    renderTile(ctx, labeledBoard('非常长的连线标签'.repeat(6)), tile, renderOptions());
    expect(ops.some((op) => op.startsWith('fillText:') && op.endsWith('…'))).toBe(true);
  });

  it('★ 深色便签（O06）：底色换成深色，且**不再铺那层主题色淡底**', () => {
    const noteBoard = (variant?: 'dark'): BoardFile =>
      createBoardFile({
        cards: [
          createCard('note', {
            id: 'a',
            x: 10,
            y: 10,
            width: 80,
            height: 60,
            color: '1',
            content: variant ? { md: 'hi', variant } : { md: 'hi' },
          }),
        ],
      });

    const light = fakeContext();
    renderTile(light.ctx, noteBoard(), tile, renderOptions());
    // ★ 浅色便签现在是 `O38` 的撞色：**白纸 + 主色标题带**
    //   （以前是"底板 + 14% 主题色淡底"那一套，导出跟着屏幕改成了新的）
    expect(light.fills).toContain(NOTE_LIGHT_FILL);
    // ★ 这张卡**没有标题** ⇒ 屏幕上连那条标题栏都没有（`showTitle` / 空标题会整行收起），
    //   于是它就是一张纯白纸 —— 底色里**不该**出现主色（撞色只上标题带）
    expect(light.fills).not.toContain(palette.theme['1']);

    // 有标题的那一张：多出"主色标题带"这一层
    const banded = fakeContext();
    renderTile(
      banded.ctx,
      createBoardFile({
        cards: [
          createCard('note', {
            id: 'a',
            x: 10,
            y: 10,
            width: 120,
            height: 80,
            color: '1',
            title: '标题',
            showTitle: true,
            content: { md: 'hi' },
          }),
        ],
      }),
      tile,
      renderOptions(),
    );
    expect(banded.fills).toContain(NOTE_LIGHT_FILL);
    expect(banded.fills).toContain(palette.theme['1']);

    const dark = fakeContext();
    renderTile(dark.ctx, noteBoard('dark'), tile, renderOptions());
    expect(dark.fills).toContain(NOTE_DARK_FILL);
    // canvas 没有 `color-mix`，那层 14% 的覆盖在近黑底上会把黑染成"深红" ——
    // 而屏幕上那张卡就是纯粹的黑（样式表把整块背景换掉了）
    expect(dark.fills).not.toContain(palette.theme['1']);
    expect(dark.fills).not.toContain(palette.cardFill);
  });

  it('背景透明时不铺底色', () => {
    const { ctx, ops } = fakeContext();
    renderTile(ctx, createBoardFile(), tile, renderOptions({ transparent: true }));
    expect(ops).not.toContain('fillRect');
  });

  it('不透明时铺底色', () => {
    const { ctx, ops } = fakeContext();
    renderTile(ctx, createBoardFile(), tile, renderOptions());
    expect(ops).toContain('fillRect');
  });

  it('tile 之外的卡片被跳过（分页时每块只画自己那一块）', () => {
    const board = createBoardFile({
      cards: [createCard('note', { x: 5000, y: 5000, width: 100, height: 100 })],
    });
    const { ctx, ops } = fakeContext();
    renderTile(ctx, board, tile, renderOptions());
    expect(ops.some((op) => op.startsWith('fillText:'))).toBe(false);
  });

  it('图片卡有预加载图像时走 drawImage', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', { x: 0, y: 0, width: 200, height: 200, content: { path: 'i.png' } }),
      ],
    });
    const { ctx, ops } = fakeContext();
    const images = new Map<string, CanvasImageSource>([
      ['i.png', { width: 100, height: 100 } as unknown as CanvasImageSource],
    ]);
    renderTile(ctx, board, tile, renderOptions({ images }));
    expect(ops).toContain('drawImage');
  });

  it('图片卡按非破坏性裁剪只取选中的那一块', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', {
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          content: { path: 'i.png', crop: { x: 0.5, y: 0, w: 0.5, h: 1 } },
        }),
      ],
    });
    const { ctx, images } = fakeContext();
    const source = { width: 100, height: 100 } as unknown as CanvasImageSource;
    renderTile(ctx, board, tile, renderOptions({ images: new Map([['i.png', source]]) }));

    expect(images).toHaveLength(1);
    const args = images[0];
    // 九参形式：(image, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(args).toHaveLength(9);
    expect(args[1]).toBe(50); // 从原图一半处开始
    expect(args[3]).toBe(50); // 只取一半宽
    expect(args[4]).toBe(100); // 全高
  });

  it('图片卡 crop 缺失时按整张图处理，不抛错', () => {
    const card = createCard('image', {
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      content: { path: 'i.png' },
    });
    // 模拟手改过的 `.nboard`：字段被删掉了
    delete (card.content as { crop?: unknown }).crop;
    const board = createBoardFile({ cards: [card] });
    const { ctx, images } = fakeContext();
    const source = { width: 80, height: 60 } as unknown as CanvasImageSource;
    renderTile(ctx, board, tile, renderOptions({ images: new Map([['i.png', source]]) }));

    expect(images).toHaveLength(1);
    expect(images[0][1]).toBe(0);
    expect(images[0][3]).toBe(80);
    expect(images[0][4]).toBe(60);
  });

  it('图片卡缺图时退回占位文字（不让一张坏图毁掉导出）', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', {
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          content: { path: 'missing.png' },
        }),
      ],
    });
    const { ctx, ops } = fakeContext();
    renderTile(ctx, board, tile, renderOptions());
    expect(ops).not.toContain('drawImage');
    expect(ops.some((op) => op.startsWith('fillText:'))).toBe(true);
  });

  it('地图卡画出真位图（没有裁剪字段 → 整图），图钉按归一化位置落在图上', () => {
    const board = createBoardFile({
      cards: [
        createCard('map', {
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          content: { path: 'm.png', label: '深圳湾', pin: { x: 0.5, y: 0.25 } },
        }),
      ],
    });
    const { ctx, images, arcs } = fakeContext();
    const source = { width: 100, height: 100 } as unknown as CanvasImageSource;
    // 背景取 `plain`：`dots` 背景自己也会调 `arc`，会盖掉"图钉到底画了几笔"的断言
    renderTile(
      ctx,
      board,
      tile,
      renderOptions({ background: 'plain', images: new Map([['m.png', source]]) }),
    );

    // 整图：地图卡没有 crop / fit，按 contain 画（九参形式 → 取原图全部）
    expect(images).toHaveLength(1);
    expect(images[0][1]).toBe(0);
    expect(images[0][2]).toBe(0);
    expect(images[0][3]).toBe(100);
    expect(images[0][4]).toBe(100);

    // 图钉 = 底圈 + 实心点两笔；圆心落在**画出来的那张图**的 50% / 25% 处
    expect(arcs).toHaveLength(2);
    const drawX = Number(images[0][5]);
    const drawY = Number(images[0][6]);
    const drawW = Number(images[0][7]);
    const drawH = Number(images[0][8]);
    expect(arcs[0][0]).toBeCloseTo(drawX + drawW * 0.5, 6);
    expect(arcs[0][1]).toBeCloseTo(drawY + drawH * 0.25, 6);
    expect(arcs[1][0]).toBeCloseTo(drawX + drawW * 0.5, 6);
  });

  it('地图卡没有图钉时只画图、不画点', () => {
    const board = createBoardFile({
      cards: [
        createCard('map', {
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          content: { path: 'm.png' },
        }),
      ],
    });
    const { ctx, images, arcs } = fakeContext();
    const source = { width: 100, height: 100 } as unknown as CanvasImageSource;
    // 背景取 `plain`：`dots` 背景自己也会调 `arc`，会盖掉"图钉到底画了几笔"的断言
    renderTile(
      ctx,
      board,
      tile,
      renderOptions({ background: 'plain', images: new Map([['m.png', source]]) }),
    );

    expect(images).toHaveLength(1);
    expect(arcs).toHaveLength(0);
  });

  it('地图卡缺图时退回占位文字（与图片卡同一条回落）', () => {
    const board = createBoardFile({
      cards: [
        createCard('map', {
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          content: { path: 'missing.png', label: '找不到的图' },
        }),
      ],
    });
    const { ctx, ops } = fakeContext();
    renderTile(ctx, board, tile, renderOptions());
    expect(ops).not.toContain('drawImage');
    expect(ops).toContain('fillText:找不到的图');
  });
});

// ─────────────────────────────────────────────────────────────
// 卡片旋转（T7.06 / `F2-00-10`）
//
// 导出这一层要同时守住两件**相反**的事：
//  * 取景 / 裁剪要看**外接框**（不然转出来的角被切掉、多页导出还会漏画整张卡）；
//  * 画的时候几何仍是**布局框**（不然"转一下卡片就变宽"）。
// 一混就把旋转做成了缩放，所以两边都要钉死。
// ─────────────────────────────────────────────────────────────

describe('boundsOfCard', () => {
  it('没转过时与 `rectOfCard` 逐字段相同（存量白板零影响）', () => {
    const card = createCard('note', { x: 5, y: 6, width: 100, height: 50 });
    expect(boundsOfCard(card)).toEqual(rectOfCard(card));
  });

  it('★ 转过时给外接框，但**不写回模型**：旋转不是"宽高变大"', () => {
    const card = createCard('note', { x: 0, y: 0, width: 100, height: 50, rotation: 90 });

    const box = boundsOfCard(card);
    expect(box.width).toBeCloseTo(50);
    expect(box.height).toBeCloseTo(100);
    expect(card.width).toBe(100);
    expect(card.height).toBe(50);
  });
});

describe('取景与裁剪 · 转过的卡片', () => {
  const tile = { x: 0, y: 0, width: 200, height: 200, index: 0, column: 0, row: 0 };

  it('★ 整板取景按外接框：转 45° 的卡片不该被裁掉一个角', () => {
    const board = createBoardFile({
      cards: [createCard('note', { x: 0, y: 0, width: 100, height: 100, rotation: 45 })],
    });

    const bounds = boardContentBounds(board)!;
    expect(bounds.width).toBeCloseTo(Math.SQRT2 * 100);
    expect(bounds.height).toBeCloseTo(Math.SQRT2 * 100);
  });

  it('★ 范围=选中：选中的卡片转过时，转出来的那部分也在框里', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', { id: 'b', x: 500, y: 500, width: 100, height: 100, rotation: 45 }),
      ],
    });

    const bounds = resolveExportBounds(
      board,
      { range: 'selection' },
      {
        selection: new Set(['b']),
      },
    )!;

    expect(bounds.width).toBeCloseTo(Math.SQRT2 * 100 + DEFAULT_PNG_PADDING * 2);
    expect(bounds.height).toBeCloseTo(Math.SQRT2 * 100 + DEFAULT_PNG_PADDING * 2);
    // 转的是绕中心的，所以框的中心仍是卡片中心
    expect(bounds.x + bounds.width / 2).toBeCloseTo(550);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(550);
  });

  it('★ 裁剪判定也用外接框：只有一角伸进这一块 tile 的卡片不能被整张丢掉', () => {
    const board = createBoardFile({
      // tile 是 y ∈ [0, 200)。这张卡的**布局框**整个在下面（y = 210 < 210 + 60 全在 200 之外），
      // 但转 45° 之后它的外接框往上探到了 197.6 —— 按布局框裁剪会把它整张丢掉，
      // 表现是分页导出的这一块上"少了一个角"（而那个角本该出现在这里）
      cards: [
        createCard('note', {
          x: 0,
          y: 210,
          width: 60,
          height: 60,
          rotation: 45,
          content: { md: '角落' },
        }),
      ],
    });
    const { ctx, ops } = fakeContext();

    renderTile(ctx, board, tile, renderOptions());

    expect(ops).toContain('fillText:角落');
  });

  it('★ 画的时候绕卡片中心转（`translate` → `rotate` → `translate` 回来）', () => {
    const board = createBoardFile({
      cards: [
        createCard('note', {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 90,
          content: { md: 'hi' },
        }),
      ],
    });
    const { ctx, transforms } = fakeContext();

    renderTile(ctx, board, tile, renderOptions());

    expect(transforms).toContain('translate(50, 50)');
    expect(transforms).toContain(`rotate(${Math.PI / 2})`);
    expect(transforms).toContain('translate(-50, -50)');
  });

  it('没转过时不碰变换矩阵（不为 98% 的卡片白算三次矩阵）', () => {
    const { ctx, transforms } = fakeContext();

    renderTile(ctx, oneCardBoard(), tile, renderOptions());

    expect(transforms.filter((entry) => entry.startsWith('rotate('))).toEqual([]);
  });

  it('★ save / restore 严格配对（图片卡那条 `continue` 曾经漏掉 restore，T7.06 顺手修）', () => {
    const board = createBoardFile({
      cards: [
        createCard('image', {
          id: 'i',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          content: { path: 'i.png' },
        }),
        createCard('note', { id: 'n', x: 100, y: 0, width: 80, height: 80, content: { md: 'hi' } }),
      ],
    });
    const source = { width: 100, height: 100 } as unknown as CanvasImageSource;
    const { ctx, ops } = fakeContext();

    renderTile(ctx, board, tile, renderOptions({ images: new Map([['i.png', source]]) }));

    expect(ops).toContain('drawImage');
    // 不配对时 `save` 会一直攒着：以前只是白攒栈帧，加了旋转之后
    // 会让"上一张卡的旋转"漏给后面每一张卡 —— 从"看不见"变成"看得见的错"
    expect(ops.filter((op) => op === 'restore')).toHaveLength(
      ops.filter((op) => op === 'save').length,
    );
  });
});
