import { ATLAS_DISCORD_URL, ATLAS_GITHUB_URL } from '../support/communityLinks';
import type { IssueReporter } from '../support/IssueReporter';
import type { AtlasSettingSection } from './settingSections';
import { t } from '../i18n';
import { addSettingButton } from '../ui/atlasButton';
import { FORK_SUPPORT_URL } from '../fork/communityNotice';

export function supportSettingsSection(reporter: IssueReporter): AtlasSettingSection {
  return {
    heading: t('settings.support.heading'),
    rows: [
      {
        name: 'Statblock Forge fork support',
        desc: 'For this community fork, report issues and request assistance in the fork support repository.',
        aliases: ['fork', 'statblock forge', 'support', 'github'],
        render: setting => {
          addSettingButton(setting, { text: 'Open fork support', onClick: () => { window.open(FORK_SUPPORT_URL, '_blank', 'noopener,noreferrer'); } });
        },
      },
      {
        name: t('settings.support.reportIssue'),
        desc: 'Use this form for issues in the original Atlas VTT project. For this fork, use the Statblock Forge fork support link above.',
        desc: t('settings.support.reportIssueDesc'),
        aliases: ['bug', 'crash', 'problem', 'feedback', 'github', 'support'],
        render: setting => {
          addSettingButton(setting, { text: t('settings.support.reportIssue'), onClick: () => reporter.open({ type: 'bug' }) });
        },
      },
      {
        name: t('settings.support.suggestFeature'),
        desc: t('settings.support.suggestFeatureDesc'),
        aliases: ['idea', 'request', 'enhancement'],
        render: setting => {
          addSettingButton(setting, { text: t('settings.support.suggestFeature'), onClick: () => reporter.open({ type: 'feature' }) });
        },
      },
      {
        name: t('settings.support.discord'),
        desc: t('settings.support.discordDesc'),
        aliases: ['discord', 'community', 'chat', 'help'],
        render: setting => {
          addSettingButton(setting, { text: t('settings.support.joinDiscord'), onClick: () => { window.open(ATLAS_DISCORD_URL); } });
        },
      },
      {
        name: 'Atlas VTT (upstream) GitHub',
        desc: 'Upstream Atlas source code, development history and releases. Fork-specific support is documented in SUPPORT.md.',
        aliases: ['github', 'source code', 'repository', 'releases'],
        render: setting => {
          addSettingButton(setting, { text: t('settings.support.openGithub'), onClick: () => { window.open(ATLAS_GITHUB_URL); } });
        },
      },
    ],
  };
}
