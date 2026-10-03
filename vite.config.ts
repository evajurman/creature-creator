import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * Writes dist/sw.js from pwa/sw.js, listing every built file (and everything
 * in public/) so the whole app is saved for offline use on the first visit.
 * The version is a hash of the build, so each new build replaces the last.
 */
function serviceWorker(): Plugin {
  return {
    name: 'critterkiln-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html');
      const files = ['./', ...[...built, ...readdirSync('public')].sort().map((f) => `./${f}`)];
      // the page has no hash in its name: its contents count too
      const page = bundle['index.html'];
      const html = page?.type === 'asset' ? String(page.source) : '';
      const version = createHash('sha256').update(files.join('\n') + html).digest('hex').slice(0, 10);
      const source = readFileSync('pwa/sw.js', 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files, null, 2));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // relative asset paths, so the build works at https://<user>.github.io/critterkiln/
  base: './',
  plugins: [serviceWorker()],
});
