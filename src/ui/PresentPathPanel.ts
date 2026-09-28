/**
 * 侧栏「演示路径」（用户 2026-09-28："演示路径的查看编辑做成可视化"）。
 *
 * ── 为什么做成侧栏面板 ──────────────────────────────────────
 *
 * 从前"路径长什么样"只活在用户的脑子里：要右键一张张卡看「加入演示 / 前移一位」，
 * 讲过一遍才知道顺序对不对。这块面板把**整条路径**摊开 —— 每行一步、能挪、能删、
 * 能点过去看，而且与演示模式联动（正在演示时当前步高亮，点某一行直接跳过去）。
 *
 * ── 三条分界（与「卡片属性」面板同一条纪律）─────────────────
 *
 * 1. **面板不碰模型**：它只通过 `PresentPathHost` 问"路径现在长什么样"、递
 *    "我要挪 / 删 / 填" —— 改由**白板视图**走它自己的 `commit`（一步撤销）。
 * 2. **单例**：整个侧栏只有一份；换一块板只是重新 `bind()`。
 * 3. **判定都在模型层**：行的顺序、悬空 id 的过滤、重编号规则全在
 *    `model/presentation.ts`（可单测）；这里只画。
 */

import { ItemView, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';

import { VIEW_TYPE_PRESENT_PATH } from '../constants';
import type { PresentRow } from '../model/presentation';
import { t } from '../util/i18n';

/** 面板与白板视图之间的窄接口（面板不认识 `BoardView`，只认识这几件事） */
export interface PresentPathHost {
  /** 现在的路径（按步骤号升序）+ 它是"编过的"还是"阅读顺序回退" */
  rows(): { rows: PresentRow[]; mode: 'explicit' | 'reading' };
  /** 正在演示到第几步（0 起）；不在演示 = `null` */
  currentStep(): number | null;
  /** 把第 `from` 步（0 起）挪到第 `to` 步（0 起） */
  reorder(from: number, to: number): void;
  move(id: string, delta: -1 | 1): void;
  remove(id: string): void;
  clear(): void;
  fillFromReadingOrder(): void;
  /** 点一行：在演示中 = 跳到那一步；否则 = 定位那个对象 */
  activate(id: string): void;
  /** 板子变了 ⇒ 重画。返回退订函数（面板关闭时必须退订，不然就是对空气重画） */
  watch(listener: () => void): () => void;
}

export class PresentPathPanelView extends ItemView {
  private host: PresentPathHost | null = null;
  private unwatch: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_PRESENT_PATH;
  }

  override getDisplayText(): string {
    return t('presentPath.title');
  }

  override getIcon(): string {
    return 'list-ordered';
  }

  override async onOpen(): Promise<void> {
    this.render();
  }

  override async onClose(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    this.host = null;
    this.contentEl.empty();
  }

  /**
   * 绑到当前白板（由插件层调，见 `main.ts` 的 `bindPresentPathPanels`）。
   *
   * ★ 参数可以是 `null`（此刻没有任何白板视图在）—— 那时画空态，**但订阅要摘掉**，
   *   否则旧板的改动还会来重画一个已经换了对象的视图。
   * ★ **同一个宿主对象重复绑 = 只重画、不重订**：`layout-change` 一响调一次，
   *   每次都重订等于把订阅表越滚越长。宿主由 `BoardView.presentPathHost()` 缓存 ⇒
   *   对象相等就是"还是那块板"。
   */
  bindHost(host: PresentPathHost | null): void {
    if (host === this.host) {
      this.render();
      return;
    }
    this.unwatch?.();
    this.unwatch = null;
    this.host = host;
    this.unwatch = host ? host.watch(() => this.render()) : null;
    this.render();
  }

  /** 绑到当前白板（老的调用口，等价于 `bindHost(host)`） */
  bind(host: PresentPathHost): void {
    this.bindHost(host);
  }

  /** 没绑到任何板（面板先开、板后开）时由 `main.ts` 补一次绑定 */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass('nestboard-present-path');

    const host = this.host;
    if (!host) {
      el.createDiv({ cls: 'nestboard-present-path-empty', text: t('presentPath.empty') });
      return;
    }

    const { rows, mode } = host.rows();

    // ── 头部：步数 + 模式徽标 + 两个全局动作 ──
    const header = el.createDiv({ cls: 'nestboard-present-path-header' });
    const badge = header.createSpan({ cls: 'nestboard-present-path-count' });
    badge.setText(
      `${t('presentPath.count', { n: rows.length })} · ${
        mode === 'explicit' ? t('presentPath.mode.explicit') : t('presentPath.mode.reading')
      }`,
    );
    const actions = header.createDiv({ cls: 'nestboard-present-path-actions' });
    this.actionButton(actions, 'list-plus', t('presentPath.fill'), () =>
      host.fillFromReadingOrder(),
    );
    this.actionButton(actions, 'trash-2', t('presentPath.clear'), () => host.clear());

    if (rows.length === 0) {
      el.createDiv({ cls: 'nestboard-present-path-empty', text: t('presentPath.empty') });
      return;
    }

    const current = host.currentStep();

    // ── 列表：一行一步 ──
    const list = el.createDiv({ cls: 'nestboard-present-path-list' });
    rows.forEach((row, index) => {
      const line = list.createDiv({ cls: 'nestboard-present-path-row' });
      line.toggleClass('is-current', current !== null && current === index);

      const title = line.createSpan({ cls: 'nestboard-present-path-title' });
      title.setText(`${row.step}. ${row.title.length > 0 ? row.title : t('presentPath.untitled')}`);
      title.addClass(row.kind === 'mind' ? 'is-mind' : 'is-card');
      // 点名字：演示中跳到那一步，否则定位
      title.addEventListener('click', () => host.activate(row.id));

      const buttons = line.createDiv({ cls: 'nestboard-present-path-row-actions' });
      this.iconButton(
        buttons,
        'arrow-up',
        t('presentPath.up'),
        () => host.move(row.id, -1),
        index === 0,
      );
      this.iconButton(
        buttons,
        'arrow-down',
        t('presentPath.down'),
        () => host.move(row.id, 1),
        index === rows.length - 1,
      );
      this.iconButton(buttons, 'trash-2', t('presentPath.remove'), () => host.remove(row.id));
    });
  }

  /**
   * 头部的小按钮（全局动作，没有禁用态）。
   *
   * ★ 图标 + 文字（用户 2026-09-28："界面需要优化一下，按钮上加图标"）：
   *   纯文字按钮一眼分不出"填入"和"清空"，加了图标才扫得动。
   */
  private actionButton(parent: HTMLElement, icon: string, label: string, run: () => void): void {
    const button = parent.createEl('button', { cls: 'nestboard-present-path-action' });
    const glyph = button.createSpan({ cls: 'nestboard-present-path-action-icon' });
    setIcon(glyph, icon);
    button.createSpan({ text: label });
    button.addEventListener('click', run);
  }

  /** 行内的图标按钮；`disabled` = 到头了（第一行不能上移） */
  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    run: () => void,
    disabled = false,
  ): void {
    const button = parent.createEl('button', {
      cls: 'nestboard-present-path-icon',
      attr: { 'aria-label': label },
    });
    setIcon(button, icon);
    button.disabled = disabled;
    button.addEventListener('click', run);
  }
}
