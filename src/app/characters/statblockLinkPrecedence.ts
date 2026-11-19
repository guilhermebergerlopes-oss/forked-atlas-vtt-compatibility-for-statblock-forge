/**
 * The statblock on a placed character is its instance-level choice. The link on the
 * library asset is only the default when that instance has no choice of its own.
 * Asset link changes refresh copies that followed the old asset link, but never
 * replace a different path stored on an individual map token.
 */
export interface StatblockLinkOwner {
  assetId?: string | undefined;
  imagePath: string;
  statblockPath?: string | undefined;
}

export interface AssetStatblockLinkChange {
  assetId?: string | undefined;
  tokenImagePath: string;
  previousStatblockPath?: string | null | undefined;
  statblockPath: string | null;
  /** Legacy map tokens without an Asset ID may match by art only when that art is unambiguous. */
  allowLegacyPathMatch?: boolean | undefined;
}

/** The explicit instance path wins; otherwise the library asset supplies the default. */
export function effectiveStatblockPath(
  instancePath: string | null | undefined,
  assetPath: string | null | undefined,
): string | null {
  const instance = typeof instancePath === 'string' ? instancePath.trim() : '';
  if (instance) return instancePath!;
  const asset = typeof assetPath === 'string' ? assetPath.trim() : '';
  return asset ? assetPath! : null;
}


/**
 * A resolved Asset ID record is the source of truth, including when it has no link.
 * Only a missing/deleted record may fall back to a path captured by an older reference.
 */
export function statblockPathFromAssetRecord(
  record: { statblockPath?: string | undefined } | null | undefined,
  referencePath: string | null | undefined,
): string | null {
  return record === null || record === undefined
    ? effectiveStatblockPath(referencePath, null)
    : effectiveStatblockPath(null, record.statblockPath);
}

/**
 * Whether a placed token belongs to the asset whose default link changed.
 * A present but different Asset ID is authoritative, even when two records share art.
 * Legacy map tokens without an Asset ID match by image path only when no duplicate Asset makes that unsafe.
 */
export function belongsToLinkedAsset(
  token: StatblockLinkOwner,
  change: Pick<AssetStatblockLinkChange, 'assetId' | 'tokenImagePath' | 'allowLegacyPathMatch'>,
  pathsEquivalent: (left: string, right: string) => boolean = (left, right) => left === right,
): boolean {
  if (token.assetId) return change.assetId !== undefined && token.assetId === change.assetId;
  if (change.assetId && change.allowLegacyPathMatch === false) return false;
  return pathsEquivalent(token.imagePath, change.tokenImagePath);
}

/**
 * Whether a token is still following the asset default. A missing instance path means
 * it was relying on the asset at render time; a path equal to the old/new default is
 * the materialized copy of that same link. Any other path is an instance override.
 */
export function followsAssetStatblockLink(
  instancePath: string | null | undefined,
  previousPath: string | null | undefined,
  nextPath: string | null,
  pathsEquivalent: (left: string, right: string) => boolean = (left, right) => left === right,
): boolean {
  const instance = typeof instancePath === 'string' ? instancePath.trim() : '';
  if (!instance) return true;
  return (typeof previousPath === 'string' && previousPath !== '' && pathsEquivalent(instance, previousPath))
    || (typeof nextPath === 'string' && nextPath !== '' && pathsEquivalent(instance, nextPath));
}

/** An asset change is applied only to instances that both belong to the asset and follow its link. */
export function followsAssetLinkChange(
  token: StatblockLinkOwner,
  change: AssetStatblockLinkChange,
  pathsEquivalent?: (left: string, right: string) => boolean,
): boolean {
  return belongsToLinkedAsset(token, change, pathsEquivalent)
    && followsAssetStatblockLink(token.statblockPath, change.previousStatblockPath, change.statblockPath, pathsEquivalent);
}
