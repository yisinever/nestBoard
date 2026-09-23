/**
 * `.canvas` 预览卡（`F6`）的纯逻辑：外接框、方块上的字、空卡。
 *
 * ★ 这里钉的是"错了会在卡面上看出来、却很难查"的三件事：
 *   ① 外接框是否把所有方块都框进去（漏一个就会画出卡外）；
 *   ② 字号是不是按**最小的方块**算（按最大的算 ⇒ 小方块里的字溢出去压邻居）；
 *   ③ 各类型取的是不是规范里**自己那个字段**。
 * ★ SVG 那一层不在这里测（假 DOM 没有 `createElementNS`），见 `cards/canvas.ts` 的注释。
 */

import { describe, expect, it } from 'vitest';
import { canvasBoundsOf, canvasCard, canvasNodeLabelOf } from '../../cards/canvas';
import type { CardRenderContext } from '../../cards/registry';
import type { JsonCanvasNode } from '../../export/jsonCanvas';
import type { CardOf } from '../../model/schema';
import { createFakeDocument } from '../helpers/fakeDom';

const node = (over: Partial<JsonCanvasNode> & { id: string }): JsonCanvasNode =>
  ({ type: 'text', x: 0, y: 0, width: 100, height: 60, ...over }) as JsonCanvasNode;

interface FakeEl {
  className: string;
  textContent: string;
  children: unknown[];
  /**
   * SVG 节点上的属性走 `setAttribute`（`viewBox` / `class` / `font-size`），
   * 不是 DOM 属性 —— 所以断言要读属性，不能读字段。
   */
  getAttribute: (name: string) => string | null;
}
const asEl = (value: unknown): FakeEl => value as FakeEl;

describe('canvasBoundsOf（外接框）', () => {
  it('把所有方块并起来，四周各留一圈白', () => {
    const bounds = canvasBoundsOf([
      node({ id: 'a', x: 0, y: 0, width: 100, height: 60 }),
      node({ id: 'b', x: 400, y: 300, width: 200, height: 40 }),
    ]);

    // 左上往外扩、右下往外扩（留白量写在 `CANVAS_PADDING`，这里只断言"确实扩了"）
    expect(bounds.x).toBeLessThan(0);
    expect(bounds.y).toBeLessThan(0);
    expect(bounds.x + bounds.width).toBeGreaterThan(600);
    expect(bounds.y + bounds.height).toBeGreaterThan(340);
  });

  it('★ 字号跟**最小的方块**走：不然小方块里的字会溢出去压住邻居', () => {
    const tall = canvasBoundsOf([node({ id: 'a', height: 400 })]);
    const short = canvasBoundsOf([node({ id: 'a', height: 40 })]);

    expect(short.fontSize).toBeLessThan(tall.fontSize);
    // 有下限，别缩成看不见的 1px
    expect(canvasBoundsOf([node({ id: 'a', height: 1 })]).fontSize).toBeGreaterThanOrEqual(8);
  });

  it('一个能画的方块都没有时给一个安全的框（不至于除零 / 画成空）', () => {
    const bounds = canvasBoundsOf([node({ id: 'a', width: Number.NaN })]);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });
});

describe('canvasNodeLabelOf（方块上写什么）', () => {
  it('★ 各类型取规范里**自己那个字段**', () => {
    expect(canvasNodeLabelOf(node({ id: 'a', type: 'text', text: '一句话' } as never))).toBe(
      '一句话',
    );
    expect(canvasNodeLabelOf(node({ id: 'b', type: 'file', file: '资料/x.pdf' } as never))).toBe(
      '资料/x.pdf',
    );
    expect(canvasNodeLabelOf(node({ id: 'c', type: 'link', url: 'https://x.com' } as never))).toBe(
      'https://x.com',
    );
    expect(canvasNodeLabelOf(node({ id: 'd', type: 'group', label: '一组' } as never))).toBe(
      '一组',
    );
  });

  it('多行正文只取第一行（SVG 文字不折行，塞进去会占满整个方块）', () => {
    expect(canvasNodeLabelOf(node({ id: 'a', text: '第一行\n第二行' } as never))).toBe('第一行');
  });

  it('太长就截断加省略号；取不到字段时退回类型名（别留个空方块）', () => {
    const long = canvasNodeLabelOf(node({ id: 'a', text: 'x'.repeat(60) } as never));
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(30);

    expect(canvasNodeLabelOf(node({ id: 'b', type: 'unknown' } as never))).toBe('unknown');
  });
});

describe('`.canvas` 卡本体（`F6`）', () => {
  const ctxOf = (): CardRenderContext =>
    ({ app: { vault: { adapter: { read: async () => '{}' } } } }) as unknown as CardRenderContext;

  it('尺寸是横版 3:2（canvas 多半是"一屏摊开"的形状）', () => {
    expect(canvasCard.defaultSize.width / canvasCard.defaultSize.height).toBeCloseTo(1.5, 2);
  });

  it('空卡（还没拖文件）：给一句引导，不去读文件、也不挂 SVG', () => {
    const el = createFakeDocument().createElement('div') as unknown as HTMLElement;
    canvasCard.render(
      el,
      { content: { path: '', showSize: false } } as unknown as CardOf<'canvas'>,
      ctxOf(),
    );

    const child = asEl(asEl(el).children[0]);
    expect(child.className).toBe('nestboard-canvas-ref-note');
    expect(child.textContent).toContain('canvas');
  });

  it('卡面不提供「编辑内容」、也不显示标题栏（只读预览，与 PDF 卡同一条）', () => {
    expect(canvasCard.menuItems).toMatchObject({ editContent: false, showTitle: false });
  });

  it('有文件时：读完真的画出方块与连线，外接框落进 viewBox', async () => {
    const doc = createFakeDocument();
    const host = doc.createElement('div') as unknown as HTMLElement;
    const el = doc.createElement('div') as unknown as HTMLElement;
    host.appendChild(el);
    // ★ 真实 DOM 里 `isConnected` 由浏览器给（卡片读完文件要确认"还在文档里"才画），
    //   假 DOM 没有这一项 ⇒ 在用例里显式标一下
    (asEl(el) as unknown as { isConnected: boolean }).isConnected = true;

    const raw = JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 60, text: '甲' },
        { id: 'b', type: 'file', x: 300, y: 100, width: 100, height: 60, file: '资料/乙.md' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    });
    const ctx = {
      app: { vault: { adapter: { read: async () => raw } } },
    } as unknown as CardRenderContext;

    canvasCard.render(
      el,
      { content: { path: '板子.canvas', showSize: false } } as unknown as CardOf<'canvas'>,
      ctx,
    );
    // 读文件是异步的：等它落定
    await Promise.resolve();
    await Promise.resolve();

    const svg = asEl(asEl(el).children[0]);
    expect(svg.getAttribute('viewBox')).toBeTruthy();
    const parts = (svg.children as unknown[]).map((child) => asEl(child));
    expect(parts.filter((p) => (p.getAttribute('class') ?? '').includes('node')).length).toBe(2);
    expect(parts.filter((p) => (p.getAttribute('class') ?? '').includes('edge')).length).toBe(1);
    // 文字取的是各类型自己那个字段
    // ★ 按 **class** 认文字节点，不按 `tagName`：假 DOM 的 `createElementNS` 不保留标签名
    //   （真实浏览器里是 `<text>`，两边的差别在这里没有意义）
    const labels = parts
      .filter((p) => (p.getAttribute('class') ?? '').includes('label'))
      .map((p) => (p as unknown as { textContent: string }).textContent);
    expect(labels).toEqual(['甲', '资料/乙.md']);
  });

  it('文件读不到 / 内容不是 canvas：给一句话，不抛错', async () => {
    const doc = createFakeDocument();
    const el = doc.createElement('div') as unknown as HTMLElement;
    (asEl(el) as unknown as { isConnected: boolean }).isConnected = true;
    const ctx = {
      app: {
        vault: {
          adapter: {
            read: async () => {
              throw new Error('ENOENT');
            },
          },
        },
      },
    } as unknown as CardRenderContext;

    canvasCard.render(
      el,
      { content: { path: '没了.canvas', showSize: false } } as unknown as CardOf<'canvas'>,
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();

    const note = asEl(asEl(el).children[0]);
    expect(note.className).toBe('nestboard-canvas-ref-note');
    expect(note.textContent.length).toBeGreaterThan(0);
  });
});
