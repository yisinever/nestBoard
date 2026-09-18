/**
 * emoji 网格（`C3`）—— 纯 DOM 构件。
 *
 * 模态框那一层测不了（一 import `obsidian` 就离不了真实运行时），但"哪一格被过滤掉了、
 * 当前选中的有没有被标出来、钉在最前面那一格是不是来自输入框"全在这一层：
 *
 *  * **分组**：一格都不能少（少了就是"某个 emoji 选不中"）；
 *  * **两种过滤**：emoji ⇒ 钉一格；文字 ⇒ 按分组标题筛；
 *  * **兜底**：两种都不是时**照旧显示全部** —— 让人对着一片空白猜"是不是我打错了"
 *    比多看到几行更难受（这是最容易在重构里被顺手改掉的一条）。
 */

import { describe, expect, it, vi } from 'vitest';
import { buildEmojiGrid } from '../../ui/emojiGrid';
import { EMOJI_GROUPS } from '../../util/emoji';
import { createFakeDocument, type FakeElement } from '../helpers/fakeDom';

const doc = () => createFakeDocument() as unknown as Document;

/** 中文标题：过滤那一档要按**人打的字**测，用真名字而不是 `T:key` */
const TITLES: Record<string, string> = {
  symbols: '其他符号',
  geometry: '几何',
  office: '办公',
  status: '状态',
  docs: '文档',
  ideas: '灵感',
  time: '时间',
  people: '人物',
  nature: '自然',
  tools: '工具',
};

function build(current?: string) {
  const onPick = vi.fn();
  const grid = buildEmojiGrid(doc(), {
    current,
    titleOf: (key) => TITLES[key] ?? key,
    onPick,
  });
  return { grid, onPick, root: grid.element as unknown as FakeElement };
}

/** 分组那一节（`data-group` 只写在节上；钉在最前面那**一格**没有它） */
const sectionsOf = (root: FakeElement): FakeElement[] =>
  (root.children as FakeElement[]).filter((child) => child.dataset.group !== undefined);

const visibleSections = (root: FakeElement): string[] =>
  sectionsOf(root)
    .filter((section) => !section.classList.contains('is-hidden'))
    .map((section) => section.dataset.group ?? '');

/** 深度优先找所有满足条件的格子（假 DOM 没有 `querySelector`） */
function findAll(el: FakeElement, match: (cell: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  if (match(el)) found.push(el);
  for (const child of el.children as FakeElement[]) found.push(...findAll(child, match));
  return found;
}

const cellsOf = (root: FakeElement): FakeElement[] =>
  findAll(root, (cell) => cell.classList.contains('nestboard-emoji-cell'));

describe('buildEmojiGrid', () => {
  it('★ 一组一节、一节里是"标题 + 网格"，每组的格子数一个不少', () => {
    const { root } = build();
    const sections = sectionsOf(root);

    expect(sections).toHaveLength(EMOJI_GROUPS.length);
    EMOJI_GROUPS.forEach((group, index) => {
      const section = sections[index]!;
      expect(section.dataset.group).toBe(group.key);
      const cells = findAll(section, (cell) => cell.classList.contains('nestboard-emoji-cell'));
      expect(cells.map((cell) => cell.textContent)).toEqual([...group.emojis]);
    });
  });

  it('点一格交出那个 emoji（并挡住冒泡：这一层不该被画布 / 画板的拖动接管）', () => {
    const { root, onPick } = build();
    const cell = findAll(root, (item) => item.textContent === '🔵')[0]!;

    const down = { stopPropagation: vi.fn() } as unknown as Event;
    cell.emit('pointerdown', down);
    expect(
      (down as unknown as { stopPropagation: ReturnType<typeof vi.fn> }).stopPropagation,
    ).toHaveBeenCalledTimes(1);

    cell.emit('click', { stopPropagation: vi.fn() } as unknown as Event);
    expect(onPick).toHaveBeenCalledWith('🔵');
  });

  it('★ 当前已选的那一格带选中环（不是往里加 `✓`：加字会把格子撑变形）', () => {
    const { root } = build('⭐');
    const starred = findAll(root, (cell) => cell.textContent === '⭐');
    expect(starred.some((cell) => cell.classList.contains('is-current'))).toBe(true);
    expect(cellsOf(root).filter((cell) => cell.classList.contains('is-current'))).toHaveLength(1);
  });

  it('★ 输入框里是文字 ⇒ 按分组标题筛（"时间"只留时间那一组）', () => {
    const { grid, root } = build();
    grid.filter('时间');
    expect(visibleSections(root)).toEqual(['time']);

    grid.filter('');
    expect(visibleSections(root)).toHaveLength(EMOJI_GROUPS.length);
  });

  it('★ 输入框里是一个 emoji ⇒ 最前面钉一格"就是它"（清单里没有的也选得中）', () => {
    const { grid, root } = build();
    grid.filter('🦄');

    const pinned = cellsOf(root).filter((cell) => cell.classList.contains('is-pinned'));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.classList.contains('is-hidden')).toBe(false);
    expect(pinned[0]?.textContent).toBe('🦄');

    grid.filter('');
    expect(pinned[0]?.classList.contains('is-hidden')).toBe(true);
  });

  it('★ 两种都不是（打了一串没人匹配的字）⇒ 照旧显示全部，不给人一片空白', () => {
    const { grid, root } = build();
    grid.filter('zzz');
    expect(visibleSections(root)).toHaveLength(EMOJI_GROUPS.length);
  });
});
