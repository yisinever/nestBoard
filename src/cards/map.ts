/**
 * 地图卡（`T7.03` / `F2.9`；`O08` 补"粘贴分享链接"）—— 一张**本地静态地图图** + 一个图钉。
 *
 * ── 为什么是"静态图"而不是在线地图 ─────────────────────────────
 * 卡上贴的是一张**落在 vault 里**的地图图（地图 App 的截图、导出的地图、扫描件都算），
 * 没有地图库、没有平移缩放、也没有离线瓦片缓存 —— `01` 的能力对照表里这条本就被标成
 * "⚠️ 仅静态图"，不是本轮偷偷缩水。插件负责的是**图钉**：
 * 把"就是这个地方"钉在图上，并让它在卡片改大小之后仍然对准。
 *
 * ── `O08` 之后多的一条来路：粘贴分享链接 ────────────────────────
 * 用户在设置里挑了一个静态图服务（默认**不出图**）之后，右键「粘贴地图链接」会把
 * 链接换成一张真图：视图层解析链接（`util/mapUrl.ts`）、发一次请求、把图落进附件目录，
 * 然后**照旧走上面这条路**（本地图 + 图钉）。所以这一层的正经逻辑一点没变，
 * 只有两处跟着走：
 *  * `sourceUrl` / `coords` 变成卡面的一部分（没图时卡上显示坐标与链接，见
 *    `renderFallback`）—— 这是"没网 / 没配 / 服务商回错"时的**降级落点**；
 *  * 双击的含义多了一条：没图但有链接时，双击 = 去地图上看。
 * ★ 渲染路径**一次都不联网**（`CardRenderContext.mapTiles` 只用来读 `enabled`，
 *   决定卡上那句提示怎么说），所以"零网络"这条承诺只是从"绝不"收窄到
 *   "只在用户点「粘贴地图链接」时"。
 *
 * ── 三件容易做错的事 ────────────────────────────────────────
 * 1. **图钉钉的是图，不是卡片**。图按 `contain` 缩进卡片里，两侧/上下会留白；直接把图钉
 *    摆在 `x*100%`（相对**卡片**）会让它飘到留白里 —— 越靠边缘越离谱。做法：留白交给外层
 *    的 stage，里面那个 frame 收成"图上那条矩形"（`aspect-ratio` 由 `load` 时的真实像素
 *    算出），图钉是 frame 的孩子、按百分比定位 —— 这样"图钉 ↔ 图上某点"的对应关系与卡片
 *    尺寸**无关**，卡片一改大小自动重排。
 *    ★ 也正因为如此，本文件**不在渲染时量尺寸**：`CardLayer` 是先 `applyCard` 再
 *      `appendChild`（渲染时元素还没上树，量出来是 0），而且卡片被拉伸时 `render`
 *      **不会**重跑（内容指纹只含模式 + 内容）。写死 px 或依赖"渲染那刻的尺寸"都会失配。
 * 2. **双击图 = 落图钉**。所以图上挂了 `dblclick` 并 `stopPropagation` —— 不拦的话这一下会
 *    同时冒泡到卡片自己的双击（`onDoubleClick` = **打开原图**），变成"落钉 + 弹出一个图片查看器"。
 * 3. **点在留白上不算数**。双击到图上那条矩形之外时**不落钉**，而且**不吞事件** ——
 *    让它照常冒泡（落到 `onDoubleClick`：有图就打开原图看细节，空卡则退回"双击进编辑态"）。
 *    地图上的位置本身有语义，夹到边上等于替用户标了一个他没指过的点。
 *
 * ★ 不 import `obsidian`：资源 URL 从 `CardRenderContext` 的端口拿，所以落钉的判定与提交
 *   逻辑可以在 node 下直接单测（`src/tests/cards/map.test.ts`）。
 */

import type { CardOfType, MapContent, MapPin } from '../model/schema';
import type { Size } from '../util/geometry';
import { clamp } from '../util/geometry';
import { fileNameOf } from '../util/fileName';
import { t } from '../util/i18n';
import { coordsText } from '../util/mapUrl';
import type { CardRenderContext, CardTypeDefinition, CardTypeMenuItem } from './registry';

/** 新建地图卡的默认尺寸：4:3 横构图（地图截图 / 导出图最常见的比例） */
export const MAP_DEFAULT_SIZE: Size = { width: 320, height: 240 };

/**
 * 链接原文（`O08`）。
 *
 * ★ 模型里它是**可选**的，而且空值会被 `validate` 归成"键缺席"
 *   （见 `normalizeMapContent`）。于是"从没贴过链接的卡"上这个键**根本不存在**——
 *   卡面每处都必须按"可能没有"来读，写成 `content.sourceUrl.length` 会当场抛。
 *   这两行访问器就是那个唯一的读法。
 */
function sourceUrlOf(content: MapContent): string {
  return content.sourceUrl ?? '';
}

/** 从链接解析出的经纬度（`O08`）。理由同 `sourceUrlOf`：可选的键，缺席即"没有" */
function coordsOf(content: MapContent): { lat: number; lon: number } | null {
  return content.coords ?? null;
}

/**
 * 把"图上的实际宽高比"写到 frame 上的 CSS 变量名。
 * ★ 单独导出是为了让单测能直接断言"到底写了哪个值"（同 `toPng` 的裁剪断言思路）。
 */
export const MAP_RATIO_PROP = '--nestboard-map-ratio';

/** 本定义会加到槽位元素上的 class，`destroy()` 必须**原样摘掉**（复用池里的节点会串味） */
const MAP_CLASSES = [
  'nestboard-map',
  'nestboard-map-preview',
  'nestboard-map-edit',
  'is-missing',
] as const;

// ─────────────────────────────────────────────────────────────
// 纯逻辑（可直接单测）
// ─────────────────────────────────────────────────────────────

/** 归一化坐标夹进 0~1：越界的值只可能来自手改文件，钉到边上比飘到卡外好解释 */
export function clampUnit(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * frame 内的局部坐标 → 归一化图钉位置；**落到图外（留白）返回 `null`**。
 *
 * `size` 是 frame 的**实际渲染尺寸** —— 也就是浏览器已经把 `aspect-ratio` 算完之后
 * "图真正画在哪儿"的结果。这里刻意不复刻一遍 `contain` 的算术：那种复刻等于把
 * "我以为浏览器会这么排"再写一遍，一旦哪边改了就是图钉与图错位。
 */
export function pinFromPoint(
  point: { x: number; y: number },
  size: { width: number; height: number },
): MapPin | null {
  if (!(size.width > 0) || !(size.height > 0)) return null;
  const x = point.x / size.width;
  const y = point.y / size.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** 归一化位置 → 可读文案（`'40% / 62%'`）；没图钉返回 `null` */
export function pinText(pin: MapPin | null): string | null {
  if (pin === null) return null;
  return `${Math.round(clampUnit(pin.x) * 100)}% / ${Math.round(clampUnit(pin.y) * 100)}%`;
}

/** 两个图钉是不是同一个位置（都为 `null` 也算"同一个"）—— 编辑态用它判断"改没改" */
export function samePin(a: MapPin | null, b: MapPin | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y;
}

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

/**
 * 落定 frame 的宽高比：只有 `load` 之后才知道图的真实像素。
 * ★ `naturalWidth/Height` 为 0（断链图）时不写 —— 写了 `0 / 0` 是无效值，frame 会直接塌掉，
 *   连"图在哪"都看不出来；不写则 frame 保持自适应，能看到浏览器的断链图标。
 */
function applyNaturalRatio(frame: HTMLElement, img: HTMLImageElement): void {
  if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return;
  frame.style.setProperty(MAP_RATIO_PROP, `${img.naturalWidth} / ${img.naturalHeight}`);
}

/** 图钉（一个点 + 可选的地点名标签）；没标位置时整块 `hidden` */
function buildPin(doc: Document, label: string, pin: MapPin | null): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'nestboard-map-pin';
  el.hidden = pin === null;
  // 位置本身是视觉信息，读屏拿不到；"这是什么地方"由图片的 alt 承担
  el.setAttribute('aria-hidden', 'true');
  if (pin !== null) {
    el.style.setProperty('left', `${clampUnit(pin.x) * 100}%`);
    el.style.setProperty('top', `${clampUnit(pin.y) * 100}%`);
  }

  const dot = doc.createElement('span');
  dot.className = 'nestboard-map-dot';
  el.appendChild(dot);

  if (label.length > 0) {
    const tag = doc.createElement('span');
    tag.className = 'nestboard-map-tag';
    tag.textContent = label;
    el.appendChild(tag);
  }
  return el;
}

/**
 * 落钉：双击处 → 归一化坐标 → `updateContent`。
 *
 * ★ 只读白板上 `updateContent` 自己直接返回，所以这里也不会假装生效（同 `cards/todo.ts`）。
 * ★ 走 `updateContent` 而不是就地挪 DOM：撤销、脏标记、重画都只有模型那条路认得。
 */
function dropPin(
  event: MouseEvent,
  card: CardOfType<'map'>,
  ctx: CardRenderContext,
  frame: HTMLElement,
): void {
  if (card.locked) return;
  const rect = frame.getBoundingClientRect();
  const next = pinFromPoint(
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
    { width: rect.width, height: rect.height },
  );
  // 留白：不落钉，也**不**吞事件（让它照常冒泡成"双击进编辑态"）
  if (next === null) return;
  event.stopPropagation();
  ctx.updateContent({ pin: next });
}

/**
 * 没有图可画时的卡面（`O08` 起这条路上有了正经内容）。
 *
 * ★ 分两种情形，因为它们的**可做之事**完全不同：
 *  * 连链接都没有（新建的空卡 / 还没选图）：还是原来那一句"还没有地图图片"；
 *  * 贴过分享链接（有 `sourceUrl` 或 `coords`）：卡上有坐标可读、链接可点 ——
 *    这时说"什么都没有"就是在骗用户。**这里正是 `O08` 的降级落点**：
 *    没网 / 没配服务 / 服务商回错，卡片仍然是一条可用的信息，而不是一个空框。
 * ★ 图丢了（`path` 有值但文件不在）与"还没选图"也分开说：前者要提示用户去修，
 *    后者是新卡片的正常状态。
 */
function renderFallback(el: HTMLElement, card: CardOfType<'map'>, ctx: CardRenderContext): void {
  const content = card.content;
  const doc = el.ownerDocument;
  el.classList.add('is-missing');
  el.dataset.placeholder = 'map';

  const coords = coordsOf(content);
  const sourceUrl = sourceUrlOf(content);
  if (sourceUrl.length === 0 && coords === null) {
    el.textContent = t('card.map.empty', { path: content.path });
    return;
  }

  const box = doc.createElement('div');
  box.className = 'nestboard-map-fallback';

  if (content.path.length > 0) {
    const missing = doc.createElement('div');
    missing.className = 'nestboard-map-missing';
    missing.textContent = t('card.map.missingImage', { path: content.path });
    box.appendChild(missing);
  }

  if (content.label.length > 0 || coords !== null) {
    const place = doc.createElement('div');
    place.className = 'nestboard-map-place';
    place.textContent = [content.label, coords === null ? '' : coordsText(coords.lat, coords.lon)]
      .filter((part) => part.length > 0)
      .join(' · ');
    box.appendChild(place);
  }

  if (sourceUrl.length > 0) {
    const url = doc.createElement('div');
    url.className = 'nestboard-map-url';
    url.textContent = sourceUrl;
    box.appendChild(url);

    const links = ctx.links;
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'nestboard-map-open';
    open.textContent = t('menu.card.openMapLink');
    if (links === undefined) {
      // 没有外链桥时给一个按不动的按钮，而不是一个按下去没反应的
      open.disabled = true;
    } else {
      // ★ 必须在 `pointerdown` 上停一下：不停的话这一按会被卡片层当成拖动的开始，
      //   按钮的 `click` 就永远等不到（与链接卡的那个按钮同一个处理）
      open.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
      open.addEventListener('click', (event: MouseEvent) => {
        event.stopPropagation();
        void links.openExternal(sourceUrl);
      });
    }
    box.appendChild(open);
  }

  // 最后那句提示随"能不能出图"换一种说法：配好了就说"再取一次"，没配就说"去哪儿配"
  // ★ `is-static`：有图时那句提示是**绝对定位**在图的底部，而这里没有那张图，
  //   绝对定位会挂到卡片底部去（见样式表里那一段）
  const hint = doc.createElement('div');
  hint.className = 'nestboard-map-hint is-static';
  hint.textContent =
    ctx.mapTiles?.enabled === true ? t('card.map.hintFetchTile') : t('card.map.hintTileSetup');
  box.appendChild(hint);

  el.replaceChildren(box);
}

function renderPreview(el: HTMLElement, card: CardOfType<'map'>, ctx: CardRenderContext): void {
  const content = card.content;
  const doc = el.ownerDocument;
  // `resourceUrl` 对"空路径 / 文件不在了"一律返回 null，与图片卡同一套判定
  const url = content.path.length > 0 ? (ctx.notes?.resourceUrl(content.path) ?? null) : null;

  if (url === null) {
    renderFallback(el, card, ctx);
    return;
  }

  el.classList.add('nestboard-map-preview');

  const stage = doc.createElement('div');
  stage.className = 'nestboard-map-stage';

  const frame = doc.createElement('div');
  frame.className = 'nestboard-map-frame';

  const img = doc.createElement('img');
  img.className = 'nestboard-map-img';
  img.loading = 'lazy';
  img.draggable = false;
  // 没有地点名时退回文件名：用整条 vault 路径当 alt 等于没写
  img.alt = content.label.length > 0 ? content.label : fileNameOf(content.path);
  img.addEventListener('load', () => applyNaturalRatio(frame, img));
  img.addEventListener('dblclick', (event: MouseEvent) => dropPin(event, card, ctx, frame));
  img.src = url;

  frame.appendChild(img);
  frame.appendChild(buildPin(doc, content.label, content.pin));
  stage.appendChild(frame);

  // 还没有图钉时给一句引导：卡片的招牌动作（双击落钉）在界面上没有任何别的提示
  if (content.pin === null && !card.locked) {
    const hint = doc.createElement('div');
    hint.className = 'nestboard-map-hint';
    hint.textContent = t('card.map.hintDrop');
    stage.appendChild(hint);
  }

  el.appendChild(stage);
}

/**
 * 编辑态：**只有地点名能在这里改**（换图走右键「选择地图图片」）。
 *
 * ★ 图钉的清除**先攒着**（`pending`），点了「清除」不立刻写模型：清除按钮与输入框在同一个
 *   表单里，一按就写会因内容变化触发重画 —— 输入框里刚敲一半的地点名会连同撤销栈里的
 *   中间态一起被冲掉；攒到提交时一次写，语义也更干净（取消 = 什么都没发生）。
 */
function renderEditor(el: HTMLElement, content: MapContent, ctx: CardRenderContext): void {
  el.classList.add('nestboard-map-edit');
  const doc = el.ownerDocument;

  let pendingPin = content.pin;

  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'nestboard-map-input';
  input.value = content.label;
  input.placeholder = t('card.map.labelPlaceholder');
  input.spellcheck = false;
  // 只让输入框吃掉指针：不拦的话按一下会先被卡片层的拖动/框选接管
  input.addEventListener('pointerdown', (event: Event) => event.stopPropagation());

  const meta = doc.createElement('div');
  meta.className = 'nestboard-map-meta';
  const metaText = doc.createElement('span');
  metaText.className = 'nestboard-map-meta-text';

  const clear = doc.createElement('button');
  clear.type = 'button';
  clear.className = 'nestboard-map-clear';
  clear.textContent = t('menu.card.clearPin');
  // ★ 在 `pointerdown` 上处理并 `preventDefault`：既不让卡片层抢走拖动，也不让按钮抢走焦点
  //   —— 抢走焦点会先触发输入框的 blur（= 提交并退出编辑态），这一下点击根本落不到按钮上。
  clear.addEventListener('pointerdown', (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    pendingPin = null;
    syncMeta();
  });

  function syncMeta(): void {
    const text = pinText(pendingPin);
    metaText.textContent = text === null ? t('card.map.noPin') : t('card.map.pinAt', { pin: text });
    meta.replaceChildren(metaText);
    if (pendingPin !== null) meta.appendChild(clear);
  }
  syncMeta();

  const hint = doc.createElement('div');
  hint.className = 'nestboard-map-help';
  hint.textContent = t('card.map.hint');

  el.appendChild(input);
  el.appendChild(meta);
  el.appendChild(hint);

  let done = false;
  const exit = (): void => {
    if (done) return;
    done = true;
    ctx.setMode('display');
  };

  const commit = (): void => {
    if (done) return;
    const patch: Partial<MapContent> = {};
    const next = input.value.trim();
    if (next !== content.label) patch.label = next;
    if (!samePin(pendingPin, content.pin)) patch.pin = pendingPin;
    // 没改就不写：`updateContent` 会逐字段比较，但少喂一次脏值就少一次 undo 记录
    if (Object.keys(patch).length > 0) ctx.updateContent(patch);
    exit();
  };

  const cancel = (): void => exit();

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  });
  // 点卡片外面（提交）与点空白（取消）在视图那侧不可区分，所以 blur 一律当提交：
  // 与图片卡的说明文字同一条规矩
  input.addEventListener('blur', commit);

  input.focus();
}

// ─────────────────────────────────────────────────────────────
// 卡片定义
// ─────────────────────────────────────────────────────────────

export const mapCard: CardTypeDefinition<'map'> = {
  type: 'map',
  icon: 'map',
  // ★ 做成 getter：语言可能中途切换，写法与其它卡片一致
  get displayName(): string {
    return t('card.type.map');
  },
  defaultSize: MAP_DEFAULT_SIZE,
  createDefaultContent: () => ({ path: '', label: '', pin: null }),

  render(el, card, ctx): void {
    el.classList.add('nestboard-map');
    el.classList.remove('nestboard-map-preview', 'nestboard-map-edit', 'is-missing');
    delete el.dataset.placeholder;

    if (ctx.mode === 'edit') {
      renderEditor(el, card.content, ctx);
      return;
    }
    renderPreview(el, card, ctx);
  },

  contextMenu(card, ctx): CardTypeMenuItem[] {
    const busy = ctx.multiple || card.locked;
    return [
      // 粘贴分享链接（O08）：这是地图卡**从哪来**的主入口 —— 换图与落钉都要先有一张图，
      // 而这条路一步到位（认得出就顺带把图、坐标、地点名一起填上）
      {
        id: 'map-paste-link',
        title: t('menu.card.pasteMapLink'),
        icon: 'link',
        disabled: busy,
        action: 'pasteMapLink',
      },
      // 打开链接：没有链接时置灰而不是藏起来 —— 藏起来会让"粘了一条认不出的链接"
      // 显得像什么都没发生（与链接卡的「打开链接」同一条规矩）
      {
        id: 'map-open-link',
        title: t('menu.card.openMapLink'),
        icon: 'external-link',
        disabled: busy || sourceUrlOf(card.content).length === 0,
        action: 'openMapLink',
      },
      // 换图：与图片卡的「选择图片」共用同一个选择器（只收图片扩展名）。
      // ★ 换图**保留图钉**：用户多半是拿同一片区域的另一版图来替（见文件头）
      {
        id: 'map-pick-image',
        title: t('menu.card.pickMapImage'),
        icon: 'image-plus',
        disabled: busy,
        action: 'pickMapImage',
      },
      // 没有"清除图钉"菜单项：清图钉在**编辑态**里（那里能攒着改、能取消），
      // 而菜单项按下去就该立刻生效 —— 一次误点就永久丢掉位置，代价不对称
      { id: 'map-edit', title: t('menu.card.edit'), disabled: busy, action: 'editContent' },
    ];
  },

  /**
   * 走到这里的双击都是"图上那条矩形之外"的（图上的双击被卡片自己的监听吃掉了），
   * 或者是没图的卡。有图就打开原图看细节；没图但有链接就**去地图上看**（`O08`）；
   * 其余交回视图 —— 空卡因此仍然保留"双击进编辑态"这条通用逃生口。
   *
   * ★ 两条路的顺序有意义：图在的时候双击应当看**图**（那是这张卡上的内容，
   *   用户双击的是他看见的东西），链接只是备选。
   */
  onDoubleClick(card, ctx): boolean {
    const path = card.content.path;
    const sourceUrl = sourceUrlOf(card.content);
    const shell = ctx.shell;
    if (
      path.length > 0 &&
      ctx.notes !== undefined &&
      ctx.notes.exists(path) &&
      shell !== undefined
    ) {
      void shell.openPath(path);
      return true;
    }
    if (sourceUrl.length > 0 && ctx.links !== undefined) {
      void ctx.links.openExternal(sourceUrl);
      return true;
    }
    return false;
  },

  /**
   * 导出为 Markdown。
   *
   * 有图：标准图片语法（与图片卡一致），图钉那根位置用**标题**承载 ——
   * Obsidian 的 `![]()` 没有第三个位置放"标注"，而地点名正是这张卡要说的话。
   * 没图但贴过链接（`O08`）：导出成一个普通链接（`[天安门](https://…)`），
   * 名字优先、没名字就用坐标。**不再返回空串** —— 之前那是"没图的地图卡本来就是个空框"
   * 的结论，而现在那样的卡上有用户特意记下来的地点。
   */
  toMarkdown(card): string {
    const { path, label } = card.content;
    if (path.length > 0) return `![${label}](${path})`;

    const sourceUrl = sourceUrlOf(card.content);
    const coords = coordsOf(card.content);
    const text =
      label.length > 0 ? label : coords === null ? '' : coordsText(coords.lat, coords.lon);

    if (sourceUrl.length > 0)
      return `[${text.length > 0 ? text : t('card.type.map')}](${sourceUrl})`;
    // 只有坐标没有链接（手改过的文件，或者解析出来的链接被清掉了）：
    // 坐标本身就是可读内容，导出成一行纯文本总比什么都不留强
    return coords === null || text.length === 0 ? '' : text;
  },

  destroy(el): void {
    el.classList.remove(...MAP_CLASSES);
    delete el.dataset.placeholder;
    el.replaceChildren();
  },
};
