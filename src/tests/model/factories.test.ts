import { describe, expect, it } from 'vitest';
import {
  createBoardFile,
  createCard,
  createColumn,
  createEdge,
  createGroup,
  DEFAULT_CARD_SIZES,
  maxZ,
  nextZ,
} from '../../model/factories';
import { BOARD_REF_MINI_SIZE, BOARD_SPEC, BOARD_VERSION } from '../../constants';

describe('createCard', () => {
  it('note 卡带默认尺寸与空内容标识', () => {
    const card = createCard('note');
    expect(card.type).toBe('note');
    expect(card.width).toBe(DEFAULT_CARD_SIZES.note.width);
    expect(card.height).toBe(DEFAULT_CARD_SIZES.note.height);
    expect(card.content).toEqual({ md: '', editorMode: 'markdown' });
    expect(card.columnId).toBeNull();
    expect(card.accent).toBeNull();
    expect(card.color).toBe('1');
    expect(card.id).toMatch(/^c_/);
  });

  it('content 走浅合并：只覆盖传入的字段，其余保留默认（T1.08 关键行为）', () => {
    const card = createCard('noteRef', { content: { path: 'Note/A.md' } });
    expect(card.content).toEqual({
      path: 'Note/A.md',
      subpath: null,
      mode: 'summary',
      excerptLines: 6,
    });
  });

  it('基础字段覆盖生效，且不影响未传入字段', () => {
    const card = createCard('image', { x: 42, y: -7, title: '图', width: 500 });
    expect(card.x).toBe(42);
    expect(card.y).toBe(-7);
    expect(card.title).toBe('图');
    expect(card.width).toBe(500);
    // 未传入 → 仍是该类型的默认高度
    expect(card.height).toBe(DEFAULT_CARD_SIZES.image.height);
    expect(card.content).toEqual({
      path: '',
      caption: '',
      crop: { x: 0, y: 0, w: 1, h: 1 },
      fit: 'cover',
    });
  });

  it('不同类型互不干扰，且各自 content 形状正确', () => {
    expect(createCard('todo').content).toEqual({ title: '', items: [] });
    expect(createCard('ink').content).toEqual({ paths: [] });
    expect(createCard('swatch').content).toEqual({ colors: [], pickedFrom: null });
    // ★ 白板卡的默认内容 = **迷你形式 + 一个随机记号**（`newBoardRefContent`）：
    //   记号是随机的，所以只钉"给了"而不钉"是哪一个"（否则这条用例每次跑结果都不同）
    const boardRefCard = createCard('boardRef');
    expect(boardRefCard.content).toMatchObject({ path: '', preview: 'mini', showCount: true });
    expect(typeof boardRefCard.content.icon).toBe('string');
    expect((boardRefCard.content.icon ?? '').length).toBeGreaterThan(0);
    // ★ 尺寸也必须是那个**正方形**：默认尺寸还留着 300×200 的话，新建出来是
    //   "迷你排版塞在大方块里"的四不像，而重开时被读入口掰成正方形 ——
    //   表现就是"新建不是迷你、重载之后才变迷你"（真实报障，回归过一次）
    expect(boardRefCard.width).toBe(BOARD_REF_MINI_SIZE.width);
    expect(boardRefCard.height).toBe(BOARD_REF_MINI_SIZE.height);
  });

  it('连续创建不产生重复 id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createCard('note').id));
    expect(ids.size).toBe(200);
  });

  it('★ 便签 / 同步便签默认就带标题行（2026-09-14：对齐待办卡的"先标题后正文"编辑体验）', () => {
    // 便签的编辑态是"标题框 + 正文框"两格（O22），标题行（showTitle）只决定**显示态**
    // 顶部要不要画那行名字；默认开着，新建便签的标题在显示态与编辑态都看得见。
    expect(createCard('note').showTitle).toBe(true);
    expect(createCard('syncNote').showTitle).toBe(true);
    // 其余类型的"标题"是 caption / 文件名 / 清单标题，默认不该平白多一条空标题带
    expect(createCard('image').showTitle).toBe(false);
    expect(createCard('todo').showTitle).toBe(false);
    expect(createCard('link').showTitle).toBe(false);
    expect(createCard('swatch').showTitle).toBe(false);
  });
});

describe('createBoardFile', () => {
  it('默认是一块合法的空板', () => {
    const board = createBoardFile();
    expect(board.spec).toBe(BOARD_SPEC);
    expect(board.version).toBe(BOARD_VERSION);
    expect(board.revision).toBe(0);
    expect(board.cards).toEqual([]);
    expect(board.columns).toEqual([]);
    expect(board.edges).toEqual([]);
    expect(board.groups).toEqual([]);
    expect(board.view).toEqual({ x: 0, y: 0, zoom: 1, background: 'dots' });
    expect(board.settings.snapToGrid).toBe(true);
    expect(board.meta.id).toMatch(/^nb_/);
    expect(board.meta.parent).toBeNull();
  });

  it('meta / view / settings 支持部分覆盖', () => {
    const board = createBoardFile({
      revision: 7,
      meta: { title: '项目白板', parent: 'Boards/parent.nboard' },
      view: { zoom: 0.5 },
      settings: { gridSize: 32 },
    });
    expect(board.revision).toBe(7);
    expect(board.meta.title).toBe('项目白板');
    expect(board.meta.parent).toBe('Boards/parent.nboard');
    expect(board.view.zoom).toBe(0.5);
    expect(board.view.background).toBe('dots');
    expect(board.settings.gridSize).toBe(32);
    expect(board.settings.readOnly).toBe(false);
  });
});

describe('createColumn / createEdge / createGroup', () => {
  it('分栏有默认尺寸，且模型层不提供嵌套字段（T1.60 的硬约束）', () => {
    const column = createColumn({ title: '待办' });
    expect(column.id).toMatch(/^col_/);
    expect(column.width).toBeGreaterThan(0);
    expect(column.collapsed).toBe(false);
    expect(Object.keys(column)).not.toContain('parentColumnId');
  });

  it('连线默认 fromEnd=none / toEnd=arrow，与 JSON Canvas 语义一致', () => {
    const edge = createEdge({ cardId: 'c_1', side: null }, { cardId: 'c_2', side: 'right' });
    expect(edge.fromEnd).toBe('none');
    expect(edge.toEnd).toBe('arrow');
    expect(edge.style).toBe('solid');
    expect(edge.routing).toBe('free');
    expect(edge.id).toMatch(/^e_/);
  });

  it('编组拷贝成员数组，避免外部改动反向污染', () => {
    const members = ['c_1', 'c_2'];
    const group = createGroup(members, '一组');
    members.push('c_3');
    expect(group.cardIds).toEqual(['c_1', 'c_2']);
    expect(group.label).toBe('一组');
  });
});

describe('maxZ / nextZ', () => {
  it('同时考虑卡片与分栏的层级', () => {
    const board = createBoardFile({
      cards: [createCard('note', { z: 3 }), createCard('note', { z: 9 })],
      columns: [createColumn({ z: 5 })],
    });
    expect(maxZ(board)).toBe(9);
    expect(nextZ(board)).toBe(10);
  });

  it('空板从 1 开始', () => {
    const board = createBoardFile();
    expect(maxZ(board)).toBe(0);
    expect(nextZ(board)).toBe(1);
  });
});
