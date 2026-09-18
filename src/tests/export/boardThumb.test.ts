/**
 * 板级缩略图（T4.16 / `F2-8-2`）单测。
 *
 * 分两层，各盯一类会**静默出错**的地方（node 下没有真 canvas，像素断言不了，
 * 但结构性错误抓得住，思路与 `toPng.test.ts` 一致）：
 *   1. **规划**（`planBoardThumbnail`）：最长边 = 256、**只缩不放**、空板 → `null`。
 *      错了的表现是"预览里的东西比真板子小一圈"，或者空板占着一张纯背景图；
 *   2. **绘制**（`paintBoardThumbnail`）：用假 2D 上下文记录调用，保证
 *      "确实作了图"（设变换 + 画背景 + 画卡片文字），而不是悄悄什么都没画。
 */

import { describe, expect, it } from 'vitest';
import {
  BOARD_THUMB_MAX_LINES,
  BOARD_THUMB_PADDING,
  BOARD_WINDOW_PADDING,
  MAX_BOARD_WINDOW_SIDE,
  paintBoardThumbnail,
  planBoardThumbnail,
  planBoardWindow,
} from '../../export/boardThumb';
import type { PngPalette } from '../../export/toPng';
import { THUMB_SIZE } from '../../io/ThumbnailCache';
import { createBoardFile, createCard, createColumn } from '../../model/factories';

// ── 假 2D 上下文：只记录调用，不做像素 ─────────────────────────

class FakeContext {
  readonly ops: string[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  globalAlpha = 1;
  lineCap = '';

  save(): void {
    this.ops.push('save');
  }
  restore(): void {
    this.ops.push('restore');
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
  }
  stroke(): void {
    this.ops.push('stroke');
  }
  fillRect(): void {
    this.ops.push('fillRect');
  }
  arc(): void {
    this.ops.push('arc');
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
  drawImage(): void {
    this.ops.push('drawImage');
  }
  fillText(text: string): void {
    this.ops.push(`fillText:${text}`);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 6 };
  }
}

function fakeContext(): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const fake = new FakeContext();
  return { ctx: fake as unknown as CanvasRenderingContext2D, ops: fake.ops };
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

// ── 规划 ──────────────────────────────────────────────────────

describe('planBoardThumbnail', () => {
  it('空板 → null（没有可画的东西，不生成一张纯背景图）', () => {
    expect(planBoardThumbnail(createBoardFile())).toBeNull();
  });

  it('大板：最长边压到 256，且等比', () => {
    const board = createBoardFile({
      cards: [createCard('note', { content: { md: 'x' }, width: 3000, height: 2000 })],
    });

    const plan = planBoardThumbnail(board);
    expect(plan).not.toBeNull();
    // 留白 8 世界 px 也在图里：外接框 = 3000+16 × 2000+16
    expect(plan?.tile.width).toBe(3016);
    expect(plan?.tile.height).toBe(2016);
    expect(plan?.scale).toBeLessThan(1);
    expect(plan?.width).toBe(THUMB_SIZE);
    // 2016 × (256 / 3016) ≈ 171.1 → 取整 171
    expect(plan?.height).toBe(171);
  });

  it('小板：**只缩不放**（放大会得到一张糊图，字形像坏了）', () => {
    const board = createBoardFile({
      cards: [createCard('note', { content: { md: 'x' }, width: 100, height: 100 })],
    });

    const plan = planBoardThumbnail(board);
    expect(plan?.scale).toBe(1);
    // 100 + 2×BOARD_THUMB_PADDING
    expect(plan?.width).toBe(100 + BOARD_THUMB_PADDING * 2);
    expect(plan?.height).toBe(100 + BOARD_THUMB_PADDING * 2);
  });

  it('外接框按 `BOARD_THUMB_PADDING` 留白（比导出的 32 小得多）', () => {
    const board = createBoardFile({
      cards: [createCard('note', { content: { md: 'x' }, x: 0, y: 0, width: 100, height: 100 })],
    });
    expect(planBoardThumbnail(board)?.tile).toMatchObject({
      x: -BOARD_THUMB_PADDING,
      y: -BOARD_THUMB_PADDING,
    });
  });

  it('只有分栏、没有卡片也算有内容', () => {
    const board = createBoardFile({
      columns: [createColumn({ x: 0, y: 0, width: 200, height: 300 })],
    });
    expect(planBoardThumbnail(board)).not.toBeNull();
  });
});

// ── 绘制 ──────────────────────────────────────────────────────

describe('paintBoardThumbnail', () => {
  function smallBoard() {
    return createBoardFile({
      cards: [createCard('note', { content: { md: 'hello' }, width: 200, height: 120 })],
    });
  }

  it('确实作了图：设变换 + 画背景 + 画卡片文字', () => {
    const board = smallBoard();
    const plan = planBoardThumbnail(board);
    expect(plan).not.toBeNull();

    const { ctx, ops } = fakeContext();
    paintBoardThumbnail(ctx, board, plan!, palette);

    expect(ops).toContain('setTransform');
    expect(ops).toContain('fillRect');
    expect(ops.some((op) => op.startsWith('fillText:'))).toBe(true);
  });

  it('不传 `images` 也不抛（图片卡退化成占位块，版式仍在）', () => {
    const board = createBoardFile({
      cards: [createCard('image', { content: { path: 'a.png', caption: '' } })],
    });
    const plan = planBoardThumbnail(board);
    expect(plan).not.toBeNull();

    const { ctx } = fakeContext();
    expect(() => paintBoardThumbnail(ctx, board, plan!, palette)).not.toThrow();
  });

  it('正文行数上限与笔记里的板嵌入一致（`BOARD_THUMB_MAX_LINES`）', () => {
    // 断言常量本身就是契约：改了它，两处预览就会长得不一样
    expect(BOARD_THUMB_MAX_LINES).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────
// 只读小窗的规划（T7.09 / F7-10）
//
// 与缩略图是**同一件事的另一个尺度**：缩略图是"最长边固定、另一条随内容"，
// 小窗是"框有多大就填多大"。这里盯住四条不会报错、只会一直不对劲的：
//   1. 只沿着一个方向缩（另一个方向内容溢出/留空）；
//   2. 放大（小板被拉糊）；
//   3. 尺寸还没定就规划（得到一张 1×1 的图，而且此后不会自己变好）；
//   4. 按 CSS 像素而不是设备像素定画布（Retina 上糊一层）。
// ─────────────────────────────────────────────────────────────

describe('planBoardWindow', () => {
  /** 一块远大于任何窗口的板：3000×2000 + 两侧留白 */
  const bigBoard = () =>
    createBoardFile({
      cards: [createCard('note', { content: { md: 'x' }, x: 0, y: 0, width: 3000, height: 2000 })],
    });

  it('空板 → null（与缩略图同一条：一张纯背景图说不清"是空的"还是"读失败"）', () => {
    expect(planBoardWindow(createBoardFile(), 400, 300)).toBeNull();
  });

  it('装不下时按**两个方向的较小倍率**缩（内容必须整个装进框里）', () => {
    const plan = planBoardWindow(bigBoard(), 400, 300, 1);
    // 外接框 = (3000+24)×(2000+24) = 3024×2024。
    // 宽比 400/3024 ≈ 0.1323 比高比 300/2024 ≈ 0.1482 更小，所以按宽缩 ——
    // 取更小的那个内容才整个装得进去；取大的会在宽方向溢出被裁掉一条。
    expect(plan?.scale).toBeCloseTo(400 / 3024, 6);
    expect(plan?.width).toBe(400);
    expect(plan?.height).toBe(300);
  });

  it('★ 铺满：瓦片向外扩到整个框（否则宽板会在窗口里上下留一条空，像贴了张小照片）', () => {
    const plan = planBoardWindow(bigBoard(), 400, 300, 1);
    // 这块板的限制轴是**宽**：缩到宽正好后上下会多出一截 —— 把瓦片向外扩到整框，
    // 多出来的那一圈由板自己的背景（含点阵 / 网格）填上，内容仍然居中
    expect(plan?.tile.width).toBeCloseTo(400 / plan!.scale, 6);
    expect(plan?.tile.height).toBeCloseTo(300 / plan!.scale, 6);
    expect(plan?.tile.y).toBeLessThan(-BOARD_WINDOW_PADDING);
  });

  it('板比框小时**只缩不放**，多出来的地方由背景铺满', () => {
    const board = createBoardFile({
      cards: [createCard('note', { content: { md: 'x' }, x: 0, y: 0, width: 100, height: 100 })],
    });
    const plan = planBoardWindow(board, 400, 300, 1);
    expect(plan?.scale).toBe(1);
    expect(plan).toMatchObject({ width: 400, height: 300, cssWidth: 400, cssHeight: 300 });
    expect(plan?.tile).toMatchObject({ x: -150, y: -100, width: 400, height: 300 });
  });

  it('★ 按设备像素定画布：Retina 上后备像素 × dpr，CSS 尺寸还原回框的大小', () => {
    const plan = planBoardWindow(bigBoard(), 400, 300, 2);
    expect(plan).toMatchObject({ width: 800, height: 600, cssWidth: 400, cssHeight: 300 });
  });

  it('★ 设备像素夹上限（`height:` 是用户手打的数字，不能直接变成画布尺寸）', () => {
    const plan = planBoardWindow(bigBoard(), 100000, 100000, 1);
    expect(plan?.width).toBe(MAX_BOARD_WINDOW_SIDE);
    expect(plan?.height).toBe(MAX_BOARD_WINDOW_SIDE);
  });

  it('还没布局（0 / 负数 / NaN）→ null，不生成一张 1×1 的图', () => {
    for (const [width, height] of [
      [0, 300],
      [400, 0],
      [Number.NaN, 300],
      [400, -10],
    ]) {
      expect(planBoardWindow(bigBoard(), width ?? 0, height ?? 0)).toBeNull();
    }
  });

  it('画法与缩略图共用一条路（`paintBoardThumbnail` 只认 `tile` + `scale`）', () => {
    const board = bigBoard();
    const plan = planBoardWindow(board, 400, 300, 1);
    expect(plan).not.toBeNull();

    const { ctx, ops } = fakeContext();
    expect(() => paintBoardThumbnail(ctx, board, plan!, palette)).not.toThrow();
    expect(ops).toContain('setTransform');
    expect(ops.some((op) => op.startsWith('fillText:'))).toBe(true);
  });
});
