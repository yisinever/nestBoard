/**
 * 板级缩略图管线的生产实现（T4.16 / `F2-8-2`）。
 *
 * 与 `ObsidianThumbnailBridge`（原图 → 256px）**共用同一套缓存与并发生成逻辑**
 * （`io/ThumbnailCache.ts` + `io/ThumbnailProvider.ts`），区别只有一处：
 * "画什么"换成了"整块板"—— 原图渲染器把一张图缩小，板级渲染器把模型画一遍。
 *
 * ★ 一块板与一个 `path` 一一对应，而缓存键是 `<路径>@<mtime>@<size>`
 *   （`memoryKey`）：板的字节一变，键就变，旧缩略图自动成为可删的垃圾，
 *   与图片卡完全同一套失效语义，不需要另写逻辑。
 *
 * ★ **只读不建 session**：这里读 `.nboard` 是"为了画一张图"，不是"打开这块板"。
 *   所以不走 `BoardRepository`（那会把板装进内存、跟踪脏状态、参与写盘仲裁），
 *   而是自己 `cachedRead` + 解析 —— 一块 100 张卡的板不该因为"有人瞄了一眼预览"
 *   就变成常驻内存的编辑对象。
 *
 * ★ 铁律同其余几座桥：**任何失败都退化成 `null`**（读不到 / 解析失败 / 空板 /
 *   画布拿不到上下文）。卡面那时会继续显示概要面板，而概要面板本来就是"没有预览时"
 *   的正确形态。
 *
 * ★ T7.09（`F7-10`）起，本桥多两个入口：`readBoard()`（把模型交给白板卡的**只读小窗**
 *   自己按卡面尺寸画）与 `watchBoard()`（那块板一保存就叫醒小窗）。
 *   之所以都放在这里而不是让视图各自去读文件：**"一块 `.nboard` 怎么读"只能有一份实现**
 *   （`cachedRead` → 迁移 → 规范化，见 `readBoardForPreview`），缩略图与小窗各写一遍，
 *   迟早会出现"两处对同一块板的解析结果不同"。
 */

import { TFile, type App, type EventRef } from 'obsidian';

import { BOARD_EXT } from '../constants';
import { paintBoardThumbnail, planBoardThumbnail } from '../export/boardThumb';
import { readPngPalette } from '../export/toPng';
import { THUMB_QUALITY, ThumbnailCache, type ThumbnailRenderer } from '../io/ThumbnailCache';
import { migrateBoardFile } from '../io/migrate';
import { ThumbnailProvider } from '../io/ThumbnailProvider';
import type { BoardFile } from '../model/schema';
import { normalizeBoardFile, safeJsonParse } from '../model/validate';
import { describeError } from '../util/errors';
import {
  AdapterThumbnailStore,
  vaultFileOf,
  VaultThumbnailSource,
} from './ObsidianThumbnailBridge';

export class ObsidianBoardThumbnailBridge extends ThumbnailProvider {
  private readonly app: App;
  /** `vault.on('modify')` 的凭据；`dispose()` 要按它退订 */
  private readonly modifyRef: EventRef;
  /** `watchBoard()` 登记的订阅（T7.09）；`dispose()` 要一并退订 */
  private readonly watchers = new Set<EventRef>();

  /**
   * @param paletteHost 读主题色的宿主元素。传白板视图的根节点，缩略图就会跟着
   *   **当前视图的主题**走 —— 与笔记里的板嵌入（`BoardEmbed` 用它的容器）同一条约定。
   *   不传则退回 `document.body`。
   */
  constructor(app: App, paletteHost?: Element, memoryLimit?: number) {
    super(
      new ThumbnailCache({
        store: new AdapterThumbnailStore(app),
        render: createBoardRenderer(app, paletteHost),
        memoryLimit,
      }),
      new VaultThumbnailSource(app),
    );
    this.app = app;

    // ★ 磁盘缓存靠 `memoryKey` 里的 `mtime`/`size` 自动换键，不会过期；
    //   但 `peek` 的同步答案来自 `ThumbnailProvider.ready` 那张 `path → objectURL` 表，
    //   它**不知道**文件变了。不订阅的话，"进子板改完再回父板"会一直显示旧图 ——
    //   卡片确实重新渲染了（`get` 会拿到新键），可 `peek` 先命中旧表，于是永远不换。
    //   这里按 `.nboard` 的修改事件把映射清掉，让下一次渲染重新 `stat` + 取新键。
    this.modifyRef = app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === BOARD_EXT) this.invalidate(file.path);
    });
  }

  /**
   * 读一块板的**模型**（T7.09 / `F7-10`）：白板卡的只读小窗按卡面尺寸重画时要用。
   *
   * ★ 与缩略图渲染器**走同一条读法**（`cachedRead` → 迁移 → 规范化，见
   *   `readBoardForPreview`）：同一块板在两处必须解析成同一个模型 —— 否则
   *   "小窗里有的卡，缩略图里没有"这种怪事迟早会出现，而且极难查。
   */
  readBoard(path: string): Promise<BoardFile | null> {
    return readBoardForPreview(this.app, path);
  }

  /**
   * 订阅**某一块板**的文件变化（T7.09）：保存 / 删除时叫一下 `listener`。
   * 返回退订函数（可以重复调用 —— 卡片与桥各退一次不会互相打脸）。
   *
   * ★ 订阅登记在本桥的 `watchers` 里：万一某条卡片回收路径忘了退订，
   *   `dispose()` 仍会收干净。卡片的 `destroy()` 只是让窗口活得更短，
   *   不该成为"监听器不泄漏"的唯一保证。
   *
   * ★ 只听 `modify` 与 `delete`，不听 `rename`：改名之后**路径**已经变了，
   *   卡片内容会被视图的重命名跟踪改写（于是重新渲染、重新订阅），
   *   这里再收一次旧路径的事件只是重复劳动。
   */
  watchBoard(path: string, listener: () => void): () => void {
    const changed = (file: unknown): void => {
      if (file instanceof TFile && file.path === path) listener();
    };
    const refs: EventRef[] = [
      this.app.vault.on('modify', changed),
      this.app.vault.on('delete', changed),
    ];
    for (const ref of refs) this.watchers.add(ref);

    return () => {
      for (const ref of refs) {
        if (!this.watchers.delete(ref)) continue;
        this.app.vault.offref(ref);
      }
    };
  }

  override dispose(): void {
    // 订阅挂在 Vault（不是本对象）上：不退订的话，视图关掉之后每个改动事件
    // 都会去找一个已经清空的表 —— 泄漏的不是内存而是监听器
    for (const ref of this.watchers) this.app.vault.offref(ref);
    this.watchers.clear();
    this.app.vault.offref(this.modifyRef);
    super.dispose();
  }
}

/**
 * 渲染端口：`.nboard` → 256px WebP。
 *
 * 与图片渲染器的根本差别：它**不看** `source.url`（那指向 `.nboard` 文件本身，
 * 不是一张能 draw 的图），而是按 `source.path` 把模型读出来再画。
 */
function createBoardRenderer(app: App, paletteHost?: Element): ThumbnailRenderer {
  return async (source) => {
    const board = await readBoardForPreview(app, source.path);
    if (!board) return null;

    const plan = planBoardThumbnail(board);
    // 空板：没有卡片也没有分栏，画出来是一张纯背景 —— 那与"读取失败"长得一样，
    // 而概要面板至少会说一句"0 张卡"
    if (!plan) return null;

    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    try {
      // 主题色从宿主元素上读（与 `BoardEmbed` 一致）：缩略图里的卡片颜色必须
      // 和用户在这个视图里看到的那些颜色是同一套
      paintBoardThumbnail(ctx, board, plan, readPngPalette(paletteHost ?? document.body));
    } catch (error) {
      // 一张图画不出来不该让整张卡挂掉 —— 这里兜住，让上层退回概要面板
      console.warn('[nestboard] 绘制板缩略图失败', describeError(error));
      return null;
    }

    // `toBlob` 的失败分支是回调收到 `null`，不是抛错
    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/webp', THUMB_QUALITY);
    });
  };
}

/**
 * 读一块 `.nboard` 并解析成模型；任何一步失败都返回 `null`。
 *
 * ★ 三步的顺序与 `BoardRepository.parseBoardText` **必须一致**：JSON → 迁移 → 规范化。
 *   少了迁移这一步，老版本的板会渲染成一片空白（字段名对不上，卡片全被判为非法），
 *   而那看起来就是"这块板是空的"。
 */
async function readBoardForPreview(app: App, path: string): Promise<BoardFile | null> {
  try {
    const file = vaultFileOf(app, path);
    if (!file) return null;

    // `cachedRead` 而不是 `adapter.read`：板可能正开在另一个标签页里，
    // 缓存里就是它最新的一次保存结果，读它既省一次磁盘也避免读到半截
    const raw = await app.vault.cachedRead(file);

    const json = safeJsonParse(raw);
    if (!json.ok) return null;

    const migrated = migrateBoardFile(json.value);
    if (!migrated.ok) return null;

    const normalized = normalizeBoardFile(migrated.value);
    return normalized ? normalized.board : null;
  } catch (error) {
    console.warn('[nestboard] 读取板缩略图来源失败', describeError(error));
    return null;
  }
}
