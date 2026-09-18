/**
 * 取色器（T1.39 的「自定义颜色…」，`F2-00-5`）。
 *
 * 为什么要自己弹一个：Obsidian **没有**取色器 API，而"卡片颜色"只给 6 个主题色
 * 迟早不够用。这里用原生的 `<input type="color">`（系统取色盘，深浅色主题都能用）
 * 配一个手填 HEX 的输入框 —— 两者双向同步，谁改都行。
 *
 * ★ 非法 HEX 必须**当场拦住**：直接写进 `.nboard` 的 `accent` 字段会一路渲染成
 *   非法 CSS（整张卡的样式全丢），而且下次打开时那份文件已经坏了。
 *   所以确定按钮在校验通过前一直禁用，校验走 `util/color.normalizeHex`
 *   —— 与渲染层**同一个**校验函数，不存在"界面放行、渲染拒绝"的缝。
 */

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { normalizeHex } from '../../util/color';
import { t } from '../../util/i18n';
import type { HexColor } from '../../model/schema';

/** 兜底默认色：只在用户原先没设过颜色、且他清空了输入框时用到 */
const FALLBACK_COLOR = '#4c6ef5';

export class ColorPickerModal extends Modal {
  private draft: string;

  constructor(
    app: App,
    current: string | null,
    private readonly onSubmit: (color: HexColor) => void,
  ) {
    super(app);
    this.draft = normalizeHex(current ?? '') ?? FALLBACK_COLOR;
  }

  override onOpen(): void {
    this.titleEl.setText(t('color.custom'));
    const { contentEl } = this;

    // 不传 `{ type: 'color' }`：`DomElementInfo` 的类型在各版本间并不一致，
    // 直接赋属性最稳（也不损失什么）
    const swatch = contentEl.createEl('input');
    swatch.type = 'color';
    swatch.addClass('nestboard-color-picker');
    swatch.value = this.draft;

    const errorEl = contentEl.createDiv({ cls: 'nestboard-color-picker__error' });

    const hexSetting = new Setting(contentEl).addText((component) => {
      component.setValue(this.draft).onChange((value) => {
        this.draft = value;
        // 合法就顺手把色盘拨过去，用户立刻看到自己选中了什么
        const normalized = normalizeHex(value);
        if (normalized) swatch.value = normalized;
        validate();
      });
    });
    hexSetting.controlEl.querySelector('input')?.addClass('nestboard-color-picker__hex');

    swatch.addEventListener('input', () => {
      this.draft = swatch.value;
      const input = hexSetting.controlEl.querySelector('input');
      if (input) input.value = this.draft;
      validate();
    });

    const confirmSetting = new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('modal.cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(t('modal.ok'))
          .setCta()
          .onClick(() => {
            const color = normalizeHex(this.draft);
            if (!color) return;
            this.close();
            this.onSubmit(color);
          }),
      );

    // 最后一个按钮 = 确定（Obsidian 的 `addButton` 依次追加，取末位最稳）
    const buttons = confirmSetting.controlEl.querySelectorAll('button');
    const confirmButton = buttons[buttons.length - 1];

    const validate = (): void => {
      const valid = normalizeHex(this.draft) !== null;
      errorEl.setText(valid ? '' : t('color.invalid'));
      errorEl.toggleClass('is-visible', !valid);
      if (confirmButton) confirmButton.disabled = !valid;
    };
    validate();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
