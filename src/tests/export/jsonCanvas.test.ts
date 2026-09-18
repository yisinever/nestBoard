/**
 * `.canvas` 互转的单元测试（T4.11 / T4.12 / T4.13、`03 §7.4`）。
 *
 * 这块逻辑的失败方式都**不抛错**：一张卡悄悄变成空框、一条连线凭空消失、
 * 别人的 group 被认成别的东西。用户只有在某个下午打开导出的画布时才会发现
 * "怎么少了一半"，而那时源头已经查不清了。所以这里把三类东西钉死：
 *
 * 1. **映射**：每种卡片变成什么节点、每种节点变回什么卡；
 * 2. **损失声明**：降级与丢弃都必须**被数出来**（T4.13 的有损提示就靠这些数字）；
 * 3. **不猜**：认不出的东西一律跳过并计数，绝不硬塞进某个类型。
 *
 * 纯函数 + 内存数据，不碰 Obsidian：写盘与提示那部分只能在 Obsidian 里肉眼验证。
 */

import { describe, expect, it } from 'vitest';
import type { CanvasCardSource, JsonCanvasFile, JsonCanvasNode } from '../../export/jsonCanvas';
import {
  describeCanvasLosses,
  importCanvas,
  parseCanvasFile,
  planCanvasExport,
  serializeCanvas,
} from '../../export/jsonCanvas';
import { COLUMN_LAYOUT } from '../../model/columns';
import { createBoardFile, createEdge } from '../../model/factories';
import type { BoardFile, Card, CardOf, Column, Edge, NoteContent } from '../../model/schema';
import { t } from '../../util/i18n';

/**
 * 假卡片数据源。★ 刻意不引真实注册表：这里要验的是**互转规则**，
 * 用假源可以让每种卡片的文本形态一眼可见（而真实导出物另有它自己的测试）。
 * 唯一照抄真实行为的是 `ink` —— 它确实恒返回空串（矢量笔迹没有 Markdown 形态）。
 */
const cardSource: CanvasCardSource = {
  toMarkdown: (card) => {
    switch (card.type) {
      case 'note':
        return card.content.md;
      case 'syncNote':
        // 与便签同形：正文就是 `md`（T7.04）
        return card.content.md;
      case 'todo':
        return '- [ ] 一件事';
      case 'ink':
        return '';
      // 地图卡（O08）：只写本文件用得到的那两种形态（有链接 / 只有坐标）。
      // ★ 真实实现那三条分支由 `cards/map.test.ts` 盯着，这里只保证**节点映射**
      //   （link 节点 / 文本节点 / 降级）测的是真的东西
      case 'map':
        return card.content.sourceUrl
          ? `[${card.content.label || '地图'}](${card.content.sourceUrl})`
          : card.content.coords
            ? `${card.content.coords.lat}, ${card.content.coords.lon}`
            : '';
      default:
        return `[[${card.type}]]`;
    }
  },
};

function note(id: string, overrides: Partial<CardOf<'note'>> = {}): Card {
  const content: NoteContent = { md: '', editorMode: 'markdown' };
  return {
    id,
    type: 'note',
    x: 0,
    y: 0,
    width: 240,
    height: 160,
    z: 1,
    columnId: null,
    order: 0,
    color: '1',
    accent: null,
    locked: false,
    showTitle: false,
    title: '',
    presentStep: null,
    content,
    ...overrides,
  };
}

function image(id: string, path: string, overrides: Partial<CardOf<'image'>> = {}): Card {
  return {
    id,
    type: 'image',
    x: 0,
    y: 0,
    width: 200,
    height: 150,
    z: 1,
    columnId: null,
    order: 0,
    color: '1',
    accent: null,
    locked: false,
    showTitle: false,
    title: '',
    presentStep: null,
    content: {
      path,
      caption: '',
      width: 200,
      height: 150,
      source: 'vault',
    } as unknown as CardOf<'image'>['content'],
    ...overrides,
  } as Card;
}

function card(
  id: string,
  type: 'todo' | 'swatch' | 'boardRef' | 'ink' | 'syncNote' | 'comment',
  overrides = {},
): Card {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    z: 1,
    columnId: null,
    order: 0,
    color: '1',
    accent: null,
    locked: false,
    showTitle: false,
    title: '',
    presentStep: null,
    content:
      type === 'boardRef'
        ? { path: 'Boards/别的.nboard', preview: 'thumb', showCount: true }
        : type === 'ink'
          ? { paths: [] }
          : type === 'swatch'
            ? { colors: ['#112233'] }
            : type === 'syncNote'
              ? { key: 'sy_1', md: '同一份正文' }
              : type === 'comment'
                ? { entries: [{ id: 'cmt_1', text: '一条备注', at: 1 }], resolved: false }
                : { title: '', items: [] },
    ...overrides,
  } as Card;
}

function link(id: string, url: string): Card {
  return {
    id,
    type: 'link',
    x: 0,
    y: 0,
    width: 260,
    height: 120,
    z: 1,
    columnId: null,
    order: 0,
    color: '1',
    accent: null,
    locked: false,
    showTitle: false,
    title: '',
    presentStep: null,
    content: { url, title: '', description: '', image: '', fetchedAt: null },
  };
}

function column(id: string, overrides: Partial<Column> = {}): Column {
  return {
    id,
    title: id,
    x: 0,
    y: 0,
    width: 280,
    height: 400,
    collapsed: false,
    color: '2',
    z: 1,
    ...overrides,
  };
}

function boardOf(cards: Card[], columns: Column[] = [], edges: Edge[] = []): BoardFile {
  return { ...createBoardFile({ meta: { title: '项目A' } }), cards, columns, edges };
}

const options = { sourcePath: 'Boards/项目A.nboard' };

function planOf(board: BoardFile) {
  return planCanvasExport(board, cardSource, options);
}

/** 按 id 取节点（测试里几乎每条都要找某个节点） */
function nodeOf(canvas: JsonCanvasFile, id: string): JsonCanvasNode {
  const node = canvas.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

describe('planCanvasExport：卡片 → 节点', () => {
  it('便签卡变文本节点，正文原样', () => {
    const plan = planOf(boardOf([note('c1', { content: { md: '正文', editorMode: 'markdown' } })]));

    expect(plan.canvas.nodes).toHaveLength(1);
    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'text', text: '正文' });
  });

  it('同步便签卡也是文本节点：同组两张各是一个节点（板上本来就是两处）', () => {
    const plan = planOf(
      boardOf([
        card('c1', 'syncNote', { content: { key: 'sy_1', md: '同一份正文' } }),
        card('c2', 'syncNote', { content: { key: 'sy_1', md: '同一份正文' } }),
      ]),
    );

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'text', text: '同一份正文' });
    expect(nodeOf(plan.canvas, 'c2')).toMatchObject({ type: 'text', text: '同一份正文' });
    // 文本节点是这张卡正常的形态，不算损失
    expect(plan.degraded).toEqual([]);
  });

  it('评论卡也是文本节点：整条线程按顺序落成一段，条目之间空一行（T7.05）', () => {
    const plan = planOf(
      boardOf([
        card('c1', 'comment', {
          content: {
            entries: [
              { id: 'cmt_1', text: '先这样', at: 1 },
              { id: 'cmt_2', text: '后来改成那样', at: 2 },
            ],
            resolved: false,
          },
        }),
      ]),
    );

    // 时间戳不进导出：`.canvas` 的文本节点是给别人读的内容，不是运行日志
    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({
      type: 'text',
      text: '先这样\n\n后来改成那样',
    });
    expect(plan.degraded).toEqual([]);
  });

  it('卡片**看得见**的标题跟着走（补成一级标题）', () => {
    const plan = planOf(
      boardOf([
        note('c1', {
          showTitle: true,
          title: '会议纪要',
          content: { md: '正文', editorMode: 'markdown' },
        }),
      ]),
    );

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ text: '# 会议纪要\n\n正文' });
  });

  it('标题没在显示（`showTitle` 为假）时不补 —— 那是元数据，画布上本来就没显示', () => {
    const plan = planOf(
      boardOf([
        note('c1', {
          showTitle: false,
          title: '会议纪要',
          content: { md: '正文', editorMode: 'markdown' },
        }),
      ]),
    );

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ text: '正文' });
  });

  it('只有标题、没有正文时，文本就是那行标题（不留空节点）', () => {
    const plan = planOf(boardOf([note('c1', { showTitle: true, title: '只有标题' })]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ text: '# 只有标题' });
  });

  it('引用卡变 file 节点，子路径跟着走', () => {
    const plan = planOf(
      boardOf([
        {
          ...note('c1'),
          type: 'noteRef',
          content: { path: 'Notes/甲.md', subpath: '#第二节', mode: 'embed', excerptLines: 8 },
        } as Card,
      ]),
    );

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({
      type: 'file',
      file: 'Notes/甲.md',
      subpath: '#第二节',
    });
  });

  it('没有子路径时不写 `subpath` 字段（不是写一个空串）', () => {
    const plan = planOf(
      boardOf([
        {
          ...note('c1'),
          type: 'noteRef',
          content: { path: 'Notes/甲.md', subpath: null, mode: 'embed', excerptLines: 8 },
        } as Card,
      ]),
    );

    expect(nodeOf(plan.canvas, 'c1')).not.toHaveProperty('subpath');
  });

  it('图片卡 / 文件卡变 file 节点', () => {
    const plan = planOf(boardOf([image('c1', 'assets/图.png'), card('c2', 'boardRef')]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'file', file: 'assets/图.png' });
  });

  it('路径为空的图片卡只能降级成文本，并计入损失', () => {
    const plan = planOf(boardOf([image('c1', '   ')]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'text' });
    expect(plan.degraded).toEqual([{ type: 'image', count: 1 }]);
  });

  it('链接卡变 link 节点', () => {
    const plan = planOf(boardOf([link('c1', 'https://example.com')]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'link', url: 'https://example.com' });
  });

  // ── 地图卡（O08）：没图但有链接时**不算降级** ────────────────────
  // ★ 一张贴过链接、只差一张图的卡，画布上有一条能点开的地址就够了 ——
  //   它完整地表达了这张卡。之前会掉进"降级成文本"，用户还会看到一条损失提示，
  //   而那条提示是错的：什么都没丢。
  function map(id: string, content: Record<string, unknown>): Card {
    return {
      id,
      type: 'map',
      x: 0,
      y: 0,
      width: 320,
      height: 240,
      z: 1,
      columnId: null,
      order: 0,
      color: '1',
      accent: null,
      locked: false,
      showTitle: false,
      title: '',
      presentStep: null,
      content: { path: '', label: '', pin: null, ...content },
    } as unknown as Card;
  }

  it('有图的地图卡变 file 节点（与图片卡同理）', () => {
    const plan = planOf(boardOf([map('c1', { path: 'assets/地图.png' })]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'file', file: 'assets/地图.png' });
  });

  it('没图但有链接 → link 节点，且**不计**损失', () => {
    const plan = planOf(boardOf([map('c1', { sourceUrl: 'https://maps.google.com/?q=1,2' })]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({
      type: 'link',
      url: 'https://maps.google.com/?q=1,2',
    });
    expect(plan.degraded).toEqual([]);
  });

  it('三条都没有的地图卡才降级成文本（那是真的空框）', () => {
    const plan = planOf(boardOf([map('c1', {})]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'text' });
    expect(plan.degraded).toEqual([{ type: 'map', count: 1 }]);
  });

  it('只有坐标没有链接：坐标自己就是文本节点（而不是一句"这里是地图卡"的占位）', () => {
    const plan = planOf(boardOf([map('c1', { coords: { lat: 39.9042, lon: 116.4074 } })]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'text', text: '39.9042, 116.4074' });
  });

  it('没有 URL 的链接卡降级成文本', () => {
    const plan = planOf(boardOf([link('c1', '  ')]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ type: 'text' });
    expect(plan.degraded).toEqual([{ type: 'link', count: 1 }]);
  });

  it('待办 / 色板 / 白板卡 / 手绘降级成文本，且按数量降序计数', () => {
    const plan = planOf(
      boardOf([
        card('c1', 'todo'),
        card('c2', 'todo'),
        card('c3', 'swatch'),
        card('c4', 'boardRef'),
        card('c5', 'ink'),
      ]),
    );

    // 全部是 `text` 节点，内容是卡片自己的 Markdown 形态
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      expect(nodeOf(plan.canvas, id)).toMatchObject({ type: 'text' });
    }
    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ text: '- [ ] 一件事' });
    expect(nodeOf(plan.canvas, 'c3')).toMatchObject({ text: '[[swatch]]' });

    // 数量降序：todo 2 条排第一
    expect(plan.degraded[0]).toEqual({ type: 'todo', count: 2 });
    expect(plan.degraded.reduce((sum, item) => sum + item.count, 0)).toBe(5);
  });

  it('手绘卡（导出物恒为空串）留一句占位文本，而不是一个隐形空框', () => {
    const plan = planOf(boardOf([card('c1', 'ink')]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({
      type: 'text',
      text: t('canvas.node.placeholder', { type: t('card.type.ink') }),
    });
    expect(plan.placeholders).toBe(1);
  });

  it('有损失的画布才报损失；干净的画布 `degraded` / `placeholders` 都是空', () => {
    const plan = planOf(boardOf([note('c1'), image('c2', 'assets/图.png')]));

    expect(plan.degraded).toEqual([]);
    expect(plan.placeholders).toBe(0);
    expect(plan.droppedEdges).toBe(0);
  });
});

describe('planCanvasExport：几何、颜色与顺序', () => {
  it('坐标取整，尺寸下限 1', () => {
    const plan = planOf(boardOf([note('c1', { x: 10.6, y: -4.4, width: 0, height: 12.2 })]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ x: 11, y: -4, width: 1, height: 12 });
  });

  it('颜色原样传给画布（`"1"`~`"6"` 与十六进制两边同语义）', () => {
    const plan = planOf(boardOf([note('c1', { color: '3' }), note('c2', { color: '#AABBCC' })]));

    expect(nodeOf(plan.canvas, 'c1')).toMatchObject({ color: '3' });
    // ★ 十六进制**原样**（连大小写都不动）：颜色是用户选的值，不是我们算出来的值
    expect(nodeOf(plan.canvas, 'c2')).toMatchObject({ color: '#AABBCC' });
  });

  it('分栏变 group 节点，标题进 `label`', () => {
    const plan = planOf(boardOf([], [column('col1', { title: '待办', x: 10, y: 20 })]));

    expect(nodeOf(plan.canvas, 'col1')).toMatchObject({
      type: 'group',
      label: '待办',
      x: 10,
      y: 20,
      width: 280,
      height: 400,
    });
  });

  it('没标题的分栏不写 `label`', () => {
    const plan = planOf(boardOf([], [column('col1', { title: '' })]));

    expect(nodeOf(plan.canvas, 'col1')).not.toHaveProperty('label');
  });

  it('节点按 z 升序，且**所有 group 排在最前**（分栏在我们这边本来就画在卡片之下）', () => {
    const plan = planOf(
      boardOf([note('low', { z: 1 }), note('high', { z: 5 })], [column('col1', { z: 3 })]),
    );

    expect(plan.canvas.nodes.map((node) => node.id)).toEqual(['col1', 'low', 'high']);
  });

  it('z 相同时按 id 排 —— 同一块板子导出两次必须**一模一样**', () => {
    const board = boardOf([note('b', { z: 2 }), note('a', { z: 2 })]);
    const first = planOf(board).text;
    const second = planOf(board).text;

    expect(planOf(board).canvas.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(first).toBe(second);
  });
});

describe('planCanvasExport：连线', () => {
  it('端点、箭头、颜色、标签都带过去', () => {
    const edge = createEdge(
      { cardId: 'c1', side: 'right' },
      { cardId: 'c2', side: 'left' },
      { label: '依赖', color: '4', fromEnd: 'arrow', toEnd: 'none' },
    );
    const plan = planOf(boardOf([note('c1'), note('c2')], [], [edge]));

    expect(plan.canvas.edges).toEqual([
      {
        id: edge.id,
        fromNode: 'c1',
        fromSide: 'right',
        toNode: 'c2',
        toSide: 'left',
        fromEnd: 'arrow',
        toEnd: 'none',
        color: '4',
        label: '依赖',
      },
    ]);
  });

  it('自动选边（`side: null`）就是**省略字段** —— 往返之后"自动翻面"仍然成立', () => {
    const edge = createEdge({ cardId: 'c1', side: null }, { cardId: 'c2', side: null });
    const plan = planOf(boardOf([note('c1'), note('c2')], [], [edge]));
    const canvasEdge = plan.canvas.edges[0];

    expect(canvasEdge).not.toHaveProperty('fromSide');
    expect(canvasEdge).not.toHaveProperty('toSide');
  });

  it('空标签不写 `label`', () => {
    const edge = createEdge({ cardId: 'c1', side: null }, { cardId: 'c2', side: null });
    const plan = planOf(boardOf([note('c1'), note('c2')], [], [edge]));

    expect(plan.canvas.edges[0]).not.toHaveProperty('label');
  });

  it('自由端（一头悬空）的连线只能丢掉，并**数出来**', () => {
    const free = createEdge({ cardId: 'c1', side: null }, { cardId: '', side: null });
    const plan = planOf(boardOf([note('c1')], [], [free]));

    expect(plan.canvas.edges).toEqual([]);
    expect(plan.droppedEdges).toBe(1);
    expect(plan.edges).toBe(0);
  });
});

describe('serializeCanvas', () => {
  it('Tab 缩进 + 结尾换行（导出的文件多半要进 git，diff 才不整篇重排）', () => {
    const text = serializeCanvas({ nodes: [], edges: [] });

    expect(text).toBe('{\n\t"nodes": [],\n\t"edges": []\n}\n');
  });
});

/**
 * 损失清单（T4.13）。
 *
 * 这是用户**唯一**能提前知道"导出去会少东西"的地方：对话框、命令面板提示都只读它。
 * 所以钉两件事：无损时不出行（否则用户会在无损的板子上白紧张一次），
 * 有损时**每一类损失都有自己的一行**（合成一句话就会漏说某一类）。
 */
describe('describeCanvasLosses', () => {
  it('无损时返回空数组（调用方据此显示"不会有损失"）', () => {
    const plan = planOf(boardOf([note('c1'), image('c2', 'assets/图.png')]));

    expect(describeCanvasLosses(plan)).toEqual([]);
  });

  it('每种降级类型各一行，用卡片类型名而不是内部标识', () => {
    const plan = planOf(boardOf([card('c1', 'todo'), card('c2', 'todo'), card('c3', 'ink')]));
    const lines = describeCanvasLosses(plan);

    // 数量降序：todo 在前
    expect(lines[0]).toBe(
      t('modal.exportCanvas.degraded', { count: 2, type: t('card.type.todo') }),
    );
    expect(lines.some((line) => line.includes(t('card.type.ink')))).toBe(true);
  });

  it('占位文本与悬空连线各占一行，且与降级分开说', () => {
    const free = createEdge({ cardId: 'c1', side: null }, { cardId: '', side: null });
    const plan = planOf(boardOf([card('c1', 'ink')], [], [free]));
    const lines = describeCanvasLosses(plan);

    // 三条：ink 降级 + 一个占位文本 + 一条悬空连线被丢
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(t('modal.exportCanvas.placeholders', { count: 1 }));
    expect(lines[2]).toBe(t('modal.exportCanvas.droppedEdges', { count: 1 }));
  });

  it('折叠分栏与外观修饰排在最后（内容损失在前，外观在后）', () => {
    const dashed = createEdge(
      { cardId: 'c1', side: null },
      { cardId: 'c2', side: null },
      { style: 'dashed' },
    );
    const plan = planOf(
      boardOf(
        [card('c1', 'todo'), note('c2', { accent: '#ff0000' })],
        [column('col1', { collapsed: true })],
        [dashed],
      ),
    );
    const lines = describeCanvasLosses(plan);

    // todo 降级 → 折叠分栏 → 外观修饰（1 个强调色条 + 1 条虚线连线）
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(t('card.type.todo'));
    expect(lines[1]).toBe(t('modal.exportCanvas.collapsedColumns', { count: 1 }));
    expect(lines[2]).toBe(t('modal.exportCanvas.cosmetic', { count: 2 }));
  });

  it('★ 转过的卡片算进"纯外观修饰"（JSON Canvas 的节点没有角度这回事）', () => {
    const plan = planOf(boardOf([note('c1', { rotation: 30 })]));

    expect(plan.cosmetic).toBe(1);
    expect(describeCanvasLosses(plan)).toEqual([t('modal.exportCanvas.cosmetic', { count: 1 })]);
  });

  it('旋转**不**折进节点的外接框：对面宁可看到一张正着的卡，也不该看到"变大的卡"', () => {
    const turned: Card = { ...note('c1'), rotation: 45 };
    const canvas = planOf(boardOf([turned])).canvas;

    const node = nodeOf(canvas, 'c1');
    expect(node.width).toBe(turned.width);
    expect(node.height).toBe(turned.height);
  });

  it('什么都没丢时说"没有损失"（外观也是默认样式的干净板子）', () => {
    const plan = planOf(
      boardOf(
        [note('c1')],
        [column('col1')],
        [createEdge({ cardId: 'c1', side: null }, { cardId: 'c1', side: null })],
      ),
    );

    expect(describeCanvasLosses(plan)).toEqual([]);
  });
});

describe('parseCanvasFile', () => {
  it('坏 JSON 与"不是 canvas"要分得开（提示与排查方向都不一样）', () => {
    expect(parseCanvasFile('{ 不是 json')).toEqual({ ok: false, reason: 'json' });
    expect(parseCanvasFile('[]')).toEqual({ ok: false, reason: 'shape' });
    expect(parseCanvasFile('{"nodes": {}}')).toEqual({ ok: false, reason: 'shape' });
    expect(parseCanvasFile('null')).toEqual({ ok: false, reason: 'shape' });
  });

  it('没有 `edges` 字段的 canvas 是合法的（当空数组）', () => {
    const result = parseCanvasFile('{"nodes": []}');

    expect(result).toEqual({ ok: true, canvas: { nodes: [], edges: [] } });
  });
});

describe('importCanvas：节点 → 卡片', () => {
  function importOf(nodes: JsonCanvasNode[], edges: JsonCanvasFile['edges'] = []) {
    return importCanvas({ nodes, edges }, { title: '导入的板子' });
  }

  function textNode(id: string, x: number, y: number, text: string): JsonCanvasNode {
    return { id, type: 'text', x, y, width: 240, height: 160, text };
  }

  it('文本节点变便签卡；`# 标题` 那行**留在正文里**，不抠出来当卡片标题', () => {
    const result = importOf([textNode('n1', 10, 20, '# 甲\n\n正文')]);
    if (!result.ok) throw new Error('import failed');

    const first = result.board.cards[0];
    expect(first).toMatchObject({ type: 'note', title: '', showTitle: false });
    expect(first.content).toMatchObject({ md: '# 甲\n\n正文' });
    expect(result.report).toMatchObject({ cards: 1, columns: 0, edges: 0 });
  });

  it('坐标与尺寸保真，颜色认得出就带走', () => {
    const result = importOf([
      { id: 'n1', type: 'text', x: 10.4, y: -20.6, width: 240, height: 160, text: '', color: '5' },
    ]);
    if (!result.ok) throw new Error('import failed');

    expect(result.board.cards[0]).toMatchObject({ x: 10, y: -21, color: '5' });
  });

  it('认不出的颜色回落到默认色（不抛错，也不把怪值写进模型）', () => {
    const result = importOf([
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 240,
        height: 160,
        text: '',
        color: 'chartreuse',
      },
    ]);
    if (!result.ok) throw new Error('import failed');

    expect(result.board.cards[0].color).toBe('1');
  });

  it('file 节点按扩展名分派：图片 / 引用 / 白板 / 其它', () => {
    const result = importOf([
      { id: 'n1', type: 'file', x: 0, y: 0, width: 100, height: 100, file: 'assets/图.png' },
      {
        id: 'n2',
        type: 'file',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        file: 'Notes/甲.md',
        subpath: '#乙',
      },
      { id: 'n3', type: 'file', x: 0, y: 0, width: 100, height: 100, file: 'Boards/别的.nboard' },
      { id: 'n4', type: 'file', x: 0, y: 0, width: 100, height: 100, file: 'docs/表.xlsx' },
    ]);
    if (!result.ok) throw new Error('import failed');

    expect(result.board.cards.map((item) => item.type)).toEqual([
      'image',
      'noteRef',
      'boardRef',
      'file',
    ]);
    expect(result.board.cards[1].content).toMatchObject({ path: 'Notes/甲.md', subpath: '#乙' });
  });

  it('子路径没写 `#` 一律当没有 —— 不去猜它指的是标题还是块', () => {
    const result = importOf([
      {
        id: 'n1',
        type: 'file',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        file: 'Notes/甲.md',
        subpath: '第二节',
      },
    ]);
    if (!result.ok) throw new Error('import failed');

    expect(result.board.cards[0].type).toBe('noteRef');
    expect(result.board.cards[0].content).toMatchObject({ subpath: null });
  });

  it('link 节点变链接卡', () => {
    const result = importOf([
      { id: 'n1', type: 'link', x: 0, y: 0, width: 260, height: 120, url: 'https://example.com' },
    ]);
    if (!result.ok) throw new Error('import failed');

    expect(result.board.cards[0]).toMatchObject({ type: 'link' });
    expect(result.board.cards[0].content).toMatchObject({ url: 'https://example.com' });
  });

  it('认不出的节点类型跳过并点名，不硬塞成便签卡', () => {
    const result = importOf([
      textNode('n1', 0, 0, '留着'),
      {
        id: 'n2',
        type: 'future-thing',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      } as unknown as JsonCanvasNode,
      {
        id: 'n3',
        type: 'text',
        x: 0,
        y: 0,
        width: 10,
        text: '缺 height',
      } as unknown as JsonCanvasNode,
    ]);
    if (!result.ok) throw new Error('import failed');

    expect(result.board.cards).toHaveLength(1);
    expect(result.report.skippedNodes).toBe(2);
    expect(result.report.unknownTypes).toEqual(['future-thing']);
  });

  it('一个可用节点都没有 → 明确失败（而不是造一块空板）', () => {
    expect(importOf([])).toEqual({ ok: false, reason: 'empty' });
    expect(
      importOf([
        { id: 'n1', type: 'nope', x: 0, y: 0, width: 1, height: 1 } as unknown as JsonCanvasNode,
      ]),
    ).toEqual({ ok: false, reason: 'empty' });
  });

  it('只有 group、没有节点也是合法输入（一块只有分栏的板子）', () => {
    const result = importOf([
      { id: 'g1', type: 'group', x: 0, y: 0, width: 300, height: 500, label: '甲' },
    ]);

    if (!result.ok) throw new Error('import failed');
    expect(result.report.columns).toBe(1);
    expect(result.board.cards).toHaveLength(0);
    expect(result.board.columns[0].title).toBe('甲');
  });
});

describe('importCanvas：group → 分栏', () => {
  function importOf(nodes: JsonCanvasNode[]) {
    return importCanvas({ nodes, edges: [] }, { title: '导入的板子' });
  }

  const group: JsonCanvasNode = {
    id: 'g1',
    type: 'group',
    x: 0,
    y: 0,
    width: 300,
    height: 600,
    label: '待办',
  };

  it('中心点落在 group 里的卡片入栏，栏内顺序按画布上的 y', () => {
    const result = importOf([
      group,
      { id: 'n1', type: 'text', x: 10, y: 300, width: 100, height: 100, text: '下面' },
      { id: 'n2', type: 'text', x: 10, y: 60, width: 100, height: 100, text: '上面' },
      { id: 'n3', type: 'text', x: 900, y: 60, width: 100, height: 100, text: '外面' },
    ]);
    if (!result.ok) throw new Error('import failed');

    const board = result.board;
    const columnId = board.columns[0].id;
    const byText = (text: string) =>
      board.cards.find((item) => item.type === 'note' && item.content.md === text);

    expect(byText('上面')?.columnId).toBe(columnId);
    expect(byText('下面')?.columnId).toBe(columnId);
    expect(byText('上面')?.order).toBe(0);
    expect(byText('下面')?.order).toBe(1);
    // 栏外的卡不受影响：它本来就没有栏
    expect(byText('外面')?.columnId).toBeNull();
  });

  it('入栏的卡片会被分栏布局重排（这是分栏模型的既定形变，不是 bug）', () => {
    const result = importOf([
      group,
      { id: 'n1', type: 'text', x: 10, y: 60, width: 100, height: 100, text: '甲' },
    ]);
    if (!result.ok) throw new Error('import failed');

    const column = result.board.columns[0];
    const member = result.board.cards[0];
    expect(member.x).toBe(column.x + COLUMN_LAYOUT.padding);
    expect(member.y).toBeGreaterThan(column.y);
  });

  it('栏太窄时自动撑宽，成员不会被压瘦', () => {
    // 卡片比 group 宽（`.canvas` 里 group 常常是贴着卡片画的），但中心点在 group 内
    const result = importOf([
      { id: 'g1', type: 'group', x: 0, y: 0, width: 200, height: 400, label: '窄' },
      { id: 'n1', type: 'text', x: -200, y: 50, width: 600, height: 100, text: '宽卡' },
    ]);
    if (!result.ok) throw new Error('import failed');

    const column = result.board.columns[0];
    expect(result.board.cards[0].columnId).toBe(column.id);
    expect(column.width).toBeGreaterThanOrEqual(600 + COLUMN_LAYOUT.padding * 2);
    expect(result.board.cards[0].width).toBeGreaterThanOrEqual(600);
  });

  it('嵌套 group 取最内层（我们的分栏不允许嵌套）', () => {
    const result = importOf([
      { id: 'outer', type: 'group', x: 0, y: 0, width: 1000, height: 1000, label: '外' },
      { id: 'inner', type: 'group', x: 100, y: 100, width: 300, height: 300, label: '内' },
      { id: 'n1', type: 'text', x: 150, y: 150, width: 100, height: 100, text: '在里层' },
    ]);
    if (!result.ok) throw new Error('import failed');

    const inner = result.board.columns.find((item) => item.title === '内');
    const outer = result.board.columns.find((item) => item.title === '外');
    expect(result.board.cards[0].columnId).toBe(inner?.id);
    expect(result.board.cards[0].columnId).not.toBe(outer?.id);
  });
});

describe('importCanvas：连线', () => {
  it('端点映射到新建的卡片，箭头与标签带回来', () => {
    const result = importCanvas(
      {
        nodes: [
          { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: '甲' },
          { id: 'n2', type: 'text', x: 300, y: 0, width: 100, height: 100, text: '乙' },
        ],
        edges: [
          {
            id: 'e1',
            fromNode: 'n1',
            fromSide: 'bottom',
            toNode: 'n2',
            toEnd: 'none',
            color: '2',
            label: '依赖',
          },
        ],
      },
      { title: '导入的板子' },
    );
    if (!result.ok) throw new Error('import failed');

    const [first, second] = result.board.cards;
    expect(result.board.edges).toHaveLength(1);
    expect(result.board.edges[0]).toMatchObject({
      from: { cardId: first.id, side: 'bottom' },
      to: { cardId: second.id, side: null },
      fromEnd: 'none',
      toEnd: 'none',
      color: '2',
      label: '依赖',
    });
    expect(result.report.edges).toBe(1);
  });

  it('认不出的选边当"自动"、认不出的箭头形状回落到默认', () => {
    const result = importCanvas(
      {
        nodes: [
          { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: '甲' },
          { id: 'n2', type: 'text', x: 300, y: 0, width: 100, height: 100, text: '乙' },
        ],
        edges: [
          {
            id: 'e1',
            fromNode: 'n1',
            fromSide: 'north-east' as never,
            toNode: 'n2',
            fromEnd: 'diamond' as never,
            toEnd: 'dot' as never,
          },
        ],
      },
      { title: '导入的板子' },
    );
    if (!result.ok) throw new Error('import failed');

    expect(result.board.edges[0]).toMatchObject({
      from: { side: null },
      fromEnd: 'none',
      toEnd: 'arrow',
    });
  });

  it('★ 指向认不出的节点的连线跳过并计数；指向 group 的连线**保留**（`O21`）', () => {
    const result = importCanvas(
      {
        nodes: [
          { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: '甲' },
          { id: 'g1', type: 'group', x: 0, y: 0, width: 400, height: 400 },
          {
            id: 'bad',
            type: 'future',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          } as unknown as JsonCanvasNode,
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', toNode: 'g1' },
          { id: 'e2', fromNode: 'n1', toNode: 'bad' },
          { id: 'e3', fromNode: 'n1', toNode: 'n1' },
        ],
      },
      { title: '导入的板子' },
    );
    if (!result.ok) throw new Error('import failed');

    // e2 才是"跳过"的那条（端点是个认不出的节点）
    expect(result.report.skippedEdges).toBe(1);
    // e1 连到 group = 连到分栏：规范里合法，且分栏现在是真端点，不能丢；
    // e3 是自己连自己，`.canvas` 与模型都允许，照建
    expect(result.board.edges).toHaveLength(2);
    // ★ 分栏 id 与节点 id 不是同一个东西：映射漏了的话这里会是 n1 或 undefined
    expect(result.board.edges[0].to.cardId).toBe(result.board.columns[0].id);
  });
});

describe('往返：导出的 `.canvas` 再导入', () => {
  it('文本 / 文件 / 链接 / 分栏 / 连线五样都还在', () => {
    const original = boardOf(
      [
        note('c1', {
          x: 0,
          y: 0,
          title: '备忘',
          showTitle: true,
          content: { md: '正文', editorMode: 'markdown' },
        }),
        image('c2', 'assets/图.png', { x: 400, y: 0 }),
        link('c3', 'https://example.com'),
      ],
      [column('col1', { title: '甲栏' })],
      [
        createEdge(
          { cardId: 'c1', side: 'right' },
          { cardId: 'c2', side: null },
          { label: '看图' },
        ),
      ],
    );

    const exported = planOf(original);
    const parsed = parseCanvasFile(exported.text);
    if (!parsed.ok) throw new Error('parse failed');

    const imported = importCanvas(parsed.canvas, { title: '项目A' });
    if (!imported.ok) throw new Error('import failed');

    expect(imported.report).toMatchObject({ cards: 3, columns: 1, edges: 1, skippedNodes: 0 });
    expect(imported.board.cards.map((item) => item.type).sort()).toEqual(['image', 'link', 'note']);
    expect(imported.board.columns[0].title).toBe('甲栏');

    // 连线两端仍然指着"同一对卡片"（id 变了，但两端都对得上）
    const edge = imported.board.edges[0];
    const noteCard = imported.board.cards.find((item) => item.type === 'note');
    const imageCard = imported.board.cards.find((item) => item.type === 'image');
    expect(edge.from.cardId).toBe(noteCard?.id);
    expect(edge.to.cardId).toBe(imageCard?.id);
    expect(edge.from.side).toBe('right');
    expect(edge.to.side).toBeNull();
    expect(edge.label).toBe('看图');
  });
});
