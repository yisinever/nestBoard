import esbuild from 'esbuild';
import process from 'node:process';

const prod = process.argv[2] === 'production';

const banner = `/*
Nestboard —— Obsidian 白板插件
构建产物，请勿直接修改；源码见仓库 src/。
*/`;

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',

  // Obsidian 运行时与编辑器依赖不打包（运行期由宿主提供）
  external: ['obsidian', 'electron', 'codemirror', '@codemirror/*', '@lezer/*'],

  format: 'cjs', // Obsidian 要求 CommonJS 产物
  platform: 'browser', // ★ 主动防线：误引 Node 内置模块时构建即失败，保证移动端可用（03 §7.6）
  target: 'es2018',

  logLevel: 'info',
  treeShaking: true,
  sourcemap: prod ? false : 'inline',
  minify: prod,
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
