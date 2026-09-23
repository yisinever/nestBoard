/**
 * 卡内嵌脑图（`EmbedMind`）**手势契约**的回归测试（`F4` 手工验收，2026-09-21）。
 *
 * 只钉用户当次报的那两条**规则**（渲染几何照旧在真环境里验）：
 *
 * 1. **根节点也是一个节点**：点它能选中；但 `pointerdown` **不拦** ——
 *    从根上按住拖仍然是"拖整张卡"（`F3b` 那条手势不能丢）。
 * 2. **双击根节点 = 就地改名**（不再是"打开这份脑图"）；只有"改不了"（只读 / 没有写回口）
 *    时才退回打开。双击**空白**照样打开。
 *
 * ★ 事件目标是自己造的（`{ closest }`）：假 DOM 的元素没有 `closest`、node 下也没有
 *   `Element` 全局，所以这里把 `Element` 换成一个只认 `closest` 的替身，
 *   让 `target instanceof Element` 这道闸门照常成立（真浏览器里它当然是真 `Element`）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedMind } from '../../mind/view/EmbedMind';
import { MIND_HANDLE_ATTR, MIND_NODE_CLASS, MIND_NODE_ID_ATTR } from '../../mind/view/render';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';

/** 只认 `closest` 的事件目标（见文件头那条） */
class StubElement {
  constructor(private readonly lookup: Record<string, unknown> = {}) {}

  closest(selector: string): unknown {
    return this.lookup[selector] ?? null;
  }
}

interface Harness {
  host: FakeElement;
  embed: EmbedMind;
  /** 写回口（`mutate`）：手柄那次应当走它 */
  mutate: ReturnType<typeof vi.fn>;
  rootId: string;
  childId: string;
  nodeLayer: FakeElement;
  /** `onSelect` 的每一次调用（`null` 也在里面 —— 那是"卡内不再选中任何节点"） */
  selects: Array<string | null>;
  /** 换一份模型重画（用来模拟"节点被删掉之后那一次重画"） */
  update(mind: ReturnType<typeof createMindFile>): void;
  /** 某个节点那个元素（按 `data-node-id` 找） */
  nodeEl(nodeId: string): FakeElement;
  pointerDown(target: unknown): { stopPropagation: ReturnType<typeof vi.fn> };
  doubleClick(target: unknown): { stopPropagation: ReturnType<typeof vi.fn> };
}

function makeHarness(options: { readOnly?: boolean; onOpen?: () => void } = {}): Harness {
  // node 下没有 `Element`：换成只认 `closest` 的替身，让那道闸门照常成立（见文件头）
  vi.stubGlobal('Element', StubElement);
  const doc = createFakeDocument();
  const host = createFakeElement(doc);
  const file = createMindFile({ rootText: '中心主题' });
  file.nodes.push(createMindNode({ parentId: file.rootId, text: '分支甲', order: 0 }));
  const mutate = vi.fn(() => true);
  const selects: Array<string | null> = [];

  const embed = new EmbedMind({
    doc: doc as unknown as Document,
    host: host as unknown as HTMLElement,
    mind: file,
    readOnly: options.readOnly,
    mutate: options.readOnly ? undefined : mutate,
    onOpen: options.onOpen,
    // 卡内选中变了（`F4`：底部那条快捷操作栏靠它）
    onSelect: (nodeId) => selects.push(nodeId),
  });

  // 结构：host ▸ 嵌图根 ▸ 世界 ▸ [连线层, 节点层, 手柄层]
  const world = (host.children[0] as FakeElement).children[0] as FakeElement;
  const nodeLayer = world.children[1] as FakeElement;

  const nodeEl = (nodeId: string): FakeElement => {
    const found = nodeLayer.children.find(
      (child) => (child as FakeElement).getAttribute(MIND_NODE_ID_ATTR) === nodeId,
    );
    if (!found) throw new Error(`没有这个节点：${nodeId}`);
    return found as FakeElement;
  };

  const fire = (type: 'pointerdown' | 'dblclick', target: unknown) => {
    const stopPropagation = vi.fn();
    (host.children[0] as FakeElement).emit(type, {
      target,
      stopPropagation,
      preventDefault: vi.fn(),
    });
    return { stopPropagation };
  };

  return {
    host,
    embed,
    mutate,
    rootId: file.rootId,
    childId: file.nodes[1].id,
    nodeLayer,
    selects,
    update: (mind) => embed.update(mind),
    nodeEl,
    pointerDown: (target) => fire('pointerdown', target),
    doubleClick: (target) => fire('dblclick', target),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('嵌图手势 · 根节点与普通节点一视同仁（F4 手工验收）', () => {
  it('★ 点**普通节点**：选中，而且这一下不冒泡（否则就成了"按住卡片拖动"）', () => {
    const h = makeHarness();
    const el = h.nodeEl(h.childId);

    const { stopPropagation } = h.pointerDown(new StubElement({ [`.${MIND_NODE_CLASS}`]: el }));

    expect(el.classList.contains('is-selected')).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('★★ 点**根节点**：同样选中，但这一下**放行**（"从根上按住拖 = 拖整张卡"没丢）', () => {
    const h = makeHarness();
    const el = h.nodeEl(h.rootId);

    const { stopPropagation } = h.pointerDown(new StubElement({ [`.${MIND_NODE_CLASS}`]: el }));

    expect(el.classList.contains('is-selected')).toBe(true);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it('手柄上的按下仍然是"折叠 / 展开"，且不冒泡（这条不能被根节点那次改动碰坏）', () => {
    const h = makeHarness();
    const handleEl = createFakeElement(h.nodeEl(h.rootId).ownerDocument);
    handleEl.setAttribute(MIND_HANDLE_ATTR, h.rootId);

    const { stopPropagation } = h.pointerDown(
      new StubElement({ [`[${MIND_HANDLE_ATTR}]`]: handleEl }),
    );

    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalled();
    // 手柄那一下**不该**顺带把节点选上（它是"折叠"这个动作，不是"选中"）
    expect(h.nodeEl(h.rootId).classList.contains('is-selected')).toBe(false);
  });
});

/**
 * `F4` 的第二条手工验收（用户 2026-09-21）："点击脑图节点，在画布上，底部也可以出现
 * 对应节点的快捷操作栏" —— 那条栏靠 `onSelect` 这一路才知道"现在是谁"。
 */
describe('嵌图手势 · 选中哪个节点要说出去（`onSelect`）', () => {
  it('点普通节点 → 报这个节点；点根节点 → 也报它（根也是节点）', () => {
    const h = makeHarness();

    h.pointerDown(new StubElement({ [`.${MIND_NODE_CLASS}`]: h.nodeEl(h.childId) }));
    h.pointerDown(new StubElement({ [`.${MIND_NODE_CLASS}`]: h.nodeEl(h.rootId) }));

    expect(h.selects).toEqual([h.childId, h.rootId]);
  });

  it('★ 同一个节点再点一次**不再喊**（栏会照着它改模型，喊出循环就麻烦了）', () => {
    const h = makeHarness();
    const target = () => new StubElement({ [`.${MIND_NODE_CLASS}`]: h.nodeEl(h.childId) });

    h.pointerDown(target());
    h.pointerDown(target());

    expect(h.selects).toEqual([h.childId]);
  });

  it('★ 选中的那个节点在重画后不在了（被删 / 被折叠）⇒ 报一次 `null`（栏该收起）', () => {
    const h = makeHarness();
    h.pointerDown(new StubElement({ [`.${MIND_NODE_CLASS}`]: h.nodeEl(h.childId) }));

    // 这份模型里没有 `childId` 了（模拟"它被删掉了"）
    const next = createMindFile({ rootText: '中心主题' });
    h.update(next);

    expect(h.selects).toEqual([h.childId, null]);
  });
});

/**
 * `F4` 的第三条手工验收（用户 2026-09-21）："……不断地增加节点，会让整个脑图的所有节点
 * 都缩小。应该是无论如何增加节点，脑图中节点尺寸不用相对白板等比缩小。"
 *
 * 修法：卡面装不下时**卡片长大**（`onRequiredSize` → 视图 `growTo`），不是把图缩小。
 */
describe('嵌图 · 装不下就长大卡片（不是缩小节点）', () => {
  /** 建一棵带一个分支的小脑图 */
  function smallMind() {
    const file = createMindFile({ rootText: '中心主题' });
    file.nodes.push(createMindNode({ parentId: file.rootId, text: '分支甲', order: 0 }));
    return file;
  }

  /** 造一个"有尺寸"的假宿主（假 DOM 的普通元素没有 `clientWidth/Height`） */
  function hostOf(doc: ReturnType<typeof createFakeDocument>, width: number, height: number) {
    const host = createFakeElement(doc);
    Object.assign(host, { clientWidth: width, clientHeight: height });
    return host as unknown as HTMLElement;
  }

  it('★ 卡面太小 ⇒ 报出"需要多大"', () => {
    const doc = createFakeDocument();
    const required = vi.fn();

    new EmbedMind({
      doc: doc as unknown as Document,
      host: hostOf(doc, 200, 120),
      mind: smallMind(),
      mutate: () => true,
      onRequiredSize: required,
    });

    expect(required).toHaveBeenCalledTimes(1);
    const need = required.mock.calls[0][0] as { width: number; height: number };
    // 整张图（根 + 一个分支）+ 四周留白，一定比 200 宽
    expect(need.width).toBeGreaterThan(200);
    expect(need.height).toBeGreaterThan(0);
  });

  it('卡面本来就够大 ⇒ 一个字都不报（节点 1:1，卡片不必长）', () => {
    const doc = createFakeDocument();
    const required = vi.fn();

    new EmbedMind({
      doc: doc as unknown as Document,
      host: hostOf(doc, 4000, 3000),
      mind: smallMind(),
      mutate: () => true,
      onRequiredSize: required,
    });

    expect(required).not.toHaveBeenCalled();
  });

  it('★ 同一个需求不重复报（重画连着来几趟也只报一次）', () => {
    const doc = createFakeDocument();
    const required = vi.fn();
    const mind = smallMind();
    const embed = new EmbedMind({
      doc: doc as unknown as Document,
      host: hostOf(doc, 200, 120),
      mind,
      mutate: () => true,
      onRequiredSize: required,
    });

    embed.update(mind);
    embed.update(mind);

    expect(required).toHaveBeenCalledTimes(1);
  });
});

/**
 * `2.2.0` 的第三种摆法：**白板级脑图的锚点摆法**（`placement: 'anchor'`）。
 *
 * 卡内嵌图只能"缩着装进盒子里"；白板上的脑图没有盒子 —— 宿主是一个零尺寸锚点，
 * 世界容器只平移（把根节点中心对到原点），**一个像素都不缩放**。
 */
describe('嵌图 · `anchor` 摆法（白板级脑图）', () => {
  it('★★ 只平移、**不缩放**：根节点中心对准宿主原点', () => {
    const doc = createFakeDocument();
    const host = createFakeElement(doc);
    const file = createMindFile({ rootText: '中心主题' });
    file.nodes.push(createMindNode({ parentId: file.rootId, text: '分支甲', order: 0 }));

    const embed = new EmbedMind({
      doc: doc as unknown as Document,
      host: host as unknown as HTMLElement,
      mind: file,
      mutate: () => true,
      placement: 'anchor',
    });

    const world = (host.children[0] as FakeElement).children[0] as FakeElement;
    const transform = String(world.style.transform ?? '');
    expect(transform).toContain('translate(');
    // ★ 关键：**没有 `scale(`** —— "每加一个节点所有节点都缩小"那个问题在结构上不存在
    expect(transform).not.toContain('scale(');

    // 外接框是"相对宿主原点"的（白板那边适应内容 / 缩略图要用）：向右展开的树
    // ⇒ 左边界落在原点左侧（根节点自己占半格）
    const bounds = embed.contentBounds();
    expect(bounds).not.toBeNull();
    expect(bounds?.width).toBeGreaterThan(0);
    expect(bounds?.x).toBeLessThan(0);
  });

  it('★ `anchor` 摆法没有"装不下"这回事 ⇒ 一个字都不报', () => {
    const doc = createFakeDocument();
    const host = createFakeElement(doc);
    Object.assign(host, { clientWidth: 50, clientHeight: 50 });
    const required = vi.fn();

    new EmbedMind({
      doc: doc as unknown as Document,
      host: host as unknown as HTMLElement,
      mind: createMindFile({ rootText: '中心主题' }),
      mutate: () => true,
      placement: 'anchor',
      onRequiredSize: required,
    });

    expect(required).not.toHaveBeenCalled();
  });
});

/**
 * `2.2.0` 批 3：节点成为白板的连线端点，靠的是 `nodeRects()` 报出来的盒子。
 *
 * 两条口径在这里钉死：
 *
 * 1. **原点** —— `'anchor'` 摆法下就是根节点中心（白板那边加上容器 `x/y` 得到世界坐标）；
 * 2. **只报画出来的** —— 折叠收起来的那一支没有盒子（指向它的线因此也不画），
 *    而 `'anchor'` 摆法**不做深度截断**（画布上没有"卡面"这个空间上限）。
 */
describe('嵌图 · 节点盒子（连线端点的几何）', () => {
  /** 一条 6 层的链：根 → 甲 → 乙 → 丙 → 丁 → 戊（用来验"截断与不截断"） */
  function chain(depth: number) {
    const file = createMindFile({ rootText: '根' });
    let parent = file.rootId;
    for (let index = 0; index < depth; index++) {
      const node = createMindNode({ parentId: parent, text: `第${index + 1}层`, order: 0 });
      file.nodes.push(node);
      parent = node.id;
    }
    return file;
  }

  function embedOf(file: ReturnType<typeof createMindFile>, placement: 'fit' | 'anchor') {
    const doc = createFakeDocument();
    const host = createFakeElement(doc);
    return new EmbedMind({
      doc: doc as unknown as Document,
      host: host as unknown as HTMLElement,
      mind: file,
      mutate: () => true,
      placement,
    });
  }

  it('★★ `anchor` 摆法：根节点的盒子**中心就是宿主原点**（容器 x/y = 根节点中心）', () => {
    const file = chain(2);
    const embed = embedOf(file, 'anchor');

    const rects = embed.nodeRects();
    expect(rects).toHaveLength(3);
    const root = rects.find((item) => item.nodeId === file.rootId);
    expect(root).toBeDefined();
    expect(root!.rect.x + root!.rect.width / 2).toBeCloseTo(0, 5);
    expect(root!.rect.y + root!.rect.height / 2).toBeCloseTo(0, 5);
    // 每个盒子都有正的尺寸（连线要在它的四边上取锚点）
    for (const item of rects) {
      expect(item.rect.width).toBeGreaterThan(0);
      expect(item.rect.height).toBeGreaterThan(0);
    }
  });

  it('★ `anchor` 摆法**不做深度截断**：画布上要看得到、也要连得到深层节点', () => {
    const file = chain(6);

    // 卡内嵌图（`fit`）：只画前 3 层（根 + 3）—— 卡面比屏幕小得多
    expect(embedOf(file, 'fit').nodeRects()).toHaveLength(4);
    // 白板级脑图：整棵都在
    expect(embedOf(file, 'anchor').nodeRects()).toHaveLength(7);
  });

  it('★ 折叠收起来的那一支**没有盒子**（它的线也不该画出来）', () => {
    const file = chain(3);
    // 把"第 1 层"收起来：它下面两层都不该有盒子
    const first = file.nodes[1];
    const collapsed = {
      ...file,
      nodes: file.nodes.map((node) => (node.id === first.id ? { ...node, collapsed: true } : node)),
    };
    const embed = embedOf(collapsed, 'anchor');

    const ids = embed.nodeRects().map((item) => item.nodeId);
    expect(ids).toContain(file.rootId);
    expect(ids).toContain(first.id);
    expect(ids).toHaveLength(2);
  });
});

/**
 * `2.2.0` 批 4：画布过滤落到**节点**这一层（`isNodeDimmed` / `refreshDim`）。
 *
 * 两条口径：
 *
 * 1. **只改 class，不重建节点** —— 过滤是"打字就触发"的动作，重建整棵树会把
 *    正在改名的输入框与用户的手都弄没（`refreshDim` 与 `applySelection` 同一套写法）；
 * 2. **重画之后新出现的节点照样按过滤态** —— 否则"过滤着的时候加一个不匹配的节点"
 *    会亮着，而下次敲键盘又变淡（两套状态打架）。
 */
describe('嵌图 · 过滤到节点（变淡）', () => {
  /** 一棵根 + 两个分支的脑图 */
  function tree() {
    const file = createMindFile({ rootText: '中心主题' });
    file.nodes.push(createMindNode({ parentId: file.rootId, text: '分支甲', order: 0 }));
    file.nodes.push(createMindNode({ parentId: file.rootId, text: '分支乙', order: 1 }));
    return file;
  }

  function harnessOf() {
    const doc = createFakeDocument();
    const host = createFakeElement(doc);
    const file = tree();
    let dimmed = new Set<string>([file.nodes[1].id]);
    const embed = new EmbedMind({
      doc: doc as unknown as Document,
      host: host as unknown as HTMLElement,
      mind: file,
      mutate: () => true,
      isNodeDimmed: (nodeId) => dimmed.has(nodeId),
    });
    const world = (host.children[0] as FakeElement).children[0] as FakeElement;
    const nodeLayer = world.children[1] as FakeElement;
    const nodeEl = (nodeId: string): FakeElement => {
      const found = nodeLayer.children.find(
        (child) => (child as FakeElement).getAttribute(MIND_NODE_ID_ATTR) === nodeId,
      );
      if (!found) throw new Error(`没有这个节点：${nodeId}`);
      return found as FakeElement;
    };
    return {
      file,
      embed,
      nodeEl,
      setDimmed: (ids: string[]) => {
        dimmed = new Set(ids);
      },
    };
  }

  it('首帧就照着回调画：集合里的那个变淡，别的没有', () => {
    const h = harnessOf();
    expect(h.nodeEl(h.file.nodes[1].id).classList.contains('is-dimmed')).toBe(true);
    expect(h.nodeEl(h.file.rootId).classList.contains('is-dimmed')).toBe(false);
    expect(h.nodeEl(h.file.nodes[2].id).classList.contains('is-dimmed')).toBe(false);
  });

  it('★ 过滤条件变了：`refreshDim()` 当场改 class（**不重建**节点元素）', () => {
    const h = harnessOf();
    const before = h.nodeEl(h.file.rootId);
    h.setDimmed([h.file.rootId]);
    h.embed.refreshDim();

    expect(h.nodeEl(h.file.rootId).classList.contains('is-dimmed')).toBe(true);
    expect(h.nodeEl(h.file.nodes[1].id).classList.contains('is-dimmed')).toBe(false);
    // ★ 同一个元素对象（没被换掉）：说明只改了 class
    expect(h.nodeEl(h.file.rootId)).toBe(before);
  });

  it('★ 重画之后**新出现**的节点照样按过滤态（不会亮着等下次敲键盘）', () => {
    const h = harnessOf();
    const next = { ...h.file, nodes: [...h.file.nodes] };
    const added = createMindNode({ parentId: h.file.rootId, text: '分支丙', order: 2 });
    next.nodes = [...next.nodes, added];
    h.setDimmed([added.id]);
    h.embed.update(next);

    expect(h.nodeEl(added.id).classList.contains('is-dimmed')).toBe(true);
  });
});

describe('嵌图手势 · 双击', () => {
  it('★★ 双击**根节点**：不再去"打开这份脑图"（它现在和别的节点一样就地改名）', () => {
    const onOpen = vi.fn();
    const h = makeHarness({ onOpen });
    const el = h.nodeEl(h.rootId);

    h.doubleClick(
      new StubElement({ [`.${MIND_NODE_CLASS}`]: el, [`[${MIND_HANDLE_ATTR}]`]: null }),
    );

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('只读时双击根节点退回"打开"（改不了就说清楚，而不是什么都没发生）', () => {
    const onOpen = vi.fn();
    const h = makeHarness({ onOpen, readOnly: true });
    const el = h.nodeEl(h.rootId);

    h.doubleClick(new StubElement({ [`.${MIND_NODE_CLASS}`]: el }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('双击**空白**仍然是"打开这份脑图"（卡内留白那一圈没被这次改动收走）', () => {
    const onOpen = vi.fn();
    const h = makeHarness({ onOpen });

    h.doubleClick(new StubElement());

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
