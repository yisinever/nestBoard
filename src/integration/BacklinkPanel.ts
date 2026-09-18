/**
 * 「跨白板反链」侧栏视图（T5.03 / T5.05 · `F10-08` / `F7-04`）。
 *
 * ## 它回答什么问题
 *
 * 用户站在一篇**笔记**上，想知道"有哪几块白板的内联卡提过我"。
 * Obsidian 自己的反链面板答不了 —— `.nboard` 不是 `.md`，它压根不索引里面的东西。
 * 这个侧栏列出：当前笔记被哪些白板的哪张卡提到、原话是哪一句，点一下跳过去。
 *
 * ## 为什么不塞进「核心反链面板」
 *
 * `F7-04` 的原话是"在笔记的反链面板中体现白板位置"。**Obsidian 没有公开 API
 * 可以往核心反链面板里插内容** —— 没有注册钩子，也没有可扩展的容器。能做的只有
 * 自己提供一个面板，让用户摆在核心反链面板旁边。
 *
 * ★ 这个取舍必须写在代码里而不是"实现完就当满足了"：规格要的是那个效果，
 *   我们给的是**能达到同样效果的另一条路**。它比规格描述的多一步"用户得手动把面板
 *   拖到侧栏"，少的那一步（自动化）不是我们偷懒，是宿主没给口子。
 *
 * ## 为什么必须标注「不参与全局图谱」
 *
 * `F10-08` 明确要求标注。这不是免责声明，是**功能的一部分**：用户在图谱视图里
 * 看不到这些边，如果面板不提，他会以为"插件把我这条链接弄丢了"。把边界说在前面，
 * 他才知道该去哪儿找。
 */

import { ItemView, Platform, setIcon } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { MIND_EXT, VIEW_TYPE_BACKLINK } from '../constants';
import { t } from '../util/i18n';
import { openBoardView } from '../view/BoardViewHost';
import { openMindView } from '../mind/view/host';
import type { LinkHit } from './LinkIndex';
import type NestboardPlugin from '../main';

/** 按**文档**分组的反链（同一份文档里提过多次时并成一组） */
interface DocGroup {
  path: string;
  title: string;
  hits: LinkHit[];
}

export class BacklinkPanelView extends ItemView {
  private readonly plugin: NestboardPlugin;
  /** 上一次渲染时看的笔记路径。用来在 `active-leaf-change` 里过滤掉"换了但没换笔记" */
  private renderedNotePath: string | null = null;
  /**
   * 上一次渲染时「索引笔记」开关的状态（`null` = 还没渲染过）。
   *
   * ★ 存这个状态只为了一件事：设置里拨了开关之后，判断**要不要重画**（见 `refreshIndexNoteHint`）。
   */
  private renderedIndexNoteEnabled: boolean | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: NestboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_BACKLINK;
  }

  override getDisplayText(): string {
    return '跨白板反链';
  }

  override getIcon(): string {
    return 'links-coming-in';
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass('nestboard-backlinks');
    // ★ 自己贴一个移动端标记，而不是去蹭 Obsidian 全局的 `.is-mobile`：
    //   那是宿主加在 `body` 上的类，我们借它做后代选择器等于把样式押在宿主的实现细节上。
    //   这里只用来把命中区放大到 44px（`02 §6`），标记写在自己的元素上最稳。
    if (Platform.isMobile) this.contentEl.addClass('nestboard-is-mobile');
    this.render();

    // 索引变化就重画：扫描每完成一片、每次保存、每次外部改动都会触发。
    // ★ 直接重画而不是做增量 diff —— 一个面板最多几十行，重建比维护 diff
    //   状态简单得多，也不会有"漏更新某一行"的 bug。
    this.register(this.plugin.linkIndex.onChanged(() => this.render()));

    const onActiveChange = (): void => this.renderIfNoteChanged();
    this.registerEvent(this.app.workspace.on('active-leaf-change', onActiveChange));
    this.registerEvent(this.app.workspace.on('file-open', onActiveChange));
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  // ── 渲染 ────────────────────────────────────────────────────

  /**
   * 只换笔记时才重画。
   *
   * ★ 守卫是必要的：`active-leaf-change` 在**点任何地方**都会触发（包括点设置、
   *   点别的侧栏）。无条件重画会让列表在用户每次点击时闪一下、滚动位置每次都回顶。
   */
  private renderIfNoteChanged(): void {
    const path = this.activeNotePath();
    if (path === this.renderedNotePath) return;
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();

    this.renderedNotePath = this.activeNotePath();
    const notePath = this.renderedNotePath;

    root.createDiv({ cls: 'nestboard-backlinks__title', text: '跨白板反链' });
    this.renderIndexNoteHint(root);

    if (notePath === null) {
      root.createDiv({
        cls: 'nestboard-backlinks__empty',
        text: '打开一篇笔记，这里会列出提到它的白板。',
      });
      this.renderDisclaimer(root);
      return;
    }

    root.createDiv({ cls: 'nestboard-backlinks__note', text: notePath });
    this.renderDisclaimer(root);

    const hits = this.plugin.linkIndex.backlinksOf(notePath);
    if (hits.length === 0) {
      root.createDiv({ cls: 'nestboard-backlinks__empty', text: this.emptyText() });
      return;
    }

    this.renderGroups(root, hits);
  }

  /** 空状态文案要分清"扫完了没有"与"真没有" —— 混在一起用户会以为功能坏了 */
  private emptyText(): string {
    const index = this.plugin.linkIndex;
    if (index.isReady) return '没有白板的内联卡提到这篇笔记。';
    return `正在扫描白板…（已扫 ${index.scannedBoards} 块）`;
  }

  /**
   * 顶部提示：内联卡里的链接进不了图谱 —— 并给一个"那就维护一份索引笔记"的入口（T7.01）。
   *
   * ★ 位置选在**最上面**，而不是列表底下：这句话解释的正是"你在这块面板里看不到什么"，
   *   而列表为空时用户最需要它（那也正是他会怀疑"是不是插件没索引到"的时刻）。
   * ★ 只在开关**关着**时出现：开着的时候索引笔记已经在替我们把这些链接送进图谱与
   *   搜索了，再留一句就是噪音 —— 而这块面板本来就窄，噪音的代价是列表的可见行数。
   */
  private renderIndexNoteHint(root: HTMLElement): void {
    this.renderedIndexNoteEnabled = this.plugin.settings.enableIndexNote;
    if (this.renderedIndexNoteEnabled) return;

    const hint = root.createDiv({ cls: 'nestboard-backlinks__index-hint' });
    hint.createDiv({
      cls: 'nestboard-backlinks__index-hint-text',
      text: t('backlinks.indexNoteHint'),
    });
    const button = hint.createEl('button', {
      cls: 'nestboard-backlinks__index-hint-action',
      text: t('backlinks.indexNoteEnable'),
    });
    button.addEventListener('click', () => {
      // ★ 点完**不在这里**重画：`updateSettings` 会回头调 `refreshIndexNoteHint`，
      //   让"开关变了 → 面板更新"只有一条路径（两条路径迟早会有一条忘了改）
      void this.plugin.updateSettings({ enableIndexNote: true });
    });
  }

  /**
   * 设置里拨动「索引笔记」开关后，重画顶部那句提示（T7.01）。
   *
   * ★ 只在**提示的显示与否真的变了**时才重画：提示与列表在同一棵 DOM 上，无差别重画
   *   会把用户刚滚到一半的位置弹回顶部 —— 而改一项无关设置时他不期待任何变化。
   */
  refreshIndexNoteHint(): void {
    if (this.renderedIndexNoteEnabled === this.plugin.settings.enableIndexNote) return;
    this.render();
  }

  private renderDisclaimer(root: HTMLElement): void {
    const stats = this.plugin.linkIndex.stats();
    root.createDiv({
      cls: 'nestboard-backlinks__disclaimer',
      // `F10-08` 要求如实标注，且要说清"为什么" —— 只说"不参与图谱"像是 bug 说明
      text:
        '内联卡与脑图节点写在 .nboard / .nestmind 里，Obsidian 只索引 .md，' +
        '所以这些引用不出现在全局图谱与核心反链面板中。',
    });
    root.createDiv({
      cls: 'nestboard-backlinks__stats',
      text: `已索引 ${stats.boards} 份文档 · ${stats.links} 条内联链接`,
    });
  }

  private renderGroups(root: HTMLElement, hits: LinkHit[]): void {
    const groups = new Map<string, DocGroup>();
    for (const hit of hits) {
      const group = groups.get(hit.docPath) ?? {
        path: hit.docPath,
        title: hit.docTitle,
        hits: [],
      };
      group.hits.push(hit);
      groups.set(hit.docPath, group);
    }

    const list = root.createDiv({ cls: 'nestboard-backlinks__list' });
    for (const group of groups.values()) {
      const section = list.createDiv({ cls: 'nestboard-backlinks__group' });

      const head = section.createDiv({ cls: 'nestboard-backlinks__group-head' });
      const button = head.createEl('button', {
        cls: 'nestboard-backlinks__board',
        text: group.title.length > 0 ? group.title : group.path,
      });
      button.setAttr('aria-label', `打开 ${group.path}`);
      button.addEventListener('click', () => {
        void this.openDoc(group.path);
      });
      // 标题可能与文件名无关（`meta.title` 可改），所以路径单独显示 ——
      // `F7-04` 要的是"文档位置"，只有名字不构成位置
      head.createDiv({ cls: 'nestboard-backlinks__board-path', text: group.path });

      for (const hit of group.hits) {
        const item = section.createDiv({ cls: 'nestboard-backlinks__hit' });
        const icon = item.createSpan({ cls: 'nestboard-backlinks__hit-icon' });
        setIcon(icon, 'text-select');

        const body = item.createDiv({ cls: 'nestboard-backlinks__hit-body' });
        if (hit.label.length > 0) {
          body.createDiv({ cls: 'nestboard-backlinks__hit-title', text: hit.label });
        }
        body.createDiv({ cls: 'nestboard-backlinks__hit-excerpt', text: hit.excerpt });

        item.addEventListener('click', () => {
          void this.openDoc(group.path, hit.anchorId);
        });
      }
    }
  }

  // ── 动作 ────────────────────────────────────────────────────

  /**
   * 打开那份文档；给了锚点（白板卡 / 脑图节点）就一并定位过去。
   *
   * ★ 按扩展名分派：`.nestmind` 走脑图视图（`06 §7.2` 第 3 条："点进去要能定位到节点"），
   *   其余照旧走白板。**面板自己不认识两种文档的模型** —— 它只认扩展名与"锚点"这一个概念。
   * ★ `revealCardById` / `revealNodeById` 自己会处理"视图刚创建、内容还没加载完"的时序
   *   （见两处实现里的注释），这里不必轮询等待。
   */
  private async openDoc(path: string, anchorId?: string): Promise<void> {
    if (path === '' || path.endsWith(`.${MIND_EXT}`)) {
      if (path === '') return;
      const view = await openMindView(this.app, path);
      if (view && anchorId !== undefined) view.revealNodeById(anchorId);
      return;
    }
    const view = await openBoardView(this.app, path);
    if (view && anchorId !== undefined) view.revealCardById(anchorId);
  }

  // ── 上下文 ──────────────────────────────────────────────────

  /** 当前活动笔记的路径；活动文件不是 markdown（如白板自己）时返回 `null` */
  private activeNotePath(): string | null {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === 'md' ? file.path : null;
  }
}

/**
 * 打开（或聚焦）跨白板反链面板。
 *
 * 侧栏三段式与 `openBoardView` 同规矩：先找已有 leaf 复用 → 没有才 `getRightLeaf`
 * → `setViewState` → `revealLeaf`。漏掉 `revealLeaf` 就是"视图建好了但不显示"。
 */
export async function openBacklinkPanel(plugin: NestboardPlugin): Promise<void> {
  const app = plugin.app;
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_BACKLINK)[0];
  if (existing) {
    await app.workspace.revealLeaf(existing);
    return;
  }

  // `false` = 不新建分栏；用户把右栏关到没有时它会给一个
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: VIEW_TYPE_BACKLINK, active: true });
  await app.workspace.revealLeaf(leaf);
}

/** 该面板是否已经打开（命令用它决定是"打开"还是"聚焦"） */
export function hasBacklinkPanel(plugin: NestboardPlugin): boolean {
  return plugin.app.workspace.getLeavesOfType(VIEW_TYPE_BACKLINK).length > 0;
}
