/**
 * **像素图标**的分组网格（用户 2026-09-28 第二种图标）。
 *
 * ★ 与 `emojiGrid` 同一套样式类（`.nestboard-emoji-*`）⇒ 观感天然一致；
 *   单独一个构件而不去改造 emoji 那份，是因为两边的"格子内容"不同
 *   （emoji 是一个字符、像素图标是一枚 SVG + 一个 `nb:` 值）—— 硬塞同一个构件
 *   要加三条可选回调，不如各自五十行。
 * ★ 过滤口径：组标题命中 ⇒ 整组显隐；否则按**格子**的搜索文本（名字 + 组名）；
 *   都没命中 ⇒ 照旧显示全部（与 emojiGrid 第 2 条同一条人情味）。
 */

import { PIXEL_ICON_GROUPS, type PixelIcon } from './icons/pixelIcons';
import { pixelIconValue, renderIconInto } from '../util/iconValue';

export interface PixelIconGridOptions {
  /** 当前已选的值（`nb:0101` 这种；空 = 没选） */
  current?: string;
  onPick: (value: string) => void;
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
  root.className = 'nestboard-emoji-panel';

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
    cell.className = 'nestboard-emoji-cell';
    const value = pixelIconValue(icon);
    cell.dataset.value = value;
    renderIconInto(cell, value);
    cell.classList.toggle('is-current', value === options.current);
    cell.title = icon.name;
    cell.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
    cell.addEventListener('click', (event: Event) => {
      event.stopPropagation();
      options.onPick(value);
    });
    return { cell, search: `${icon.name} ${groupTitle}`.toLowerCase() };
  };

  for (const group of PIXEL_ICON_GROUPS) {
    const section = doc.createElement('section');
    section.className = 'nestboard-emoji-section';
    const heading = doc.createElement('div');
    heading.className = 'nestboard-emoji-group-title';
    heading.textContent = group.title;
    section.appendChild(heading);
    const grid = doc.createElement('div');
    grid.className = 'nestboard-emoji-grid';
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
