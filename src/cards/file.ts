/**
 * 文件卡（T1.53 / `F2-3-7`）—— 任意附件的「图标 + 文件名 + 大小」，双击交给系统默认应用。
 *
 * 音视频（T3.10 / `F2-3-8`）在此基础上多一段**就地播放器**：能播的格式直接在卡片里
 * 播放，不必离开白板去开系统播放器。哪些格式能播见 `mediaKindOf`，播放器为什么是两态见
 * `buildVideoPlayer`。
 *
 * 与其他卡片一致的几条做法：
 *
 *  * **不 import `obsidian`**：打开文件、取文件大小都走 `CardRenderContext.shell`
 *    （`ShellBridge`），所以"扩展名怎么归一""字节数怎么显示"这些判定能在 node 下单测；
 *  * **文件信息是异步的**：`statInfo()` 返回之前卡片必须已经画出来，否则滚动时那一格会空一下。
 *    所以大小那一段先留空、落地后再填，并喊一次 `contentReady()` 让卡片层重算高度（T1.38）；
 *  * **异步回来先判 `isConnected`**：卡片可能已被回收去装别的文件了，
 *    不判就会把**上一份文件的大小**写到这一张卡上。
 *
 * ★ 为什么画"扩展名徽标"而不是 Lucide 图标：`setIcon()` 是 Obsidian 运行时
 *   （`cards/` 不许 import），而 `PDF` / `PNG` / `ZIP` 这几个字母比一个通用文件图标
 *   更容易一眼认出内容 —— 换成图标方案反而要在集成层再维护一张扩展名 → 图标名的映射表。
 */

import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, isNotePath } from '../model/drop';
import type { FileContent } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 新建文件卡的默认尺寸：一行图标 + 一行文件名 + 一行大小 */
export const FILE_DEFAULT_SIZE: Size = { width: 260, height: 96 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（复用池里的节点会串味） */
const FILE_CLASSES = ['nestboard-file', 'is-missing', 'has-media'] as const;

// ─────────────────────────────────────────────────────────────
// 纯逻辑（可单测）
// ─────────────────────────────────────────────────────────────

/** 从路径取文件名（只认 `/`：Vault 内路径一律正斜杠） */
export function fileNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * 取小写扩展名（**不含点**）；没有扩展名返回空串。
 *
 * `dot <= 0` 而不是 `dot < 0`：`.gitignore` 这类"点开头的隐藏文件"里那个点
 * 是文件名的一部分，不当扩展名 —— 否则徽标会显示成 `GITIGNORE`。
 */
export function extensionOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** 徽标文字：无扩展名给 `?`；扩展名过长（`tar.gz` 之类）只截前 4 个字母 */
export function extensionBadgeOf(path: string): string {
  const ext = extensionOf(path);
  return (ext.length > 0 ? ext.slice(0, 4) : '?').toUpperCase();
}

/**
 * 字节数 → 人类可读文本。
 *
 * ★ 用 **1024** 进制而不是 1000：Obsidian 与操作系统的"文件大小"都是二进制单位，
 *   用 1000 会让同一份文件在两处显示不同的数字（用户会以为插件算错了）。
 * ★ 10 以下留一位小数（`1.4 MB` 比 `1 MB` 有信息量），10 以上取整（`87 MB` 足够）。
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${text} ${units[unit]}`;
}

/**
 * 毫秒时间戳 → `2026-09-18 14:32`（`A7`）。
 *
 * ★ 故意**定长**，不用"今天 / 3 天前"那种相对说法：
 *   ① 相对时间要跟着**当前时刻**变，卡片就得在说不清的时刻重绘一次；
 *   ② 卡片第二行是同一列并排的，长度一蹦这一列就看着参差。
 * ★ 两位补零（`09-08 09:05`）：不补的话这一行会左右抖。
 * ★ 坏输入（0 / NaN / 越界）返回空串 —— 调用方用 `filter` 拼，不会留下一个孤零零的 `·`。
 */
export function formatFileTime(mtime: number): string {
  if (!Number.isFinite(mtime) || mtime <= 0) return '';
  const date = new Date(mtime);
  const stamp = date.getTime();
  if (!Number.isFinite(stamp)) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 文件卡此刻该画什么。三种状态的全部判定都在这里，`render` 只负责照着画 */
export type FileState = 'empty' | 'missing' | 'ready';

/**
 * @param exists Vault 查询函数；传 `null` 表示没有 Vault 桥（单测场景）——
 *               此时一律当作"能读"：读不到是运行时才知道的事。
 */
export function fileState(
  content: Pick<FileContent, 'path'>,
  exists: ((path: string) => boolean) | null,
): FileState {
  if (content.path.length === 0) return 'empty';
  if (!exists) return 'ready';
  return exists(content.path) ? 'ready' : 'missing';
}

// ─────────────────────────────────────────────────────────────
// 媒体（T3.10 / `F2-3-8`）
// ─────────────────────────────────────────────────────────────

/** 能就地播放的两种媒体 */
export type MediaKind = 'video' | 'audio';

/**
 * 能播的扩展名**名单本体在 `model/drop.ts`**（`A1` 起），这里只负责查表。
 *
 * ★ 为什么搬过去：`dropKindForPath`（拖进来落哪种卡）要读**同一份**名单 —— 而那一处
 *   在模型层，模型 import 卡片会成环。名单归模型，卡片这边只做"渲染时挑不挑播放器"。
 * ★ 查表仍用 `Set`：这是热路径（每条可见卡片每次挂载都要问一次），数组 `includes`
 *   在大名单上是线性的。构造一次，之后只查。
 */
const VIDEO_EXTENSION_SET: ReadonlySet<string> = new Set(VIDEO_EXTENSIONS);
const AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS);

/** 这个路径能不能就地播；不能（含所有普通文件）返回 `null` */
export function mediaKindOf(path: string): MediaKind | null {
  const ext = extensionOf(path);
  if (VIDEO_EXTENSION_SET.has(ext)) return 'video';
  if (AUDIO_EXTENSION_SET.has(ext)) return 'audio';
  return null;
}

/**
 * 槽位元素 → 此刻挂在它上面的媒体元素。
 *
 * 记引用而不是 `el.querySelector('video')`：`destroy()` 只需要"停掉那个播放器"，
 * 而它拿到的槽位在复用池里可能已经被重画成别的卡了 —— 手里握着实实在在的那个元素，
 * 比"按标签名再找一遍"少一层猜测。
 */
const players = new WeakMap<HTMLElement, HTMLMediaElement>();

/**
 * 停掉播放器，并把手里的文件松开。
 *
 * ★ 只 `pause()` 不够：媒体元素**被摘出 DOM 之后仍会继续播**（声音还在响、解码器还占着），
 *   而卡片回收恰恰就是"把节点从 DOM 上摘下来塞进复用池"（`CardLayer.releaseNode`）。
 *   少了这一步，"把一张正在放视频的卡滚出视口"就会变成"画面没了、声音还在"。
 * ★ `removeAttribute('src')` + `load()` 才是真松手：不清 `src` 的节点留在池子里会一直
 *   握着那份文件与解码缓冲 —— 而池子会反复复用这些节点，一份 4K 视频的缓冲就这么常驻了。
 */
export function stopMedia(media: HTMLMediaElement): void {
  media.pause();
  media.removeAttribute('src');
  media.load();
}

/** 一段播放器：`root` 进内容槽，`media` 留给 `destroy()` 停播 */
interface MediaPlayer {
  root: HTMLElement;
  media: HTMLMediaElement;
}

/**
 * 视频：**概览 ⇄ 播放**两态。
 *
 * ★ 分两态的唯一理由是**拖动**。卡片的第一交互永远是拖，而原生控件一旦可见就必须吃指针
 *   （不吃就点不动播放键、拖不动进度条）。于是概览态把播放器整个设成 `pointer-events: none`
 *   ——整张卡照常拖，只有正中那个播放按钮吃指针；点开之后指针交给控件，拖动改由**文件名
 *   那一行**发起（它是既有的卡片结构，不是为播放器新加的），并给一个"收起"退回来。
 * ★ 封面是白捡的：`preload="metadata"` 会让浏览器读出首帧并画在画面区里，我们一个字都不用管。
 *   自己抽帧则要额外解码一遍，还可能把画布弄脏（跨域），不划算。
 * ★ 代价写在明处：每张可见的视频卡都会读一次文件头（约为文件开头的若干 KB）。
 *   卡片本来就只在可见时才挂载（`CardLayer` 裁剪），所以这个数量和"屏幕上看得见几张"同阶。
 */
export function buildVideoPlayer(doc: Document, url: string, ctx: CardRenderContext): MediaPlayer {
  const root = doc.createElement('div');
  root.className = 'nestboard-media';
  root.dataset.kind = 'video';

  const media = doc.createElement('video');
  media.className = 'nestboard-media-frame';
  media.src = url;
  // 只读头部 + 首帧：既拿到"封面"，也拿到真实宽高比（卡片靠它自动定高，见 `measure`）
  media.preload = 'metadata';
  // 手机上不加这个，一点播放就整个吃掉屏幕 —— 用户会以为白板不见了
  media.playsInline = true;

  const play = doc.createElement('button');
  play.type = 'button';
  play.className = 'nestboard-media-play';
  play.textContent = '▶';
  play.title = t('card.media.play');
  play.setAttribute('aria-label', t('card.media.play'));

  const collapse = doc.createElement('button');
  collapse.type = 'button';
  collapse.className = 'nestboard-media-collapse';
  collapse.textContent = t('card.media.collapse');
  collapse.title = t('card.media.collapse');

  let playing = false;
  const toggle = (next: boolean): void => {
    playing = next;
    root.classList.toggle('is-playing', next);
    media.controls = next;
    if (next) {
      // `play()` 返回的 promise 必须接住：被自动播放策略拒绝时它会是**未处理的拒绝**
      // （这里是用户点击触发的，正常不会被拦，但"正常不会"不是不处理的理由）
      void media.play().catch(() => undefined);
    } else {
      media.pause();
    }
  };

  // 两个按钮都要挡住冒泡：`pointerdown` 挡住卡片层的拖动手势，`click` 挡住选中/双击
  // （与链接卡的按钮、待办卡的复选框同一条约定）
  play.addEventListener('pointerdown', (event) => event.stopPropagation());
  play.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle(true);
  });
  collapse.addEventListener('pointerdown', (event) => event.stopPropagation());
  collapse.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle(false);
  });

  // 播放中才让播放器吃指针：概览态的整张卡都要能拖（见本节开头）
  media.addEventListener('pointerdown', (event) => {
    if (playing) event.stopPropagation();
  });

  // 元数据到手才知道真实宽高比 —— 让卡片层重量一次高度。
  // 少了这一声，竖屏视频会永远卡在"按默认比例算出来的"高度里
  media.addEventListener('loadedmetadata', () => ctx.contentReady?.());

  // 扩展名说能播、实际却解不开（文件损坏 / 编码不在解码器支持范围内）：
  // 摆一个"点了没反应"的播放器不如直说。
  // ★ 只写播放器自己的子树，一个字都不碰卡片槽位的 class：这一刻这个节点很可能已经被
  //   回收去装别的卡了，动槽位就是给别的卡染上"无法播放"
  media.addEventListener('error', () => showUnplayable(doc, root));

  root.appendChild(media);
  root.appendChild(play);
  root.appendChild(collapse);
  return { root, media };
}

/**
 * 音频：一行原生控件，**常驻可见、不做两态**。
 *
 * ★ 不做两态的理由：音频没有"封面"可展示，概览态唯一能放的只有那个播放按钮 ——
 *   多一个中间状态就多一个"怎么收回去"的问题，而它换不来任何东西。
 * ★ 它只有一行，卡片其余部分（文件名那一行、大小那一行）照常可以拖动，
 *   所以也不存在视频那种"播放器把整张卡盖住"的麻烦。
 */
function buildAudioPlayer(doc: Document, url: string): MediaPlayer {
  const root = doc.createElement('div');
  root.className = 'nestboard-media';
  root.dataset.kind = 'audio';

  const media = doc.createElement('audio');
  media.className = 'nestboard-media-frame';
  media.src = url;
  media.preload = 'metadata';
  media.controls = true;
  // 原生控件吃掉指针，否则点"播放"会变成拖卡片（与色板卡、待办卡同一条约定）
  media.addEventListener('pointerdown', (event) => event.stopPropagation());
  media.addEventListener('error', () => showUnplayable(doc, root));

  root.appendChild(media);
  return { root, media };
}

/** 解不开时把播放器整个换成一句话（播放器自己也没了，不会留下一个能点的空壳） */
function showUnplayable(doc: Document, root: HTMLElement): void {
  root.classList.add('is-unplayable');
  root.replaceChildren(doc.createTextNode(t('card.media.unplayable')));
}

/**
 * 这个文件该不该配播放器；该配就建一个（不能播 / 拿不到资源 URL → `null`，退回图标行）。
 *
 * `resourceUrl()` 给不出 URL 时不画播放器，而不是画一个空的：那个 URL 是 Obsidian 解析
 * 出来的，它给不出来就说明这份文件根本没法当资源加载 —— 画个空壳只会让人以为能点。
 */
function buildMediaPlayer(doc: Document, path: string, ctx: CardRenderContext): MediaPlayer | null {
  const kind = mediaKindOf(path);
  if (!kind) return null;
  const url = ctx.notes?.resourceUrl(path) ?? null;
  if (!url) return null;
  return kind === 'video' ? buildVideoPlayer(doc, url, ctx) : buildAudioPlayer(doc, url);
}

/**
 * "大小 · 修改时间"那一行（`A7`）。
 *
 * ★ **先建节点、后异步填**：`stat` 要读盘，等它回来再插节点会让卡片先矮一下再长高
 *   （滚动时看得见）。填之前是个空 `span`，CSS 里 `:empty { display: none }` 兜住。
 * ★ 回来时卡片可能已被回收 ⇒ 判 `isConnected`（与图片卡、播放器同一套时序纪律）。
 * ★ 两项都可能缺：`filter` 掉空串再拼，于是"只有大小"或"什么都没有"都不会
 *   画出一个孤零零的分隔点。
 * ★ 拿到数据后喊一次 `contentReady()`：这是一行新内容，卡片层要重量一次高度
 *   （与从前只填大小那一版同一条，`T1.38`）。
 */
function buildMetaLine(
  doc: Document,
  path: string,
  ctx: CardRenderContext,
  el: HTMLElement,
): HTMLElement {
  const meta = doc.createElement('span');
  meta.className = 'nestboard-file-meta';
  void ctx.shell?.statInfo(path).then((info) => {
    if (!info || !el.isConnected) return;
    const text = [formatFileSize(info.size), formatFileTime(info.mtime)]
      .filter((part) => part.length > 0)
      .join(' · ');
    if (text.length === 0) return;
    meta.textContent = text;
    ctx.contentReady?.();
  });
  return meta;
}

/**
 * 卡片右上角的「打开」（`A7`）。
 *
 * ★ **只在有系统能力桥时才画**：没有 `openPath` 的按钮就是"点了没反应"，
 *   比不画它更糟（与链接卡那个「打开」同一条取舍）。
 * ★ `pointerdown` 挡住冒泡：不挡的话按一下会先被卡片层的拖动接管。
 * ★ 图标走 `ctx.setIcon`（视图注入 `obsidian.setIcon`）；拿不到时退回文字按钮 ——
 *   `cards/` 不许 import `obsidian`，而一个没有图标的按钮也仍然能用。
 */
function buildOpenButton(doc: Document, path: string, ctx: CardRenderContext): HTMLElement | null {
  const shell = ctx.shell;
  if (!shell) return null;

  const open = doc.createElement('button');
  open.type = 'button';
  open.className = 'nestboard-file-open';
  open.title = t('card.file.open');
  open.setAttribute('aria-label', t('card.file.open'));
  if (ctx.setIcon) ctx.setIcon(open, 'external-link');
  else open.textContent = t('card.file.open');

  open.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  open.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    void shell.openPath(path);
  });
  return open;
}

// ─────────────────────────────────────────────────────────────
// 卡片定义
// ─────────────────────────────────────────────────────────────

export const fileCard: CardTypeDefinition<'file'> = {
  type: 'file',

  get displayName(): string {
    return t('card.type.file');
  },

  icon: 'file',
  defaultSize: FILE_DEFAULT_SIZE,

  createDefaultContent(): FileContent {
    return { path: '', showSize: true };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-file');
    el.classList.remove('is-missing');
    delete el.dataset.placeholder;

    // 上一次挂在这个槽位上的播放器：重画（换文件 / 进编辑态）时必须先停掉，
    // 否则它会带着 `src` 留在池子里继续播上一份文件 —— 见 `stopMedia`
    const previous = players.get(el);
    if (previous) {
      stopMedia(previous);
      players.delete(el);
    }

    const doc = el.ownerDocument;
    const { path, showSize } = card.content;
    const notes = ctx.notes ?? null;
    const state = fileState(card.content, notes ? (value) => notes.exists(value) : null);

    if (state !== 'ready') {
      el.classList.add('is-missing');
      el.dataset.placeholder = 'true';
      el.replaceChildren(doc.createTextNode(t('card.file.missing', { path })));
      return;
    }

    const badge = doc.createElement('span');
    badge.className = 'nestboard-file-icon';
    badge.dataset.ext = extensionOf(path) || 'none';
    badge.textContent = extensionBadgeOf(path);

    const name = doc.createElement('span');
    name.className = 'nestboard-file-name';
    name.textContent = fileNameOf(path);
    // 完整路径放 `title`：同名文件放两张卡时，只有它能把两者区分开
    name.title = path;

    // 右侧两行（`A7`）：文件名在上、"大小 · 修改时间"在下（第二行异步填，见 `buildMetaLine`）
    const text = doc.createElement('div');
    text.className = 'nestboard-file-text';
    text.appendChild(name);
    if (showSize) text.appendChild(buildMetaLine(doc, path, ctx, el));

    const row = doc.createElement('div');
    row.className = 'nestboard-file-main';
    row.appendChild(badge);
    row.appendChild(text);

    // 播放器（音视频才有）排在文件信息行下面：上行仍然是拖动把手，
    // 新东西只占它下面那一块
    const player = buildMediaPlayer(doc, path, ctx);
    if (player) players.set(el, player.media);
    // 有播放器时排版要换个对齐方式，见 `styles.css` 里 `.nestboard-file.has-media` 的说明
    el.classList.toggle('has-media', player !== null);

    const nodes: HTMLElement[] = [row];
    if (player) nodes.push(player.root);
    // 悬停才出现的「打开」（`A7`）：右键与双击都能打开，但一个**看得见**的按钮
    // 才让人知道这张卡点得动（位置由样式表钉在卡片右上角）
    const open = buildOpenButton(doc, path, ctx);
    if (open) nodes.push(open);
    el.replaceChildren(...nodes);
  },

  /**
   * 自动高度（T1.38）：**只有媒体卡**参与，普通文件卡一个字都不改。
   *
   * ★ 普通文件卡必须返回 0（不表态）：给它接上 `scrollHeight` 会让**已经存在的白板**
   *   在升级后集体变高 —— 用户摆好的版面因为一次插件更新全乱了。
   * ★ 媒体卡用 `scrollHeight`（与引用卡同一招）：槽位里"标题行 + 播放器 + 大小行"
   *   谁多高由 CSS 说了算，抄一份高度常量到 TS 里迟早会对不上。
   * ★ 视频的真实高度靠 CSS 的 `width: 100%; height: auto` 从固有宽高比推出来 ——
   *   元数据到了浏览器会自己重排，我们再喊一次 `contentReady()` 重量一次（见上）。
   */
  measure(el, card): number {
    if (!mediaKindOf(card.content.path)) return 0;
    return el.scrollHeight;
  },

  contextMenu(card, menuCtx) {
    return [
      {
        id: 'file-open',
        title: t('card.file.open'),
        icon: 'external-link',
        disabled: menuCtx.multiple || card.content.path.length === 0,
        // ★ 复用 `openSource` 这个具名动作而不是新加一个：它最终会走到本定义的
        //   `onDoubleClick`，"用系统应用打开"和"双击卡片"本来就是同一条路 ——
        //   再分一个动作名，只会让两处逻辑慢慢长歪
        action: 'openSource',
      },
    ];
  },

  /**
   * 只有指向 **`.md`** 的文件卡，标题才是那个文件的名字（`O30`）。
   *
   * ★ 别的文件（PDF / 表格 / 压缩包）**不接**：那些文件的文件名是它自己的身份，
   *   卡片上的标题只是一句备注 —— 改一下就动用户的文件，是这个功能最吓人的一种走火。
   */
  titleFilePath(card): string | null {
    return isNotePath(card.content.path) ? card.content.path : null;
  },

  onDoubleClick(card, ctx): boolean {
    const path = card.content.path;
    if (path.length === 0) return false;
    const notes = ctx.notes;
    // 文件不在 → 不接管，让视图统一给"文件不存在"的提示（好过点了没反应）
    if (notes && !notes.exists(path)) return false;
    if (!ctx.shell) return false;
    void ctx.shell.openPath(path);
    return true;
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...FILE_CLASSES);
    delete el.dataset.placeholder;
    // ★ 先停播再拆子树：这段代码跑的时机是"卡片滚出视口"，而**媒体元素被摘出 DOM
    //   之后仍会继续播**（`CardLayer.releaseNode` 正是把节点摘下来塞进池子）。
    //   少了这一步，用户滚走一张正在放的视频卡，画面没了、声音还在
    const media = players.get(el);
    if (media) {
      stopMedia(media);
      players.delete(el);
    }
    // 整棵子树一起丢掉：复用池里的节点可能还带着上一份文件的名字与大小
    el.replaceChildren();
  },

  toMarkdown(card): string {
    // 附件用普通 wikilink 而不是 `![[…]]` 嵌入：`![[x.pdf]]` 在导出笔记里会变成
    // 一大块内嵌预览，把正文挤没了 —— 而文件卡的语义只是"这里有个附件"
    return `[[${card.content.path}]]`;
  },
};
