import { context } from 'esbuild';
import { sassPlugin } from 'esbuild-sass-plugin';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';

const production = process.env.NODE_ENV === 'production';

const ctx = await context({
    entryPoints: ['src/index.js'],
    bundle: true,
    outdir: 'dist',
    format: 'iife',
    target: 'es2020',
    minify: production,
    sourcemap: !production,
    external: ['*.woff', '*.woff2', '*.jpg', '*.svg', '../../assets*'],
    plugins: [
        sassPlugin({
            loadPaths: ['src/lib', 'node_modules'],
            filter: /\.scss/,
            quietDeps: true,
        }),
    ],
});

mkdirSync('dist', { recursive: true });
mkdirSync('dist/fontawesome/webfonts', { recursive: true });
copyFileSync('manifest.json', 'dist/manifest.json');
copyFileSync('index.html', 'dist/index.html');

for (const file of readdirSync('src/fontawesome/webfonts')) {
    copyFileSync(`src/fontawesome/webfonts/${file}`, `dist/fontawesome/webfonts/${file}`);
}

if (process.env.ESBUILD_WATCH === 'true') {
    await ctx.watch();
    console.log('Watching for changes...');
} else {
    await ctx.rebuild();
    await ctx.dispose();
}
