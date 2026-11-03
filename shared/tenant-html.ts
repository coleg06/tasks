import {
  type TenantBrandPalette,
  type TenantProfile,
  tenantProfile,
  tenantTitle,
} from './tenant-profile.ts';

const cssPropertyByPaletteKey = {
  accent: '--accent',
  accentHover: '--accent-hover',
  accentSubtle: '--accent-subtle',
  accentBorder: '--accent-border',
  brand: '--brand',
  brandStrong: '--brand-strong',
  onAccent: '--on-accent',
} as const satisfies Record<keyof TenantBrandPalette, `--${string}`>;

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function paletteCss(palette: TenantBrandPalette) {
  return Object.entries(cssPropertyByPaletteKey)
    .map(([key, property]) => `${property}:${palette[key as keyof TenantBrandPalette]}`)
    .join(';');
}

export function tenantBrandingCss(profile: TenantProfile = tenantProfile) {
  return `:root{${paletteCss(profile.branding.light)}}@media (prefers-color-scheme:dark){:root{${paletteCss(profile.branding.dark)}}}`;
}

export function renderTenantHtml(html: string, profile: TenantProfile = tenantProfile) {
  const title = escapeHtml(tenantTitle(profile));
  return html
    .replace('<title>Tasks</title>', `<title>${title}</title>`)
    .replace(
      '<!-- tenant-profile-branding -->',
      `<style id="tenant-profile-branding">${tenantBrandingCss(profile)}</style>`,
    );
}
