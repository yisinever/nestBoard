import { Modal, Setting, type App } from 'obsidian';

import { t } from '../../util/i18n';

/**
 * 链接地址输入框（T3.21：工具条的「链接」按钮；`O08` 起也给地图卡用）。
 *
 * ★ 为什么需要一个模态而不是直接把空链接卡丢到画布上：
 *   链接卡的内容**就是一串 URL**，没有 URL 的链接卡渲染出来是个空壳，
 *   用户还得再双击一次进编辑态 —— 那还不如在落卡之前就问一次，
 *   问到了就落一张完整的卡。这和"便签卡落点即编辑"是两种不同的卡，
 *   不该被统一成一种交互。
 *
 * ★ `O08` 之后地图卡也走这里（「粘贴地图链接」在**读不到剪贴板**、
 *   或者粘进来的东西认不出时的退路）。所以标题/说明/确认按钮都能被覆盖 ——
 *   一个写着"新建链接卡"的弹窗让用户往里粘地图链接，是明显的错位。
 *   默认值仍是链接那一套：这个类的老用法（工具条）一行都不用改。
 *
 * ★ 取消必须回调 `null`（与 `NotePickerModal` / `BoardPickerModal` 同一条约定）：
 *   否则调用方的 `await` 永远挂着。
 */
export interface LinkPromptOptions {
  /** 弹窗标题（默认「新建链接卡」） */
  title?: string;
  /** 输入框那一行的名字 */
  name?: string;
  /** 输入框那一行的说明 */
  desc?: string;
  /** 确认按钮的文案 */
  confirm?: string;
  /**
   * 输入框的初始值。
   * ★ `O08` 用来预填"刚从剪贴板读到、但认不出"的那段：让用户**看见**插件手上
   *   到底拿到了什么，比只回一句"认不出来"有用得多（多半是复制时多带了几个字）。
   */
  initial?: string;
}

export class LinkPromptModal extends Modal {
  private value: string;
  private chosen = false;

  constructor(
    app: App,
    private readonly onDone: (url: string | null) => void,
    private readonly options: LinkPromptOptions = {},
  ) {
    super(app);
    this.value = options.initial ?? '';
  }

  override onOpen(): void {
    this.titleEl.setText(this.options.title ?? t('modal.link.title'));

    new Setting(this.contentEl)
      .setName(this.options.name ?? t('modal.link.name'))
      .setDesc(this.options.desc ?? t('modal.link.desc'))
      .addText((text) => {
        text
          .setValue(this.value)
          .setPlaceholder('https://…')
          .onChange((value) => {
            this.value = value;
          });
        // ★ 回车即确认：输一行网址之后手不会离开键盘，非要去点按钮很别扭。
        //   用 `keydown` 而不是 `input` 事件：`input` 分不清"输完了"和"还没输完"
        text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });
        // 打开即聚焦，用户可以直接开始打字
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText(this.options.confirm ?? t('modal.link.confirm'))
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.chosen) this.onDone(null);
  }

  /** 确认。空白输入按"取消"处理 —— 落一张没有地址的链接卡没有意义 */
  private submit(): void {
    const url = this.value.trim();
    if (url.length === 0) {
      this.close();
      return;
    }
    this.chosen = true;
    this.onDone(url);
    this.close();
  }
}
