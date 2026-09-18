/**
 * 大纲面板（`N3-a`）的**行首两件**：三角手柄与小圆点的**元素类型与类名**。
 *
 * ★ 这一组是**真实报障换来的回归线**（用户："叶子节点和展开的节点小黑点不需要底图
 *   这个还没修复"）：圆点 / 三角当初建成 `<button>`，而 Obsidian 自带的 `app.css` 里有
 *   `button:not(.clickable-icon) { background-color: var(--interactive-normal); box-shadow: … }`
 *   —— 特异性 (0,1,1) **压过**插件自己的类 (0,1,0) ⇒ 常态就顶着一层底色 + 阴影，
 *   配上 `border-radius: 50%` 就是"小黑点包在一个圈里"。
 *   修法**不是**在样式表里加 `background: none`（那压不住），而是**别当 `<button>`**
 *   （与画布那个折叠手柄同一个手法：`<span role="button" tabindex="-1">`）。
 *
 * ⇒ 所以这里断言的是**元素类型**，而不是某条样式：样式能被主题翻掉，元素类型不会。
 * 跑在仓库手写的假 DOM 上（本仓库刻意不引 jsdom，见 `vitest.config.ts`），
 * 于是不用 `querySelector`，直接顺着 `children` 走。
 */

import { describe, expect, it } from 'vitest';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';
import { createFakeDocument } from '../helpers/fakeDom';
import type { OutlineHandlers } from '../../mind/view/outline';
import { buildOutlinePanel, outlineRowsOf } from '../../mind/view/outline';

/** 假节点的最小视图（只声明这一组用例用到的字段） */
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  children: unknown[];
  attributes: Map<string, string>;
}

const asEl = (value: unknown): FakeEl => value as FakeEl;

/** 顺 `children` 找第一个带这个 class 的后代（假 DOM 没有 `querySelector`） */
function findByClass(root: unknown, className: string): FakeEl | null {
  for (const child of asEl(root).children) {
    const el = asEl(child);
    if (el.className.split(/\s+/).includes(className)) return el;
    const deeper = findByClass(el, className);
    if (deeper) return deeper;
  }
  return null;
}

/** 造一份脑图：`[标题, 父标题 | null]` */
function mindOf(shape: readonly (readonly [string, string | null])[]): MindFile {
  const file = createMindFile({ title: 'T', now: () => 'T' });
  file.nodes = shape.map(([text, parentText], index) =>
    createMindNode({
      id: `n_${text}`,
      text,
      note: '',
      parentId: parentText === null ? null : `n_${parentText}`,
      order: index,
    }),
  );
  file.rootId = `n_${shape[0]?.[0] ?? ''}`;
  return file;
}

const handlers: OutlineHandlers = {
  onToggle: () => undefined,
  onPick: () => undefined,
  onEdit: () => undefined,
  onMenu: () => undefined,
  onCrumb: () => undefined,
};

/** 渲染一份两层的图，返回"甲"那一行（有子节点）与"甲1"那一行（叶子） */
function renderTwoLevels(collapsed = false): { parentRow: FakeEl; leafRow: FakeEl } {
  const file = mindOf([
    ['中心', null],
    ['甲', '中心'],
    ['甲1', '甲'],
  ]);
  const jia = file.nodes.find((node) => node.id === 'n_甲');
  if (jia) jia.collapsed = collapsed;

  const panel = buildOutlinePanel(createFakeDocument() as unknown as Document);
  panel.render(outlineRowsOf(file), new Set(), handlers, '中心');

  const list = findByClass(panel.element, 'nestboard-mind-outline-list');
  if (!list) throw new Error('夹具坏了：没有列表');
  const rows = list.children.map(asEl);
  return { parentRow: rows[0], leafRow: rows[1] };
}

const lineOf = (row: FakeEl): FakeEl => {
  const line = findByClass(row, 'nestboard-mind-outline-line');
  if (!line) throw new Error('夹具坏了：没有这一行');
  return line;
};

describe('大纲面板的行首（`N3-a`）', () => {
  it('★★ 圆点与三角都**不是 `<button>`**（主题的 button 规则会糊上一层底，压不住）', () => {
    const { parentRow } = renderTwoLevels();
    const line = lineOf(parentRow);
    const caret = findByClass(line, 'nestboard-mind-outline-caret');
    const bullet = findByClass(line, 'nestboard-mind-outline-bullet');
    if (!caret || !bullet) throw new Error('夹具坏了：行首两件不全');

    expect(caret.tagName).toBe('SPAN');
    expect(bullet.tagName).toBe('SPAN');
    // 语义照给读屏（`role`）与"别抢焦点"（`tabindex="-1"`）
    expect(caret.attributes.get('role')).toBe('button');
    expect(bullet.attributes.get('role')).toBe('button');
    expect(caret.attributes.get('tabindex')).toBe('-1');
    expect(bullet.attributes.get('tabindex')).toBe('-1');
  });

  it('★ 收起那一行：行上有 `is-collapsed`，但**圆点上没有**（无底、不包外圈）', () => {
    const { parentRow } = renderTwoLevels(true);
    const bullet = findByClass(parentRow, 'nestboard-mind-outline-bullet');
    if (!bullet) throw new Error('夹具坏了：没有圆点');

    // 行上的这个类照旧留着（无障碍 / 将来的样式钩子）
    expect(parentRow.className.split(/\s+/)).toContain('is-collapsed');
    // ★ 圆点上**不许**有这个类（它的样式已经删了；重加就是把那层圆底带回来）
    expect(bullet.className.split(/\s+/)).not.toContain('is-collapsed');
  });

  it('★★ 那一格**每行都有**（占位），但只有有子节点的行才是"手柄"', () => {
    // 真实报障：从前是"叶子行不建这一格" ⇒ 一行**刚有孩子**时整行右跳 18px
    // （"按 tab 键有时会把父节点也一起缩进一点，实际层级没变，显示上小半格"）。
    // ⇒ 现在位置恒定，靠 `is-empty` 区分"占位"与"手柄"。
    const { parentRow, leafRow } = renderTwoLevels();
    const parentCaret = findByClass(parentRow, 'nestboard-mind-outline-caret');
    const leafCaret = findByClass(leafRow, 'nestboard-mind-outline-caret');
    if (!parentCaret || !leafCaret) throw new Error('夹具坏了：行首那一格不全');

    // 有子节点：手柄（可点、语义完整）
    expect(parentCaret.className.split(/\s+/)).not.toContain('is-empty');
    expect(parentCaret.attributes.get('role')).toBe('button');
    expect(parentCaret.attributes.get('aria-expanded')).toBe('true');

    // 叶子：**占位**（不显形、不接事件、不进读屏的按钮序）
    expect(leafCaret.className.split(/\s+/)).toContain('is-empty');
    expect(leafCaret.attributes.get('role')).toBeUndefined();
    expect(leafCaret.attributes.get('aria-expanded')).toBeUndefined();
    expect(leafCaret.textContent).toBe('');
  });

  it('三角的字形跟着收起 / 展开走，并与 `aria-expanded` 一致', () => {
    const { parentRow } = renderTwoLevels(true);
    const caret = findByClass(parentRow, 'nestboard-mind-outline-caret');
    if (!caret) throw new Error('夹具坏了：没有三角');

    expect(caret.textContent).toBe('▸');
    expect(caret.attributes.get('aria-expanded')).toBe('false');
  });

  it('行首顺序是：三角 → 圆点 → 内容列（文字的左边界由这个顺序定）', () => {
    const { parentRow } = renderTwoLevels();
    const line = lineOf(parentRow);

    expect(line.children.map((child) => asEl(child).className)).toEqual([
      'nestboard-mind-outline-caret',
      'nestboard-mind-outline-bullet',
      'nestboard-mind-outline-main',
    ]);
  });

  it('★★ 圆点上**不挂** `click` / `dblclick`（指针捕获会把它们派发给捕获元素，收不到）', () => {
    const calls: string[] = [];
    const file = mindOf([
      ['中心', null],
      ['甲', '中心'],
      ['甲1', '甲'],
    ]);

    const panel = buildOutlinePanel(createFakeDocument() as unknown as Document);
    panel.render(
      outlineRowsOf(file),
      new Set(),
      {
        ...handlers,
        onMenu: (id) => calls.push(`menu:${id}`),
        onPick: (id) => calls.push(`pick:${id}`),
        onToggle: (id) => calls.push(`toggle:${id}`),
      },
      '中心',
    );

    const list = findByClass(panel.element, 'nestboard-mind-outline-list');
    const bullet = list
      ? findByClass(asEl(list).children[0], 'nestboard-mind-outline-bullet')
      : null;
    if (!bullet) throw new Error('夹具坏了：没有圆点');

    // 假 DOM 的事件派发：只带 handler 真正用到的那几个方法
    const fake = bullet as unknown as { emit: (type: string, event: unknown) => void };
    const event = {
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
      detail: 1,
    };
    fake.emit('click', event);
    fake.emit('dblclick', event);

    // ★ 一条都不该有：圆点上的单击 / 双击**全部**归视图的指针状态机管 ——
    //   真正的报障就是"单击没菜单、双击没效果"（挂在 click 上的手势压根收不到），
    //   而拖拽好用（pointer 事件照样收得到），正是指针捕获的形状。
    expect(calls).toEqual([]);
  });

  it('★ 右键这一行 = 这一行的菜单（`N3-e` 起菜单从这儿出）', () => {
    const calls: string[] = [];
    const file = mindOf([
      ['中心', null],
      ['甲', '中心'],
    ]);

    const panel = buildOutlinePanel(createFakeDocument() as unknown as Document);
    panel.render(
      outlineRowsOf(file),
      new Set(),
      { ...handlers, onMenu: (id) => calls.push(`menu:${id}`) },
      '中心',
    );

    const list = findByClass(panel.element, 'nestboard-mind-outline-list');
    const row = list ? asEl(list).children[0] : null;
    if (!row) throw new Error('夹具坏了：没有行');

    (row as unknown as { emit: (type: string, event: unknown) => void }).emit('contextmenu', {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });

    expect(calls).toEqual(['menu:n_甲']);
  });
});
