/**
 * SVG 文本 → PNG 字节（`06 §7.3` 的 PNG 那一半）。
 *
 * ── 为什么走"SVG 再栅格化"而不是直接用 Canvas 画一遍 ──────────
 *
 * 一条渲染器喂三种导出（SVG 文件 / PNG 图片 / 将来的 PDF）比两套渲染器各画一遍
 * 可靠得多：两套的下场是"SVG 导出的图与 PNG 导出的图字距不一样"，而那种差异
 * 用户只会归因成"这插件有毛病"。文字排版（换行、字体回退、中文基线）交给浏览器，
 * 我们只管几何。
 *
 * ── 唯一一处碰浏览器的地方 ────────────────────────────────
 *
 * `Image` + `canvas` 只有渲染进程里有，所以这一层**故意做薄**：它没有判断、没有
 * 几何、没有格式知识 —— 那些全在纯函数里（`mind/export/toSvg.ts`），可以在 node 下测。
 *
 * ★ `Image` 的 `onload` 对 `blob:` URL 是异步的，必须等它 —— 直接 `drawImage`
 *   会画出一张空白（而且不报错，最难查的那类）。
 */

/** 把一份 SVG 文本栅格化成 PNG 字节；`scale` = 像素倍率（2 表示二倍图） */
export async function svgToPngBytes(svg: string, scale = 2): Promise<ArrayBuffer> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((image.width || 1) * scale));
    canvas.height = Math.max(1, Math.round((image.height || 1) * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no-2d-context');
    // 白色打底：PNG 的透明区域在多数阅读器里是**黑**的，而脑图导出的默认预期是白纸
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), 'image/png'),
    );
    if (!blob) throw new Error('to-blob-failed');
    return await blob.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('svg-load-failed'));
    image.src = url;
  });
}
