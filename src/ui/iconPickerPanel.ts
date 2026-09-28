/**
 * **图标选择面板**（`2.1.5`；用户 2026-09-28："这里的整个组件最好规划一下重写"）。
 *
 * ── 它替换掉的那一版 ─────────────────────────────────────────
 *
 * 从前是**两处各写一遍**：白板卡的标记走 `IconPickerModal`（自己搭标签页 + 搜索 +
 * 网格宿主），脑图节点的标记走 `QuickBar` 里那条自建弹层（自己搭标签页 + 分组行）。
 * 两处各有一条"滚动条"的做法，于是同一件事出现了两种观感 —— 用户切到第二页时
 * 出现两根滚动条、整个框还会跳一下高度、滚到底还能滚出框外。
 *
 * ── 这一版的四条几何规矩（重写的全部理由）────────────────────
 *
 * 1. **视口高度固定**（`__viewport`）：两页共用一块固定高的窗口 —— 切页时
 *    整个 UI 的尺寸**不变**（从前是"哪一页高就长成哪一页"，切过去要跳一下）。
 * 2. **每页自己滚**（`__page` 绝对定位铺满视口 + `overflow-y: auto`）：任何时刻
 *    只有**一根**滚动条，而且两页各记各的滚动位置（翻回上一页还在原处）。
 *    `overscroll-behavior: contain` 让"滚到头继续滚"不外溢给后面的容器。
 * 3. **滚轮归面板**：页上带 {@link WHEEL_SCROLL_ATTR}，画布那层
 *    （`BoardView.onCanvasWheelCapture` → `scrollBodyUnder`）会把滚轮让给它 ——
 *    用户在面板上滚滚轮**不会**缩放 / 平移画布（用户 2026-09-28 的原话）。
 * 4. **两页的标签在顶上**（横排），第一页 = 传统 emoji、第二页 = 复古游戏机。
 *
 * ── 分界 ────────────────────────────────────────────────────
 *
 * ★ 本文件只搭"容器 + 两个标签页 + 搜索框"，两页的内容分别由 `emojiGrid`
 *   （emoji 分组网格）与 `pixelIconGrid`（像素图标网格）画 —— 与从前同一条分工，
 *   只是"谁负责搭骨架"从两个调用方收敛到这里一处。
 * ★ 不 import `obsidian`：纯 DOM，可在假 DOM 下单测（见 `tests/ui/iconPickerPanel.test.ts`）。
 */

import type { EmojiGroupKey } from '../util/emoji';
import { buildEmojiGrid } from './emojiGrid';
import { buildPixelIconGrid } from './pixelIconGrid';

/** 两页的 id（也是标签的顺序） */
export type IconPickerTab = 'emoji' | 'pixel';

export const ICON_PICKER_TABS: readonly IconPickerTab[] = ['emoji', 'pixel'];

/**
 * "滚轮归我"的标记属性。
 *
 * ★ 值是**空串**：它只是一个"自报家门"的记号（选择器 `[data-nestboard-wheel-scroll]`），
 *   不携带数据 —— 用属性而不是类名，是为了不被样式层的重构顺手删掉。
 */
export const WHEEL_SCROLL_ATTR = 'data-nestboard-wheel-scroll';

export interface IconPickerPanelOptions {
  /** 当前已选的值（emoji 字 / `nb:0101`；空 = 没选）：格子上画一圈选中环 */
  current?: string;
  /** 打开时停在哪一页（默认第一页 = emoji） */
  initialTab?: IconPickerTab;
  /** 两个标签的文案（**已经翻译过**：本文件不认识 i18n） */
  tabLabels: Record<IconPickerTab, string>;
  /** 搜索框的占位文字（不给就不设） */
  searchPlaceholder?: string;
  /** emoji 分组标题（已翻译，交给 `emojiGrid`） */
  emojiTitleOf: (key: EmojiGroupKey) => string;
  onPick: (value: string) => void;
  /**
   * 每建一格登记一次（脑图工具栏的弹层用它做"当前值"的照表，不查 DOM）。
   * ★ 只登记**有意义的值**（空串不登记）—— 见 `emojiGrid` 里那一格的说明。
   */
  register?: (cell: HTMLElement, value: string) => void;
}

export interface IconPickerPanelHandle {
  /** 面板根节点（调用方负责插进自己的容器） */
  element: HTMLElement;
  /** 切到某一页（同时更新标签的选中态） */
  showTab(tab: IconPickerTab): void;
  /** 当前停在哪一页 */
  activeTab(): IconPickerTab;
  /** 按搜索框的内容重算两页的可见性（空串 = 全部可见） */
  filter(query: string): void;
  /** 把焦点交给搜索框（打开面板时调） */
  focusSearch(): void;
}

export function buildIconPickerPanel(
  doc: Document,
  options: IconPickerPanelOptions,
): IconPickerPanelHandle {
  const root = doc.createElement('div');
  root.className = 'nestboard-iconpicker';

  // ── 标签行（横排，两个） ──
  const tabs = doc.createElement('div');
  tabs.className = 'nestboard-iconpicker__tabs';

  // ── 搜索框（两页共用：切页时词**留着**，于是"换个页接着筛"是自然的） ──
  const search = doc.createElement('input');
  search.type = 'text';
  search.className = 'nestboard-iconpicker__search';
  if (options.searchPlaceholder !== undefined) {
    search.placeholder = options.searchPlaceholder;
  }

  // ── 视口 + 两页 ──
  // ★ 视口**固定高**、页**绝对定位铺满**它：两页的滚动互不影响，外层一个像素都不滚
  const viewport = doc.createElement('div');
  viewport.className = 'nestboard-iconpicker__viewport';

  const pages = new Map<IconPickerTab, HTMLElement>();
  for (const tab of ICON_PICKER_TABS) {
    const page = doc.createElement('div');
    page.className = 'nestboard-iconpicker__page';
    page.dataset.tab = tab;
    // ★ 自报家门：画布那层读到它就把滚轮让给这一页（见文件头第 3 条）
    page.setAttribute(WHEEL_SCROLL_ATTR, '');
    pages.set(tab, page);
    viewport.appendChild(page);
  }

  // ── 两页的内容 ──
  const emojiGrid = buildEmojiGrid(doc, {
    current: options.current,
    titleOf: options.emojiTitleOf,
    onPick: options.onPick,
    register: options.register,
  });
  const pixelGrid = buildPixelIconGrid(doc, {
    current: options.current,
    onPick: options.onPick,
    register: options.register,
  });
  pages.get('emoji')?.appendChild(emojiGrid.element);
  pages.get('pixel')?.appendChild(pixelGrid.element);

  // ── 标签页的开关 ──
  const buttons = new Map<IconPickerTab, HTMLElement>();
  let active: IconPickerTab = options.initialTab ?? 'emoji';

  const showTab = (tab: IconPickerTab): void => {
    active = tab;
    for (const [key, button] of buttons) button.classList.toggle('is-active', key === tab);
    for (const [key, page] of pages) page.classList.toggle('is-hidden', key !== tab);
  };

  for (const tab of ICON_PICKER_TABS) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'nestboard-iconpicker__tab';
    button.textContent = options.tabLabels[tab];
    button.addEventListener('click', (event: Event) => {
      // 浮层挂在画布上时，点击会冒泡到画布的"取消选中 / 长按菜单"那几条路上
      event.stopPropagation();
      showTab(tab);
    });
    buttons.set(tab, button);
    tabs.appendChild(button);
  }

  // ── 搜索：两页一起筛（当前页看不到另一半，但切过去时它是筛好的） ──
  const filter = (query: string): void => {
    emojiGrid.filter(query);
    pixelGrid.filter(query);
  };
  search.addEventListener('input', () => filter(search.value));
  search.addEventListener('pointerdown', (event: Event) => event.stopPropagation());

  root.appendChild(tabs);
  root.appendChild(search);
  root.appendChild(viewport);
  showTab(active);

  return {
    element: root,
    showTab,
    activeTab: () => active,
    filter,
    focusSearch: () => search.focus(),
  };
}
