/**
 * 「查找与替换」弹窗（用户 2026-09-28："要支持检索和替换，支持文档内的查询和替换"）。
 *
 * ★ 只画与递话：命中多少处由宿主算（`model/findReplace.ts` 的纯函数），替换走宿主的
 *   `commit` ⇒ **一步撤销**。弹窗自己不认识白板 / 脑图。
 * ★ 为什么是弹窗而不是嵌进过滤条：过滤条的搜词是"**看**"的口径（变淡 / 聚焦），
 *   替换是"**改**"的动作 —— 两者对"命中"的定义迟早分叉（过滤认类型维度、
 *   替换只认文字），分开放反而各说各话说得清楚。
 * ★ 实时命中数：输入时就算（便宜：一遍字符串扫描），用户不必按一下才知道有没有。
 */

import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';

import { t } from '../../util/i18n';

/** 弹窗与视图之间的窄接口（白板 / 脑图视图各给一份实现） */
export interface FindReplaceHost {
  /** 现在 `query` 命中多少处（实时喂，给"有没有"的即时反馈） */
  count(query: string, matchCase: boolean): number;
  /** 全部替换；返回是否有改动（调用方负责提交与提示） */
  replaceAll(query: string, replacement: string, matchCase: boolean): boolean;
}

export class FindReplaceModal extends Modal {
  private matchCase = false;

  constructor(
    app: App,
    private readonly host: FindReplaceHost,
    /** 打开时预填的查询（比如从选区带过来）；缺省 = 空 */
    private readonly initialQuery = '',
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('findReplace.title'));
    const { contentEl } = this;
    contentEl.empty();

    let query = this.initialQuery;
    let replacement = '';
    let hitsRow: HTMLElement | null = null;

    const refreshHits = (): void => {
      if (!hitsRow) return;
      const count = query.length > 0 ? this.host.count(query, this.matchCase) : 0;
      hitsRow.setText(count > 0 ? t('findReplace.hits', { n: count }) : t('findReplace.none'));
    };

    new Setting(contentEl)
      .setName(t('findReplace.find'))
      .addText((text) =>
        text
          .setValue(query)
          .setPlaceholder(t('findReplace.find'))
          .onChange((value) => {
            query = value;
            refreshHits();
          }),
      )
      .then((setting) => {
        hitsRow = setting.controlEl.createDiv({ cls: 'nestboard-find-replace-hits' });
        refreshHits();
      });

    new Setting(contentEl).setName(t('findReplace.replace')).addText((text) =>
      text.setPlaceholder(t('findReplace.replace')).onChange((value) => {
        replacement = value;
      }),
    );

    new Setting(contentEl).setName(t('findReplace.matchCase')).addToggle((toggle) =>
      toggle.setValue(this.matchCase).onChange((value) => {
        this.matchCase = value;
        refreshHits();
      }),
    );

    new Setting(contentEl).addButton((button) =>
      button
        .setCta()
        .setButtonText(t('findReplace.replaceAll'))
        .onClick(() => {
          if (query.length === 0) return;
          const changed = this.host.replaceAll(query, replacement, this.matchCase);
          // 有改动才提示：替换里"没找到"不算事件（命中数那一行已经说了）
          if (changed) new Notice(t('findReplace.done'));
          refreshHits();
        }),
    );

    // 焦点给查找框：打开就能打字
    const first = contentEl.querySelector<HTMLInputElement>('input');
    first?.focus();
    first?.select();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
