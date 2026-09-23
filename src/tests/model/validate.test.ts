import { describe, expect, it } from 'vitest';
import { BOARD_SPEC, BOARD_VERSION, BOARD_REF_MINI_SIZE } from '../../constants';
import { DEFAULT_CARD_SIZES } from '../../model/factories';
import type { LinkContent } from '../../model/schema';
import { normalizeBoardFile, parseBoardJson } from '../../model/validate';

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

function rawBoardRefCard(preview: unknown): Record<string, unknown> {
  return rawNoteCard({
    type: 'boardRef',
    content: { path: 'Boards/子板.nboard', preview, showCount: true },
  });
}

/** 一个最小可用的分栏，id 固定为 `col_1`（连线端点测试要点名指它） */
function rawColumn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'col_1',
    title: '',
    x: 0,
    y: 0,
    width: 320,
    height: 480,
    collapsed: false,
    color: '2',
    z: 1,
    ...overrides,
  };
}

function rawNoteCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c_1',
    type: 'note',
    x: 0,
    y: 0,
    width: 120,
    height: 90,
    z: 1,
    columnId: null,
    order: 0,
    color: '1',
    accent: null,
    locked: false,
    showTitle: false,
    title: '',
    content: { md: 'hi', editorMode: 'markdown' },
    ...overrides,
  };
}

/**
 * `2.2.0` 收尾 · 演示对接：树上的步骤号必须落盘、也必须读得回来。
 *
 * ★ 这条用例是补的：`normalizeMindContainer` 是**逐字段重建**对象的，
 *   漏接一个字段的后果不是"少一栏"，而是"编好演示顺序、重开白板又乱了"。
 */
describe('normalizeBoardFile × 脑图的演示步骤号（2.2.0 收尾 · 演示对接）', () => {
  /** 一个最小的内嵌脑图容器（raw 形态） */
  const rawMind = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'nm_x',
    x: 0,
    y: 0,
    z: 1,
    path: '',
    mind: { revision: 1, rootId: 'n_root', nodes: [] },
    ...overrides,
  });

  function read(presentStep: unknown) {
    const container = rawMind(presentStep === undefined ? {} : { presentStep });
    const result = normalizeBoardFile(rawBoard({ minds: [container] }));
    return result!.board.minds?.[0] ?? null;
  }

  it('★ 存过步骤号 ⇒ 读回来还在（否则"编好顺序、重开白板又乱"）', () => {
    expect(read(3)?.presentStep).toBe(3);
    // 与卡片同一条归一：非有限数不认、至少是 1
    expect(read(0)?.presentStep).toBe(1);
    expect(read('3')?.presentStep).toBeUndefined();
  });

  it('没存过 ⇒ **不补这个键**（缺席纪律：读一遍写回去逐字节不变）', () => {
    expect('presentStep' in (read(undefined) ?? {})).toBe(false);
  });
});

describe('parseBoardJson —— 信封判定（W6：解析失败绝不覆盖）', () => {
  it('非法 JSON → invalid-json', () => {
    expect(parseBoardJson('{ 不是 json')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('空文件 → invalid-json（由 Repository 决定按"新建"处理还是保护）', () => {
    expect(parseBoardJson('')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('JSON 合法但不是白板 → not-a-board', () => {
    expect(parseBoardJson('{"foo":1}')).toEqual({ ok: false, reason: 'not-a-board' });
    expect(parseBoardJson('[1,2,3]')).toEqual({ ok: false, reason: 'not-a-board' });
    expect(parseBoardJson('"文本"')).toEqual({ ok: false, reason: 'not-a-board' });
  });

  it('合法白板 → 读出模型', () => {
    const result = parseBoardJson(JSON.stringify(rawBoard({ cards: [rawNoteCard()] })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.revision).toBe(3);
    expect(result.board.cards).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });
});

describe('normalizeBoardFile —— 条目级容错（坏一张卡不牵连整块板）', () => {
  it('未知卡片类型只丢弃该卡，其余内容照常读出', () => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard(), rawNoteCard({ id: 'c_2', type: '不存在的类型' })] }),
    );
    expect(result).not.toBeNull();
    const { board, issues } = result!;
    expect(board.cards).toHaveLength(1);
    expect(issues.some((issue) => issue.action === 'dropped' && issue.path === 'cards[1]')).toBe(
      true,
    );
  });

  it('noteRef 缺少 path → 丢弃（引用卡没有路径等于空壳）', () => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ type: 'noteRef', content: { mode: 'summary' } })] }),
    );
    const { board, issues } = result!;
    expect(board.cards).toHaveLength(0);
    expect(issues[0].action).toBe('dropped');
  });

  it('map 三样（图 / 链接 / 坐标）全没有 → 丢弃：那才是真的空框', () => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ type: 'map', content: { label: '深圳湾' } })] }),
    );
    const { board, issues } = result!;
    expect(board.cards).toHaveLength(0);
    expect(issues[0].action).toBe('dropped');
  });

  // ── O08：贴过链接的地图卡**不再**等于空框 ─────────────────────
  // ★ 这一条一旦回归，表现是"用户刚粘完链接、重开白板，卡就没了" ——
  //   东西确实存进文件了，却在读回来那一刻被丢掉，属于最难查的一类。
  it('map 只有链接 / 只有坐标 → **保留**（贴过链接的卡上有可读的东西）', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [
          rawNoteCard({
            type: 'map',
            content: { path: '', label: '天安门', sourceUrl: 'https://maps.google.com/?q=1,2' },
          }),
          rawNoteCard({
            type: 'map',
            content: { path: '', coords: { lat: 39.9042, lon: 116.4074 } },
          }),
        ],
      }),
    );
    const { board } = result!;
    expect(board.cards).toHaveLength(2);
    expect(board.cards[0].content).toEqual({
      path: '',
      label: '天安门',
      pin: null,
      sourceUrl: 'https://maps.google.com/?q=1,2',
    });
    expect(board.cards[1].content).toEqual({
      path: '',
      label: '',
      pin: null,
      coords: { lat: 39.9042, lon: 116.4074 },
    });
  });

  it('map 的空链接 / 空坐标归成**键缺席**（"从没贴过"与"贴过又清掉"是同一份字节）', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [
          rawNoteCard({
            type: 'map',
            content: { path: 'a.png', sourceUrl: '', coords: { lat: '坏', lon: 1 } },
          }),
        ],
      }),
    );
    const content = result!.board.cards[0].content as unknown as Record<string, unknown>;
    expect('sourceUrl' in content).toBe(false);
    expect('coords' in content).toBe(false);
  });

  it('★ 越界的经纬度算"没有坐标"，而不是夹回来（纬度 91 与 89 是两个地方）', () => {
    // 夹回 89 等于替用户认领了一个他没说过的点；这里干脆当"没有坐标"，
    // 于是三样全空 → 整张丢掉（总比留一张指着错误地点的卡好）
    const result = normalizeBoardFile(
      rawBoard({
        cards: [rawNoteCard({ type: 'map', content: { path: '', coords: { lat: 91, lon: 116 } } })],
      }),
    );
    expect(result!.board.cards).toHaveLength(0);
  });

  it('map 图钉：越界坐标夹进 0~1，非数字当作"还没标位置"', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [
          rawNoteCard({
            type: 'map',
            content: { path: 'a.png', label: '越界', pin: { x: 1.4, y: -2 } },
          }),
          rawNoteCard({
            type: 'map',
            content: { path: 'b.png', label: '坏了', pin: { x: '不', y: 0.5 } },
          }),
          rawNoteCard({ type: 'map', content: { path: 'c.png' } }),
        ],
      }),
    );
    const { board } = result!;
    // 夹住而不是丢掉：钉到边上用户一眼能看出来并顺手改回去，丢掉则悄无声息
    expect(board.cards[0].content).toEqual({ path: 'a.png', label: '越界', pin: { x: 1, y: 0 } });
    // 不补 `{x:0,y:0}`：左上角是一个具体位置，凭空补一个等于替用户标了个错点
    expect(board.cards[1].content).toEqual({ path: 'b.png', label: '坏了', pin: null });
    expect(board.cards[2].content).toEqual({ path: 'c.png', label: '', pin: null });
  });

  it('同步便签：正文为空也**保留**（与便签同待遇 —— 空便签只是还没落笔）', () => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ type: 'syncNote', content: { key: 'sy_1' } })] }),
    );
    const { board, issues } = result!;

    expect(board.cards).toHaveLength(1);
    expect(board.cards[0].content).toEqual({ key: 'sy_1', md: '' });
    expect(issues).toHaveLength(0);
  });

  it('同步便签：key / md 不是字符串时回落到空串（key 空 = 独立便签，不是缺陷）', () => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ type: 'syncNote', content: { key: 7, md: null } })] }),
    );
    const { board } = result!;

    expect(board.cards[0].content).toEqual({ key: '', md: '' });
  });

  it('评论卡：空线程**保留**（新建的卡本来就是空的）；空正文条目丢弃、坏时间戳记 0 但不丢条目', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [
          rawNoteCard({ type: 'comment', content: { resolved: 'yes' } }),
          rawNoteCard({
            id: 'c_2',
            type: 'comment',
            content: {
              entries: [
                { id: 'cmt_1', text: '写下的', at: 1_756_000_000_000 },
                { id: 'cmt_2', text: '   ' },
                { text: '没写 id、时间也坏了', at: '昨天' },
                '这不是对象',
                { id: 'cmt_4', text: '最后一条', at: 5 },
              ],
              resolved: true,
            },
          }),
        ],
      }),
    );
    const { board, issues } = result!;

    // 一张还没写字的评论卡是合理的空白卡（与空便签同待遇），`resolved` 读不出就是 false
    expect(board.cards[0].content).toEqual({ entries: [], resolved: false });
    expect(board.cards[1].content).toEqual({
      entries: [
        { id: 'cmt_1', text: '写下的', at: 1_756_000_000_000 },
        // 「   」那条不留：空条目在界面上就是个点不中也读不出东西的小圆点；
        // 缺 id 的补一个、时间读不出来的记 0 —— 但**条目本身不丢**：正文在，它就该在
        { id: expect.stringMatching(/^cmt_/), text: '没写 id、时间也坏了', at: 0 },
        { id: 'cmt_4', text: '最后一条', at: 5 },
      ],
      resolved: true,
    });
    expect(issues).toHaveLength(0);
  });

  it('评论卡：`entries` 不是数组 → 当成空线程，而不是丢掉整张卡', () => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ type: 'comment', content: { entries: '坏了' } })] }),
    );

    expect(result!.board.cards[0].content).toEqual({ entries: [], resolved: false });
  });

  it('id 重复 → 重新生成，不丢内容', () => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard(), rawNoteCard({ content: { md: '第二张' } })] }),
    );
    const { board, issues } = result!;
    expect(board.cards).toHaveLength(2);
    expect(board.cards[0].id).not.toBe(board.cards[1].id);
    expect(board.cards[1].content).toEqual({ md: '第二张', editorMode: 'markdown' });
    expect(issues.some((issue) => issue.path === 'cards[1].id' && issue.action === 'fixed')).toBe(
      true,
    );
  });

  it('缺少 id → 生成新 id（保住内容优先于保住 id）', () => {
    const result = normalizeBoardFile(rawBoard({ cards: [rawNoteCard({ id: undefined })] }));
    const { board, issues } = result!;
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0].id).toMatch(/^c_/);
    expect(issues.some((issue) => issue.path === 'cards[0].id')).toBe(true);
  });

  it('columnId 指向不存在的分栏 → 释放到画布，而不是丢掉卡片', () => {
    const result = normalizeBoardFile(
      rawBoard({ columns: [], cards: [rawNoteCard({ columnId: 'col_不存在' })] }),
    );
    const { board, issues } = result!;
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0].columnId).toBeNull();
    expect(
      issues.some((issue) => issue.action === 'fixed' && issue.path.includes('columnId')),
    ).toBe(true);
  });

  it('尺寸非法（0 / 负数 / 非数字）→ 回落到该类型默认尺寸', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [rawNoteCard({ width: 0, height: -5 }), rawNoteCard({ id: 'c_2', width: 'x' })],
      }),
    );
    const { board } = result!;
    expect(board.cards[0].width).toBe(DEFAULT_CARD_SIZES.note.width);
    expect(board.cards[0].height).toBe(DEFAULT_CARD_SIZES.note.height);
    expect(board.cards[1].width).toBe(DEFAULT_CARD_SIZES.note.width);
  });

  it('颜色非法 → 回落主题色 1；accent 非法 → null', () => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ color: 'chartreuse', accent: '蓝色' })] }),
    );
    const { board } = result!;
    expect(board.cards[0].color).toBe('1');
    expect(board.cards[0].accent).toBeNull();
  });

  it('ink 手绘路径过滤掉非法点，整条路径无有效点则丢弃', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [
          rawNoteCard({
            type: 'ink',
            content: {
              paths: [
                {
                  color: '#fff',
                  width: 2,
                  points: [
                    [0, 0],
                    [1, 'x'],
                    [2, 3],
                  ],
                },
                { color: '#000', width: 1, points: [['a', 'b']] },
              ],
            },
          }),
        ],
      }),
    );
    const { board } = result!;
    expect(board.cards).toHaveLength(1);
    const ink = board.cards[0];
    expect(ink.type).toBe('ink');
    if (ink.type !== 'ink') return;
    expect(ink.content.paths).toHaveLength(1);
    expect(ink.content.paths[0].points).toEqual([
      [0, 0],
      [2, 3],
    ]);
  });

  it('ink 路径的 `alpha`（T7.08）：只认"确实半透明"的值，其余一律当缺省且**不报 issue**', () => {
    const raw = (alpha: unknown): Record<string, unknown> => ({
      color: '#e03131',
      width: 16,
      points: [[0, 0]],
      alpha,
    });
    const result = normalizeBoardFile(
      rawBoard({
        cards: [
          rawNoteCard({
            type: 'ink',
            content: {
              paths: [raw(0.35), raw(1), raw(0), raw(-0.5), raw(Number.NaN), raw(2)],
            },
          }),
        ],
      }),
    );
    const { board, issues } = result!;
    const ink = board.cards[0];
    if (ink.type !== 'ink') throw new Error('应当是一张 ink 卡');
    const paths = ink.content.paths;

    // 半透明：原样留下
    expect(paths[0].alpha).toBe(0.35);
    // `1` / `0` / 越界 / 非数：一律**不写键** —— "最常见的那个值"不该出现在文件里，
    // 而 `0` 在运行侧也意味着"别管这个字段"（见 `model/ink` 的 `normalizedAlpha`）
    for (const index of [1, 2, 3, 4, 5]) expect('alpha' in paths[index]).toBe(false);
    // ★ 新字段在存量文件里处处缺席，读不出来时**不能**报 issue：每条笔迹一条
    //   "已修复 alpha" 会把真正的问题淹掉
    expect(issues).toEqual([]);
  });

  it('ink 路径的 `alpha` 收敛到 2 位小数（逐帧算出来的浮点尾巴不该写进文件）', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [
          rawNoteCard({
            type: 'ink',
            content: {
              paths: [
                { color: '#e03131', width: 16, points: [[0, 0]], alpha: 0.34999999999999998 },
              ],
            },
          }),
        ],
      }),
    );
    const ink = result!.board.cards[0];
    if (ink.type !== 'ink') throw new Error('应当是一张 ink 卡');
    expect(ink.content.paths[0].alpha).toBe(0.35);
  });
});

describe('normalizeBoardFile —— 连线 / 编组 / 视口', () => {
  it('端点指向不存在卡片的连线被丢弃', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [rawNoteCard()],
        edges: [
          {
            id: 'e_1',
            from: { cardId: 'c_1', side: null },
            to: { cardId: 'c_幽灵', side: null },
          },
        ],
      }),
    );
    const { board, issues } = result!;
    expect(board.edges).toHaveLength(0);
    expect(issues.some((issue) => issue.path === 'edges[0]')).toBe(true);
  });

  it('★ 端点指向**分栏**的连线保留（`O21`：分栏也是连线的合法端点）', () => {
    const result = normalizeBoardFile(
      rawBoard({
        columns: [rawColumn()],
        cards: [rawNoteCard()],
        edges: [
          {
            id: 'e_1',
            from: { cardId: 'c_1', side: null },
            to: { cardId: 'col_1', side: 'left' },
          },
        ],
      }),
    );
    // ★ 这条以前会被当成"指向不存在的卡片"丢掉：表现是"重启一次少一条线"，
    //   而用户完全看不出规律 —— 所以端点合法性必须与 `addEdges` 用同一张 id 表
    const { board } = result!;
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0].to.cardId).toBe('col_1');
  });

  it('★ 带自由端的连线保留（空 `cardId` 不是"指向不存在的卡片"，T2.07 / `F3-02`）', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [rawNoteCard()],
        edges: [
          {
            id: 'e_1',
            from: { cardId: 'c_1', side: null },
            to: { cardId: '', side: null, point: { x: 640, y: 480 } },
          },
        ],
      }),
    );
    const { board } = result!;
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0].to.cardId).toBe('');
    expect(board.edges[0].to.point).toEqual({ x: 640, y: 480 });
  });

  it('★ 自由端缺坐标 / 坐标非法 → 整条边丢弃（没有落点的线根本画不出来）', () => {
    for (const point of [undefined, { x: 1 }, { x: Number.NaN, y: 0 }, { x: 1, y: '2' }]) {
      const result = normalizeBoardFile(
        rawBoard({
          cards: [rawNoteCard()],
          edges: [
            {
              id: 'e_1',
              from: { cardId: 'c_1', side: null },
              to: { cardId: '', side: null, point },
            },
          ],
        }),
      );
      expect(result!.board.edges).toHaveLength(0);
    }
  });

  it('编组移除非成员卡片；成员全失效则丢弃编组', () => {
    const result = normalizeBoardFile(
      rawBoard({
        cards: [rawNoteCard()],
        groups: [
          { id: 'g_1', cardIds: ['c_1', 'c_幽灵'], label: 'A' },
          { id: 'g_2', cardIds: ['c_幽灵'], label: 'B' },
        ],
      }),
    );
    const { board } = result!;
    expect(board.groups).toHaveLength(1);
    expect(board.groups[0].cardIds).toEqual(['c_1']);
  });

  it('★ 只认 `collapsed: true`；缺席 / false / 脏数据一律当"展开"（O03）', () => {
    const withFlag = (extra: Record<string, unknown>): unknown[] => [
      { id: 'g_1', cardIds: ['c_1'], label: 'A' },
      { id: 'g_2', cardIds: ['c_1'], label: 'B', ...extra },
    ];
    const read = (extra: Record<string, unknown>): unknown[] => {
      const result = normalizeBoardFile(
        rawBoard({ cards: [rawNoteCard()], groups: withFlag(extra) }),
      );
      return result!.board.groups.map((group) => 'collapsed' in group);
    };
    // ★ "这个键在不在"才是断言的对象：`false` 与 `1` 会被**丢掉**（而不是转成 false 写回去），
    //   否则存量文件读一遍写回来就会多出一个 `collapsed: false`，逐字节一致性当场破功
    expect(read({ collapsed: true })).toEqual([false, true]);
    expect(read({ collapsed: false })).toEqual([false, false]);
    expect(read({ collapsed: 'yes' })).toEqual([false, false]);
    expect(read({ collapsed: 1 })).toEqual([false, false]);
  });

  it('zoom 越界 → 夹到 [0.05, 8]；background 非法 → dots', () => {
    const result = normalizeBoardFile(
      rawBoard({ view: { zoom: 999, background: '棋盘格', x: 1, y: 2 } }),
    );
    const { board } = result!;
    expect(board.view.zoom).toBe(8);
    expect(board.view.background).toBe('dots');
    expect(board.view.x).toBe(1);
  });

  it('spec / version 与当前不一致 → 记录 fixed 并改写为当前值', () => {
    const result = normalizeBoardFile(rawBoard({ spec: 'other/9', version: 0 }));
    const { board, issues } = result!;
    expect(board.spec).toBe(BOARD_SPEC);
    expect(board.version).toBe(BOARD_VERSION);
    expect(issues.filter((issue) => issue.action === 'fixed').map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['spec', 'version']),
    );
  });

  it('数组字段缺失或类型错误 → 视为空数组并记账', () => {
    const missing = normalizeBoardFile({ meta: { id: 'nb_x' } })!;
    expect(missing.board.cards).toEqual([]);
    expect(missing.issues.some((issue) => issue.path === 'cards')).toBe(true);

    const wrongType = normalizeBoardFile(rawBoard({ cards: { 0: 'x' } }))!;
    expect(wrongType.board.cards).toEqual([]);
    expect(
      wrongType.issues.some((issue) => issue.path === 'cards' && issue.action === 'dropped'),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 卡片旋转的读回（T7.06 / `F2-00-10`）
//
// 三条约定都只有这里能钉死：
//  1. 归一化 + 收敛到 1 位小数（否则同一个朝向下"改了没改"永远判不出来）；
//  2. `0` 抹掉这个键（存量文件里"没转过"就是**没有**这个键）；
//  3. 读不出**不记 `issues`**（这是新字段，老文件里根本没有它）。
// ─────────────────────────────────────────────────────────────

describe('卡片旋转的读回', () => {
  function read(rotation: unknown) {
    const result = normalizeBoardFile(rawBoard({ cards: [rawNoteCard({ rotation })] }));
    return { card: result!.board.cards[0]!, issues: result!.issues };
  }

  it('正常角度原样保留（含负数）', () => {
    expect(read(30).card.rotation).toBe(30);
    expect(read(-45).card.rotation).toBe(-45);
    expect(read(179.9).card.rotation).toBe(179.9);
  });

  it('★ 归一化到 (-180, 180]：`450` 与 `90` 是同一个朝向，只留一种写法', () => {
    expect(read(450).card.rotation).toBe(90);
    expect(read(-270).card.rotation).toBe(90);
    expect(read(-180).card.rotation).toBe(180);
  });

  it('★ 长小数收敛到 1 位（手势逐帧算出来的是 `89.99999999999999` 这种）', () => {
    expect(read(89.99999999999999).card.rotation).toBe(90);
    expect(read(15.4321).card.rotation).toBe(15.4);
  });

  it('★ `0` / 缺席都抹掉这个键：没转过的卡片一个字节都不多', () => {
    expect('rotation' in read(0).card).toBe(false);
    expect('rotation' in read(undefined).card).toBe(false);
    // 转一整圈回到 0，同样抹掉
    expect('rotation' in read(360).card).toBe(false);
  });

  it('★ 脏值当 `0` 且**不记 `issues`**：新字段在老文件里处处缺席，报它会把真问题淹掉', () => {
    for (const junk of ['abc', Number.NaN, null, {}]) {
      const { card, issues } = read(junk);
      expect('rotation' in card).toBe(false);
      expect(issues.some((issue) => issue.path.includes('rotation'))).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 白板卡的预览档位：**一律归成迷你**（用户 2026-09-16）
//
// 原话："所有白板，只保留迷你形式。其他形式都不需要放出来"。
// 于是读入口不再"照原样保留"任何档位 —— `thumb` / `live` / `none` / 认不出来的
// （`hologram`）/ 整个键缺席，**全都读成 `mini`**。
//
// ★ 为什么在**读入口**归、而不是只删菜单项：只删菜单的话，存量卡会一直停在原来
//   那一档上（用户看到的还是缩略图），"只保留迷你"就只对新卡成立。
// ★ 另外三档的**渲染代码留着**：那是"读得懂旧数据"的能力（手改过的文件、
//   别处导入的卡），删掉只会让它们变成一张认不出来的卡；它们现在是死路径。
// ─────────────────────────────────────────────────────────────

describe('normalizeBoardFile —— 图片卡的「取消边框」（用户 2026-09-17）', () => {
  function read(showBorder: unknown) {
    const card = rawNoteCard({ type: 'image', content: { path: 'a.png' } });
    if (showBorder !== undefined) card.showBorder = showBorder;
    const result = normalizeBoardFile(rawBoard({ cards: [card] }));
    return result!.board.cards[0]!;
  }

  it('★ 缺省 = 有边框：文件里没有这个键，读回来也**不写**这个键（旧文件一个字不动）', () => {
    expect(read(undefined).showBorder).toBeUndefined();
    // 显式写了 `true` 也归成"缺省"（只留一种写法：想画边框就别写这个键）
    expect(read(true).showBorder).toBeUndefined();
  });

  it('显式 `false` 读回来仍是 `false`（那一次点击会被记住）', () => {
    expect(read(false).showBorder).toBe(false);
  });

  it('坏值（字符串 / 数字 / 对象）一律当"有边框"，不把卡片染色成半残', () => {
    expect(read('no').showBorder).toBeUndefined();
    expect(read(0).showBorder).toBeUndefined();
    expect(read({}).showBorder).toBeUndefined();
  });
});

describe('normalizeBoardFile —— boardRef 预览档位一律归成 mini', () => {
  const readPreview = (preview: unknown, size = { width: 300, height: 200 }) => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ ...rawBoardRefCard(preview), ...size })] }),
    );
    expect(result).not.toBeNull();
    const card = result!.board.cards[0];
    if (!card || card.type !== 'boardRef') throw new Error('应当是一张 boardRef 卡');
    return { card, content: card.content, issues: result!.issues };
  };

  it('★ 四个档位（含认不出来的、含整个键缺席）**全读成 `mini`**，尺寸一并钉成正方形', () => {
    for (const preview of ['thumb', 'live', 'none', 'mini', 'hologram', undefined]) {
      const { card, content, issues } = readPreview(preview);
      const label = String(preview);
      expect(content.preview, label).toBe('mini');
      // ★ 尺寸紧跟着被钉成正方形（`O18` 那一段）：读入口把"档位"与"尺寸"一次做完，
      //   否则会留下"是迷你档、却还是 300×200"的中间态
      expect(card.width, label).toBe(BOARD_REF_MINI_SIZE.width);
      expect(card.height, label).toBe(BOARD_REF_MINI_SIZE.height);
      // 记的账只会落在这一张卡上（没有与档位/尺寸无关的噪声）
      expect(
        issues.every((issue) => issue.path.startsWith('cards[0]')),
        label,
      ).toBe(true);
    }
  });

  it('★ 本来就是 `mini` 且尺寸已经是正方形 → 一个 `issues` 都不记（没东西可修）', () => {
    const { content, issues } = readPreview('mini', BOARD_REF_MINI_SIZE);

    expect(content).toEqual({ path: 'Boards/子板.nboard', preview: 'mini', showCount: true });
    expect(issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 白板卡卡面图标（O10）
//
// 这条字段的读入口必须与写入口（`BoardView.setBoardRefIcon`）对齐：
// 「没图标」是一个**缺席的键**，空串 / 纯空白 / 脏值都归一成它 ——
// 于是"清掉图标"与"从来没设过"是同一份字节，不会因为清一次就多写一个 `"icon": ""`。
// ─────────────────────────────────────────────────────────────

describe('normalizeBoardFile —— boardRef 卡面图标（O10）', () => {
  const read = (icon: unknown) => {
    const content: Record<string, unknown> = {
      path: 'Boards/子板.nboard',
      // ★ 走**迷你档 + 正方形尺寸**：读入口会把任何档位归一成 mini（见上一组），
      //   给个 `thumb` + 长方形进来的话，会被顺手掰成正方形、并记一条尺寸修正 ——
      //   这一组测的是图标，不该被那条噪声干扰
      preview: 'mini',
      showCount: true,
    };
    if (icon !== undefined) content.icon = icon;
    const result = normalizeBoardFile(
      rawBoard({
        cards: [rawNoteCard({ type: 'boardRef', content, ...BOARD_REF_MINI_SIZE })],
      }),
    );
    const card = result!.board.cards[0];
    if (!card || card.type !== 'boardRef') throw new Error('应当是一张 boardRef 卡');
    return { content: card.content, issues: result!.issues };
  };

  it('合法的 emoji 原样读出', () => {
    expect(read('📌').content.icon).toBe('📌');
  });

  it('★ 空串 / 纯空白 / 脏值 → 键不写进文件，且不记 `issues`', () => {
    for (const junk of ['', '   ', null, 42, {}]) {
      const { content, issues } = read(junk);
      expect('icon' in content).toBe(false);
      expect(issues).toEqual([]);
    }
  });

  it('控制字符被剔掉（手改过的文件不能把卡面撑坏）', () => {
    expect(read('\n🚀\u0000').content.icon).toBe('🚀');
  });
});

// ─────────────────────────────────────────────────────────────
// 便签深色变体（O06）
//
// 读入口必须与写入口（`BoardView.toggleNoteVariant`）对齐：
// 「浅色」是一个**缺席的键** —— 于是"切回浅色"与"从来没切过"是同一份字节。
// 认不出来的值退回缺席，且不记 `issues`（同 `preview`：不是数据坏了，
// 只是这个版本还不认识）。
// ─────────────────────────────────────────────────────────────

describe('normalizeBoardFile —— 便签深色变体（O06）', () => {
  const read = (content: Record<string, unknown>) => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ content: { md: 'hi', ...content } })] }),
    );
    const card = result!.board.cards[0];
    if (!card || card.type !== 'note') throw new Error('应当是一张便签卡');
    return { content: card.content, issues: result!.issues };
  };

  it('`dark` 照原样读出', () => {
    expect(read({ variant: 'dark' }).content.variant).toBe('dark');
  });

  it('★ `light` 不写进文件（缺席就是浅色，显式写出来只是多一份字节）', () => {
    const { content, issues } = read({ variant: 'light' });
    expect('variant' in content).toBe(false);
    expect(issues).toEqual([]);
  });

  it('★ 脏值 / 缺席 → 当浅色，且不记 `issues`', () => {
    for (const junk of [undefined, null, 'DARK', 'blue', 3, {}]) {
      const { content, issues } = read(junk === undefined ? {} : { variant: junk });
      expect('variant' in content).toBe(false);
      expect(issues).toEqual([]);
    }
  });

  it('便签的其它字段照旧（变体只是多一个键，不动 `md` / `editorMode`）', () => {
    expect(read({ variant: 'dark' }).content).toEqual({
      md: 'hi',
      editorMode: 'markdown',
      variant: 'dark',
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 色板卡的渐变格（O07）
//
// 一格色要么是色号、要么是一个渐变对象。渐变的容错取舍与 `parseSwatchText` 一致：
// **坏掉的格丢掉，而不是补一个默认色** —— 补出来的渐变是用户没写过的颜色。
// ─────────────────────────────────────────────────────────────

describe('normalizeBoardFile —— 色板渐变（O07）', () => {
  const read = (colors: unknown[]) => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ type: 'swatch', content: { colors } })] }),
    );
    const card = result!.board.cards[0];
    if (!card || card.type !== 'swatch') throw new Error('应当是一张色板卡');
    return { colors: card.content.colors, issues: result!.issues };
  };

  const gradient = {
    type: 'linear',
    angle: 90,
    stops: [
      { color: '#ff0000', position: 0 },
      { color: '#0000ff', position: 100 },
    ],
  };

  it('色号与渐变混排时各按各的读出', () => {
    expect(read(['#4c8dff', gradient]).colors).toEqual(['#4c8dff', gradient]);
  });

  it('位置可省（均分）', () => {
    const entry = {
      type: 'linear',
      angle: 180,
      stops: [{ color: '#ff0000' }, { color: '#0000ff' }],
    };
    expect(read([entry]).colors).toEqual([entry]);
  });

  it('位置收进 0~100（读进来就合法，下游不用每次画之前再夹一遍）', () => {
    const entry = {
      type: 'linear',
      angle: 90,
      stops: [
        { color: '#ff0000', position: -50 },
        { color: '#0000ff', position: 300 },
      ],
    };
    expect(read([entry]).colors).toEqual([
      {
        type: 'linear',
        angle: 90,
        stops: [
          { color: '#ff0000', position: 0 },
          { color: '#0000ff', position: 100 },
        ],
      },
    ]);
  });

  it('★ 色标少于 2 个 / 色号非法 / 角度非数字 → 丢掉这一格，不补默认色', () => {
    const broken = [
      { type: 'linear', angle: 90, stops: [{ color: '#ff0000' }] },
      { type: 'linear', angle: 90, stops: [{ color: 'red' }, { color: '#0000ff' }] },
      { type: 'linear', angle: '90', stops: [{ color: '#ff0000' }, { color: '#0000ff' }] },
      // 非法色标被逐个剔掉，剩一个同样不构成渐变
      { type: 'linear', angle: 90, stops: [{ color: '#ff0000' }, { color: 'nope' }] },
      { type: 'radial', angle: 90, stops: [{ color: '#ff0000' }, { color: '#0000ff' }] },
    ];
    // 坏格丢掉，好格照常留住 —— 逐格容错（不是"一格坏就整块卡作废"）
    const result = read([...broken, '#4C8DFF']);
    // 且**原样留着**：文件是唯一的真源，读一遍就顺手改写用户的字节属于越权
    // （归一化发生在**写**入那一侧 —— 粘贴 / 切换走 `normalizeHex`）
    expect(result.colors).toEqual(['#4C8DFF']);
    expect(result.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 白板卡 mini 形态的固定尺寸（O18）
//
// mini 的尺寸由**形态**给（固定正方形，见 `BOARD_REF_MINI_SIZE`），不是用户拉出来的。
// 读入口这条归一不是防御性代码：O09 那一版的 mini 是"用户拉多大就多大"，
// 所以存量文件里确实躺着非正方形的 mini 卡。
//
// ★ 它必须与写入口（`BoardView.setBoardRefPreview` → `boardRefPreviewSize`）判据一致：
//   两边不一致的表现是"菜单里选了 mini 是正方形、重开白板又变回长方形"。
// ─────────────────────────────────────────────────────────────

describe('normalizeBoardFile —— 白板卡 mini 的固定正方形（O18）', () => {
  const read = (preview: unknown, width: number, height: number) => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ ...rawBoardRefCard(preview), width, height })] }),
    );
    const card = result!.board.cards[0];
    if (!card || card.type !== 'boardRef') throw new Error('应当是一张 boardRef 卡');
    return { card, issues: result!.issues };
  };

  it('★ 存量 mini 卡（O09 时代随手拉出来的长方形）→ 掰成正方形并记一条 `fixed`', () => {
    const { card, issues } = read('mini', 280, 180);
    expect(card.width).toBe(BOARD_REF_MINI_SIZE.width);
    expect(card.height).toBe(BOARD_REF_MINI_SIZE.height);
    expect(issues).toEqual([
      {
        path: 'cards[0]',
        message: `白板卡 mini 形态应为 ${BOARD_REF_MINI_SIZE.width}×${BOARD_REF_MINI_SIZE.height} 正方形，已修正尺寸`,
        action: 'fixed',
      },
    ]);
  });

  it('已经是正方形 → 一个字节都不动，也不记 `issues`（每次开板都报"已修复"是噪声）', () => {
    const { card, issues } = read('mini', BOARD_REF_MINI_SIZE.width, BOARD_REF_MINI_SIZE.height);
    expect(card.width).toBe(BOARD_REF_MINI_SIZE.width);
    expect(card.height).toBe(BOARD_REF_MINI_SIZE.height);
    expect(issues).toEqual([]);
  });

  it('★ 另外三档**已经不存在了**：读进来一律被掰成迷你（连尺寸一起）', () => {
    for (const preview of ['thumb', 'live', 'none'] as const) {
      const { card } = read(preview, 411, 233);
      expect(card.content, preview).toMatchObject({ preview: 'mini' });
      expect(card.width, preview).toBe(BOARD_REF_MINI_SIZE.width);
      expect(card.height, preview).toBe(BOARD_REF_MINI_SIZE.height);
    }
  });

  it('尺寸本身就非法（0）时也照样落成正方形，且**不记**尺寸修正（回落之后本来就对）', () => {
    // 尺寸非法是**静默回落**（`readPositiveNumber` 与所有卡片同一条老规矩），而白板卡的
    // 默认尺寸**本来就是**那个正方形（`DEFAULT_CARD_SIZES.boardRef`）⇒ 回落之后没有可修的
    // 东西，于是这一条账也不该记（每次开板都报"已修复"是噪声）
    const { card, issues } = read('mini', 0, 0);
    expect(card.width).toBe(BOARD_REF_MINI_SIZE.width);
    expect(card.height).toBe(BOARD_REF_MINI_SIZE.height);
    expect(issues).toEqual([]);
  });
});

describe('normalizeBoardFile —— 链接卡的站点信息与迷你档（`O20` / `A8`）', () => {
  const FULL = {
    url: 'https://a.com/x',
    title: 'A',
    description: '',
    image: '',
    fetchedAt: '2026-09-18T00:00:00.000Z',
  };

  const read = (content: Record<string, unknown>): LinkContent => {
    const result = normalizeBoardFile(
      rawBoard({ cards: [rawNoteCard({ type: 'link', content })] }),
    );
    expect(result).not.toBeNull();
    const card = result!.board.cards[0]!;
    expect(card.type).toBe('link');
    return card.content as LinkContent;
  };

  it('★ `O20` 抓下来的三样必须活着回来（从前这里一个字都不读 ⇒ 重开白板就没了）', () => {
    const content = read({
      ...FULL,
      siteName: 'A 站',
      icon: 'https://a.com/i.png',
      finalUrl: 'https://a.com/final',
    });
    expect(content.siteName).toBe('A 站');
    expect(content.icon).toBe('https://a.com/i.png');
    expect(content.finalUrl).toBe('https://a.com/final');
  });

  it('没抓到的键**不补空串**（"从没抓到"与"抓到是空"是两份不同的字节）', () => {
    const content = read(FULL);
    expect('siteName' in content).toBe(false);
    expect('icon' in content).toBe(false);
    expect('finalUrl' in content).toBe(false);
    expect('style' in content).toBe(false);
  });

  it('★ 迷你档读回来仍是 `mini`；`full` 与坏值一律当作默认那档（不写这个键）', () => {
    expect(read({ ...FULL, style: 'mini' }).style).toBe('mini');
    expect('style' in read({ ...FULL, style: 'full' })).toBe(false);
    expect('style' in read({ ...FULL, style: 'huge' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 仅标题卡（`A3`，用户 2026-09-18："应该直接展示标题文字"）
// ─────────────────────────────────────────────────────────────

describe('normalizeBoardFile —— 仅标题卡那行字以**标题**为准', () => {
  const read = (overrides: Record<string, unknown>) => {
    const result = normalizeBoardFile(rawBoard({ cards: [rawNoteCard(overrides)] }));
    return result!.board.cards[0]!;
  };

  it('旧文件把字存在 `content.text` 里 → 读出来时搬进 `title`，并把 `text` 清空', () => {
    const card = read({ type: 'titleCard', title: '', content: { text: '结论' } });
    expect(card.title).toBe('结论');
    expect((card.content as { text: string }).text).toBe('');
  });

  it('标题已经有字时以标题为准（旧字段不覆盖它）', () => {
    const card = read({ type: 'titleCard', title: '新标题', content: { text: '旧内容' } });
    expect(card.title).toBe('新标题');
    expect((card.content as { text: string }).text).toBe('旧内容');
  });
});
