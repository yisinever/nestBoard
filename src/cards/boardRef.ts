/**
 * 白板卡 / 嵌套白板（T1.61 / `F2-8-1`–`F2-8-3`、`F2-8-7`）。
 *
 * 一张卡指向另一块 `.nboard`：**双击进到那块板里去**，卡面显示标题 + 概要
 * （有多少张卡、多少个分栏）。它是"无限画布 + 无限层级"这个卖点的落点 ——
 * 顶层板只放几个入口，细节一层层收进去，任何一块板都不会被画满。
 *
 * 三条与 `noteRef` 同源、但方向相反的设计：
 *
 *  * **不 import `obsidian`**：读目标板的概要、打开目标板都走 `CardRenderContext.boards`
 *    （`BoardNavBridge`）。"开 leaf"是视图的活，"读 `.nboard`"是 io 的活，
 *    两头都不该被卡片定义 import —— 端口把这两件事一起隔开；
 *  * **概要异步落地**：`summary()` 回来之前先画标题，回来后再填计数，
 *    并喊 `contentReady()`（T1.38）。否则"显示子卡片数量"（F2-8-7）永远不会显示；
 *  * **点进去**：`onDoubleClick` 返回 `true` 表示已被本卡接管，
 *    视图不会再把它当成"进入编辑态"（白板卡没有可编辑的正文）。
 *    空格位（`path` 为空）上双击 = "就在这儿开一块子板"，落文件 + 写回内容 +
 *    记历史全在视图那一侧（`BoardNavBridge.createChildBoard`），卡片只负责发起。
 *
 * ★ 缩略图预览（`F2-8-2` / T4.16）：`preview === 'thumb'` 时卡面显示**目标板自己**
 *   的一张 256px 缩略图 —— 由 `export/boardThumb.ts` 复用 PNG 导出那条渲染路径画出来，
 *   按 `<路径>@<mtime>@<size>` 缓存（`io/ThumbnailCache.ts`），所以进子板改完再回来
 *   看到的就是新图，而不是一张过期的快照。
 *
 *   缩略图**拿不到**时（还没生成好 / 空板 / 读不到 / 这个环境没有缩略图能力）卡面
 *   显示一块带边框的概览区（数量 + 空板提示）—— 两条路都不留空白，也都不画假图。
 *
 * ★ 只读小窗（`F7-10` / T7.09）：`preview === 'live'` 时卡面改成**按卡面自己的像素尺寸**
 *   把目标板矢量重画一遍 —— 一扇窗，而不是一张贴上去的小照片。
 *
 *   为什么缩略图不够：它是**固定 256px** 的（那个尺寸是为了能落盘缓存、能让多张卡看起来
 *   一致），而卡面是用户拖出来的。卡比 256px 大时，图被拉糊，字读不出来 —— 而"不进去
 *   就能读到内容"正是这块卡存在的理由。
 *
 * ★ mini 形态（`O18`，取代 `O09` 的"只留一张缩略图"）：`preview === 'mini'` 时
 *   **不预览任何内容**，卡面只剩**正中一个图标**，名字挪到卡**外面**的正下方居中，
 *   尺寸由模型钉成固定正方形（{@link BOARD_REF_MINI_SIZE}，用户拖不了）。
 *
 *   它存在的场景是"把几块子板排成一排当目录看"：那时每一格都顶着同一段
 *   "子板名 + 12 张卡"的文字，反而是噪声 —— 而 87px 见方的格子里一张缩略图
 *   本来也读不出任何信息（`O09` 那一版正是这么做的，实际用起来就是"一排糊掉的小图"）。
 *   所以这一版把整格让给**一个记号 + 一个名字**：记号回答"是哪一类"，名字回答"是哪一块"。
 *
 *   ★ 它与 `thumb` / `live` **不共用任何一块渲染路径**（那是 `O09` 的做法）：
 *     不读概要、不查缩略图缓存、不挂只读小窗 —— 三样都只在"要看内容"时才有意义。
 *     于是它也不需要 `ctx.contentReady`：卡面在 `render()` 返回时就画完了。
 *
 *   三件事必须成对做，缺一个就会出现"窗口永远空着"或"越画越慢"这类难查的毛病：
 *
 *   1. **尺寸从卡面来**：量不到（视图还没布局 / 刚 append）就先不画，等 `ResizeObserver`
 *      报到真实尺寸 —— 按 0 去规划只会得到一张 1×1 的图；
 *   2. **重画要有先后**：读模型是异步的，一次尺寸变化可能连发好几次读。每次读带一个
 *      序号，回来时对不上就丢掉（否则"旧尺寸的图"会盖住"新尺寸的图"）；
 *   3. **收得干净**：观察器与文件订阅都必须在卡片被回收时退掉 —— 它们是挂在
 *      Vault 与布局系统上的，不是挂在这张卡上。见 `WINDOW_CLEANUPS`。
 *      ★ 两种"结束"都要收：`destroy()`（卡片被回收进复用池）**和**下一轮 `render()`
 *      （同一张卡换了预览档位 / 换了目标板）。后一条最容易漏 —— 内容槽元素是复用的，
 *      走的是重新 `render()` 而不是「回收 → destroy → 再挂」，于是 `destroy` 根本不发生。
 */

import { BOARD_EXT, BOARD_REF_MINI_SIZE } from '../constants';
import { planBoardWindow, paintBoardThumbnail } from '../export/boardThumb';
import { readPngPalette } from '../export/toPng';
import type { BoardFile, BoardRefContent, CardOfType } from '../model/schema';
import { normalizeIcon } from '../util/emoji';
import { newBoardRefContent } from '../model/factories';
import { describeError } from '../util/errors';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import type {
  BoardSummary,
  CardRenderContext,
  CardTypeDefinition,
  CardTypeMenuItem,
} from './registry';

/** 新建白板卡的默认尺寸：比便签卡大一圈，够放标题 + 概览 */
export const BOARD_REF_DEFAULT_SIZE: Size = { width: 280, height: 180 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉** */
const BOARD_REF_CLASSES = [
  'nestboard-board-ref',
  'is-missing',
  'is-empty',
  'is-preview',
  'is-window',
  // mini 形态（`O18`）：不摘掉的话，下一位租客会继承"卡面只有正中一个图标"
  // 的整套排版假设 —— 尤其 `styles.css` 里那条"藏掉尺寸手柄"的规则会跟着它走
  'is-mini',
] as const;

/**
 * 只读小窗的**尺寸下限**（CSS px）：比它更小的框连一行字都放不下，不值得画。
 *
 * ★ 它真正的职责是兜住"**还没布局**"：卡片是先 `render()` 再插进 DOM 的，
 *   那一刻 `clientWidth / clientHeight` 都是 0，照 0 规划会得到一张 1×1 的图，
 *   而卡面此后不会自己变好看 —— 于是看起来就是"这扇窗永远是空的"。
 *   等 `ResizeObserver` 报到真实尺寸再画，是这个组件唯一正确的顺序。
 */
const MIN_WINDOW_SIDE = 24;

/**
 * 只读小窗要收走的东西（观察器 + 文件订阅），按**槽位元素**挂。
 *
 * ★ 为什么用 `WeakMap` 而不是往 `el` 上挂字段：槽位元素是**复用的**（`CardLayer` 回收后
 *   交给另一张卡），往上挂字段迟早会漏给下一张卡；而 `destroy(el)` 只拿得到元素本身，
 *   没有别的地方能存这个闭包。
 * ★ `WeakMap` 还顺手解决了"忘记收"的最坏情况：元素被丢弃时这一项自动消失，
 *   不会把闭包永久留在内存里（订阅本身另有 `dispose()` 兜底，见 `watchBoard`）。
 */
const WINDOW_CLEANUPS = new WeakMap<HTMLElement, () => void>();

// ─────────────────────────────────────────────────────────────
// 纯逻辑（可单测）
// ─────────────────────────────────────────────────────────────

/**
 * 路径 → 白板标题：取文件名并**剥掉扩展名**。
 *
 * 只在"读不到 `meta.title`"时兜底用（目标板还没建好 / 解析失败）——
 * 显示 `子板.nboard` 而右上角还写着"进入白板"，用户会以为扩展名是标题的一部分。
 */
export function boardTitleOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 白板卡此刻该画什么 */
export type BoardRefState = 'empty' | 'missing' | 'ready';

/**
 * @param exists Vault 查询函数；`null` = 没有 Vault 桥（单测场景），一律当作"能读"
 */
export function boardRefState(
  content: Pick<BoardRefContent, 'path'>,
  exists: ((path: string) => boolean) | null,
): BoardRefState {
  if (content.path.length === 0) return 'empty';
  if (!exists) return 'ready';
  return exists(content.path) ? 'ready' : 'missing';
}

/** `F2-8-7`：概览行文案（独立出来是为了让"0 张卡"这句话也被单测钉住） */
export function cardCountLabel(count: number): string {
  return t('card.boardRef.cards', { count });
}

/**
 * 概要那一行的数字（`2.2.0` 收尾）。
 *
 * ★ 脑图那一段**只有真的有树**才出现：绝大多数板子一棵都没有，让每一张引用卡
 *   都拖着"0 棵脑图"只是噪音（与模板列表那条同一取舍）。
 * ★ 单独抽成函数是为了能在 node 下断言 —— 引用卡那块 DOM 在单测里搭不起来。
 */
export function summaryCountLabel(summary: BoardSummary): string {
  return summary.minds > 0
    ? t('card.boardRef.cardsAndMinds', {
        cards: summary.cards,
        minds: summary.minds,
      })
    : cardCountLabel(summary.cards);
}

/**
 * 换预览档位时要顺手写回去的尺寸；`null` = "尺寸一个字都不动"（`O18`）。
 *
 * mini 是**固定正方形**，所以它的尺寸不是用户拉出来的、而是形态自带的：
 * 进这一档钉住 {@link BOARD_REF_MINI_SIZE}，离开这一档还给该类型的默认尺寸。
 *
 * ★ 为什么"离开"要判一次"还停在那个正方形上"：只有停在正方形上才说明这个尺寸是
 *   mini 给的、可以收回去。否则（手改过的文件、或者用户先切走再切回来）那个尺寸
 *   就是有意义的输入，替用户改成 280×180 是**抹掉他刚做过的事**。
 * ★ 与 `model/validate` 的读入口归一**必须是同一条判据**：那边管"存量文件进来时掰正"，
 *   这边管"用户点菜单时钉住"。两边不一致的表现是"选了 mini 是正方形、重开又变回去"。
 */
export function boardRefPreviewSize(
  next: BoardRefContent['preview'],
  card: Pick<CardOfType<'boardRef'>, 'width' | 'height' | 'content'>,
): Size | null {
  if (next === 'mini') return BOARD_REF_MINI_SIZE;
  if (card.content.preview !== 'mini') return null;
  const onSquare =
    card.width === BOARD_REF_MINI_SIZE.width && card.height === BOARD_REF_MINI_SIZE.height;
  return onSquare ? BOARD_REF_DEFAULT_SIZE : null;
}

// ─────────────────────────────────────────────────────────────
// 卡片定义
// ─────────────────────────────────────────────────────────────

export const boardRefCard: CardTypeDefinition<'boardRef'> = {
  type: 'boardRef',

  get displayName(): string {
    return t('card.type.boardRef');
  },

  icon: 'layout-dashboard',
  /**
   * 新建白板卡的默认主色：`#6b84ff`（用户 2026-09-18："默认颜色改成 #6b84ff"）。
   *
   * ★ 只影响新建：已存在的白板卡一个字节都不动。迷你形态整格铺的就是这个色
   *   （见样式表里 `.nestboard-card:has(> .nestboard-board-ref.is-mini)`）。
   */
  defaultColor: '#6b84ff',
  /**
   * 新卡片的默认尺寸 = **迷你那个正方形**（不是 `BOARD_REF_DEFAULT_SIZE`）。
   *
   * ★ 这一条是"新建的白板卡看起来还不是迷你"的根因（用户 2026-09-16）：档位改成 mini
   *   之后，**尺寸**还按老默认给 280×180 ⇒ 新建出来是一个"迷你排版塞在大方块里"的
   *   四不像，而重开 Obsidian 时被读入口掰成 87×87 才真迷你（所以"重载之后就对了"）。
   *   mini 的尺寸本来就由形态钉死，默认值必须与它一致 —— 否则同一件事有两处口径。
   */
  defaultSize: BOARD_REF_MINI_SIZE,

  createDefaultContent(): BoardRefContent {
    // ★ 走 `model/factories` 的 `newBoardRefContent()`，**不在这里另写一份**：
    //   新建白板卡有两条入口 —— `createCard`（走 `CONTENT_FACTORIES`）与这里，
    //   两处各写一份正是"改了档位却没用"的来源（另一处还在给 `thumb` 与空图标）。
    return newBoardRefContent();
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    // ★ 先收上一次渲染留下的东西：内容槽元素是**复用**的（换预览档位走的是
    //   重新 `render()`，而不是「回收 → destroy → 再挂」），所以 `destroy` 那一步
    //   不会发生。不收的话每换一次档位就多留一个 Vault 订阅与一个观察器，
    //   而它们都在盯着一张已经不在 DOM 里的画布。
    WINDOW_CLEANUPS.get(el)?.();
    WINDOW_CLEANUPS.delete(el);

    el.classList.add('nestboard-board-ref');
    el.classList.remove('is-missing', 'is-empty', 'is-preview', 'is-mini');
    delete el.dataset.placeholder;

    const doc = el.ownerDocument;
    const { path, preview, showCount } = card.content;
    const notes = ctx.notes ?? null;
    const state = boardRefState(card.content, notes ? (value) => notes.exists(value) : null);

    if (state === 'empty') {
      el.classList.add('is-empty');
      el.dataset.placeholder = 'true';
      el.replaceChildren(doc.createTextNode(t('card.boardRef.empty')));
      return;
    }
    if (state === 'missing') {
      el.classList.add('is-missing');
      el.dataset.placeholder = 'true';
      el.replaceChildren(doc.createTextNode(t('card.boardRef.missing', { path })));
      return;
    }

    // mini 形态（`O18`）：**不预览内容**。整格只放两样东西 —— 正中一个记号、
    // 卡外正下方一个名字（名字为什么要出卡、以及"它撑不歪方格"是为什么，
    // 见 `createMiniName` 与样式表里 `.nestboard-board-ref-mini-title` 那两段）。
    // ★ 所以它在这一步就返回：概要、缩略图、只读小窗三条路一条都不碰。
    //   `O09` 那一版是"再少两行字的 thumb"（挂在缩略图管线上），而"不要预览内容"
    //   把那条挂靠整个去掉了：87px 见方的格子里，一张缩略图本来也读不出任何信息。
    // ★ 也不喊 `ctx.contentReady()`：卡面在 `render()` 返回的这一刻就已经画完了，
    //   没有"稍后会到的东西"要等。
    if (preview === 'mini') {
      el.classList.add('is-mini');
      el.replaceChildren(createMiniMark(doc, card.content.icon), createMiniName(doc, path));
      return;
    }

    // 卡面的两块：标题行 + 预览区
    const children: HTMLElement[] = [];

    // 标题先落地：概要要等一次异步读，而"这是哪块板"必须立刻可见
    const icon = doc.createElement('span');
    icon.className = 'nestboard-board-ref-icon';
    // 卡面图标（`O10`）：设了 emoji 就把那一格画成它，没设就退回"这是白板"的
    // 强调色小方块（老外观）。★ 判据走 `normalizeIcon`（与读写入口同一份），
    // 空串 / 控制字符 / 超长都当"没设" —— 手改过的文件也不能把卡面撑坏。
    const emoji = normalizeIcon(card.content.icon);
    if (emoji.length > 0) {
      icon.classList.add('is-emoji');
      icon.textContent = emoji;
    }

    const title = doc.createElement('span');
    title.className = 'nestboard-board-ref-title';
    title.textContent = boardTitleOf(path);
    // 完整路径：卡面只放得下文件名，而"这是哪一块板"常常只有路径能分清
    // （两层各有一块叫「子板」的板是完全正常的）。
    // ★ 两个属性都设，**不是冗余**：`title` 是浏览器原生 tooltip，需要鼠标静止
    //   一秒才弹、在 Electron 里还常常被吞；`aria-label` 是 Obsidian 自己那套
    //   tooltip 与读屏共用的一份。只设前者时，悬停标题行不会出现任何东西。
    // ★ 不用 `setTooltip()`：那要 import `obsidian`，而本文件刻意不 import
    //   （解析与渲染判定要能在 node 下直接单测）。`aria-label` 是纯 DOM 属性，
    //   走同一条路却不必付这个代价。
    title.title = path;
    title.setAttribute('aria-label', path);

    const header = doc.createElement('div');
    header.className = 'nestboard-board-ref-header';
    header.appendChild(icon);
    header.appendChild(title);
    children.push(header);

    const body = doc.createElement('div');
    body.className = 'nestboard-board-ref-body';
    // 两种预览都画在带边框的预览区里；`none` 时那一圈边框不该出现（它什么都没有）
    if (preview !== 'none') body.classList.add('is-preview');

    const count = doc.createElement('div');
    count.className = 'nestboard-board-ref-count';
    body.appendChild(count);
    children.push(body);

    el.replaceChildren(...children);

    const boards = ctx.boards;
    if (!boards) return;
    // ★ 不 await：渲染必须同步完成。回来时卡片可能已被回收（`isConnected`）
    void boards.summary(path).then((summary) => {
      if (!el.isConnected) return;
      paintSummary(body, count, summary, showCount);
      ctx.contentReady?.();
    });

    // 只读小窗（T7.09）：与缩略图互斥 —— 两者画在同一块预览区里，同时挂上只会打架
    if (preview === 'live') {
      mountWindow(el, body, path, ctx);
      return;
    }

    // 缩略图与概要**并行**要，两者不互相依赖：概要说"有多少张卡"，缩略图说"长什么样"。
    // 谁先到谁先显示，卡面不会为了等其中任何一个而空着
    // ★ mini（`O18`）在上面的 mini 分支里就返回了，走不到这里 —— 它没有"要看的东西"
    if (preview !== 'thumb') return;
    const thumbs = boards.thumbnail;
    if (!thumbs) return;

    // 同步那一查：有就当场挂上，一帧都不用等（缩略图是本地缓存，绝大多数情况都在）
    const cached = thumbs.peek(path);
    if (cached !== null) {
      paintThumbnail(body, cached);
      ctx.contentReady?.();
      return;
    }
    void thumbs.get(path).then((url) => {
      // 拿不到就**什么都不做**：概要面板已经是"没有预览"时的正确形态，
      // 再补一句"预览失败"只是让卡面上多一行用户无能为力的字
      if (url === null || !el.isConnected) return;
      paintThumbnail(body, url);
      ctx.contentReady?.();
    });
  },

  contextMenu(card, menuCtx) {
    const empty = card.content.path.length === 0;
    const items: CardTypeMenuItem[] = [];

    // 「新建子白板」（T1.61）只在卡片**还没有目标**时出现：这张卡已经指向别处时，
    // 这个动作不再是"给它找个去处"，而是"把那一块板从画布上抹掉" ——
    // 那种事不该藏在类型菜单里，用户想要的话得自己先清空这张卡
    if (empty) {
      items.push({
        id: 'board-create',
        title: t('menu.card.newChildBoard'),
        icon: 'folder-plus',
        disabled: menuCtx.multiple,
        action: 'newChildBoard',
      });
    }

    items.push({
      id: 'board-open',
      title: t('menu.card.openBoard'),
      icon: 'folder-open',
      disabled: menuCtx.multiple || empty,
      action: 'openBoard',
    });

    // ── 「卡面预览」那一组**收起来了**（用户 2026-09-16）───────────
    //
    // 原话："所有白板，只保留迷你形式。其他形式都不需要放出来" ⇒ 四档子菜单
    // （`thumb` / `mini` / `live` / `none`）从菜单里整个去掉，只留迷你这一档。
    //
    // ★ **光删菜单不够**：存量卡会一直停在原来那一档上（用户看到的还是缩略图），
    //   "只保留迷你"就只对新卡成立。所以三处一起改，缺一不可：
    //   ① 读入口归一 —— `model/validate.normalizeBoardRefContent` 一律读成 `mini`
    //      （尺寸由紧随其后的"mini 形态钉死正方形"接手）；
    //   ② 新建默认 —— `createDefaultContent` 也从 `mini` 起步；
    //   ③ 菜单不再给别的档 —— 就是删掉的这一段。
    // ★ 另外三档的**渲染代码与 `boardPreview*` 动作留着**：那是"读得懂旧数据"的能力
    //   （手改过的文件、别处导入的卡），删掉只会让它们变成一张认不出来的卡；
    //   它们现在是死路径，`render()` 里也就多两个分支。

    // 「卡面图标」（`O10`）：给这张板一个一眼认得的记号。
    // ★ 只在**有目标**时出现：空格位 / 断链时卡面根本不画标题行（更没有那一格），
    //   摆一个"选了也看不见"的入口比少一项更让人困惑。
    // ★ 「清除」只在本卡**确实有图标**时出现（与 `edge-label-clear` 同一条取舍）：
    //   没图标就没有可清的，一直摆着一项灰的会让人以为它本来该能点。
    if (!empty) {
      const hasIcon = normalizeIcon(card.content.icon).length > 0;
      items.push({
        id: 'board-icon',
        title: hasIcon ? t('menu.card.changeIcon') : t('menu.card.pickIcon'),
        icon: 'smile',
        // 多选时"换哪一张的图标"没有唯一答案（与 `openBoard` / 预览档位同一条约定）
        disabled: menuCtx.multiple,
        action: 'pickBoardIcon',
      });
      if (hasIcon) {
        items.push({
          id: 'board-icon-clear',
          title: t('menu.card.clearIcon'),
          icon: 'eraser',
          disabled: menuCtx.multiple,
          action: 'clearBoardIcon',
        });
      }
    }
    return items;
  },

  /**
   * 白板卡的标题就是那块 **`.nboard`** 的名字（`O37`）：改标题 = 改文件名。
   *
   * ★ 卡面上写的就是这个文件名（标题行与 mini 形态卡外那行名字都取自 `content.path`），
   *   所以"改标题"必须落到文件上 —— 只写 `card.title` 的话卡面**一个字都不会变**，
   *   用户看到的是"点了编辑标题、打完字、什么都没发生"。
   * ★ 路径跟随不用这里管：`RenameWatcher.retargetBoard` 的名单里本来就有 `boardRef`
   *   （`integration/RenameWatcher.ts`），改名之后 `content.path` 自己会跟过来，
   *   两个形态的名字于是同时更新。
   * ★ 空格位（还没建子板）返回 `null`：没有文件可改，标题照旧只是一行字。
   */
  titleFilePath(card): string | null {
    const path = card.content.path;
    return path.toLowerCase().endsWith(`.${BOARD_EXT}`) ? path : null;
  },

  onDoubleClick(card, ctx): boolean {
    const path = card.content.path;

    // 空格位（T1.61 / `F2-8-1`）：双击 = "就在这儿开一块子板"。
    // ★ 卡片层只能**发起**：落一个 `.nboard` 要 Vault，写回内容要历史栈，
    //   两样都只有视图有。所以这里递卡片 id，剩下的交给 `BoardNavBridge`。
    if (path.length === 0) {
      const create = ctx.boards?.createChildBoard;
      if (!create) return false;
      void create(card.id);
      return true;
    }

    const notes = ctx.notes;
    // 断链时不开（开了只会得到一块打不开的板），让用户先把路径修好
    if (notes && !notes.exists(path)) return false;
    if (!ctx.boards) return false;
    // 打开是异步的，但"我处理了这次双击"是同步的结论 —— 不接管的话视图会
    // 紧接着弹出一个没有意义的编辑态
    void ctx.boards.open(path);
    return true;
  },

  destroy(el: HTMLElement): void {
    // 只读小窗在 Vault 与布局系统上挂了观察器 / 订阅：**先收它们**再清 DOM。
    // 顺序无关紧要（收的是闭包，不是 DOM），但漏了这一步就是真泄漏 ——
    // 之后每保存一次那个文件，都会去写一张已经不属于任何卡片的画布
    WINDOW_CLEANUPS.get(el)?.();
    el.classList.remove(...BOARD_REF_CLASSES);
    delete el.dataset.placeholder;
    el.replaceChildren();
  },

  toMarkdown(card): string {
    // 与文件卡同理：普通 wikilink。`![[子板.nboard]]` 在导出笔记里没有可渲染的语义
    return `[[${card.content.path}]]`;
  },
};

/** 概要落地后填计数行（概要拿不到时**什么都不填**，而不是写一个假数字） */
function paintSummary(
  body: HTMLElement,
  count: HTMLElement,
  summary: BoardSummary | null,
  showCount: boolean,
): void {
  if (!summary) return;
  // 空板要显式说出来：概要面板里一片空白，用户会以为是"还没加载出来"。
  // ★ "空" = **既没有卡片也没有脑图**（`2.2.0` 收尾）：一块只放了一棵树的板子
  //   不是空板 —— 从前这里只看 `cards`，于是它会显示成"空板 / 0 张卡片"。
  if (summary.cards === 0 && summary.minds === 0) body.classList.add('is-empty');
  if (!showCount) return;
  count.textContent = summaryCountLabel(summary);
}

/**
 * mini 形态卡面正中那个记号（`O18`）。
 *
 * 设了 emoji（`O10` 的卡面图标）就画它 —— mini 把**整格面积**都让给了这一个字，
 * 这也正是那条"添加图标无效、添加之后该在正方形里居中"的反馈的落点：
 * 老版把图标画在标题行里，而 mini 连标题行都没有，于是设了也看不见。
 * 没设就退回强调色方块（与标题行里那一格是同一个记号，只是大一号）：
 * 一个纯空白的方格子和"这块板读不出来"分不清。
 */
function createMiniMark(doc: Document, icon: string | undefined): HTMLElement {
  const el = doc.createElement('span');
  el.className = 'nestboard-board-ref-mini-icon';
  const emoji = normalizeIcon(icon);
  if (emoji.length > 0) {
    el.classList.add('is-emoji');
    el.textContent = emoji;
  }
  return el;
}

/**
 * mini 形态的名字（`O18`）：画在卡**外面**的正下方居中。
 *
 * ★ 为什么挪到卡外：87px 见方的格子再切出一行文字，剩下那块既不像图也不像字；
 *   而"把几块子板排成一排当目录看"时，名字在格子下面读起来最顺（也是网格相册的老办法）。
 * ★ 它是**绝对定位**的（见样式表），于是不占卡内任何空间 —— 这就是"正方形永远是正方形"
 *   的保证：名字多长、字体多大，都撑不歪那个方格。
 * ★ `title` / `aria-label` 与标题行同一条理由都设（见上面那段注释）。
 * ★ 不 import `obsidian`：`normalizeIcon` 与 DOM 都是纯的，本文件要能在 node 下单测。
 */
function createMiniName(doc: Document, path: string): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'nestboard-board-ref-mini-title';
  el.textContent = boardTitleOf(path);
  el.title = path;
  el.setAttribute('aria-label', path);
  return el;
}

/**
 * 把缩略图挂进预览区（`F2-8-2`）。
 *
 * ★ 图与计数行的上下关系交给 CSS（`.is-thumb .nestboard-board-ref-count` 是绝对定位、
 *   压在图上），所以这里 DOM 顺序上把图**追加在最后**是安全的：绝对定位的元素天然
 *   盖住非定位的兄弟节点。计数是文字，必须比图更清楚。
 *
 * ★ `draggable = false`：Electron 里拖一个 `<img>` 会启动**原生图片拖拽**，
 *   它和画布的卡片拖拽抢同一套手势，表现是"拖这张卡的时候飞出一张幽灵图"。
 *   与 `cards/image.ts` 同一处理。
 */
function paintThumbnail(body: HTMLElement, url: string): void {
  const img = body.ownerDocument.createElement('img');
  img.className = 'nestboard-board-ref-thumb';
  img.src = url;
  // 图是装饰：标题行已经说了这是哪块板，读屏软件再念一遍路径只是更吵
  img.alt = '';
  img.draggable = false;
  body.classList.add('is-thumb');
  body.appendChild(img);
}

/**
 * 挂上只读小窗（`F7-10` / T7.09）。
 *
 * 生命周期只有三件事：观察器报出尺寸 → 读模型 → 画；目标板被保存 → 重画；
 * 卡片被回收 → 全收掉。**没有第四件** —— 它不写任何东西、不建 session，
 * 所以不存在"看小窗把子板看坏了"这种可能（与双击打开那条路彻底分开）。
 */
function mountWindow(
  el: HTMLElement,
  body: HTMLElement,
  path: string,
  ctx: CardRenderContext,
): void {
  const boards = ctx.boards;
  const read = boards?.readBoard;
  // 能力缺失（单测、只有图片管线的嵌入视图）：留在概要面板 —— 与缩略图缺能力时同一条路
  if (!boards || !read) return;

  const doc = el.ownerDocument;
  const canvas = doc.createElement('canvas');
  canvas.className = 'nestboard-board-ref-window';
  // 先压成 0×0：`<canvas>` 的默认后备尺寸是 300×150，不先压下去，
  // 在第一次画出来之前会闪一块 300×150 的透明方块
  canvas.width = 0;
  canvas.height = 0;
  body.classList.add('is-window');
  body.appendChild(canvas);

  const watch = boards.watchBoard?.bind(boards) ?? null;
  let observer: ResizeObserver | null = null;
  let unwatch: (() => void) | null = null;
  let disposed = false;
  /** 重画序号：异步读回来时对不上就作废（见文件头第 2 条） */
  let generation = 0;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    observer = null;
    unwatch?.();
    unwatch = null;
  };

  const draw = (): void => {
    if (disposed) return;
    // 卡片已被回收（观察器与订阅还没退掉）：顺手收干净，别再往下画
    if (!el.isConnected) {
      dispose();
      return;
    }
    // 还没布局：等观察器报出真实尺寸再画（见 `MIN_WINDOW_SIDE`）
    const cssWidth = Math.floor(body.clientWidth);
    const cssHeight = Math.floor(body.clientHeight);
    if (cssWidth < MIN_WINDOW_SIDE || cssHeight < MIN_WINDOW_SIDE) return;

    const request = ++generation;
    const dpr = doc.defaultView?.devicePixelRatio ?? 1;
    void read(path)
      .then((board) => {
        // 期间又 resize 过 / 已经回收：这一次的结果没有意义
        // （用旧尺寸的图去盖新尺寸的图，比不画更糟）
        if (disposed || request !== generation || !el.isConnected) return;
        // 读不到（文件没了 / 解析失败）：什么都不画 —— 计数行已是"没有预览"时的正确形态
        if (!board) return;
        // 空板：规划也会返回 `null`，这里提前退出省一次规划
        if (board.cards.length === 0) return;
        paintWindow(canvas, el, board, cssWidth, cssHeight, dpr);
        ctx.contentReady?.();
      })
      .catch((error: unknown) => {
        console.warn('[nestboard] 只读小窗读取目标白板失败', describeError(error));
      });
  };

  // 初始那一次也走观察器（它必然先报一次）：这里不额外调 `draw()`，
  // 否则会连读两遍模型，而其中一遍量到的尺寸一定是 0
  if (typeof ResizeObserver === 'function') {
    const resize = new ResizeObserver(() => draw());
    observer = resize;
    resize.observe(body);
  } else {
    // 没有观察器的宿主（不在 Obsidian 里）：只画一次，尺寸取当下拿得到的
    draw();
  }

  // ★ 订阅与观察器分开判断：订阅缺失时"不自动刷新"是可接受的退化（能看，只是不新鲜），
  //   而观察器缺失时"完全不画"不是 —— 两者的取舍不一样，不该合并成一个条件
  unwatch = watch ? watch(path, () => draw()) : null;

  WINDOW_CLEANUPS.set(el, dispose);
}

/**
 * 按卡面尺寸把目标板画进小窗的画布。
 *
 * ★ 后备像素 = `cssWidth × dpr`，画布的 CSS 尺寸由**规划**给出（`plan.cssWidth`）：
 *   两者相等时浏览器不需要重采样，字才是清楚的。样式里只留 `max-width: 100%` 兜底。
 */
function paintWindow(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  board: BoardFile,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): void {
  const plan = planBoardWindow(board, cssWidth, cssHeight, dpr);
  if (!plan) return;

  canvas.width = plan.width;
  canvas.height = plan.height;
  canvas.style.width = `${plan.cssWidth}px`;
  canvas.style.height = `${plan.cssHeight}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    // 主题色从卡片自己身上读（与缩略图、笔记嵌入同一套）：小窗里卡片的颜色
    // 必须和用户在这个视图里看到的是同一套
    paintBoardThumbnail(ctx, board, plan, readPngPalette(host));
  } catch (error) {
    // 一张图画不出来不该让整张卡挂掉 —— 兜住，让概要面板继续说话
    console.warn('[nestboard] 绘制只读小窗失败', describeError(error));
  }
}
