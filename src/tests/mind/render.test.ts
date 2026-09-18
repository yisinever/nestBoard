/**
 * 脑图渲染层（`06 §2` 的 `mind/view/render.ts`）—— 节点与连线的 DOM。
 *
 * 用假 DOM 测（与白板 `cards/` 的测法一致）：这里钉的是"节点长什么样、摆在哪、
 * 连线两端贴不贴边"，都是**错了会一眼看出来但很难查**的地方。
 */

import { describe, expect, it } from 'vitest';
import type { NodeBox } from '../../mind/layout/tree';
import { mindPaletteOf } from '../../mind/model/palette';
import { createMindNode } from '../../mind/model/factories';
import type { MindNode } from '../../mind/model/schema';
import {
  MIND_BODY_CLASS,
  MIND_HANDLE_ATTR,
  MIND_IMAGE_RESIZE_ATTR,
  MIND_NODE_CLASS,
  MIND_NODE_ID_ATTR,
  MIND_REF_ATTR,
  applyHandleBox,
  applyHandleState,
  applyNodeBox,
  branchPointOf,
  buildEdgeLayer,
  buildHandleElement,
  childSideOf,
  buildNodeElement,
  buildTitleEditor,
  edgePathOf,
  edgeTrunkPathOf,
  handleLabelOf,
  paintEdges,
  renderSignatureOf,
} from '../../mind/view/render';
import { createFakeDocument, type FakeElement } from '../helpers/fakeDom';
import { boxOf as nodeBoxOf } from '../helpers/mindFixtures';

/**
 * 假 `Document`。
 *
 * ★ 双转型是**必须**的：假 DOM 只实现被测代码真正用到的那几个接口，永远不可能结构上
 *   满足 `Document`（浏览器里那 280 个成员）。与白板 `cards/` 那些用例同一条做法 ——
 *   真类型给被测代码、假类型给断言。
 */
const doc = () => createFakeDocument() as unknown as Document;

/** 假 DOM 的元素（本文件里处处要断言它的属性 / 孩子 / 样式） */
type El = FakeElement;

function asEl(value: unknown): El {
  return value as El;
}

function childrenOf(el: El): El[] {
  return el.children.map(asEl);
}

function byClass(el: El, className: string): El | null {
  for (const child of childrenOf(el)) {
    if (child.classList.contains(className)) return child;
  }
  return null;
}

// ── 节点元素 ─────────────────────────────────────────────────

describe('buildNodeElement', () => {
  it('带上节点 id 属性（命中 / 裁剪 / 拖拽都读它同一份）', () => {
    const node = createMindNode({ id: 'n_1', text: '甲' });
    const el = asEl(buildNodeElement(doc(), node));

    expect(el.classList.contains(MIND_NODE_CLASS)).toBe(true);
    expect(el.getAttribute(MIND_NODE_ID_ATTR)).toBe('n_1');
  });

  it('★ 撞色写在四个 CSS 变量上（不是逐块 inline 样式：改一处会漏另一处）', () => {
    const node = createMindNode({ text: '甲', style: { color: '#4c8dff' } });
    const el = asEl(buildNodeElement(doc(), node));
    const palette = mindPaletteOf(node.style);

    expect(el.style.getPropertyValue('--nestboard-mind-title-bg')).toBe(palette.title);
    expect(el.style.getPropertyValue('--nestboard-mind-title-ink')).toBe(palette.titleInk);
    expect(el.style.getPropertyValue('--nestboard-mind-body-bg')).toBe(palette.body);
    expect(el.style.getPropertyValue('--nestboard-mind-body-ink')).toBe(palette.bodyInk);
  });

  it('★ 四级及更深：不画盒子（四块颜色退回透明 / 正文色 + `is-deep`，`D3`）', () => {
    const node = createMindNode({ text: '甲', style: { color: '#4c8dff' } });
    const palette = mindPaletteOf(node.style);

    // 三层：照旧带色（阈值是"四级及更深"）
    const shallow = asEl(buildNodeElement(doc(), node, { depth: 3 }));
    expect(shallow.classList.contains('is-deep')).toBe(false);
    expect(shallow.style.getPropertyValue('--nestboard-mind-title-bg')).toBe(palette.title);

    const deep = asEl(buildNodeElement(doc(), node, { depth: 4 }));
    expect(deep.classList.contains('is-deep')).toBe(true);
    // ★ 必须是**行内变量**被改写：类规则压不住行内样式（写在样式表里不会生效）
    expect(deep.style.getPropertyValue('--nestboard-mind-title-bg')).toBe('transparent');
    expect(deep.style.getPropertyValue('--nestboard-mind-title-ink')).toBe('var(--text-normal)');
    expect(deep.style.getPropertyValue('--nestboard-mind-body-bg')).toBe('transparent');
    expect(deep.style.getPropertyValue('--nestboard-mind-body-ink')).toBe('var(--text-normal)');
    // ★ 字号一个字节不改：它与布局估算读的是同一份数，改了这一层就会与连线错位
    expect(deep.style.getPropertyValue('--nestboard-mind-title-size')).toBe(
      shallow.style.getPropertyValue('--nestboard-mind-title-size'),
    );
  });

  it('标题是纯文本一行；没有内容时**不建内容块**（空块会白占一行高）', () => {
    const el = asEl(buildNodeElement(doc(), createMindNode({ text: '甲', note: '' })));

    const title = byClass(el, 'nestboard-mind-node-title') as El;
    // ★ 文字在**那一层 span 里**（包一层是为了让省略号只管文字，不管回形针）——
    //   而假 DOM 的 `textContent` 不聚合孩子，所以断言要走到那一层
    expect(byClass(title, 'nestboard-mind-node-title-text')?.textContent).toBe('甲');
    expect(byClass(el, 'nestboard-mind-node-body')).toBeNull();
  });

  it('有内容时建内容块（P2 先纯文本，Markdown 渲染在 P4）', () => {
    const el = asEl(buildNodeElement(doc(), createMindNode({ text: '甲', note: '# 一段内容' })));

    expect(byClass(el, 'nestboard-mind-node-body')?.textContent).toBe('# 一段内容');
  });

  it('★ 附件**不进内容区**：只有标题带末尾一个回形针，且悬停给的是文件名', () => {
    const noRef = asEl(buildNodeElement(doc(), createMindNode({ text: '甲' })));
    const withRef = asEl(
      buildNodeElement(
        doc(),
        createMindNode({ text: '甲', refs: [{ kind: 'note', path: 'Notes/乙.md' }] }),
      ),
    );

    const noRefTitle = byClass(noRef, 'nestboard-mind-node-title') as El;
    const withRefTitle = byClass(withRef, 'nestboard-mind-node-title') as El;
    expect(byClass(noRefTitle, 'nestboard-mind-clip')).toBeNull();
    const clip = byClass(withRefTitle, 'nestboard-mind-clip');
    expect(clip).not.toBeNull();
    expect(clip?.title).toBe('乙.md');
    // 命中测试靠这个属性认人（值 = 路径；点它打开文件）
    expect(clip?.getAttribute(MIND_REF_ATTR)).toBe('Notes/乙.md');
    // 内容区里不再有附件行（用户 2026-09-16 明确要求）
    expect(byClass(withRef, 'nestboard-mind-node-chips')).toBeNull();
  });

  it('★ 附件失效（文件被删 / 移出库，`06 §6`）：回形针挂 `is-missing`，提示语换成"附件不在了"', () => {
    const node = createMindNode({ text: '甲', refs: [{ kind: 'file', path: 'Docs/报告.pdf' }] });

    const gone = asEl(buildNodeElement(doc(), node, { refMissing: () => true }));
    const goneTitle = byClass(gone, 'nestboard-mind-node-title') as El;
    const clip = byClass(goneTitle, 'nestboard-mind-clip');
    expect(clip?.className).toContain('is-missing');
    // 失效时"悬停给文件名"帮不上忙 —— 要说的是"这东西怎么了"（仍带着文件名，好认人）
    expect(clip?.title).toContain('报告.pdf');
    // ★ 仍然可点：命中测试靠的还是同一个属性（点一下会说清"文件不在了"）
    expect(clip?.getAttribute(MIND_REF_ATTR)).toBe('Docs/报告.pdf');

    // 文件还在 ⇒ 一个 `is-missing` 都没有（默认口径不变）
    const ok = asEl(buildNodeElement(doc(), node, { refMissing: () => false }));
    const okTitle = byClass(ok, 'nestboard-mind-node-title') as El;
    expect(byClass(okTitle, 'nestboard-mind-clip')?.className).not.toContain('is-missing');
  });

  it('★ 图片附件：图片块排在标题**上面**，宽度写进节点元素上的 CSS 变量', () => {
    const node = createMindNode({
      text: '甲',
      refs: [{ kind: 'image', path: 'a.png', width: 260 }],
    });
    const el = asEl(buildNodeElement(doc(), node, { resolveResource: () => 'app://local/a.png' }));

    expect(byClass(el, 'nestboard-mind-image')).not.toBeNull();
    // 顺序：图片（第一块）→ 标题（第二块）
    expect(childrenOf(el).map((child) => child.className)).toEqual([
      'nestboard-mind-image',
      'nestboard-mind-node-title',
    ]);
    // 宽度走变量：拉角时视图只改这一个变量就能实时预览
    expect(el.style.getPropertyValue('--nestboard-mind-image-width')).toBe('260px');
    // 四个角都在（拉角靠 `data-mind-image-corner` 认人）
    const corners = childrenOf(byClass(el, 'nestboard-mind-image') as El)
      .map((child) => child.getAttribute(MIND_IMAGE_RESIZE_ATTR))
      .filter((value): value is string => value !== null);
    expect(corners.sort()).toEqual(['ne', 'nw', 'se', 'sw']);
  });

  it('★ 图片附件**不显示回形针**（图片自己就是附件、就摆在眼前）', () => {
    const node = createMindNode({ text: '甲', refs: [{ kind: 'image', path: 'a.png' }] });
    const el = asEl(buildNodeElement(doc(), node, { resolveResource: () => 'app://a.png' }));
    const title = byClass(el, 'nestboard-mind-node-title') as El;

    expect(byClass(el, 'nestboard-mind-image')).not.toBeNull();
    expect(byClass(title, 'nestboard-mind-clip')).toBeNull();
    // 图片这层没有回形针，"这是什么 / 怎么打开"得靠它自己说
    const img = byClass(byClass(el, 'nestboard-mind-image') as El, 'nestboard-mind-image-el');
    expect(img?.title).toContain('a.png');
  });

  it('★ 指纹带上标记：只换一个 emoji 也必须**当场重建**（真实报障的回归）', () => {
    const before = createMindNode({ text: '甲', icon: '📌' });
    const after = createMindNode({ text: '甲', icon: '🔥' });

    // 用户报的是"挑完标记不实时更新，要再点一下 B 才出现" —— 根因就是指纹漏了 `icon`：
    // `paint()` 见指纹没变就跳过重建，而那个节点已经是画好的了（里面还是旧表情）
    expect(renderSignatureOf(before)).not.toBe(renderSignatureOf(after));
    // 没有标记与有一个标记也必须是两个签名（"摘掉标记"同样要当场生效）
    expect(renderSignatureOf(before)).not.toBe(renderSignatureOf(createMindNode({ text: '甲' })));
  });

  it('★ 附件**失效**也要进指纹：不然删掉那个文件之后回形针不会变灰（`06 §6`）', () => {
    const node = createMindNode({ text: '甲', refs: [{ kind: 'file', path: 'Docs/报告.pdf' }] });

    expect(renderSignatureOf(node, () => true)).not.toBe(renderSignatureOf(node, () => false));
    // ★ 没传判据（单测 / 嵌入视图那一档）⇒ 指纹仍然稳定，也不逼调用方回答这个问题
    expect(renderSignatureOf(node)).toBe(renderSignatureOf(node));
  });

  it('★ 标记（`08 §3.1`）：放在标题**最前面**，跟着层级字号走', () => {
    const bare = asEl(buildNodeElement(doc(), createMindNode({ text: '甲' })));
    const withIcon = asEl(buildNodeElement(doc(), createMindNode({ text: '甲', icon: '🔥' })));

    const bareTitle = byClass(bare, 'nestboard-mind-node-title') as El;
    const iconTitle = byClass(withIcon, 'nestboard-mind-node-title') as El;
    expect(byClass(bareTitle, 'nestboard-mind-node-icon')).toBeNull();

    // 顺序：标记在**文字那一段之前**
    expect(childrenOf(iconTitle).map((child) => child.className)).toEqual([
      'nestboard-mind-node-icon',
      'nestboard-mind-node-title-text',
    ]);
    expect(byClass(iconTitle, 'nestboard-mind-node-icon')?.textContent).toBe('🔥');
    // 对读屏隐藏（它是个装饰性符号，念出 emoji 的名字对听的人没有帮助）
    expect(byClass(iconTitle, 'nestboard-mind-node-icon')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('★ 标题的斜体 / 下划线走 CSS 变量（快捷操作栏改的是**整条标题**）', () => {
    const plain = asEl(buildNodeElement(doc(), createMindNode({ text: '甲' })));
    const styled = asEl(
      buildNodeElement(
        doc(),
        createMindNode({ text: '甲', style: { italic: true, underline: true, bold: true } }),
      ),
    );

    expect(plain.style.getPropertyValue('--nestboard-mind-title-style')).toBe('normal');
    expect(styled.style.getPropertyValue('--nestboard-mind-title-style')).toBe('italic');
    expect(styled.style.getPropertyValue('--nestboard-mind-title-decoration')).toBe('underline');
    expect(styled.style.getPropertyValue('--nestboard-mind-title-weight')).toContain('bold');
  });

  it('★ 标题字号与粗细跟着**层级**走（根 30 加粗 / 一层 18 / 二层及以下 14）', () => {
    const at = (depth: number): El =>
      asEl(buildNodeElement(doc(), createMindNode({ text: '甲' }), { depth }));

    expect(at(0).style.getPropertyValue('--nestboard-mind-title-size')).toBe('30px');
    expect(at(0).style.getPropertyValue('--nestboard-mind-title-weight')).toContain('bold');
    expect(at(1).style.getPropertyValue('--nestboard-mind-title-size')).toBe('18px');
    expect(at(1).style.getPropertyValue('--nestboard-mind-title-weight')).toBe('normal');
    expect(at(2).style.getPropertyValue('--nestboard-mind-title-size')).toBe('14px');
    // 越界（第三层及以下）取最后一档
    expect(at(7).style.getPropertyValue('--nestboard-mind-title-size')).toBe('14px');
  });

  it('★ 二层淡粉、三层及以下纯白（层级底色，与主色无关）', () => {
    const at = (depth: number): El =>
      asEl(buildNodeElement(doc(), createMindNode({ text: '甲' }), { depth }));

    expect(at(2).style.getPropertyValue('--nestboard-mind-title-bg')).toBe('#f9d8e2');
    expect(at(3).style.getPropertyValue('--nestboard-mind-title-bg')).toBe('#ffffff');
    // 一层仍然是主色（默认主题色 1 号 = 红）
    expect(at(1).style.getPropertyValue('--nestboard-mind-title-bg')).not.toBe('#ffffff');
  });

  it('图片地址拿不到（文件不在 / 不是图）时不画图片块，**回形针仍然留着**', () => {
    const node = createMindNode({ text: '甲', refs: [{ kind: 'image', path: '没了.png' }] });
    const el = asEl(buildNodeElement(doc(), node, { resolveResource: () => null }));

    expect(byClass(el, 'nestboard-mind-image')).toBeNull();
    // 点得开、也说得清"文件不在了" —— 比一张破图诚实
    const title = byClass(el, 'nestboard-mind-node-title') as El;
    expect(byClass(title, 'nestboard-mind-clip')).not.toBeNull();
  });

  it('`showBody: false` 时内容块不渲染（"只看标题"的档位将来会用到）', () => {
    const node = createMindNode({ text: '甲', note: '有内容' });
    const el = asEl(buildNodeElement(doc(), node, { showBody: false }));

    expect(byClass(el, 'nestboard-mind-node-body')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 「长什么样」的指纹（`renderSignatureOf`）
//
// 它是"改完标题当场看见"的唯一依据：视图拿它跟"上次画的是哪一版"比，
// 不一样就重建那个元素。所以两组字段必须分得清 ——
// 内容变了要重画，而几何 / 父子关系变了**不该**重画（那些 `applyNodeBox` 已经管了）。
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 就地改标题的输入组件（`buildTitleEditor`）
//
// 它的"影子"是"打字时节点跟着长"的全部依据 —— 而这条**必须**成立：
// 不成立时，往左延伸的那一支会往右长进父节点里。
// ★ 用 `children` 取子元素而不是 `querySelector`：假 DOM 没有后者
//   （这也是当初让它返回**句柄**的原因）。
// ─────────────────────────────────────────────────────────────

describe('buildTitleEditor', () => {
  it('★ 影子与输入框同步（宽度由影子那段真文字算，不同步就"打字不长个"）', () => {
    const editor = buildTitleEditor(doc(), '甲', '标题');
    const shadow = asEl(editor.element.children[0]);

    expect(editor.input.value).toBe('甲');
    expect(shadow.textContent).toBe('甲');
    expect(editor.element.children[1]).toBe(editor.input);

    editor.input.value = '甲一二三';
    editor.sync();
    expect(shadow.textContent).toBe('甲一二三');
  });

  it('空标题时影子给一个空格（不然宽度塌成 0，光标都站不住）', () => {
    const editor = buildTitleEditor(doc(), '', '标题');
    expect(asEl(editor.element.children[0]).textContent).toBe(' ');
  });
});

// ─────────────────────────────────────────────────────────────
// 折叠手柄（`06 §11.14`）：连接处那个圆圈
// ─────────────────────────────────────────────────────────────

describe('折叠手柄', () => {
  /**
   * 建一个手柄：类型上是"假元素 ∩ 真元素"，于是既能喂给被测代码（要 `HTMLElement`）、
   * 又能直接断言假 DOM 的那些字段。
   *
   * ★ 交集类型是这里最省事的写法：纯假元素喂不进 `applyHandleState`（真被 `HTMLElement`），
   *   纯真元素又读不到假 DOM 的 `style.getPropertyValue`。双转型是假 DOM 的老规矩（见文件头）。
   */
  const newHandle = (): FakeElement & HTMLElement =>
    buildHandleElement(doc()) as unknown as FakeElement & HTMLElement;

  it('★ 收起时圈里写**直接子节点数**，超过 99 给省略号（三位数会撑破圆圈）', () => {
    expect(handleLabelOf(1)).toBe('1');
    expect(handleLabelOf(12)).toBe('12');
    expect(handleLabelOf(99)).toBe('99');
    expect(handleLabelOf(100)).toBe('…');
    expect(handleLabelOf(1234)).toBe('…');
  });

  it('展开时圈里**不写字**（那条短横交给 CSS 画：文字减号在不同字体里左右不居中）', () => {
    const el = newHandle();

    applyHandleState(el, { nodeId: 'n1', collapsed: false, count: 3, label: '收起子节点' });

    expect(el.textContent).toBe('');
    expect(el.classList.contains('is-collapsed')).toBe(false);
    // 认得出"这是谁的手柄"：命中时就靠这一个属性
    expect(el.getAttribute(MIND_HANDLE_ATTR)).toBe('n1');
    expect(el.getAttribute('aria-label')).toBe('收起子节点');
  });

  it('收起时写字、挂上 `is-collapsed`（样式表按它放大圆圈并去掉短横）', () => {
    const el = newHandle();

    applyHandleState(el, { nodeId: 'n1', collapsed: true, count: 12, label: '展开 12 个子节点' });

    expect(el.textContent).toBe('12');
    expect(el.classList.contains('is-collapsed')).toBe(true);
  });

  it('★ 摆在**分支点**上：离节点边缘正好"一截线 + 半个圆圈"（不贴着节点）', () => {
    const right = newHandle();
    applyHandleBox(right, nodeBoxOf('n1', 100, 200, { width: 120, height: 40 }));

    // 右边缘 220 + (8 + 8) = 236
    expect(right.style.getPropertyValue('left')).toBe('236px');
    expect(right.style.getPropertyValue('top')).toBe('220px');
    expect(right.classList.contains('is-left')).toBe(false);

    const left = newHandle();
    applyHandleBox(left, { ...nodeBoxOf('n2', 100, 200, { width: 120, height: 40 }), side: -1 });

    // 左边缘 100 − (8 + 8) = 84；那一截线画在圆圈**右侧**（`is-left`）
    expect(left.style.getPropertyValue('left')).toBe('84px');
    expect(left.classList.contains('is-left')).toBe(true);
  });

  it('根与悬浮节点（`side === 0`）按"孩子在右"处理', () => {
    const el = newHandle();
    applyHandleBox(el, { ...nodeBoxOf('root', 0, 0, { width: 80, height: 30 }), side: 0 });

    expect(el.style.getPropertyValue('left')).toBe('96px');
  });
});

// ─────────────────────────────────────────────────────────────
// 内容块（P4）：Markdown 渲染能力与"空正文"
// ─────────────────────────────────────────────────────────────

describe('内容块', () => {
  const nodeWith = (note: string) =>
    createMindNode({ id: 'n1', text: '甲', note, parentId: null, order: 0 });

  const bodyOf = (el: El) => childrenOf(el).find((child) => child.className === MIND_BODY_CLASS);

  it('★ 没有渲染能力时退回**纯文本**（单测 / 嵌入视图 / 导出走的就是这条路）', () => {
    const el = asEl(buildNodeElement(doc(), nodeWith('**粗**')));

    expect(bodyOf(el)?.textContent).toBe('**粗**');
  });

  it('★ 有渲染能力时交给它，并**先清空**（`MarkdownRenderer.render` 是追加式的，不清就渲染两遍）', () => {
    const seen: Array<[string, string]> = [];
    const el = asEl(
      buildNodeElement(doc(), nodeWith('**粗**'), {
        renderMarkdown: (markdown, target) => {
          seen.push([markdown, asEl(target).textContent ?? '']);
          asEl(target).textContent = '渲染结果';
        },
      }),
    );

    expect(seen).toEqual([['**粗**', '']]);
    expect(bodyOf(el)?.textContent).toBe('渲染结果');
  });

  it('空正文默认**不建内容块**（空的一行不该在卡面上留一块白）；`forceBody` 时一定建', () => {
    expect(bodyOf(asEl(buildNodeElement(doc(), nodeWith(''))))).toBeUndefined();
    expect(bodyOf(asEl(buildNodeElement(doc(), nodeWith(''), { forceBody: true })))).toBeDefined();
  });

  it('空正文不请渲染能力（没什么可渲染的）', () => {
    let called = 0;
    buildNodeElement(doc(), nodeWith(''), {
      forceBody: true,
      renderMarkdown: () => {
        called += 1;
      },
    });

    expect(called).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 连线形态（`08 §1.3`）
//
// 四种线型**共用同一对端点**（分支点 → 孩子朝向父节点的那条边）：
// 换线型只改"从交汇点之后怎么走到孩子"，不会让线头离开节点。
// 那是换线型最容易踩的坑，所以这里两头都钉住。
// ─────────────────────────────────────────────────────────────

describe('edgePathOf · 四种线型', () => {
  const parent = nodeBoxOf('p', 100, 100, { depth: 0 });
  const child = nodeBoxOf('c', 300, 140, { depth: 1 });

  it('★ 四种线型的**起点与终点完全一样**（都是分支点 → 孩子左边缘中点）', () => {
    const paths = (['curve', 'line', 'elbow', 'rounded'] as const).map((style) =>
      edgePathOf(parent, child, style),
    );
    const start = branchPointOf(parent, 1);

    for (const d of paths) {
      expect(d.startsWith(`M ${start.x} ${start.y}`)).toBe(true);
      // 终点 = 孩子朝父节点那条边的中点
      expect(d.trimEnd().endsWith(`${child.x} ${child.y + child.height / 2}`)).toBe(true);
    }
  });

  it('曲线用三次贝塞尔；直线只有 M/L；直角折线三个 L；圆角折线带 Q', () => {
    expect(edgePathOf(parent, child, 'curve')).toContain('C');
    expect(edgePathOf(parent, child, 'line')).not.toContain('C');
    expect(edgePathOf(parent, child, 'line').match(/L/g)).toHaveLength(1);
    expect(edgePathOf(parent, child, 'elbow').match(/L/g)).toHaveLength(3);
    expect(edgePathOf(parent, child, 'rounded')).toContain('Q');
  });

  it('不传线型 = 曲线（既有调用与快照都不变）', () => {
    expect(edgePathOf(parent, child)).toBe(edgePathOf(parent, child, 'curve'));
  });

  it('★ 圆角只给**孩子那一端**：父端那个转折点与直角折线走同一段（用户 2026-09-17）', () => {
    const rounded = edgePathOf(parent, child, 'rounded');
    const elbow = edgePathOf(parent, child, 'elbow');

    // 父端：起点**直接**杀到转折点 —— 与直角折线的前两个点逐字相同
    //（`elbow` 的 `d` 形如 `M 起点 L 转折点 L …`，取前两段就是"父端那一段"）
    const fatherLeg = elbow.split(' L ').slice(0, 2).join(' L ');
    expect(rounded.startsWith(`${fatherLeg} L `)).toBe(true);

    // 只剩**一个**圆弧（从前父端、子端各一个）
    expect(rounded.match(/Q/g)).toHaveLength(1);
    // 而且圆弧出现在**走完两段直线之后**（起点 → 转折点 → 沿兄弟轴推到圆弧起点）
    // ⇒ 父端那一路全是直角，只有快到孩子时才开始拐
    const beforeArc = rounded.split(' Q ')[0] ?? '';
    expect(beforeArc.split(' L ')).toHaveLength(3);
    // 圆弧之后仍然有一段直线收到孩子那条边（与直角折线同一个终点）
    expect(rounded.split(' Q ')[1]?.split(' L ')).toHaveLength(2);
  });

  it('★ 孩子在同一行时（`dy = 0`）圆角折线退回直角折线，不会画出怪东西', () => {
    const same = nodeBoxOf('c2', 300, 100, { depth: 1 });
    const d = edgePathOf(parent, same, 'rounded');

    expect(d).not.toContain('Q');
    expect(d.match(/L/g)).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────
// 纵向布局（组织结构图，向下）
//
// 同一个函数换个轴：层级往 y 长、兄弟往 x 排。所以"两头贴着节点"这条规则
// 必须一模一样地成立 —— 差别只在贴的是**下边缘 → 上边缘**而不是左边 → 右边。
// ─────────────────────────────────────────────────────────────

describe('edgePathOf · 纵向布局', () => {
  const parent = nodeBoxOf('p', 0, 0, { depth: 0, vertical: true, width: 120, height: 40 });
  const child = nodeBoxOf('c', 20, 120, { depth: 1, vertical: true, width: 80, height: 40 });

  it('★ 从父节点**下边缘**的中点出发（再让出一个 GAP），到孩子**上边缘**的中点', () => {
    const start = branchPointOf(parent, 1);

    expect(start).toEqual({ x: 60, y: 40 + 16 });
    const d = edgePathOf(parent, child, 'curve');
    expect(d.startsWith(`M ${start.x} ${start.y}`)).toBe(true);
    // 终点 = 孩子上边缘中点（x = 20 + 80/2 = 60）
    expect(d.trimEnd().endsWith('60 120')).toBe(true);
  });

  it('★ 纵向只有一个方向 ⇒ `childSideOf` 恒为「往下」（哪怕孩子在上方）', () => {
    expect(childSideOf(parent, child)).toBe(1);
    expect(childSideOf(parent, nodeBoxOf('up', -400, -200, { vertical: true }))).toBe(1);
  });

  it('延长线是一小段**竖线**（手柄在节点下方，那截短线朝上连回节点）', () => {
    expect(edgeTrunkPathOf(parent, 1)).toBe('M 60 40 L 60 56');
  });

  it('四种线型在纵向也共用同一对端点', () => {
    for (const style of ['curve', 'line', 'elbow', 'rounded'] as const) {
      const d = edgePathOf(parent, child, style);
      expect(d.startsWith('M 60 56')).toBe(true);
      expect(d.trimEnd().endsWith('60 120')).toBe(true);
    }
  });

  it('★ 手柄画在节点**下方**，且那截短线是竖的（`is-up`）', () => {
    // ★ 这里**不转成 FakeElement**：`applyHandleBox` 收的是真的 `HTMLElement`
    //   （运行期当然是假 DOM，但类型上要过），断言也都能在 `HTMLElement` 的表达力内做完
    const handle = buildHandleElement(doc());
    applyHandleBox(handle, parent);

    expect(handle.style.left).toBe('60px');
    expect(handle.style.top).toBe('56px');
    expect(handle.classList.contains('is-up')).toBe(true);
    // 横向布局里那个 `is-left` 不该同时挂上（两者互斥）
    expect(handle.classList.contains('is-left')).toBe(false);
  });
});

describe('renderSignatureOf', () => {
  const nodeOf = (overrides: Partial<MindNode> = {}): MindNode => ({
    id: 'n1',
    text: '甲',
    note: '',
    parentId: null,
    order: 0,
    ...overrides,
  });

  it('★ 标题 / 正文 / 附件 / 配色 / 折叠 一变就不一样（这几样就是"卡面"）', () => {
    const base = nodeOf();

    expect(renderSignatureOf(nodeOf({ text: '乙' }))).not.toBe(renderSignatureOf(base));
    expect(renderSignatureOf(nodeOf({ note: '正文' }))).not.toBe(renderSignatureOf(base));
    expect(renderSignatureOf(nodeOf({ collapsed: true }))).not.toBe(renderSignatureOf(base));
    expect(renderSignatureOf(nodeOf({ style: { color: '2' } }))).not.toBe(renderSignatureOf(base));
    expect(renderSignatureOf(nodeOf({ refs: [{ path: 'a.md', kind: 'note' }] }))).not.toBe(
      renderSignatureOf(base),
    );
  });

  it('★ 父子关系 / 次序 / 悬浮坐标 变了**不算**内容变化（重画它们纯属白费）', () => {
    const base = nodeOf();

    expect(renderSignatureOf(nodeOf({ parentId: 'p', order: 3 }))).toBe(renderSignatureOf(base));
    expect(renderSignatureOf(nodeOf({ free: { x: 10, y: 20 } }))).toBe(renderSignatureOf(base));
  });

  it('★ 完成（`N3-g`）也要进指纹（漏了就"点了完成没反应"）', () => {
    expect(renderSignatureOf(nodeOf({ done: true }))).not.toBe(renderSignatureOf(nodeOf()));
  });

  it('★ 完成的两档**分开放**：自己完成 = `is-done`，祖先完成 = `is-done-dim`（不叠加）', () => {
    const self = asEl(buildNodeElement(doc(), createMindNode({ text: '甲' })));
    const done = asEl(buildNodeElement(doc(), createMindNode({ text: '甲', done: true })));
    const dim = asEl(buildNodeElement(doc(), createMindNode({ text: '甲' }), { doneBranch: true }));

    expect(done.classList.contains('is-done')).toBe(true);
    // 自己完成的那一块**不**再压一层淡：它已经有删除线，两档合起来就分不出
    // "这是我做完的那条"与"它是某条已完成分支里的"
    expect(done.classList.contains('is-done-dim')).toBe(false);

    expect(dim.classList.contains('is-done-dim')).toBe(true);
    expect(dim.classList.contains('is-done')).toBe(false);

    expect(self.classList.contains('is-done')).toBe(false);
    expect(self.classList.contains('is-done-dim')).toBe(false);
  });
});

describe('applyNodeBox', () => {
  const newEl = () => asEl(createFakeDocument().createElement('div'));

  it('写 left / top', () => {
    const el = newEl();

    applyNodeBox(el as unknown as HTMLElement, boxOf({ x: 12, y: -34 }));

    expect(el.style.getPropertyValue('left')).toBe('12px');
    expect(el.style.getPropertyValue('top')).toBe('-34px');
  });

  it('★ **不写宽高**：写下去等于让尺寸测量变成自证（量到的是自己刚写的那个数）', () => {
    const el = newEl();

    applyNodeBox(el as unknown as HTMLElement, boxOf({ x: 0, y: 0, width: 180, height: 90 }));

    expect(el.style.getPropertyValue('width')).toBe('');
    expect(el.style.getPropertyValue('height')).toBe('');
  });
});

// ── 连线 ─────────────────────────────────────────────────────

function boxOf(partial: Partial<NodeBox> = {}): NodeBox {
  return {
    id: 'n',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    depth: 1,
    side: 1,
    free: false,
    ...partial,
  };
}

describe('branchPointOf（交汇点）与延长线', () => {
  it('★ 交汇点 = 节点边缘再让出"一截线 + 半个圆圈"', () => {
    const box = boxOf({ id: 'p', x: 100, y: 200, width: 120, height: 40 });

    expect(branchPointOf(box, 1)).toEqual({ x: 236, y: 220 });
    expect(branchPointOf(box, -1)).toEqual({ x: 84, y: 220 });
  });

  it('★ 延长线从节点边缘的中点连到交汇点（收起时也得画，否则手柄会飘着）', () => {
    const box = boxOf({ id: 'p', x: 100, y: 200, width: 120, height: 40 });

    expect(edgeTrunkPathOf(box, 1)).toBe('M 220 220 L 236 220');
    expect(edgeTrunkPathOf(box, -1)).toBe('M 100 220 L 84 220');
  });
});

describe('edgePathOf', () => {
  it('★ 右侧：从父节点的**交汇点**出发，落到孩子**左边缘**', () => {
    const parent = boxOf({ id: 'p', x: 0, y: 0, width: 100, height: 40 });
    const child = boxOf({ id: 'c', x: 200, y: 60, width: 80, height: 40 });

    const d = edgePathOf(parent, child);

    // 右边缘 100 + 16 = 116 —— 分支线从交汇点起，不再是节点边缘
    expect(d.startsWith('M 116 20 C ')).toBe(true);
    expect(d.endsWith(' 200 80')).toBe(true);
  });

  it('★ 左侧：镜像（从交汇点出发，落到孩子右边缘）', () => {
    const parent = boxOf({ id: 'p', x: 0, y: 0, width: 100, height: 40 });
    const child = boxOf({ id: 'c', x: -200, y: 0, width: 80, height: 40 });

    const d = edgePathOf(parent, child);

    // 左边缘 0 − 16 = −16
    expect(d.startsWith('M -16 20 C ')).toBe(true);
    expect(d.endsWith(' -120 20')).toBe(true);
  });

  it('父子几乎重叠时也给一段控制点距离（否则线缩成一个点）', () => {
    const parent = boxOf({ x: 0, y: 0, width: 100, height: 40 });
    const child = boxOf({ x: 101, y: 0, width: 10, height: 40 });

    const d = edgePathOf(parent, child);
    const numbers = d.match(/-?\d+(\.\d+)?/g) ?? [];

    expect(numbers).toHaveLength(8);
    // 控制点至少拉开 16px
    expect(Math.abs(Number(numbers[2]) - Number(numbers[0]))).toBeGreaterThanOrEqual(16);
  });
});

describe('paintEdges', () => {
  /** 连线层：真实类型给被测代码，假 DOM 类型给断言（与 `cards/` 的测法一致） */
  const edgeLayer = () => {
    const svg = buildEdgeLayer(doc());
    return { svg, el: svg as unknown as El };
  };

  it('每条父子一对画一条 `<path>`，并**整批替换**（不留上一轮的路）', () => {
    const { svg, el } = edgeLayer();

    paintEdges(svg, [
      [boxOf({ id: 'p' }), boxOf({ id: 'c1', x: 200 })],
      [boxOf({ id: 'p' }), boxOf({ id: 'c2', x: 200, y: 60 })],
    ]);
    // 2 条分支线 + **1 条延长线**（两个孩子在同一个方向，共用一条）
    expect(childrenOf(el)).toHaveLength(3);

    paintEdges(svg, []);
    expect(childrenOf(el)).toHaveLength(0);
  });

  it('★ 延长线按"父 + 方向"去重：左右各一个孩子就是两条', () => {
    const { svg, el } = edgeLayer();

    paintEdges(svg, [
      [boxOf({ id: 'p' }), boxOf({ id: 'l', x: -200 })],
      [boxOf({ id: 'p' }), boxOf({ id: 'r', x: 200 })],
    ]);

    const classes = childrenOf(el).map((child) => child.getAttribute('class'));
    expect(classes.filter((name) => name === 'nestboard-mind-edge-trunk')).toHaveLength(2);
    expect(classes.filter((name) => name === 'nestboard-mind-edge')).toHaveLength(2);
  });

  it('连线层带 `aria-hidden`（纯装饰：读屏念一遍"一条线"没有意义）', () => {
    const { svg } = edgeLayer();

    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});
