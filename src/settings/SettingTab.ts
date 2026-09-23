/**
 * 设置面板（T1.74 / `F11-01`；T3.23–T3.25 补语言、卡片外观、画布背景）。
 *
 * ★ 只放**真的会被读到**的设置项。面板上多一个不生效的开关，比少一个更伤信任 ——
 *   用户会以为它生过效，然后拿一个错误的预期去理解白板的行为。
 *
 * ★ 改完立刻落盘，不设"保存"按钮：这是 Obsidian 设置面板的一贯行为，
 *   也省掉"改完忘了点保存"这一类问题。
 *
 * ★ 输入框改动时**不重画**面板：重画会把焦点从正在打字的输入框上抢走
 *   （用户输 `Boards` 打到第三个字母就断了）。只有下拉框才重画 ——
 *   "自定义附件目录"与"自定义颜色"那两项要跟着出现 / 消失。
 */

import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type NestboardPlugin from '../main';
import { BOARD_BACKGROUNDS, isThemeColor } from '../model/schema';
import type { ThemeColor } from '../model/schema';
import { colorLabel, THEME_COLOR_OPTIONS } from '../util/color';
import { normalizeLinkBlocklist } from '../util/linkPreview';
import { MAP_TILE_PROVIDERS } from '../util/mapUrl';
import { LANGUAGE_CHOICES, t } from '../util/i18n';
import type { LanguagePreference } from '../util/i18n';
import {
  AUTOSAVE_CHOICES,
  BACKGROUND_LABEL_KEY,
  CARD_CORNER_RADIUS_RANGE,
  CARD_FONT_SIZE_RANGE,
  DEFAULT_SETTINGS,
  MAP_TILE_LABEL_KEY,
  normalizeMapTileProvider,
} from './settings';
import type {
  AttachmentLocation,
  AttachmentNaming,
  CardStyleMode,
  NestboardSettings,
} from './settings';

export class NestboardSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: NestboardPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ★ 语言放第一位（T3.23）：它是"看这份面板的眼睛"，用户最可能是为了改它
    //   才进来的；而且改完重画时，下面所有文案会当场变成新语言
    this.renderLanguageSection();
    this.renderBoardSection();
    this.renderIndexNoteSection();
    this.renderCanvasSection();
    this.renderMinimapSection();
    this.renderCardSection();
    this.renderAttachmentSection();
    this.renderPrivacySection();
    this.renderMapTileSettings();
    this.renderSaveSection();
    this.renderSnapshotSection();
    this.renderResetSection();
    this.renderBuildSection();
  }

  /**
   * **构建信息**（2026-09-17 加，`06 §11.55`）。
   *
   * ★ 为什么值得占面板一行：用户报"改了没生效"时，第一件要问清的是**他跑的是哪份包**
   *   （库里没同步 / 换包后没重启 / 解压了更早的 zip —— 这三种都真实发生过）。
   *   放在这里，他打开设置就能读出来，不必去开控制台。
   */
  private renderBuildSection(): void {
    this.heading('settings.section.build');
    new Setting(this.containerEl)
      .setName(t('settings.build.name'))
      .setDesc(t('settings.build.desc', { build: this.plugin.buildStamp }));
  }

  private get settings(): NestboardSettings {
    return this.plugin.settings;
  }

  /** 改一项：落盘，但不重画面板（文本输入 / 滑杆用） */
  private patch(changes: Partial<NestboardSettings>): void {
    void this.plugin.updateSettings(changes);
  }

  /** 改一项：落盘 + 重画面板（下拉框用，有条件显示的兄弟项要看新值） */
  private patchAndRedraw(changes: Partial<NestboardSettings>): void {
    void this.plugin.updateSettings(changes).then(() => this.display());
  }

  /**
   * 一节的小标题。
   *
   * ★ 用 `setHeading()` 而不是自己塞一个 `<h3>`：Obsidian 的主题会给它
   *   `setting-item-heading` 的间距与字重，且未来改版时我们不用跟着调。
   */
  private heading(key: Parameters<typeof t>[0]): void {
    new Setting(this.containerEl).setName(t(key)).setHeading();
  }

  /** 界面语言（T3.23 / `F11-13`） */
  private renderLanguageSection(): void {
    new Setting(this.containerEl)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dropdown) => {
        for (const preference of LANGUAGE_CHOICES) {
          dropdown.addOption(preference, languageOptionLabel(preference));
        }
        return (
          dropdown
            .setValue(this.settings.language)
            // ★ 必须重画：换语言之后这一页上每一行文案都变了，不重画就会留着
            //   上一门语言的残影，看起来像"只翻译了一半"
            .onChange((value) => this.patchAndRedraw({ language: value as LanguagePreference }))
        );
      });
  }

  private renderBoardSection(): void {
    this.heading('settings.section.board');
    new Setting(this.containerEl)
      .setName(t('settings.newBoardFolder.name'))
      .setDesc(t('settings.newBoardFolder.desc'))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.newBoardFolder)
          .setValue(this.settings.newBoardFolder)
          .onChange((value) => this.patch({ newBoardFolder: value })),
      );
    // 模板目录（T4.14 / F7-06）：跟"新白板目录"挨着放 —— 这两个目录是同一个心智模型
    // （"东西落在库里的哪一块"），分到两节里用户会找不到
    new Setting(this.containerEl)
      .setName(t('setting.templateFolder.name'))
      .setDesc(t('setting.templateFolder.desc'))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.templateFolder)
          .setValue(this.settings.templateFolder)
          .onChange((value) => this.patch({ templateFolder: value })),
      );
    // Home 白板路径（T5.07 / `F11-09`）。放在这一节是因为它回答的是同一个问题 ——
    // "东西落在库里的哪一块"。★ 留空不是"填错了"，而是**关掉 Home**这个明确意图
    //   （`normalizeHomeBoardPath` 专门照顾了这一点，否则这个输入框永远清不空）
    new Setting(this.containerEl)
      .setName(t('setting.homeBoard.name'))
      .setDesc(t('setting.homeBoard.desc'))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.homeBoardPath)
          // ★ 不重画：这是文本输入，重画会把焦点从正在打字的框上抢走
          .setValue(this.settings.homeBoardPath)
          .onChange((value) => this.patch({ homeBoardPath: value })),
      );
  }

  /**
   * 索引笔记（T7.01 / `F10-09` / `F7-09`）。
   *
   * ★ 单独成节，与「缩略图导航器」「网页预览」同一类：这一项回答的不是"外观长什么样"，
   *   而是"**要不要往你的库里写文件**"。打开之后用户的库里会多出一沓 `.md`，
   *   大纲、搜索、图谱、Dataview 里都会看见 —— 这种后果值得自成一块，
   *   而不是夹在目录设置里当第四行。
   *
   * ★ 打开时**不**弹确认框（与 `linkPreview` 不同）：联网是不可逆的对外行为，
   *   而在自己库里多出一沓文件是**可一条命令整体撤销**的（进回收站，且关掉开关后
   *   不会再长回来）。代价可撤销，就不该拿一个确认框拦一道。
   */
  private renderIndexNoteSection(): void {
    this.heading('settings.section.indexNote');
    new Setting(this.containerEl)
      .setName(t('settings.indexNote.name'))
      .setDesc(t('settings.indexNote.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.settings.enableIndexNote).onChange((value) => {
          // ★ 重画而不是只保存：下面的目录输入框只在打开时才有意义
          //   （关着的时候它一个文件都不会生成，等于一个怎么填都不生效的输入框）
          this.patchAndRedraw({ enableIndexNote: value });
        }),
      );

    if (!this.settings.enableIndexNote) return;

    new Setting(this.containerEl)
      .setName(t('settings.indexNote.folder.name'))
      .setDesc(t('settings.indexNote.folder.desc'))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.indexNoteFolder)
          // ★ 不重画：这是文本输入，重画会把焦点从正在打字的框上抢走
          .setValue(this.settings.indexNoteFolder)
          .onChange((value) => this.patch({ indexNoteFolder: value })),
      );
  }

  /** 新建白板的默认背景（T3.25 / `F11-04`） */
  private renderCanvasSection(): void {
    this.heading('settings.canvas.name');
    new Setting(this.containerEl)
      .setName(t('settings.canvas.background.name'))
      .setDesc(t('settings.canvas.background.desc'))
      .addDropdown((dropdown) => {
        for (const background of BOARD_BACKGROUNDS) {
          dropdown.addOption(background, t(BACKGROUND_LABEL_KEY[background]));
        }
        return dropdown
          .setValue(this.settings.defaultBackground)
          .onChange((value) =>
            this.patch({ defaultBackground: value as (typeof BOARD_BACKGROUNDS)[number] }),
          );
      });
  }

  /**
   * 缩略图导航器（T5.09 / `F1-06`）。
   *
   * ★ 单独成节、不并进上一节的「新建白板画布」：那一节管的是**以后新建的板长什么样**
   *   （背景），而这一项是**现在这块板上要不要那块浮层** —— 两者回答的不是同一个问题。
   * ★ 与命令、面板上的 `×` 共用同一份真源（`settings.minimap`）：这里拨一下，
   *   `main.ts` 会把新值推给所有已打开的白板（`applyMinimapSetting`），
   *   于是用户在旁边的板上**当场**看到浮层出现 / 消失。
   */
  private renderMinimapSection(): void {
    this.heading('settings.section.minimap');
    new Setting(this.containerEl)
      .setName(t('settings.minimap.name'))
      .setDesc(t('settings.minimap.desc'))
      .addToggle((toggle) =>
        // ★ 不重画：这一节没有"跟着新值出现 / 消失"的兄弟项，重画只会让开关闪一下
        toggle.setValue(this.settings.minimap).onChange((value) => this.patch({ minimap: value })),
      );
  }

  /**
   * 卡片默认外观（T3.24 / `F11-03`）。
   *
   * 五行：默认颜色、圆角、字号、字体、**图片清晰度**（`A5`）。前三项改完立刻作用到
   * **所有已打开的白板**（`main.ts` 的 `refreshLocalizedChrome` 推 CSS 变量），
   * 用户拖动滑杆时能当场在旁边的白板上看到效果 —— 这比"设置里写个数字、回去才发现太圆"
   * 强得多。图片那一项不是 CSS 变量，由 `main.ts` 推一次重绘（见那边的注释）。
   */
  private renderCardSection(): void {
    this.heading('settings.cardDefaults.name');

    const { defaultCardColor } = this.settings;
    const isCustomColor = !isThemeColor(defaultCardColor);

    new Setting(this.containerEl)
      .setName(t('settings.cardColor.name'))
      .setDesc(t('settings.cardColor.desc'))
      .addDropdown((dropdown) => {
        for (const color of THEME_COLOR_OPTIONS) {
          dropdown.addOption(color, colorLabel(color));
        }
        dropdown.addOption(CUSTOM_COLOR_OPTION, t('settings.cardColor.custom'));
        return dropdown
          .setValue(isCustomColor ? CUSTOM_COLOR_OPTION : defaultCardColor)
          .onChange((value) => {
            // ★ 选中「自定义」本身不改任何值：真正的自定义色在下面那行输入框里。
            //   这里要是"顺手"写一个占位色进去，用户会看到颜色被我们改了一次
            if (value !== CUSTOM_COLOR_OPTION) {
              this.patchAndRedraw({ defaultCardColor: value as ThemeColor });
            }
          });
      });

    // ★ 只有自定义色才显示输入框：一个没生效的输入框比没有输入框更让人困惑
    if (isCustomColor) {
      new Setting(this.containerEl)
        .setName(t('settings.cardColor.customHex.name'))
        .setDesc(t('settings.cardColor.customHex.desc'))
        .addText((text) =>
          text
            .setPlaceholder('#RRGGBB')
            .setValue(defaultCardColor)
            // ★ 不重画：输入过程中 `#8` 还不是合法色值，`normalizeSettings` 会把它
            //   回落成主题色，重画会把用户正在输入的框整个换掉
            .onChange((value) => this.patch({ defaultCardColor: value })),
        );
    }

    // ★ 外观档（`F2`）：放在颜色与圆角之间 —— 它决定的是"整套光影规则"，
    //   比圆角 / 字号更靠前，读完颜色接着读它最顺
    new Setting(this.containerEl)
      .setName(t('settings.cardStyle.name'))
      .setDesc(t('settings.cardStyle.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('classic', t('settings.cardStyle.classic'))
          .addOption('neumorph', t('settings.cardStyle.neumorph'))
          .setValue(this.settings.cardStyle)
          // 立即生效（`§6` 13j）：`patchAndRedraw` 会推 CSS 变量 + 重画设置页，
          // 旁边的白板当场变样 —— 切档是"看一眼才决定"的事
          .onChange((value) => this.patchAndRedraw({ cardStyle: value as CardStyleMode })),
      );

    new Setting(this.containerEl)
      .setName(t('settings.cardRadius.name'))
      .setDesc(t('settings.cardRadius.desc'))
      .addSlider((slider) =>
        slider
          .setLimits(
            CARD_CORNER_RADIUS_RANGE.min,
            CARD_CORNER_RADIUS_RANGE.max,
            CARD_CORNER_RADIUS_RANGE.step,
          )
          .setValue(this.settings.cardCornerRadius)
          .setDynamicTooltip()
          .onChange((value) => this.patch({ cardCornerRadius: value })),
      );

    new Setting(this.containerEl)
      .setName(t('settings.cardFontSize.name'))
      .setDesc(t('settings.cardFontSize.desc'))
      .addSlider((slider) =>
        slider
          .setLimits(CARD_FONT_SIZE_RANGE.min, CARD_FONT_SIZE_RANGE.max, CARD_FONT_SIZE_RANGE.step)
          .setValue(this.settings.cardFontSize)
          .setDynamicTooltip()
          .onChange((value) => this.patch({ cardFontSize: value })),
      );

    new Setting(this.containerEl)
      .setName(t('settings.cardFont.name'))
      .setDesc(t('settings.cardFont.desc'))
      .addText((text) =>
        text
          .setPlaceholder(t('settings.cardFont.placeholder'))
          .setValue(this.settings.cardFontFamily)
          .onChange((value) => this.patch({ cardFontFamily: value })),
      );

    // 图片清晰度（`A5`）：默认开 —— 用户 2026-09-18 明确要"保持原图清晰度"
    new Setting(this.containerEl)
      .setName(t('settings.alwaysFullImage.name'))
      .setDesc(t('settings.alwaysFullImage.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.alwaysFullImage)
          .onChange((value) => this.patch({ alwaysFullImage: value })),
      );
  }

  private renderAttachmentSection(): void {
    this.heading('settings.section.attachment');
    new Setting(this.containerEl)
      .setName(t('settings.attachment.location.name'))
      .setDesc(t('settings.attachment.location.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('vault', t('settings.attachment.location.vault'))
          .addOption('custom', t('settings.attachment.location.custom'))
          .setValue(this.settings.attachmentLocation)
          .onChange((value) =>
            this.patchAndRedraw({ attachmentLocation: value as AttachmentLocation }),
          ),
      );

    // ★ 只有自定义模式才给目录输入框：一个没生效的输入框比没有输入框更让人困惑
    if (this.settings.attachmentLocation === 'custom') {
      new Setting(this.containerEl)
        .setName(t('settings.attachment.folder.name'))
        .setDesc(t('settings.attachment.folder.desc'))
        .addText((text) =>
          text
            .setValue(this.settings.customAttachmentFolder)
            .onChange((value) => this.patch({ customAttachmentFolder: value })),
        );
    }

    new Setting(this.containerEl)
      .setName(t('settings.attachment.naming.name'))
      .setDesc(t('settings.attachment.naming.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('timestamp', t('settings.attachment.naming.timestamp'))
          .addOption('original', t('settings.attachment.naming.original'))
          .setValue(this.settings.attachmentNaming)
          .onChange((value) =>
            this.patchAndRedraw({ attachmentNaming: value as AttachmentNaming }),
          ),
      );

    // 内容去重（T6.05）。★ 不做 `linkPreview` 那种确认弹窗：这一个开关**可逆**
    //   （关掉即恢复各存一份），没有需要用户先理解后果的不可逆决策。
    new Setting(this.containerEl)
      .setName(t('settings.attachment.dedupe.name'))
      .setDesc(t('settings.attachment.dedupe.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.attachmentDedupe)
          .onChange((value) => this.patch({ attachmentDedupe: value })),
      );
  }

  /**
   * 隐私与网络（T2.05 / `F11-07`；`O08` 补静态图服务）。
   *
   * ★ 单独成节而不是塞进"附件"：这里的两项决定的不是外观、也不是命名，而是
   *   **插件会不会往外发请求** —— 值得让用户在面板上一眼看到它们自成一块。
   *   塞进别的节里，等于把仅有的两处联网能力藏起来。
   */
  private renderPrivacySection(): void {
    this.heading('settings.section.privacy');
    new Setting(this.containerEl)
      .setName(t('settings.linkPreview.name'))
      .setDesc(t('settings.linkPreview.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.settings.linkPreview).onChange((value) => {
          // ★ 打开时**额外**弹一条说明：这个开关的后果（插件会去访问你粘贴的那些
          //   网址，并把预览图存进库里）不是设置项里一句话能交代完的，
          //   值得一次明确的确认
          //   （`O20` 起默认就是开着的，所以这条说明实际只在"关过又开"时出现 ——
          //   那不是冗余：用户关过，说明他在意，重新打开时更该再确认一次）
          if (value) new Notice(t('notice.linkPreviewEnabled'));
          // ★ 重画而不是只保存：下面的"域名黑名单"只在联网打开时才有意义
          //   （关着的时候它一个请求都拦不到，等于一个怎么填都不生效的输入框）
          this.patchAndRedraw({ linkPreview: value });
        }),
      );

    // 域名黑名单（T6.06 / F2-4-6）。★ 跟随总开关出现 / 消失 —— 见上面的理由
    if (!this.settings.linkPreview) return;

    new Setting(this.containerEl)
      .setName(t('settings.linkPreview.blocklist.name'))
      .setDesc(t('settings.linkPreview.blocklist.desc'))
      .addTextArea((area) => {
        // 一行一个站。★ 这里塞进去的是**已归一化**的域名（小写、无 www.、无路径），
        //   于是用户重开面板时能直接看到"我粘的那条长链接被收成了什么" ——
        //   比在文档里解释一遍归一化规则有用
        area
          .setPlaceholder(t('settings.linkPreview.blocklist.placeholder'))
          .setValue(this.settings.linkPreviewBlocklist.join('\n'))
          .onChange((value) =>
            this.patch({ linkPreviewBlocklist: normalizeLinkBlocklist(value.split('\n')) }),
          );
        area.inputEl.rows = 4;
        area.inputEl.addClass('nestboard-blocklist-input');
      });
  }

  /**
   * 地图卡的静态图服务（`O08`）。
   *
   * ★ 与链接预览挤在同一节里，但**没有**做成"跟着 `linkPreview` 出现"的子项：
   *   两条链完全独立（预览抓的是别人网页上的 `og:image`，地图抓的是地图服务商），
   *   把地图这一档藏在一个不相干的开关后面，用户会以为它是链接预览的附加项。
   * ★ 默认那一档是"不出图"：粘贴链接照样能用（存下链接与经纬度，卡上显示出来），
   *   只是不生成图片 —— 这是**唯一**一个不需要用户理解任何术语就能安全默认的选项。
   */
  private renderMapTileSettings(): void {
    new Setting(this.containerEl)
      .setName(t('settings.mapTile.name'))
      .setDesc(t('settings.mapTile.desc'))
      .addDropdown((dropdown) => {
        for (const provider of MAP_TILE_PROVIDERS) {
          dropdown.addOption(provider, t(MAP_TILE_LABEL_KEY[provider]));
        }
        dropdown.setValue(this.settings.mapTileProvider).onChange((value) => {
          // ★ 重画而不是只保存：下面的 key 输入框只对"要 key 的那两档"有意义
          //   （与"域名黑名单只在联网打开时出现"同一条规矩）
          this.patchAndRedraw({ mapTileProvider: normalizeMapTileProvider(value) });
        });
      });

    // key 只对 Google / 高德有意义：OSM 用的是社区公共静态图服务，「不出图」更是
    // 连请求都没有。留着它等于摆一个怎么填都不生效的输入框
    const provider = this.settings.mapTileProvider;
    if (provider !== 'google' && provider !== 'amap') return;

    new Setting(this.containerEl)
      .setName(t('settings.mapTile.key.name'))
      .setDesc(t('settings.mapTile.key.desc', { provider: t(MAP_TILE_LABEL_KEY[provider]) }))
      .addText((text) => {
        // ★ 输入框改动时**不重画**（面板顶上的规矩）：key 是一串字符一个字符敲进去的，
        //   重画会把焦点从输入框上抢走
        text
          .setPlaceholder(t('settings.mapTile.key.placeholder'))
          .setValue(this.settings.mapTileKey)
          .onChange((value) => this.patch({ mapTileKey: value }));
      });
  }

  private renderSaveSection(): void {
    this.heading('settings.section.save');
    new Setting(this.containerEl)
      .setName(t('settings.autosave.name'))
      .setDesc(t('settings.autosave.desc'))
      .addDropdown((dropdown) => {
        for (const ms of AUTOSAVE_CHOICES) {
          dropdown.addOption(String(ms), t('settings.autosave.value', { ms }));
        }
        // ★ 手改过 `.data.json` 的值可能不在档位里：补一项，否则下拉框会因为
        //   找不到匹配的 option 而显示成空白 —— 看起来像"这项设置丢了"
        if (!AUTOSAVE_CHOICES.includes(this.settings.autosaveDebounceMs)) {
          dropdown.addOption(
            String(this.settings.autosaveDebounceMs),
            t('settings.autosave.value', { ms: this.settings.autosaveDebounceMs }),
          );
        }
        return dropdown
          .setValue(String(this.settings.autosaveDebounceMs))
          .onChange((value) => this.patchAndRedraw({ autosaveDebounceMs: Number(value) }));
      });
  }

  /**
   * 版本快照（T4.01 / `F11-11`）。
   *
   * ★ 只给「开 / 关」和「放哪儿」两个旋钮，**间隔与保留上限不给调**：
   *   5 分钟 / 50 份 / 20MB 是数据保护的安全底线。让人把间隔调成 1 分钟，
   *   等于让大板每拖一下就写一份快照；真嫌占地方就该整体关掉，而不是"半开"。
   */
  private renderSnapshotSection(): void {
    this.heading('settings.section.snapshot');

    new Setting(this.containerEl)
      .setName(t('settings.snapshot.enabled.name'))
      .setDesc(t('settings.snapshot.enabled.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.settings.snapshotEnabled).onChange((value) =>
          // 重画：下面「存放位置」要跟着出现 / 消失
          this.patchAndRedraw({ snapshotEnabled: value }),
        ),
      );

    if (!this.settings.snapshotEnabled) return;

    new Setting(this.containerEl)
      .setName(t('settings.snapshot.location.name'))
      .setDesc(t('settings.snapshot.location.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('plugin', t('settings.snapshot.location.plugin'))
          .addOption('vault', t('settings.snapshot.location.vault'))
          .setValue(this.settings.snapshotLocation)
          .onChange((value) =>
            // 切换位置不搬走已有快照，只影响之后新拍的 —— 描述里已说明
            this.patchAndRedraw({ snapshotLocation: value === 'vault' ? 'vault' : 'plugin' }),
          ),
      );
  }

  private renderResetSection(): void {
    new Setting(this.containerEl)
      .setName(t('settings.reset.name'))
      .setDesc(t('settings.reset.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.reset.button'))
          .setWarning()
          .onClick(() => {
            // 传整份默认值而不是逐项清空：以后新增设置项时这里不会漏掉
            void this.plugin.updateSettings(DEFAULT_SETTINGS).then(() => {
              new Notice(t('notice.settingsReset'));
              this.display();
            });
          }),
      );
  }
}

/** 「自定义颜色」在下拉框里的 value（不属于任何主题色号，故单独取一个不会撞车的名字） */
const CUSTOM_COLOR_OPTION = '__custom__';

/**
 * 语言下拉的显示名。
 *
 * ★ 两种语言**各自用母语显示自己**（`简体中文` / `English`），`auto` 才跟着界面翻 ——
 *   一个看不懂当前界面语言的用户，正好最需要"用他认识的字写着的那个选项"。
 */
function languageOptionLabel(preference: LanguagePreference): string {
  if (preference === 'auto') return t('settings.language.auto');
  if (preference === 'en') return t('settings.language.en');
  return t('settings.language.zhCn');
}
