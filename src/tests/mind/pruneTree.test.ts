/**
 * 卡内嵌脑图的截断规则（`F3a` / `mind/embed/pruneTree.ts`）。
 *
 * 这一层是全项里**最容易"看着对"却错**的一块：`+N` 里的数字、哪一支被截，
 * 都要与画布上看到的顺序一致。所以逐条钉住，而不是只钉"层数对了"。
 */

import { describe, expect, it } from 'vitest';
import { EMBED_MAX_DEPTH, pruneMindForEmbed } from '../../mind/embed/pruneTree';
import type { MindFile, MindNode } from '../../mind/model/schema';

/** 造一棵树：`text` 就是 id（`a` 的孩子 `a1`/`a2`……） */
function treeOf(...ids: string[]): MindFile {
  const nodes: MindNode[] = ids.map((id) => {
    const parentId = id.length > 1 ? id.slice(0, -1) : null;
    const last = id.slice(-1);
    return {
      id,
      text: id,
      note: '',
      parentId: id === 'a' ? null : parentId,
      order: Number.isFinite(Number(last)) ? Number(last) : 0,
    };
  });
  return {
    spec: 'nestmind/1',
    version: 1,
    revision: 1,
    meta: { id: 'm1', title: '', createdAt: '', updatedAt: '' },
    view: {},
    rootId: 'a',
    nodes,
  } as unknown as MindFile;
}

describe('pruneMindForEmbed · 深度截断', () => {
  it('根 + 前 3 层都留着（根算第 0 层）', () => {
    const { file, hiddenOf } = pruneMindForEmbed(treeOf('a', 'a1', 'a11', 'a111', 'a1111'));

    expect(file.nodes.map((node) => node.id)).toEqual(['a', 'a1', 'a11', 'a111']);
    // 第 3 层那个节点下面还藏着一个 ⇒ `+1`
    expect(hiddenOf.get('a111')).toBe(1);
    expect(hiddenOf.get('a11')).toBeUndefined();
  });

  it('★ `+N` 数的是**整支子孙**，不是直接孩子（三层以下一律算进最上面那个被截的节点）', () => {
    const { hiddenOf } = pruneMindForEmbed(
      treeOf('a', 'a1', 'a11', 'a111', 'a1111', 'a11111'),
      // 上限收到 2 层，让 a11 成为"被截的那个"
      2,
    );

    // a11 下面是 a111 → a1111 → a11111，一共 3 个
    expect(hiddenOf.get('a11')).toBe(3);
  });

  it('默认上限就是 3（根 + 3 层）—— 口径写死在常量里，改它要连着改文档', () => {
    expect(EMBED_MAX_DEPTH).toBe(3);
  });
});

describe('pruneMindForEmbed · 收起的一支', () => {
  it('`collapsed` 的子树一个节点都不留，整支记成 `+N`', () => {
    const mind = treeOf('a', 'a1', 'a11', 'a2');
    mind.nodes.find((node) => node.id === 'a1')!.collapsed = true;

    const { file, hiddenOf } = pruneMindForEmbed(mind);

    expect(file.nodes.map((node) => node.id)).toEqual(['a', 'a1', 'a2']);
    expect(hiddenOf.get('a1')).toBe(1);
  });

  it('★ 收起的节点**不与深度截断叠加**：记的仍然是整支子孙数', () => {
    const mind = treeOf('a', 'a1', 'a11', 'a111', 'a1111');
    mind.nodes.find((node) => node.id === 'a1')!.collapsed = true;

    const { hiddenOf } = pruneMindForEmbed(mind);
    expect(hiddenOf.get('a1')).toBe(3);
  });

  it('没有孩子的节点不记 `+N`（不然每个叶子都挂一个「+0」）', () => {
    const { hiddenOf } = pruneMindForEmbed(treeOf('a', 'a1'));
    expect(hiddenOf.size).toBe(0);
  });
});

describe('pruneMindForEmbed · 悬浮节点与顺序', () => {
  it('悬浮节点（`parentId === null`）照样画，且**自己也从第 0 层起算**', () => {
    const mind = treeOf('a', 'a1');
    mind.nodes.push({
      id: 'f',
      text: 'f',
      note: '',
      parentId: null,
      order: 0,
      free: { x: 1, y: 2 },
    });

    const { file } = pruneMindForEmbed(mind);
    expect(file.nodes.map((node) => node.id)).toEqual(['a', 'a1', 'f']);
  });

  it('★ 留下的节点保持原顺序与 `parentId`（布局按它排，改顺序就是改画面）', () => {
    const { file } = pruneMindForEmbed(treeOf('a', 'a1', 'a2', 'a11'));
    expect(file.nodes.map((node) => node.id)).toEqual(['a', 'a1', 'a2', 'a11']);
    expect(file.nodes.find((node) => node.id === 'a11')?.parentId).toBe('a1');
  });

  it('★ 根不在（坏文件）时，`parentId === null` 的节点按**悬浮节点**画（不白屏）', () => {
    const mind = treeOf('a', 'a1');
    mind.rootId = '幽灵';
    expect(pruneMindForEmbed(mind).file.nodes.map((node) => node.id)).toEqual(['a', 'a1']);
  });

  it('★ 父节点不在（真孤儿）的节点被丢掉：它连不到任何一棵树上', () => {
    const mind = treeOf('a', 'a1');
    mind.nodes.push({ id: 'x', text: 'x', note: '', parentId: '幽灵', order: 0 });
    expect(pruneMindForEmbed(mind).file.nodes.map((node) => node.id)).toEqual(['a', 'a1']);
  });
});
