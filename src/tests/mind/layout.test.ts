/**
 * 脑图布局与配色（`06 §5` / `§6.1`）—— 两组纯逻辑，全部在 node 下逐条钉住。
 *
 * 布局这一组盯的是**骨架规则**（谁在左、谁在右、同层是否对齐、折叠有没有真的藏起来、
 * 悬浮节点是不是按 `free` 摆），而不是像素值 —— 像素随字号与内容变，规则不该变。
 * 另加一条"同一输入必须布局成同一份坐标"（= 快照测试的等价物）与一条 1000 节点的规模检查。
 */

import { describe, expect, it } from 'vitest';
import {
  MIND_NODE_PADDING_X,
  MIND_NODE_PADDING_Y,
  MIND_TITLE_MAX_UNITS,
  MIND_TITLE_MAX_WIDTH,
  MIND_TITLE_MIN_WIDTH,
  estimateNodeSize,
} from '../../mind/layout/measure';
import {
  MIND_LEVEL_GAP,
  MIND_SIBLING_GAP,
  directionForStructure,
  layoutMind,
  layoutMindEqualLevels,
} from '../../mind/layout/tree';
import type { MindLayout, NodeBox } from '../../mind/layout/tree';
import {
  MIND_BODY_MIX_PERCENT,
  mindPaletteOf,
  mindPaletteOfHex,
  titleBoldOf,
  titleSizeOf,
} from '../../mind/model/palette';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile, MindNode } from '../../mind/model/schema';
import { mixSrgb, swatchInkColor } from '../../util/color';
import type { Size } from '../../util/geometry';

// ── 工具 ─────────────────────────────────────────────────────

/** 固定尺寸：布局规则与"节点多大"无关，钉住尺寸才能断言坐标 */
const SIZE: Size = { width: 100, height: 40 };
const sizeOf = (): Size => SIZE;

/** 造一棵树：`text` 就是节点文字，父子关系由嵌套表达 */
function treeOf(rootText: string, children: (string | [string, unknown[]])[] = []): MindFile {
  // ★ 根节点文字现在单独给（`2.2.0` 收尾那一批改了默认值 —— 见 `createMindFile`）
  const file = createMindFile({ title: rootText, rootText, now: () => 'T' });
  const rootId = file.rootId;
  file.nodes = [file.nodes[0] as MindNode];

  const add = (text: string, parentId: string, order: number): string => {
    const node = createMindNode({ text, parentId, order });
    file.nodes.push(node);
    return node.id;
  };

  children.forEach((entry, index) => {
    if (typeof entry === 'string') {
      add(entry, rootId, index);
      return;
    }
    const [text, grandChildren] = entry;
    const id = add(text, rootId, index);
    (grandChildren as string[]).forEach((grand, sub) => add(grand, id, sub));
  });

  return file;
}

function boxOf(file: MindFile, text: string): NodeBox {
  const node = file.nodes.find((item) => item.text === text);
  if (!node) throw new Error(`没有这个节点：${text}`);
  const layout = layoutMind(file, { sizeOf });
  const box = layout.boxes.get(node.id);
  if (!box) throw new Error(`这个节点没被排进去：${text}`);
  return box;
}

// ── 同层等宽（用户 2026-09-21）─────────────────────────────────

describe('同层等宽', () => {
  /** 宽度跟着文字长度走（每个字 10px）：用来验证"以同层最宽者为准" */
  const widthByText = (node: MindNode): Size => ({ width: node.text.length * 10, height: 40 });
  /** 一律往右排：两侧各自算宽度，混在一起看不出断言想说什么 */
  const layoutOf = (file: MindFile) =>
    layoutMind(file, { sizeOf: widthByText, direction: 'right' });
  const idOf = (file: MindFile, text: string): string =>
    file.nodes.find((node) => node.text === text)?.id ?? '';

  it('★ 比"同层最宽那个"窄的节点，会拿到它的宽度当**下限**；最宽那个自己不设', () => {
    const file = treeOf('中心', ['甲', '乙乙乙乙']);
    const layout = layoutOf(file);
    const wide = layout.boxes.get(idOf(file, '乙乙乙乙'));
    const narrow = layout.boxes.get(idOf(file, '甲'));

    expect(narrow?.minWidth).toBe(wide?.width);
    // 它本来就是这一层的宽度，不必给自己设下限
    expect(wide?.minWidth).toBeUndefined();
  });

  it('★ 每一层各算一份：下一层的宽度不为上一层让路', () => {
    const file = treeOf('中心', [['甲', ['甲甲甲甲甲']], '甲二']);
    const layout = layoutOf(file);

    // 一层：甲(1 字) 与 甲二(2 字) ⇒ 甲 被撑到 2 个字
    expect(layout.boxes.get(idOf(file, '甲'))?.minWidth).toBe(
      layout.boxes.get(idOf(file, '甲二'))?.width,
    );
    // 二层只有它一个（5 个字）⇒ 不设下限，宽度就是自己的 50
    const deep = layout.boxes.get(idOf(file, '甲甲甲甲甲'));
    expect(deep?.minWidth).toBeUndefined();
    expect(deep?.width).toBe(50);
  });

  it('折叠起来的子孙不参与等宽（它们一个都不排）', () => {
    const file = treeOf('中心', ['甲', '乙乙乙乙']);
    const collapsed = file.nodes.find((node) => node.text === '甲');
    if (collapsed) collapsed.collapsed = true;

    const layout = layoutOf(file);
    // 没有崩、也没有因为折叠了谁就少算宽度
    expect(layout.boxes.get(idOf(file, '乙乙乙乙'))?.width).toBe(40);
  });
});

/**
 * 画布那条路的"同层等宽"（`2.2.0` 收尾 · 用户 2026-09-22 报的
 * "超过第二级就不生效了，节点长度会有长有短"）。
 *
 * ── 这条路的形状 ─────────────────────────────────────────
 * 布局给出**下限** → 渲染层写成 `min-width` → 量真尺寸 → 再排一遍。
 * 致命之处在于 `min-width` **只抬高、不压低**：第二遍要是还拿"**量到的宽度**"算
 * "这一层谁最宽"，量到的那个数里已经含着**上一轮自己撑开**的那一档 ⇒ 算出来永远是
 * "就是刚才那个下限" ⇒ "比最宽的窄"一个都不成立 ⇒ 渲染层把下限摘掉、节点缩回内容宽
 * —— 于是同层又参差不齐。所以布局层多收一份 `intrinsicSizeOf`（**内容真宽**），
 * 画布两条渲染路径（`MindView` / `EmbedMind`）都传它。
 *
 * ── 这一组怎么做到"不必开浏览器"─────────────────────────
 * 把浏览器那点事照抄成几行：元素只记住一个"下限"，而它**画出来**的宽度就是
 * `max(内容宽, 下限)` —— 正好是样式表里 `min-width: var(…, 0)` 那条规则的语义。
 * 于是"第二轮之后到底齐不齐"在 node 下就能被钉住。
 */
describe('同层等宽 × 画布那条路（两遍布局 + min-width）', () => {
  const idOf = (file: MindFile, text: string): string =>
    file.nodes.find((node) => node.text === text)?.id ?? '';
  /** 内容自己要多大：跟着字数走（每个字 10px）——"同层长短不一"就是靠它造的 */
  const contentWidth = (text: string): number => text.length * 10;
  const contentSize = (node: MindNode): Size => ({ width: contentWidth(node.text), height: 40 });

  /**
   * 极简"元素层"：只模拟 `min-width` 那一条（**只抬高、不压低**）。
   *
   * ★ `apply` = `applyNodeBox` 那一步（写下限；`minWidth` 缺席 ⇒ 把变量摘掉）；
   * ★ `widthOf` = 浏览器算出来的最终宽度；
   * ★ `measured` = 量尺寸（元素上挂着下限时，窄的那个会量成被撑开的宽度 —— 就是"自证"）。
   */
  class FakeElements {
    private readonly mins = new Map<string, number>();

    constructor(private readonly file: MindFile) {}

    apply(layout: MindLayout): void {
      for (const box of layout.boxes.values()) {
        if (box.minWidth === undefined) this.mins.delete(box.id);
        else this.mins.set(box.id, Math.round(box.minWidth));
      }
    }

    widthOf(text: string): number {
      return Math.max(contentWidth(text), this.mins.get(idOf(this.file, text)) ?? 0);
    }

    measured(): (node: MindNode) => Size {
      return (node) => ({ width: this.widthOf(node.text), height: 40 });
    }
  }

  /** 一棵**三层**、同层长短不一的树（"超过第二级"那一档必须真的有三层） */
  function tree3(): MindFile {
    const file = createMindFile({ rootText: '中心', now: () => 'T' });
    const add = (text: string, parentId: string, order: number): string => {
      const node = createMindNode({ text, parentId, order });
      file.nodes.push(node);
      return node.id;
    };
    const a = add('甲', file.rootId, 0);
    const b = add('乙乙乙乙乙乙', file.rootId, 1);
    const a1 = add('甲一', a, 0);
    add('甲二甲二甲二甲二', a, 1);
    const b1 = add('乙一', b, 0);
    add('甲一甲一', a1, 0); // ← 三层（4 字 ⇒ 40）
    add('乙一乙一乙一', b1, 0); // ← 三层（6 字 ⇒ 60）
    return file;
  }

  const options = { direction: 'right' as const };

  it('★★ 两遍之后同层等宽：**三层也一样**，而且再跑一遍还齐（下限没被自己抹掉）', () => {
    const file = tree3();
    const dom = new FakeElements(file);

    // ① 第一遍：按内容宽排一版（画布上先摆的就是它）
    let layout = layoutMind(file, {
      ...options,
      sizeOf: contentSize,
      intrinsicSizeOf: contentSize,
    });
    dom.apply(layout);
    // ② 量"内容真宽"（`measureNodeSizes` 量之前会把下限摘掉 ⇒ 拿到的就是内容自己要多宽）
    // ③ 第二遍：几何**撑开** + 下限继续挂着（`layoutMindEqualLevels` + `intrinsicSizeOf`）
    layout = layoutMindEqualLevels(file, {
      ...options,
      sizeOf: contentSize,
      intrinsicSizeOf: contentSize,
    });
    dom.apply(layout);

    // 一层：10 / 60 ⇒ 都 60；二层：20 / 80 / 20 ⇒ 都 80；三层：40 / 60 ⇒ 都 60
    expect(dom.widthOf('甲')).toBe(60);
    expect(dom.widthOf('乙乙乙乙乙乙')).toBe(60);
    expect(dom.widthOf('甲一')).toBe(80);
    expect(dom.widthOf('甲二甲二甲二甲二')).toBe(80);
    expect(dom.widthOf('甲一甲一')).toBe(60);
    expect(dom.widthOf('乙一乙一乙一')).toBe(60);
    // 三层里窄的那个：几何也撑开了（连线 / 外接框 / 缩略图读的都是 `box.width`）
    expect(layout.boxes.get(idOf(file, '甲一甲一'))?.width).toBe(60);

    // ★ 再排一遍（用户改一个字就会重排一次）：还是齐的 —— 下限不会在第二遍里消失
    layout = layoutMindEqualLevels(file, {
      ...options,
      sizeOf: contentSize,
      intrinsicSizeOf: contentSize,
    });
    dom.apply(layout);
    expect(dom.widthOf('甲一甲一')).toBe(60);
    expect(dom.widthOf('甲一')).toBe(80);
  });

  it('★ 反例：拿"量到的宽度"算最宽（老口径）⇒ 下限会被自己抹掉、节点缩回去', () => {
    const file = tree3();
    const dom = new FakeElements(file);

    // 老口径：`intrinsicSizeOf` 缺席 ⇒ 同层最宽是拿**量到的宽度**算的
    let layout = layoutMind(file, { ...options, sizeOf: dom.measured() });
    dom.apply(layout);
    expect(dom.widthOf('甲')).toBe(60); // 第一遍：按内容宽算出来的是 60，撑开了

    // 第二遍：此刻量到的宽度**已经是被撑开的** ⇒ "甲"不再"比最宽的窄" ⇒ 拿不到下限
    layout = layoutMind(file, { ...options, sizeOf: dom.measured() });
    expect(layout.boxes.get(idOf(file, '甲'))?.minWidth).toBeUndefined();
    dom.apply(layout); // ← 渲染层把元素上的下限摘掉
    expect(dom.widthOf('甲')).toBe(contentWidth('甲')); // ⇒ 缩回 10，同层又不齐了
  });
});

/**
 * 同层等宽**落进几何**（`2.2.0` 批 4 六）。
 *
 * 画布那边靠"CSS 撑开 + 量到真尺寸再排一遍"落地；缩略图 / 导出**没有第二次测量**，
 * 只靠上面那份 `minWidth` 提示的话，导出的树里同层节点会参差不齐、整体比画布上窄
 * —— 用户 2026-09-22 报的"绘制尺寸不是很还原"就是这一处。
 */
describe('同层等宽 · 落进几何（layoutMindEqualLevels）', () => {
  const widthByText = (node: MindNode): Size => ({ width: node.text.length * 10, height: 40 });
  const idOf = (file: MindFile, text: string): string =>
    file.nodes.find((node) => node.text === text)?.id ?? '';
  const options = { sizeOf: widthByText, direction: 'right' as const };

  it('★★ 两遍之后**真的等宽**（不是只挂一个 CSS 下限），右边缘因此齐平', () => {
    const file = treeOf('中心', ['甲', '乙乙乙乙']);

    const plain = layoutMind(file, options);
    const even = layoutMindEqualLevels(file, options);

    // 只排一遍：窄的那个仍然窄（它靠自己那点内容宽）
    expect(plain.boxes.get(idOf(file, '甲'))?.width).toBe(10);
    // 排两遍：两个都等于这一层最宽的那个
    expect(even.boxes.get(idOf(file, '甲'))?.width).toBe(40);
    expect(even.boxes.get(idOf(file, '乙乙乙乙'))?.width).toBe(40);
    // 几何已经等宽 ⇒ 不再需要那个下限提示
    expect(even.boxes.get(idOf(file, '甲'))?.minWidth).toBeUndefined();
    // 右边缘齐平（从根往右排：两兄弟起笔在同一个 x）
    const narrow = even.boxes.get(idOf(file, '甲'));
    const wide = even.boxes.get(idOf(file, '乙乙乙乙'));
    expect((narrow?.x ?? 0) + (narrow?.width ?? 0)).toBeCloseTo(
      (wide?.x ?? 0) + (wide?.width ?? 0),
      5,
    );
  });

  it('一层里没有更宽的邻居 ⇒ 就是第一遍的结果（小树不必多排一次）', () => {
    const file = treeOf('中心', ['甲']);
    const even = layoutMindEqualLevels(file, options);
    expect(even.boxes.size).toBe(2);
    expect(even.boxes.get(idOf(file, '甲'))?.width).toBe(10);
  });
});

// ── 尺寸估算 ─────────────────────────────────────────────────

describe('estimateNodeSize', () => {
  const node = (overrides: Partial<MindNode> = {}): MindNode =>
    createMindNode({ text: '中心主题', ...overrides });

  it('标题越长越宽（但有上下限）', () => {
    const short = estimateNodeSize(node({ text: 'A' }));
    const long = estimateNodeSize(node({ text: 'A'.repeat(80) }));

    expect(short.width).toBeLessThan(long.width);
    // 下限：再短的标题也放得下
    expect(short.width).toBeGreaterThanOrEqual(MIND_TITLE_MIN_WIDTH + MIND_NODE_PADDING_X * 2);
    // 上限：再长的标题也不会变成一条横贯屏幕的带子（= 一行 29 个英文单位那么宽）
    expect(long.width).toBeLessThanOrEqual(MIND_TITLE_MAX_WIDTH + MIND_NODE_PADDING_X * 2);
  });

  it('★ 一行放不下就在节点内**换行**（用户 2026-09-21）：宽度封顶、高度按行数涨', () => {
    const one = estimateNodeSize(node({ text: 'A'.repeat(MIND_TITLE_MAX_UNITS) }));
    const two = estimateNodeSize(node({ text: 'A'.repeat(MIND_TITLE_MAX_UNITS + 1) }));
    const three = estimateNodeSize(node({ text: 'A'.repeat(MIND_TITLE_MAX_UNITS * 2 + 1) }));

    // 多出来的那一个字符**不再加宽**，而是多一行
    expect(two.width).toBe(one.width);
    expect(two.height).toBeGreaterThan(one.height);
    expect(three.height).toBeGreaterThan(two.height);
  });

  it('★ 中文按**两个英文单位**折算：十五个汉字就换行，宽度与满行英文齐平', () => {
    const fullEn = estimateNodeSize(node({ text: 'A'.repeat(MIND_TITLE_MAX_UNITS) }));
    const zhShort = estimateNodeSize(node({ text: '汉'.repeat(14) }));
    const zhLong = estimateNodeSize(node({ text: '汉'.repeat(15) }));

    // 14 个汉字 = 28 个单位 ⇒ 还在一行里（比满行略窄）
    expect(zhShort.width).toBeLessThan(fullEn.width);
    // 15 个汉字 = 30 个单位 ⇒ 已经满行：宽度与 29 个英文字符相同，多出来的是一个新行
    expect(zhLong.width).toBe(fullEn.width);
    expect(zhLong.height).toBeGreaterThan(zhShort.height);
  });

  it('内容块让节点更高（行数越多越高）', () => {
    const bare = estimateNodeSize(node());
    const oneLine = estimateNodeSize(node({ note: '一句话' }));
    const manyLines = estimateNodeSize(node({ note: '很长的一段话'.repeat(20) }));

    expect(oneLine.height).toBeGreaterThan(bare.height);
    expect(manyLines.height).toBeGreaterThan(oneLine.height);
  });

  it('★ 图片附件让节点又高又宽；非图片附件只占标题末尾一个回形针；属性不占面积', () => {
    const bare = estimateNodeSize(node());
    const withNote = estimateNodeSize(node({ refs: [{ kind: 'note', path: 'a.md' }] }));
    const withImage = estimateNodeSize(node({ refs: [{ kind: 'image', path: 'a.png' }] }));
    const withWideImage = estimateNodeSize(
      node({ refs: [{ kind: 'image', path: 'a.png', width: 400 }] }),
    );
    const withProps = estimateNodeSize(
      node({ props: [{ id: 'p', key: '负责人', value: '老王' }] }),
    );

    // 非图片附件：只在标题行末尾多一个回形针 ⇒ 宽一点，**不高**
    expect(withNote.height).toBe(bare.height);
    expect(withNote.width).toBeGreaterThan(bare.width);
    // 图片：既高又宽，宽度跟着 `ref.width` 走（没写过宽度时用默认值）
    expect(withImage.height).toBeGreaterThan(bare.height);
    expect(withWideImage.width).toBeGreaterThan(withImage.width);
    // 属性仍然不占面积（在卡角当角标）
    expect(withProps).toEqual(bare);
  });

  it('高度里含上下内边距（估算与 CSS 的 padding 对齐）', () => {
    const size = estimateNodeSize(createMindNode({ text: '' }));
    expect(size.height).toBeGreaterThan(MIND_NODE_PADDING_Y * 2);
  });
});

// ── 走向：向右（大纲式，产品现在的口径）──────────────────────

describe('走向：向右', () => {
  const file = () => treeOf('根', ['一', '二', '三', ['一', ['一甲']]]);

  it('★ 全部孩子都在右边（`side = 1`）—— 两侧模式里总会有人挂到左边', () => {
    const mind = file();
    const right = layoutMind(mind, { sizeOf, direction: 'right' });
    const both = layoutMind(mind, { sizeOf });
    const rootX = right.boxes.get(mind.rootId)?.x ?? 0;

    for (const text of ['一', '二', '三', '一甲']) {
      const id = mind.nodes.find((node) => node.text === text)?.id ?? '';
      const box = right.boxes.get(id);
      expect(box?.side).toBe(1);
      expect((box?.x ?? 0) > rootX).toBe(true);
    }
    expect([...both.boxes.values()].some((box) => box.side === -1)).toBe(true);
    expect([...right.boxes.values()].some((box) => box.side === -1)).toBe(false);
  });

  it('★ 逻辑图（向左）：全部孩子都在左边（与向右逐条镜像）', () => {
    const mind = file();
    const layout = layoutMind(mind, { sizeOf, direction: 'left' });
    const rootX = layout.boxes.get(mind.rootId)?.x ?? 0;

    for (const text of ['一', '二', '三', '一甲']) {
      const id = mind.nodes.find((node) => node.text === text)?.id ?? '';
      const box = layout.boxes.get(id);
      expect(box?.side).toBe(-1);
      // 左孩子的**右边缘**在根左边缘之左
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(rootX);
    }
  });

  it('★ 结构 → 走向：四档各归各的', () => {
    expect(directionForStructure('logic-right')).toBe('right');
    expect(directionForStructure('logic-left')).toBe('left');
    expect(directionForStructure('octopus')).toBe('two-sided');
    expect(directionForStructure('org-down')).toBe('down');
  });

  it('★ 组织结构图（向下）：层级沿 y、兄弟沿 x，同层左边缘仍对齐', () => {
    const mind = file();
    const layout = layoutMind(mind, { sizeOf, direction: 'down' });
    const root = layout.boxes.get(mind.rootId);
    const idOf = (text: string): string => mind.nodes.find((n) => n.text === text)?.id ?? '';

    // 根在上：每个孩子都在根**下方**
    for (const text of ['一', '二', '三', '一甲']) {
      expect(layout.boxes.get(idOf(text))?.y).toBeGreaterThan(root?.y ?? 0);
    }
    // 一层三个孩子在同一行（`y` 完全一样）、沿 x 并排
    const row = ['一', '二', '三'].map((text) => layout.boxes.get(idOf(text))?.y);
    expect(new Set(row).size).toBe(1);
    const xs = ['一', '二', '三'].map((text) => layout.boxes.get(idOf(text))?.x ?? 0);
    expect(new Set(xs).size).toBe(3);
    // 纵向布局里所有盒子都标了 `vertical`（连线与手柄靠它分方向）
    expect([...layout.boxes.values()].every((box) => box.vertical === true)).toBe(true);
  });

  it('同一层的左边缘对齐（一层的三个孩子 `x` 完全一样）', () => {
    const mind = file();
    const layout = layoutMind(mind, { sizeOf, direction: 'right' });
    const xs = ['一', '二', '三'].map(
      (text) => layout.boxes.get(mind.nodes.find((node) => node.text === text)?.id ?? '')?.x,
    );

    expect(new Set(xs).size).toBe(1);
  });
});

// ── 层级样式：底色与字号（`palette.ts`）──────────────────────

describe('层级样式', () => {
  it('★ 一层仍是主色；二层淡粉、三层及以下纯白（不跟主色走）', () => {
    expect(mindPaletteOf(undefined, { depth: 1 }).title).toBe(mindPaletteOf(undefined).title);
    expect(mindPaletteOf(undefined, { depth: 2 }).title).toBe('#f9d8e2');
    expect(mindPaletteOf(undefined, { depth: 3 }).title).toBe('#ffffff');
    expect(mindPaletteOf(undefined, { depth: 9 }).title).toBe('#ffffff');
  });

  it('层级底色的字色按对比度算（淡粉上是深字，纯白上也是深字）', () => {
    expect(mindPaletteOf(undefined, { depth: 2 }).titleInk).toBe(swatchInkColor('#f9d8e2'));
    expect(mindPaletteOf(undefined, { depth: 3 }).titleInk).toBe(swatchInkColor('#ffffff'));
  });

  it('★ 根与一层的字色默认**白**（饱和主色块上写字，用户 2026-09-17 定）', () => {
    // 与白板便签的撞色标题带同一条口径：不按对比度猜，直接给白
    expect(mindPaletteOf(undefined, { depth: 0 }).titleInk).toBe('#ffffff');
    expect(mindPaletteOf(undefined, { depth: 1 }).titleInk).toBe('#ffffff');
    // ★ 只动标题带：正文那块仍是白底深字
    expect(mindPaletteOf(undefined, { depth: 1 }).bodyInk).toBe(swatchInkColor('#ffffff'));
    // ★ 用户显式挑过的字色压过它（快捷操作栏那一格不是白摆设）
    expect(mindPaletteOf({ ink: '#111111' }, { depth: 0 }).titleInk).toBe('#111111');
  });

  it('★ 字号按层级：根 30 / 一层 18 / 二层及以下 14；只有根加粗', () => {
    expect([0, 1, 2, 5].map((depth) => titleSizeOf(depth))).toEqual([30, 18, 14, 14]);
    expect([0, 1, 2, 5].map((depth) => titleBoldOf(depth))).toEqual([true, false, false, false]);
  });

  it('★ 手调覆盖仍然盖得过层级底色（那是用户自己定的色，P5 的属性面板用）', () => {
    const palette = mindPaletteOf(
      { override: { title: '#ff0000', body: '#ffeeee', ink: '#111111' } },
      { depth: 3 },
    );

    expect(palette.title).toBe('#ff0000');
  });

  it('估算带上层级字号才是对的（30px 的根明显比 14px 占地方）', () => {
    const node = createMindNode({ text: '中心主题' });
    const big = estimateNodeSize(node, { fontSize: 30, titleLineHeight: 41 });
    const small = estimateNodeSize(node, { fontSize: 14, titleLineHeight: 19 });

    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
  });
});

// ── 布局：根与分侧 ───────────────────────────────────────────

describe('layoutMind · 根与分侧', () => {
  it('★ 中心主题居中于原点（世界坐标的原点在根的中心）', () => {
    const file = treeOf('中心');
    const box = boxOf(file, '中心');

    expect(box.x).toBe(-SIZE.width / 2);
    expect(box.y).toBe(-SIZE.height / 2);
    expect(box.depth).toBe(0);
    expect(box.side).toBe(0);
  });

  it('只有根时：外接框就是根那一格', () => {
    const layout = layoutMind(treeOf('中心'), { sizeOf });

    expect(layout.boxes.size).toBe(1);
    expect(layout.bounds).toEqual({
      x: -SIZE.width / 2,
      y: -SIZE.height / 2,
      width: SIZE.width,
      height: SIZE.height,
    });
    expect(layout.hiddenCount).toBe(0);
  });

  it('★ 一个孩子 → 全在右侧，左侧空着', () => {
    const file = treeOf('中心', ['甲']);

    expect(boxOf(file, '甲').side).toBe(1);
    expect(boxOf(file, '甲').x).toBe(SIZE.width / 2 + MIND_LEVEL_GAP);
  });

  it('★ 两个孩子 → 一右一左（贪心分侧：先右后左，结果稳定）', () => {
    const file = treeOf('中心', ['甲', '乙']);

    expect(boxOf(file, '甲').side).toBe(1);
    expect(boxOf(file, '乙').side).toBe(-1);
    // 左侧那个的**右边缘**在根左边缘之外一个间距处
    const left = boxOf(file, '乙');
    expect(left.x + left.width).toBe(-(SIZE.width / 2 + MIND_LEVEL_GAP));
  });

  it('★ 三个孩子 → 右、左、右（按下标交替：加第 N 个时前面几支不动）', () => {
    const file = treeOf('中心', ['甲', '乙', '丙']);

    expect([boxOf(file, '甲').side, boxOf(file, '乙').side, boxOf(file, '丙').side]).toEqual([
      1, -1, 1,
    ]);
  });

  it('★ 折叠一支**不会**把别的支挪到另一边（交替分侧的代价换来的确定性）', () => {
    const shape: (string | [string, string[]])[] = [['甲', ['甲一', '甲二', '甲三']], '乙', '丙'];
    const folded = treeOf('中心', shape);
    folded.nodes.find((node) => node.text === '甲')!.collapsed = true;

    expect(boxOf(folded, '乙').side).toBe(-1);
    expect(boxOf(folded, '丙').side).toBe(1);
  });

  it('两侧各自垂直居中于根（等高时上下对称）', () => {
    const file = treeOf('中心', ['甲', '乙', '丙', '丁']);
    const right = [boxOf(file, '甲'), boxOf(file, '丙')].sort((a, b) => a.y - b.y);
    const left = [boxOf(file, '乙'), boxOf(file, '丁')].sort((a, b) => a.y - b.y);

    // 两侧的"中心"都落在根的 y 上
    const centerOf = (boxes: NodeBox[]) =>
      (boxes[0]!.y + boxes[boxes.length - 1]!.y + SIZE.height) / 2;
    expect(centerOf(right)).toBeCloseTo(0);
    expect(centerOf(left)).toBeCloseTo(0);
    // 兄弟之间是一个"节点高 + 间距"
    expect(right[1]!.y - right[0]!.y).toBe(SIZE.height + MIND_SIBLING_GAP);
  });
});

// ── 布局：层级与列对齐 ───────────────────────────────────────

describe('layoutMind · 层级与列对齐', () => {
  it('★ 同一侧、同一深度的节点**左边缘对齐**（宽窄不一也对齐）', () => {
    // 三个孩子 → 右、左、右：右侧那两个同深度、但宽度不同，左边缘必须一样
    const file = treeOf('中心', ['甲', '乙', '丙']);
    const wide = file.nodes.find((node) => node.text === '甲')!;
    const narrow = file.nodes.find((node) => node.text === '丙')!;

    const layout = layoutMind(file, {
      sizeOf: (node) => (node.text === '甲' ? { width: 160, height: 40 } : SIZE),
    });

    const wideBox = layout.boxes.get(wide.id)!;
    const narrowBox = layout.boxes.get(narrow.id)!;
    expect(wideBox.side).toBe(1);
    expect(narrowBox.side).toBe(1);
    expect(narrowBox.x).toBe(wideBox.x);
    // 列宽按**最宽的那个**算：第 1 列的左边缘 = 根半宽 + 间距
    expect(wideBox.x).toBe(SIZE.width / 2 + MIND_LEVEL_GAP);
  });

  it('孙子辈再往外推一列（列宽 = 同层最宽的那个 + 间距）', () => {
    const file = treeOf('中心', [['甲', ['甲一']]]);
    const layout = layoutMind(file, {
      sizeOf: (node) => (node.text === '甲' ? { width: 160, height: 40 } : SIZE),
    });
    const child = file.nodes.find((node) => node.text === '甲')!;
    const grand = file.nodes.find((node) => node.text === '甲一')!;

    const childBox = layout.boxes.get(child.id)!;
    const grandBox = layout.boxes.get(grand.id)!;
    // 第 2 列 = 第 1 列左边缘 + 第 1 列宽 + 间距
    expect(grandBox.x).toBe(childBox.x + 160 + MIND_LEVEL_GAP);
    expect(grandBox.depth).toBe(2);
  });

  it('父节点垂直居中于它的子树（子树更高时父在上面那段的中点）', () => {
    const file = treeOf('中心', [['甲', ['甲一', '甲二', '甲三']]]);
    const layout = layoutMind(file, { sizeOf });
    const child = file.nodes.find((node) => node.text === '甲')!;
    const grands = ['甲一', '甲二', '甲三'].map((text) =>
      layout.boxes.get(file.nodes.find((node) => node.text === text)!.id)!,
    );

    const childBox = layout.boxes.get(child.id)!;
    const top = grands[0]!.y;
    const bottom = grands[2]!.y + grands[2]!.height;
    expect(childBox.y + childBox.height / 2).toBeCloseTo((top + bottom) / 2);
  });
});

// ── 布局：折叠与悬浮节点 ─────────────────────────────────────

describe('layoutMind · 折叠与悬浮节点', () => {
  it('★ 折叠的节点：整棵子树一个都不排，`hiddenCount` 如实报出来', () => {
    const file = treeOf('中心', [['甲', ['甲一', '甲二']], '乙']);
    file.nodes.find((node) => node.text === '甲')!.collapsed = true;

    const layout = layoutMind(file, { sizeOf });

    expect(layout.boxes.size).toBe(3); // 中心 + 甲 + 乙
    expect(layout.hiddenCount).toBe(2);
    expect(file.nodes.find((node) => node.text === '甲一')).toBeTruthy();
  });

  it('折叠的子树不占高度：同侧的兄弟会往上收', () => {
    // 三个孩子 ⇒ 甲（右）、乙（左）、丙（右）：折叠甲的子树只影响**右侧**那一段
    const shape: (string | [string, string[]])[] = [['甲', ['甲一', '甲二', '甲三']], '乙', '丙'];
    const open = treeOf('中心', shape);
    const folded = treeOf('中心', shape);
    folded.nodes.find((node) => node.text === '甲')!.collapsed = true;

    // 右侧整段从"148 + 14 + 40"缩到"40 + 14 + 40" ⇒ 丙 明显上移
    expect(boxOf(folded, '丙').y).toBeLessThan(boxOf(open, '丙').y);
    // 折叠掉的三个孙子不占位置
    const layout = layoutMind(folded, { sizeOf });
    expect(layout.boxes.size).toBe(4); // 中心 + 甲 + 乙 + 丙
    expect(layout.hiddenCount).toBe(3);
  });

  it('★ 悬浮节点按 `free`（中心点）摆，并标成 free', () => {
    const file = treeOf('中心', ['甲']);
    file.nodes.push(
      createMindNode({ text: '自由', parentId: null, order: 0, free: { x: 320, y: -80 } }),
    );
    const layout = layoutMind(file, { sizeOf });
    const free = file.nodes.find((node) => node.text === '自由')!;
    const box = layout.boxes.get(free.id)!;

    expect(box.free).toBe(true);
    expect(box.x + box.width / 2).toBe(320);
    expect(box.y + box.height / 2).toBe(-80);
    expect(box.side).toBe(0);
  });

  it('悬浮节点缺坐标时按原点摆（`validate` 会补 `{0,0}`，这里也兜一层）', () => {
    const file = treeOf('中心', ['甲']);
    file.nodes.push(createMindNode({ text: '自由', parentId: null, order: 0 }));
    const layout = layoutMind(file, { sizeOf });
    const box = layout.boxes.get(file.nodes[2]!.id)!;

    expect(box.x).toBe(-SIZE.width / 2);
    expect(box.y).toBe(-SIZE.height / 2);
  });

  it('★ 悬浮节点的子树**一律向右**展开（自由主题没有两侧的语义）', () => {
    const file = createMindFile({ title: '中心', now: () => 'T' });
    const free = createMindNode({
      text: '自由',
      parentId: null,
      order: 0,
      free: { x: 400, y: 100 },
    });
    const kid = createMindNode({ text: '子', parentId: free.id, order: 0 });
    file.nodes.push(free, kid);

    const layout = layoutMind(file, { sizeOf });
    const kidBox = layout.boxes.get(kid.id)!;

    // 从自由节点的**右边缘**再往外一个间距
    expect(kidBox.x).toBe(400 + SIZE.width / 2 + MIND_LEVEL_GAP);
    expect(kidBox.y + kidBox.height / 2).toBeCloseTo(100);
    expect(kidBox.depth).toBe(1);
    expect(kidBox.side).toBe(1);
  });
});

// ── 布局：确定性与规模 ───────────────────────────────────────

describe('layoutMind · 确定性与规模', () => {
  it('★ 同一份输入布局两次，结果逐字段相同（没有隐藏的随机 / 时钟依赖）', () => {
    const file = treeOf('中心', [['甲', ['甲一', '甲二']], ['乙', ['乙一']], '丙']);

    const first = layoutMind(file, { sizeOf });
    const second = layoutMind(file, { sizeOf });

    expect([...second.boxes.entries()]).toEqual([...first.boxes.entries()]);
    expect(second.bounds).toEqual(first.bounds);
  });

  it('★ 1000 个节点：全部排进去，且耗时是线性量级（不做 O(n²) 的傻事）', () => {
    const file = createMindFile({ title: '大图', now: () => 'T' });
    const root = file.nodes[0]!;
    // 10 个分支 × 10 × 10 = 1010 个节点
    let order = 0;
    for (let a = 0; a < 10; a++) {
      const branch = createMindNode({ text: `分支${a}`, parentId: root.id, order: order++ });
      file.nodes.push(branch);
      let sub = 0;
      for (let b = 0; b < 10; b++) {
        const mid = createMindNode({ text: `中${a}-${b}`, parentId: branch.id, order: sub++ });
        file.nodes.push(mid);
        for (let c = 0; c < 10; c++) {
          file.nodes.push(createMindNode({ text: `叶${a}-${b}-${c}`, parentId: mid.id, order: c }));
        }
      }
    }

    const started = Date.now();
    const layout = layoutMind(file, { sizeOf });
    const elapsed = Date.now() - started;

    // 1 根 + 10 分支 + 100 中层 + 1000 叶子
    expect(file.nodes).toHaveLength(1111);
    expect(layout.boxes.size).toBe(1111);
    expect(layout.hiddenCount).toBe(0);
    expect(layout.bounds).not.toBeNull();
    // 阈值给得很松（只为抓 O(n²)：1000 节点若退化，这里会是几秒）
    expect(elapsed).toBeLessThan(1000);
  });
});

// ── 配色（`A` 撞色）──────────────────────────────────────────

describe('mindPaletteOf · 撞色', () => {
  it('★ 标题带是主色本身，字色按对比度挑（深底给浅字）', () => {
    const palette = mindPaletteOfHex('#1e293b');

    expect(palette.title).toBe('#1e293b');
    expect(palette.titleInk).toBe(swatchInkColor('#1e293b'));
  });

  it('★ 内容块是**纯白**（撞色只上标题带）：白底 + 深字，任何主色下都读得清', () => {
    const palette = mindPaletteOfHex('#1e293b');

    // ★ 关键的是下面这个**字面量**：拿表达式自比的断言逮不住方向错
    //   （上一版正是 `mixSrgb(白, 主色, 16)` = 84% 主色，文档却写着"浅色版"）
    expect(palette.body).toBe('#ffffff');
    expect(palette.bodyInk).toBe(swatchInkColor('#ffffff'));
    expect(palette.body).toBe(mixSrgb('#1e293b', '#ffffff', MIND_BODY_MIX_PERCENT));
  });

  it('★ 主色的比例调大时才往主色偏（方向的另一头也钉一下）', () => {
    // 不测常量的当前值，只钉**方向**：比例越大，正文底色离白越远、离主色越近
    expect(mixSrgb('#1e293b', '#ffffff', 0)).toBe('#ffffff');
    expect(mixSrgb('#1e293b', '#ffffff', 100)).toBe('#1e293b');
    expect(mixSrgb('#1e293b', '#ffffff', 16)).not.toBe('#ffffff');
  });

  it('同一主色永远得到同一套色（导出稳定、不跟随主题）', () => {
    expect(mindPaletteOfHex('#4c8dff')).toEqual(mindPaletteOfHex('#4c8dff'));
  });

  it('主题色编号：有解析器时用真值，没有时用近似表', () => {
    const resolved = mindPaletteOf({ color: '3' }, { resolveTheme: () => '#123456' });
    const approximated = mindPaletteOf({ color: '3' });

    expect(resolved.title).toBe('#123456');
    expect(approximated.title).not.toBe('#123456');
  });

  it('没写颜色时用兜底主色（不产出非法 CSS）', () => {
    expect(mindPaletteOf(undefined).title).toMatch(/^#[0-9a-f]{6}$/);
    expect(mindPaletteOf({ color: '不是颜色' as never }).title).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('★ 手调覆盖三色齐了就照用，不再算一遍（用户的撞色是用户定的）', () => {
    const palette = mindPaletteOf({
      override: { title: '#ff0000', body: '#ffeeee', ink: '#111111' },
    });

    expect(palette).toEqual({
      title: '#ff0000',
      titleInk: '#111111',
      body: '#ffeeee',
      bodyInk: '#111111',
    });
  });
});

// ── 聚焦当根（`D1`，用户 2026-09-18："树视图也支持进入当前主题"）─────────

describe('layoutMind · 聚焦当根（`D1`）', () => {
  const file = treeOf('中心', ['甲', ['乙', ['丙']]]);

  const idOf = (text: string): string => {
    const node = file.nodes.find((item) => item.text === text);
    if (!node) throw new Error(`没有这个节点：${text}`);
    return node.id;
  };

  const textsIn = (layout: ReturnType<typeof layoutMind>): string[] =>
    [...layout.boxes.keys()].map((id) => file.nodes.find((node) => node.id === id)?.text ?? '');

  it('★ 传了 `focusId` ⇒ **只排那一支**（中心、旁支、别人的子节点一个都不排）', () => {
    const layout = layoutMind(file, { sizeOf, focusId: idOf('乙') });
    const texts = textsIn(layout);

    expect(texts).toContain('乙');
    expect(texts).toContain('丙');
    // ★ 中心主题与旁支的 `parentId` 是 `null` / 别人的 id ⇒ 它们**都不该出现**：
    //   这一条正是"悬浮节点那一趟"要跳过的理由（不跳过就会走进一支之后旁边还杵着它们）
    expect(texts).not.toContain('中心');
    expect(texts).not.toContain('甲');
  });

  it('★ 聚焦的那个节点成了**新的根**（位置跟着变，不是还挂在原来的父下）', () => {
    const whole = layoutMind(file, { sizeOf });
    const focused = layoutMind(file, { sizeOf, focusId: idOf('甲') });

    expect(focused.boxes.get(idOf('甲'))).not.toEqual(whole.boxes.get(idOf('甲')));
    expect(focused.bounds).not.toBeNull();
  });

  it('★ `focusId` 是个不存在的 id ⇒ 退回整棵树（不画一片空白）', () => {
    const whole = layoutMind(file, { sizeOf });
    const broken = layoutMind(file, { sizeOf, focusId: 'n_不存在' });
    expect(broken.boxes.size).toBe(whole.boxes.size);
  });
});
