/** Length of the abbreviated commit shown beside the product version. */
const SHORT_RELEASE_LENGTH = 7;

export type ReleaseLabel = {
  /** Visible text, e.g. `Tasks 1.8.2 · 638b9a6`, or `Tasks 1.8.2` when no build is known. */
  text: string;
  /** Tooltip text carrying the full release identifier, when there is one. */
  title: string | undefined;
};

/**
 * Builds the small version line shown in the sidebar. `release` is the server's `RELEASE_SHA`.
 * A missing, blank or `local` value (an unreleased development build) shows the version only.
 */
export function releaseLabel(
  productName: string,
  version: string,
  release: string | null | undefined,
): ReleaseLabel {
  const sha = release?.trim() ?? '';
  const base = `${productName} ${version}`;
  if (!sha || sha.toLowerCase() === 'local') return { text: base, title: undefined };
  return {
    text: `${base} · ${sha.slice(0, SHORT_RELEASE_LENGTH)}`,
    title: `${base}\nBuild ${sha}`,
  };
}
