/**
 * 待办总览浮层单元测试（T3.03 / `F2.5`）。
 *
 * 浮层本身没有业务判断（过滤 / 排序都在 `model/todos.ts` 里单测过了），
 * 这里钉的是**它与视图的契约**：
 *
 *  * 只画未完成项，空白板给空态而不是空白面板；
 *  * 点正文 = "带我去那张卡"，点复选框 = "改模型" —— 两件事必须走不同的回调；
 *  * 复选框必须 `preventDefault`：勾不勾由重画决定，不许浏览器先替我们打勾；
 *  * 只读板把复选框**禁用**，而不是"看起来能点、点了没反应"。
 */

import { describe, expect, it, vi } from 'vitest';
import { createBoardFile, createCard } from '../../model/factories';
import type { BoardFile, TodoItem } from '../../model/schema';
import { TodoOverview } from '../../ui/TodoOverview';
import { t } from '../../util/i18n';
import { type FakeElement, createFakeDocument, createFakeElement } from '../helpers/fakeDom';

function boardWith(items: TodoItem[], title = '本周'): BoardFile {
  return createBoardFile({
    cards: [createCard('todo', { title, content: { title: '', items } })],
  });
}

function setup(getBoard: () => BoardFile | null, canToggle = true) {
  const doc = createFakeDocument();
  const parent = createFakeElement(doc);
  const onPick = vi.fn();
  const onToggle = vi.fn();

  const panel = new TodoOverview(parent as unknown as HTMLElement, {
    board: getBoard,
    canToggle: () => canToggle,
    onPick,
    onToggle,
  });

  // 面板结构：root = [head, list]；head = [title, count, close]；row = [check, text, source]
  const root = parent.children[0] as FakeElement;
  const head = root.children[0] as FakeElement;
  const list = root.children[1] as FakeElement;
  return { doc, parent, panel, root, head, list, onPick, onToggle };
}

/** 取某一行里的零件 */
function parts(row: FakeElement): {
  check: {
    disabled: boolean;
    checked: boolean;
    type: string;
    emit: (t: string, e: unknown) => void;
  };
  text: FakeElement;
  source: FakeElement;
} {
  const [check, text, source] = row.children as FakeElement[];
  return {
    check: check as unknown as {
      disabled: boolean;
      checked: boolean;
      type: string;
      emit: (t: string, e: unknown) => void;
    },
    text,
    source,
  };
}

describe('显隐', () => {
  it('构造出来是收起的', () => {
    const { panel, root } = setup(() => null);
    expect(panel.isOpen).toBe(false);
    expect(root.classList.contains('is-hidden')).toBe(true);
  });

  it('show / close / toggle 来回切', () => {
    const { panel, root } = setup(() => null);

    panel.show();
    expect(panel.isOpen).toBe(true);
    expect(root.classList.contains('is-hidden')).toBe(false);

    panel.toggle();
    expect(panel.isOpen).toBe(false);

    panel.toggle();
    expect(panel.isOpen).toBe(true);
  });

  it('Esc 关掉（焦点在浮层里时画布的 Esc 管不到这里）', () => {
    const { panel, root } = setup(() => null);
    panel.show();

    root.emit('keydown', { key: 'Escape', preventDefault: vi.fn() });

    expect(panel.isOpen).toBe(false);
    expect(root.classList.contains('is-hidden')).toBe(true);
  });

  it('Esc 之外的不按键不关', () => {
    const { panel, root } = setup(() => null);
    panel.show();

    root.emit('keydown', { key: 'a', preventDefault: vi.fn() });

    expect(panel.isOpen).toBe(true);
  });

  it('dispose 把节点从父节点摘掉', () => {
    const { panel, parent } = setup(() => null);
    expect(parent.children).toHaveLength(1);

    panel.dispose();

    expect(parent.children).toHaveLength(0);
  });
});

describe('清单内容', () => {
  it('逐条画未完成项，并带上来源卡片标题', () => {
    const board = boardWith(
      [
        { text: '买牛奶', done: false },
        { text: '遛狗', done: true },
        { text: '修灯泡', done: false },
      ],
      '周末',
    );
    const { panel, list } = setup(() => board);

    panel.show();

    const rows = list.children as FakeElement[];
    expect(rows).toHaveLength(2);
    expect(parts(rows[0]).text.textContent).toBe('买牛奶');
    expect(parts(rows[0]).source.textContent).toBe('周末');
    expect(parts(rows[1]).text.textContent).toBe('修灯泡');
  });

  it('计数徽标 = 未完成条数', () => {
    const board = boardWith([
      { text: 'a', done: false },
      { text: 'b', done: true },
    ]);
    const { panel, head } = setup(() => board);

    panel.show();

    expect((head.children[1] as FakeElement).textContent).toBe('1');
  });

  it('缩进不画出来（扁平聚合里缩进无所依附）', () => {
    const board = boardWith([{ text: '  子项', done: false }]);
    const { panel, list } = setup(() => board);

    panel.show();

    expect(parts((list.children as FakeElement[])[0]).text.textContent).toBe('子项');
  });

  it('空条目不画成空白按钮，用类型名兜底', () => {
    const board = boardWith([{ text: '   ', done: false }]);
    const { panel, list } = setup(() => board);

    panel.show();

    expect(parts((list.children as FakeElement[])[0]).text.textContent).toBe(t('card.todo.item'));
  });

  it('无标题的卡片用待办类型名兜底（新建后直接开写是常态）', () => {
    const board = boardWith([{ text: 'a', done: false }], '');
    const { panel, list } = setup(() => board);

    panel.show();

    expect(parts((list.children as FakeElement[])[0]).source.textContent).toBe(t('card.type.todo'));
  });

  it('全部完成时给空态，不是一张空白面板', () => {
    const board = boardWith([{ text: 'a', done: true }]);
    const { panel, list, head } = setup(() => board);

    panel.show();

    expect(list.children).toHaveLength(1);
    expect((list.children[0] as FakeElement).textContent).toBe(t('todoOverview.empty'));
    expect((head.children[1] as FakeElement).textContent).toBe('0');
  });

  it('还没打开白板（board 为 null）也不炸，按空处理', () => {
    const { panel, list } = setup(() => null);

    expect(() => panel.show()).not.toThrow();
    expect((list.children[0] as FakeElement).textContent).toBe(t('todoOverview.empty'));
  });

  it('refresh 重画：模型变了清单跟着变', () => {
    let board = boardWith([{ text: 'a', done: false }]);
    const { panel, list } = setup(() => board);
    panel.show();
    expect(list.children).toHaveLength(1);

    board = boardWith([
      { text: 'a', done: false },
      { text: 'b', done: false },
    ]);
    panel.refresh();

    expect(list.children).toHaveLength(2);
  });

  it('重复 refresh 不会累积 DOM', () => {
    const board = boardWith([{ text: 'a', done: false }]);
    const { panel, list } = setup(() => board);

    panel.show();
    panel.refresh();
    panel.refresh();

    expect(list.children).toHaveLength(1);
  });

  it('收起状态下 refresh 也只改数据、不自己冒出来', () => {
    const board = boardWith([{ text: 'a', done: false }]);
    const { panel, root } = setup(() => board);

    panel.refresh();

    expect(panel.isOpen).toBe(false);
    expect(root.classList.contains('is-hidden')).toBe(true);
  });
});

describe('动作', () => {
  it('点正文 → onPick（浮层不碰视口）', () => {
    const board = boardWith([{ text: '买牛奶', done: false }]);
    const { panel, list, onPick } = setup(() => board);
    panel.show();

    const row = (list.children as FakeElement[])[0];
    parts(row).text.emit('click', {});

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: board.cards[0].id, index: 0, text: '买牛奶' }),
    );
  });

  it('点复选框 → onToggle，且阻止默认行为与冒泡', () => {
    const board = boardWith([{ text: '买牛奶', done: false }]);
    const { panel, list, onToggle, onPick } = setup(() => board);
    panel.show();

    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    parts((list.children as FakeElement[])[0]).check.emit('click', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));
    // 勾选不是"跳过去"，两者别串了
    expect(onPick).not.toHaveBeenCalled();
  });

  it('复选框是 checkbox 且默认不勾（清单里只放未完成的）', () => {
    const board = boardWith([{ text: 'a', done: false }]);
    const { panel, list } = setup(() => board);
    panel.show();

    const { check } = parts((list.children as FakeElement[])[0]);

    expect(check.type).toBe('checkbox');
    expect(check.checked).toBe(false);
    expect(check.disabled).toBe(false);
  });

  it('只读板：复选框禁用（不是"点了没反应"）', () => {
    const board = boardWith([{ text: 'a', done: false }]);
    const { panel, list } = setup(() => board, false);
    panel.show();

    expect(parts((list.children as FakeElement[])[0]).check.disabled).toBe(true);
  });

  it('只读板仍然可以点正文跳过去（只读的是内容，不是导航）', () => {
    const board = boardWith([{ text: 'a', done: false }]);
    const { panel, list, onPick } = setup(() => board, false);
    panel.show();

    parts((list.children as FakeElement[])[0]).text.emit('click', {});

    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
