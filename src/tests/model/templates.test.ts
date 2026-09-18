/**
 * 模板库模型层（`T4.14` / `F7-06`）单元测试。
 *
 * 这里钉的是两条最容易错、也最难在使用中发现的规则：
 *
 * 1. **内置模板是"搭"出来的，且结构自洽**：卡片引用的分栏 / 连线的端点 / 编组的成员
 *    必须真实存在。模板里出现一处悬空引用，用户新建出来的板就是"连线飘在空中"。
 * 2. **实例化 = 换身份，不换内容**：所有 id 重新生成、引用同步重写、视口落回原点、
 *    只读清掉；而背景 / 演示步骤 / 其余设置要**原样保留**（模板作者调好的东西）。
 *    反过来 `packTemplate` 只决定"文件长什么样"，卡片 / 分栏 id 保持原样。
 *
 * 纯逻辑模块，不碰 `obsidian`，假数据即可测完。
 */

import { describe, expect, it } from 'vitest';

import {
  createBoardFile,
  createCard,
  createColumn,
  createEdge,
  createGroup,
} from '../../model/factories';
import type { BoardFile } from '../../model/schema';
import {
  BUILTIN_TEMPLATES,
  TEMPLATE_CATEGORIES,
  builtinTemplateById,
  describeTemplate,
  instantiateTemplate,
  packTemplate,
} from '../../model/templates';
import { t } from '../../util/i18n';

// ─────────────────────────────────────────────────────────────
// 内置模板：存在性 + 结构自洽
// ─────────────────────────────────────────────────────────────

describe('BUILTIN_TEMPLATES', () => {
  it('四个分类各有一个模板，id 与分类一一对应', () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(TEMPLATE_CATEGORIES.length);
    expect([...BUILTIN_TEMPLATES].map((template) => template.category)).toEqual([
      ...TEMPLATE_CATEGORIES,
    ]);
    // id 是稳定标识，与显示名解耦：不该跟着语言变
    for (const template of BUILTIN_TEMPLATES) {
      expect(template.id).toBe(template.category);
    }
  });

  it('每个模板都有一个非空的显示名与说明（空名字在列表里就是一行空白）', () => {
    for (const template of BUILTIN_TEMPLATES) {
      expect(t(template.nameKey).trim().length).toBeGreaterThan(0);
      expect(t(template.descKey).trim().length).toBeGreaterThan(0);
    }
  });

  it('每个模板都"有内容"：至少一张卡片、板标题非空', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const board = template.build();
      expect(board.cards.length).toBeGreaterThan(0);
      expect(board.meta.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('卡片引用的分栏、连线端点、编组成员都真实存在（模板里不许有悬空引用）', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const board = template.build();
      const columnIds = new Set(board.columns.map((column) => column.id));
      const cardIds = new Set(board.cards.map((card) => card.id));

      for (const card of board.cards) {
        if (card.columnId !== null) expect(columnIds.has(card.columnId)).toBe(true);
      }
      for (const edge of board.edges) {
        if (edge.from.cardId.length > 0) expect(cardIds.has(edge.from.cardId)).toBe(true);
        if (edge.to.cardId.length > 0) expect(cardIds.has(edge.to.cardId)).toBe(true);
      }
      for (const group of board.groups) {
        for (const id of group.cardIds) expect(cardIds.has(id)).toBe(true);
      }
    }
  });

  it('成员卡片的 z 必须高于它所在的分栏（否则卡片被分栏底板盖住）', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const board = template.build();
      const columnZ = new Map(board.columns.map((column) => [column.id, column.z]));
      for (const card of board.cards) {
        if (card.columnId === null) continue;
        const base = columnZ.get(card.columnId);
        expect(base).toBeDefined();
        expect(card.z).toBeGreaterThan(base as number);
      }
    }
  });

  it('`build()` 每次都返回全新的一份（连 id 都是新的，可以随便改那一份）', () => {
    const template = BUILTIN_TEMPLATES[0];
    const first = template.build();
    const second = template.build();

    expect(first).not.toBe(second);
    expect(first.meta.id).not.toBe(second.meta.id);
    expect(first.cards[0]).not.toBe(second.cards[0]);

    // 改一份不影响另一份 —— 这是"每次调用都重新搭"的意义
    first.cards[0].title = '被改过了';
    expect(second.cards[0].title).not.toBe('被改过了');
  });
});

describe('builtinTemplateById', () => {
  it('按 id 取得到', () => {
    expect(builtinTemplateById('research')?.id).toBe('research');
  });

  it('取不到返回 null，不抛（选项是刚列出来的，取不到只可能是代码被改了）', () => {
    expect(builtinTemplateById('no-such-template')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 实例化：换 id、重写引用、落回原点
// ─────────────────────────────────────────────────────────────

/** 一块"什么都有"的板：分栏、栏内卡片、连线、编组、非默认视口 / 设置 */
function fixture(): BoardFile {
  const column = createColumn({ title: '第一栏', x: 100, y: 200 });
  const inColumn = createCard('note', {
    columnId: column.id,
    order: 0,
    x: 9999,
    y: 9999,
    presentStep: 2,
  });
  const loose = createCard('todo', { x: 40, y: 60 });
  const target = createCard('note', { x: 400, y: 60 });

  return createBoardFile({
    meta: { title: '原板', parent: 'Boards/父板.nboard', aliases: ['旧名'] },
    view: { x: 123, y: -45, zoom: 2.5, background: 'grid' },
    settings: { snapToGrid: false, readOnly: true },
    columns: [column],
    cards: [inColumn, loose, target],
    edges: [createEdge({ cardId: inColumn.id, side: null }, { cardId: target.id, side: null })],
    groups: [createGroup([inColumn.id, loose.id], '一组')],
  });
}

describe('instantiateTemplate', () => {
  it('所有 id 重新生成：板 / 卡 / 栏 / 连线 / 编组', () => {
    const source = fixture();
    const made = instantiateTemplate(source);

    expect(made.meta.id).not.toBe(source.meta.id);

    const sourceCardIds = new Set(source.cards.map((card) => card.id));
    for (const card of made.cards) expect(sourceCardIds.has(card.id)).toBe(false);

    const sourceColumnIds = new Set(source.columns.map((column) => column.id));
    for (const column of made.columns) expect(sourceColumnIds.has(column.id)).toBe(false);

    const sourceEdgeIds = new Set(source.edges.map((edge) => edge.id));
    for (const edge of made.edges) expect(sourceEdgeIds.has(edge.id)).toBe(false);

    const sourceGroupIds = new Set(source.groups.map((group) => group.id));
    for (const group of made.groups) expect(sourceGroupIds.has(group.id)).toBe(false);
  });

  it('引用跟着 id 一起重写：`card.columnId` / 连线端点 / 编组成员', () => {
    const source = fixture();
    const made = instantiateTemplate(source);

    const newColumnId = made.columns[0].id;
    // 原来在栏里那张卡，现在还在（新的）栏里
    const moved = made.cards.find((card) => card.presentStep === 2);
    expect(moved).toBeDefined();
    expect(moved?.columnId).toBe(newColumnId);

    // 连线两端指向新卡片，而不是模板里的旧 id
    const newCardIds = new Set(made.cards.map((card) => card.id));
    expect(made.edges).toHaveLength(1);
    expect(newCardIds.has(made.edges[0].from.cardId)).toBe(true);
    expect(newCardIds.has(made.edges[0].to.cardId)).toBe(true);

    // 编组成员也换成了新 id，且数量不变
    expect(made.groups).toHaveLength(1);
    expect(made.groups[0].cardIds).toHaveLength(2);
    for (const id of made.groups[0].cardIds) expect(newCardIds.has(id)).toBe(true);
  });

  it('视口落回原点、`readOnly` 清掉、`aliases` 清空、`parent` 按参数归位', () => {
    const made = instantiateTemplate(fixture(), { parent: 'Boards/新父.nboard' });

    expect(made.view.x).toBe(0);
    expect(made.view.y).toBe(0);
    expect(made.view.zoom).toBe(1);
    expect(made.meta.parent).toBe('Boards/新父.nboard');
    expect(made.meta.aliases).toEqual([]);
    expect(made.settings.readOnly).toBe(false);
  });

  it('`parent` 不传 = 顶层板（`null`）', () => {
    expect(instantiateTemplate(fixture()).meta.parent).toBeNull();
  });

  it('刻意保留：背景、其余设置、卡片演示步骤', () => {
    const made = instantiateTemplate(fixture());
    const howto = made.cards.find((card) => card.presentStep === 2);

    expect(made.view.background).toBe('grid');
    expect(made.settings.snapToGrid).toBe(false);
    expect(howto?.presentStep).toBe(2);
  });

  it('标题：传了就用传的，没传沿用模板标题', () => {
    expect(instantiateTemplate(fixture(), { title: '新板' }).meta.title).toBe('新板');
    expect(instantiateTemplate(fixture()).meta.title).toBe('原板');
  });

  it('栏内卡片重新排版（不再停在模板作者摆的旧坐标上）', () => {
    const source = fixture();
    const made = instantiateTemplate(source);
    const moved = made.cards.find((card) => card.columnId !== null);

    expect(moved).toBeDefined();
    // 模板里那张栏内卡被摆在 (9999, 9999)，实例化后必须落到分栏的范围内
    const column = made.columns[0];
    expect(moved!.x).toBeGreaterThanOrEqual(column.x);
    expect(moved!.y).toBeGreaterThanOrEqual(column.y);
    expect(moved!.x).toBeLessThan(column.x + column.width);
  });

  it('不共享任何对象：改实例化出来的板碰不到模板', () => {
    const source = fixture();
    const made = instantiateTemplate(source);

    made.cards[0].title = '改过了';
    made.meta.tags.push('新标签');

    for (const card of source.cards) expect(card.title).not.toBe('改过了');
    expect(source.meta.tags).toEqual([]);
  });

  it('指向不存在卡片的连线整条丢掉；自由端（`cardId` 为空）原样带走', () => {
    const source = fixture();
    const gone = createCard('note');
    source.edges.push(
      createEdge({ cardId: gone.id, side: null }, { cardId: source.cards[0].id, side: null }),
    );
    source.edges.push(
      createEdge({ cardId: '', side: null }, { cardId: source.cards[0].id, side: null }),
    );

    const made = instantiateTemplate(source);

    expect(made.edges).toHaveLength(2);
    const freeEnd = made.edges.find((edge) => edge.from.cardId === '');
    expect(freeEnd).toBeDefined();
    expect(freeEnd?.to.cardId.length).toBeGreaterThan(0);
  });

  it('编组成员全部失联时整组丢掉（留一个空组 = 一个看不见的框）', () => {
    const source = fixture();
    source.groups.push(createGroup([createCard('note').id], '空组'));

    const made = instantiateTemplate(source);

    expect(made.groups).toHaveLength(1);
    expect(made.groups[0].label).toBe('一组');
  });
});

// ─────────────────────────────────────────────────────────────
// 打包：文件长什么样
// ─────────────────────────────────────────────────────────────

describe('packTemplate', () => {
  it('换板 id / 换标题 / `parent` 归空 / 别名清空 / revision 归零', () => {
    const source = fixture();
    source.revision = 7;

    const packed = packTemplate(source, '我的模板');

    expect(packed.meta.id).not.toBe(source.meta.id);
    expect(packed.meta.title).toBe('我的模板');
    expect(packed.meta.parent).toBeNull();
    expect(packed.meta.aliases).toEqual([]);
    expect(packed.revision).toBe(0);
  });

  it('视口落回原点、`readOnly` 清掉', () => {
    const packed = packTemplate(fixture(), '模板');

    expect(packed.view.x).toBe(0);
    expect(packed.view.y).toBe(0);
    expect(packed.view.zoom).toBe(1);
    expect(packed.view.background).toBe('grid');
    expect(packed.settings.readOnly).toBe(false);
  });

  it('卡片 / 分栏 id **保持原样**：这份文件只是拿来用的，用的时候再统一换', () => {
    const source = fixture();
    const packed = packTemplate(source, '模板');

    expect(packed.cards.map((card) => card.id)).toEqual(source.cards.map((card) => card.id));
    expect(packed.columns.map((column) => column.id)).toEqual(
      source.columns.map((column) => column.id),
    );
  });

  it('不共享对象：改打包结果碰不到原板', () => {
    const source = fixture();
    const packed = packTemplate(source, '模板');

    packed.cards[0].title = '改过了';

    for (const card of source.cards) expect(card.title).not.toBe('改过了');
    expect(source.meta.title).toBe('原板');
  });
});

describe('describeTemplate', () => {
  it('数出卡片 / 分栏 / 连线，供列表那行数字使用', () => {
    expect(describeTemplate(fixture())).toEqual({ cards: 3, columns: 1, edges: 1 });

    for (const template of BUILTIN_TEMPLATES) {
      const board = template.build();
      expect(describeTemplate(board)).toEqual({
        cards: board.cards.length,
        columns: board.columns.length,
        edges: board.edges.length,
      });
    }
  });
});
