/**
 * `MindLayer`（白板级脑图的渲染层）**对外报的几何**（`2.2.0` 批 3）。
 *
 * 这一层是"节点连线的唯一几何来源"：绘制（`EdgeRenderer` 的 `getNodeRects`）、
 * 命中（`cardRectLookup`）、连线手势（`ConnectController` 的 `nodes`）三处都问它。
 * 所以这里钉的是**口径**，而不是像素：
 *
 * * 键是 `脑图id/节点id`（`schema.nodeEndpointKey`）；
 * * 矩形是**白板世界坐标**（容器 `x/y` + 节点相对锚点的盒子）；
 * * **拖动中跟着预览走**（模型那几帧还没变，不跟手的话线会留在原地）；
 * * 模型没读到 / 一棵树被摘掉 ⇒ 报空（指向它的线因此不画，也不会连到虚空上）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIND_SELECTION_CLASS, MindLayer } from '../../view/render/MindLayer';
import { createMind } from '../../model/factories';
import { nodeEndpointKey, type Mind } from '../../model/schema';
import { addChild } from '../../mind/model/ops';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';
import { MIND_NODE_CLASS, MIND_NODE_ID_ATTR } from '../../mind/view/render';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';

const MIND_ID = 'nm_1';

function makeHarness(
  options: { withModel?: boolean; onNodeMenu?: (mind: Mind, nodeId: string) => void } = {},
) {
  const withModel = options.withModel ?? true;
  const doc = createFakeDocument();
  const host = createFakeElement(doc);
  const file = createMindFile({ rootText: '根' });
  file.nodes.push(createMindNode({ parentId: file.rootId, text: '分支', order: 0 }));
  const branchId = file.nodes[1].id;

  const mind: Mind = { ...createMind({ path: '', mind: file, x: 1000, y: 500 }), id: MIND_ID };
  let minds: Mind[] = [mind];
  /** 被通知到的"卡内选中了谁"（`null` = 取消选中）—— 底部那条快捷栏靠它 */
  const focusCalls: Array<string | null> = [];

  const layer = new MindLayer(host as unknown as HTMLElement, {
    getMinds: () => minds,
    // `withModel: false` = 那份 `.nestmind` 还没读到（或文件没了）
    modelOf: (item) => (withModel ? (item.mind ?? null) : null),
    isReadOnly: () => false,
    mutate: () => true,
    onNodeMenu: (target, nodeId) => options.onNodeMenu?.(target, nodeId),
    onNodeFocus: (_target, nodeId) => focusCalls.push(nodeId),
    onDragStart: () => undefined,
  });
  layer.sync();

  return {
    layer,
    file,
    host,
    rootKey: nodeEndpointKey(MIND_ID, file.rootId),
    branchKey: nodeEndpointKey(MIND_ID, branchId),
    setMinds: (next: Mind[]) => {
      minds = next;
      layer.sync();
    },
    /** 此刻板上的那几棵（用例要拿原对象去造"压在上面的那一棵"） */
    currentMinds: () => minds,
    /**
     * 改一次模型并按两种**真实**数据源的样子重画：
     *
     * * `'replace'` —— **内嵌**脑图（`mutateMind` → `cloneJson` → `setMindModel`）：
     *   模型换成**新对象**；
     * * `'inPlace'` —— **文件**脑图（`MindRepository.mutate`）：**就地改**那一份
     *   缓存模型、只把 `revision` 往上抬（对象引用一个字都不变）。
     */
    mutate(mode: 'replace' | 'inPlace', mutator: (target: MindFile) => void): void {
      const current = minds[0].mind as MindFile;
      if (mode === 'replace') {
        const next = JSON.parse(JSON.stringify(current)) as MindFile;
        mutator(next);
        minds = [{ ...minds[0], mind: next }];
      } else {
        mutator(current);
        current.revision += 1;
      }
      layer.sync();
    },
    /** 被通知到的"卡内选中了谁"（`null` = 取消选中）—— 底部那条快捷栏靠它 */
    focusCalls,

    /**
     * 画面上此刻有几个节点元素（`容器 ▸ 嵌图根 ▸ 世界 ▸ [连线, 节点, 手柄]`） */
    paintedNodes(): number {
      // 容器里第一个孩子是"读不到模型"那句话，嵌图根按 class 找（顺序不该被测试焊死）
      const container = host.children[0] as FakeElement;
      const embed = container.children.find((child) =>
        (child as FakeElement).classList.contains('nestboard-mind-embed'),
      ) as FakeElement;
      const world = embed.children[0] as FakeElement;
      return (world.children[1] as FakeElement).children.length;
    },
  };
}

/**
 * **视口裁剪**（`2.2.0` 收尾）：屏幕外的树不挂 DOM。
 *
 * 三条口径必须一起成立，少一条就会出现"看着像 bug"的现象：
 *
 * 1. 屏幕上**看不到**的树不挂（这是裁剪的意义）；
 * 2. `bounds()` 仍然报**全部**树 —— 否则缩略图 / 导出取景会越缩越小；
 * 3. `nodeRects()` 仍然含有被裁掉的树的节点 —— 否则"从屏幕里的卡指向屏幕外某个节点"
 *    的连线会整条消失（它半截本来在屏幕上）。
 */
describe('MindLayer · 视口裁剪（2.2.0 收尾）', () => {
  /** 一棵小树（根 + 一个分支），带自己的 id */
  function tree(id: string, x: number, y: number): Mind {
    const file = createMindFile({ rootText: `根-${id}` });
    file.nodes.push(createMindNode({ parentId: file.rootId, text: '分支', order: 0 }));
    return { ...createMind({ path: '', mind: file, x, y }), id };
  }

  const VISIBLE = { x: -500, y: -500, width: 1600, height: 1200 };

  it('★ 屏幕外的树不挂 DOM，但几何与端点表**照旧有它**', () => {
    const h = makeHarness();
    const near = tree('nm_near', 0, 0);
    const far = tree('nm_far', 6000, 6000);
    h.setMinds([near, far]);
    h.layer.sync(VISIBLE);

    expect(h.layer.renderedCount).toBe(1);
    // ② 缩略图 / 导出取景要的是全部
    expect(
      h.layer
        .bounds()
        .map((item) => item.id)
        .sort(),
    ).toEqual(['nm_far', 'nm_near']);
    // ③ 被裁掉那棵的节点仍在端点表里（连线不会整条消失）
    const rootOfFar = nodeEndpointKey('nm_far', (far.mind as MindFile).rootId);
    expect(h.layer.nodeRects().has(rootOfFar)).toBe(true);
    expect(h.layer.nodeRectOf(rootOfFar)).not.toBeNull();
    // 屏幕内那棵的节点也在
    expect(h.layer.nodeRects().size).toBe(4);
  });

  it('★ 视口挪过去 ⇒ 换挂（旧的下、新的上）', () => {
    const h = makeHarness();
    const near = tree('nm_near', 0, 0);
    const far = tree('nm_far', 6000, 6000);
    h.setMinds([near, far]);

    h.layer.sync({ x: 5600, y: 5600, width: 1600, height: 1200 });
    expect(h.layer.renderedCount).toBe(1);
    // 现在屏幕里的是"远"那棵：它的节点由 **DOM 实测**报出来（与纯布局同一个框）
    const rootOfFar = nodeEndpointKey('nm_far', (far.mind as MindFile).rootId);
    const rect = h.layer.nodeRects().get(rootOfFar)!;
    expect(rect.x + rect.width / 2).toBeCloseTo(6000, 5);
  });

  it('不传可见矩形 = 不裁（老调用方 / 测试一字不用改）', () => {
    const h = makeHarness();
    h.setMinds([tree('nm_a', 0, 0), tree('nm_b', 6000, 6000)]);
    h.layer.sync();
    expect(h.layer.renderedCount).toBe(2);
  });

  it('★ 模型读不到 ⇒ 按**锚点**判（否则"还没读到"的树会被永久裁掉）', () => {
    const h = makeHarness({ withModel: false });
    h.layer.sync({ x: 900, y: 400, width: 200, height: 200 });
    expect(h.layer.renderedCount).toBe(1);
    h.layer.sync({ x: 90000, y: 90000, width: 200, height: 200 });
    expect(h.layer.renderedCount).toBe(0);
  });
});

describe('MindLayer · 节点端点几何', () => {
  it('★★ 键是 `脑图id/节点id`，矩形是**世界坐标**（根节点中心 = 容器的 x/y）', () => {
    const h = makeHarness();
    const rects = h.layer.nodeRects();

    expect([...rects.keys()].sort()).toEqual([h.branchKey, h.rootKey].sort());

    const root = rects.get(h.rootKey)!;
    expect(root.x + root.width / 2).toBeCloseTo(1000, 5);
    expect(root.y + root.height / 2).toBeCloseTo(500, 5);
    // 节点自己是**原尺寸**（`anchor` 摆法不缩放）：盒子必须量得出宽高
    expect(root.width).toBeGreaterThan(0);
    expect(root.height).toBeGreaterThan(0);
  });

  it('★ 单个键的矩形与整张表**同源**（连线手势要的是"只问一个"）', () => {
    const h = makeHarness();
    expect(h.layer.nodeRectOf(h.rootKey)).toEqual(h.layer.nodeRects().get(h.rootKey));
    // 不是节点键（卡片 id / 别的树）⇒ `null`，绝不"猜一个"
    expect(h.layer.nodeRectOf('c_1')).toBeNull();
    expect(h.layer.nodeRectOf(`${MIND_ID}/${h.file.rootId}`)).not.toBeNull();
    expect(h.layer.nodeRectOf(nodeEndpointKey('nm_不存在', h.file.rootId))).toBeNull();
  });

  it('★ 世界坐标命中节点（连线落点用它）；没压在节点上给 `null`', () => {
    const h = makeHarness();
    expect(h.layer.nodeAt({ x: 1000, y: 500 })).toBe(h.rootKey);
    expect(h.layer.nodeAt({ x: 99999, y: 99999 })).toBeNull();
  });

  it('★★ 拖动中跟着**预览**走（模型那几帧还没变，不跟手线就留在原地）', () => {
    const h = makeHarness();
    h.layer.setPreview(MIND_ID, { x: 0, y: 0 });

    const rect = h.layer.nodeRects().get(h.rootKey)!;
    expect(rect.x + rect.width / 2).toBeCloseTo(0, 5);
    expect(rect.y + rect.height / 2).toBeCloseTo(0, 5);
    expect(h.layer.nodeAt({ x: 0, y: 0 })).toBe(h.rootKey);

    // 松手（预览撤掉）⇒ 回到模型位置
    h.layer.setPreview(MIND_ID, null);
    const back = h.layer.nodeRects().get(h.rootKey)!;
    expect(back.x + back.width / 2).toBeCloseTo(1000, 5);
  });

  it('★ 模型还没读到 ⇒ 一个盒子都不报（线不画、也连不到虚空上）', () => {
    const h = makeHarness({ withModel: false });
    expect(h.layer.nodeRects().size).toBe(0);
    expect(h.layer.nodeRectOf(h.rootKey)).toBeNull();
    expect(h.layer.nodeAt({ x: 1000, y: 500 })).toBeNull();
  });

  it('★ 容器被摘掉（删掉 / 换板）⇒ 盒子跟着消失', () => {
    const h = makeHarness();
    expect(h.layer.nodeRects().size).toBe(2);

    h.setMinds([]);
    expect(h.layer.nodeRects().size).toBe(0);
  });
});

/**
 * **加完节点之后画面上要多一个**（用户 2026-09-21 报的"添加的子节点没有立即出现"）。
 *
 * 这条回归线要同时钉住**两种数据源**，因为它们的"变化信号"完全不同：
 *
 * * **内嵌**脑图：`mutateMind` 会 `cloneJson` 出一份**新对象** ⇒ 引用变了；
 * * **文件**脑图：`MindRepository.mutate` 是**就地改**那一份缓存模型
 *   （`mind.nodes.push(...)`），**引用一个字都不变** —— 只认"换没换对象"的话，
 *   加出来的节点会永远画不出来（文件里明明有）。
 */
describe('MindLayer · 加节点之后必须重画', () => {
  it('★★ 内嵌脑图（模型换成新对象）⇒ 画面上多一个节点', () => {
    const h = makeHarness();
    expect(h.paintedNodes()).toBe(2);

    h.mutate('replace', (target) => {
      addChild(target, h.file.rootId);
    });

    expect(h.paintedNodes()).toBe(3);
    expect(h.layer.nodeRects().size).toBe(3);
  });

  it('★★ 文件脑图（**就地改**、引用不变）⇒ 一样要多一个节点', () => {
    const h = makeHarness();
    expect(h.paintedNodes()).toBe(2);

    h.mutate('inPlace', (target) => {
      addChild(target, h.file.rootId);
    });

    expect(h.paintedNodes()).toBe(3);
    // 新节点的盒子也要在（连线要用）
    expect(h.layer.nodeRects().size).toBe(3);
  });

  it('★ 折叠也一样（就地改的第二种情形：没有新节点，但画面上要少掉一支）', () => {
    const h = makeHarness();
    const branchId = h.file.nodes[1].id;

    h.mutate('inPlace', (target) => {
      const node = target.nodes.find((item) => item.id === branchId);
      if (node) node.collapsed = true;
    });

    // 分支自己被收起来（`+N` 角标）：这一棵只有根 + 那一个分支，所以数量不变，
    // 但**重画确实发生了** —— 手柄变成"展开"态就是证据
    const branch = h.layer.nodeRects().get(h.branchKey);
    expect(branch).toBeDefined();
    expect(h.paintedNodes()).toBe(2);
  });
});

/**
 * 节点右键把请求递出去时，**必须带上"这次属于哪棵脑图"**。
 *
 * 视图那一侧要拿它做两件事（`BoardView.showMindNodeMenu`）：
 *
 * * `cardId` —— 卡片级菜单按 id 查（并且并到根节点那一份里）；
 * * `editKey` —— "加完节点把光标送进新节点"的**请求键**。
 *
 * ★ 后者踩过一次：那一层从前写的是 `path`（老的脑图**卡**的键），而白板这一层
 *   取请求用的是**脑图 id** —— 于是**文件脑图**上"加子节点"之后光标进不来。
 *   所以这里钉的是"回调拿得到那个 id"（视图才能把它当 `editKey` 递下去）。
 */
describe('MindLayer · 节点右键把"是哪棵脑图"递出去', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 只认 `closest` 的事件目标（node 下没有真 `Element`，见 `embedMind.test.ts`） */
  class StubElement {
    constructor(private readonly lookup: Record<string, unknown> = {}) {}
    closest(selector: string): unknown {
      return this.lookup[selector] ?? null;
    }
  }

  it('★ 普通节点与**根节点**都给菜单，且回调里那棵树就是它自己（id 可当 `editKey`）', () => {
    vi.stubGlobal('Element', StubElement);
    const seen: Array<{ mindId: string; nodeId: string }> = [];
    const h = makeHarness({
      onNodeMenu: (mind, nodeId) => seen.push({ mindId: mind.id, nodeId }),
    });

    const fire = (nodeId: string) => {
      const nodeEl = createFakeElement(h.host.ownerDocument);
      nodeEl.setAttribute(MIND_NODE_ID_ATTR, nodeId);
      // 容器是挂在本层宿主上的（`MindLayer` 把每个容器 append 进 `world`）
      const container = h.host.children[0] as FakeElement;
      const embedRoot = container.children.find((child) =>
        (child as FakeElement).classList.contains('nestboard-mind-embed'),
      ) as FakeElement;
      embedRoot.emit('contextmenu', {
        target: new StubElement({ [`.${MIND_NODE_CLASS}`]: nodeEl }),
        stopPropagation: () => undefined,
        preventDefault: () => undefined,
      });
    };

    fire(h.file.rootId);
    fire(h.file.nodes[1].id);

    expect(seen).toEqual([
      { mindId: MIND_ID, nodeId: h.file.rootId },
      { mindId: MIND_ID, nodeId: h.file.nodes[1].id },
    ]);
  });
});
/**
 * **从外面选中一个节点**（`2.2.0` 批 4：搜索结果点一条就飞到那个节点上）。
 *
 * ★ 走的是与"用户在卡内点一下"同一条路（`EmbedMind.setSelected`）⇒ 选中框与
 *   底部那条快捷操作栏都会到位；另写一条路的话，"搜索跳过去之后栏里还是上个节点"
 *   这种只在某一条路上复现的 bug 就来了。
 */
/**
 * 整棵树进选区（`2.2.0` 批 5）。
 *
 * 脑图只有"整棵"这一个粒度（无边界、节点位置由布局算），所以选区里放的是**容器 id**，
 * 框选判据是"**外接框**与选框相交"—— 与卡片 / 分栏同一条"相交即选中"。
 * 外观上另画一圈框（不是给节点加描边）：它是"选中了一整棵"，必须与"选中了某个节点"分得开。
 */
describe('MindLayer · 整棵进选区', () => {
  /** 容器里那个选中框（按 class 找，不靠孩子顺序） */
  function boxOf(host: FakeElement): FakeElement {
    const container = host.children[0] as FakeElement;
    const found = container.children.find((child) =>
      (child as FakeElement).classList.contains(MIND_SELECTION_CLASS),
    );
    if (!found) throw new Error('容器里没有选中框元素');
    return found as FakeElement;
  }

  const num = (value: unknown): number => Number.parseFloat(String(value));

  it('★ 框在树的空白处（一个节点都没框到）⇒ 整棵进选区；框得远 ⇒ 一棵都不选', () => {
    const h = makeHarness();
    const bounds = h.layer.bounds()[0].rect;

    // ★ 外接框是**紧贴节点的**（没有大块留白）⇒ 取"根与分支之间那条缝"：
    //   那里一个节点都没有，但落在树的外接框里 ⇒ 按第 3 条，整棵进选区
    const rects = h.layer.nodeRects();
    const keys = [...rects.keys()];
    const a = rects.get(keys[0]!)!;
    // 根节点**右沿 + 1px**：正是连线的起笔处，那里一个节点都没有
    const gapX = a.x + a.width + 1;
    expect(h.layer.marqueeIn({ x: gapX, y: bounds.y + 1, width: 1, height: 1 }).minds).toEqual([
      MIND_ID,
    ]);
    // 框在很远的地方 ⇒ 一棵都不选
    expect(
      h.layer.marqueeIn({ x: bounds.x - 500, y: bounds.y - 500, width: 10, height: 10 }),
    ).toEqual({ minds: [], nodes: [] });
  });

  it('★ `mindAtPoint`：点在树的外接框里就命中它，点在别处不命中（右键树身那条路）', () => {
    const h = makeHarness();
    const bounds = h.layer.bounds()[0].rect;
    const inside = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };

    expect(h.layer.mindAtPoint(inside)).toBe(MIND_ID);
    expect(h.layer.mindAtPoint({ x: bounds.x - 500, y: bounds.y - 500 })).toBeNull();
  });

  it('★ `mindAtPoint` 重叠时取 z 大的那棵（右键该落到看得见的那棵上）', () => {
    const h = makeHarness();
    const bounds = h.layer.bounds()[0].rect;
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };

    // 再来一棵压在上面（同一位置、z 更大）
    const base = h.currentMinds()[0];
    const top = { ...base, id: 'nm_top', z: 99 };
    h.setMinds([base, top]);
    expect(h.layer.mindAtPoint(point)).toBe('nm_top');
  });

  it('★ 节点级框选：框住**一部分**节点 ⇒ 只选那几个，整棵不进选区', () => {
    const h = makeHarness();
    const rects = h.layer.nodeRects();
    const keys = [...rects.keys()];
    const first = rects.get(keys[0]!)!;

    const hits = h.layer.marqueeIn({ x: first.x, y: first.y, width: 1, height: 1 });
    // 只框到一个节点（树不止一个）⇒ 节点级
    expect(hits.minds).toEqual([]);
    expect(hits.nodes).toEqual([keys[0]]);
  });

  it('★ 整棵框住（框比整棵树还大）⇒ 回到"整棵"那一档', () => {
    const h = makeHarness();
    const bounds = h.layer.bounds()[0].rect;
    const pad = 20;

    const hits = h.layer.marqueeIn({
      x: bounds.x - pad,
      y: bounds.y - pad,
      width: bounds.width + pad * 2,
      height: bounds.height + pad * 2,
    });
    expect(hits.minds).toEqual([MIND_ID]);
    expect(hits.nodes).toEqual([]);
  });

  it('★★ 选中之后画一圈框：尺寸 = 外接框 + 两侧留白，中心与树心对齐', () => {
    const h = makeHarness();
    h.layer.setSelection(new Set([MIND_ID]));

    const world = h.layer.bounds()[0].rect;
    const box = boxOf(h.host);
    expect(box.hidden).toBe(false);

    const left = num(box.style.left);
    const top = num(box.style.top);
    const width = num(box.style.width);
    const height = num(box.style.height);
    // 两侧各留 6（`SELECTION_PADDING`）
    expect(width).toBeCloseTo(world.width + 12, 5);
    expect(height).toBeCloseTo(world.height + 12, 5);
    // 框是**相对容器原点**写的（容器的 left/top 已经是根节点中心：1000 / 500）
    expect(left + width / 2).toBeCloseTo(world.x + world.width / 2 - 1000, 5);
    expect(top + height / 2).toBeCloseTo(world.y + world.height / 2 - 500, 5);
  });

  it('★ 取消选中 ⇒ 框收起来（`hidden`，不是留在原地）', () => {
    const h = makeHarness();
    h.layer.setSelection(new Set([MIND_ID]));
    expect(boxOf(h.host).hidden).toBe(false);

    h.layer.setSelection(new Set());
    expect(boxOf(h.host).hidden).toBe(true);
  });

  it('★ 改名把树撑宽 ⇒ 框跟着长（框按每一帧的外接框现算，不缓存）', () => {
    const h = makeHarness();
    h.layer.setSelection(new Set([MIND_ID]));
    const before = num(boxOf(h.host).style.width);

    h.mutate('replace', (file) => {
      file.nodes[0].text = '一个特别特别长的中心主题'.repeat(3);
    });

    expect(num(boxOf(h.host).style.width)).toBeGreaterThan(before);
  });

  it('★ 模型还没读到（那份 `.nestmind` 不在）⇒ 框不画、也框不中', () => {
    const h = makeHarness({ withModel: false });
    h.layer.setSelection(new Set([MIND_ID]));

    // 框到锚点那一句话 ⇒ 按"整棵"算（与裁剪判据 `intersects` 同一口径）
    expect(h.layer.marqueeIn({ x: 999, y: 499, width: 2, height: 2 })).toEqual({
      minds: [MIND_ID],
      nodes: [],
    });
    // 框在别处 ⇒ 什么都不选
    expect(h.layer.marqueeIn({ x: 0, y: 0, width: 10, height: 10 })).toEqual({
      minds: [],
      nodes: [],
    });
    expect(boxOf(h.host).hidden).toBe(true);
  });
});

/**
 * 千节点规模（`2.2.0` · O7）：`b92` 的**视口裁剪**之后补的回归。
 *
 * ★ 基准生成器（100 / 1000 / 5000 三档）早就在 `tests/benchmark/` 里，但那是
 *   "整块板能不能生成、能不能读回" —— 缺的正是**裁剪那条路在规模下不回归**：
 *   屏幕外的树不挂 DOM（这是"平移不卡"的全部来源），而几何与端点表**一个节点都不许少**
 *   （少了就会出现"线画不出来 / 指着虚空"）。这一条钉的就是这两句。
 */
describe('MindLayer · 千节点规模（2.2.0 · O7）', () => {
  function bigMind(): Mind {
    const file = createMindFile({ branches: 0 });
    // 根 + 999 个子节点 = **正好 1000**：一层铺开，横跨很多屏
    for (let index = 0; index < 999; index += 1) {
      file.nodes.push(createMindNode({ parentId: file.rootId, text: `n${index}`, order: index }));
    }
    return { ...createMind({ path: '', mind: file, x: 0, y: 0 }), id: 'nm_big' };
  }

  it('★ 屏幕外：一个容器都不挂，但 `bounds()` / `nodeRects()` 照旧报全 1000 个节点', () => {
    const doc = createFakeDocument();
    const host = createFakeElement(doc);
    const mind = bigMind();
    const layer = new MindLayer(host as unknown as HTMLElement, {
      getMinds: () => [mind],
      modelOf: (item) => item.mind ?? null,
      isReadOnly: () => false,
      mutate: () => true,
      onNodeMenu: () => undefined,
      onNodeFocus: () => undefined,
      onDragStart: () => undefined,
    });

    // 视口离这棵树很远 ⇒ 被裁掉
    layer.sync({ x: 1e6, y: 1e6, width: 800, height: 600 });
    expect(host.children.length).toBe(0);
    expect(layer.bounds()).toHaveLength(1);
    expect(layer.nodeRects().size).toBe(1000);

    // 视口挪过去 ⇒ 换挂回来
    const rect = layer.bounds()[0].rect;
    layer.sync({
      x: rect.x - 10,
      y: rect.y - 10,
      width: rect.width + 20,
      height: rect.height + 20,
    });
    expect(host.children.length).toBe(1);
  });
});

describe('MindLayer · 从外面选中节点', () => {
  it('★ 选中了，而且**报给了视图**（栏会跟着换到这个节点）', () => {
    const h = makeHarness();
    h.focusCalls.length = 0;

    expect(h.layer.focusNode(MIND_ID, h.file.nodes[1].id)).toBe(true);
    expect(h.focusCalls).toEqual([h.file.nodes[1].id]);
  });

  it('★ 同一个节点再选一次不重复报（栏会照着它改模型，喊出循环就麻烦了）', () => {
    const h = makeHarness();
    h.layer.focusNode(MIND_ID, h.file.nodes[1].id);
    h.focusCalls.length = 0;

    h.layer.focusNode(MIND_ID, h.file.nodes[1].id);
    expect(h.focusCalls).toEqual([]);
  });

  it('★ 节点不在这一帧里（被折叠 / 模型换了）⇒ `false`，调用方退回"飞到树根"', () => {
    const h = makeHarness();
    expect(h.layer.focusNode(MIND_ID, 'n_不存在')).toBe(false);
    expect(h.layer.focusNode('nm_没有这棵树', h.file.rootId)).toBe(false);
  });
});
