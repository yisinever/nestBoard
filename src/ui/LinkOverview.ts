/**
 * 断链总览浮层（T3.19 / `F8-07`）。
 *
 * 与 `TodoOverview` 同理、同形：断链这件事在画布上**只有点开每一张卡才知道** ——
 * 引用卡安静地显示"文件不存在"，图卡显示一个破图图标，但"整块板一共断了几处、
 * 都是哪几张"没人回答得了。这个浮层把它拍平。
 *
 * ★ 数据由 `entries()` 现取、点击靠 `onPick` 回调：浮层不认识白板、也不认识 Vault
 *   （Vault 存在性判断在视图层），所以它能在 node 下被单测，也不会因为引用模型
 *   变化而重写（与 `Breadcrumb` / `TodoOverview` 同一条边界）。
 */

import type { CardRef, RefKind } from '../model/links';
import type { MessageKey } from '../util/i18n';
import { t } from '../util/i18n';

export interface LinkOverviewOptions {
  /**
   * 取**当前**断链清单。
   *
   * ★ 做成函数而不是构造时传一份：浮层开着的过程中用户可能修好一条、撤销、
   *   或切到别的白板 —— 每次重画都重新取，清单才不会停留在打开那一刻。
   */
  entries(): readonly CardRef[];
  /** 点某一条：视图负责把视口挪到那张卡并高亮（浮层不碰视口） */
  onPick(ref: CardRef): void;
  /**
   * 「修复引用」（T4.07）此刻是否可用。省略 = 不显示这个按钮。
   *
   * ★ 由视图（而不是本浮层）回答：可不可修取决于"是不是只读板""有没有
   *   可按文件名重连的断链"，而这两件事浮层一概不知道（它只认识 `CardRef`）。
   * ★ 每次 `refresh` 都重新问：用户可能刚刚把这个板锁上，或者刚手工修好最后一条。
   */
  canRepair?(): boolean;
  /** 点「修复引用」：视图负责开清单、落地、提示（浮层不碰 Vault） */
  onRepair?(): void;
}

export class LinkOverview {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;
  /** 只在视图提供了 `onRepair` 时才存在（本浮层也被别的场景复用，没这个功能就没有这个按钮） */
  private readonly repairEl: HTMLButtonElement | null = null;
  private visible = false;

  constructor(
    parent: HTMLElement,
    private readonly options: LinkOverviewOptions,
  ) {
    // ★ 从父节点取 ownerDocument（跨窗口安全，与 `TodoOverview` 同理）
    this.doc = parent.ownerDocument;
    this.root = this.doc.createElement('aside');
    this.root.className = 'nestboard-link-overview';
    this.root.classList.add('is-hidden');
    this.root.setAttribute('aria-label', t('linkOverview.title'));
    parent.appendChild(this.root);

    const head = this.doc.createElement('header');
    head.className = 'nestboard-link-overview-head';

    const title = this.doc.createElement('span');
    title.className = 'nestboard-link-overview-title';
    title.textContent = t('linkOverview.title');

    this.countEl = this.doc.createElement('span');
    this.countEl.className = 'nestboard-link-overview-count';

    const close = this.doc.createElement('button');
    close.type = 'button';
    close.className = 'nestboard-link-overview-close';
    close.textContent = '×';
    close.setAttribute('aria-label', t('linkOverview.close'));
    close.addEventListener('click', () => this.close());

    // 「修复引用」（T4.07）：断链清单是用户**唯一**会盯着看的地方，所以入口就摆在这儿
    // —— 命令面板里也有，但"看到一屏断链"与"知道有一条命令能修它们"之间隔着一次搜索。
    if (this.options.onRepair) {
      const repair = this.doc.createElement('button');
      repair.type = 'button';
      repair.className = 'nestboard-link-overview-repair';
      repair.textContent = t('linkOverview.repair');
      repair.setAttribute('aria-label', t('linkOverview.repair'));
      repair.addEventListener('click', () => this.options.onRepair?.());
      this.repairEl = repair;
    }

    // ★ 用条件展开而不是 `append(title, count, repair, close)`：真的 `append(null)`
    //   会往 DOM 里塞一个文本节点 "null"（假 DOM 照单全收，于是只有真机会露馅）
    head.append(title, this.countEl, ...(this.repairEl ? [this.repairEl] : []), close);

    this.listEl = this.doc.createElement('div');
    this.listEl.className = 'nestboard-link-overview-list';

    this.root.append(head, this.listEl);

    this.root.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key !== 'Escape') return;
      event.preventDefault();
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

  /** 重画。**幂等**：可以反复调，不会累积 DOM */
  refresh(): void {
    const entries = this.options.entries();
    this.countEl.textContent = String(entries.length);

    // ★ 藏（`hidden`）而不是禁用：一条都修不了的时候（只读板、只剩 URL 类断链），
    //   一个灰着的按钮只会让人反复去点它问"为什么不行"
    if (this.repairEl) this.repairEl.hidden = !(this.options.canRepair?.() ?? true);

    // 一次 replaceChildren，避免"清空 → 重建"之间闪过一帧空列表
    this.listEl.replaceChildren();

    if (entries.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'nestboard-link-overview-empty';
      empty.textContent = t('linkOverview.empty');
      this.listEl.appendChild(empty);
      return;
    }

    for (const ref of entries) this.listEl.appendChild(this.renderRow(ref));
  }

  dispose(): void {
    this.root.remove();
  }

  // ── 内部 ────────────────────────────────────────────────────

  private renderRow(ref: CardRef): HTMLElement {
    const row = this.doc.createElement('button');
    row.type = 'button';
    row.className = 'nestboard-link-overview-row';

    const reason = this.doc.createElement('span');
    reason.className = 'nestboard-link-overview-reason';
    reason.textContent = t(REASON_KEYS[ref.kind]);
    row.appendChild(reason);

    const body = this.doc.createElement('span');
    body.className = 'nestboard-link-overview-body';

    const source = this.doc.createElement('span');
    source.className = 'nestboard-link-overview-source';
    const label = ref.cardTitle.trim();
    source.textContent = label.length > 0 ? label : t(`card.type.${ref.cardType}` as MessageKey);
    body.appendChild(source);

    const path = this.doc.createElement('span');
    path.className = 'nestboard-link-overview-path';
    path.textContent = ref.path;
    path.title = ref.path;
    body.appendChild(path);

    row.appendChild(body);

    // ★ `pointerdown` 而不是 `click`：与 `SearchPanel` 的结果行同理 ——
    //   清单可能因为外部变化被重建，`click` 要等"按下 + 抬起"完整走完，
    //   中间那一帧按钮可能已经不在文档里，事件就丢了
    row.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.options.onPick(ref);
    });

    return row;
  }
}

/** 断链原因文案：与 `linkOverview.reason.*` 一一对应 */
const REASON_KEYS: Record<RefKind, MessageKey> = {
  image: 'linkOverview.reason.image',
  file: 'linkOverview.reason.file',
  noteRef: 'linkOverview.reason.noteRef',
  boardRef: 'linkOverview.reason.boardRef',
  link: 'linkOverview.reason.link',
};
