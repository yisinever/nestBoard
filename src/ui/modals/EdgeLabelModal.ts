/**
 * 连线标签输入框（T7.13 / `F3-06`）。
 *
 * ★ 为什么需要一个模态：连线的标签是一行**短文字**，而画布上双击线是"打开/进入"
 *   的手势（落在卡片上），给连线复用不了。用 Obsidian 的 `Modal` + `Setting`
 *   是这里唯一合规的选择（`04 §13`：一律用 Obsidian 的组件，不自绘）。
 *
 * ★ 空输入 = **清除标签**，而不是"取消"：用户想删掉这段文字时，最自然的动作
 *   就是把框里的字全删掉再确认 —— 让它在这里变成"什么都没发生"是反直觉的。
 *   取消是另一条路（Esc / 点遮罩），回调 `null`，与 `LinkPromptModal` 同一条约定。
 */

import { Modal, Setting, type App } from 'obsidian';

import { t } from '../../util/i18n';

export class EdgeLabelModal extends Modal {
  private value: string;
  private chosen = false;

  constructor(
    app: App,
    current: string,
    private readonly onDone: (label: string | null) => void,
  ) {
    super(app);
    this.value = current;
  }

  override onOpen(): void {
    this.titleEl.setText(t('modal.edgeLabel.title'));

    new Setting(this.contentEl).setDesc(t('modal.edgeLabel.desc')).addText((text) => {
      // ★ 带上**现有的**标签：编辑标签的典型用法是"改两个字"，
      //   每次从空框开始等于逼用户重打一遍
      text.setValue(this.value).setPlaceholder(t('modal.edgeLabel.placeholder'));
      text.onChange((value) => {
        this.value = value;
      });
      // 回车即确认：输一行字之后手不会离开键盘
      text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submit();
        }
      });
      // 打开即聚焦，并全选 —— 想重打就重打，想改就按方向键
      window.setTimeout(() => {
        text.inputEl.focus();
        text.inputEl.select();
      }, 0);
    });

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(t('modal.edgeLabel.cancel')).onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText(t('modal.edgeLabel.save'))
          .setCta()
          .onClick(() => this.submit()),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.chosen) this.onDone(null);
  }

  /** 确认。空字符串**照原样交出去**（= 清除标签），由调用方决定怎么写模型 */
  private submit(): void {
    this.chosen = true;
    this.onDone(this.value.trim());
    this.close();
  }
}
