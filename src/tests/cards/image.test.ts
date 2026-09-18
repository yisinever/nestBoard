/**
 * 图片卡单元测试（T1.50 / T2.02 / T3.09 / `F2-3-3`）。
 *
 * 渲染本身要在真环境里才验得准（真正的布局、真正的 `naturalWidth` 时序），
 * 所以这里钉的是**纯逻辑与 DOM 形状**：
 *   1. **恒等裁剪走老结构**：一次都没裁过的卡片，DOM 必须与 T2.02 之前完全一致
 *      —— 否则"升级插件把老卡片画歪"是没法自证的；
 *   2. **裁剪只写行内样式**：卡片只把四个比例算成"放大多少、往哪推"，
 *      原图 URL、缩略图逻辑一个字都不动（`F2-3-3`：不改原图）；
 *   3. **`measure` 用裁剪区的比例**：裁成竖条后再按横图高度排版会多出一圈留白；
 *   4. **菜单项的置灰规则**：多选 / 空路径 / 锁定卡都不该出现"可点的裁剪"；
 *   5. **双击 = 在图上标注**（T3.09）—— 图片没有可编辑正文，双击掉进编辑态是死胡同，
 *      所以这里钉的是"什么情况下才接管"：`false` 的那几种必须真的交回视图。
 */

import { describe, expect, it, vi } from 'vitest';
import type { App, Component } from 'obsidian';
import { imageCard, normalizeImageCardColor, shouldUseFullImage } from '../../cards/image';
import type {
  CardActionContext,
  CardRenderContext,
  ThumbnailBridge,
  VaultBridge,
} from '../../cards/registry';
import { createCard } from '../../model/factories';
import type { CardOf, ImageCrop } from '../../model/schema';
import { createFakeDocument, createFakeElement, type FakeElement } from '../helpers/fakeDom';

const URL = 'app://local/note-image.png';

interface Setup {
  el: FakeElement;
  ctx: CardRenderContext;
}

function setup(): Setup {
  const doc = createFakeDocument();
  const ctx: CardRenderContext = {
    app: {} as unknown as App,
    sourcePath: '',
    component: {} as unknown as Component,
    renderMarkdown: async () => {},
    zoom: 1,
    mode: 'display',
    notes: { resourceUrl: () => URL } as unknown as VaultBridge,
    updateContent: () => {},
    updateCard: () => {},
    setMode: () => {},
  };
  return { el: createFakeElement(doc), ctx };
}

function renderCropped(crop: ImageCrop): FakeElement {
  const { el, ctx } = setup();
  const card = createCard('image', { content: { path: 'assets/a.png', crop } });
  imageCard.render(el as unknown as HTMLElement, card, ctx);
  return el;
}

// ── 渲染结构 ──────────────────────────────────────────────────

describe('imageCard.render', () => {
  it('恒等裁剪：`<img>` 直接进 `<figure>`（与裁剪功能之前完全一致）', () => {
    const { el, ctx } = setup();
    const card = createCard('image', { content: { path: 'assets/a.png' } });
    imageCard.render(el as unknown as HTMLElement, card, ctx);

    expect(el.classList.contains('nestboard-image')).toBe(true);
    const figure = el.children[0] as FakeElement;
    expect(figure.className).toBe('nestboard-image-figure');
    expect((figure.children[0] as FakeElement).className).toBe('nestboard-image-img');
    // 多包一层 `frame` / `clip` 会让没有裁剪的卡片也走新样式，等于"白裁了一次"
    expect(figure.children).toHaveLength(2);
  });

  it('裁剪后：`figure > frame > clip > img`，四个比例全部写成行内样式', () => {
    const el = renderCropped({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 });

    const figure = el.children[0] as FakeElement;
    const frame = figure.children[0] as FakeElement;
    const clip = frame.children[0] as FakeElement;
    const img = clip.children[0] as FakeElement;

    expect(frame.className).toBe('nestboard-image-frame');
    expect(clip.className).toBe('nestboard-image-clip');
    expect(img.className).toBe('nestboard-image-img');
    // 整图放大 2× / 4×，左上角推出去 20% / 80%
    expect(clip.style.getPropertyValue('width')).toBe('200%');
    expect(clip.style.getPropertyValue('height')).toBe('400%');
    expect(clip.style.getPropertyValue('left')).toBe('-20%');
    expect(clip.style.getPropertyValue('top')).toBe('-80%');
    // 原图地址一点没变（裁剪不碰文件，只改显示）
    expect((img as unknown as { src: string }).src).toBe(URL);
    // 说明文字仍在最后一行
    expect((figure.children[1] as FakeElement).className).toBe('nestboard-image-caption');
  });

  it('空路径只画占位，不建任何 `<img>`（src 为空会让浏览器去请求当前页面）', () => {
    const { el, ctx } = setup();
    imageCard.render(el as unknown as HTMLElement, createCard('image'), ctx);
    expect(el.classList.contains('is-missing')).toBe(true);
    // 只放一段占位文字（文本节点），**没有** `<img>`
    expect(el.children).toHaveLength(1);
    expect((el.children[0] as { nodeType: number }).nodeType).toBe(3);
  });
});

// ── 自动高度 ──────────────────────────────────────────────────

describe('imageCard.measure', () => {
  const fakeEl = (naturalWidth: number, naturalHeight: number, clientWidth: number): HTMLElement =>
    ({
      querySelector: () => ({ naturalWidth, naturalHeight }),
      clientWidth,
    }) as unknown as HTMLElement;

  it('恒等裁剪：高度 = 宽度 ÷ 原图比例', () => {
    const card = createCard('image', { content: { path: 'a.png' } });
    // 400×200，卡片内容宽 200 → 高 100
    expect(imageCard.measure?.(fakeEl(400, 200, 200), card, {} as CardRenderContext)).toBe(100);
  });

  it('★ 按裁剪区的比例：裁成正方块后高度跟着变', () => {
    const card = createCard('image', {
      content: { path: 'a.png', crop: { x: 0, y: 0, w: 0.5, h: 1 } },
    });
    // 裁剪区 200×200 → 比例 1 → 高 200
    expect(imageCard.measure?.(fakeEl(400, 200, 200), card, {} as CardRenderContext)).toBe(200);
  });

  it('读不到固有尺寸返回 0（"我没有意见"，交给卡片层的最小高度）', () => {
    const el = { querySelector: () => null, clientWidth: 200 } as unknown as HTMLElement;
    expect(imageCard.measure?.(el, createCard('image'), {} as CardRenderContext)).toBe(0);
  });
});

// ── 右键菜单 ──────────────────────────────────────────────────

describe('normalizeImageCardColor · 存量图片卡的相框归黑（用户 2026-09-17）', () => {
  it('★ 还是全局默认色 ⇒ 改成默认黑（当年建的卡拿的就是它）', () => {
    const card = createCard('image', { content: { path: 'a.png' }, color: '2' });
    expect(normalizeImageCardColor(card, '2')).toBe(true);
    expect(card.color).toBe('#000000');
  });

  it('★ 用户自己挑过的颜色一个字节都不动（那是他的选择）', () => {
    const card = createCard('image', { content: { path: 'a.png' }, color: '4' });
    expect(normalizeImageCardColor(card, '2')).toBe(false);
    expect(card.color).toBe('4');
  });

  it('已经是黑的 ⇒ 不动（幂等：`applyBoard` 每次改动都会走到这一句）', () => {
    const black = createCard('image', { content: { path: 'a.png' }, color: '#000000' });
    expect(normalizeImageCardColor(black, '#000000')).toBe(false);
    expect(normalizeImageCardColor(black, '2')).toBe(false);
    expect(black.color).toBe('#000000');
  });
});

describe('shouldUseFullImage · 缩略图还是原图（用户 2026-09-17 报"图糊"）', () => {
  it('★ 判据是"屏幕上要画多少像素"，不是单纯的缩放倍数', () => {
    // 老卡片宽度 320px：与从前的 `zoom > 0.8` 一字不差（默认参数就是为它留的）
    expect(shouldUseFullImage(0.8)).toBe(false);
    expect(shouldUseFullImage(0.81)).toBe(true);

    // 800px 宽的截图卡片：0.8 倍下要画 640px，还拿 256px 的缩略图撑 ⇒ 一眼糊
    expect(shouldUseFullImage(0.8, 800)).toBe(true);
    // 屏幕宽度正好等于缩略图边长时还不必上原图（256px 的图 1:1 画出来是清楚的）
    expect(shouldUseFullImage(0.32, 800)).toBe(false);
    expect(shouldUseFullImage(0.33, 800)).toBe(true);
  });

  it('★ 缩得很小的时候仍然吃缩略图（"概览省显存"那条取舍没变）', () => {
    expect(shouldUseFullImage(0.1, 1600)).toBe(false);
    expect(shouldUseFullImage(0.05, 4000)).toBe(false);
  });

  it('★★ 乘上 devicePixelRatio（用户 2026-09-18 仍报"糊"的成因之一）', () => {
    // 320pt 的卡在 0.5 倍下要画 160 个**CSS** 像素 ⇒ 单看它"缩略图够用"
    expect(shouldUseFullImage(0.5, 320, 1)).toBe(false);
    // 但 Retina（DPR = 2）要画 320 个**设备**像素 > 256 ⇒ 该上原图。不乘就还是糊
    expect(shouldUseFullImage(0.5, 320, 2)).toBe(true);
    // 同一张卡在 1 倍屏上要放大到 0.8 才破 256；1.5 倍屏上更早就破
    expect(shouldUseFullImage(0.8, 320, 1)).toBe(false);
    expect(shouldUseFullImage(0.8, 320, 1.5)).toBe(true);
  });

  it('坏的 DPR（0 / NaN）当作 1：宁可多吃缩略图，也别让判据永远为假', () => {
    expect(shouldUseFullImage(0.5, 320, 0)).toBe(false);
    expect(shouldUseFullImage(0.5, 320, Number.NaN)).toBe(false);
  });
});

// ── 缩略图回填：判为"该用原图"的卡不许被换掉（A5）────────────────

describe('imageCard.render · 缩略图回填', () => {
  const THUMB = 'app://local/thumb.png';

  const withThumbs = (
    zoom: number,
    options: { cached?: string | null; alwaysFullImage?: boolean } = {},
  ): { ctx: CardRenderContext; get: ReturnType<typeof vi.fn> } => {
    const { ctx } = setup();
    const get = vi.fn(async () => THUMB);
    return {
      get,
      ctx: {
        ...ctx,
        zoom,
        alwaysFullImage: options.alwaysFullImage,
        thumbnails: {
          peek: () => options.cached ?? null,
          get,
        } as unknown as ThumbnailBridge,
      },
    };
  };

  /** 恒等裁剪下 `img` 的位置：`el > figure > img` */
  const imgOf = (el: FakeElement): { src: string } =>
    (el.children[0] as FakeElement).children[0] as unknown as { src: string };

  it('★ 判为"该用原图"时，后台生成的缩略图**不许**把它换掉', async () => {
    const { ctx, get } = withThumbs(1);
    const el = createFakeElement(createFakeDocument());
    const card = createCard('image', { content: { path: 'assets/a.png' } });

    imageCard.render(el as unknown as HTMLElement, card, ctx);
    expect(imgOf(el).src).toBe(URL);

    // 连后台生成都不该发起：生成了也没人用，而**回填那一句**正是把原图换掉的元凶
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(get).not.toHaveBeenCalled();
    expect(imgOf(el).src).toBe(URL);
  });

  it('缩得很小 + 没有缓存：先用原图顶着，后台生成完再换上缩略图（老行为不能丢）', async () => {
    const { ctx, get } = withThumbs(0.2);
    const el = createFakeElement(createFakeDocument());
    const card = createCard('image', { content: { path: 'assets/a.png' } });

    imageCard.render(el as unknown as HTMLElement, card, ctx);
    // 首帧先拿原图顶着（同步渲染，不许空一块）
    expect(imgOf(el).src).toBe(URL);

    // 假 DOM 的节点没有 `isConnected`（真浏览器里挂在 DOM 上就恒为 true）⇒ 补一个，
    // 否则"回填缩略图"那一句会被它的守卫（`!img.isConnected`）提前 return，这条老行为就测没了
    (imgOf(el) as unknown as { isConnected: boolean }).isConnected = true;

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(get).toHaveBeenCalledWith('assets/a.png');
    expect(imgOf(el).src).toBe(THUMB);
  });

  it('★ 设置项 `alwaysFullImage`：缩到最小也用原图，缓存里那份缩略图一眼不看', () => {
    const { ctx, get } = withThumbs(0.05, { cached: THUMB, alwaysFullImage: true });
    const el = createFakeElement(createFakeDocument());
    const card = createCard('image', { content: { path: 'assets/a.png' } });

    imageCard.render(el as unknown as HTMLElement, card, ctx);
    expect(imgOf(el).src).toBe(URL);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('imageCard.contextMenu', () => {
  const itemOf = (card: CardOf<'image'>, multiple: boolean, action: string) =>
    imageCard.contextMenu!(card, { multiple }).find((item) => item.action === action);

  it('给出"编辑说明文字" / "取消边框" / "在图上标注" / "裁剪图片"四项', () => {
    const card = createCard('image', { content: { path: 'a.png' } });
    expect(imageCard.contextMenu!(card, { multiple: false }).map((item) => item.action)).toEqual([
      'editCaption',
      'toggleCardBorder',
      'inkAnnotate',
      'cropImage',
    ]);
  });

  it('★ "边框"那一项的标题跟着当前状态走（有边框 ⇒ 取消边框；已取消 ⇒ 显示边框）', () => {
    const bordered = createCard('image', { content: { path: 'a.png' } });
    const borderless = createCard('image', { content: { path: 'a.png' }, showBorder: false });

    const on = imageCard.contextMenu!(bordered, { multiple: false }).find(
      (item) => item.action === 'toggleCardBorder',
    );
    const off = imageCard.contextMenu!(borderless, { multiple: false }).find(
      (item) => item.action === 'toggleCardBorder',
    );
    // 缺省（没有这个键）= 有边框 ⇒ 菜单说"取消边框"；显式 `false` 才反过来
    expect(on?.title).not.toBe(off?.title);
    expect(on?.disabled).toBe(false);
    // 锁定卡不该被改外观
    const locked = createCard('image', { content: { path: 'a.png' }, locked: true });
    expect(itemOf(locked, false, 'toggleCardBorder')?.disabled).toBe(true);
  });

  it('裁剪与标注的置灰规则一致：多选 / 空路径 / 锁定卡（点了没反应比缺一项更糟）', () => {
    const ready = createCard('image', { content: { path: 'a.png' } });
    const empty = createCard('image');
    const locked = createCard('image', { content: { path: 'a.png' }, locked: true });

    for (const action of ['cropImage', 'inkAnnotate']) {
      expect(itemOf(ready, false, action)?.disabled).toBe(false);
      expect(itemOf(ready, true, action)?.disabled).toBe(true);
      expect(itemOf(empty, false, action)?.disabled).toBe(true);
      expect(itemOf(locked, false, action)?.disabled).toBe(true);
    }
  });
});

// ── 双击 = 在图上标注（T3.09）──────────────────────────────────

describe('imageCard.onDoubleClick', () => {
  const ready = (): CardOf<'image'> => createCard('image', { content: { path: 'assets/a.png' } });

  const actionCtx = (ink?: CardActionContext['ink']): CardActionContext => ({
    app: {} as unknown as App,
    sourcePath: '',
    applyContent: () => {},
    ink,
  });

  it('有图 + 有手绘能力：接管双击（返回 true，视图不再进入那个没有编辑器的编辑态）', () => {
    const annotate = vi.fn(() => true);
    expect(imageCard.onDoubleClick!(ready(), actionCtx({ annotate }))).toBe(true);
    expect(annotate).toHaveBeenCalledTimes(1);
  });

  it('★ 进不去绘图态（只读 / 图层未就绪）：不接管，把这次双击交回视图解释', () => {
    expect(imageCard.onDoubleClick!(ready(), actionCtx({ annotate: () => false }))).toBe(false);
  });

  it('没有手绘桥（单测 / 嵌入视图）：不接管 —— 宁可让视图解释，也别吞掉一次双击', () => {
    expect(imageCard.onDoubleClick!(ready(), actionCtx())).toBe(false);
  });

  it('空路径：双击该干的是"选一张图"，不是标注（别把落笔点画进一张还没有图的卡）', () => {
    const annotate = vi.fn(() => true);
    expect(imageCard.onDoubleClick!(createCard('image'), actionCtx({ annotate }))).toBe(false);
    expect(annotate).not.toHaveBeenCalled();
  });
});

// ── 定义契约 ──────────────────────────────────────────────────

describe('imageCard 定义', () => {
  it('默认内容带恒等裁剪 / `contain`（新建卡片不迁移旧数据）', () => {
    expect(imageCard.createDefaultContent()).toEqual({
      path: '',
      caption: '',
      crop: { x: 0, y: 0, w: 1, h: 1 },
      fit: 'contain',
    });
  });

  it('导出为 Markdown 仍是普通图片语法（裁剪是显示层的事，不写进正文）', () => {
    const card = createCard('image', {
      content: { path: 'assets/a.png', caption: '图', crop: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    });
    expect(imageCard.toMarkdown(card, { sourcePath: '' })).toBe('![图](assets/a.png)');
  });
});
