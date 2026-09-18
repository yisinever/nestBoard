/**
 * 本地模板市场（`T4.14` / `T6.09` / `F7-06`）。
 *
 * ── 从"一行字的列表"升级成"看得见样子的市场" ──
 *
 * 旧版用 `SuggestModal`，只能给出名字与一句说明 —— 而"从模板开始"这件事，
 * 用户真正想确认的是**这块板长什么样**（我的调研到底会被摆成几栏、情绪板是什么脾气）。
 * 所以这里换成一组**预览卡**：每张模板用与 PNG 导出、板缩略图**同一套渲染**画一张
 * 真实几何的缩略图（`export/boardThumb.ts`，只缩放到 256px），所见即所得。
 *
 * ★ **预览是"真板子的缩小"，不是示意图**：这正是 `boardThumb.ts` 开头写下的取舍 ——
 *   小图和真板子长得不一样，等于让用户学两套版本。这里直接复用，不另画一套色块。
 * ★ **目录逻辑全在 `model/templateCatalog.ts`**：分组、搜索、分类筛选都是纯函数，
 *   这里只负责把它画出来。UI 里能少一行判断，就少一个要测的分支。
 * ★ **取消也必须回调 `null`**（`onClose` 里判 `chosen`）：否则调用方 `await` 的那个
 *   Promise 永远 pending、静默挂住 —— 这个坑在旧版的注释里写过一次，这里同罪同罚。
 * ★ 预览**一次性画完**：模板数是个位到几十的量级，`planBoardThumbnail` 只读几何不 decode 图片
 *   （大图会被画成占位块），所以没有懒加载的必要 —— 为它加 IntersectionObserver
 *   反而带来"滚动时一块块蹦出来"的观感。真到了几百份模板，再说。
 * ★ "会建到哪个目录 / 读不出来几份"这两句话贴在**底部**，不混进网格里：
 *   它们不是候选项，混进去会让人以为能点。
 */

import { Modal, type App } from 'obsidian';

import { planBoardThumbnail, paintBoardThumbnail } from '../../export/boardThumb';
import { readPngPalette } from '../../export/toPng';
import type { UserTemplate } from '../../io/templateLibrary';
import {
  buildTemplateCatalog,
  catalogSize,
  type CatalogCategoryFilter,
  type CatalogEntry,
} from '../../model/templateCatalog';
import {
  BUILTIN_TEMPLATES,
  TEMPLATE_CATEGORIES,
  builtinTemplateById,
  type TemplateCategory,
} from '../../model/templates';
import type { BoardFile } from '../../model/schema';
import { describeError } from '../../util/errors';
import { t, type MessageKey } from '../../util/i18n';

/** 分类标题（也是切换按钮）的文案键。写成表，`TemplateCategory` 加成员时编译器会提醒补 */
const CATEGORY_LABEL_KEY: Record<TemplateCategory, MessageKey> = {
  research: 'template.category.research',
  schedule: 'template.category.schedule',
  moodboard: 'template.category.moodboard',
  writing: 'template.category.writing',
};

/**
 * 一次最多画多少格。
 *
 * ★ 沿用旧选择器的上限（当时是 100 行，现在是 100 张预览）。它不是在防列表太长 ——
 *   模板多到几百份本来就该靠搜索 —— 而是在防**一次性建太多 canvas**：
 *   一张 256px 的缩略图约 256KB 显存，几百张就是几十 MB，还会把首次打开拖慢到可感知。
 *   超出时给一句话让用户去搜索，而不是把市场变成一个卡住的窗口。
 */
const MAX_TILES = 100;

/** 选中结果。两种来源的差别留给动作层去处理，这里只说"选了哪一个" */
export type TemplateChoice =
  { kind: 'builtin'; id: string; name: string } | { kind: 'user'; path: string; name: string };

export interface TemplateModalOptions {
  userTemplates: readonly UserTemplate[];
  /** 读不出来的模板份数（> 0 时给一句话，否则用户会以为模板凭空少了） */
  skipped: number;
  /** 新建的白板会落到哪 —— 提示文案里要用 */
  boardFolder: string;
  onDone: (choice: TemplateChoice | null) => void;
}

export class TemplateModal extends Modal {
  private chosen = false;
  private query = '';
  private category: CatalogCategoryFilter = 'all';

  private chipsEl!: HTMLElement;
  private galleryEl!: HTMLElement;

  constructor(
    app: App,
    private readonly options: TemplateModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('nestboard-template-market');
    this.titleEl.setText(t('modal.template.title'));

    const search = this.contentEl.createEl('input', {
      cls: 'nestboard-template-market__search',
      type: 'text',
      placeholder: t('modal.template.placeholder'),
      // 只有 placeholder 的输入框对读屏软件是"无名字段"；两处都给上同一句话
      attr: { 'aria-label': t('modal.template.placeholder') },
    });
    search.addEventListener('input', () => {
      this.query = search.value;
      this.render();
    });

    this.chipsEl = this.contentEl.createDiv({ cls: 'nestboard-template-market__chips' });
    this.galleryEl = this.contentEl.createDiv({ cls: 'nestboard-template-market__gallery' });

    const notes = [t('modal.template.hint', { folder: this.options.boardFolder })];
    if (this.options.skipped > 0) {
      notes.push(t('modal.template.skipped', { count: String(this.options.skipped) }));
    }
    this.contentEl.createDiv({ cls: 'nestboard-template__note', text: notes.join(' ') });

    this.render();
    search.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.chosen) this.options.onDone(null);
  }

  // ───────────────────────────────────────────────────────────
  // 渲染
  // ───────────────────────────────────────────────────────────

  private render(): void {
    this.renderChips();
    this.galleryEl.empty();

    const groups = buildTemplateCatalog({
      builtins: BUILTIN_TEMPLATES,
      users: this.options.userTemplates,
      query: this.query,
      category: this.category,
    });

    if (catalogSize(groups) === 0) {
      this.galleryEl.createDiv({
        cls: 'nestboard-template-market__empty',
        text: t('modal.template.empty'),
      });
      return;
    }

    let remaining = MAX_TILES;
    let truncated = false;
    for (const group of groups) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const entries = group.entries.slice(0, remaining);
      if (entries.length < group.entries.length) truncated = true;
      remaining -= entries.length;

      const section = this.galleryEl.createDiv({ cls: 'nestboard-template-market__group' });
      section.createDiv({
        cls: 'nestboard-template-market__group-title',
        text: this.groupLabel(group.key),
      });
      const grid = section.createDiv({ cls: 'nestboard-template-market__grid' });
      for (const entry of entries) this.renderTile(grid, entry);
    }

    if (truncated) {
      this.galleryEl.createDiv({
        cls: 'nestboard-template-market__overflow',
        text: t('modal.template.overflow', { shown: String(MAX_TILES) }),
      });
    }
  }

  private renderChips(): void {
    this.chipsEl.empty();
    // 顺序固定：全部 → 四个内置分类 → 我的模板。直接用 `TEMPLATE_CATEGORIES` 而不是
    // `Object.keys(CATEGORY_LABEL_KEY)`：后者是 `string[]`，还会把顺序交给对象的键序
    const filters: CatalogCategoryFilter[] = ['all', ...TEMPLATE_CATEGORIES, 'user'];

    for (const key of filters) {
      const chip = this.chipsEl.createEl('button', {
        cls: 'nestboard-template-market__chip',
        text: this.groupLabel(key),
      });
      if (key === this.category) chip.addClass('is-active');
      chip.addEventListener('click', () => {
        this.category = key;
        this.render();
      });
    }
  }

  private renderTile(grid: HTMLElement, entry: CatalogEntry): void {
    const tile = grid.createEl('button', {
      cls: 'nestboard-template-tile',
      attr: { type: 'button', 'data-key': entry.key },
    });

    const preview = tile.createDiv({ cls: 'nestboard-template-tile__preview' });
    this.paintPreview(preview, entry);

    tile.createDiv({ cls: 'nestboard-template-tile__title', text: entry.title });
    tile.createDiv({ cls: 'nestboard-template-tile__detail', text: entry.detail });

    tile.addEventListener('click', () => this.choose(entry));
  }

  /** 画一格预览。空板（没有任何卡片/分栏）给一块占位，而不是一张纯背景的图 */
  private paintPreview(host: HTMLElement, entry: CatalogEntry): void {
    const board = this.previewBoard(entry);
    if (!board) return;

    const plan = planBoardThumbnail(board);
    if (!plan) {
      host.createDiv({
        cls: 'nestboard-template-tile__placeholder',
        text: t('modal.template.previewEmpty'),
      });
      return;
    }

    const canvas = host.createEl('canvas', { cls: 'nestboard-template-tile__canvas' });
    // 缩略图是"名字与说明的注解"，对读屏软件来说是噪声
    canvas.setAttr('aria-hidden', 'true');
    canvas.width = plan.width;
    canvas.height = plan.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      paintBoardThumbnail(ctx, board, plan, readPngPalette(host));
    } catch (error) {
      // 一张预览画不出来不该让整个市场打不开：退化成占位块，其余照常
      console.warn('[nestboard] 模板预览绘制失败', describeError(error));
      canvas.remove();
      host.createDiv({
        cls: 'nestboard-template-tile__placeholder',
        text: t('modal.template.previewEmpty'),
      });
    }
  }

  /** 预览用的板：内置模板现搭一份，用户模板用列表里已经解析好的那份 */
  private previewBoard(entry: CatalogEntry): BoardFile | null {
    if (entry.source === 'builtin') {
      return builtinTemplateById(entry.ref)?.build() ?? null;
    }
    return (
      this.options.userTemplates.find((template) => template.path === entry.ref)?.board ?? null
    );
  }

  private groupLabel(key: CatalogCategoryFilter): string {
    if (key === 'all') return t('modal.template.category.all');
    if (key === 'user') return t('modal.template.user');
    return t(CATEGORY_LABEL_KEY[key]);
  }

  private choose(entry: CatalogEntry): void {
    this.chosen = true;
    this.close();
    if (entry.source === 'builtin') {
      this.options.onDone({ kind: 'builtin', id: entry.ref, name: entry.title });
      return;
    }
    this.options.onDone({ kind: 'user', path: entry.ref, name: entry.title });
  }
}
