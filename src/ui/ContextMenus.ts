/**
 * 右键菜单的**渲染层**（T1.41 卡片菜单 / T1.34 空白菜单 / O11 视图「更多」菜单）。
 *
 * 规格（长什么样、点了做什么）在 `view/interact/cardMenu.ts` 与
 * `view/interact/viewMenu.ts` 里，是纯数据；本文件只干一件事：把它塞进 Obsidian 的 `Menu`。
 *
 * ★ 合规（`04 §13`）：一律用 Obsidian 的 `Menu` —— 自绘 div 菜单在 iPad 上点不中、
 *   在弹出窗口里错位、主题一换就瞎眼，且拿不到系统的键盘导航。
 *   O11 说的"走自有 DOM"指的是**触发按钮**（不去碰 `leaf.view.addAction` 那类私有
 *   leaf header API），菜单本体照样交给 `Menu`。
 */

import { Menu } from 'obsidian';
import type { App, MenuItem } from 'obsidian';
import type { MenuItemSpec } from '../view/interact/cardMenu';
import type { HexColor } from '../model/schema';
import { ColorPickerModal } from './modals/ColorPickerModal';

/**
 * 我们自己的菜单上的标记类（`F2` 拟物档只认它）。
 *
 * ★ 为什么必须有个标记、而不是直接写 `.menu`：`.menu` 是**全 Obsidian 的**菜单
 *   （别的插件、文件浏览器、标签页右键都用它）。拟物是个"卡片外观档"，把它套到
 *   宿主与别人家的菜单上属于越界 —— 只给自己开的菜单加这个类，边界就干净了。
 * ★ 注入进 Obsidian「⋯」菜单的那些项（`appendMenuItems`）**不加**：那个菜单是宿主的，
 *   我们只是往里塞了几项（它自己还放着"左右分屏"那些）。
 */
export const NESTBOARD_MENU_CLASS = 'nestboard-menu';

/**
 * 给菜单打上标记类。
 *
 * ★ `Menu.dom` 在本版 `obsidian.d.ts` 里**没有声明** ⇒ 运行时探测（与下面
 *   `showAtPosition` 的探测同一条纪律：拿不到就退，而不是让插件挂掉）。
 *   拿不到的代价只是"这个菜单没换皮"，不影响任何功能。
 */
function markAsOurs(menu: Menu): void {
  const dom = (menu as unknown as { dom?: HTMLElement }).dom;
  if (dom && typeof dom.classList?.add === 'function') dom.classList.add(NESTBOARD_MENU_CLASS);
}

/** 在鼠标位置弹出菜单（空白处 / 卡片上的右键都走它） */
export function showMenuAtMouse(event: MouseEvent, items: readonly MenuItemSpec[]): void {
  const menu = new Menu();
  appendItems(menu, items);
  markAsOurs(menu);
  menu.showAtMouseEvent(event);
}

/**
 * 在指定屏幕坐标弹出菜单（T3.21 长按）。
 *
 * ★ 为什么需要它：长按触发时手里只有"手指按在哪儿"这个坐标，
 *   **没有 `MouseEvent`** —— 移动端的长按压根不经过 `contextmenu`。
 *   拿一个假事件去凑 `showAtMouseEvent` 也能跑，但一旦将来要传真实事件属性
 *   （`shiftKey` / `target`）就会造出"看起来是真的、其实是编的"的事件。
 *
 * ★ `showAtPosition` 在旧版 `obsidian.d.ts` 里可能没有声明 —— 所以运行时探测，
 *   拿不到就退回"在同一个坐标上派发一个 `contextmenu`"，效果一样。
 */
export function showMenuAtPoint(
  point: { x: number; y: number },
  items: readonly MenuItemSpec[],
): void {
  present(new Menu(), items, point);
}

/**
 * 把一批**菜单规格**塞进一个已经存在的 Obsidian `Menu`（用户 2026-09-17）。
 *
 * ★ 从前的宿主是"我们自绘的那枚「⋯」浮标"（`O11`，连 `showMenuAtAnchor` 一起删了）；
 *   用户要求把菜单**注入 Obsidian 自己的「…」**（`View.onPaneMenu`）⇒ 现在这个函数就是
 *   那条路的入口：宿主菜单由 Obsidian 给（它自己已经放了"左右分屏 / 上下分屏"），
 *   我们只往上加自己的几项。
 * ★ 分隔线、子菜单、置灰规则全由 `MenuItemSpec` 说了算 —— 与右键菜单共用同一套，
 *   于是"我们的菜单长什么样"只有一处定义（`view/interact/viewMenu.ts` 那张纯规格表）。
 */
export function appendMenuItems(menu: Menu, items: readonly MenuItemSpec[]): void {
  appendItems(menu, items);
}

/**
 * 建菜单 → 填项 → 弹在某个屏幕坐标上。
 *
 * ★ `showAtPosition` 在旧版 `obsidian.d.ts` 里可能没有声明 —— 所以运行时探测，
 *   拿不到就退回"在同一个坐标上派发一个 `contextmenu`"，效果一样。
 */
function present(
  menu: Menu,
  items: readonly MenuItemSpec[],
  point: { x: number; y: number },
): void {
  appendItems(menu, items);
  markAsOurs(menu);

  const candidate = menu as Menu & {
    showAtPosition?: (position: { x: number; y: number }) => void;
  };
  if (typeof candidate.showAtPosition === 'function') {
    candidate.showAtPosition({ x: point.x, y: point.y });
    return;
  }
  menu.showAtMouseEvent(
    new MouseEvent('contextmenu', { clientX: point.x, clientY: point.y, bubbles: true }),
  );
}

/** 弹系统取色器；确定后回调（取消则什么都不发生） */
export function pickColor(
  app: App,
  current: string | null,
  apply: (color: HexColor) => void,
): void {
  new ColorPickerModal(app, current, apply).open();
}

function appendItems(menu: Menu, items: readonly MenuItemSpec[]): void {
  for (const item of items) {
    if (item.separatorBefore) menu.addSeparator();
    if (item.children && item.children.length > 0) appendBranch(menu, item);
    else menu.addItem((entry) => configure(entry, item));
  }
}

/**
 * 带子菜单的项。
 *
 * ★ `MenuItem.setSubmenu()` 是**较新**的 API，且并非所有版本的 `obsidian.d.ts`
 *   都声明了它 —— 所以这里用运行时探测，而不是直接调用：
 *   拿不到就把这一项退化成"分组标题"、把子项**平铺**到父菜单。
 *   菜单少一层嵌套，总好过点开一片空白（旧版本上真正的失败模式）。
 */
function appendBranch(menu: Menu, item: MenuItemSpec): void {
  const children = item.children ?? [];
  let submenu: Menu | null = null;

  menu.addItem((entry) => {
    entry.setTitle(item.title);
    if (item.icon) entry.setIcon(item.icon);

    const candidate = entry as MenuItem & { setSubmenu?: () => Menu };
    if (typeof candidate.setSubmenu === 'function') {
      try {
        submenu = candidate.setSubmenu();
      } catch {
        submenu = null;
      }
    }
    if (!submenu) {
      entry.setIsLabel(true);
      entry.setDisabled(true);
    }
  });

  if (submenu) appendItems(submenu, children);
  else appendItems(menu, children);
}

function configure(entry: MenuItem, item: MenuItemSpec): void {
  entry.setTitle(item.title);
  if (item.icon) entry.setIcon(item.icon);
  if (item.checked !== undefined) entry.setChecked(item.checked);

  if (item.disabled || !item.run) {
    entry.setDisabled(true);
    return;
  }
  entry.onClick(() => item.run?.());
}
