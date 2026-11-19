import React from 'react';

export const FORK_COMMUNITY_NOTICE =
  'Statblock Forge: Fork for Atlas VTT is a community extension. It is not made, endorsed or supported by Atlas VTT or Atlas Online.';
export const FORK_SUPPORT_URL =
  'https://github.com/guilhermebergerlopes-oss/statblock-forge-for-atlas-vtt/issues';

/** Community identity and the fork's own support destination, shown beside online/account surfaces. */
export function ForkCommunityNotice(): React.JSX.Element {
  return (
    <div className="atlas-fork-community-notice" role="note">
      <span>{FORK_COMMUNITY_NOTICE}</span>
      <a href={FORK_SUPPORT_URL} target="_blank" rel="noopener noreferrer">
        Support and issue reporting
      </a>
    </div>
  );
}

/** DOM counterpart for the map's online-play panel. */
export function appendForkCommunityNotice(parent: HTMLElement): HTMLElement {
  const notice = parent.createDiv({ cls: 'atlas-fork-community-notice', attr: { role: 'note' } });
  notice.createSpan({ text: FORK_COMMUNITY_NOTICE });
  notice.createEl('a', {
    text: 'Support and issue reporting',
    href: FORK_SUPPORT_URL,
    attr: { target: '_blank', rel: 'noopener noreferrer' },
  });
  return notice;
}
