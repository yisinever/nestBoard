/**
 * 画布过滤条（T3.17 / T3.18 / `F8-04` / `F8-06`）。
 *
 * 与 `TodoOverview` 同一套挂载方式（视图根节点、屏幕坐标系、`board()` 现取），
 * 但使命不同：那个是"列清单"，这个是"调条件"。所以它**常驻在屏幕上**（不抢焦点、
 * 不遮画布），用户一边敲词一边看画布上哪些卡在变淡。
 *
 * ★ 过滤器状态**不放在这里**：`options.filter()` 现取、`onChange` 交出去。
 *   条子只负责"输入控件 ↔ 状态"的翻译，谁拥有状态、谁负责重画卡片都由视图决定。
 *   于是这块 UI 与它所在的视图之间只隔着两个纯函数式的回调，可以单测。
 * ★ 不回写 `input.value`（除非值真的变了）：每敲一个字都重设 value 会把光标顶到末尾，
 *   用户改中间的一个字就会被打断 —— 这是"输入框直觉"里最容易被忽略的一条。
 */

import { FILTERABLE_TYPES, NO_FILTER, isFilterActive, type CardFilter } from '../model/filter';
import type { CardType } from '../model/schema';
import { t } from '../util/i18n';
import type { MessageKey } from '../util/i18n';

export interface CardFilterBarOptions {
  /** 取当前过滤器（每次重画都现取，与 `TodoOverviewOptions.board` 同理） */
  filter(): CardFilter;
  /** 匹配情况，用于"N / M"标签 */
  counts(): { matched: number; total: number };
  /** 条件变化：视图负责更新状态并把结果同步到卡片外观 */
  onChange(filter: CardFilter): void;
}

export class CardFilterBar {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly inputEl: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private readonly brokenEl: HTMLInputElement;
  private readonly chips = new Map<CardType, HTMLButtonElement>();
  private visible = false;

  constructor(
    parent: HTMLElement,
    private readonly options: CardFilterBarOptions,
  ) {
    this.doc = parent.ownerDocument;

    this.root = this.doc.createElement('aside');
    this.root.className = 'nestboard-filter-bar';
    this.root.classList.add('is-hidden');
    this.root.setAttribute('aria-label', t('filter.title'));
    parent.appendChild(this.root);

    const head = this.doc.createElement('header');
    head.className = 'nestboard-filter-bar-head';

    const title = this.doc.createElement('span');
    title.className = 'nestboard-filter-bar-title';
    title.textContent = t('filter.title');

    this.countEl = this.doc.createElement('span');
    this.countEl.className = 'nestboard-filter-bar-count';

    const clear = this.doc.createElement('button');
    clear.type = 'button';
    clear.className = 'nestboard-filter-bar-clear';
    clear.textContent = t('filter.clear');
    clear.addEventListener('click', () => this.emit(NO_FILTER));

    const close = this.doc.createElement('button');
    close.type = 'button';
    close.className = 'nestboard-filter-bar-close';
    close.textContent = '×';
    close.setAttribute('aria-label', t('filter.clear'));
    close.addEventListener('click', () => this.close());

    head.append(title, this.countEl, clear, close);

    this.inputEl = this.doc.createElement('input');
    this.inputEl.type = 'text';
    this.inputEl.className = 'nestboard-filter-input';
    this.inputEl.placeholder = t('filter.placeholder');
    this.inputEl.spellcheck = false;
    this.inputEl.autocomplete = 'off';
    this.inputEl.addEventListener('input', () =>
      this.emit({ ...this.options.filter(), query: this.inputEl.value }),
    );

    const typesRow = this.doc.createElement('div');
    typesRow.className = 'nestboard-filter-types';
    for (const type of FILTERABLE_TYPES) {
      const chip = this.doc.createElement('button');
      chip.type = 'button';
      chip.className = 'nestboard-filter-chip';
      chip.textContent = t(`card.type.${type}` as MessageKey);
      chip.addEventListener('click', () => this.toggleType(type));
      this.chips.set(type, chip);
      typesRow.appendChild(chip);
    }

    const optionsRow = this.doc.createElement('div');
    optionsRow.className = 'nestboard-filter-options';

    const brokenLabel = this.doc.createElement('label');
    brokenLabel.className = 'nestboard-filter-broken';
    this.brokenEl = this.doc.createElement('input');
    this.brokenEl.type = 'checkbox';
    this.brokenEl.addEventListener('change', () =>
      this.emit({ ...this.options.filter(), onlyBroken: this.brokenEl.checked }),
    );
    const brokenText = this.doc.createElement('span');
    brokenText.textContent = t('filter.broken');
    brokenLabel.append(this.brokenEl, brokenText);

    const hint = this.doc.createElement('span');
    hint.className = 'nestboard-filter-hint';
    hint.textContent = t('filter.hint');
    optionsRow.append(brokenLabel, hint);

    this.root.append(head, this.inputEl, typesRow, optionsRow);

    // Esc 关掉（与浮层一致的习惯）。stopPropagation 免得画布把同一个 Esc 吃了去做别的事
    this.root.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.visible;
  }

  show(): void {
    this.visible = true;
    this.root.classList.remove('is-hidden');
    this.refresh();
    this.inputEl.focus();
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('is-hidden');
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.show();
  }

  /** 从 `options.filter()` 回填控件外观。**幂等**，可以随每次重画调用 */
  refresh(): void {
    const filter = this.options.filter();
    // ★ 值不同才写：写 value 会把光标顶到末尾，正在打字的人会被打断
    if (this.inputEl.value !== filter.query) this.inputEl.value = filter.query;
    this.brokenEl.checked = filter.onlyBroken;
    for (const [type, chip] of this.chips) {
      chip.classList.toggle('is-active', filter.types.has(type));
    }
    const { matched, total } = this.options.counts();
    const narrow = isFilterActive(filter);
    this.countEl.textContent = narrow
      ? t('filter.count', { count: matched, total })
      : String(total);
  }

  dispose(): void {
    this.root.remove();
  }

  // ── 内部 ────────────────────────────────────────────────────

  private toggleType(type: CardType): void {
    const types = new Set(this.options.filter().types);
    if (types.has(type)) types.delete(type);
    else types.add(type);
    this.emit({ ...this.options.filter(), types });
  }

  /** 把新状态交出去，然后**立刻**回填自己的显示（计数要跟上） */
  private emit(next: CardFilter): void {
    this.options.onChange(next);
    this.refresh();
  }
}
