/**
 * 链接卡单元测试（T2.04–T2.06 / `F2-4-1`–`F2-4-5`）。
 *
 * 渲染要在真环境里才验得准（真 `<button>`、真 `isConnected` 时序），所以这里钉
 * 的是**抓取流程**与**卡片契约**这两块错了很难肉眼发现的：
 *   1. **一次抓取写回什么**：标题、描述、时间，以及预览图**必须是库内路径**
 *      （写远程地址 = 每开一次白板就往外发一轮请求，`F2-4-4` 的全部意义）；
 *   2. **开关关着时一个请求都不能发**（`F11-07`）—— 这是"零网络请求"红线的
 *      最后一道闸门，退化成"发了请求只是不显示"就全错了；
 *   3. **失败/无能力时什么都不写**：把 `failed` 误当成"写个空标题"会让卡片
 *      看起来抓成功了，用户再也不会去点第二次；
 *   4. **双击不接管**的边界：没有外链能力时必须交回视图。
 */

import { describe, expect, it, vi } from 'vitest';
import { LINK_DEFAULT_SIZE, fetchLinkPreview, linkCard } from '../../cards/link';
import type { CardActionContext, CardRenderContext, LinkPreviewBridge } from '../../cards/registry';
import { createCard } from '../../model/factories';
import type { LinkContent } from '../../model/schema';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';

const BARE: LinkContent = {
  url: 'https://example.com/',
  title: '',
  description: '',
  image: '',
  fetchedAt: null,
};

/** 一个"什么都成"的假桥，各用例按需覆盖其中一项 */
function bridgeOf(overrides: Partial<LinkPreviewBridge> = {}): LinkPreviewBridge {
  return {
    enabled: true,
    isBlocked: vi.fn(() => false),
    fetch: vi.fn(async () => ({
      title: '示例标题',
      description: '示例描述',
      image: 'https://cdn.example.com/a.png',
      // `O20` 的三样：默认给空串 = "这个站没声明"，各用例按需覆盖
      siteName: '',
      icon: '',
      finalUrl: '',
    })),
    cacheImage: vi.fn(async () => 'assets/链接预览.png'),
    openExternal: vi.fn(async () => true),
    ...overrides,
  };
}

// ── 抓取流程 ──────────────────────────────────────────────────

describe('fetchLinkPreview', () => {
  it('成功：标题 / 描述 / 抓取时间写回，预览图先落盘再写成库内路径', async () => {
    const links = bridgeOf();
    const updateContent = vi.fn();
    const contentReady = vi.fn();

    const result = await fetchLinkPreview(BARE, { links, updateContent, contentReady });

    expect(result).toBe('ok');
    expect(links.cacheImage).toHaveBeenCalledWith('https://cdn.example.com/a.png');

    expect(updateContent).toHaveBeenCalledTimes(1);
    const patch = updateContent.mock.calls[0]?.[0] as Partial<LinkContent> | undefined;
    expect(patch?.title).toBe('示例标题');
    expect(patch?.description).toBe('示例描述');
    // ★ 一定不能是远程地址：那等于每开一次白板就往人家 CDN 发一轮请求
    expect(patch?.image).toBe('assets/链接预览.png');
    // `fetchedAt` 是"抓过了"的唯一判据（见 `linkStateOf`），不能漏
    expect(typeof patch?.fetchedAt).toBe('string');
    expect(patch?.fetchedAt).not.toBeNull();

    // 抓到东西会改变卡片内容高度，得让视图重量一次
    expect(contentReady).toHaveBeenCalledTimes(1);
  });

  it('落盘失败退回远程地址（离线时图会裂，但内容不丢）', async () => {
    const links = bridgeOf({ cacheImage: vi.fn(async () => null) });
    const updateContent = vi.fn();

    expect(await fetchLinkPreview(BARE, { links, updateContent })).toBe('ok');

    const patch = updateContent.mock.calls[0]?.[0] as Partial<LinkContent> | undefined;
    expect(patch?.image).toBe('https://cdn.example.com/a.png');
  });

  it('网页没有 og:image 时根本不碰落盘（不白跑一趟附件目录）', async () => {
    const links = bridgeOf({
      fetch: vi.fn(async () => ({
        title: '只有标题',
        description: '',
        image: '',
        siteName: '',
        icon: '',
        finalUrl: '',
      })),
    });
    const updateContent = vi.fn();

    expect(await fetchLinkPreview(BARE, { links, updateContent })).toBe('ok');
    expect(links.cacheImage).not.toHaveBeenCalled();
    const patch = updateContent.mock.calls[0]?.[0] as Partial<LinkContent> | undefined;
    expect(patch?.image).toBeUndefined();
  });

  it('抓不到 → `failed`，而且一个字都不写回', async () => {
    const links = bridgeOf({ fetch: vi.fn(async () => null) });
    const updateContent = vi.fn();

    expect(await fetchLinkPreview(BARE, { links, updateContent })).toBe('failed');
    // 写了空标题会让卡片看着像"抓成功了但没有内容"，用户不会再点第二次
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('★ 总开关关着 → `disabled`，而且一个请求都没发', async () => {
    const links = bridgeOf({ enabled: false });
    const updateContent = vi.fn();

    expect(await fetchLinkPreview(BARE, { links, updateContent })).toBe('disabled');
    expect(links.fetch).not.toHaveBeenCalled();
    expect(links.cacheImage).not.toHaveBeenCalled();
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('没有外链能力 → `unavailable`（不抛错）', async () => {
    const updateContent = vi.fn();
    expect(await fetchLinkPreview(BARE, { updateContent })).toBe('unavailable');
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('★ 域名在黑名单里 → `blocked`，而且一个请求都没发', async () => {
    const links = bridgeOf({ isBlocked: vi.fn(() => true) });
    const updateContent = vi.fn();

    expect(await fetchLinkPreview(BARE, { links, updateContent })).toBe('blocked');
    // 黑名单存在的**全部意义**就是"不发这个请求"—— 这里一旦松动，
    // 用户在设置里写的规则就成了一句空话
    expect(links.fetch).not.toHaveBeenCalled();
    expect(links.cacheImage).not.toHaveBeenCalled();
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('★ 黑名单与总开关是两回事：开关开着但站被封 → `blocked`（而不是 `disabled`）', async () => {
    // 报成 `disabled` 的话，用户会去翻一个**明明开着**的总开关，然后以为插件坏了
    const links = bridgeOf({ enabled: true, isBlocked: vi.fn(() => true) });
    expect(await fetchLinkPreview(BARE, { links, updateContent: vi.fn() })).toBe('blocked');
  });

  it('总开关关着时**不**去问黑名单（少读一次设置，也不给"两档到底哪个生效"留缝）', async () => {
    const isBlocked = vi.fn(() => true);
    const links = bridgeOf({ enabled: false, isBlocked });
    expect(await fetchLinkPreview(BARE, { links, updateContent: vi.fn() })).toBe('disabled');
    expect(isBlocked).not.toHaveBeenCalled();
  });

  // ── O20：站点名 / 图标 / 最终网址 ──────────────────────────

  it('站点名与图标原样写回（抓到就该记下来，哪怕标题为空也一样算"抓到了"）', async () => {
    const links = bridgeOf({
      fetch: vi.fn(async () => ({
        title: '标题',
        description: '',
        image: '',
        siteName: '少数派',
        icon: 'https://cdn.example.com/logo.png',
        finalUrl: '',
      })),
    });
    const updateContent = vi.fn();

    expect(await fetchLinkPreview(BARE, { links, updateContent })).toBe('ok');
    const patch = updateContent.mock.calls[0]?.[0] as Partial<LinkContent> | undefined;
    expect(patch?.siteName).toBe('少数派');
    expect(patch?.icon).toBe('https://cdn.example.com/logo.png');
  });

  it('★ 图标**不落盘**：它就是页面声明的那个地址，多下一次就打破了"不新增请求"', async () => {
    const links = bridgeOf({
      fetch: vi.fn(async () => ({
        title: '标题',
        description: '',
        image: '',
        siteName: '',
        icon: 'https://cdn.example.com/logo.png',
        finalUrl: '',
      })),
    });

    expect(await fetchLinkPreview(BARE, { links, updateContent: vi.fn() })).toBe('ok');
    expect(links.cacheImage).not.toHaveBeenCalled();
  });

  it('★ 空值键缺席：这三样没抓到就**不写这个键**（与 title 的空串是两码事）', async () => {
    // `title` / `description` 的空串是"抓到了，但页面没写"；这三样是"根本没有"。
    // 留着 `siteName: ''` 会让"抓过但没站点名"与"从没抓过"在内容字节上分不开
    // （见 `LinkContent` 的注释）。渲染层用 `?? ''` 读它们，缺席是安全的。
    const links = bridgeOf({
      fetch: vi.fn(async () => ({
        title: '标题',
        description: '',
        image: '',
        siteName: '',
        icon: '',
        finalUrl: '',
      })),
    });
    const updateContent = vi.fn();
    await fetchLinkPreview(BARE, { links, updateContent });

    const patch = updateContent.mock.calls[0]?.[0] as Partial<LinkContent> | undefined;
    expect(patch).toBeDefined();
    expect(patch && 'siteName' in patch).toBe(false);
    expect(patch && 'icon' in patch).toBe(false);
    expect(patch && 'finalUrl' in patch).toBe(false);
  });

  it('最终网址只在**和用户粘的那条不同**时才写（短链展开是新信息，"原样"则是噪声）', async () => {
    const expanded = bridgeOf({
      fetch: vi.fn(async () => ({
        title: '标题',
        description: '',
        image: '',
        siteName: '',
        icon: '',
        finalUrl: 'https://www.bilibili.com/video/BV1',
      })),
    });
    const updateContent = vi.fn();
    await fetchLinkPreview(BARE, { links: expanded, updateContent });

    let patch = updateContent.mock.calls[0]?.[0] as Partial<LinkContent> | undefined;
    expect(patch?.finalUrl).toBe('https://www.bilibili.com/video/BV1');

    // 页面自报的 `og:url` 就是用户粘的那条 → 不写这个键
    const same = bridgeOf({
      fetch: vi.fn(async () => ({
        title: '标题',
        description: '',
        image: '',
        siteName: '',
        icon: '',
        finalUrl: BARE.url,
      })),
    });
    const updateContentAgain = vi.fn();
    await fetchLinkPreview(BARE, { links: same, updateContent: updateContentAgain });

    patch = updateContentAgain.mock.calls[0]?.[0] as Partial<LinkContent> | undefined;
    expect(patch && 'finalUrl' in patch).toBe(false);
  });
});

// ── 卡片定义契约 ──────────────────────────────────────────────

describe('linkCard 定义', () => {
  it('暴露类型 / 默认尺寸 / 默认内容（新建链接卡用它）', () => {
    expect(linkCard.type).toBe('link');
    expect(linkCard.defaultSize).toEqual(LINK_DEFAULT_SIZE);
    expect(linkCard.createDefaultContent()).toEqual({
      url: '',
      title: '',
      description: '',
      image: '',
      fetchedAt: null,
    });
  });

  it('导出为 Markdown：用标题当链接文字', () => {
    const card = createCard('link', { content: { url: 'https://a.com/x', title: '示例站' } });
    expect(linkCard.toMarkdown(card, { sourcePath: '' })).toBe('[示例站](https://a.com/x)');
  });

  it('导出为 Markdown：标题里的方括号被清掉（否则导出的链接会断）', () => {
    const card = createCard('link', {
      content: { url: 'https://a.com/', title: 'a [b] c' },
    });
    expect(linkCard.toMarkdown(card, { sourcePath: '' })).toBe('[a b c](https://a.com/)');
  });

  it('导出为 Markdown：没有标题时用域名（`[](url)` 在导出的笔记里是个看不见的空链接）', () => {
    const card = createCard('link', { content: { url: 'https://www.a.com/x', title: '' } });
    expect(linkCard.toMarkdown(card, { sourcePath: '' })).toBe('[a.com](https://www.a.com/x)');
  });

  it('导出为 Markdown：URL 为空返回空串（不产生半个链接）', () => {
    const card = createCard('link', {});
    expect(linkCard.toMarkdown(card, { sourcePath: '' })).toBe('');
  });

  it('双击：有外链能力时交给系统浏览器并接管这次双击', () => {
    const card = createCard('link', { content: { url: 'https://a.com/' } });
    const openExternal = vi.fn(async () => true);
    const ctx = { links: bridgeOf({ openExternal }) } as unknown as CardActionContext;

    expect(linkCard.onDoubleClick?.(card, ctx)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://a.com/');
  });

  it('双击：没有外链能力时不接管（交给视图去解释，别把一次双击吞掉）', () => {
    const card = createCard('link', { content: { url: 'https://a.com/' } });
    const ctx = {} as unknown as CardActionContext;
    expect(linkCard.onDoubleClick?.(card, ctx)).toBe(false);
  });

  it('双击：URL 为空不接管', () => {
    const card = createCard('link', {});
    const ctx = { links: bridgeOf() } as unknown as CardActionContext;
    expect(linkCard.onDoubleClick?.(card, ctx)).toBe(false);
  });

  it('收起态标题（`O34`）：有预览写网页标题，没有预览写链接本身', () => {
    // 收起只留标题行，而链接卡的名字住在 `content.title` 里 —— 不接管这一步，
    // 收起的链接卡就是一条空白（`CardLayer.applyCard` 会把空标题那一行整个收掉）
    const withPreview = createCard('link', {
      content: { url: 'https://a.com/x', title: '示例标题' },
    });
    const blank = createCard('link', { content: { url: 'https://a.com/x', title: '' } });

    expect(linkCard.collapsedTitle?.(withPreview)).toBe('示例标题');
    expect(linkCard.collapsedTitle?.(blank)).toBe('https://a.com/x');
  });

  it('收起态标题（`O34`）：标题只有空白不算标题（与 `toMarkdown` 的判据同一口径）', () => {
    const card = createCard('link', { content: { url: 'https://a.com/x', title: '   ' } });
    expect(linkCard.collapsedTitle?.(card)).toBe('https://a.com/x');
  });

  it('菜单：给出"打开"、"获取预览"、"卡面样式"三项，各自带动作', () => {
    const card = createCard('link', { content: { url: 'https://a.com/' } });
    const items = linkCard.contextMenu?.(card, { multiple: false }) ?? [];
    expect(items.map((item) => item.action)).toEqual([
      'openSource',
      'fetchPreview',
      'toggleLinkStyle',
    ]);
  });

  it('★ 菜单里那一项说的总是"切到另一种"（当前是迷你 ⇒ 说"完整卡片样式"）', () => {
    const full = createCard('link', { content: { url: 'https://a.com/' } });
    const mini = createCard('link', { content: { url: 'https://a.com/', style: 'mini' } });

    const titleOf = (card: typeof full): string =>
      (linkCard.contextMenu?.(card, { multiple: false }) ?? []).find(
        (item) => item.action === 'toggleLinkStyle',
      )?.title ?? '';

    expect(titleOf(full)).not.toBe(titleOf(mini));
    // 迷你档那一项是勾选态（与文件卡"取消边框"同一个做法）
    expect(
      (linkCard.contextMenu?.(mini, { multiple: false }) ?? []).find(
        (item) => item.action === 'toggleLinkStyle',
      )?.checked,
    ).toBe(true);
  });

  it('菜单：多选或还没填 URL 时两项都禁用', () => {
    const filled = createCard('link', { content: { url: 'https://a.com/' } });
    const empty = createCard('link', {});

    const multi = linkCard.contextMenu?.(filled, { multiple: true }) ?? [];
    expect(multi.every((item) => item.disabled === true)).toBe(true);

    const blank = linkCard.contextMenu?.(empty, { multiple: false }) ?? [];
    expect(blank.every((item) => item.disabled === true)).toBe(true);
  });
});

// ── 迷你档渲染（`A8`）────────────────────────────────────────

describe('linkCard 迷你档（A8）', () => {
  const hasClassDeep = (el: FakeElement, className: string): boolean =>
    el.classList.contains(className) ||
    (el.children as FakeElement[]).some((child) => hasClassDeep(child, className));

  const render = (content: Partial<LinkContent>): FakeElement => {
    const doc = createFakeDocument();
    const el = createFakeElement(doc);
    const ctx = {
      notes: { exists: () => true, resourceUrl: () => 'app://local/x' },
    } as unknown as CardRenderContext;
    const card = createCard('link', { content: { url: 'https://a.com/page', ...content } });
    linkCard.render(el as unknown as HTMLElement, card, ctx);
    return el;
  };

  it('★ 只画一行"站点图标 + 域名"：没有标题 / 描述 / 预览图 / 按钮条', () => {
    const el = render({ style: 'mini' });

    expect(el.classList.contains('is-mini')).toBe(true);
    const row = el.children[0] as FakeElement;
    expect(row.className).toBe('nestboard-link-mini');
    // 没抓过图标 ⇒ 本地画的字母徽章；右边是域名（`linkSiteNameOf` 的回退）
    expect((row.children[0] as FakeElement).className).toBe('nestboard-link-favicon');
    expect((row.children[1] as FakeElement).textContent).toBe('a.com');

    for (const cls of [
      'nestboard-link-title',
      'nestboard-link-desc',
      'nestboard-link-thumb',
      'nestboard-link-actions',
    ]) {
      expect(hasClassDeep(el, cls)).toBe(false);
    }
  });

  it('抓过图标时用那个图标；站点名优先用 `siteName`（与完整档同一套回退）', () => {
    const el = render({ style: 'mini', icon: 'https://a.com/i.png', siteName: 'A 站' });
    const row = el.children[0] as FakeElement;
    expect((row.children[0] as FakeElement).className).toBe('nestboard-link-logo');
    expect((row.children[1] as FakeElement).textContent).toBe('A 站');
  });

  it('没有地址时仍然是那句占位语（迷你档连域名都没有）', () => {
    const el = render({ url: '', style: 'mini' });
    expect(el.dataset.placeholder).toBe('true');
    expect(el.classList.contains('is-mini')).toBe(false);
  });

  it('★ 复用池安全：槽位从"迷你"换画"完整"时 `is-mini` 必须被摘掉', () => {
    const doc = createFakeDocument();
    const el = createFakeElement(doc);
    const ctx = {
      notes: { exists: () => true, resourceUrl: () => 'app://local/x' },
    } as unknown as CardRenderContext;

    linkCard.render(
      el as unknown as HTMLElement,
      createCard('link', { content: { url: 'https://a.com/x', style: 'mini' } }),
      ctx,
    );
    expect(el.classList.contains('is-mini')).toBe(true);

    linkCard.render(
      el as unknown as HTMLElement,
      createCard('link', { content: { url: 'https://a.com/x' } }),
      ctx,
    );
    expect(el.classList.contains('is-mini')).toBe(false);
  });
});
