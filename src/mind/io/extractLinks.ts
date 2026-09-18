/**
 * 脑图那份 `LinkExtractor`（`06 §7.2` 的接缝）—— `.nestmind` 文本 → 出链 / 标签。
 *
 * 于是反链面板（`integration/BacklinkPanel.ts`）**不必认识脑图**：它拿到的是中立的
 * `LinkHit`（`docPath` / `anchorId` / `label`），点一条就 `openMindView(path, { nodeId })`
 * 定位到那个节点。白板那份在 `integration/LinkIndex.ts`（`extractBoardDoc`）。
 *
 * ── 扫什么 ────────────────────────────────────────────────
 *
 * **只扫节点的正文**（`node.note`），与白板"只扫内联卡正文"同一条边界：
 *  * 标题是**一行纯文本**（`06 §1` 第 10 条），不渲染 Markdown ⇒ 里面的 `[[x]]`
 *    不是链接、只是五个字符；
 *  * 附件（`refs`）已经是**结构化**的引用了，不该再被当成"内联链接"数一遍
 *    （那样反链面板上会出现同一份文件的两种说法）。
 *
 * ★ 纯函数：不 import `obsidian`、不碰 DOM，可直接单测。
 * ★ 复用 `scanInlineText`：围栏代码块跳过、行内代码抹掉、`#标签` 的规则 —— 这些
 *   "什么是链接、什么只是展示语法"的判断，两边**必须**同一套，各写一份必漂。
 */

import { scanInlineText } from '../../integration/LinkIndex';
import type { ExtractedDoc } from '../../integration/LinkIndex';
import { parseMindFile } from '../model/validate';

/**
 * 一段 `.nestmind` 文本 → 出链 / 标签。
 *
 * @returns `null` = 不是脑图 / 读不成（调用方跳过这一份，不当作"没有链接"）
 */
export function extractMindDoc(_sourcePath: string, text: string): ExtractedDoc | null {
  const parsed = parseMindFile(text);
  if (!parsed.ok) return null;

  const file = parsed.file;
  const links: ExtractedDoc['links'] = [];
  const tags = new Set<string>();

  for (const node of file.nodes) {
    const note = node.note;
    if (note.trim().length === 0) continue;

    const scan = scanInlineText(note);
    for (const tag of scan.tags) tags.add(tag);
    for (const hit of scan.links) {
      links.push({
        excerpt: hit.excerpt,
        target: hit.target,
        // 命中的是**节点**：点一条反链就定位到这个节点（`anchorId` 中立地叫这个名）
        anchorId: node.id,
        label: node.text,
      });
    }
  }

  return { title: file.meta.title, links, tags: [...tags] };
}
