/**
 * 脑图模型（`06 §3`）：工厂 + 反序列化容错。
 *
 * 这里钉的是"**读进来的文件一定是一份合法脑图**"这件事。它是纯逻辑，所以能在 node 下
 * 逐条钉死 —— 这正是 `06 §2` 那条边界纪律（`mind/model` 不碰 `obsidian`、不碰 DOM）换来的。
 *
 * 分组按 `06 §3.3` 的不变量表走，最后一条是**幂等**：它是"读一遍写回去逐字节不变"
 * 的代理判据（没有序列化器时，幂等就是能测的那个等价物）。
 */

import { describe, expect, it } from 'vitest';
import { MIND_SPEC, MIND_VERSION } from '../../constants';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import { t } from '../../util/i18n';
import type { NormalizedMind } from '../../mind/model/validate';
import { normalizeMindFile, parseMindFile } from '../../mind/model/validate';

/** 一份最小的合法文件：根 + 两个子节点 + 一个悬浮节点 */
function rawOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: MIND_SPEC,
    version: MIND_VERSION,
    revision: 1,
    meta: { id: 'nm_1', title: '产品脑暴', createdAt: 'a', updatedAt: 'b' },
    view: { x: 10, y: 20, zoom: 1.5, background: 'grid' },
    rootId: 'n_root',
    nodes: [
      { id: 'n_root', text: '中心', note: '**内容**', parentId: null, order: 0 },
      { id: 'n_a', text: 'A', note: '', parentId: 'n_root', order: 0 },
      { id: 'n_b', text: 'B', note: '', parentId: 'n_root', order: 1 },
      { id: 'n_free', text: '自由', note: '', parentId: null, order: 0, free: { x: 320, y: -80 } },
    ],
    ...overrides,
  };
}

/** 断言"读得出来"，顺手把联合类型收窄 */
function okFile(raw: unknown): NormalizedMind {
  const result = normalizeMindFile(raw);
  if (!result.ok) throw new Error(`这份文件应当读得出来，实际是 ${result.reason}`);
  return result;
}

/**
 * 这个键在不在对象上。
 *
 * ★ 不用 `Object.hasOwn`：tsconfig 的 `lib` 还没到 `es2022`，而"可选键缺席"这条纪律
 *   （`06 §3` 纪律 2）恰恰是本文件要钉的东西，不能因为它改 tsconfig。
 */
function hasKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nodeOf(file: NormalizedMind['file'], id: string) {
  const node = file.nodes.find((item) => item.id === id);
  if (!node) throw new Error(`节点不在了：${id}`);
  return node;
}

// ── 工厂 ─────────────────────────────────────────────────────

describe('createMindFile（新建的唯一入口）', () => {
  it('★ 必定带一个中心主题，且 `rootId` 指向它', () => {
    const file = createMindFile({ title: '产品脑暴' });

    expect(file.spec).toBe(MIND_SPEC);
    expect(file.version).toBe(MIND_VERSION);
    expect(file.revision).toBe(0); // 还没落过盘
    expect(file.nodes).toHaveLength(1);
    expect(file.nodes[0]?.id).toBe(file.rootId);
    expect(file.nodes[0]?.parentId).toBeNull();
    expect(file.nodes[0]?.text).toBe('产品脑暴');
  });

  it('没给标题时用 i18n 的默认名（中心主题也跟着它）', () => {
    const file = createMindFile();
    expect(file.meta.title).toBe(t('mind.untitled'));
    expect(file.nodes[0]?.text).toBe(t('mind.untitled'));
  });

  it('★ 可选键按需写：新建的文件里没有 `collapsed` / `props` / `refs` 这些键', () => {
    const node = createMindFile().nodes[0] as object;
    for (const key of ['collapsed', 'free', 'style', 'props', 'refs']) {
      expect(hasKey(node, key)).toBe(false);
    }
  });

  it('`createMindNode`：`collapsed: false` **不写这个键**（缺席 = 展开）', () => {
    expect(hasKey(createMindNode({ collapsed: false }), 'collapsed')).toBe(false);
    expect(createMindNode({ collapsed: true }).collapsed).toBe(true);
  });
});

// ── 反序列化：好文件 ──────────────────────────────────────────

describe('normalizeMindFile · 好文件', () => {
  it('结构原样读出，一处都不修（零 issue）', () => {
    const { file, issues } = okFile(rawOf());

    expect(issues).toEqual([]);
    expect(file.meta.title).toBe('产品脑暴');
    expect(file.view).toMatchObject({ x: 10, y: 20, zoom: 1.5, background: 'grid' });
    expect(file.nodes).toHaveLength(4);
    expect(nodeOf(file, 'n_free').free).toEqual({ x: 320, y: -80 });
  });

  it('★ 幂等：读一遍再读一遍，零 issue（= 读一遍写回去不会改字节）', () => {
    const first = okFile(rawOf());
    const second = okFile(first.file);
    expect(second.issues).toEqual([]);
  });
});

// ── 反序列化：信封 ───────────────────────────────────────────

describe('normalizeMindFile · 信封严格', () => {
  it('不是对象 / 是数组 / 缺 nodes / nodes 不是数组 / 缺 rootId → 判定失败（绝不写回）', () => {
    for (const raw of [
      'hello',
      [],
      { rootId: 'n_root' },
      { rootId: 'n_root', nodes: {} },
      { nodes: [] },
    ]) {
      expect(normalizeMindFile(raw)).toEqual({ ok: false, reason: 'not-a-mind' });
    }
  });

  it('磁盘文本解析不了 → `invalid-json`（与"不像脑图"分开记）', () => {
    expect(parseMindFile('{ 坏')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(parseMindFile('{}')).toEqual({ ok: false, reason: 'not-a-mind' });
  });
});

// ── 反序列化：条目宽松 ───────────────────────────────────────

describe('normalizeMindFile · 条目宽松', () => {
  it('坏节点条目只丢它自己（不是对象 / 没有 id）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          { id: 'n_root', text: '中心', parentId: null, order: 0 },
          42,
          { text: '没有 id' },
          { id: '  ', text: '空白 id' },
        ],
      }),
    );

    expect(file.nodes.map((node) => node.id)).toEqual(['n_root']);
    expect(issues.filter((issue) => issue.action === 'dropped')).toHaveLength(3);
  });

  it('重复 id → 丢掉后来那个（留着先来的）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          { id: 'n_root', text: '先', parentId: null, order: 0 },
          { id: 'n_root', text: '后', parentId: null, order: 1 },
        ],
      }),
    );

    expect(file.nodes).toHaveLength(1);
    expect(file.nodes[0]?.text).toBe('先');
    expect(issues.some((issue) => issue.message.includes('重复'))).toBe(true);
  });

  it('★ 父指针悬空 → 降级为悬浮节点（**内容保住**，不丢）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          { id: 'n_root', text: '中心', parentId: null, order: 0 },
          { id: 'n_x', text: '孤儿', note: '正文还在', parentId: 'n_没了', order: 0 },
        ],
      }),
    );

    expect(nodeOf(file, 'n_x').text).toBe('孤儿');
    expect(nodeOf(file, 'n_x').note).toBe('正文还在');
    expect(nodeOf(file, 'n_x').parentId).toBeNull();
    expect(issues[0]?.action).toBe('fixed');
  });

  it('★ 父子成环 → 断开一个（两个节点的内容都保住）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          { id: 'n_root', text: '中心', parentId: null, order: 0 },
          { id: 'n_a', text: 'A', parentId: 'n_b', order: 0 },
          { id: 'n_b', text: 'B', parentId: 'n_a', order: 0 },
        ],
      }),
    );

    expect(file.nodes).toHaveLength(3);
    expect(nodeOf(file, 'n_a').parentId).toBeNull();
    expect(issues.some((issue) => issue.message.includes('成环'))).toBe(true);
  });

  it('★ 中心主题不在了 → 用第一个顶层节点顶替', () => {
    const { file, issues } = okFile(
      rawOf({
        rootId: 'n_没了',
        nodes: [
          { id: 'n_root', text: '中心', parentId: null, order: 0 },
          { id: 'n_a', text: 'A', parentId: 'n_root', order: 0 },
        ],
      }),
    );

    expect(file.rootId).toBe('n_root');
    expect(issues.some((issue) => issue.path === 'rootId')).toBe(true);
  });

  it('★ 一个顶层节点都没有 → 补一个空的中心主题（宁可多一个空节点）', () => {
    const { file, issues } = okFile(
      rawOf({
        rootId: 'n_没了',
        nodes: [{ id: 'n_a', text: 'A', parentId: 'n_也没了', order: 0 }],
      }),
    );

    expect(file.nodes).toHaveLength(2);
    expect(file.nodes.some((node) => node.id === file.rootId)).toBe(true);
    expect(issues.some((issue) => issue.message.includes('已补一个空节点'))).toBe(true);
  });

  it('中心主题挂在别人下面 → 断开（否则立刻成环）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          { id: 'n_root', text: '中心', parentId: 'n_a', order: 0 },
          { id: 'n_a', text: 'A', parentId: 'n_root', order: 0 },
        ],
      }),
    );

    expect(nodeOf(file, 'n_root').parentId).toBeNull();
    expect(issues.some((issue) => issue.message.includes('中心主题不能挂在'))).toBe(true);
  });
});

// ── 反序列化：坐标与次序 ─────────────────────────────────────

describe('normalizeMindFile · 坐标（`06 §3` 纪律 1）', () => {
  it('★ 树上的节点残留坐标 → 删掉（位置由布局算，留着是骗人的旧值）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          { id: 'n_root', text: '中心', parentId: null, order: 0 },
          { id: 'n_a', text: 'A', parentId: 'n_root', order: 0, free: { x: 5, y: 5 } },
        ],
      }),
    );

    expect(hasKey(nodeOf(file, 'n_a'), 'free')).toBe(false);
    expect(issues.some((issue) => issue.message.includes('坐标由布局决定'))).toBe(true);
  });

  it('★ 悬浮节点没有坐标 → 补原点（没有坐标它就没有位置）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          { id: 'n_root', text: '中心', parentId: null, order: 0 },
          { id: 'n_free', text: '自由', parentId: null, order: 0 },
        ],
      }),
    );

    expect(nodeOf(file, 'n_free').free).toEqual({ x: 0, y: 0 });
    expect(issues.some((issue) => issue.message.includes('已放在原点'))).toBe(true);
  });

  it('同父下的次序重排成 0..n-1', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          { id: 'n_root', text: '中心', parentId: null, order: 0 },
          { id: 'n_a', text: 'A', parentId: 'n_root', order: 5 },
          { id: 'n_b', text: 'B', parentId: 'n_root', order: 9 },
        ],
      }),
    );

    expect(nodeOf(file, 'n_a').order).toBe(0);
    expect(nodeOf(file, 'n_b').order).toBe(1);
    expect(issues.some((issue) => issue.message.includes('次序已重排'))).toBe(true);
  });

  it('不认识的颜色 / 背景 / 退化缩放都被修好并留痕', () => {
    const { file, issues } = okFile(
      rawOf({
        view: { x: 0, y: 0, zoom: 0, background: '彩虹' },
        nodes: [
          { id: 'n_root', text: '中心', parentId: null, order: 0, style: { color: '不是颜色' } },
        ],
      }),
    );

    expect(file.view.zoom).toBe(1);
    expect(file.view.background).toBe('dots');
    expect(hasKey(nodeOf(file, 'n_root'), 'style')).toBe(false);
    expect(issues).toHaveLength(3);
  });
});

// ── 反序列化：属性与引用（`C` / `B`）─────────────────────────

describe('normalizeMindFile · 属性与引用', () => {
  it('坏属性整批记一条 dropped（面板上的处置是同一件事）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          {
            id: 'n_root',
            text: '中心',
            parentId: null,
            order: 0,
            props: [
              { id: 'p1', key: '负责人', value: '老王' },
              { id: '', key: '对', value: 1 }, // 缺 id → 补一个
              { key: '', value: 1 },
              { key: '空值', value: null },
              'nope',
            ],
          },
        ],
      }),
    );

    const props = nodeOf(file, 'n_root').props ?? [];
    expect(props).toHaveLength(2);
    expect(props[1]?.id).toBeTruthy();
    expect(issues.some((issue) => issue.message.includes('丢弃了 3 条属性'))).toBe(true);
  });

  it('引用：坏的丢掉、同一份文件挂两次静默去重', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          {
            id: 'n_root',
            text: '中心',
            parentId: null,
            order: 0,
            refs: [
              { kind: 'image', path: 'assets/a.png' },
              { kind: 'image', path: 'assets/a.png' },
              { kind: '不认识的类型', path: 'assets/b.png' },
              { kind: 'file', path: '' },
            ],
          },
        ],
      }),
    );

    expect(nodeOf(file, 'n_root').refs).toEqual([{ kind: 'image', path: 'assets/a.png' }]);
    expect(issues.some((issue) => issue.message.includes('丢弃了 2 条引用'))).toBe(true);
  });

  it('★ 标记与标题格式：读回来一个字不差；`italic: false` 丢掉、`bold: false` 留住', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          {
            id: 'n_root',
            text: '中心',
            note: '',
            parentId: null,
            order: 0,
            icon: '📌',
            style: { bold: false, italic: false, underline: true, ink: '#ffffff' },
          },
        ],
      }),
    );

    const node = nodeOf(file, 'n_root');
    expect(node.icon).toBe('📌');
    // ★ `bold: false` 有意义（缺省取决于层级：根是加粗的）⇒ 必须留住
    expect(node.style?.bold).toBe(false);
    // ★ `italic: false` 与缺省同义 ⇒ 不写
    expect(node.style?.italic).toBeUndefined();
    expect(node.style?.underline).toBe(true);
    expect(node.style?.ink).toBe('#ffffff');
    expect(issues.filter((issue) => issue.action === 'fixed')).toHaveLength(0);
  });

  it('★ 坏标记 / 坏开关：**只丢那个键**，不丢节点（也留痕）', () => {
    const { file, issues } = okFile(
      rawOf({
        nodes: [
          {
            id: 'n_root',
            text: '中心',
            note: '',
            parentId: null,
            order: 0,
            icon: 42,
            style: { bold: '是的', ink: '不是颜色' },
          },
        ],
      }),
    );

    const node = nodeOf(file, 'n_root');
    expect(node.icon).toBeUndefined();
    expect(node.style?.bold).toBeUndefined();
    expect(node.style?.ink).toBeUndefined();
    expect(issues.some((issue) => issue.path.endsWith('.icon'))).toBe(true);
    expect(issues.some((issue) => issue.path.endsWith('.bold'))).toBe(true);
    expect(issues.some((issue) => issue.path.endsWith('.ink'))).toBe(true);
  });

  it('★ 结构 / 线型：认识的值留住；缺席**不补键**（纪律 2）', () => {
    const bare = okFile(rawOf()).file;
    expect(hasKey(bare.view as object, 'structure')).toBe(false);
    expect(hasKey(bare.view as object, 'edge')).toBe(false);

    const kept = okFile(
      rawOf({
        view: { x: 0, y: 0, zoom: 1, background: 'dots', structure: 'logic-left', edge: 'elbow' },
      }),
    ).file;
    expect(kept.view.structure).toBe('logic-left');
    expect(kept.view.edge).toBe('elbow');
  });

  it('★ 不认识的结构 / 线型：**丢那个键 + 留痕**，不整份文件判失败', () => {
    const { file, issues } = okFile(
      rawOf({
        view: { x: 0, y: 0, zoom: 1, background: 'dots', structure: '螺旋形', edge: 42 },
      }),
    );

    // 丢键 = 视图那边按缺省走（"回落"），而文件里那个坏值下次保存自然消失
    expect(file.view.structure).toBeUndefined();
    expect(file.view.edge).toBeUndefined();
    expect(issues.some((issue) => issue.path === 'view.structure')).toBe(true);
    expect(issues.some((issue) => issue.path === 'view.edge')).toBe(true);
    // 其余内容一个字都不受影响
    expect(file.nodes).toHaveLength(4);
  });

  it('★ 图片宽度只认正有限数；坏了**只丢那个键**，不丢整条引用', () => {
    const { file } = okFile(
      rawOf({
        nodes: [
          {
            id: 'n_root',
            text: '中心',
            parentId: null,
            order: 0,
            refs: [
              { kind: 'image', path: 'assets/a.png', width: 320 },
              { kind: 'image', path: 'assets/b.png', width: -5 },
              { kind: 'image', path: 'assets/c.png', width: '宽' },
            ],
          },
        ],
      }),
    );

    const refs = nodeOf(file, 'n_root').refs ?? [];
    expect(refs[0]).toEqual({ kind: 'image', path: 'assets/a.png', width: 320 });
    // 坏宽度丢掉之后，引用本身还在（"这个文件还挂着"是用户最要紧的那件事）
    expect(refs[1]).toEqual({ kind: 'image', path: 'assets/b.png' });
    expect(refs[2]).toEqual({ kind: 'image', path: 'assets/c.png' });
  });
});
