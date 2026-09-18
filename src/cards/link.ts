/**
 * 链接卡（T2.04–T2.06 / `F2-4-1`–`F2-4-5`；`O20` 补站点名 / 图标 / 最终网址）。
 *
 * 三条设计约束，全部来自"渲染不联网"这条红线（`01 §合规` / `03 §7.5`）：
 *
 *  1. **抓取有两个入口，都要用户自己动手**：卡片上那个「获取预览」按钮（点一下抓一次），
 *     以及**第一次填入链接时自动抓一次**（新建带 URL / 粘贴，见 `BoardView.createLinkCardAt`）。
 *     空卡片（没有 URL）一个请求都不发；关掉设置里的总开关、或域名在黑名单里时，
 *     `fetchLinkPreview` 一次请求都不发。
 *     ★ 渲染、导出、翻遍整块板仍然不会调 `fetch`（`F2-4-3` / `F11-07`）。
 *  2. **缩略图不留远程地址**。抓到的 `og:image` 会先落盘成 Vault 附件
 *     （`F2-4-4`），卡片存的是**库内相对路径** —— 否则每打开一次白板，
 *     光看图就要往人家 CDN 发一轮请求，而且离线时整排卡片都是裂图。
 *     落盘失败才退回远程地址：有图看总比没图强，且用户已经点过"获取预览"，
 *     那时他就已经接受了"这一次会联网"。
 *  3. **双击 = 用系统浏览器打开**（`F2-4-5`）。与文件卡/引用卡同一套手势约定。
 *
 * ★ `O20` 的两处取舍，都是"不新增请求"这条线的延伸：
 *   - 站点图标是页面**自己声明的那个**地址（`og:logo` / `<link rel="…icon…">`），
 *     不额外发请求去试探 `favicon.ico`，也不是 favicon 聚合服务。它是卡片里唯一
 *     一个会**留在内容中的远程地址**，所以加载失败必须退回字母徽章（见 `render`），
 *     绝不留一个裂图。
 *   - 最终网址（`finalUrl`）只在"和 `url` 不一样"时才写：短链展开之后它才是新信息，
 *     "最终就是原样"时多存一份只是噪声（见 `fetchLinkPreview`）。
 *
 * ★ 与 `file.ts` 一样，本文件**不 import `obsidian`**：抓取、落盘、开浏览器
 *   全走 `CardRenderContext.links`（`LinkPreviewBridge`），于是"域名怎么显示"
 *   "按钮什么时候出现"这些规则能在 node 下单测。
 */

import type { LinkContent } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import {
  domainOf,
  isExternalUrl,
  linkDisplayUrlOf,
  linkSiteNameOf,
  linkStateOf,
  linkTitleOf,
  siteInitialOf,
} from '../util/linkPreview';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 默认尺寸：一行站点 + 一行标题 +（可选）两行描述 + 一行按钮 */
export const LINK_DEFAULT_SIZE: Size = { width: 300, height: 150 };

/**
 * 迷你档（`A8`）的尺寸：一行"图标 + 域名"，40px 高。
 *
 * ★ 与 `LINK_DEFAULT_SIZE` 一样是**形态**（"书签"和"卡片"本来就不是一个形状）：
 *   换档时由视图把尺寸一并写下去 —— 见 `view/BoardView.ts` 的 `toggleLinkStyleCard`。
 */
export const LINK_MINI_SIZE: Size = { width: 220, height: 40 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（复用池里的节点会串味） */
const LINK_CLASSES = ['nestboard-link', 'is-fetching', 'is-error', 'is-mini'] as const;

/**
 * 图片的 `src`：库内路径走资源解析，远程地址直接用。
 *
 * ★ 两处消费：预览图（落盘失败时的远程退路）与站点图标（`O20`，本来就是远程地址）。
 */
function imageSrc(image: string, ctx: CardRenderContext): string {
  if (image.length === 0) return '';
  if (isExternalUrl(image)) return image;
  return ctx.notes?.resourceUrl(image) ?? '';
}

/**
 * 域名首字母徽章。
 *
 * ★ `O20` 之前这是图标的**唯一**形态；现在它是"页面上那个远程图标加载失败"时的退路
 *   —— 所以它必须能被随时插回去，见 `render` 里的 `error` 处理。
 */
function badgeOf(doc: Document, url: string): HTMLElement {
  const badge = doc.createElement('span');
  badge.className = 'nestboard-link-favicon';
  badge.textContent = siteInitialOf(url);
  return badge;
}

/**
 * 迷你档（`A8`，用户 2026-09-18："链接卡迷你样式"）：一行"站点图标 + 域名"。
 *
 * ★ 只用**已经存在**的两样东西（`content.icon` 与 `linkSiteNameOf`）：迷你档不联网、
 *   也不多读一个字段 —— "这个链接是哪儿的"在完整档里已经有答案了。
 * ★ 图标加载失败退回首字母徽章（与完整档同一套退路，尺寸也一样 —— 换的那一下不抖）。
 * ★ 右下角没有按钮条：书签只回答"这是哪儿"，要打开就双击（与完整档同一条路）。
 */
function renderMini(el: HTMLElement, content: LinkContent, ctx: CardRenderContext): void {
  el.classList.add('is-mini');
  const doc = el.ownerDocument;

  const row = doc.createElement('div');
  row.className = 'nestboard-link-mini';

  // 站点名与徽章首字母都按**展示地址**算：短链展开后"我在哪个站"的答案在最终域名上
  const displayUrl = linkDisplayUrlOf(content);
  const iconSrc = imageSrc(content.icon ?? '', ctx);
  if (iconSrc.length > 0) {
    const logo = doc.createElement('img');
    logo.className = 'nestboard-link-logo';
    logo.src = iconSrc;
    logo.addEventListener('error', () => logo.replaceWith(badgeOf(doc, displayUrl)));
    row.appendChild(logo);
  } else {
    row.appendChild(badgeOf(doc, displayUrl));
  }

  const name = doc.createElement('span');
  name.className = 'nestboard-link-sitename';
  name.textContent = linkSiteNameOf(content);
  // 完整地址放 `title`：书签上只写站点名，而"具体是哪一页"只有悬停才问得出来
  name.title = content.url;
  row.appendChild(name);

  el.replaceChildren(row);
}

/** 抓取结果：调用方据它决定"按钮说什么 / 要不要弹 Notice" */
export type LinkFetchResult =
  /** 抓到了，内容已写回模型 */
  | 'ok'
  /** 网络或页面本身的问题（连不上、不是网页、一个字段都没解析出来） */
  | 'failed'
  /** 设置里的总开关关着（`F11-07`）——**没发任何请求** */
  | 'disabled'
  /** 这个域名在用户的黑名单里（T6.06 / `F2-4-6`）——同样**没发任何请求** */
  | 'blocked'
  /** 上下文里根本没有外链能力（单测 / 嵌入视图） */
  | 'unavailable';

/**
 * 抓一次预览并写回模型（T2.05 / T2.06）。
 *
 * ★ 这是**唯一**的抓取实现：卡面上的按钮、右键菜单、以及"第一次填入链接"的自动抓
 *   （`BoardView.createLinkCardAt`）都调它。几处各写一遍的话，迟早出现"按钮能抓、菜单抓不了"
 *   或者"菜单落了盘、自动没落"这种互相矛盾的现场。
 * ★ 返回值而不是 `boolean`：`disabled` / `blocked` / `failed` 要给用户完全不同的提示
 *   （去设置里开开关 / 这个站被你屏蔽了 / 重试一次），压成一个 `false` 就只能说套话。
 * ★ 不做 `isConnected` 判断：本函数只写**模型**（按卡片 id 定位），卡片此刻有没有
 *   渲染在屏幕上与写入正确性无关。
 */
export async function fetchLinkPreview(
  content: LinkContent,
  ctx: Pick<CardRenderContext, 'links' | 'updateContent' | 'contentReady'>,
): Promise<LinkFetchResult> {
  const links = ctx.links;
  if (!links) return 'unavailable';
  if (!links.enabled) return 'disabled';
  // ★ 黑名单在**发请求之前**问一次，并且与 `disabled` 分开报（T6.06）：
  //   "被你屏蔽了"和"总开关关着"要用户做的事完全不同，而这两条都是用户**自己设的**，
  //   混起来他就会去翻一个根本没关的开关。桥内部还会再拦一次 —— 这里是让提示说得出话。
  if (links.isBlocked(content.url)) return 'blocked';

  const meta = await links.fetch(content.url);
  if (!meta) return 'failed';

  const patch: Partial<LinkContent> = {
    title: meta.title,
    description: meta.description,
    fetchedAt: new Date().toISOString(),
  };

  // ★ 先落盘再一次性写回（T2.06）：先写内容的话会先渲染一版远程图，
  //   落盘回来再换一次本地图 —— 用户看到图片闪一下，且中间那一帧是联网的
  if (meta.image.length > 0) {
    const local = isExternalUrl(meta.image) ? await links.cacheImage(meta.image) : null;
    patch.image = local ?? meta.image;
  }

  // ★ `O20`：站点名 / 图标新信息，**空值键缺席**（见 `LinkContent` 的注释）。
  //   图标**不落盘**：它就是页面声明的那个地址，多下一次只是把"不新增请求"这条线拉断
  //   —— 渲染那边有 `error` 兜底（退回首字母徽章），离线也不会留裂图
  if (meta.siteName.length > 0) patch.siteName = meta.siteName;
  if (meta.icon.length > 0) patch.icon = meta.icon;
  // ★ 最终网址只在**真的换了个地址**时才写（短链展开 / 站点规范化）：
  //   和 `url` 一模一样时多存一个键只是噪声，而"空值键缺席"这条约定
  //   是为了让"抓过"与"没抓到"两份内容在字节上仍然可分
  if (meta.finalUrl.length > 0 && meta.finalUrl !== content.url) patch.finalUrl = meta.finalUrl;

  ctx.updateContent(patch);
  ctx.contentReady?.();
  return 'ok';
}

export const linkCard: CardTypeDefinition<'link'> = {
  type: 'link',

  get displayName(): string {
    return t('card.type.link');
  },

  icon: 'link',
  defaultSize: LINK_DEFAULT_SIZE,

  createDefaultContent(): LinkContent {
    return { url: '', title: '', description: '', image: '', fetchedAt: null };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-link');
    // ★ `is-mini` 也要在这里摘掉（`A8`）：复用池里的槽位随时会被派给别的卡 ——
    //   上一张是迷你书签、这一张是完整卡时，留着它会让完整卡顶着书签的排版
    el.classList.remove('is-fetching', 'is-error', 'is-mini');
    delete el.dataset.placeholder;

    const doc = el.ownerDocument;
    const content = card.content;
    const state = linkStateOf(content);
    const links = ctx.links;

    if (state === 'empty') {
      el.dataset.placeholder = 'true';
      el.replaceChildren(doc.createTextNode(t('card.link.empty')));
      return;
    }

    // ── 迷你档（`A8`）：一行"站点图标 + 域名" ──────────────
    // ★ 排在 `empty` 之后：没有地址的链接卡仍然只是那句占位语（它连域名都没有）
    if (content.style === 'mini') {
      renderMini(el, content, ctx);
      return;
    }

    // ── 主体：缩略图 + （域名 / 标题 / 描述） ──────────────
    const body = doc.createElement('div');
    body.className = 'nestboard-link-body';

    const src = imageSrc(content.image, ctx);
    if (src.length > 0) {
      const thumb = doc.createElement('img');
      thumb.className = 'nestboard-link-thumb';
      thumb.src = src;
      // 图裂时不要留一个占位的破图图标：直接整块收掉，文字部分仍然可读
      thumb.addEventListener('error', () => thumb.remove());
      body.appendChild(thumb);
    }

    const main = doc.createElement('div');
    main.className = 'nestboard-link-main';

    // 站点那一行的两截文案都用**展示地址**算：短链抓完之后，"我在哪个站"的答案
    // 应该在展开后的域名上，而不是 `b23.tv`（`O20`）
    const displayUrl = linkDisplayUrlOf(content);
    const siteName = linkSiteNameOf(content);

    const site = doc.createElement('div');
    site.className = 'nestboard-link-site';
    const iconSrc = imageSrc(content.icon ?? '', ctx);
    if (iconSrc.length > 0) {
      const logo = doc.createElement('img');
      logo.className = 'nestboard-link-logo';
      logo.src = iconSrc;
      // 装饰性图片：旁边那行字已经说清是哪个站了，读屏不必再念一遍
      logo.alt = '';
      // ★ 图标是页面自报的**远程**地址（`O20`）：断网 / 对方 404 / 被拦都可能裂。
      //   裂了就换回本地画的字母徽章 —— 这一格必须"有东西"，
      //   与缩略图裂了直接 `remove()` 的取向不同（那边是可选装饰，这边是身份标识）
      logo.addEventListener('error', () => logo.replaceWith(badgeOf(doc, displayUrl)));
      site.appendChild(logo);
    } else {
      // 没有图标（没抓到 / 抓到的不是 http(s)）：回到 `O20` 之前那套字母徽章
      site.appendChild(badgeOf(doc, displayUrl));
    }

    const domain = doc.createElement('span');
    domain.className = 'nestboard-link-sitename';
    domain.textContent = siteName;
    // 站点名可能被 CSS 截断（"少数派" 不会，但一长串公司名会），
    // 悬停能看全 —— 这一行同时承担域名与站点名两种内容，值得给个 toast
    domain.title = siteName;
    site.appendChild(domain);
    main.appendChild(site);

    const title = doc.createElement('div');
    title.className = 'nestboard-link-title';
    title.textContent = linkTitleOf(content);
    main.appendChild(title);

    if (content.description.length > 0) {
      const desc = doc.createElement('div');
      desc.className = 'nestboard-link-desc';
      desc.textContent = content.description;
      main.appendChild(desc);
    }

    // ★ 网址那一行只在**抓过之后**才出现（`O20`）：没抓过时上面那行已经是域名，
    //   再摆一条完整地址只是同一句话说三遍；抓过之后它才是"我到底在看哪一页"
    //   （`title` 给全地址：CSS 会按一行截断，长网址靠悬停看全）
    if (state === 'fetched') {
      const urlLine = doc.createElement('div');
      urlLine.className = 'nestboard-link-url';
      urlLine.textContent = displayUrl;
      urlLine.title = displayUrl;
      main.appendChild(urlLine);
    }

    body.appendChild(main);

    // ── 按钮条 ────────────────────────────────────────────
    const actions = doc.createElement('div');
    actions.className = 'nestboard-link-actions';

    /** 卡片内的按钮：不拦 `pointerdown` 的话，按一下会先被卡片层的拖动接管 */
    const wire = (button: HTMLButtonElement, run: () => void): void => {
      button.type = 'button';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
      });
    };

    // 「获取预览」按钮（`O20` 的手动入口）：`O32` 曾按"填入即抓"撤掉，现已按用户要求**改回**。
    // ★ 与自动抓取**并存**：第一次填入链接时会自动抓一次（见 `BoardView.createLinkCardAt`），
    //   之后想重抓就点这里 —— 卡面上必须留一个看得见的手动入口。
    if (links) {
      const fetch = doc.createElement('button');
      fetch.className = 'nestboard-link-fetch';
      fetch.textContent = state === 'fetched' ? t('card.link.refetch') : t('card.link.fetch');
      // 总开关关着时按钮**照样在**（`F2-4-2` 的字面要求），但按下不抓取，
      // 而是把"为什么没反应"说清楚 —— 比藏起来让用户以为卡片坏了强
      if (!links.enabled) fetch.classList.add('is-disabled');

      // 定义在 `wire` 之前：块内的 `function` 声明在各家 lint 规则下待遇不一，
      // 箭头常量最没有歧义
      const runFetch = async (): Promise<void> => {
        if (!links.enabled) {
          el.classList.add('is-error');
          fetch.textContent = t('card.link.disabled');
          return;
        }
        const label = fetch.textContent ?? '';
        el.classList.add('is-fetching');
        el.classList.remove('is-error');
        fetch.disabled = true;
        fetch.textContent = t('card.link.fetching');

        // 抓取本体与右键菜单、自动抓共用（见 `fetchLinkPreview`）：这里只负责按钮自己的
        // 加载态与失败文案
        const result = await fetchLinkPreview(content, ctx);
        // 抓取期间这张卡可能已被回收去装别的链接：模型那边写回是对的（按 id 定位，
        // 不会串卡），但**按钮已经不是我们手里这一个了**，不能再改它的文案
        if (!el.isConnected) return;

        el.classList.remove('is-fetching');
        fetch.disabled = false;
        if (result === 'ok') {
          fetch.textContent = label;
          return;
        }
        el.classList.add('is-error');
        // ★ `blocked` 必须是**独立**的一档（T6.06）：把它并进 `disabled` 的话，
        //   用户会去翻总开关 —— 而总开关明明是开着的，他只会以为插件坏了。
        //   这条判断在 `fetchLinkPreview` 里、**任何 `await` 之前**就返回，
        //   所以按钮不会先闪一下"抓取中"再改口。
        if (result === 'failed') fetch.textContent = t('card.link.retry');
        else if (result === 'blocked') fetch.textContent = t('card.link.blocked');
        else fetch.textContent = t('card.link.disabled');
      };

      wire(fetch, () => void runFetch());
      actions.appendChild(fetch);
    }

    const open = doc.createElement('button');
    open.className = 'nestboard-link-open';
    // 图标按钮（`O32`）：只画一个"分享 / 外链"记号，文案进 `aria-label` / `title`
    open.setAttribute('aria-label', t('card.link.open'));
    open.title = t('card.link.open');
    if (ctx.setIcon) ctx.setIcon(open, 'share-2');
    else open.textContent = t('card.link.open');
    wire(open, () => void links?.openExternal(content.url));
    if (!links) open.disabled = true;
    actions.appendChild(open);

    el.replaceChildren(body, actions);
  },

  contextMenu(card, menuCtx) {
    const empty = card.content.url.length === 0;
    const mini = card.content.style === 'mini';
    return [
      {
        id: 'link-open',
        title: t('card.link.open'),
        icon: 'external-link',
        disabled: menuCtx.multiple || empty,
        // 复用 `openSource`：它最终走到本定义的 `onDoubleClick` —— "菜单里打开"和
        // "双击卡片"本来就是同一条路（与文件卡同一套做法）
        action: 'openSource',
      },
      {
        id: 'link-fetch',
        title: t('menu.card.fetchPreview'),
        icon: 'cloud-download',
        disabled: menuCtx.multiple || empty,
        action: 'fetchPreview',
      },
      // 卡面样式（`A8`）：标题跟着**当前**样式走（与文件卡"取消边框 / 显示边框"同一个做法）
      {
        id: 'link-style',
        title: mini ? t('menu.card.linkFull') : t('menu.card.linkCompact'),
        icon: mini ? 'square' : 'minus',
        checked: mini,
        disabled: menuCtx.multiple || empty || card.locked,
        action: 'toggleLinkStyle',
      },
    ];
  },

  /**
   * 收起后标题行写什么（`O34`）：**预览抓到的网页标题**；没抓到预览就写**链接本身**。
   *
   * ★ 链接卡的名字一直住在 `content.title` 里（`CardBase.title` 是用户自己起的名字，
   *   通常空着），而收起只留标题行 —— 不接管这一步，收起的链接卡就是一条空白。
   * ★ 空标题的卡片标题行会整个收起（见 `CardLayer.applyCard` 的 `is-empty`），
   *   所以这里**必须**回落到 URL：那至少说明"这张卡指的是哪"。
   */
  collapsedTitle(card): string {
    const { url, title } = card.content;
    return title.trim().length > 0 ? title.trim() : url;
  },

  onDoubleClick(card, ctx): boolean {
    const url = card.content.url;
    if (url.length === 0) return false;
    // 没有外链能力（单测 / 嵌入视图）→ 不接管，让视图去决定怎么提示
    if (!ctx.links) return false;
    void ctx.links.openExternal(url);
    return true;
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...LINK_CLASSES);
    delete el.dataset.placeholder;
    // 整棵子树丢掉：复用池里的节点可能还挂着上一张卡的图片与按钮
    el.replaceChildren();
  },

  toMarkdown(card): string {
    const { url, title } = card.content;
    if (url.length === 0) return '';
    // 标题为空时用域名当链接文字：`[](url)` 在导出的笔记里是个看不见的空链接
    const text = (title.trim() || domainOf(url) || url).replace(/[[\]]/g, '');
    return `[${text}](${url})`;
  },
};
