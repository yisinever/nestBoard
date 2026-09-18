/**
 * 白板嵌入笔记的只读渲染（T3.16 / `F10-04` / `F1-10`、T7.09 / `F7-10`）。
 *
 * 两种写法都落到**同一条**渲染路径：
 *
 * ```
 * ```nestboard
 * file: Boards/路线图.nboard
 * height: 480
 * ```
 * ```
 *
 * 以及行内嵌入 `![[路线图.nboard]]`。产物是一行标题信息 +「打开白板」按钮 + 一张图 ——
 * 嵌入的目的是"在这篇笔记里瞥一眼这块板长什么样"，不是"在这里编辑它"。
 *
 * ★ 刻意不复用 `BoardView`：那是一个完整的 `ItemView`（视口、选区、命令、DOM 一大套），
 *   为了画一张缩略图把它整套装配起来，既慢又会在同一块板上多出第二个"活着"的模型副本
 *   （两份模型各自防抖保存，冲突迟早发生）。这里只做两件事：读文件 → 画一张 canvas。
 * ★ 缩略图**不预载图片卡的原图**：一段笔记里嵌三块板，每块都去解码十几张大图，
 *   会把滚动卡住。缺图时 `renderTile` 会画占位文字，缩略图上完全看得懂。
 * ★ 一律只读：不写模型、不改文件，只读保护态（`F10-06`）下同样显示。
 *
 * ── 两种形态：缩略图 / 只读小窗（T7.09 / `F7-10`）────────────
 *
 * 默认仍是 T3.16 的**静态缩略图**（整板一页、`max-width: 100%`、高度随宽度）。
 * 写了 `height: 480` 就变成**只读小窗**：高度按写的来，宽度跟着笔记栏宽走（`ResizeObserver`），
 * 内容按"装进这扇窗"重新规划（`planBoardWindow`），而且目标板一保存就重画。
 *
 * 两者的区别不是"清晰度"，是**这扇窗知不知道自己在哪**：缩略图是一件按笔记本宽度
 * 等比缩放的图片，小窗是一扇固定高度的窗口 —— 栏宽变窄时缩略图整体变小、小窗只是
 * 看见的范围少了，而后者才是"嵌了一块板在这儿"。
 *
 * ★ 为什么 `height:` 是**另写一行**而不是让 `![[x.nboard|480]]` 那样的别名语法兼职：
 *   行内嵌入是 Obsidian 自己解析的，我们能拿到的只有 `src`，塞进去的数字会被它当成
 *   别名（"显示什么"）而不是尺寸（"多大"）。代码块（` ```nestboard `）里那几行字
 *   才是我们说了算的地方。
 * ★ 小窗仍然**不订阅模型事件**、不建 session：读文件是唯一的数据来源，与缩略图同一条路
 *   （所以不存在"嵌进去的一块板被笔记改坏"这种可能）。
 */

import { MarkdownRenderChild, TFile, type App, type Plugin } from 'obsidian';
import { BOARD_EXT } from '../constants';
import { paintBoardThumbnail, planBoardWindow } from '../export/boardThumb';
import {
  DEFAULT_PNG_PADDING,
  planPngExport,
  readPngPalette,
  renderTile,
  resolveExportBounds,
} from '../export/toPng';
import type { BoardFile } from '../model/schema';
import { parseBoardJson } from '../model/validate';
import { isBoardPath, parseEmbedSpec, type EmbedSpec } from '../util/embedTarget';
import { describeError } from '../util/errors';
import { t } from '../util/i18n';
import { openBoardView } from '../view/BoardViewHost';

/** 代码块语言：` ```nestboard` */
export const EMBED_BLOCK_LANG = 'nestboard';

/** 只读缩略图最多画几行正文（比导出少，嵌在笔记里的图不需要读完整段文字） */
const EMBED_MAX_LINES = 4;

/**
 * 小窗的**尺寸**下限（CSS px，两个方向共用）。
 *
 * ★ 与白板卡那边（`cards/boardRef.ts` 的 `MIN_WINDOW_SIDE`）是同一个数的同一个用途：
 *   兜住"还没布局"。`ResizeObserver` 第一次报出来的尺寸也可能是 0（笔记在后台标签页里
 *   渲染、栏宽尚未定下来），照 0 去规划只会得到一张 1×1 的图，而那扇窗此后不会自己变好。
 */
const MIN_EMBED_WINDOW_SIDE = 24;

/** 读一块板的两种结果 —— 让"读到了什么"与"该怎么措辞"分开（见 `readBoard`） */
type BoardReadResult = { ok: true; board: BoardFile } | { ok: false; reason: string };

/**
 * 注册两种嵌入写法（在插件 `onload` 里调用一次）。
 *
 * ★ 用 `Plugin` 的 `register*` 系方法注册：`onunload` 时由 Obsidian 统一回收，
 *   不会出现"重载插件后同一段笔记里嵌入渲染两遍"（与 `main.ts` 的 DoD-4 同一条纪律）。
 */
export function registerBoardEmbed(plugin: Plugin): void {
  plugin.registerMarkdownCodeBlockProcessor(EMBED_BLOCK_LANG, (source, el, ctx) => {
    ctx.addChild(new BoardEmbedChild(el, plugin.app, ctx.sourcePath, parseEmbedSpec(source)));
  });

  // `![[x.nboard]]`：Obsidian 已经把它变成 `.internal-embed`，但内容不是我们想要的
  // （默认会显示成"不支持的文件类型"）。这里认出白板路径、清空、换成只读缩略图。
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    for (const embed of Array.from(el.querySelectorAll<HTMLElement>('.internal-embed'))) {
      const src = embed.getAttribute('src') ?? '';
      if (!isBoardPath(src)) continue;
      // ★ 行内写法拿不到 `height:`（见文件头）：这里**只取路径**，高度一律为"随内容"
      const spec = parseEmbedSpec(src);
      if (!spec.path) continue;
      // 标掉：同一个 `.internal-embed` 可能被后续 processor 再看到一遍
      embed.removeAttribute('src');
      embed.empty();
      ctx.addChild(new BoardEmbedChild(embed, plugin.app, ctx.sourcePath, spec));
    }
  });
}

/**
 * 一段嵌入的生命周期：`onload` 建壳、异步读文件、画缩略图或小窗。
 *
 * 必须挂在 `ctx.addChild` 上而不是用完就丢：`cachedRead` 是异步的，笔记可能在读盘
 * 回来之前就被关闭 —— 那时 `onunload` 已经跑过，`disposed` 让回调安静地放弃写 DOM。
 */
class BoardEmbedChild extends MarkdownRenderChild {
  private disposed = false;

  constructor(
    containerEl: HTMLElement,
    private readonly app: App,
    private readonly sourcePath: string,
    private readonly spec: EmbedSpec,
  ) {
    super(containerEl);
  }

  override onload(): void {
    this.containerEl.addClass('nestboard-embed');
    const shell = this.containerEl.createDiv({ cls: 'nestboard-embed-shell' });
    const target = this.spec.path;
    if (!target) {
      this.renderMessage(shell, t('embed.invalid'));
      return;
    }
    void this.loadBoard(shell, target);
  }

  override onunload(): void {
    this.disposed = true;
  }

  // ── 内部 ────────────────────────────────────────────────────

  /**
   * ★ 名字刻意不叫 `load`：`MarkdownRenderChild`（`Component`）已经有一个无参
   *   `load()` 钩子，重名会被基类签名钉住（编译不过），而这里的语义完全不同。
   */
  private async loadBoard(shell: HTMLElement, target: string): Promise<void> {
    const file = this.resolveFile(target);
    if (!file) {
      this.renderMessage(shell, t('embed.notFound', { path: target }));
      return;
    }

    const result = await this.readBoard(file);
    if (!result.ok) {
      this.renderMessage(shell, t('embed.loadFailed', { error: result.reason }));
      return;
    }

    // 读盘回来时笔记可能已经关了（见类注释）——此时不要再碰 DOM
    if (this.disposed) return;
    shell.empty();
    this.renderBoard(shell, result.board, file);
  }

  /**
   * 路径 → 文件。
   *
   * 先走 `getFirstLinkpathDest`（Obsidian 自己的链接解析：相对路径、同名消歧都由它管），
   * 取不到再退到"当作 Vault 绝对路径直查" —— 代码块里写 `Boards/A.nboard` 是常见写法，
   * 而它未必经过链接索引。
   */
  private resolveFile(target: string): TFile | null {
    const linkpath = isBoardPath(target) ? target.trim() : `${target.trim()}.${BOARD_EXT}`;
    const resolved = this.app.metadataCache.getFirstLinkpathDest(linkpath, this.sourcePath);
    if (resolved instanceof TFile) return resolved;
    const direct = this.app.vault.getAbstractFileByPath(linkpath);
    return direct instanceof TFile ? direct : null;
  }

  /**
   * 读一块板。
   *
   * ★ 失败时返回**原因**而不是 `null`：第一次读失败要说清"为什么"（坏文件 / 权限），
   *   而小窗里重读失败只需一句笼统的话（用户没在等它，说太细反而像报错）。
   *   两种措辞都从这一份原因里派生 —— 读盘这件事只有一份实现。
   */
  private async readBoard(file: TFile): Promise<BoardReadResult> {
    try {
      const parsed = parseBoardJson(await this.app.vault.cachedRead(file));
      return parsed.ok ? { ok: true, board: parsed.board } : { ok: false, reason: parsed.reason };
    } catch (error) {
      return { ok: false, reason: describeError(error) };
    }
  }

  private renderBoard(shell: HTMLElement, board: BoardFile, file: TFile): void {
    const head = shell.createDiv({ cls: 'nestboard-embed-head' });
    head.createSpan({ cls: 'nestboard-embed-title', text: file.basename });
    head.createSpan({
      cls: 'nestboard-embed-count',
      text: t('embed.cards', { count: board.cards.length }),
    });

    const open = head.createEl('button', {
      cls: 'nestboard-embed-open',
      text: t('embed.open'),
    });
    open.type = 'button';
    open.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openBoardView(this.app, file.path);
    });

    const body = shell.createDiv({ cls: 'nestboard-embed-body' });
    // 写了 `height:` 就是小窗（T7.09）：高度是用户定的、宽度跟着栏宽走、内容实时重画
    if (this.spec.height !== null) {
      this.mountWindow(body, file, board);
      return;
    }

    const bounds = resolveExportBounds(board, { range: 'all', padding: DEFAULT_PNG_PADDING });
    const plan = planPngExport(bounds, { range: 'all', scale: 1, paginate: false });
    const tile = plan.tiles[0];
    if (!tile || board.cards.length === 0) {
      this.renderMessage(body, t('embed.empty'));
      return;
    }

    const canvas = body.createEl('canvas', { cls: 'nestboard-embed-canvas' });
    canvas.width = Math.max(1, Math.round(tile.width * plan.scale));
    canvas.height = Math.max(1, Math.round(tile.height * plan.scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.renderMessage(body, t('embed.loadFailed', { error: 'canvas 2d context unavailable' }));
      return;
    }

    renderTile(ctx, board, tile, {
      scale: plan.scale,
      transparent: false,
      background: board.view.background,
      gridSize: board.settings.gridSize,
      // 主题色从**嵌入容器**上读：缩略图要跟着笔记所在的主题走，而不是白板视图的主题
      palette: readPngPalette(this.containerEl),
      maxLines: EMBED_MAX_LINES,
    });
  }

  /**
   * 挂上只读小窗（T7.09 / `F7-10`）。
   *
   * 生命周期只有三件事：观察器报出宽度 → 读文件 → 画；目标板被保存 → 重读重画；
   * 笔记关掉 → 全收掉（`onunload`）。**没有第四件** —— 它不写任何东西，
   * 与白板卡那扇小窗（`cards/boardRef.ts` 的 `mountWindow`）是同一条路子的两个宿主。
   *
   * ★ 高度**先写死再量**：`height:` 写进 `body` 的 `style.height`（那是"用户要的多高"），
   *   规划时量的却是 `clientHeight`（那是"实际拿到多高"）。两者在正常情况下相等，
   *   而边框 / 主题自己的 `box-sizing` 一来就不等了 —— 以**量到的**为准，
   *   画布才会正好贴在框里，而不是宽出两个像素被裁掉一条。
   */
  private mountWindow(body: HTMLElement, file: TFile, initial: BoardFile): void {
    const height = this.spec.height;
    if (height === null) return;
    body.addClass('is-window');
    body.style.height = `${height}px`;

    const canvas = body.createEl('canvas', { cls: 'nestboard-embed-window' });
    // 先压成 0×0：`<canvas>` 默认后备尺寸 300×150，不压下去会先闪一块透明方块
    canvas.width = 0;
    canvas.height = 0;
    canvas.hide();

    // 空板 / 读不到时的兜底文案：与小窗共用同一个框，不另起一套 DOM
    const message = body.createDiv({ cls: 'nestboard-embed-window-message' });
    message.hide();

    const doc = this.containerEl.ownerDocument;
    /** 重画序号：异步读回来时对不上就作废（与白板卡那条同理） */
    let generation = 0;
    let observer: ResizeObserver | null = null;

    const showMessage = (text: string): void => {
      message.textContent = text;
      message.show();
      canvas.hide();
    };

    const draw = (): void => {
      if (this.disposed) return;
      const cssWidth = Math.floor(body.clientWidth);
      const cssHeight = Math.floor(body.clientHeight);
      // 还没布局：等观察器报到真实尺寸再画（见 `MIN_EMBED_WINDOW_SIDE`）
      if (cssWidth < MIN_EMBED_WINDOW_SIDE || cssHeight < MIN_EMBED_WINDOW_SIDE) return;

      const request = ++generation;
      void this.readBoard(file).then((result) => {
        if (this.disposed || request !== generation) return;
        if (!result.ok) {
          showMessage(t('embed.loadFailed', { error: result.reason }));
          return;
        }
        if (result.board.cards.length === 0) {
          showMessage(t('embed.empty'));
          return;
        }
        const dpr = doc.defaultView?.devicePixelRatio ?? 1;
        const plan = planBoardWindow(result.board, cssWidth, cssHeight, dpr);
        if (!plan) {
          showMessage(t('embed.empty'));
          return;
        }

        canvas.width = plan.width;
        canvas.height = plan.height;
        canvas.style.width = `${plan.cssWidth}px`;
        canvas.style.height = `${plan.cssHeight}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          showMessage(t('embed.loadFailed', { error: 'canvas 2d context unavailable' }));
          return;
        }
        try {
          // 主题色从**嵌入容器**上读（与缩略图同一条理由）：小窗要跟着笔记所在的主题走
          paintBoardThumbnail(ctx, result.board, plan, readPngPalette(this.containerEl));
        } catch (error) {
          console.warn('[nestboard] 绘制嵌入小窗失败', describeError(error));
          return;
        }
        message.hide();
        canvas.show();
      });
    };

    // 第一次也走观察器（它必然先报一次）：不额外调 `draw()`，否则会连读两遍文件
    if (typeof ResizeObserver === 'function') {
      const resize = new ResizeObserver(() => draw());
      observer = resize;
      resize.observe(body);
    } else {
      // 没有观察器的宿主：用**已经读到的那一份**画一次，尺寸取当下拿得到的
      const cssWidth = Math.floor(body.clientWidth);
      const cssHeight = Math.floor(body.clientHeight);
      const plan =
        cssWidth >= MIN_EMBED_WINDOW_SIDE && cssHeight >= MIN_EMBED_WINDOW_SIDE
          ? planBoardWindow(initial, cssWidth, cssHeight, doc.defaultView?.devicePixelRatio ?? 1)
          : null;
      if (plan && initial.cards.length > 0) {
        canvas.width = plan.width;
        canvas.height = plan.height;
        canvas.style.width = `${plan.cssWidth}px`;
        canvas.style.height = `${plan.cssHeight}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) paintBoardThumbnail(ctx, initial, plan, readPngPalette(this.containerEl));
        canvas.show();
      } else {
        showMessage(t('embed.empty'));
      }
    }

    // 目标板一保存就重画 —— 不订阅的话，"小窗"里永远是最初那一眼
    // ★ 收 `unknown` 再自己收窄：`vault.on` 的回调签名是弱类型的 `(...data: unknown[])`，
    //   直接写 `{ path: string }` 编译不过；而 `TFile` 判断顺带把"删除的是别的文件"挡掉
    const onChanged = (changed: unknown): void => {
      if (changed instanceof TFile && changed.path === file.path) draw();
    };
    this.app.vault.on('modify', onChanged);
    this.app.vault.on('delete', onChanged);

    // ★ 走 `register` 而不是自己记一个 `dispose`：它由 `MarkdownRenderChild.unload()`
    //   在 `onunload` 之后统一跑，笔记被关掉的那一刻一定会执行到
    this.register(() => {
      this.disposed = true;
      observer?.disconnect();
      observer = null;
      this.app.vault.off('modify', onChanged);
      this.app.vault.off('delete', onChanged);
    });
  }

  /** 失败 / 空态：清掉半截内容再写一句解释（避免"缩略图 + 错误文案"叠在一起） */
  private renderMessage(shell: HTMLElement, message: string): void {
    shell.empty();
    shell.createDiv({ cls: 'nestboard-embed-message', text: message });
  }
}
