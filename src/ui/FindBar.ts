/**
 * 查找 / 替换**浮条**（用户 2026-09-28："参考 obsidian 原生的 md 的查找替换功能……
 * 它原生的功能是在画布上出现一个查找框"）。
 *
 * ── 形（与原生同一个形）────────────────────────────────────
 *
 * ```
 * 🔍 [查找…………]  1/5  ↑ ↓ Aa ⇄ ✕
 *    ⇄ [替换为………]  ⟨替换⟩ ⟨全部替换⟩      ← 点 ⇄ 才展开
 * ```
 *
 * ── 分界 ────────────────────────────────────────────────────
 *
 * ★ 浮条**不认识白板、也不认识脑图**：扫描 / 高亮 / 飞视野 / 写回四件事全由宿主
 *   （`FindBarHost`）实现，它只管画与键位。两处（白板 / `.nestmind`）共用同一个构件。
 * ★ 「当前第几处」的**计数以宿主为准**（模型层的命中总数，含屏外那些），浮条只显示。
 * ★ `Enter` 下一个、`⇧Enter` 上一个、`Esc` 关闭 —— 与原生的手感一致。
 */

import { setIcon } from 'obsidian';

import { t } from '../util/i18n';

/** 浮条与视图之间的窄接口 */
export interface FindBarHost {
  /** 用当前条件重新扫描；返回命中总数（宿主自己记住命中列表，供 `focusMatch` / `replaceAt` 用） */
  scan(query: string, matchCase: boolean): number;
  /** 切到第 `index` 处（0 起）：飞进视野 + 高亮当前 + 编辑态里选中 */
  focusMatch(index: number): void;
  /** 替换第 `index` 处；返回是否有改动（宿主负责提交 ⇒ 一步撤销） */
  replaceAt(index: number, replacement: string): boolean;
  /** 全部替换；返回是否有改动 */
  replaceAll(query: string, replacement: string, matchCase: boolean): boolean;
  /** 关闭（宿主负责清高亮 / 拆掉浮条） */
  onClose(): void;
}

export class FindBar {
  readonly element: HTMLElement;
  private readonly findInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly counter: HTMLElement;
  private readonly replaceRow: HTMLElement;
  private query = '';
  private replacement = '';
  private matchCase = false;
  private total = 0;
  private index = -1;

  constructor(
    doc: Document,
    private readonly host: FindBarHost,
  ) {
    const root = doc.createElement('div');
    root.className = 'nestboard-findbar';

    const row = doc.createElement('div');
    row.className = 'nestboard-findbar__row';

    const search = doc.createElement('span');
    search.className = 'nestboard-findbar__icon';
    setIcon(search, 'search');
    row.appendChild(search);

    this.findInput = doc.createElement('input');
    this.findInput.type = 'text';
    this.findInput.className = 'nestboard-findbar__input';
    this.findInput.placeholder = t('findReplace.find');
    row.appendChild(this.findInput);

    this.counter = doc.createElement('span');
    this.counter.className = 'nestboard-findbar__counter';
    row.appendChild(this.counter);

    this.replaceRow = doc.createElement('div');
    this.replaceRow.className = 'nestboard-findbar__row is-hidden';
    const swap = doc.createElement('span');
    swap.className = 'nestboard-findbar__icon';
    setIcon(swap, 'repeat');
    this.replaceRow.appendChild(swap);
    this.replaceInput = doc.createElement('input');
    this.replaceInput.type = 'text';
    this.replaceInput.className = 'nestboard-findbar__input';
    this.replaceInput.placeholder = t('findReplace.replace');
    this.replaceRow.appendChild(this.replaceInput);
    this.replaceRow.appendChild(this.button(doc, 'replace', '', () => this.doReplace()));
    this.replaceRow.appendChild(this.button(doc, 'replace-all', '', () => this.doReplaceAll()));

    row.appendChild(this.button(doc, 'arrow-up', '', () => this.step(-1)));
    row.appendChild(this.button(doc, 'arrow-down', '', () => this.step(1)));
    const caseButton = this.button(doc, 'case-sensitive', '', () => {
      this.matchCase = !this.matchCase;
      caseButton.classList.toggle('is-active', this.matchCase);
      this.rescan();
    });
    row.appendChild(caseButton);
    row.appendChild(
      this.button(doc, 'replace', '', () => {
        this.replaceRow.classList.toggle('is-hidden');
        if (!this.replaceRow.classList.contains('is-hidden')) this.replaceInput.focus();
      }),
    );
    row.appendChild(this.button(doc, 'x', '', () => this.host.onClose()));

    root.appendChild(row);
    root.appendChild(this.replaceRow);
    this.element = root;

    this.findInput.addEventListener('input', () => {
      this.query = this.findInput.value;
      this.rescan();
    });
    this.findInput.addEventListener('keydown', (event) => this.onKey(event, 'find'));
    this.replaceInput.addEventListener('input', () => {
      this.replacement = this.replaceInput.value;
    });
    this.replaceInput.addEventListener('keydown', (event) => this.onKey(event, 'replace'));
    this.updateCounter();
  }

  /** 把焦点给查找框（打开浮条时调） */
  focus(): void {
    this.findInput.focus();
    this.findInput.select();
  }

  /**
   * 重扫并刷新计数（宿主改完模型之后调）。
   *
   * ★ 索引**夹回范围**：替换掉最后一处之后索引会越界，不夹的话"当前"会指向不存在的一处。
   */
  refresh(): void {
    this.rescan();
  }

  private rescan(): void {
    this.total = this.host.scan(this.query, this.matchCase);
    if (this.total === 0) {
      this.index = -1;
    } else {
      this.index = Math.min(Math.max(this.index, 0), this.total - 1);
      this.host.focusMatch(this.index);
    }
    this.updateCounter();
  }

  private step(delta: 1 | -1): void {
    if (this.total === 0) return;
    // 到头**停住**（不绕回另一端）：与演示模式那条同一条理由 —— 绕回会让人失去方位感
    this.index = Math.min(Math.max(this.index + delta, 0), this.total - 1);
    this.host.focusMatch(this.index);
    this.updateCounter();
  }

  private doReplace(): void {
    if (this.index < 0) return;
    if (!this.host.replaceAt(this.index, this.replacement)) return;
    this.rescan();
  }

  private doReplaceAll(): void {
    if (this.query.length === 0) return;
    if (!this.host.replaceAll(this.query, this.replacement, this.matchCase)) return;
    this.rescan();
  }

  private onKey(event: KeyboardEvent, from: 'find' | 'replace'): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.host.onClose();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (from === 'replace') {
      this.doReplace();
      return;
    }
    this.step(event.shiftKey ? -1 : 1);
  }

  private updateCounter(): void {
    this.counter.textContent =
      this.total === 0 ? '0/0' : `${Math.max(this.index, 0) + 1}/${this.total}`;
    this.counter.classList.toggle('is-empty', this.total === 0);
  }

  /** 一个小图标按钮（`aria-label` 由图标名给：浮条上没有文字按钮） */
  private button(doc: Document, icon: string, label: string, run: () => void): HTMLElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'nestboard-findbar__button';
    button.setAttribute('aria-label', label.length > 0 ? label : icon);
    setIcon(button, icon);
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run();
    });
    return button;
  }
}
