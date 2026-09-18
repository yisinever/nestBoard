/**
 * 脑图树操作（`06 §4.1` / `mind/model/ops.ts`）—— 编辑内核的**纯逻辑**。
 *
 * 视图的每一个编辑动作都落在这些函数上，所以这里是"编辑到底对不对"的第一道闸门：
 * 加子节点 / 加兄弟 / 提升 / 删除子树 / 改父 / 折叠 / 可见顺序与键盘落点。
 * 另加一组"撤销快照"的用例（`mind/model/history.ts` + 文档中立的 `HistoryStack`）。
 */

import { describe, expect, it } from 'vitest';
import { HistoryStack } from '../../model/history';
import { restoreMindContent, serializeMindContent } from '../../mind/model/history';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import {
  addChild,
  addSibling,
  childrenOf,
  depthOf,
  enterAtEnd,
  hasChildren,
  indent,
  horizontalTargetId,
  isDescendant,
  moveNode,
  nextVisibleId,
  nodeById,
  parentOf,
  moveNodes,
  promote,
  removeNodes,
  removeRef,
  removeSubtree,
  renumberSiblings,
  sanitizeSelection,
  selectionRoots,
  splitNodeAt,
  setIcon,
  setNodeStyle,
  setNodeStyles,
  setRefWidth,
  setRefs,
  setCollapsed,
  setDone,
  setCollapsedFromDepth,
  setNote,
  setText,
  siblingIds,
  subtreeIds,
  subtreeSizes,
  visibleIds,
} from '../../mind/model/ops';
import type { MindFile } from '../../mind/model/schema';
import { MIND_IMAGE_MAX_WIDTH, MIND_IMAGE_MIN_WIDTH } from '../../mind/model/refs';
import { mindWith } from '../helpers/mindFixtures';

// ── 工具 ─────────────────────────────────────────────────────

/** 只看结构：`文字(父文字)` 的有序列表，断言起来比一堆字段好读 */
function structureOf(mind: MindFile): string[] {
  return childrenOf(mind, null)
    .flatMap(function flatten(node): string[] {
      const label = node.parentId === null ? `${node.text}(根/浮)` : node.text;
      return [label, ...childrenOf(mind, node.id).flatMap(flatten)];
    })
    .concat();
}

const texts = (mind: MindFile, ids: readonly string[]): string[] =>
  ids.map((id) => nodeById(mind, id)?.text ?? '?');

// ── 查询 ─────────────────────────────────────────────────────

describe('查询', () => {
  it('孩子按 `order` 排；父 / 兄弟 / 深度都问得到', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
      ['甲一', '甲'],
      ['甲二', '甲'],
    ]);

    expect(
      texts(
        mind,
        childrenOf(mind, 'n_中心').map((node) => node.id),
      ),
    ).toEqual(['甲', '乙']);
    expect(parentOf(mind, 'n_甲一')?.text).toBe('甲');
    expect(parentOf(mind, 'n_中心')).toBeNull();
    expect(siblingIds(mind, 'n_甲')).toEqual(['n_甲', 'n_乙']);
    expect(depthOf(mind, 'n_中心')).toBe(0);
    expect(depthOf(mind, 'n_乙')).toBe(1);
    expect(depthOf(mind, 'n_甲二')).toBe(2);
  });

  it('悬浮节点与根同属 `parentId === null` 那一层，深度都是 0', () => {
    const mind = mindWith([
      ['中心', null],
      ['自由', null],
      ['自由子', '自由'],
    ]);

    expect(childrenOf(mind, null).map((node) => node.text)).toEqual(['中心', '自由']);
    expect(depthOf(mind, 'n_自由')).toBe(0);
    expect(depthOf(mind, 'n_自由子')).toBe(1);
  });

  it('子树 = 自己 + 全部后代（含被折叠藏起来的）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['甲二', '甲'],
      ['乙', '中心'],
    ]);
    const node = nodeById(mind, 'n_甲');
    if (node) node.collapsed = true;

    expect([...subtreeIds(mind, 'n_甲')].sort()).toEqual(['n_甲', 'n_甲一', 'n_甲二']);
    expect(hasChildren(mind, 'n_甲')).toBe(true);
    expect(hasChildren(mind, 'n_乙')).toBe(false);
  });

  it('`isDescendant`：自己不算自己的后代', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
    ]);

    expect(isDescendant(mind, 'n_甲', 'n_甲一')).toBe(true);
    expect(isDescendant(mind, 'n_甲', 'n_甲')).toBe(false);
    expect(isDescendant(mind, 'n_甲一', 'n_甲')).toBe(false);
  });
});

// ── 可见顺序与键盘落点 ───────────────────────────────────────

describe('可见顺序与键盘落点', () => {
  it('★ 前序：折叠的子树整棵跳过；悬浮节点的子树接在主树之后', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['乙', '中心'],
      ['自由', null],
      ['自由子', '自由'],
    ]);
    expect(texts(mind, visibleIds(mind))).toEqual(['中心', '甲', '甲一', '乙', '自由', '自由子']);

    const jia = nodeById(mind, 'n_甲');
    if (jia) jia.collapsed = true;
    expect(texts(mind, visibleIds(mind))).toEqual(['中心', '甲', '乙', '自由', '自由子']);
  });

  it('`↑` / `↓` 走可见顺序，两端返回 `null`', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
    ]);

    expect(nextVisibleId(mind, 'n_中心', 1)).toBe('n_甲');
    expect(nextVisibleId(mind, 'n_甲', -1)).toBe('n_中心');
    expect(nextVisibleId(mind, 'n_中心', -1)).toBeNull();
    expect(nextVisibleId(mind, 'n_乙', 1)).toBeNull();
  });

  it('★ `←` / `→` 按**展开方向**判（右侧那一支往孩子的方向是 `→`）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
    ]);

    // 挂在右边（side = 1）：→ 进孩子，← 回父
    expect(horizontalTargetId(mind, 'n_甲', 1, 1)).toBe('n_甲一');
    expect(horizontalTargetId(mind, 'n_甲', -1, 1)).toBe('n_中心');
    // 挂在左边（side = -1）：镜像过来
    expect(horizontalTargetId(mind, 'n_甲', -1, -1)).toBe('n_甲一');
    expect(horizontalTargetId(mind, 'n_甲', 1, -1)).toBe('n_中心');
    // 根：孩子在右
    expect(horizontalTargetId(mind, 'n_中心', 1, 0)).toBe('n_甲');
    expect(horizontalTargetId(mind, 'n_中心', -1, 0)).toBeNull();
  });
});

// ── 改字段 ───────────────────────────────────────────────────

describe('改字段', () => {
  it('`setText` / `setNote`：真改了才返回 `true`（谎报会让撤销栈多出空档）', () => {
    const mind = mindWith([['中心', null]]);

    expect(setText(mind, 'n_中心', '新名字')).toBe(true);
    expect(setText(mind, 'n_中心', '新名字')).toBe(false);
    expect(setText(mind, 'n_不存在', 'x')).toBe(false);
    expect(setNote(mind, 'n_中心', '正文')).toBe(true);
    expect(setNote(mind, 'n_中心', '正文')).toBe(false);
  });

  it('★ 折叠：收起写 `true`，展开**删掉这个键**（缺席即默认，不写 `false` 噪声）', () => {
    const mind = mindWith([['中心', null]]);

    expect(setCollapsed(mind, 'n_中心', true)).toBe(true);
    expect(nodeById(mind, 'n_中心')?.collapsed).toBe(true);
    expect(setCollapsed(mind, 'n_中心', true)).toBe(false);

    expect(setCollapsed(mind, 'n_中心', false)).toBe(true);
    const node = nodeById(mind, 'n_中心');
    expect(node ? Object.prototype.hasOwnProperty.call(node, 'collapsed') : true).toBe(false);
  });
});

// ── 增 ───────────────────────────────────────────────────────

describe('增', () => {
  it('`addChild`：追加到末尾、次序连续、标题为空（等用户敲）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);

    const id = addChild(mind, 'n_中心');
    const created = id === null ? null : nodeById(mind, id);

    expect(created?.parentId).toBe('n_中心');
    expect(created?.text).toBe('');
    expect(created?.order).toBe(1);
    expect(addChild(mind, 'n_不存在')).toBeNull();
  });

  it('`addSibling`：插在它后面，并把兄弟次序重排成连续', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
    ]);

    const id = addSibling(mind, 'n_甲');

    expect(childrenOf(mind, 'n_中心').map((node) => node.id)).toEqual(['n_甲', id, 'n_乙']);
    expect(childrenOf(mind, 'n_中心').map((node) => node.order)).toEqual([0, 1, 2]);
  });

  it('★ 在**根**上按 `Enter` = 加子节点（根没有兄弟：那是"把整张图变成森林"）', () => {
    const mind = mindWith([['中心', null]]);

    const id = addSibling(mind, 'n_中心');

    expect(nodeById(mind, id ?? '')?.parentId).toBe('n_中心');
  });

  it('悬浮节点上按 `Enter` 同样加子节点', () => {
    const mind = mindWith([
      ['中心', null],
      ['自由', null],
    ]);

    const id = addSibling(mind, 'n_自由');

    expect(nodeById(mind, id ?? '')?.parentId).toBe('n_自由');
  });
});

// ── 提升 / 删除 / 移动 ───────────────────────────────────────

describe('提升（`Shift+Tab`）', () => {
  it('★ 挂到祖父下、插在父节点之后', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['甲二', '甲'],
      ['乙', '中心'],
    ]);

    expect(promote(mind, 'n_甲一')).toBe(true);

    expect(nodeById(mind, 'n_甲一')?.parentId).toBe('n_中心');
    expect(
      texts(
        mind,
        childrenOf(mind, 'n_中心').map((node) => node.id),
      ),
    ).toEqual(['甲', '甲一', '乙']);
    // 原来的父节点那边剩一个孩子，次序同样连续
    expect(childrenOf(mind, 'n_甲').map((node) => node.order)).toEqual([0]);
  });

  it('叶子直接挂在根下时退无可退（再往上就不是树了）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);

    expect(promote(mind, 'n_甲')).toBe(false);
    expect(promote(mind, 'n_中心')).toBe(false);
  });
});

describe('删除（`Delete`）', () => {
  it('★ 连整棵子树一起删，并把兄弟次序重排', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['甲二', '甲'],
      ['乙', '中心'],
    ]);

    expect(removeSubtree(mind, 'n_甲')).toBe(true);

    expect(mind.nodes.map((node) => node.text)).toEqual(['中心', '乙']);
    expect(childrenOf(mind, 'n_中心').map((node) => node.order)).toEqual([0]);
  });

  it('★ 根节点删不掉（一份脑图没有中心主题就不是脑图了）', () => {
    const mind = mindWith([['中心', null]]);

    expect(removeSubtree(mind, 'n_中心')).toBe(false);
    expect(mind.nodes).toHaveLength(1);
  });
});

describe('改父（`moveNode`）', () => {
  it('换一个父节点并插到指定位置', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['乙', '中心'],
    ]);

    expect(moveNode(mind, 'n_甲一', 'n_乙', { index: 0 })).toBe(true);

    expect(nodeById(mind, 'n_甲一')?.parentId).toBe('n_乙');
    expect(childrenOf(mind, 'n_乙').map((node) => node.text)).toEqual(['甲一']);
    expect(childrenOf(mind, 'n_甲')).toHaveLength(0);
  });

  it('★ 挂到自己的后代下会被挡（那是成环）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
    ]);

    expect(moveNode(mind, 'n_甲', 'n_甲一')).toBe(false);
    expect(moveNode(mind, 'n_甲', 'n_甲')).toBe(false);
    expect(moveNode(mind, 'n_甲', 'n_不存在')).toBe(false);
    expect(moveNode(mind, 'n_中心', 'n_甲')).toBe(false);
  });

  it('★ 拖到空白 = 变成悬浮节点：补上坐标（坐标是数据，必须有）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);

    expect(moveNode(mind, 'n_甲', null, { free: { x: 320, y: -80 } })).toBe(true);

    const node = nodeById(mind, 'n_甲');
    expect(node?.parentId).toBeNull();
    expect(node?.free).toEqual({ x: 320, y: -80 });
    expect(childrenOf(mind, null).map((item) => item.text)).toEqual(['中心', '甲']);
  });

  it('★ 从悬浮挂回树上：坐标删掉（树上节点的位置由布局算）', () => {
    const mind = mindWith([
      ['中心', null],
      ['自由', null],
    ]);
    const free = nodeById(mind, 'n_自由');
    if (free) free.free = { x: 100, y: 100 };

    expect(moveNode(mind, 'n_自由', 'n_中心')).toBe(true);

    const node = nodeById(mind, 'n_自由');
    expect(node?.parentId).toBe('n_中心');
    expect(node ? Object.prototype.hasOwnProperty.call(node, 'free') : true).toBe(false);
  });

  it('换到同一个父下但位置没变 → 什么都没改', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);

    expect(moveNode(mind, 'n_甲', 'n_中心')).toBe(false);
  });
});

// ── 多选 ─────────────────────────────────────────────────────

describe('多选（P3-c）', () => {
  /** 一棵三层树：中心 → 甲（甲一、甲二）/ 乙（乙一） */
  const tree = () =>
    mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['甲二', '甲'],
      ['乙', '中心'],
      ['乙一', '乙'],
    ]);

  describe('selectionRoots', () => {
    it('★ 祖先也在选区里时只留祖先（父子同时选中 = 一件事，不是两件）', () => {
      const mind = tree();
      expect(selectionRoots(mind, new Set(['n_甲', 'n_甲一']))).toEqual(['n_甲']);
    });

    it('散落的几支各自都是入口', () => {
      const mind = tree();
      expect(selectionRoots(mind, new Set(['n_甲一', 'n_乙一']))).toEqual(['n_甲一', 'n_乙一']);
    });

    it('★ 按**可见顺序**排（不是点选的先后）', () => {
      const mind = tree();
      expect(selectionRoots(mind, new Set(['n_乙', 'n_甲']))).toEqual(['n_甲', 'n_乙']);
    });

    it('不存在的 id（刚被删掉）被剔掉', () => {
      const mind = tree();
      expect(selectionRoots(mind, new Set(['n_甲', 'n_幽灵']))).toEqual(['n_甲']);
      expect(sanitizeSelection(mind, new Set(['n_幽灵'])).size).toBe(0);
    });
  });

  describe('removeNodes', () => {
    it('★ 只删入口（子孙跟着走），并跳过根', () => {
      const mind = tree();

      expect(removeNodes(mind, new Set([mind.rootId, 'n_甲', 'n_甲一']))).toBe(true);

      expect(mind.nodes.map((node) => node.text)).toEqual(['中心', '乙', '乙一']);
    });

    it('只选了根 → 什么都没删（返回 `false`，不占撤销栈）', () => {
      const mind = tree();
      expect(removeNodes(mind, new Set([mind.rootId]))).toBe(false);
      expect(mind.nodes).toHaveLength(6);
    });

    it('★ `⌘A` 之后删：根留着，其余全走（"全选再删"是最常用的那条路，不能失灵）', () => {
      const mind = tree();

      expect(removeNodes(mind, new Set(mind.nodes.map((node) => node.id)))).toBe(true);

      expect(mind.nodes.map((node) => node.text)).toEqual(['中心']);
      expect(mind.rootId).toBe('n_中心');
    });
  });

  describe('moveNodes', () => {
    it('★ 把散落的几支一起挂到同一个父下（按可见顺序依次插入）', () => {
      const mind = tree();

      expect(moveNodes(mind, new Set(['n_甲一', 'n_乙一']), 'n_乙')).toBe(true);

      expect(childrenOf(mind, 'n_乙').map((node) => node.text)).toEqual(['乙一', '甲一']);
    });

    it('父子同时选中时只挪祖先（甲一跟着甲走，不会再被挪一次）', () => {
      const mind = tree();

      expect(moveNodes(mind, new Set(['n_甲', 'n_甲一']), 'n_乙')).toBe(true);

      expect(nodeById(mind, 'n_甲')?.parentId).toBe('n_乙');
      expect(nodeById(mind, 'n_甲一')?.parentId).toBe('n_甲');
      expect(childrenOf(mind, 'n_乙').map((node) => node.text)).toEqual(['乙一', '甲']);
    });

    it('★ 目标是选区里的节点 / 选区的后代 → 整簇不动（成环，不做部分成功）', () => {
      const mind = tree();
      const ids = new Set(['n_甲', 'n_甲一']);

      expect(moveNodes(mind, ids, 'n_甲')).toBe(false);
      expect(moveNodes(mind, ids, 'n_甲二')).toBe(false);
      expect(nodeById(mind, 'n_甲')?.parentId).toBe('n_中心');
    });

    it('目标不存在 → `false`', () => {
      const mind = tree();
      expect(moveNodes(mind, new Set(['n_甲']), 'n_幽灵')).toBe(false);
    });
  });
});

describe('引用（`B` 的 setRefs / removeRef）', () => {
  const withNote = () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    return { mind, id: 'n_甲' };
  };

  it('写进 `refs`（类型由调用方算好；这里只管存）', () => {
    const { mind, id } = withNote();

    expect(setRefs(mind, id, [{ kind: 'image', path: 'a.png' }])).toBe(true);
    expect(nodeById(mind, id)?.refs).toEqual([{ kind: 'image', path: 'a.png' }]);
  });

  it('★ 一模一样时返回 `false`（不写盘、不占撤销栈）', () => {
    const { mind, id } = withNote();
    setRefs(mind, id, [{ kind: 'image', path: 'a.png' }]);

    expect(setRefs(mind, id, [{ kind: 'image', path: 'a.png' }])).toBe(false);
    // 类型变了也算变
    expect(setRefs(mind, id, [{ kind: 'file', path: 'a.png' }])).toBe(true);
  });

  it('★ 摘空了就**删掉这个键**（纪律 2：可选键缺席即默认，不留空数组）', () => {
    const { mind, id } = withNote();
    setRefs(mind, id, [{ kind: 'image', path: 'a.png' }]);

    expect(setRefs(mind, id, [])).toBe(true);
    expect('refs' in (nodeById(mind, id) ?? {})).toBe(false);
  });

  it('节点不存在 → `false`（不给不存在的节点留垃圾字段）', () => {
    const { mind } = withNote();
    expect(setRefs(mind, 'n_幽灵', [{ kind: 'file', path: 'a' }])).toBe(false);
  });

  it('`removeRef` 按**路径**摘（下标会随别的操作变，路径不会）', () => {
    const { mind, id } = withNote();
    setRefs(mind, id, [
      { kind: 'image', path: 'a.png' },
      { kind: 'note', path: 'b.md' },
    ]);

    expect(removeRef(mind, id, 'a.png')).toBe(true);
    expect(nodeById(mind, id)?.refs).toEqual([{ kind: 'note', path: 'b.md' }]);
    // 再摘一次那条路径：本来就没有了
    expect(removeRef(mind, id, 'a.png')).toBe(false);
  });

  it('★ 宽度会被带过（`setRefs` 整条复制，不是只抄 path）', () => {
    const { mind, id } = withNote();

    setRefs(mind, id, [{ kind: 'image', path: 'a.png', width: 300 }]);
    expect(nodeById(mind, id)?.refs).toEqual([{ kind: 'image', path: 'a.png', width: 300 }]);
  });
});

describe('图片宽度（`setRefWidth`）', () => {
  const withImage = (width?: number) => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    setRefs(mind, 'n_甲', [{ kind: 'image', path: 'a.png', ...(width ? { width } : {}) }]);
    return mind;
  };

  it('写进 `refs[0].width`（四舍五入）', () => {
    const mind = withImage();

    expect(setRefWidth(mind, 'n_甲', 263.4)).toBe(true);
    expect(nodeById(mind, 'n_甲')?.refs?.[0]?.width).toBe(263);
  });

  it('★ 夹在上下限里：太小看不清、太大一张图占满屏幕', () => {
    const mind = withImage();

    setRefWidth(mind, 'n_甲', 1);
    expect(nodeById(mind, 'n_甲')?.refs?.[0]?.width).toBe(MIND_IMAGE_MIN_WIDTH);
    setRefWidth(mind, 'n_甲', 99999);
    expect(nodeById(mind, 'n_甲')?.refs?.[0]?.width).toBe(MIND_IMAGE_MAX_WIDTH);
  });

  it('★ 夹完之后还是原值 ⇒ `false`（不写盘、不占撤销栈）', () => {
    const mind = withImage(MIND_IMAGE_MIN_WIDTH);

    expect(setRefWidth(mind, 'n_甲', MIND_IMAGE_MIN_WIDTH - 100)).toBe(false);
  });

  it('非图片 / 没挂附件 / 节点不存在 ⇒ `false`', () => {
    const note = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    setRefs(note, 'n_甲', [{ kind: 'note', path: 'a.md' }]);

    expect(setRefWidth(note, 'n_甲', 200)).toBe(false);
    expect(setRefWidth(note, 'n_中心', 200)).toBe(false);
    expect(setRefWidth(note, 'n_幽灵', 200)).toBe(false);
  });
});

describe('节点标记（`setIcon`，`08 §3.1`）', () => {
  const withNode = () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    return { mind, id: 'n_甲' };
  };

  it('写进去（归一化走 `util/emoji` 那份，与白板卡片共用）', () => {
    const { mind, id } = withNode();

    expect(setIcon(mind, id, '📌')).toBe(true);
    expect(nodeById(mind, id)?.icon).toBe('📌');
  });

  it('★ 传空串 = 摘掉标记 ⇒ **删掉这个键**（纪律 2：不留空串）', () => {
    const { mind, id } = withNode();
    setIcon(mind, id, '📌');

    expect(setIcon(mind, id, '')).toBe(true);
    expect('icon' in (nodeById(mind, id) ?? {})).toBe(false);
  });

  it('值没变 → `false`（不写盘、不占撤销栈）', () => {
    const { mind, id } = withNode();
    setIcon(mind, id, '📌');

    expect(setIcon(mind, id, '📌')).toBe(false);
    expect(setIcon(mind, id, '')).toBe(true);
    expect(setIcon(mind, id, '')).toBe(false);
  });
});

describe('批量改外观（`setNodeStyles`，`N2`）', () => {
  const withNodes = () =>
    mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
    ]);

  it('★ 一次改一批（框选统一改底色）', () => {
    const mind = withNodes();

    expect(setNodeStyles(mind, ['n_甲', 'n_乙'], { color: '4' })).toBe(true);
    expect(nodeById(mind, 'n_甲')?.style?.color).toBe('4');
    expect(nodeById(mind, 'n_乙')?.style?.color).toBe('4');
  });

  it('★ 只要有一条真的改了就给 `true`（一次操作 = 一步 `⌘Z`）；全都没变给 `false`', () => {
    const mind = withNodes();
    setNodeStyles(mind, ['n_甲', 'n_乙'], { color: '4' });

    expect(setNodeStyles(mind, ['n_甲', 'n_乙'], { color: '4' })).toBe(false);
    // 一个真节点 + 一个幽灵：真那个改了，照样算"改了"
    expect(setNodeStyles(mind, ['n_甲', 'n_幽灵'], { italic: true })).toBe(true);
  });

  it('空数组 ⇒ `false`（不产生一次空历史）', () => {
    expect(setNodeStyles(withNodes(), [], { bold: true })).toBe(false);
  });

  it('逐条沿用单选的删键纪律（`italic: false` 删键、`style` 空了连它一起删）', () => {
    const mind = withNodes();
    setNodeStyles(mind, ['n_甲', 'n_乙'], { italic: true });

    expect(setNodeStyles(mind, ['n_甲', 'n_乙'], { italic: false })).toBe(true);
    expect('style' in (nodeById(mind, 'n_甲') ?? {})).toBe(false);
  });
});

describe('节点外观（`setNodeStyle`，`08 §3.2` / `§3.3`）', () => {
  const withNode = () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    return { mind, id: 'n_甲' };
  };

  it('主色 / 字色：设进去、传 `null` 清掉', () => {
    const { mind, id } = withNode();

    expect(setNodeStyle(mind, id, { color: '3' })).toBe(true);
    expect(nodeById(mind, id)?.style?.color).toBe('3');
    expect(setNodeStyle(mind, id, { color: null })).toBe(true);
    expect(nodeById(mind, id)?.style?.color).toBeUndefined();
  });

  it('★ 三个开关：`italic` / `underline` 关掉就**删键**（缺省是常量 false）', () => {
    const { mind, id } = withNode();
    setNodeStyle(mind, id, { italic: true, underline: true });

    expect(setNodeStyle(mind, id, { italic: false })).toBe(true);
    expect('italic' in (nodeById(mind, id)?.style ?? {})).toBe(false);
    expect(nodeById(mind, id)?.style?.underline).toBe(true);
  });

  it('★ `bold: false` **必须留住**（缺省取决于层级：根是加粗的）', () => {
    const { mind, id } = withNode();
    setNodeStyle(mind, id, { bold: true });

    expect(setNodeStyle(mind, id, { bold: false })).toBe(true);
    expect(nodeById(mind, id)?.style?.bold).toBe(false);
  });

  it('★ 全清空之后连 `style` 键一起删掉（不留 `"style":{}` 这种噪声）', () => {
    const { mind, id } = withNode();
    setNodeStyle(mind, id, { color: '2', ink: '#ffffff', italic: true });

    setNodeStyle(mind, id, { color: null });
    setNodeStyle(mind, id, { ink: null });
    setNodeStyle(mind, id, { italic: false });
    expect('style' in (nodeById(mind, id) ?? {})).toBe(false);
  });

  it('值没变 → `false`；`override`（P5 的手调）不被碰', () => {
    const { mind, id } = withNode();
    const node = nodeById(mind, id);
    if (node) {
      node.style = { override: { title: '#ff0000', body: '#ffffff', ink: '#000000' } };
    }

    expect(setNodeStyle(mind, id, { color: null })).toBe(false);
    expect(setNodeStyle(mind, id, { bold: true })).toBe(true);
    expect(nodeById(mind, id)?.style?.override).toEqual({
      title: '#ff0000',
      body: '#ffffff',
      ink: '#000000',
    });
  });

  it('节点不存在 → `false`', () => {
    const { mind } = withNode();
    expect(setNodeStyle(mind, 'n_幽灵', { bold: true })).toBe(false);
  });

  it('★ 文字高亮（`N3-f`）：设进去、值没变给 `false`、传 `null` 就**删键**', () => {
    const { mind, id } = withNode();

    // 缺省是"没有高亮"这个**常量** ⇒ 与 `ink` 同一条：`null` 删键（纪律 2）
    expect(setNodeStyle(mind, id, { highlight: '#fff3b0' })).toBe(true);
    expect(nodeById(mind, id)?.style?.highlight).toBe('#fff3b0');
    expect(setNodeStyle(mind, id, { highlight: '#fff3b0' })).toBe(false);
    expect(setNodeStyle(mind, id, { highlight: null })).toBe(true);
    expect('highlight' in (nodeById(mind, id)?.style ?? {})).toBe(false);
  });

  it('高亮是**色号**（不是主题色编号）：原样存下来，不被解析成别的东西', () => {
    const { mind, id } = withNode();
    setNodeStyle(mind, id, { highlight: '#cfe8ff' });

    // 与 `ink` 同一条纪律 —— 主题色编号会跟着主题变，而"我划过哪一段"是存进文件的选择
    expect(nodeById(mind, id)?.style?.highlight).toBe('#cfe8ff');
  });
});

describe('回车拆行（`splitNodeAt`，`N3-i`）', () => {
  const file = () =>
    mindWith([
      ['中心', null],
      ['甲乙丙', '中心'],
      ['甲1', '甲乙丙'],
      ['丁', '中心'],
    ]);

  it('★ 光标在文字中间 ⇒ 前半截成为**前一个兄弟**，原节点留后半截（子节点跟着它）', () => {
    const mind = file();
    const target = splitNodeAt(mind, 'n_甲乙丙', 1);

    // 返回值 = **接着要编辑的那一个**（原节点）
    expect(target).toBe('n_甲乙丙');
    // 顺序照读到的文字来：前半截在前
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '乙丙', '丁']);
    // 后半截 + **原来的子节点**都跟着原节点（用户原话："子节点都跟随这个节点"）
    expect(nodeById(mind, 'n_甲乙丙')?.text).toBe('乙丙');
    expect(childrenOf(mind, 'n_甲乙丙').map((node) => node.id)).toEqual(['n_甲1']);
    // 前半截确实是**新节点**，不是把原节点改了名
    const created = childrenOf(mind, 'n_中心')[0];
    expect(created?.text).toBe('甲');
    expect(created?.id).not.toBe('n_甲乙丙');
  });

  it('★ 光标在**叶子节点**的末尾 ⇒ 下方新建一个空兄弟，返回的是**那个新节点**', () => {
    const mind = file();
    const target = splitNodeAt(mind, 'n_丁', 1);

    expect(target).not.toBe('n_丁');
    expect(target === null ? null : nodeById(mind, target)?.text).toBe('');
    // 原节点的文字一个不动（否则接着打字会莫名当上子节点的爹）
    expect(nodeById(mind, 'n_丁')?.text).toBe('丁');
  });

  it('光标越界会夹进来：`-5` 当 0（前半截为空 ⇒ 上面多一个空节点）、`99` 当末尾', () => {
    const head = file();
    expect(splitNodeAt(head, 'n_甲乙丙', -5)).toBe('n_甲乙丙');
    expect(childrenOf(head, 'n_中心').map((node) => node.text)).toEqual(['', '甲乙丙', '丁']);

    const tail = file();
    const created = splitNodeAt(tail, 'n_甲乙丙', 99);
    expect(created).not.toBe('n_甲乙丙');
  });

  it('★ 空行回车：它是最末的叶子 ⇒ **提升一级**（幕布规则③，= 取消缩进）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
      ['', '甲'],
    ]);
    const target = splitNodeAt(mind, 'n_', 0);
    expect(target).toBe('n_'); // 还是编辑它自己
    expect(nodeById(mind, 'n_')?.parentId).toBe('n_中心'); // 升到父节点的同级
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '']);
  });

  it('根 / 不存在的节点 ⇒ `null`', () => {
    expect(splitNodeAt(file(), 'n_中心', 1)).toBeNull();
    expect(splitNodeAt(file(), 'n_幽灵', 1)).toBeNull();
  });
});

describe('末尾回车 · 幕布三条规则（`enterAtEnd`，`N3-i`）', () => {
  it('① 叶子节点 ⇒ 下方新建一个**同级**', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
    ]);
    const created = enterAtEnd(mind, 'n_甲');
    expect(created).not.toBeNull();
    expect(nodeById(mind, created ?? '')?.parentId).toBe('n_中心');
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '', '乙']);
  });

  it('① 收起状态（有子节点但收着）⇒ 也是**新建同级**，子节点一个不动', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
      ['乙', '中心'],
    ]);
    const node = nodeById(mind, 'n_甲');
    if (node) node.collapsed = true;

    const created = enterAtEnd(mind, 'n_甲');
    expect(nodeById(mind, created ?? '')?.parentId).toBe('n_中心');
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '', '乙']);
    expect(childrenOf(mind, 'n_甲').map((node) => node.id)).toEqual(['n_甲1']);
  });

  it('② 展开状态 ⇒ 给自己建一个空子节点，且排在**第一个**', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
      ['甲2', '甲'],
    ]);
    const created = enterAtEnd(mind, 'n_甲');
    expect(nodeById(mind, created ?? '')?.parentId).toBe('n_甲');
    expect(childrenOf(mind, 'n_甲').map((node) => node.id)).toEqual([created, 'n_甲1', 'n_甲2']);
  });

  it('★ ③ 空叶子 + 最末 ⇒ **提升一级**（取消缩进）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
      ['', '甲'],
    ]);
    expect(enterAtEnd(mind, 'n_')).toBe('n_');
    expect(nodeById(mind, 'n_')?.parentId).toBe('n_中心');
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '']);
  });

  it('★★ ③ 提升不动时（父节点就是中心主题）⇒ **退回规则 ①**，不留下"按了没反应"', () => {
    // 用户报的场景：给**中心主题**新建一个子节点（空的、最末）⇒ 再回车
    // 从前 `promote` 返回 false 而 `enterAtEnd` 照样返回原节点 ⇒ 按了等于没按
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['', '中心'],
    ]);

    const created = enterAtEnd(mind, 'n_');

    expect(created).not.toBeNull();
    expect(created).not.toBe('n_'); // 关键：不再返回"原节点"（那等于什么都没做）
    expect(nodeById(mind, created ?? '')?.parentId).toBe('n_中心');
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '', '']);
    // 原节点原地不动
    expect(nodeById(mind, 'n_')?.parentId).toBe('n_中心');
  });

  it('③ 的两个例外：**不空** / **不在最末** ⇒ 都回落到"新建同级"', () => {
    const notEmpty = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
      ['有字', '甲'],
    ]);
    const created = enterAtEnd(notEmpty, 'n_有字');
    expect(nodeById(notEmpty, created ?? '')?.parentId).toBe('n_甲');

    const notLast = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['', '甲'],
      ['甲2', '甲'],
    ]);
    const sibling = enterAtEnd(notLast, 'n_');
    expect(nodeById(notLast, sibling ?? '')?.parentId).toBe('n_甲');
  });

  it('根 / 不存在 ⇒ `null`', () => {
    expect(enterAtEnd(mindWith([['中心', null]]), 'n_中心')).toBeNull();
    expect(enterAtEnd(mindWith([['中心', null]]), 'n_幽灵')).toBeNull();
  });

  it('★ `addChild` 能插到**开头**（`{ index: 0 }`，规则②用的就是它）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
    ]);
    const created = addChild(mind, 'n_中心', { index: 0 });
    expect(childrenOf(mind, 'n_中心').map((node) => node.id)).toEqual([created, 'n_甲', 'n_乙']);
  });
});

describe('`Tab` 缩进（`indent`，`N3-i`）', () => {
  const file = () =>
    mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
      ['乙', '中心'],
      ['乙1', '乙'],
      ['丙', '中心'],
    ]);

  it('★ 变成**上一个兄弟的最后一个子节点**', () => {
    const mind = file();
    expect(indent(mind, 'n_丙')).toBe(true);

    expect(nodeById(mind, 'n_丙')?.parentId).toBe('n_乙');
    expect(childrenOf(mind, 'n_中心').map((node) => node.text)).toEqual(['甲', '乙']);
    expect(childrenOf(mind, 'n_乙').map((node) => node.text)).toEqual(['乙1', '丙']);
  });

  it('★ 自己带着的那一支一起进去（不是只挪这一行）', () => {
    const mind = file();
    expect(indent(mind, 'n_乙')).toBe(true);

    // 乙1 的父没变 ⇒ 跟着 乙 一起搬过去了
    expect(nodeById(mind, 'n_乙1')?.parentId).toBe('n_乙');
    expect(childrenOf(mind, 'n_甲').map((node) => node.text)).toEqual(['甲1', '乙']);
  });

  it('第一个孩子没有上一个兄弟 ⇒ `false`（退无可退，与 `promote` 那条对称）', () => {
    expect(indent(file(), 'n_甲')).toBe(false);
  });

  it('根 / 不存在的节点 ⇒ `false`', () => {
    expect(indent(file(), 'n_中心')).toBe(false);
    expect(indent(file(), 'n_幽灵')).toBe(false);
  });
});

describe('完成 / 取消完成（`setDone`，`N3-g`）', () => {
  const withNode = () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
    ]);
    return { mind, id: 'n_甲' };
  };

  it('★ 设完成 ⇒ 写 `true`；取消 ⇒ **删键**（缺席 = 未完成；纪律 2）', () => {
    const { mind, id } = withNode();

    expect(setDone(mind, id, true)).toBe(true);
    expect(nodeById(mind, id)?.done).toBe(true);
    // 值没变 ⇒ `false`（不写盘、不占撤销栈）
    expect(setDone(mind, id, true)).toBe(false);
    expect(setDone(mind, id, false)).toBe(true);
    expect('done' in (nodeById(mind, id) ?? {})).toBe(false);
  });

  it('★ 只改**这一个**节点：子孙一位都不动（"整支变淡"是渲染层看出来的）', () => {
    const { mind, id } = withNode();
    setDone(mind, id, true);

    // 取消的时候才不会把子孙里本来完成过的那些弄丢 —— 因为它们压根没被改过
    expect(nodeById(mind, 'n_甲1')?.done).toBeUndefined();
    setDone(mind, id, false);
    expect(nodeById(mind, 'n_甲1')?.done).toBeUndefined();
  });

  it('节点不存在 ⇒ `false`', () => {
    const { mind } = withNode();
    expect(setDone(mind, 'n_幽灵', true)).toBe(false);
  });
});

describe('折叠所有 / 展开所有（`setCollapsedFromDepth`，飞书口径）', () => {
  /** 中心 → 甲 → 甲一；根下面还有个叶子乙 */
  const build = (): MindFile => {
    const file = createMindFile({ title: 'T', now: () => 'T' });
    file.nodes = [
      createMindNode({ id: 'n_root', text: '中心', note: '', parentId: null, order: 0 }),
      createMindNode({ id: 'n_a', text: '甲', note: '', parentId: 'n_root', order: 0 }),
      createMindNode({ id: 'n_a1', text: '甲一', note: '', parentId: 'n_a', order: 0 }),
      createMindNode({ id: 'n_b', text: '乙', note: '', parentId: 'n_root', order: 1 }),
    ];
    file.rootId = 'n_root';
    return file;
  };
  const collapsedIds = (mind: MindFile): string[] =>
    mind.nodes.filter((node) => node.collapsed === true).map((node) => node.id);

  it('★ 折叠所有：**只留中心与第一层**（第一层及更深的、有孩子的都折上）', () => {
    const mind = build();
    expect(setCollapsedFromDepth(mind, 1, true)).toBe(true);

    // 根不折（第一层要露出来）；甲折上 ⇒ 它的孩子甲一藏起来
    expect(collapsedIds(mind)).toEqual(['n_a']);
  });

  it('叶子**不写** `collapsed`（折了没有可见效果，白写一个键）', () => {
    const mind = build();
    setCollapsedFromDepth(mind, 1, true);

    expect(collapsedIds(mind)).not.toContain('n_a1');
    expect(collapsedIds(mind)).not.toContain('n_b');
  });

  it('★ 再折一次是空操作（值没变给 `false`：不写盘、不占撤销栈）', () => {
    const mind = build();
    setCollapsedFromDepth(mind, 1, true);

    expect(setCollapsedFromDepth(mind, 1, true)).toBe(false);
  });

  it('展开所有：把 `collapsed` 键**删掉**（纪律 2，不是写 `false`）', () => {
    const mind = build();
    setCollapsedFromDepth(mind, 1, true);

    expect(setCollapsedFromDepth(mind, 1, false)).toBe(true);
    expect(mind.nodes.some((node) => 'collapsed' in node)).toBe(false);
  });

  it('本来就没折过 ⇒ 展开是空操作', () => {
    expect(setCollapsedFromDepth(build(), 1, false)).toBe(false);
  });
});

describe('整支总数（`subtreeSizes`）', () => {
  it('★ 子孙总数、**不含自己**（收起时圆圈里写的是"这一支藏了多少个"）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['甲一', '甲'],
      ['甲二', '甲'],
      ['乙', '中心'],
    ]);

    const sizes = subtreeSizes(mind);

    expect(sizes.get('n_中心')).toBe(4);
    expect(sizes.get('n_甲')).toBe(2);
    expect(sizes.get('n_甲一')).toBe(0);
    expect(sizes.get('n_乙')).toBe(0);
  });

  it('★ 悬浮节点的子树也数（它们不在根的子树里，得单独走一遍）', () => {
    const mind = mindWith([
      ['中心', null],
      ['自由', null],
      ['自由子', '自由'],
    ]);

    const sizes = subtreeSizes(mind);

    expect(sizes.get('n_中心')).toBe(0);
    expect(sizes.get('n_自由')).toBe(1);
  });

  it('空图（只有一个根）→ 根是 0', () => {
    expect(subtreeSizes(mindWith([['中心', null]])).get('n_中心')).toBe(0);
  });
});

describe('`renumberSiblings`', () => {
  it('已经连续时返回 `false`（不为没发生的事记账）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
      ['乙', '中心'],
    ]);

    expect(renumberSiblings(mind, 'n_中心')).toBe(false);
  });
});

// ── 撤销快照 ─────────────────────────────────────────────────

describe('撤销快照（`mind/model/history.ts`）', () => {
  it('★ 快照只有内容：改标题 / 视口 / revision **都不会**被撤销回滚', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const before = serializeMindContent(mind);

    mind.meta.title = '新标题';
    mind.view = { ...mind.view, x: 999 };
    mind.revision = 42;

    expect(restoreMindContent(mind, before)).toBe(true);
    expect(mind.meta.title).toBe('新标题');
    expect(mind.view.x).toBe(999);
    expect(mind.revision).toBe(42);
  });

  it('★ 与 `HistoryStack` 合起来就是一次真正的撤销', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);
    const history = new HistoryStack();

    const before = serializeMindContent(mind);
    addChild(mind, 'n_甲');
    expect(mind.nodes).toHaveLength(3);
    history.submit({ label: '添加子节点', before, after: serializeMindContent(mind) });

    const entry = history.peekUndo();
    expect(entry).not.toBeNull();
    if (!entry) return;
    expect(restoreMindContent(mind, entry.before)).toBe(true);
    expect(mind.nodes.map((node) => node.text)).toEqual(['中心', '甲']);

    history.commitUndo();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    // 重做：写回 `after` 就是"再添加一次"
    expect(restoreMindContent(mind, entry.after)).toBe(true);
    expect(mind.nodes).toHaveLength(3);
  });

  it('坏快照**放弃**而不是写一半（`rootId` / `nodes` 任一不合格就整体不动）', () => {
    const mind = mindWith([['中心', null]]);
    const nodes = mind.nodes;

    expect(restoreMindContent(mind, '{ 不是 JSON')).toBe(false);
    expect(restoreMindContent(mind, '{"nodes":[]}')).toBe(false);
    expect(restoreMindContent(mind, '{"rootId":"x"}')).toBe(false);
    expect(mind.nodes).toBe(nodes);
    expect(mind.rootId).toBe('n_中心');
  });
});

describe('结构可读性（给自己看的）', () => {
  it('`structureOf` 列出全部节点（工具函数没坏）', () => {
    const mind = mindWith([
      ['中心', null],
      ['甲', '中心'],
    ]);

    expect(structureOf(mind)).toEqual(['中心(根/浮)', '甲']);
  });
});
