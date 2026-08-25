import { defineConfig, type Plugin } from 'vite';

// The single most common GitHub Pages failure is a wrong base path producing a
// blank page. The repository is `parshvak26/hostline`, so the site is served
// from `/hostline/`. Overridable for local preview and for forks.
const base = process.env['VITE_BASE'] ?? '/hostline/';

/**
 * Build the Content-Security-Policy from the configured gateway.
 *
 * Written here rather than hard-coded in `index.html` because the gateway URL
 * is a build-time variable — a fork points at its own worker, and a build with
 * no gateway at all should not be granting itself permission to reach one.
 *
 * `script-src 'self'` with no `unsafe-inline` is the part worth defending: the
 * app has zero runtime dependencies, so nothing legitimate needs an inline
 * script, and saying so out loud costs nothing.
 */
function csp(gatewayUrl: string, turnstileEnabled: boolean): Plugin {
  const gateway = gatewayUrl.trim();
  const turnstile = turnstileEnabled ? 'https://challenges.cloudflare.com' : '';
  const join = (...parts: string[]): string => parts.filter((p) => p !== '').join(' ');

  const policy = [
    `default-src 'self'`,
    `script-src 'self'${turnstile === '' ? '' : ` ${turnstile}`}`,
    // Vite inlines a small style block for the entry CSS in dev and, for some
    // asset shapes, in the build. Stylesheets are ours and are not attacker
    // controlled; scripts, which are, get no such exemption.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src ${join(`'self'`, gateway, turnstile)}`,
    `media-src ${join(`'self'`, 'blob:', gateway)}`,
    `frame-src ${join(`'none'`, turnstile) === `'none'` ? `'none'` : turnstile}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'none'`,
    // `frame-ancestors` is deliberately absent: it is only honoured in a
    // response header, and a `<meta>` CSP cannot set one. GitHub Pages does not
    // allow custom headers, so including it would buy nothing and log a warning
    // on every page load. `X-Frame-Options` is unavailable for the same reason.
    // Clickjacking a demo that stores nothing and has no authenticated action
    // is not a meaningful attack, which is why this is acceptable rather than
    // merely unavoidable.
  ].join('; ');

  return {
    name: 'hostline-csp',
    transformIndexHtml(html) {
      return html.replace('%CSP%', policy);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base,
  plugins: [
    csp(
      process.env['VITE_GATEWAY_URL'] ?? '',
      (process.env['VITE_TURNSTILE_SITE_KEY'] ?? '') !== '' || mode === 'development',
    ),
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // One entry chunk keeps the critical path simple; the audio manifest and
        // clips are fetched at runtime, after first contentful paint.
        manualChunks: undefined,
      },
    },
  },
  server: { port: 5173, strictPort: false },
  preview: { port: 4173, strictPort: false },
}));
