/**
 * 视频卡（`A1`，用户 2026-09-18："支持视频播放器卡片 —— 本地视频：支持等比缩放 / 播放 /
 * 调进度 / 音量调节 / 支持主流视频格式"）。
 *
 * ── 它与"文件卡的视频形态"的关系 ─────────────────────────────
 *
 * `T3.10` 起，文件卡遇到音视频就会**就地渲染出播放器**。那条路留着不动（老 `.nboard`
 * 里的文件卡照旧能播，一个字节都不用迁移）；这一张是**新建时**用的：拖一个 `.mp4`
 * 进来，落下的就是一张"生来就是播放器"的卡 —— 没有文件名那一行、没有大小那一行，
 * 整张卡就是画面。
 *
 * ★ 播放器本体**复用** `cards/file.ts` 的 `buildVideoPlayer`：播放键、封面
 *   （`preload="metadata"` 白捡首帧）、按真实宽高比自动定高、吃不吃指针那一套规则
 *   全在那一处 —— 复制一份的话，两边的播放器迟早长得不一样。
 * ★ 16:9 只是**默认**尺寸：真实高度由 `measure` 按文件的固有比例重算（竖屏视频也不会变形）
 *   ⇒ 这就是用户说的"等比缩放"。
 * ★ 播不了（浏览器解不了这个编码）时播放器自己会换成一句话（`is-unplayable`），
 *   与文件卡同一条路 —— 这里不重复判断。
 */

import { extensionOf } from '../model/drop';
import type { CardColor, CardOf } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import { buildVideoPlayer, stopMedia } from './file';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 默认尺寸：16:9（绝大多数片子是这个比例，落下即可看） */
export const VIDEO_DEFAULT_SIZE: Size = { width: 320, height: 180 };

/**
 * 新建视频卡的**默认颜色**：纯黑（用户 2026-09-18："卡片颜色全黑，边框也全黑，
 * 参考图片卡，标题和背景色同改"）。
 *
 * ★ 与图片卡同一个做法（见 `cards/image.ts` 的 `normalizeImageCardColor`）：
 *   底色与边框都取 `--nestboard-card-color`，于是"在调色板里改个色，画面外那一圈一起变"，
 *   不需要第二条同步逻辑 —— 这里只负责把**新建的那张**掰成黑的。
 * ★ 只动"仍然等于全局默认色"的那些：用户自己挑过的颜色一个字节都不动（那是他的选择）。
 */
export const VIDEO_DEFAULT_COLOR = '#000000';

/**
 * 把"还没挑过颜色"的视频卡掰成默认黑（纯函数，就地问一张卡）。
 *
 * ★ 与图片卡那条**逐字对齐**（`normalizeImageCardColor`）：调用方按 `card.type` 筛过再来；
 *   只改内存、不主动写盘 —— 单纯打开一块板不该改文件。
 */
export function normalizeVideoCardColor(card: CardOf<'video'>, fallback: CardColor): boolean {
  if (card.color === VIDEO_DEFAULT_COLOR) return false;
  if (card.color !== fallback) return false;
  card.color = VIDEO_DEFAULT_COLOR;
  return true;
}

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（复用池里的节点会串味） */
const VIDEO_CLASSES = ['nestboard-video', 'is-missing', 'is-unplayable'] as const;

/**
 * 每个槽位上现挂着的播放器。
 *
 * ★ `destroy()` 要停掉它：卡片滚出视口时节点被摘出 DOM，而**媒体元素摘下来仍会继续播**
 *   （`CardLayer.releaseNode` 正是把节点塞进池子）—— 少了这一步，用户滚走一张正在放的
 *   视频卡，画面没了、声音还在（与文件卡那条完全同因）。
 * ★ 用 `ReturnType<typeof buildVideoPlayer>` 而不是去 import 那个接口：播放器的类型
 *   细节属于 `file.ts`，这里只需要"能停掉它"这一个能力。
 */
const players = new WeakMap<HTMLElement, ReturnType<typeof buildVideoPlayer>>();

export const videoCard: CardTypeDefinition<'video'> = {
  type: 'video',

  get displayName(): string {
    return t('card.type.video');
  },

  icon: 'film',
  defaultSize: VIDEO_DEFAULT_SIZE,

  createDefaultContent() {
    return { path: '', showSize: false };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-video');
    el.classList.remove('is-missing');
    delete el.dataset.placeholder;

    // 上一次挂在这个槽位上的播放器：重画（换文件 / 进池子）前必须先停
    const previous = players.get(el);
    if (previous) {
      stopMedia(previous.media);
      players.delete(el);
    }

    const doc = el.ownerDocument;
    const { path } = card.content;

    // 三种"画不出画面"的情况共用一个占位态，但说的话不同：
    // ① 还没挑文件（新建的那张）② 文件不在了（改名 / 删掉）③ 库内拿不到资源 URL
    const exists = path.length > 0 && ctx.notes ? ctx.notes.exists(path) : path.length > 0;
    const url = exists ? (ctx.notes?.resourceUrl(path) ?? null) : null;

    if (url === null) {
      el.classList.add('is-missing');
      el.dataset.placeholder = 'true';
      el.replaceChildren(
        doc.createTextNode(
          path.length === 0 || exists ? t('card.video.empty') : t('card.file.missing', { path }),
        ),
      );
      return;
    }

    const player = buildVideoPlayer(doc, url, ctx);
    players.set(el, player);
    el.replaceChildren(player.root);
  },

  /**
   * 自动高度：**整张卡就是画面**，高多少由播放器自己说（`width: 100%; height: auto`
   * ⇒ 浏览器按文件的固有比例排）。
   *
   * ★ 与文件卡不同，这里**无条件**参与自动高度：视频卡没有"文件名 + 大小"那两行，
   *   画面就是全部内容（文件卡只在媒体形态下参与，是为了不动已有白板的版面）。
   */
  measure(el): number {
    return el.scrollHeight;
  },

  contextMenu(card, menuCtx) {
    const bordered = card.showBorder !== false;
    return [
      {
        id: 'video-open',
        title: t('card.file.open'),
        icon: 'external-link',
        disabled: menuCtx.multiple || card.content.path.length === 0,
        // 与文件卡同一个动作名：它最终走到本定义的 `onDoubleClick`（用系统应用打开），
        // "菜单里打开"与"双击卡片"本来就是同一条路
        action: 'openSource',
      },
      // 「取消边框」（用户 2026-09-18："也可取消边框"）：与图片卡**同一个具名动作**，
      // 文案与图标都跟着当前状态走 —— 底色与边框一起收掉（见样式表 `.is-borderless`）
      {
        id: 'video-border',
        title: bordered ? t('menu.card.hideBorder') : t('menu.card.showBorder'),
        icon: bordered ? 'square-dashed' : 'square',
        disabled: menuCtx.multiple || card.locked,
        action: 'toggleCardBorder',
      },
    ];
  },

  /**
   * 双击 = **用系统应用打开**（不是"播放"）。
   *
   * ★ 播放有卡面上的播放键（那才是播放该待的地方）；而"这张卡指的是哪份文件、
   *   我想拿别的工具看它"这件事只有双击说得清 —— 与文件卡保持同一条肌肉记忆。
   */
  onDoubleClick(card, ctx): boolean {
    const path = card.content.path;
    if (path.length === 0) return false;
    const notes = ctx.notes;
    if (notes && !notes.exists(path)) return false;
    if (!ctx.shell) return false;
    void ctx.shell.openPath(path);
    return true;
  },

  /** 导出成 Markdown 用 `![[…]]`（内嵌）：Obsidian 自己就会把它渲染成播放器 */
  toMarkdown(card): string {
    const path = card.content.path;
    if (path.length === 0) return '';
    // 扩展名不认识时也照旧导出：那是用户写进卡片里的东西，不该由我们来删
    void extensionOf(path);
    return `![[${path}]]`;
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...VIDEO_CLASSES);
    delete el.dataset.placeholder;
    // ★ 先停播再拆子树：见 `players` 上面那段说明
    const player = players.get(el);
    if (player) {
      stopMedia(player.media);
      players.delete(el);
    }
    el.replaceChildren();
  },
};
