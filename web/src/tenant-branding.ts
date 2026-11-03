import {
  type TenantBrandPalette,
  type TenantProfile,
  tenantProfile,
  tenantTitle,
} from '../../shared/tenant-profile';

const cssPropertyByPaletteKey = {
  accent: '--accent',
  accentHover: '--accent-hover',
  accentSubtle: '--accent-subtle',
  accentBorder: '--accent-border',
  brand: '--brand',
  brandStrong: '--brand-strong',
  onAccent: '--on-accent',
} as const satisfies Record<keyof TenantBrandPalette, `--${string}`>;

export function applyTenantBranding(root: HTMLElement, palette: TenantBrandPalette) {
  for (const [key, property] of Object.entries(cssPropertyByPaletteKey)) {
    root.style.setProperty(property, palette[key as keyof TenantBrandPalette]);
  }
}

export function installTenantProfile(
  documentValue: Document = document,
  windowValue: Window = window,
  profile: TenantProfile = tenantProfile,
) {
  documentValue.title = tenantTitle(profile);

  const colorScheme = windowValue.matchMedia?.('(prefers-color-scheme: dark)');
  const applyColorScheme = () =>
    applyTenantBranding(
      documentValue.documentElement,
      colorScheme?.matches ? profile.branding.dark : profile.branding.light,
    );

  applyColorScheme();
  colorScheme?.addEventListener('change', applyColorScheme);

  return () => colorScheme?.removeEventListener('change', applyColorScheme);
}
