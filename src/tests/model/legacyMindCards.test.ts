/**
 * 老卡类型（`mind` / `mindRef`）的**读入口**（`2.2.0` 收尾 · 老卡类型退出）。
 *
 * 这一组用例是补的：`2.2.0` 把脑图升格成白板对象之后，"老脑图卡读进来会变成容器"
 * 这件事**一条用例都没有** —— 而它是整条升级路径上唯一保证"老板子不丢树"的地方。
 *
 * 口径（`11 §12.4` 记的那条决定）：
 * * 这两个类型名**故意留在 `CARD_TYPES` 里** —— `isCardType` 同时把着**读入口**，
 *   真删掉的话 `normalizeBoardFile` 会把老卡当"未知类型"丢弃，树就没了；
 * * "不能再新建"是靠**别处的名单**实现的（如基准生成器 `BENCHMARK_CARD_TYPES`、
 *   画布过滤条 `FILTERABLE_TYPES`），而不是从类型名册里消失。
 */
import { describe, expect, it } from 'vitest';
import { BOARD_SPEC, BOARD_VERSION } from '../../constants';
import { FILTERABLE_TYPES } from '../../model/filter';
import { CARD_TYPES } from '../../model/schema';
import { normalizeBoardFile } from '../../model/validate';

function rawBoard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: BOARD_SPEC,
    version: BOARD_VERSION,
    revision: 3,
    meta: { id: 'nb_x', title: 'T' },
    view: { x: 0, y: 0, zoom: 1, background: 'dots' },
    settings: {},
    columns: [],
    cards: [],
    edges: [],
    groups: [],
    ...overrides,
  };
}

/** 一张老"内嵌脑图卡"（`mind`）：树就存在 `content.mind` 里 */
function rawLegacyMindCard(): Record<string, unknown> {
  return {
    id: 'c_mind',
    type: 'mind',
    x: 100,
    y: 200,
    width: 440,
    height: 300,
    z: 4,
    locked: true,
    content: {
      mind: {
        revision: 1,
        meta: { title: '老树', icon: null, tags: [], createdAt: '', updatedAt: '' },
        view: { x: 0, y: 0, zoom: 1, structure: 'logic-right' },
        rootId: 'n_root',
        nodes: [
          { id: 'n_root', parentId: null, text: '中心主题', order: 0, collapsed: false },
          { id: 'n_a', parentId: 'n_root', text: '分支', order: 0, collapsed: false },
        ],
      },
    },
  };
}

/** 一张老"脑图文件卡"（`mindRef`）：指向一份 `.nestmind` */
function rawLegacyMindRefCard(): Record<string, unknown> {
  return {
    id: 'c_mindref',
    type: 'mindRef',
    x: 600,
    y: 200,
    width: 440,
    height: 320,
    z: 5,
    content: { path: '脑图/甲.nestmind', showSize: false },
  };
}

describe('老脑图卡的读入口（2.2.0 收尾）', () => {
  it('两个类型名**故意留在**名册里（读入口要用它），但已不在"可新建"名单里', () => {
    // 留着的理由见文件头：`isCardType` 也管读入口
    expect(CARD_TYPES).toContain('mind');
    expect(CARD_TYPES).toContain('mindRef');
    // "不能新建"落在别处（这里钉住其中一处：过滤条不再列它们）
    expect(FILTERABLE_TYPES).not.toContain('mind');
    expect(FILTERABLE_TYPES).not.toContain('mindRef');
  });

  it('★ `mind` 卡读进来变成容器：树随行、卡片不再存在', () => {
    const result = normalizeBoardFile(rawBoard({ cards: [rawLegacyMindCard()] }));
    expect(result).not.toBeNull();
    const board = result!.board;

    expect(board.cards).toHaveLength(0);
    expect(board.minds).toHaveLength(1);

    const mind = board.minds![0];
    // 沿用卡的 id（连线断不了）、只读跟着走
    expect(mind.id).toBe('c_mind');
    expect(mind.locked).toBe(true);
    // ★ 锚点**不是**卡的中心：卡里那棵树是按整体包围盒居中的，转换要把它还原成
    //   "根节点落在原来的位置上"（否则树会整棵挪一下）—— 所以只钉"落在卡的范围里"
    expect(mind.x).toBeGreaterThan(100);
    expect(mind.x).toBeLessThan(540);
    expect(mind.y).toBeGreaterThan(200);
    expect(mind.y).toBeLessThan(500);
    // 树本身（含节点文字）原样带过来
    expect(mind.path).toBe('');
    expect(mind.mind?.nodes.find((node) => node.id === 'n_root')?.text).toBe('中心主题');
  });

  it('★ `mindRef` 卡读进来变成"指向那份文件"的容器', () => {
    const result = normalizeBoardFile(rawBoard({ cards: [rawLegacyMindRefCard()] }));
    const board = result!.board;

    expect(board.cards).toHaveLength(0);
    expect(board.minds).toHaveLength(1);
    expect(board.minds![0].path).toBe('脑图/甲.nestmind');
    expect(board.minds![0].id).toBe('c_mindref');
  });

  it('★ 树读不出来时：**不丢容器**，内容换成一张空树', () => {
    const broken = rawLegacyMindCard();
    // 把树弄坏（`content.mind` 不是对象）
    (broken.content as Record<string, unknown>).mind = '这不是一份脑图';
    const board = normalizeBoardFile(rawBoard({ cards: [broken] }))!.board;

    expect(board.minds).toHaveLength(1);
    const mind = board.minds![0];
    expect(mind.mind?.nodes.length).toBeGreaterThan(0);
    // ★ 锚点仍按**那棵新树**的根节点算（不是卡心）：坏树在"读卡内容"那一步就被换成
    //   一张空树，于是转换这一头拿到的是一份**合法**的树 —— 落点规则照旧。
    expect(mind.x).toBeGreaterThan(100);
    expect(mind.x).toBeLessThan(540);
  });

  it('★ 指向老脑图卡的连线跟着端点一起活下来', () => {
    const note = {
      id: 'c_note',
      type: 'note',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      z: 1,
      content: { md: '' },
    };
    const result = normalizeBoardFile(
      rawBoard({
        cards: [note, rawLegacyMindCard()],
        edges: [
          {
            id: 'e_1',
            from: { cardId: 'c_note', side: null },
            to: { cardId: 'c_mind', side: null },
            fromEnd: 'none',
            toEnd: 'arrow',
            style: 'solid',
            color: '1',
          },
        ],
      }),
    );
    const board = result!.board;

    // 卡变成容器之后，端点仍然指向一个**存在的**对象（id 沿用才做得到）
    expect(board.edges).toHaveLength(1);
    expect(board.minds!.some((mind) => mind.id === board.edges[0].to.cardId)).toBe(true);
  });
});
