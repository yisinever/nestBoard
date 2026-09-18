/**
 * 手绘工具条单元测试（T3.07 / `F4-02`、T7.07 / `F4-06`、T7.08 / `F4-07`）。
 *
 * 这里验的全是"手指点上去之后，工具条自己那一面"的规矩 —— 谁高亮、哪颗按钮藏起来、
 * 哪一颗"在但点不动"、点的到底派发给了谁。它们**只有一半在真机上看得见**：
 * 按钮确实会亮，但"为什么这一颗此刻不该亮"是读代码才有的结论，
 * 而这一层最容易在改动中悄悄失守（新加一支笔忘了同步高亮、清空按钮的显隐条件写漏一半）。
 *
 * ★ 跑在 node 下（没有 DOM）：用的是 `helpers/fakeDom` 那套最小假节点。
 *   于是断言只能看"写了哪些 class / 属性 / style"，看不了像素 —— 那是 `styles.css` 的事。
 * ★ 点击用**假事件目标**驱动：真实的 `click` 冒泡在假 DOM 里不存在，
 *   但 `InkBar.onClick` 只用到目标身上的 `closest()` 与 `disabled`，
 *   给一个带 `closest()` 的桩就等于"点了哪颗按钮"。
 */

import { describe, expect, it, vi } from 'vitest';
import { OVERLAY_UI_ATTR } from '../../constants';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';
import { InkBar, type InkBarOptions } from '../../ui/InkBar';
import { DEFAULT_INK_WIDTH_INDEX, defaultInkToolState, type InkTool } from '../../model/ink';

function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [root];
  for (const child of root.children) {
    const node = child as Partial<FakeElement>;
    if (Array.isArray(node.children)) out.push(...descendants(node as FakeElement));
  }
  return out;
}

function mustFind(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement {
  const found = descendants(root).find(predicate);
  if (!found) throw new Error('工具条里没有找到目标按钮');
  return found;
}

interface Ctx {
  bar: InkBar;
  root: FakeElement;
  setTool: (tool: InkTool) => void;
  setAnnotations: (count: number) => void;
  click: (button: FakeElement) => void;
  onTool: ReturnType<typeof vi.fn>;
  onClear: ReturnType<typeof vi.fn>;
  toolButton: (tool: InkTool) => FakeElement;
  clearButton: FakeElement;
}

function setup(): Ctx {
  const doc = createFakeDocument();
  const parent = createFakeElement(doc);
  const state = defaultInkToolState();
  const onTool = vi.fn();
  const onClear = vi.fn();
  let tool: InkTool = 'brush';
  let annotations = 0;

  const options: InkBarOptions = {
    state: () => state,
    tool: () => tool,
    onColor: vi.fn(),
    onCustomColor: vi.fn(),
    onWidth: vi.fn(),
    onTool,
    onClear,
    annotations: () => annotations,
  };

  const bar = new InkBar(parent as unknown as HTMLElement, options);
  const root = parent.children[0] as FakeElement;
  const toolButton = (which: InkTool): FakeElement =>
    mustFind(root, (node) => node.dataset.tool === which);
  const clearButton = mustFind(root, (node) => node.dataset.action === 'clear');

  return {
    bar,
    root,
    onTool,
    onClear,
    toolButton,
    clearButton,
    setTool: (next) => {
      tool = next;
    },
    setAnnotations: (count) => {
      annotations = count;
    },
    // 真实的 click 冒泡在假 DOM 里没有，但 `onClick` 只需要目标身上的 `closest()`：
    // 给一个"就地返回某颗按钮"的桩，等价于"点了那一颗"
    click: (button) => root.emit('click', { target: { closest: () => button } }),
  };
}

// ── 构造 ────────────────────────────────────────────────

describe('手绘工具条 · 构造', () => {
  it('三支笔按"最常用 → 最临时"排好，且每支都带无障碍名（图标是画出来的，读屏只剩 aria-label）', () => {
    const { root, toolButton } = setup();
    const tools = descendants(root).filter((node) =>
      node.classList.contains('nestboard-ink-bar__tool'),
    );

    expect(tools.map((node) => node.dataset.tool)).toEqual(['brush', 'marker', 'annotate']);
    for (const which of ['brush', 'marker', 'annotate'] as const) {
      expect(toolButton(which).getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('每支笔都挂了图标（`__tip`）：没有它按钮就是三个空方块', () => {
    const { root } = setup();

    const tips = descendants(root).filter((node) =>
      node.classList.contains('nestboard-ink-bar__tip'),
    );

    expect(tips).toHaveLength(3);
  });

  it('「清空」初始就是"藏着 + 点不动"：`render()` 之前它绝不该有机会被点到', () => {
    const { clearButton } = setup();

    expect(clearButton.hidden).toBe(true);
    expect(clearButton.disabled).toBe(true);
  });

  it('★ 整条工具条带 `OVERLAY_UI_ATTR`：不标的话"点一下换颜色"会顺手在画布上落一个点', () => {
    const { root } = setup();

    expect(root.getAttribute(OVERLAY_UI_ATTR)).toBe('');
    expect(root.getAttribute(OVERLAY_UI_ATTR)).not.toBeNull();
  });
});

// ── render：笔型高亮 ────────────────────────────────────

describe('手绘工具条 · 笔型高亮', () => {
  it('高亮当前那一支，并把选中态同时写进 `aria-pressed`（class 只是它的视觉投影）', () => {
    const ctx = setup();

    ctx.setTool('marker');
    ctx.bar.render();

    expect(ctx.toolButton('marker').classList.contains('is-active')).toBe(true);
    expect(ctx.toolButton('marker').getAttribute('aria-pressed')).toBe('true');
    for (const other of ['brush', 'annotate'] as const) {
      expect(ctx.toolButton(other).classList.contains('is-active')).toBe(false);
      expect(ctx.toolButton(other).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('★ 幂等：反复 render 不会把高亮叠成好几支笔亮着', () => {
    const ctx = setup();

    ctx.setTool('annotate');
    ctx.bar.render();
    ctx.bar.render();

    expect(ctx.toolButton('annotate').classList.contains('is-active')).toBe(true);
    expect(ctx.toolButton('brush').classList.contains('is-active')).toBe(false);
  });

  it('★ `is-annotating`（虚线边）只跟着标注态走，换回画笔就摘掉', () => {
    const ctx = setup();

    ctx.setTool('annotate');
    ctx.bar.render();
    expect(ctx.root.classList.contains('is-annotating')).toBe(true);

    ctx.setTool('brush');
    ctx.bar.render();
    expect(ctx.root.classList.contains('is-annotating')).toBe(false);
  });
});

// ── render：「清空」的显隐与可点性（T7.07 最容易写漏的一处）──

describe('手绘工具条 · 「清空」的两段式规矩', () => {
  it('画笔态 + 零笔迹 = 完全收起：此时它只是一颗占着位置的 ✕', () => {
    const ctx = setup();

    ctx.setTool('brush');
    ctx.setAnnotations(0);
    ctx.bar.render();

    expect(ctx.clearButton.hidden).toBe(true);
    expect(ctx.clearButton.disabled).toBe(true);
  });

  it('★ 切回画笔但临时笔迹还在 → 仍然显示**并且点得动**：那是唯一能清掉它们的入口', () => {
    const ctx = setup();

    ctx.setTool('brush');
    ctx.setAnnotations(2);
    ctx.bar.render();

    expect(ctx.clearButton.hidden).toBe(false);
    expect(ctx.clearButton.disabled).toBe(false);
    expect(ctx.clearButton.getAttribute('aria-disabled')).toBe('false');
  });

  it('★ 刚进标注态、一笔都没有 → 显示但点不动：位置绝不跳（"点了没反应"好过"按钮忽然不见"）', () => {
    const ctx = setup();

    ctx.setTool('annotate');
    ctx.setAnnotations(0);
    ctx.bar.render();

    expect(ctx.clearButton.hidden).toBe(false);
    expect(ctx.clearButton.disabled).toBe(true);
    expect(ctx.clearButton.getAttribute('aria-disabled')).toBe('true');
  });

  it('标注态 + 有笔迹 → 显示且可点', () => {
    const ctx = setup();

    ctx.setTool('annotate');
    ctx.setAnnotations(1);
    ctx.bar.render();

    expect(ctx.clearButton.hidden).toBe(false);
    expect(ctx.clearButton.disabled).toBe(false);
  });
});

// ── 点击委托 ────────────────────────────────────────────

describe('手绘工具条 · 点击派发', () => {
  it('点某支笔 → 只把"换了哪支笔"送出去（工具条自己不认识 `InkController`）', () => {
    const ctx = setup();

    ctx.click(ctx.toolButton('marker'));

    expect(ctx.onTool).toHaveBeenCalledWith('marker');
    expect(ctx.onClear).not.toHaveBeenCalled();
  });

  it('点「清空」→ 走清空回调，不顺手再换一次笔', () => {
    const ctx = setup();
    ctx.setAnnotations(1);
    ctx.bar.render();

    ctx.click(ctx.clearButton);

    expect(ctx.onClear).toHaveBeenCalledTimes(1);
    expect(ctx.onTool).not.toHaveBeenCalled();
  });

  it('★ 点不动的那颗（没有笔迹可清）不派发：`aria-disabled` 之外还欠脚本派发一条生路', () => {
    const ctx = setup();
    ctx.setAnnotations(0);
    ctx.bar.render();

    ctx.click(ctx.clearButton);

    expect(ctx.onClear).not.toHaveBeenCalled();
  });

  it('★ 不属于这条工具条的按钮一律不接（委托要校验归属，否则将来嵌进别处会吃别人的点击）', () => {
    const ctx = setup();
    const orphan = createFakeElement(createFakeDocument());
    orphan.dataset.tool = 'annotate';

    ctx.click(orphan);

    expect(ctx.onTool).not.toHaveBeenCalled();
  });

  it('★ 事件目标不是元素（`document` / `null`）时安静退出，不抛', () => {
    const { root, onTool } = setup();

    expect(() => root.emit('click', { target: null })).not.toThrow();
    expect(() => root.emit('click', { target: { closest: undefined } })).not.toThrow();
    expect(onTool).not.toHaveBeenCalled();
  });
});

// ── 状态写入 ────────────────────────────────────────────

describe('手绘工具条 · render 写出去的状态', () => {
  it('当前笔色写到根节点上的 CSS 变量：一排笔宽圆点与荧光笔图标都跟着它变色', () => {
    const { root, bar } = setup();

    bar.render();

    expect(root.style.getPropertyValue('--nestboard-ink-swatch')).toBe(defaultInkToolState().color);
  });

  it('笔宽高亮跟着 `widthIndex` 走，且**恰好一颗**亮着（多亮一颗等于没说选了多粗）', () => {
    const { root, bar } = setup();

    bar.render();

    const active = descendants(root).filter(
      (node) =>
        node.classList.contains('nestboard-ink-bar__width') && node.classList.contains('is-active'),
    );
    expect(active).toHaveLength(1);
    expect(active[0].dataset.widthIndex).toBe(String(DEFAULT_INK_WIDTH_INDEX));
  });
});

// ── 显隐与销毁 ──────────────────────────────────────────

describe('手绘工具条 · 显隐与销毁', () => {
  it('setVisible(false) 加 `is-hidden`、true 摘掉（橡皮态的收起走这条）', () => {
    const { root, bar } = setup();

    bar.setVisible(true);
    expect(root.classList.contains('is-hidden')).toBe(false);

    bar.setVisible(false);
    expect(root.classList.contains('is-hidden')).toBe(true);
  });

  it('dispose 把自己从父节点摘掉（视图关掉时不留下一条悬空的工具条）', () => {
    const doc = createFakeDocument();
    const parent = createFakeElement(doc);
    const bar = new InkBar(parent as unknown as HTMLElement, {
      state: defaultInkToolState,
      tool: (): InkTool => 'brush',
      onColor: vi.fn(),
      onCustomColor: vi.fn(),
      onWidth: vi.fn(),
      onTool: vi.fn(),
      onClear: vi.fn(),
      annotations: () => 0,
    } satisfies InkBarOptions);

    bar.dispose();

    expect(parent.children).toHaveLength(0);
  });
});
