/**
 * 侧栏「卡片属性」（`B1`，用户 2026-09-18："入口在卡片右键菜单 —— 打开一个右侧窗口
 * 操作卡片的全属性：卡片名 / 卡片类型 / 标题 / 内容……以及对应卡片的其他可操作属性"）。
 *
 * ── 三条分界 ────────────────────────────────────────────────
 *
 * 1. **面板不碰模型**：它只通过 `CardInspectorHost` 问"这张卡现在什么样"、
 *    递"我要把这些字段改成这样"—— 改由**白板视图**走它自己的 `commit`（于是
 *    每一次编辑都是**一步撤销**，并且与画布上的修改共享同一条历史）。
 * 2. **单例、跟随选中**：整个侧栏只有一份这个面板；换个卡片只是 `bind()` 一次，
 *    不新开一个视图（开一堆"属性"标签页是反用户的）。
 * 3. **行一律用 Obsidian 的 `Setting`**：面板的外观、间距、窄侧栏下的折行全归宿主管，
 *    我们不必自绘一套表单（也不必在样式表里再维护一遍）。
 *
 * ★ 卡片被删 / 文件被外部改坏时 `cardOf()` 会返回 `null` ⇒ 面板显示空白态说明，
 *   而不是对着一张不存在的卡继续画输入框。
 */

import { ItemView, Setting } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';

import { VIEW_TYPE_CARD_INSPECTOR } from '../constants';
import { THEME_COLORS } from '../model/schema';
import type { Card, CardColor } from '../model/schema';
import { swatchEntryToText } from '../util/color';
import { t } from '../util/i18n';
// 色板那一行复用卡片自己的解析器（`cards/swatch.ts`）—— 它已经处理了渐变、去重、
// 以及"哪一行算不出来"这件事；在面板里再写一遍就是两套规则慢慢分家
import { parseSwatchText } from '../cards/swatch';

/** 面板能改的字段（`id` / `type` / `content` 不在其中：那两个是身份与内容，另说） */
export type CardPatch = Partial<Omit<Card, 'id' | 'type' | 'content'>>;

/** 面板与白板视图之间的**窄接口**（面板不认识 `BoardView`，只认识这三件事） */
export interface CardInspectorHost {
  /** 这张卡现在什么样（被删掉了就 `null`） */
  cardOf(cardId: string): Card | null;
  /** 就地改这张卡的**卡片级字段**（调用方负责走 `commit`：一步撤销、一条历史） */
  applyPatch(cardId: string, patch: CardPatch): void;
  /**
   * 就地改这张卡的**内容**（`B1` 收尾）。
   *
   * ★ 与 `applyPatch` 分成两个口子：内容是按类型变形状的（便签是 `md`、文件类是 `path`、
   *   色板是 `colors`…），混进同一个 patch 会让"改卡片属性"这件事在类型上说不清。
   * ★ 同样由调用方走 `commit` —— 面板里敲一段正文也是一步撤销。
   */
  applyContent(cardId: string, patch: Record<string, unknown>): void;
  /** 这张卡所在的分栏名字（没有分栏 / 不认识的 id 给 `null`，面板那一行就写"画布上"） */
  columnTitleOf(cardId: string): string | null;
}

export class CardInspectorPanelView extends ItemView {
  private host: CardInspectorHost | null = null;
  private cardId: string | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_CARD_INSPECTOR;
  }

  override getDisplayText(): string {
    return t('inspector.title');
  }

  override getIcon(): string {
    return 'sliders-horizontal';
  }

  override async onOpen(): Promise<void> {
    this.render();
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /**
   * 让面板改看另一张卡（**每次打开 / 换选中都会调**）。
   *
   * ★ 面板是单例：这里只是换一份数据再重画，不新开视图。
   */
  bind(host: CardInspectorHost, cardId: string): void {
    this.host = host;
    this.cardId = cardId;
    this.render();
  }

  /** 外面改了这张卡（画布上拖动 / 撤销）时重画一遍 —— 面板不能显示过期的数 */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass('nestboard-inspector');

    const host = this.host;
    const cardId = this.cardId;
    const card = host && cardId ? host.cardOf(cardId) : null;
    if (!host || !cardId || !card) {
      el.createDiv({ cls: 'nestboard-inspector-empty', text: t('inspector.empty') });
      return;
    }

    // ── 身份（只读）──
    this.readonlyRow(t('inspector.type'), t(labelKeyOf(card.type)));
    this.readonlyRow(t('inspector.cardId'), card.id);
    // 所属位置：分栏名（没进栏就写"画布上"）
    this.readonlyRow(
      t('inspector.placement'),
      host.columnTitleOf(cardId) ?? t('inspector.onCanvas'),
    );

    // ── 名字与外观 ──
    this.textRow(t('inspector.name'), card.title, (next) =>
      host.applyPatch(cardId, { title: next }),
    );
    this.colorRow(card, (next) => host.applyPatch(cardId, { color: next }));
    this.toggleRow(t('inspector.showTitle'), card.showTitle, (next) =>
      host.applyPatch(cardId, { showTitle: next }),
    );
    this.toggleRow(t('inspector.showBorder'), card.showBorder !== false, (next) =>
      host.applyPatch(cardId, { showBorder: next ? undefined : false }),
    );
    this.toggleRow(t('inspector.locked'), card.locked, (next) =>
      host.applyPatch(cardId, { locked: next }),
    );

    // ── 内容（`B1`：能编的给编辑口，编不了的给只读摘要）──
    // ★ 便签 / 同步便签的正文用**多行 textarea**（一行 `addText` 会吃掉换行，正文就没法用了）；
    //   路径 / 地址 / 那行字用单行。
    // ★ 解析不出来（色板那行不是色号、图集里混进空行）就**不提交**：宁可这一下不生效，
    //   也不要拿一份半成品覆盖掉卡片里原来的内容。
    const editor = contentEditorOf(card);
    if (editor === null) {
      // 手绘 / 清单 / 评论的内容不是"一句话"，各自的编辑口不同 ⇒ 这一版只给摘要
      this.readonlyRow(t('inspector.content'), contentSummaryOf(card));
    } else {
      const setting = new Setting(this.contentEl).setName(t('inspector.content'));
      if (editor.hint !== undefined) setting.setDesc(editor.hint);
      if (editor.multiline) {
        setting.addTextArea((area) => {
          area.setValue(editor.value);
          area.onChange((next) => {
            const patch = editor.parse(next);
            if (patch !== null) host.applyContent(cardId, patch);
          });
        });
      } else {
        setting.addText((field) => {
          field.setValue(editor.value);
          field.onChange((next) => {
            const patch = editor.parse(next);
            if (patch !== null) host.applyContent(cardId, patch);
          });
        });
      }
    }

    // ── 几何 ──
    this.numberRow(t('inspector.x'), card.x, (next) => host.applyPatch(cardId, { x: next }));
    this.numberRow(t('inspector.y'), card.y, (next) => host.applyPatch(cardId, { y: next }));
    this.numberRow(t('inspector.width'), card.width, (next) =>
      host.applyPatch(cardId, { width: Math.max(1, next) }),
    );
    this.numberRow(t('inspector.height'), card.height, (next) =>
      host.applyPatch(cardId, { height: Math.max(1, next) }),
    );
    this.numberRow(t('inspector.rotation'), card.rotation ?? 0, (next) =>
      host.applyPatch(cardId, { rotation: next }),
    );
    this.numberRow(t('inspector.z'), card.z, (next) =>
      host.applyPatch(cardId, { z: Math.round(next) }),
    );
  }

  /** 只读的一行（类型 / id / 所属位置） */
  private readonlyRow(name: string, value: string): void {
    new Setting(this.contentEl).setName(name).setDesc(value).setDisabled(true);
  }

  /**
   * 文本的一行。
   *
   * ★ 只在**失焦 / 回车**时提交（`onChange` 是逐键触发的）—— 逐键提交会把每一次
   *   键入都变成一条历史记录，撤销栈会被打字填满（用户在画布上按 `⌘Z` 只会看到
   *   标题少一个字，而不是退回上一步编辑）。
   */
  private textRow(name: string, value: string, apply: (next: string) => void): void {
    new Setting(this.contentEl)
      .setName(name)
      .addText((text) => text.setValue(value).onChange((next) => apply(next)));
  }

  /**
   * 数字的一行。
   *
   * ★ 解析不出数字时**不提交**（输入框里暂时是 `-` / 空的时候，用 0 去覆盖模型
   *   会把卡片直接拖到原点 —— 那不是用户打的字的意思）。
   */
  private numberRow(name: string, value: number, apply: (next: number) => void): void {
    new Setting(this.contentEl).setName(name).addText((text) =>
      text.setValue(String(Math.round(value))).onChange((next) => {
        const parsed = Number(next);
        if (Number.isFinite(parsed)) apply(parsed);
      }),
    );
  }

  private toggleRow(name: string, value: boolean, apply: (next: boolean) => void): void {
    new Setting(this.contentEl)
      .setName(name)
      .addToggle((toggle) => toggle.setValue(value).onChange((next) => apply(next)));
  }

  /** 颜色：主题 6 色 + 当前那一个（自定义 HEX 也在其中，按它的值标出来） */
  private colorRow(card: Card, apply: (next: CardColor) => void): void {
    new Setting(this.contentEl).setName(t('inspector.color')).addDropdown((dropdown) => {
      for (const color of THEME_COLORS) dropdown.addOption(color, color);
      // 当前是自定义 HEX 时补一项，否则下拉框会显示成"没选"
      if (!(THEME_COLORS as readonly string[]).includes(card.color)) {
        dropdown.addOption(card.color, card.color);
      }
      return dropdown.setValue(card.color).onChange((next) => apply(next as CardColor));
    });
  }
}

/** 卡片类型的文案键（`card.type.*`，与注册表那份同一个命名） */
function labelKeyOf(type: Card['type']): Parameters<typeof t>[0] {
  return `card.type.${type}` as Parameters<typeof t>[0];
}

/** 内容编辑口（`B1`）：`null` = 这一版没有编辑口，只给只读摘要 */
interface ContentEditor {
  value: string;
  multiline: boolean;
  hint?: string;
  /** 把输入框里的文本解析成内容补丁；**解析不出来给 `null`**（调用方据此不提交） */
  parse(next: string): Record<string, unknown> | null;
}

/**
 * 按类型挑内容编辑口（`B1` 收尾）。
 *
 * ★ **能编的编、编不了的给摘要**：便签 / 同步便签的正文（多行）、仅标题卡那行字、
 *   链接地址、各种文件路径（单行）、色板（多行，一行一格）、图集（多行，一行一个路径）。
 *   手绘 / 清单 / 评论的内容不是"一句话"（各自的编辑口形态差得远），这一版只给只读摘要。
 * ★ **解析不出来就不提交**：色板那几行里只要有一行不是色号，就整批不写
 *   （与色板卡自己的编辑态同一条 —— 见 `cards/swatch.ts` 那段"原子校验"）；
 *   图集被清空、色板被清空同理（宁可这一下不生效，也不要拿半成品覆盖掉原有内容）。
 */
function contentEditorOf(card: Card): ContentEditor | null {
  const content = card.content as unknown as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const literal = (key: string, value: string): ContentEditor => ({
    value,
    multiline: false,
    parse: (next) => ({ [key]: next }),
  });

  switch (card.type) {
    case 'note':
    case 'syncNote':
      return { value: text(content.md), multiline: true, parse: (next) => ({ md: next }) };
    // 仅标题卡（`A3`）：那行字就是**卡片标题**（`CardBase.title`），上面那行「名字」
    // 已经能改 ⇒ 不再单独给一个"内容"编辑口（免得出现两处各改一份、谁也说不清哪个算数）
    case 'titleCard':
      return null;
    case 'link':
      return literal('url', text(content.url));
    case 'swatch':
      return {
        value: (Array.isArray(content.colors) ? content.colors : [])
          .map((entry) => swatchEntryToText(entry as never))
          .join('\n'),
        multiline: true,
        hint: t('card.swatch.hint'),
        parse: (next) => {
          const { colors, rejected } = parseSwatchText(next);
          return rejected.length > 0 || colors.length === 0 ? null : { colors };
        },
      };
    case 'gallery':
      return {
        value: (Array.isArray(content.paths) ? content.paths : [])
          .map((path) => String(path))
          .join('\n'),
        multiline: true,
        parse: (next) => {
          const paths = next
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          return paths.length === 0 ? null : { paths };
        },
      };
    default:
      // 其余（图片 / 文件 / 视频 / 音频 / 地图 / 白板 / 引用）内容都只有一个路径
      return literal('path', text(content.path));
  }
}

/**
 * 内容的**一句话摘要**（面板那一行）。
 *
 * ★ 按类型取那个"最像这张卡"的字段：便签与同步便签是正文首行、仅标题卡是那行字、
 *   链接是地址、其余文件类卡是路径；而**成组的**（清单 / 色板 / 图集 / 手绘 / 评论）
 *   给"几项"而不是把内容摊开 —— 面板那一行放不下一组数据，摊开只会是噪声。
 * ★ 只读文本，所以首行之外的内容用 `…` 收尾（`firstLine`）：一整段 Markdown 挤在
 *   一行 `desc` 里会把面板撑得很难看。
 * ★ 坏数据（`content.md` 不是字符串之类）一律当空串：面板不该因为一份手改坏的文件崩掉。
 */
function contentSummaryOf(card: Card): string {
  const content = card.content as unknown as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  switch (card.type) {
    case 'note':
    case 'syncNote':
      return firstLine(text(content.md));
    // 仅标题卡（`A3`）：那行字 = 卡片标题，内容这一栏照旧显示它（与「名字」同一处）
    case 'titleCard':
      return firstLine(card.title);
    case 'link':
      return text(content.url);
    case 'swatch':
      return t('inspector.contentColors', { count: list(content.colors).length });
    case 'todo':
      return t('inspector.contentItems', { count: list(content.items).length });
    case 'gallery':
      return t('inspector.contentImages', { count: list(content.paths).length });
    case 'ink':
      return t('inspector.contentStrokes', { count: list(content.paths).length });
    case 'comment':
      return t('inspector.contentComments', { count: list(content.entries).length });
    default:
      // 其余（图片 / 文件 / 视频 / 音频 / 地图 / 白板 / 引用）内容都只有一个路径
      return text(content.path);
  }
}

/** 摘要只看首行：多行内容挤成一行只会是一团噪声 */
function firstLine(value: string): string {
  const line = value.split('\n').find((item) => item.trim().length > 0) ?? '';
  return line.trim();
}
