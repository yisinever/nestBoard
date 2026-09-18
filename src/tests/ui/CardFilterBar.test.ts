/**
 * 画布过滤条的单元测试（T3.17 / T3.18 / `F8-04` / `F8-06`）。
 *
 * 条子本身不该有业务判断（判据在 `model/filter.ts` 里测过了），所以这里钉的是
 * **它与视图的契约**：
 *
 *  * 状态**单向**流：控件动作 → `onChange`，条子自己从不修改条件；
 *  * `onChange` 之后必须立刻把自己回填成"传来的那个状态"（计数要跟上）；
 *  * 值不同才写 `input.value`：每敲一个字都重设会把光标顶到末尾；
 *  * Esc / `×` 关闭，且 `清除` 是"清条件"、`×` 是"收面板"——两件事不能混。
 */

import { describe, expect, it, vi } from 'vitest';
import { FILTERABLE_TYPES, NO_FILTER, type CardFilter } from '../../model/filter';
import { CardFilterBar } from '../../ui/CardFilterBar';
import { t } from '../../util/i18n';
import {
  type FakeElement,
  type FakeTextarea,
  createFakeDocument,
  createFakeElement,
  createFakeTextarea,
} from '../helpers/fakeDom';

function setup(counts = { matched: 4, total: 4 }) {
  const doc = createFakeDocument();
  const createElement = doc.createElement.bind(doc);
  // ★ 过滤条上的两个 `<input>` 需要 value / checked / focus / setSelectionRange；
  //   最短的"可输入假节点"就是 `createFakeTextarea`，直接借来用
  doc.createElement = (tag: string) =>
    tag === 'input' ? createFakeTextarea(doc) : createElement(tag);

  const parent = createFakeElement(doc);
  const onChange = vi.fn();
  // ★ 用"状态盒子"而不是 `let + getter`：解构 `get current()` 会在解构那一刻就求值，
  //   拿到的永远是构造时那个对象，后续 `onChange` 换了引用也读不到
  const state: { value: CardFilter } = { value: { ...NO_FILTER, types: new Set() } };

  const bar = new CardFilterBar(parent as unknown as HTMLElement, {
    filter: () => state.value,
    counts: () => counts,
    // 视图的职责：先更新状态、再让条子回填（测试里照做，否则回填读到的还是旧值）
    onChange: (next) => {
      state.value = next;
      onChange(next);
    },
  });
  // 构造之后先按状态回填一次：真实视图里紧随其后就是首次 `applyBoard`
  bar.refresh();

  const root = parent.children[0] as FakeElement;
  const head = root.children[0] as FakeElement;
  const input = root.children[1] as unknown as FakeTextarea;
  const typesRow = root.children[2] as FakeElement;
  const optionsRow = root.children[3] as FakeElement;
  const [title, countEl, clear, close] = head.children as FakeElement[];
  const [brokenLabel] = optionsRow.children as FakeElement[];
  const broken = brokenLabel.children[0] as unknown as FakeTextarea;
  const chips = typesRow.children as FakeElement[];

  return {
    doc,
    parent,
    bar,
    root,
    title,
    countEl,
    clear,
    close,
    input,
    chips,
    broken,
    onChange,
    state,
  };
}

/** 芯片顺序与 `FILTERABLE_TYPES` 严格对应 */
function chipOf(chips: FakeElement[], type: string): FakeElement {
  const index = FILTERABLE_TYPES.indexOf(type as never);
  return chips[index];
}

describe('显隐', () => {
  it('构造出来是收起的', () => {
    const { bar, root } = setup();
    expect(bar.isOpen).toBe(false);
    expect(root.classList.contains('is-hidden')).toBe(true);
  });

  it('show 把焦点给输入框，close / toggle 来回切', () => {
    const { bar, root, input } = setup();

    bar.show();
    expect(bar.isOpen).toBe(true);
    expect(root.classList.contains('is-hidden')).toBe(false);
    // 打开就是为了敲字：焦点不给输入框等于让用户再点一下
    expect(input.focused).toBe(true);

    bar.toggle();
    expect(bar.isOpen).toBe(false);

    bar.toggle();
    expect(bar.isOpen).toBe(true);
  });

  it('Esc 关掉，并且不让画布再吃一遍这个 Esc', () => {
    const { bar, root } = setup();
    bar.show();

    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    root.emit('keydown', event);

    expect(bar.isOpen).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('dispose 把节点从父节点摘掉', () => {
    const { bar, parent } = setup();
    expect(parent.children).toHaveLength(1);

    bar.dispose();

    expect(parent.children).toHaveLength(0);
  });
});

describe('输入框', () => {
  it('敲字把 query 交出去', () => {
    const { input, onChange, state } = setup();

    input.value = '周报';
    input.emit('input', {});

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(state.value.query).toBe('周报');
  });

  it('回填时值真的变了才写（同值不写以免顶光标）', () => {
    const { input, bar } = setup();
    input.value = '旧值';

    bar.refresh();

    // 条件里 query 是空串，与 '旧值' 不同 → 必须纠正回来
    expect(input.value).toBe('');
  });

  it('只有空格也算不活跃，但输入框仍然保留用户敲的那一个空格', () => {
    const { input, onChange, state } = setup();

    input.value = ' ';
    input.emit('input', {});

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(state.value.query).toBe(' ');
  });
});

describe('类型芯片', () => {
  it('点一下加上、再点一下去掉', () => {
    const { chips, onChange, state } = setup();

    chipOf(chips, 'todo').emit('click', {});
    expect([...state.value.types]).toEqual(['todo']);
    expect(chipOf(chips, 'todo').classList.contains('is-active')).toBe(true);

    chipOf(chips, 'todo').emit('click', {});
    expect([...state.value.types]).toEqual([]);
    expect(chipOf(chips, 'todo').classList.contains('is-active')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('可多选', () => {
    const { chips, state } = setup();

    chipOf(chips, 'image').emit('click', {});
    chipOf(chips, 'link').emit('click', {});

    expect([...state.value.types].sort()).toEqual(['image', 'link']);
  });
});

describe('只看断链', () => {
  it('勾选把 onlyBroken 交出去', () => {
    const { broken, onChange, state } = setup();

    broken.checked = true;
    broken.emit('change', {});

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(state.value.onlyBroken).toBe(true);
  });
});

describe('清除与关闭是两件事', () => {
  it('清除：清掉条件，面板还开着', () => {
    const { clear, onChange, bar, state } = setup();
    bar.show();
    clear.emit('click', {});

    expect(state.value.query).toBe('');
    expect(state.value.types.size).toBe(0);
    expect(state.value.onlyBroken).toBe(false);
    expect(bar.isOpen).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('×：收起面板，条件不动（关掉不该顺手把用户的过滤也抹了）', () => {
    const { close, bar, onChange, state } = setup();
    bar.show();
    close.emit('click', {});

    expect(bar.isOpen).toBe(false);
    expect(state.value.query).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('计数', () => {
  it('不活跃时只显示总数', () => {
    const { countEl } = setup({ matched: 4, total: 4 });
    expect(countEl.textContent).toBe('4');
  });

  it('活跃时显示 N / M', () => {
    const { input, countEl } = setup({ matched: 1, total: 4 });

    input.value = '周报';
    input.emit('input', {});

    expect(countEl.textContent).toBe(t('filter.count', { count: 1, total: 4 }));
  });
});
