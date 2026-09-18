/**
 * 「修复引用」的确认清单（T4.07 / `03 §9 R10`）。
 *
 * 白板被复制 / 移动到另一个 Vault 之后，卡片里存的相对路径全废、文件却还在。
 * 匹配规则在 `io/refRepair.ts`（纯函数、有单测），这里只负责让用户**逐条确认**。
 *
 * ★ 为什么必须有这一步：同名匹配是一个猜测，而猜错的代价比断链本身更高 ——
 *   断链在卡片上有标记、在总览里列得出来；指错文件的引用长得完全正常，
 *   用户会盯着别人的图以为自己在看这张。所以这里默认勾选的**只有同名档位**，
 *   其余档位一律留空让用户自己判断。
 * ★ 每行都摆出"旧路径 → 新路径"两条完整路径：用户对着看一眼就知道对不对，
 *   而我们（插件）没有任何办法替他看这一眼。
 */

import { Modal, type App } from 'obsidian';
import {
  DEFAULT_CHECKED_QUALITIES,
  type MatchQuality,
  type RefRepair,
  type RefRepairPlan,
} from '../../io/refRepair';
import { t, type MessageKey } from '../../util/i18n';

/** 档位 → 徽章文案。★ 定义在这里而不是拼字符串：`t` 的键是静态检查的 */
const QUALITY_LABEL_KEY: Record<MatchQuality, MessageKey> = {
  sameName: 'modal.repairRefs.quality.sameName',
  sameNameIgnoreCase: 'modal.repairRefs.quality.sameNameIgnoreCase',
  normalizedName: 'modal.repairRefs.quality.normalizedName',
  similarName: 'modal.repairRefs.quality.similarName',
};

export interface RefRepairModalOptions {
  plan: RefRepairPlan;
  /** 用户确认后回调（**只含勾选的**）。空数组不会回调 —— 按钮这时是禁用的 */
  onConfirm: (repairs: RefRepair[]) => void;
}

export class RefRepairModal extends Modal {
  /** 勾选的卡片 id。★ 用 id 而不是下标：列表顺序将来可能变，下标会错位到别的卡上 */
  private readonly selected = new Set<string>();
  private confirmButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: RefRepairModalOptions,
  ) {
    super(app);
    for (const suggestion of options.plan.suggestions) {
      if (DEFAULT_CHECKED_QUALITIES.includes(suggestion.quality)) {
        this.selected.add(suggestion.cardId);
      }
    }
  }

  override onOpen(): void {
    const { plan } = this.options;
    this.contentEl.addClass('nestboard-modal', 'nestboard-ref-repair-modal');
    this.setTitle(t('modal.repairRefs.title'));

    this.contentEl.createEl('p', { cls: 'nestboard-modal-desc', text: t('modal.repairRefs.desc') });
    this.contentEl.createDiv({
      cls: 'nestboard-repair-summary',
      text: t('modal.repairRefs.summary', {
        found: plan.suggestions.length,
        unmatched: plan.unmatched.length,
      }),
    });

    const list = this.contentEl.createDiv({ cls: 'nestboard-repair-list' });
    for (const suggestion of plan.suggestions) {
      const row = list.createDiv({ cls: 'nestboard-repair-row' });

      const box = row.createEl('input', { type: 'checkbox' });
      box.checked = this.selected.has(suggestion.cardId);
      box.addEventListener('change', () => {
        if (box.checked) this.selected.add(suggestion.cardId);
        else this.selected.delete(suggestion.cardId);
        this.syncConfirmButton();
      });

      const body = row.createDiv({ cls: 'nestboard-repair-body' });
      const head = body.createDiv({ cls: 'nestboard-repair-head' });
      head.createSpan({
        cls: 'nestboard-repair-title',
        text:
          suggestion.cardTitle.length > 0
            ? suggestion.cardTitle
            : t('modal.repairRefs.untitledCard'),
      });
      head.createSpan({
        cls: `nestboard-repair-quality is-${suggestion.quality}`,
        text: t(QUALITY_LABEL_KEY[suggestion.quality]),
      });
      if (suggestion.alternatives > 0) {
        // 不做下拉：同名文件多于一个时"哪个才对"只有用户知道，而挑错的代价是静默指错。
        // 告诉他"不是唯一解"就够了，精确指定走卡片右键的「重新链接」
        head.createSpan({
          cls: 'nestboard-repair-alternatives',
          text: t('modal.repairRefs.alternatives', { count: suggestion.alternatives }),
        });
      }

      const paths = body.createDiv({ cls: 'nestboard-repair-paths' });
      paths.createSpan({ cls: 'nestboard-repair-from', text: suggestion.brokenPath });
      paths.createSpan({ cls: 'nestboard-repair-arrow', text: '→' });
      paths.createSpan({ cls: 'nestboard-repair-to', text: suggestion.nextPath });
    }

    // 对不上的那些**也要说**：否则用户关掉对话框之后会以为"能修的都修了"，
    // 而这几处断链其实还在板上（它们只能靠卡片右键「重新链接」手工指定）
    if (plan.unmatched.length > 0) {
      this.contentEl.createDiv({
        cls: 'nestboard-repair-unmatched',
        text: t('modal.repairRefs.unmatched', { count: plan.unmatched.length }),
      });
    }

    this.contentEl.createDiv({
      cls: 'nestboard-repair-hint',
      text: t('modal.repairRefs.hint'),
    });

    const footer = this.contentEl.createDiv({ cls: 'nestboard-repair-footer' });
    const cancel = footer.createEl('button', { text: t('modal.repairRefs.cancel') });
    cancel.addEventListener('click', () => this.close());

    this.confirmButton = footer.createEl('button', { cls: 'mod-cta' });
    this.confirmButton.addEventListener('click', () => {
      const repairs = this.collect();
      if (repairs.length === 0) return;
      this.close();
      this.options.onConfirm(repairs);
    });
    this.syncConfirmButton();
  }

  /** 勾选数变了就重写按钮文案与可用态（文案里带数字，是用户唯一的"要改几处"依据） */
  private syncConfirmButton(): void {
    const button = this.confirmButton;
    if (!button) return;
    const count = this.selected.size;
    button.setText(t('modal.repairRefs.confirm', { count }));
    button.disabled = count === 0;
  }

  private collect(): RefRepair[] {
    return this.options.plan.suggestions
      .filter((suggestion) => this.selected.has(suggestion.cardId))
      .map(({ cardId, brokenPath, nextPath }) => ({ cardId, brokenPath, nextPath }));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
