/**
 * 面包屑导航（T1.62 / `F2-8-4`、`F2-8-5`）。
 *
 * 它只干两件事：把"我在哪一层"画出来、把点击翻译成导航意图。
 * **它不认识 Obsidian，也不认识白板文件**：层级链由视图沿 `meta.parent` 解析好之后喂进来，
 * 跳转由回调注入。这样它既能在单测里跑，也不会因为将来换导航方式而重写。
 *
 * ★ 层级链来自 `meta.parent`（白板 → 父白板），**不是文件夹层级**。
 *   按目录拼出来的"层级"点下去是打不开的（那个路径根本不是 `.nboard`），
 *   这种"看着能点、点了报错"的面包屑比没有面包屑更糟。
 *
 * ★ 折叠超长链路时保留**最后三项**：面包屑的价值在于指出"我在哪、上一级是什么"，
 *   越靠近根的祖先越不重要 —— 而中间截断 + 一个 `…` 恰好保住这两件事。
 */

import { t } from '../util/i18n';

/** 链路上的一层：一个真实存在、可跳转的白板 */
export interface TrailNode {
  /** 目标白板路径 */
  path: string;
  /** 显示文本（调用方决定用标题还是文件名） */
  title: string;
}

/** 面包屑的一项 */
export interface BreadcrumbItem {
  /** 显示文本（已 i18n 化） */
  label: string;
  /** 目标白板路径；`null` = 不可点（当前位置 / 纯位置指示） */
  path: string | null;
}

export interface BreadcrumbOptions {
  /** 点某一项 → 请视图切过去 */
  onNavigate: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  /** 用于判"能不能再后退/前进"，`false` 时按钮 `disabled` */
  canGoBack: () => boolean;
  canGoForward: () => boolean;
}

/** 链路上最多直接显示几层（不含 Home）；超出部分折叠成 `…` */
export const MAX_TRAIL_NODES = 3;

/**
 * 由「父级链」拼出层级列表（纯函数）。
 *
 * `chain` 由视图沿 `meta.parent` 逐级向上解析后给出：**从最顶层祖先开始，
 * 最后一项是当前白板**。首项之前补一个 Home 作位置指示（不可点）。
 * 空 `path` 的项直接跳过（防御脏数据：`meta.parent` 是可以被手改的）。
 */
export function buildTrail(homeLabel: string, chain: readonly TrailNode[]): BreadcrumbItem[] {
  const nodes = chain.filter((node) => node.path !== '');
  const items: BreadcrumbItem[] = [{ label: homeLabel, path: null }];
  nodes.forEach((node, index) => {
    // 最后一项是当前白板：点自己不该触发导航（点了也只会"重新加载一下"，白闪一屏）
    items.push({ label: node.title, path: index === nodes.length - 1 ? null : node.path });
  });
  return items;
}

/** 折叠结果：实际渲染的项 + 被折掉的项（`…` 的跳转目标取被折项里最靠前的那一层） */
export interface TrailLayout {
  /** Home（永远显示） */
  home: BreadcrumbItem;
  /** 被折掉的中间层；空数组 = 无需折叠 */
  collapsed: BreadcrumbItem[];
  /** 实际显示的链路项（含当前白板） */
  visible: BreadcrumbItem[];
}

/** 按 `MAX_TRAIL_NODES` 折叠（纯函数，可单测） */
export function layoutTrail(items: readonly BreadcrumbItem[]): TrailLayout {
  const [home, ...chain] = items;
  const safeHome = home ?? { label: '', path: null };
  const overflow = chain.length - MAX_TRAIL_NODES;
  if (overflow <= 0) return { home: safeHome, collapsed: [], visible: [...chain] };
  return {
    home: safeHome,
    collapsed: chain.slice(0, overflow),
    visible: chain.slice(overflow),
  };
}

export class Breadcrumb {
  private readonly doc: Document;
  private readonly root: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly options: BreadcrumbOptions,
  ) {
    // ★ 从父节点取 `ownerDocument` 而不是用全局 `document`：
    //   视图可能被挂到一个独立窗口（弹出窗口 / 未来的移动端分屏），
    //   而全局 `document` 永远是主窗口的那个 —— 跨窗口建元素会直接抛错。
    this.doc = parent.ownerDocument;
    this.root = this.doc.createElement('nav');
    this.root.className = 'nestboard-breadcrumb';
    this.root.setAttribute('aria-label', t('breadcrumb.ariaLabel'));
    parent.appendChild(this.root);

    // 事件用**委托**绑在根节点上一次：链路每跳一次都会重建，逐项绑就要逐项解绑，
    // 漏一处就是"点了跳两次"这种鬼问题
    this.root.addEventListener('click', (event) => this.onClick(event));
  }

  /** 重画（路径或历史变化时调用）。**幂等**：可以反复调，不会累积 DOM */
  render(homeLabel: string, chain: readonly TrailNode[]): void {
    const layout = layoutTrail(buildTrail(homeLabel, chain));
    this.root.replaceChildren();

    this.root.appendChild(this.historyButton('back', '←', this.options.canGoBack()));
    this.root.appendChild(this.historyButton('forward', '→', this.options.canGoForward()));
    this.root.appendChild(this.item(layout.home));
    this.root.appendChild(this.separator());

    // 被折掉的层级：`…` 本身可点，目标是"被折掉的最靠前那一层"——
    // 那正好是用户想往回走时最先需要的一跳
    if (layout.collapsed.length > 0) {
      const target = layout.collapsed.find((entry) => entry.path !== null) ?? null;
      const ellipsis = this.doc.createElement('button');
      ellipsis.type = 'button';
      ellipsis.className = 'nestboard-breadcrumb-item is-ellipsis';
      ellipsis.textContent = '…';
      ellipsis.title = layout.collapsed.map((entry) => entry.label).join(' / ');
      if (target && target.path !== null) ellipsis.setAttribute('data-path', target.path);
      else ellipsis.disabled = true;
      this.root.appendChild(ellipsis);
      this.root.appendChild(this.separator());
    }

    layout.visible.forEach((entry, index) => {
      this.root.appendChild(this.item(entry));
      if (index < layout.visible.length - 1) this.root.appendChild(this.separator());
    });
  }

  /** 只更新前进/后退的可用态（`render` 里已经调过一次，视口历史变化时可单独调） */
  updateHistoryButtons(): void {
    const back = this.root.querySelector<HTMLButtonElement>('[data-nav="back"]');
    const forward = this.root.querySelector<HTMLButtonElement>('[data-nav="forward"]');
    if (back) back.disabled = !this.options.canGoBack();
    if (forward) forward.disabled = !this.options.canGoForward();
  }

  /** 完整路径（给 `title` 提示用）：折叠之后光看 `…` 是认不出这是哪块板的 */
  setFullPathTip(path: string): void {
    this.root.setAttribute('title', path);
  }

  dispose(): void {
    this.root.remove();
  }

  // ── 内部 ────────────────────────────────────────────────

  private historyButton(action: 'back' | 'forward', glyph: string, disabled: boolean): HTMLElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'nestboard-breadcrumb-btn';
    button.setAttribute('data-nav', action);
    button.textContent = glyph;
    button.disabled = disabled;
    button.setAttribute(
      'aria-label',
      t(action === 'back' ? 'command.navigateBack.name' : 'command.navigateForward.name'),
    );
    return button;
  }

  private separator(): HTMLElement {
    const sep = this.doc.createElement('span');
    sep.className = 'nestboard-breadcrumb-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '/';
    return sep;
  }

  private item(entry: BreadcrumbItem): HTMLElement {
    if (entry.path === null) {
      // 当前位置用 `span` 而不是禁用按钮：禁用按钮在深色主题里几乎看不出文字，
      // 而"我在哪"恰恰是这一项必须一眼看清的信息
      const current = this.doc.createElement('span');
      current.className = 'nestboard-breadcrumb-item is-current';
      current.setAttribute('aria-current', 'page');
      current.textContent = entry.label;
      return current;
    }
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'nestboard-breadcrumb-item';
    button.textContent = entry.label;
    button.setAttribute('data-path', entry.path);
    return button;
  }

  private onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !this.root.contains(target)) return;

    const nav = target.closest<HTMLElement>('[data-nav]')?.getAttribute('data-nav');
    if (nav === 'back') {
      event.preventDefault();
      this.options.onBack();
      return;
    }
    if (nav === 'forward') {
      event.preventDefault();
      this.options.onForward();
      return;
    }

    const path = target.closest<HTMLElement>('[data-path]')?.getAttribute('data-path');
    if (!path) return;
    event.preventDefault();
    this.options.onNavigate(path);
  }
}
