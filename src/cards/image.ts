/**
 * 图片卡（T1.50 / T1.52 / T2.02 / `F2-3`）。
 *
 * 卡片层要解决的三件事，前两件都跟"图是异步的"有关：
 *
 * 1. **缩略图优先**（T1.52）：缩放 < 0.8 时用 `cache/thumbs/` 里的 256px 缩略图，
 *    否则用原图 —— 一张 4K 截图的原图能吃掉几十 MB 显存，20 张就够让滚动掉到个位数帧率。
 * 2. **自动高度**（T1.38）：图片读到真实尺寸之前，谁都不知道卡片该多高。
 *    所以 `load` / `error` 都要喊一次 `contentReady()` —— 只喊成功那一半的话，
 *    一张断链的图片会让卡片永远停在默认高度上。
 * 3. **非破坏性裁剪**（T2.02 / `F2-3-3`）：卡片里只显示 `crop` 选中的那一块。
 *    做法是"把整图放大、让窗口裁掉溢出"，**原图一个字节都不动** ——
 *    所以撤销一次裁剪就是把那四个数换回去，而不是去恢复一张被改坏的文件。
 *
 * ★ 缩略图**就绪后只改这一个 `<img>` 的 `src`**，绝不 `updateContent` 或让视图重渲染。
 *   改 `src` 是浏览器内部的一次替换；重渲染会重建整张卡片的 DOM，
 *   而滚动时"每张图都重建一次"就等于把复用池（T1.26）的收益全丢掉。
 *
 * ★ 异步回调回来时必须先判 `img.isConnected`：卡片很可能已经被回收去装别的图了，
 *   不判就会把**别人的图**换成这张的缩略图（表现为"图会莫名其妙跳变"）。
 *
 * ★ 不 import `obsidian`：资源 URL 与缩略图都从 `CardRenderContext` 的端口拿，
 *   所以本文件的判定与提交逻辑可以在 node 下直接单测。
 *
 * ★ 双击该干嘛（T3.09 / `F4-05`）：图片卡没有可编辑的正文，双击掉进编辑态是个
 *   **死胡同**；于是它的双击是"给我一支笔，在图上标注"（Milanote 的肌肉记忆）。
 *   双击**说明文字**仍然是就地改说明 —— `figcaption` 的监听自己挡住了冒泡。
 *   标注本身是独立的 `ink` 卡片（T3.08），"算谁的标注"由笔迹自己定（`cards/ink.ts`）。
 */

import { IDENTITY_CROP, cropAspectRatio, cropClipStyle, isIdentityCrop } from '../model/crop';
import type { CardColor, CardOf, ImageContent } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import type { CardActionContext, CardTypeDefinition, CardTypeMenuItem } from './registry';

/** 新建图片卡的默认尺寸：横构图 16:10，一屏能并排放两张 */
export const IMAGE_DEFAULT_SIZE: Size = { width: 320, height: 220 };

/**
 * 新建图片卡的默认**主色**：纯黑（用户 2026-09-17："默认应该是纯黑的卡片颜色和边框颜色。
 * 这样比较有感觉"）。
 *
 * ★ 黑色当照片的"相框"：任何图贴在纯黑底上都不会显脏，也压得住五颜六色的截图。
 * ★ 它是**新建时的默认值**，不是铁律：用户在快捷操作栏 / 调色板里挑过色就听他的，
 *   边框会跟着那个色一起变（见样式表里 `border-color: var(--nestboard-card-color)`）。
 */
export const IMAGE_DEFAULT_COLOR = '#000000';

/**
 * 缩略图的边长（px）。
 *
 * ★ **必须与 `io/ThumbnailCache.THUMB_SIZE` 一致** —— 这里不 import 它：`cards/**`
 *   不该依赖 `io/**`（`03 §7.2` 的层界）。与"小地图那个盒子的尺寸必须与样式表一致"
 *   是同一类约定：数值写两处，注释里点明。
 */
const THUMB_PIXELS = 256;

/**
 * 缩放超过这个值就当"用户在看细节"：直接用原图（**默认卡片宽度下**的阈值）。
 *
 * ★ 保留它只为兼容老调用 / 老用例：真正的判据见 {@link shouldUseFullImage}。
 */
export const THUMB_ZOOM_THRESHOLD = 0.8;

/** 本定义会加到槽位元素上的 class，`destroy()` 必须**原样摘掉**（复用池里的节点会串味） */
const IMAGE_CLASSES = ['nestboard-image', 'is-missing', 'is-cover', 'is-contain'] as const;

/**
 * 该用原图吗 —— 判据是**这张卡在屏幕上要画多少像素**，而不是单纯的缩放倍数。
 *
 * ★ 老判据是 `zoom > 0.8`（= `256 / 320`，"一张典型卡片宽度"）。那个 0.8 只在卡片
 *   **正好 320px 宽**时才等价于"缩略图不够用了"；而用户的图常常是整屏截图、
 *   卡片拉到 800px 宽：0.8 倍下要画 640px，却还在用 256px 的缩略图 ⇒ **一眼糊**
 *   （用户 2026-09-17 报的就是这个）。
 * ⇒ 现在的判据：**屏幕上的宽度 > 缩略图边长 ⇒ 上原图**。取舍点仍然是"概览时省显存" ——
 *   卡片缩到 256px 以下时，缩略图与原图在屏幕上**看不出差别**，而那正是缩略图存在的意义。
 *
 * ★★ **必须乘 `devicePixelRatio`**（`A5`，用户 2026-09-18 仍报"图糊"）：上面那句
 *   "屏幕上要画多少像素"问的是**设备像素**，而卡宽与缩放都是 **CSS 像素** ——
 *   Retina（DPR=2）上一张 320pt 的卡片要画 640 个设备像素，256 的缩略图照样被撑开
 *   ⇒ 在用户的机器上看起来还是糊。老判据漏的正是这一层。
 *
 * @param zoom 当前缩放
 * @param cardWidth 卡片的世界宽度（px）；不传 = 新建卡的默认宽度（老调用行为不变）
 * @param devicePixelRatio 设备像素比（`window.devicePixelRatio`）；不传 = 1（单测 / 老调用）
 */
export function shouldUseFullImage(
  zoom: number,
  cardWidth: number = IMAGE_DEFAULT_SIZE.width,
  devicePixelRatio: number = 1,
): boolean {
  // 坏值（0 / NaN / 负数，手改出来的）当作 1：宁可多用缩略图，也别让判据永远为假
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return zoom * cardWidth * ratio > THUMB_PIXELS;
}

/** 从路径取文件名当 `alt`（纯函数：只认 `/`，Vault 内路径一律正斜杠） */
export function fileNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/** 说明文字为空 → 显示引导文案（空 `<figcaption>` 会让卡片底部多出一条看不见的空白） */
export function applyCaption(el: HTMLElement, caption: string): void {
  const trimmed = caption.trim();
  el.textContent = trimmed || t('card.image.caption');
  if (trimmed) el.removeAttribute('data-placeholder');
  else el.setAttribute('data-placeholder', 'true');
}

export const imageCard: CardTypeDefinition<'image'> = {
  type: 'image',

  get displayName(): string {
    return t('card.type.image');
  },

  icon: 'image',
  defaultSize: IMAGE_DEFAULT_SIZE,
  // 新建的图片卡默认**纯黑**（照片的"相框"，见 `IMAGE_DEFAULT_COLOR`）
  defaultColor: IMAGE_DEFAULT_COLOR,

  createDefaultContent(): ImageContent {
    return {
      path: '',
      caption: '',
      // 新建的图片卡 = "整张图"（恒等裁剪）；去掉裁剪也是回到这个值
      crop: { ...IDENTITY_CROP },
      fit: 'contain',
    };
  },

  render(el, card, ctx): void {
    el.classList.add('nestboard-image');
    const { path, caption, fit } = card.content;
    // 手改过的 `.nboard` 可能缺 `crop`（校验层会补，但渲染层不该假设它一定在）
    const crop = card.content.crop ?? IDENTITY_CROP;
    const doc = el.ownerDocument;

    // 空路径不建 `<img>`：`src=''` 会让浏览器按**当前页面 URL** 再发一次请求，
    // 在 Obsidian 里就表现为"打开白板时莫名其妙加载了 app 页面"
    const url = path ? (ctx.notes?.resourceUrl(path) ?? null) : null;
    if (!url) {
      el.classList.add('is-missing');
      el.dataset.placeholder = 'true';
      el.replaceChildren(doc.createTextNode(t('card.image.empty', { path })));
      return;
    }
    delete el.dataset.placeholder;
    el.classList.add(fit === 'cover' ? 'is-cover' : 'is-contain');

    const figure = doc.createElement('figure');
    figure.className = 'nestboard-image-figure';

    const img = doc.createElement('img');
    img.className = 'nestboard-image-img';
    img.loading = 'lazy';
    img.draggable = false;
    img.alt = caption || fileNameOf(path);

    // 设备像素比（`A5`）：Retina 上一张 320pt 的卡要画 640 个**设备**像素，
    // 而缩放与卡宽都是 CSS 像素 ⇒ 判据必须乘它（不乘就会继续拿 256 的缩略图撑）
    const dpr = el.ownerDocument.defaultView?.devicePixelRatio ?? 1;

    const oversampled =
      ctx.alwaysFullImage === true || shouldUseFullImage(ctx.zoom, card.width, dpr);
    const cached = ctx.thumbnails?.peek(path) ?? null;
    // 缩略图只在"缩小俯视"时才用；放大看细节时直接上原图
    const useThumb = cached !== null && !oversampled;
    img.src = useThumb ? cached : url;

    // ── 裁剪（T2.02 / F2-3-3）─────────────────────────────────
    // ★ 恒等裁剪走**原来的结构**（`<img>` 直接进 `<figure>`）：一次都没裁过的卡片
    //   与 T2.02 之前渲染出来的 DOM 完全一致，不存在"升级插件把老卡片画歪"的可能。
    const cropped = !isIdentityCrop(crop);
    const clip = cropped ? doc.createElement('div') : null;
    if (clip) {
      clip.className = 'nestboard-image-clip';
      // 把整图放大、让窗口只留 `x,y,w,h` 那一块（几何见 `model/crop.ts`）
      const clipStyle = cropClipStyle(crop);
      for (const [name, value] of Object.entries(clipStyle)) {
        clip.style.setProperty(name, value);
      }
      const frame = doc.createElement('div');
      frame.className = 'nestboard-image-frame';
      frame.appendChild(clip);
      clip.appendChild(img);
      figure.appendChild(frame);
    } else {
      figure.appendChild(img);
    }

    // 自动高度（T1.38）：成功与失败都要喊一声，否则断链的图片永远等不到重算
    let measured = false;
    const readyOnce = (): void => {
      if (measured) return;
      measured = true;
      ctx.contentReady?.();
    };
    /**
     * 裁剪窗口的形状 = 裁剪区的**像素**比例（`w×nw : h×nh`）。
     *
     * ★ 必须等到图片加载完：不拿到 `naturalWidth/Height` 就算不出这个比例，
     *   而窗口若先被摆成卡片形状，`<img>` 的百分比放大就会把图**拉变形**
     *   —— 用户看到的是"裁完图变扁了"，还会以为是插件改坏了原图。
     */
    const applyCropRatio = (): void => {
      if (!clip || !clip.isConnected) return;
      const ratio = cropAspectRatio(crop, img.naturalWidth, img.naturalHeight);
      if (ratio) clip.style.setProperty('aspect-ratio', String(ratio));
    };
    img.addEventListener('load', () => {
      applyCropRatio();
      readyOnce();
    });
    img.addEventListener('error', readyOnce);
    // 缓存命中的图片在挂上来时就已经 `complete`，那一刻不会再派发 `load`
    if (clip && img.complete && img.naturalWidth > 0) applyCropRatio();

    // ★★ 三个条件都要（`A5`）：**已经决定用原图的卡片，绝不能被后台生成好的缩略图换掉**。
    //   从前这里只判 `!useThumb && cached === null` —— 而"决定用原图"（`oversampled`）与
    //   "没有缓存缩略图"这两件事常常同时成立，于是：首帧用原图画得很清楚 → 后台把 256px
    //   缩略图生成好 → **回填把原图换掉** ⇒ 用户看到的还是糊的（这正是 2026-09-18 那条
    //   "图片卡清晰度应该保持原图清晰度"的第二个成因，单靠乘 DPR 修不掉）。
    if (!useThumb && cached === null && !oversampled) {
      // 先用原图顶着，后台生成缩略图。★ 这里**不 await**：渲染必须同步完成，
      // 否则首帧会空一块，用户滚动时看到卡片在闪
      void ctx.thumbnails?.get(path).then((next) => {
        // 三个都必须判：可能已被回收（`isConnected`）、可能已经换过（`src`）、可能生成失败
        if (!next || !img.isConnected || img.src === next) return;
        img.src = next;
      });
    }

    const captionEl = doc.createElement('figcaption');
    captionEl.className = 'nestboard-image-caption';
    applyCaption(captionEl, caption);
    captionEl.addEventListener('dblclick', (event) => {
      // 双击说明文字 = 就地改说明；必须挡住冒泡，否则视图会当成"双击卡片进编辑态"
      event.stopPropagation();
      startCaptionEdit(captionEl, caption, (value) => ctx.updateContent({ caption: value }));
    });
    figure.appendChild(captionEl);

    el.replaceChildren(figure);
  },

  /**
   * 按图片（或裁剪区）的**宽高比**算内容高度，让卡片自己长到合适的高度。
   * 读不到固有尺寸（还没加载完 / 图片坏了）返回 0 = "我没有意见"，交给卡片层的最小高度。
   */
  measure(el, card): number {
    const img = el.querySelector('img');
    if (!img || img.naturalWidth <= 0) return 0;
    const width = el.clientWidth;
    if (width <= 0) return 0;
    // ★ 用裁剪区的比例而不是原图比例：裁成一个竖条之后，再按横图的高度排版
    //   会在卡片里留下一大圈看不见的留白（用户以为卡片"底下空了"）
    const ratio = cropAspectRatio(
      card.content.crop ?? IDENTITY_CROP,
      img.naturalWidth,
      img.naturalHeight,
    );
    if (!ratio) return 0;
    // 说明文字那一行不算进图片高度（它是额外的一行，由卡片层的最小高度兜底）
    return Math.round(width / ratio);
  },

  destroy(el): void {
    el.classList.remove(...IMAGE_CLASSES);
    delete el.dataset.placeholder;
    // ★ 整棵子树一起丢掉，而不是逐个属性重置：复用池里的节点可能还带着上一张图的
    //   `src`、`alt`、监听器，逐个清迟早会漏（漏掉 `src` 就是"残留旧图闪一下"）
    el.replaceChildren();
  },

  contextMenu(card, ctx): CardTypeMenuItem[] {
    // 「取消边框 / 显示边框」是一个开关 ⇒ 标题跟着当前状态走（与白板卡那三档预览同一个做法）
    const bordered = card.showBorder !== false;
    return [
      { id: 'image-caption', title: t('menu.card.editCaption'), action: 'editCaption' },
      {
        id: 'image-border',
        title: bordered ? t('menu.card.hideBorder') : t('menu.card.showBorder'),
        icon: bordered ? 'square-dashed' : 'square',
        // 取消边框 = 底色与边框都收掉（只留照片）；锁定卡不该被改外观
        disabled: ctx.multiple || card.locked,
        action: 'toggleCardBorder',
      },
      {
        id: 'image-annotate',
        title: t('menu.card.annotate'),
        icon: 'pen-tool',
        // 与裁剪同一条约定：多选时"标哪一张"没有答案；空路径没图可标；锁定卡不该被改内容
        disabled: ctx.multiple || card.content.path.length === 0 || card.locked,
        action: 'inkAnnotate',
      },
      {
        id: 'image-crop',
        title: t('menu.card.cropImage'),
        icon: 'crop',
        // 多选时"裁哪一张"没有答案；空路径没图可裁；锁定卡不该被改内容。
        // 视图还会再兜一层（文件真的不存在时直接不弹），这里只管"项该不该出现"
        disabled: ctx.multiple || card.content.path.length === 0 || card.locked,
        action: 'cropImage',
      },
    ];
  },

  /**
   * 双击图片 = 在图上标注（T3.09 / `F4-05`）。
   *
   * 三种"交回视图"的情形与文件卡同源 —— 卡片定义拿不到能力时**不接管**，
   * 让视图去解释，好过吞掉一次点击让用户以为卡了：
   *   * 空路径：该干的是"选一张图"（视图会进编辑态），不是标注；
   *   * 没有手绘桥（单测 / 嵌入视图）；
   *   * 只读白板 / 手绘图层还没就绪（`annotate()` 自己返回 `false`）。
   */
  onDoubleClick(card, ctx: CardActionContext): boolean {
    if (card.content.path.length === 0) return false;
    const ink = ctx.ink;
    if (!ink) return false;
    return ink.annotate();
  },

  toMarkdown(card): string {
    const { caption, path } = card.content;
    return `![${caption}](${path})`;
  },
};

/**
 * 存量图片卡的"相框色"归一到默认黑（用户 2026-09-17："图片卡，边框和背景颜色，默认黑色"）。
 *
 * ── 为什么需要这一步 ─────────────────────────────────────────
 * 新建的图片卡已经在创建时拿到 `IMAGE_DEFAULT_COLOR`（`defaultColor` 那个口头），
 * 但**存量**卡片当年拿的是"全局默认色"（设置里那个），于是满屏五颜六色的相框。
 *
 * ★ 只动**仍然等于全局默认色**的那些 —— 用户在调色板 / 快捷操作栏里挑过的颜色
 *   （与前一次"默认值"不同）一个字节都不动，那是他自己的选择。
 * ★ 调用方（视图）**只改内存、不主动写盘**：单纯打开一块板不该改文件；用户下次真的
 *   动了别的东西时，它会跟着一起落盘 —— 那时它就是这块板该有的样子了。
 * ★ 纯函数（就地问一个卡片），可单测。
 *
 * @param card 待检查的卡片（签名就写死 `CardOf<'image'>`：调用方按 `card.type` 筛过再来）
 * @param fallback **全局默认色**（`settings.defaultCardColor`）：等于它 = 用户没挑过
 * @returns 是否真的改了
 */
export function normalizeImageCardColor(card: CardOf<'image'>, fallback: CardColor): boolean {
  if (card.color === IMAGE_DEFAULT_COLOR) return false;
  if (card.color !== fallback) return false;
  card.color = IMAGE_DEFAULT_COLOR;
  return true;
}

/**
 * 就地编辑说明文字。
 *
 * 用 `contenteditable` 而不是临时 `<input>`：说明文字经常是一整句话，
 * 在 320px 宽的卡片里用输入框会看不见后半句。`plaintext-only` 不支持时退回 `true`
 * （少数 Electron 版本），此时靠 `paste` 时只取纯文本兜底。
 */
function startCaptionEdit(host: HTMLElement, value: string, commit: (next: string) => void): void {
  if (host.dataset.editing === 'true') return;
  host.dataset.editing = 'true';
  host.setAttribute('contenteditable', 'plaintext-only');
  host.classList.add('is-editing');
  host.focus();

  const finish = (submit: boolean): void => {
    if (host.dataset.editing !== 'true') return;
    delete host.dataset.editing;
    host.removeAttribute('contenteditable');
    host.classList.remove('is-editing');
    const next = submit ? (host.textContent ?? '').trim() : value;
    applyCaption(host, next);
    if (submit && next !== value) commit(next);
  };

  host.addEventListener('keydown', function onKey(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      host.removeEventListener('keydown', onKey);
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      host.removeEventListener('keydown', onKey);
      finish(false);
    }
  });

  host.addEventListener('blur', () => finish(true), { once: true });
}
