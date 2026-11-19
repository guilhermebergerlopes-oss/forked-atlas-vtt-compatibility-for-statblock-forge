import { t } from '../i18n';
import { showNotice } from '../ui/notice';
import forkIconUrl from '../assets/brand/statblock-forge-icon.svg?inline';
import { createAtlasButton } from '../ui/atlasButton';
import { FORK_PLUGIN_PAGE_URL, FORK_RELEASES_URL } from './forkReleaseConfig';

/** Returns this fork's release notes URL only after its own repository is configured. */
export function releaseNotesUrl(version: string): string | null {
  return FORK_RELEASES_URL ? `${FORK_RELEASES_URL}/releases/tag/${encodeURIComponent(version)}` : null;
}

/** Hands the update to Obsidian only when this fork has its own community-plugin listing. */
export function openUpdate(): void {
  if (FORK_PLUGIN_PAGE_URL) window.open(FORK_PLUGIN_PAGE_URL);
}

/** Says that `version` is out, but never presents upstream Atlas releases as fork updates. */
export function announceUpdate(version: string, acted: () => void = () => undefined): void {
  const notesUrl = releaseNotesUrl(version);
  if (!FORK_PLUGIN_PAGE_URL || !notesUrl) return;

  const message = createFragment();
  const card = message.createDiv({ cls: 'atlas-vtt-plugin atlas-update-notice' });
  card.createEl('img', { cls: 'atlas-update-notice__icon', attr: { src: forkIconUrl, alt: '' } });
  const body = card.createDiv({ cls: 'atlas-update-notice__body' });
  body.createDiv({ cls: 'atlas-update-notice__title', text: t('settings.updates.noticeTitle') });
  body.createDiv({ cls: 'atlas-update-notice__text', text: t('settings.updates.notice', { version }) });
  const actions = body.createDiv({ cls: 'atlas-update-notice__actions' });
  const update = createAtlasButton(actions, { text: t('settings.updates.update'), size: 'sm' });
  const notes = createAtlasButton(actions, { text: t('settings.updates.whatsNew'), variant: 'outline', size: 'sm' });
  const close = createAtlasButton(card, { variant: 'ghost', size: 'icon', icon: 'x', cls: ['atlas-close-btn', 'atlas-update-notice__close'], attr: { 'aria-label': t('common.close') } });
  const notice = showNotice(message, 0);
  close.addEventListener('click', () => {
    acted();
    notice.hide();
  });
  update.addEventListener('click', () => {
    acted();
    notice.hide();
    openUpdate();
  });
  notes.addEventListener('click', () => {
    acted();
    notice.hide();
    window.open(notesUrl);
  });
}
