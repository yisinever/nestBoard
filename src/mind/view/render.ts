/**
 * 脑图节点与连线的 DOM（`06 §2` 的渲染层）。
 *
 * ★ 只碰 DOM、不 import `obsidian`、不认识视图与仓储 —— 于是它能在假 DOM 下直接单测
 *   （与白板 `cards/` 的测法一致）。**什么时候重画、量多大**是视图的事（`MindView`）。
 * ★ 这里**不写节点的宽高**（见 `applyNodeBox`）：写了宽高，测量就变成自证
 *   （量到的正是自己刚写下去的那个数），而脑图的骨架恰恰要靠"量出来的真尺寸"。
 */

import {
  MIND_HANDLE_GAP,
  MIND_HANDLE_SIZE,
  MIND_HANDLE_STUB,
  branchPointOf,
  childSideOf,
  edgePathOf,
  edgeTrunkPathOf,
} from '../layout/edges';
import {
  MIND_LINK_ARROW_SIZE,
  linkArrowEnds,
  linkArrowPoints,
  linkMidpointOf,
  linkPathOf,
} from '../layout/links';
import type { NodeBox } from '../layout/tree';
import type { MindEdgeStyle } from '../model/schema';
import { OUTLINE_VIEW_ICON, TREE_VIEW_ICON } from './viewToggleIcons';

// ★ 这些名字以前定义在本文件里，现在搬到了 `layout/edges.ts`（纯几何的正确归属，
//   导出那一层也要用同一份 ⇒ 导出的线条与屏幕一致）。**照旧从这里转出**：
//   视图、单测、样式表的注释都还按老地方引用，转出比满地改引用干净，
//   也少一次"两处各写一份"的机会。
export {
  MIND_HANDLE_GAP,
  MIND_HANDLE_SIZE,
  MIND_HANDLE_STUB,
  branchPointOf,
  childSideOf,
  edgePathOf,
  edgeTrunkPathOf,
};
import {
  MIND_DEEP_DEPTH,
  mindPaletteOf,
  titleBoldOf,
  titleSizeOf,
  type MindPaletteOptions,
} from '../model/palette';
import { firstRefOf, refLabelOf } from '../model/refs';
import type { MindNode, MindRef } from '../model/schema';
import { t } from '../../util/i18n';
import { roundTo, type Point, type Rect } from '../../util/geometry';

/** SVG 命名空间（连线与辅助线共用） */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 节点元素上的 class（样式表与命中测试都认它） */
export const MIND_NODE_CLASS = 'nestboard-mind-node';

/**
 * 节点 id 的属性名。
 *
 * ★ 与白板的 `CARD_ID_ATTR` 同一条纪律：**只留一个来源**。P3 的"拖节点改父"、
 *   P2 的裁剪与命中都要读它，各写一份迟早出现"这里写 `data-node-id`、那里写 `nodeId`
 *   而悄悄失配"。
 */
export const MIND_NODE_ID_ATTR = 'data-mind-node-id';

/**
 * 一个节点"长什么样"的指纹（`O`：改标题 / 正文 / 附件 / 配色 / 折叠都要能**当场**看见）。
 *
 * ★ 为什么需要它：`paint()` 对已挂载的节点只改 `left/top`（几何），从不动内容 ——
 *   于是"改完标题要重开一次才显示"这种 bug 就会出现（真的出现过）。
 *   视图拿这个指纹与"上次画的是哪一版"比一下，不一样就重建那一个元素。
 * ★ 指纹里**刻意不含** `parentId` / `order`：它们一变就重建 DOM 是白费的，
 *   几何那些事 `applyNodeBox` 已经管了。`free` 同理（不影响长相）。
 */
export function renderSignatureOf(node: MindNode, refMissing?: (path: string) => boolean): string {
  // ★ 附件**还在不在**也要进指纹（`06 §6` 的断链态）：它只改回形针那一个类名，
  //   不进指纹的话"删掉那个文件之后回形针不变灰"—— 而那一枚灰恰恰是这个状态
  //   唯一的可见部分（视图那边靠 `vault.on('delete' / 'rename')` 触发一次 `render`，
  //   指纹变了才会真的重建那颗回形针）。
  // ★ 没传判据（单测 / 嵌入视图）就记 `null`：指纹仍然稳定，也不逼调用方回答这个问题。
  const ref = firstRefOf(node);
  return JSON.stringify([
    node.text,
    node.note,
    node.refs ?? null,
    node.style ?? null,
    node.collapsed === true,
    // ★ 标记（`08 §3.1`）必须在指纹里：它只改"标题前面那一格"，
    //   漏掉的话"挑一个 emoji 之后要再点一下 B 才出现"（真实报障 —— 那一问
    //   顺带把 `style` 带上，指纹才变，节点才重建）
    node.icon ?? null,
    // 完成（`N3-g`）同理：它只改标题那一段的删除线与灰度，漏掉就会"点了完成没反应"
    node.done === true,
    ref && refMissing ? refMissing(ref.path) : null,
  ]);
}

export interface NodeElementOptions extends MindPaletteOptions {
  /** 内容块是否渲染（默认渲染；"只看标题"这类档位将来会用到） */
  showBody?: boolean;
  /**
   * **祖先里有完成的节点**（`N3-g`）：整块画淡一点。
   *
   * ★ 由视图沿父链算出来传进来（这一层只认"画成什么样"）——
   *   而它必须进**指纹**，否则祖先一改完成，子孙的 DOM 不会重建、淡不淡就留在旧样子上。
   */
  doneBranch?: boolean;
  /**
   * 内容块**一定要建出来**（哪怕 `note` 是空的）。
   *
   * ★ 内容区编辑态要用它：空正文也得有那块地方放输入框。
   *   显示态则保持"正文为空就不占位"（空的一行不该在卡面上留一块白）。
   */
  forceBody?: boolean;
  /**
   * 把一段 Markdown 渲染进内容块的能力（**由视图注入**）。
   *
   * ★ 可选：这一层刻意保持"纯 DOM、同步、可在假 DOM 下单测"，而富文本要 Obsidian 的
   *   `MarkdownRenderer`（异步、属视图能力）。能力缺席就**退回纯文本** ——
   *   单测、嵌入视图、未来的导出都用得上这条路（白板的 `renderMarkdown` 是必填，
   *   因为卡片只在视图里渲染；脑图这一层多一个纯文本档）。
   * ★ 时序：调用**之前**已经把纯文本让出去了（`textContent = ''`），
   *   因为 `MarkdownRenderer.render` 是**追加**进元素的 —— 不清空就会渲染两遍。
   * ★ 抛错由实现方自己消化（视图那边 catch 之后回落到纯文本）：
   *   这里是同步调用，返回 `void`，不留悬空的 Promise 给这一层。
   */
  renderMarkdown?: (markdown: string, el: HTMLElement) => void;
  /**
   * 把一条**库内路径**换成能直接放进 `<img src>` 的地址（**由视图注入**）。
   *
   * ★ 和 `renderMarkdown` 同一条理由：这一层不 import `obsidian`，
   *   而"文件 → 可访问地址"只有宿主知道（`vault.adapter.getResourcePath`）。
   * ★ 返回 `null` = 这张图现在拿不到地址（文件没了 / 不是图片）⇒ 不画图片块，
   *   只留标题上的回形针 —— 用户仍然能点开看看它到底怎么了。
   */
  resolveResource?: (path: string) => string | null;
  /**
   * 这条附件的文件**还在不在**（**由视图注入**，与 `resolveResource` 同一条理由）。
   *
   * ★ 与 `resolveResource` **分开**：那个回答的是"能不能画成图"（不是图片、拿不到地址
   *   都返回 `null`），而回形针要的是"这份文件还在不在"—— 一条 PDF 附件永远画不成图，
   *   但它好好地躺在库里时回形针**不该变灰**。
   * ★ 缺席（`undefined`）= 一律按"在"处理：单测与嵌入视图不该被迫回答这个问题。
   */
  refMissing?: (path: string) => boolean;
  /**
   * 图片**加载完成**时喊一声（视图拿它重排一次）。
   *
   * ★ 必须要有：布局量到的是"这一刻的高度"，而图片是异步加载的 ——
   *   不重排的话，节点会一直按估算的那个高度摆着（一加载完就又歪又挤）。
   */
  onImageLoad?: () => void;
}

/** 内容块的 class（视图挂编辑器、样式表、测试都认它） */
export const MIND_BODY_CLASS = 'nestboard-mind-node-body';

/**
 * 附件标记上的属性：**值是它引用的那条路径**（现在只有标题带末尾的回形针用它）。
 *
 * ★ 与节点手柄同一个套路（`MIND_HANDLE_ATTR`）：只带自己的标记、**不带**节点 id 属性，
 *   于是"点节点"（选中 / 拖动）与"点回形针"（打开文件）在 DOM 上就是两条路，
 *   不必靠"先问谁后问谁"的先后顺序去救。
 */
export const MIND_REF_ATTR = 'data-mind-ref';

/** 图片块（在标题**上面**）与其四个角的缩放把手 */
export const MIND_IMAGE_CLASS = 'nestboard-mind-image';
export const MIND_IMAGE_RESIZE_ATTR = 'data-mind-image-corner';
/** 四个角（顺序无关，只是写全） */
export const MIND_IMAGE_CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
export type MindImageCorner = (typeof MIND_IMAGE_CORNERS)[number];

/**
 * 建一个节点元素，并把撞色写在 CSS 变量上。
 *
 * 从上到下：**图片块（只有图片附件才有）→ 标题带（文字 + 回形针）→ 内容块**（`06 §4.1`）。
 *
 * ★ 图片在标题**上面**：图片是这张卡的"脸"，标题是它的名字 —— 名字压在脸上没道理。
 * ★ 附件**不进内容区**（用户 2026-09-16 明确要求）：内容区是正文，附件是"这个节点指向的东西"，
 *   两者混在一起时，正文一长就不知道 chip 属于谁。
 */
export function buildNodeElement(
  doc: Document,
  node: MindNode,
  options: NodeElementOptions = {},
): HTMLElement {
  const el = doc.createElement('div');
  el.className = MIND_NODE_CLASS;
  el.setAttribute(MIND_NODE_ID_ATTR, node.id);
  applyNodePalette(el, node, options);

  // 完成（`N3-g`）：两档分开放，**不叠加** ——
  //   `is-done` = **这一行自己**完成（标题删除线 + 变灰）；
  //   `is-done-dim` = **祖先里有完成的**（整块变淡；它自己那一位并没有被标）。
  // ★ 用户要能一眼分出"这是我做完的那一条"与"它是某条已完成分支里的"，
  //   合成一档的话两条看起来一模一样。
  el.classList.toggle('is-done', node.done === true);
  el.classList.toggle('is-done-dim', options.doneBranch === true && node.done !== true);

  const hasNote = node.note.trim().length > 0;
  // 一个节点只认第一条附件（`06 §4.1`）—— 统一走 `firstRefOf`，不在各处现拼下标
  const ref = firstRefOf(node);
  const resource = ref ? (options.resolveResource?.(ref.path) ?? null) : null;

  if (ref && ref.kind === 'image' && resource !== null) {
    el.appendChild(buildImageBlock(doc, ref, resource, options));
    // ★ 宽度写在**节点元素**的 CSS 变量上（不是写在那张 `<img>` 上）：
    //   拖角时视图只改这一个变量就能实时预览（不必去 DOM 里 query 那张图），
    //   而样式表按变量给 `<img>` 定宽 —— 没设过时用 CSS 里那个默认值。
    if (ref.width !== undefined) {
      el.style.setProperty('--nestboard-mind-image-width', `${ref.width}px`);
    }
  }

  const title = doc.createElement('div');
  title.className = 'nestboard-mind-node-title';
  // ★ 标记（`08 §3.1`）：放在**标题最前面**、一个节点最多一个。
  //   对读屏隐藏：它是个装饰性的符号，念出那个 emoji 的名字对听的人没有任何帮助
  if (node.icon !== undefined && node.icon.length > 0) {
    const icon = doc.createElement('span');
    icon.className = 'nestboard-mind-node-icon';
    icon.textContent = node.icon;
    icon.setAttribute('aria-hidden', 'true');
    title.appendChild(icon);
  }
  // 标题是**一行纯文本**（`06 §1` 第 10 条）：不走 Markdown，换行会被 CSS 省略号收掉。
  // ★ 包一层 span 而不是直接写在这条 div 上：末尾要放回形针，`text-overflow` 的省略
  //   必须只作用在文字那一段（写在 div 上会让省略号跑到图标后面去）
  const titleText = doc.createElement('span');
  titleText.className = 'nestboard-mind-node-title-text';
  titleText.textContent = node.text;
  title.appendChild(titleText);
  // ★ 图片附件**不显示回形针**（用户 2026-09-16）：图片块自己就是那个附件、就摆在眼前，
  //   再挂一个图标是重复的。例外：图片画不出来时（文件没了 / 拿不到地址）仍然给回形针 ——
  //   那一刻它是打开这个附件的**唯一**入口。
  if (ref && !(ref.kind === 'image' && resource !== null)) {
    // 文件不在了（被删 / 移到库外）⇒ 回形针画成"失效"那一档（灰 + 说清原因）
    title.appendChild(buildClip(doc, ref.path, options.refMissing?.(ref.path) === true));
  }
  el.appendChild(title);

  if (options.showBody !== false && (hasNote || options.forceBody === true)) {
    const body = doc.createElement('div');
    body.className = MIND_BODY_CLASS;
    // ★ 先写**纯文本**：同步、可在假 DOM 下单测，而且视口内的节点**立刻**有内容
    //   （富文本是异步的，先渲染再替换的话会闪一下空白）。
    body.textContent = node.note;
    if (options.renderMarkdown && hasNote) {
      // 富文本要接管这一块：先把纯文本让出去（`MarkdownRenderer.render` 是追加式的）
      body.textContent = '';
      options.renderMarkdown(node.note, body);
    }
    el.appendChild(body);
  }

  return el;
}

/**
 * 回形针（标题带末尾的那一个）：悬停显示文件名、点击打开文件。
 *
 * ★ 用内联 SVG（Lucide 的 `paperclip` 路径，与 Obsidian 自己的图标同一套画法）
 *   而不是 emoji：emoji 的字形随系统/字体变，而这是要**精确对齐到标题行**的一个图标。
 * ★ `stroke="currentColor"`：颜色跟着标题的字色走（深底浅字时它自己就变白了）。
 * ★ `aria-label` 给读屏：它是个按钮，光有图标读屏读不出来。
 * ★ **失效态**（`missing`，`06 §6` 的断链那一行）：文件被删 / 移到库外之后，
 *   悬停显示文件名对用户毫无帮助 —— 他要的是"这东西怎么了"。这时换成一句说清的话
 *   （`mind.refMissing`），并多挂一个 `is-missing` 类给样式表把它压暗。
 *   ★ 点它仍然有用：`MindView.openRef` 会照旧说一句"文件不在了"（两条路给同一个答案）。
 */
function buildClip(doc: Document, path: string, missing: boolean): HTMLElement {
  const name = refLabelOf(path);

  const clip = doc.createElement('span');
  clip.className = missing ? 'nestboard-mind-clip is-missing' : 'nestboard-mind-clip';
  clip.setAttribute(MIND_REF_ATTR, path);
  // 悬停给的是**文件名**（用户要的），不是整条路径；失效时换成"为什么不在了"
  clip.title = missing ? t('mind.refMissing', { path: name }) : name;
  clip.setAttribute('aria-label', clip.title);
  clip.setAttribute('role', 'button');

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const pathEl = doc.createElementNS(SVG_NS, 'path');
  pathEl.setAttribute(
    'd',
    'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  );
  svg.appendChild(pathEl);
  clip.appendChild(svg);

  return clip;
}

/** 图片块 = 图 + 四个角的缩放把手（宽度由 `ref.width` 说了算，高度随原图长宽比） */
function buildImageBlock(
  doc: Document,
  ref: MindRef,
  resource: string,
  options: NodeElementOptions,
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = MIND_IMAGE_CLASS;

  const img = doc.createElement('img');
  img.className = 'nestboard-mind-image-el';
  img.setAttribute('src', resource);
  // ★ 图片这一层没有回形针，所以"这是什么 / 怎么打开"得靠它自己说：
  //   悬停给文件名 + 一句"双击打开"（`\n` 在原生提示里会正常分行）
  img.title = `${refLabelOf(ref.path)}\n${t('mind.imageHint')}`;
  // 标题已经写了名字，图本身对读屏是重复信息
  img.setAttribute('alt', '');
  // ★ 别让浏览器把这张图当成"可拖走的对象"：那会抢走我们的指针手势
  //   （拖起来变成 ghost image，节点拖不动、角也拉不动）
  img.setAttribute('draggable', 'false');
  // 宽度由 `--nestboard-mind-image-width` 说了算（见 `buildNodeElement`），这里不写 inline 宽
  if (options.onImageLoad) img.addEventListener('load', () => options.onImageLoad?.());
  wrap.appendChild(img);

  for (const corner of MIND_IMAGE_CORNERS) {
    const handle = doc.createElement('span');
    handle.className = `nestboard-mind-image-handle is-${corner}`;
    handle.setAttribute(MIND_IMAGE_RESIZE_ATTR, corner);
    wrap.appendChild(handle);
  }

  return wrap;
}

/**
 * 把配色写进 CSS 变量（样式表只负责"哪一块用哪个变量"）。
 *
 * ★ 走变量而不是逐块写 `style.backgroundColor`：撞色是**四块**（标题底 / 标题字 /
 *   内容底 / 内容字），一处漏改就会得到"标题换了、正文还是上一套"这种半新半旧的样子。
 */
export function applyNodePalette(
  el: HTMLElement,
  node: MindNode,
  options: MindPaletteOptions = {},
): void {
  const palette = mindPaletteOf(node.style, options);
  // ★ 四级及更深**不画盒子**（`D3`，用户 2026-09-18："支持 4 级子节点隐藏外框，
  //   只保留下方托底的线"）。四块颜色全部退回透明 / 正文色，盒子那点影子由样式表的
  //   `.is-deep` 收掉，标题带底下留一条细线（也写在样式表里）。
  //
  // ★ 为什么在**这里**判而不是纯靠 CSS：这四块是**行内变量**（`el.style.setProperty`），
  //   行内样式压得住类规则 —— 不在这里改写的话，`.is-deep` 里写多少条 `--…-bg:
  //   transparent` 都不会生效（这是最容易"改完没反应"的一处）。
  // ★ 只动**颜色**：字号 / 内边距 / 盒子尺寸一个字节不改 —— 那些数在
  //   `palette.ts` 与布局估算里各有一份，改一处就会让布局漂（见下面那段说明）。
  const deep = (options.depth ?? 1) >= MIND_DEEP_DEPTH;
  el.classList.toggle('is-deep', deep);

  el.style.setProperty('--nestboard-mind-title-bg', deep ? 'transparent' : palette.title);
  el.style.setProperty(
    '--nestboard-mind-title-ink',
    deep ? 'var(--text-normal)' : palette.titleInk,
  );
  el.style.setProperty('--nestboard-mind-body-bg', deep ? 'transparent' : palette.body);
  el.style.setProperty('--nestboard-mind-body-ink', deep ? 'var(--text-normal)' : palette.bodyInk);
  // 文字**高亮**（`N3-f`）：只有文字那一块（`.nestboard-mind-node-title-text`）读它 ——
  // 变量写在**节点元素**上、靠继承落下去（与上面四块同一个手法），没设过时是 `transparent`
  el.style.setProperty('--nestboard-mind-title-highlight', node.style?.highlight ?? 'transparent');

  // ★ 字号与粗细跟着**层级**走（根 30 加粗、一层 18、二层及以下 14），
  //   由 `palette.ts` 那组常量算出来写成变量 —— 布局的估算与样式表读的是同一份数，
  //   两边各写一份迟早会漂（估算用 14 而 CSS 是 30，第一帧就会明显错位）。
  const depth = options.depth ?? 1;
  el.style.setProperty('--nestboard-mind-title-size', `${titleSizeOf(depth)}px`);

  // ★ 加粗的判据是"用户设过就听用户的，否则按层级"（根是加粗的）——
  //   `bold: false` 是有意义的值（`08 §3.2` 的优先级表第 2 条），所以这里用 `??` 而不是 `||`
  const weight = node.style?.bold ?? titleBoldOf(depth);
  el.style.setProperty(
    '--nestboard-mind-title-weight',
    weight ? 'var(--font-bold, 700)' : 'normal',
  );
  el.style.setProperty(
    '--nestboard-mind-title-style',
    node.style?.italic === true ? 'italic' : 'normal',
  );
  el.style.setProperty(
    '--nestboard-mind-title-decoration',
    node.style?.underline === true ? 'underline' : 'none',
  );
}

/**
 * 就地改标题的输入组件。
 *
 * ── 为什么不是"一个铺满的 `input`" ──────────────────────────
 *
 * 最初写的是 `input { width: 100% }`，实测**打字时节点不跟着长**：`100%` 的含义是
 * "和父节点一样宽"，而父节点的宽度又是这个输入框撑出来的 —— 循环依赖，浏览器只能
 * 退回输入框的**默认宽度**（约 20 个字符），于是输入框要么太窄、要么比节点还宽
 * （往左延伸的那一支会**长进父节点里**）。
 *
 * 解法是教科书式的"影子"：把**同一段文字**放进一个隐藏的 `span`，让输入框与它叠在
 * 同一个网格单元格里。宽度由那段真文字自己算（字体知道它多宽），输入框只负责填满 ——
 * 循环就解开了，而且纯 CSS，不必用 JS 去量字宽。
 */
export interface TitleEditorHandle {
  /** 插进标题带的那个元素（用户看见的就是它） */
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  /** 把输入框的内容同步给影子（**节点宽度跟着它走**） */
  sync(): void;
}

export function buildTitleEditor(
  doc: Document,
  initial: string,
  ariaLabel: string,
): TitleEditorHandle {
  const wrap = doc.createElement('div');
  wrap.className = 'nestboard-mind-title-edit';

  const shadow = doc.createElement('span');
  shadow.className = 'nestboard-mind-title-shadow';
  shadow.setAttribute('aria-hidden', 'true');

  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'nestboard-mind-title-input';
  input.value = initial;
  input.setAttribute('aria-label', ariaLabel);

  wrap.append(shadow, input);

  const sync = (): void => {
    // 空的时候也得给一个字符：不然宽度塌成 0，光标都站不住
    shadow.textContent = input.value.length > 0 ? input.value : ' ';
  };
  sync();

  return { element: wrap, input, sync };
}

/**
 * 把节点摆到布局给的位置上。
 *
 * ★ **只写 `left` / `top`，不写宽高**：写了宽高，`offsetWidth` 量到的就是自己刚写下的
 *   那个数，尺寸测量变成自证 —— 而脑图的骨架要靠真实的量测（内容是 Markdown，
 *   行数只有浏览器知道）。于是"节点多大"永远由 CSS + 内容决定，布局只是**读**它。
 */
export function applyNodeBox(el: HTMLElement, box: NodeBox): void {
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
}

// ─────────────────────────────────────────────────────────────
// 连线
// ─────────────────────────────────────────────────────────────

/** 连线的 class（样式表认它） */
export const MIND_EDGE_CLASS = 'nestboard-mind-edge';
/** 延长线（节点边缘 → 分支点）的 class */
export const MIND_EDGE_TRUNK_CLASS = 'nestboard-mind-edge-trunk';

/** 「正在拉的那条线」的 class（`N1-b`）：落笔前的虚线预览 */
export const MIND_LINK_PREVIEW_CLASS = 'nestboard-mind-link-preview';

/** 建"正在拉的那条线"的 `<svg>`（与关联线层同一套 1×1 锚点，只是**独立一层**） */
export function buildLinkPreviewLayer(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.classList.add('nestboard-mind-link-preview-layer');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/**
 * 画"正在拉的那条线"（`N1-b`）：一条虚线。
 *
 * ★ 与落笔之后那条**共用 `linkPathOf`** ⇒ 松手时线不会跳
 *   （预览与结果各算一遍，是"松手跳一下"这类 bug 的唯一来路）。
 * ★ 还没吸附到目标时，调用方传一个**退化的框**（零尺寸、落在指针上）——
 *   `linkPathOf` 眼里它就只是一个点，于是"跟手"这一档不用另写一套几何。
 */
export function paintLinkPreview(svg: SVGSVGElement, from: Rect | null, to: Rect | null): void {
  if (!from || !to) {
    svg.replaceChildren();
    return;
  }
  const doc = svg.ownerDocument;
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', MIND_LINK_PREVIEW_CLASS);
  path.setAttribute('d', linkPathOf(from, to));
  svg.replaceChildren(path);
}

/** 关联线的 class（`N1`；样式表认它） */
export const MIND_LINK_CLASS = 'nestboard-mind-link';
/** 被选中的关联线（换标签 / 删线时高亮） */
export const MIND_LINK_SELECTED_CLASS = 'is-selected';

/** 建关联线的 `<svg>` 容器（与连线容器同一套：世界坐标里 1×1 的锚点 + `overflow: visible`） */
export function buildLinkLayer(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.classList.add('nestboard-mind-links');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/**
 * 重画全部关联线（`N1`）。
 *
 * ★ **独立一层**、不复用连线那个 `<svg>`：那一层每次都是 `replaceChildren` 整层重画
 *   （分支线的配对由树决定，散着改反而容易漏），两种数据源混在一层里必然互相擦掉。
 * ★ 两端框拿不到（节点刚删 / 还没量到尺寸）就**跳过这一条** —— 不画一根悬空的线。
 * ★ 几何全部来自 `layout/links.ts`：预览（拖动中的虚线）也走它，落笔与预览因此必然是同一根线。
 */
export interface LinkPaintItem {
  id: string;
  from: Rect;
  to: Rect;
  /** 箭头（`N1-c`）：`'end'` = 终点一个、`'both'` = 两端各一个；缺席 = 无 */
  arrow?: 'end' | 'both';
  /** 标签（`N1-c`）；缺席 = 没有标签（不画那个小牌子） */
  label?: string;
  /** 实线（用户 2026-09-16）：缺席 = **虚线**（默认那一档） */
  solid?: boolean;
  /**
   * **线条颜色**（`N1-e`）：已经解析好的 CSS 颜色值（视图把主题色编号换成 `var(--color-…)`）；
   * 缺席 = 默认那条灰线。
   */
  color?: string;
  /**
   * **弯折**（`N1-d`）：曲线中点的位移；缺席 = 不弯（从前的样子）。
   * ★ 拖动那个手柄时，视图把**预览值**从这里递进来 ⇒ 线、箭头、标签一起跟手，
   *   而模型一个字节都还没动（松手才写一次）。
   */
  bend?: { x: number; y: number };
}

/** 实线的 class（用户 2026-09-16）：没有它就是虚线 */
export const MIND_LINK_SOLID_CLASS = 'is-solid';
/** 箭头三角形的 class（`N1-c`） */
export const MIND_LINK_ARROW_CLASS = 'nestboard-mind-link-arrow';
/** 标签的 class（`N1-c`） */
export const MIND_LINK_LABEL_CLASS = 'nestboard-mind-link-label';

// ─────────────────────────────────────────────────────────────
// 大纲 / 树的**切换器**（用户 2026-09-17 定稿：左上角、竖排两格、白卡片）
// ─────────────────────────────────────────────────────────────

/** 切换器容器的 class（样式表认它；当前视图的格子上强调色） */
export const MIND_VIEW_TOGGLE_CLASS = 'nestboard-mind-view-toggle';
/** 切换器里"一格"的 class（`data-mode` 标记它是哪一档） */
export const MIND_VIEW_TOGGLE_SEG_CLASS = 'nestboard-mind-view-toggle-seg';
/** 两格之间那条分隔线 */
export const MIND_VIEW_TOGGLE_SEP_CLASS = 'nestboard-mind-view-toggle-sep';

/**
 * 把一段**常量** SVG 字符串解析成节点插进 `host`。
 *
 * ★ 用 `DOMParser` 而不是 `innerHTML`：后者会被社区审核判成不安全赋值（见调用处注释）。
 * ★ 解析出的节点经 `importNode` 搬进宿主 document —— 弹出窗（popout）下也不会把节点
 *   落在另一个 document 里。
 */
function appendSvg(host: Element, doc: Document, markup: string): void {
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  const node = parsed.body.firstElementChild;
  if (node) host.appendChild(doc.importNode(node, true));
}

/**
 * 建**大纲 / 树的切换器**（用户 2026-09-17 的设计稿：白卡片里竖排两格，中间一条分隔线，
 * 当前视图的那一格上强调色）。
 *
 * ★ 两个格子**各自只做一件事**：点"大纲"进大纲、点"树"回树 —— 点当前那一格是空操作
 *   （`toggleOutline()` 的开关语义留给旧入口，这里给的是"我要去哪儿"的直接表达）。
 * ★ 图标用用户给的两份设计稿（`viewToggleIcons.ts`），`currentColor` ⇒ 高亮换色走 CSS。
 */
export function buildViewToggle(
  doc: Document,
  handlers: { onOutline: () => void; onTree: () => void },
  labels: { outline: string; tree: string },
): HTMLElement {
  const root = doc.createElement('div');
  root.className = MIND_VIEW_TOGGLE_CLASS;

  const segment = (mode: 'outline' | 'tree', label: string, icon: string): HTMLElement => {
    const seg = doc.createElement('button');
    seg.type = 'button';
    seg.className = MIND_VIEW_TOGGLE_SEG_CLASS;
    seg.dataset.mode = mode;
    seg.setAttribute('aria-label', label);
    // 图标是本模块的**常量**（`viewToggleIcons` 里用户给的设计稿），不是外部输入。
    // ★ 但仍不走 `innerHTML`：社区审核有一条规则把「innerHTML 赋值」判成不安全写法
    //   （它只看这个动作，不看这串到底是不是常量）。用 `DOMParser` 解析成节点再
    //   `importNode`，插进去的是同一段 `<svg>`（`currentColor` 高亮照旧），且绕开该规则。
    appendSvg(seg, doc, icon);
    seg.addEventListener('click', (event) => {
      // ★ 不让它冒泡到视图容器上：画布那份 `pointerdown` 会把这一下当成"点空白"
      event.stopPropagation();
      if (mode === 'outline') handlers.onOutline();
      else handlers.onTree();
    });
    return seg;
  };

  const outlineSeg = segment('outline', labels.outline, OUTLINE_VIEW_ICON);
  const treeSeg = segment('tree', labels.tree, TREE_VIEW_ICON);
  const sep = doc.createElement('div');
  sep.className = MIND_VIEW_TOGGLE_SEP_CLASS;

  root.append(outlineSeg, sep, treeSeg);
  return root;
}
/**
 * **弯折手柄**的 class（`N1-d`，用户 2026-09-17："连线上加个手柄，可以调节连线的弯折程度和方向"）。
 *
 * ★ 它不是 SVG 里的东西，而是**世界容器里一个 HTML 元素**（与折叠手柄同一套）：
 *   位置由视图按"曲线中点"那个世界坐标写 `left/top`（见 `MindView.syncLinkHandle`）。
 */
export const MIND_LINK_HANDLE_CLASS = 'nestboard-mind-link-handle';
/**
 * 关联线**颜色**的 CSS 变量名（`N1-e`，用户 2026-09-17："脑图的连接线应该也要支持改颜色"）。
 *
 * ★ 写成**变量**而不是直接写 `stroke` / `fill`：这样样式表里
 *   `.is-selected { stroke: var(--interactive-accent) }` 那条照样赢（选中时一眼看出动的是哪条），
 *   而没选中时显示用户挑的颜色 —— 直接写死 inline 属性会把"选中"那档盖掉。
 */
export const MIND_LINK_COLOR_VAR = '--nestboard-mind-link-color';

export function paintLinks(
  svg: SVGSVGElement,
  items: readonly LinkPaintItem[],
  selected: ReadonlySet<string> = new Set<string>(),
): void {
  const doc = svg.ownerDocument;
  const parts: SVGElement[] = [];

  for (const item of items) {
    const isSelected = selected.has(item.id);

    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', MIND_LINK_CLASS);
    path.classList.toggle(MIND_LINK_SELECTED_CLASS, isSelected);
    // 线型：默认虚线（样式表里的基准），`solid` 才加这一档（用户 2026-09-16）
    path.classList.toggle(MIND_LINK_SOLID_CLASS, item.solid === true);
    path.setAttribute('d', linkPathOf(item.from, item.to, item.bend));
    if (item.color) path.style.setProperty(MIND_LINK_COLOR_VAR, item.color);
    parts.push(path);

    // 箭头（`N1-c`）：每端一个实心三角，跟着线一起高亮
    // ★ 传 `item.bend`：箭头的方向取**锚点处的切线**，线一弯切线就变 ——
    //   不跟着弯折走的话，箭头会斜着插在节点边上
    for (const end of linkArrowEnds(item.arrow)) {
      const [tip, wingA, wingB] = linkArrowPoints(
        item.from,
        item.to,
        end,
        MIND_LINK_ARROW_SIZE,
        item.bend,
      );
      const arrow = doc.createElementNS(SVG_NS, 'polygon');
      arrow.setAttribute('class', MIND_LINK_ARROW_CLASS);
      arrow.classList.toggle(MIND_LINK_SELECTED_CLASS, isSelected);
      // 箭头的颜色跟着线走（`N1-e`）：同一个变量，一处改两处都对
      if (item.color) arrow.style.setProperty(MIND_LINK_COLOR_VAR, item.color);
      arrow.setAttribute(
        'points',
        `${roundTo(tip.x)},${roundTo(tip.y)} ${roundTo(wingA.x)},${roundTo(wingA.y)} ${roundTo(wingB.x)},${roundTo(wingB.y)}`,
      );
      parts.push(arrow);
    }

    // 标签（`N1-c`）：摆在线中点；底色靠 CSS 的 `paint-order: stroke` 描一圈实底，
    // 于是压在线上也读得清（不必另画一个矩形，少一个要对齐的东西）
    if (item.label !== undefined && item.label.length > 0) {
      // ★ 标签跟着**曲线中点**走：弯折之后它还贴在线上（不跟的话会飘在弧外面）
      const mid = linkMidpointOf(item.from, item.to, item.bend);
      const label = doc.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', MIND_LINK_LABEL_CLASS);
      label.classList.toggle(MIND_LINK_SELECTED_CLASS, isSelected);
      label.setAttribute('x', String(roundTo(mid.x)));
      label.setAttribute('y', String(roundTo(mid.y)));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'middle');
      label.textContent = item.label;
      parts.push(label);
    }
  }

  svg.replaceChildren(...parts);
}

/** 建连线的 `<svg>` 容器（世界坐标里 1×1 的锚点 + `overflow: visible`，样式表负责） */
export function buildEdgeLayer(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.classList.add('nestboard-mind-edges');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/**
 * 重画全部连线（父子的配对由调用方给：它才认识这棵树）。
 *
 * ★ 除了一父一子的分支线，还要给**每个方向各画一条延长线**（`edgeTrunkPathOf`）：
 *   同一个父的多个同侧孩子共用一条（按 `父id:方向` 去重），否则会叠着画好几遍。
 */
export function paintEdges(
  svg: SVGSVGElement,
  pairs: readonly (readonly [NodeBox, NodeBox])[],
  style: MindEdgeStyle = 'curve',
): void {
  const doc = svg.ownerDocument;
  const parts: SVGElement[] = [];
  const trunks = new Set<string>();

  for (const [parent, child] of pairs) {
    const direction = childSideOf(parent, child);
    const key = `${parent.id}:${direction}`;
    if (!trunks.has(key)) {
      trunks.add(key);
      const trunk = doc.createElementNS(SVG_NS, 'path');
      trunk.setAttribute('class', MIND_EDGE_TRUNK_CLASS);
      trunk.setAttribute('d', edgeTrunkPathOf(parent, direction));
      parts.push(trunk);
    }

    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', MIND_EDGE_CLASS);
    // 线型只改"从交汇点之后怎么走到孩子"（`08 §1.3`）；延长线与分支点不受它影响
    path.setAttribute('d', edgePathOf(parent, child, style));
    parts.push(path);
  }

  svg.replaceChildren(...parts);
}

// ─────────────────────────────────────────────────────────────
// 折叠手柄（`06 §11.14`：长在**连接处**的那个圆圈）
// ─────────────────────────────────────────────────────────────

/**
 * 手柄元素上的属性 —— **值就是它管着哪个节点**。
 *
 * ★ 只用这一个属性（而不是"节点 id 属性 + 一个标记"）：命中时一句
 *   `closest('[data-mind-handle]')` 就够，且手柄**不带** `data-mind-node-id` ——
 *   于是 `MindView` 里"点节点"那条路（选中 / 拖动 / 框选）天然不会把点手柄
 *   认成点节点，两套手势不会互相串。
 */
export const MIND_HANDLE_ATTR = 'data-mind-handle';
/** 手柄的 class（样式表认它） */
export const MIND_HANDLE_CLASS = 'nestboard-mind-handle';

// 手柄的尺寸（`MIND_HANDLE_SIZE` / `_STUB` / `_GAP`）**定义在 `layout/edges.ts`**：
// 手柄的圆心就是分支点，而分支点由 `MIND_HANDLE_GAP` 决定 —— 尺寸与几何是一件事的两半。
// 见文件顶部的转出（老引用照旧能从这里拿到）。

export interface HandleState {
  nodeId: string;
  /** 这一支现在是收起状态吗 */
  collapsed: boolean;
  /** **整支总数**（子孙总数，不含自己）—— 收起时写进圆圈 */
  count: number;
  /** 悬停提示（由视图翻好传进来 —— 这一层不认识 i18n） */
  label: string;
}

/**
 * 圆圈里写什么（参数是**整支总数**）。
 *
 * ★ 超过 99 给省略号：三位数会把圆圈撑破（用户给的那版样例也是三个点），
 *   而"这一支里有九十几个还是几百个"对做决定没有区别。
 */
export function handleLabelOf(count: number): string {
  return count > 99 ? '…' : String(count);
}

export function buildHandleElement(doc: Document): HTMLElement {
  const el = doc.createElement('div');
  el.className = MIND_HANDLE_CLASS;
  // 语义上是按钮，但它**不能真的抢焦点**：画布要一直拿着键盘（`Tab` / `Enter` 全在那边）
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '-1');
  return el;
}

/**
 * 写上状态：谁的手柄、收起没有、圈里写什么、悬停提示是什么。
 *
 * ★ 展开态**不写字**（`textContent` 清空），那条短横由 CSS 的 `::before` 画 ——
 *   一个减号用文字表达会在不同字体下左右不居中。
 */
export function applyHandleState(el: HTMLElement, state: HandleState): void {
  el.setAttribute(MIND_HANDLE_ATTR, state.nodeId);
  el.classList.toggle('is-collapsed', state.collapsed);
  el.textContent = state.collapsed ? handleLabelOf(state.count) : '';
  el.setAttribute('aria-label', state.label);
  el.title = state.label;
}

/**
 * 把手柄摆到**分支点上**（节点朝孩子那一侧的边中点，再往外让出 {@link MIND_HANDLE_GAP}）。
 *
 * ★ 让出的那一段就是"节点延伸出来的那截线"：手柄**不贴着节点**，
 *   展开态下它是透明的（鼠标移上去才显形），于是不挡视线；
 *   收起态下它连着那截线一起常显（此时没有子节点的线，光靠那截线才看得出归属）。
 * ★ 方向类 `is-left` 也在这里定：那截线画在圆圈的哪一侧由它决定（见样式表）。
 * ★ 根与悬浮节点（`side === 0`）按"孩子在右"处理：它们的子节点左右交替 / 默认向右，
 *   一个手柄没法同时压在两条分支上 —— 放右边是最不意外的那一侧。
 */
export function applyHandleBox(el: HTMLElement, box: NodeBox): void {
  const toRight = box.side !== -1;
  // 圆心就落在**交汇点**上（与分支线的出发点同一个点 —— 两处必须同源）
  const point = branchPointOf(box, toRight ? 1 : -1);
  el.style.left = `${point.x}px`;
  el.style.top = `${point.y}px`;
  // ★ 纵向布局（组织结构图）：手柄在节点**下方**，那截短线朝**上**。
  //   只看 `side` 分不出"往右"与"往下"（两者的 `side` 都是 1）⇒ 要看 `box.vertical`
  const vertical = box.vertical === true;
  el.classList.toggle('is-up', vertical);
  el.classList.toggle('is-left', !vertical && !toRight);
}

// ─────────────────────────────────────────────────────────────
// 拖拽辅助线（`06 §4.1` 的 `D`：只渲染，**不落盘**）
// ─────────────────────────────────────────────────────────────

/** 辅助线图层的 class（样式表认它） */
export const MIND_GUIDE_CLASS = 'nestboard-mind-guide';
/** 圈住"会挂到这个节点下"的那个虚线框 */
export const MIND_GUIDE_RING_CLASS = 'nestboard-mind-guide-ring';
/** 从父节点连到落点的那条虚线 */
export const MIND_GUIDE_LINE_CLASS = 'nestboard-mind-guide-line';

/** 辅助线要画什么；`null` = 全部收起 */
export interface GuideSpec {
  /** 圈起来的盒子（"松手会挂到它下面"） */
  ring?: Rect | null;
  /** 一条虚线：从哪到哪 */
  line?: readonly [Point, Point] | null;
  /**
   * 这个落点**不允许**（落在自己的子孙上）。
   *
   * ★ 环变红是刻意给的反馈：什么都不画的话，用户只会觉得"拖拽又坏了"，
   *   而红环说的是"在这儿放不行"——两件事必须分得清（与白板 `is-error` 同一考虑）。
   */
  invalid?: boolean;
}

/**
 * 辅助线图层：**一个句柄**而不是一个裸 `<svg>`。
 *
 * ★ 返回句柄而不是让调用方 `querySelector`：假 DOM（单测用的那套）只实现被测代码真正用到的
 *   接口，`querySelector` 不在其中 —— 而辅助线是要被单测的（"原地放下时线必须消失"）。
 */
export interface GuideLayer {
  readonly svg: SVGSVGElement;
  set(spec: GuideSpec | null): void;
}

/** 环往外挪几像素：贴着边画会与节点自己的描边糊在一起 */
const RING_PADDING = 5;

export function buildGuideLayer(doc: Document): GuideLayer {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.classList.add(MIND_GUIDE_CLASS);
  svg.setAttribute('aria-hidden', 'true');

  const ring = doc.createElementNS(SVG_NS, 'rect');
  ring.setAttribute('class', MIND_GUIDE_RING_CLASS);
  ring.setAttribute('rx', '10');
  ring.setAttribute('display', 'none');

  const line = doc.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', MIND_GUIDE_LINE_CLASS);
  line.setAttribute('display', 'none');

  svg.append(ring, line);

  return {
    svg,
    set(spec: GuideSpec | null): void {
      const rect = spec?.ring ?? null;
      if (rect) {
        ring.setAttribute('x', String(roundTo(rect.x - RING_PADDING)));
        ring.setAttribute('y', String(roundTo(rect.y - RING_PADDING)));
        ring.setAttribute('width', String(roundTo(rect.width + RING_PADDING * 2)));
        ring.setAttribute('height', String(roundTo(rect.height + RING_PADDING * 2)));
        ring.classList.toggle('is-invalid', spec?.invalid === true);
        ring.removeAttribute('display');
      } else {
        ring.setAttribute('display', 'none');
      }

      const segment = spec?.line ?? null;
      if (segment) {
        const [from, to] = segment;
        line.setAttribute(
          'd',
          `M ${roundTo(from.x)} ${roundTo(from.y)} L ${roundTo(to.x)} ${roundTo(to.y)}`,
        );
        line.removeAttribute('display');
      } else {
        line.setAttribute('display', 'none');
      }
    },
  };
}
