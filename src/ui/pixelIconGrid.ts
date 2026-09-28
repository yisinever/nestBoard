/**
 * **像素图标**的分组网格（用户 2026-09-28 第二种图标）。
 *
 * ★ 与 `emojiGrid` 分工相同（各画一页、都交给 `iconPickerPanel` 搭骨架），但**样式类
 *   自成一套**（`.nestboard-iconpicker__pixels` / `__pixel`）：像素图标要的是
 *   "**每行 8 个正方形底框**"（用户 2026-09-28 明确要求），与 emoji 那种"一个字符一格"
 *   的排法不是同一张网格 —— 共用一套类名的话，改这边的列数会连带改坏那边。
 * ★ 过滤口径：组标题命中 ⇒ 整组显隐；否则按**格子**的搜索文本（名字 + 组名）；
 *   都没命中 ⇒ 照旧显示全部（与 emojiGrid 第 2 条同一条人情味）。
 * ★ 滚轮 / 滚动条**不归本文件**：页自己滚、滚轮归面板，见 `iconPickerPanel`。
 */

import { PIXEL_ICON_GROUPS, type PixelIcon } from './icons/pixelIcons';
import { pixelIconValue, renderIconInto } from '../util/iconValue';

export interface PixelIconGridOptions {
  /** 当前已选的值（`nb:0101` 这种；空 = 没选） */
  current?: string;
  onPick: (value: string) => void;
  /**
   * 每建一格登记一次（`QuickBar` 用它记"当前值"的照表，不查 DOM）——
   * 与 emoji 那侧的 `register` 同一条口径。
   */
  register?: (cell: HTMLElement, value: string) => void;
}

export interface PixelIconGridHandle {
  element: HTMLElement;
  filter(query: string): void;
}

export function buildPixelIconGrid(
  doc: Document,
  options: PixelIconGridOptions,
): PixelIconGridHandle {
  const root = doc.createElement('div');
  root.className = 'nestboard-pixel-panel';

  interface GroupView {
    section: HTMLElement;
    title: string;
    cells: Array<{ cell: HTMLElement; search: string }>;
  }
  const groups: GroupView[] = [];

  const buildCell = (
    icon: PixelIcon,
    groupTitle: string,
  ): { cell: HTMLElement; search: string } => {
    const cell = doc.createElement('button');
    cell.type = 'button';
    cell.className = 'nestboard-iconpicker__pixel';
    const value = pixelIconValue(icon);
    cell.dataset.value = value;
    renderIconInto(cell, value);
    cell.classList.toggle('is-current', value === options.current);
    cell.title = icon.name;
    options.register?.(cell, value);
    cell.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
    cell.addEventListener('click', (event: Event) => {
      event.stopPropagation();
      options.onPick(value);
    });
    return { cell, search: `${icon.name} ${groupTitle}`.toLowerCase() };
  };

  for (const group of PIXEL_ICON_GROUPS) {
    const section = doc.createElement('section');
    section.className = 'nestboard-pixel-section';
    const heading = doc.createElement('div');
    heading.className = 'nestboard-pixel-group-title';
    heading.textContent = group.title;
    section.appendChild(heading);
    const grid = doc.createElement('div');
    grid.className = 'nestboard-iconpicker__pixels';
    const cells = group.icons.map((icon) => {
      const entry = buildCell(icon, group.title);
      grid.appendChild(entry.cell);
      return entry;
    });
    section.appendChild(grid);
    root.appendChild(section);
    groups.push({ section, title: group.title, cells });
  }

  const setVisible = (group: GroupView, visible: boolean): void => {
    group.section.classList.toggle('is-hidden', !visible);
  };

  const filter = (query: string): void => {
    const typed = query.trim().toLowerCase();
    if (typed.length === 0) {
      for (const group of groups) {
        setVisible(group, true);
        for (const entry of group.cells) entry.cell.classList.remove('is-hidden');
      }
      return;
    }
    const byTitle = groups.filter((group) => group.title.toLowerCase().includes(typed));
    if (byTitle.length > 0) {
      const visible = new Set(byTitle);
      for (const group of groups) {
        setVisible(group, visible.has(group));
        if (visible.has(group))
          for (const entry of group.cells) entry.cell.classList.remove('is-hidden');
      }
      return;
    }
    let any = false;
    for (const group of groups) {
      let hit = false;
      for (const entry of group.cells) {
        const matched = entry.search.includes(typed);
        entry.cell.classList.toggle('is-hidden', !matched);
        hit = hit || matched;
      }
      setVisible(group, hit);
      any = any || hit;
    }
    if (!any) {
      for (const group of groups) {
        setVisible(group, true);
        for (const entry of group.cells) entry.cell.classList.remove('is-hidden');
      }
    }
  };

  filter('');
  return { element: root, filter };
}
