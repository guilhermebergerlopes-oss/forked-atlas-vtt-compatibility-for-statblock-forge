import React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { t } from '../../../../i18n';
import type { ForgeStatblockEntryIssue } from './forgeStatblockEntryIssue';

interface ForgeStatblockIssueNoticeProps {
  issue: ForgeStatblockEntryIssue;
  compact?: boolean;
}

function content(issue: ForgeStatblockEntryIssue): { title: string; detail: string; moved: boolean } {
  switch (issue.kind) {
    case 'template-moved':
      return {
        title: t('am.link.forgeTemplateMoved'),
        detail: t('am.link.forgeTemplateMovedBody', { from: issue.from, path: issue.path, id: issue.templateId }),
        moved: true,
      };
    case 'template-missing':
      return {
        title: t('am.link.forgeTemplateMissing'),
        detail: t('am.link.forgeTemplateMissingBody', { path: issue.expectedPath, id: issue.templateId }),
        moved: false,
      };
    case 'template-ambiguous':
      return {
        title: t('am.link.forgeTemplateAmbiguous'),
        detail: t('am.link.forgeTemplateAmbiguousBody', { paths: issue.candidates.join('\n'), id: issue.templateId }),
        moved: false,
      };
    case 'template-invalid':
      return {
        title: t('am.link.forgeTemplateInvalid'),
        detail: t('am.link.forgeTemplateInvalidBody', { reason: issue.reason, path: issue.path ?? '' }),
        moved: false,
      };
    case 'note-values-invalid':
      return {
        title: t('am.link.forgeNoteValuesInvalid'),
        detail: t('am.link.forgeNoteValuesInvalidBody', { reason: issue.reason }),
        moved: false,
      };
    case 'resolved-statblock-invalid':
      return {
        title: t('am.link.forgeResolvedStatblockInvalid'),
        detail: t('am.link.forgeResolvedStatblockInvalidBody', { issues: issue.issues.join(', ') }),
        moved: false,
      };
    case 'invalid-link':
      return {
        title: t('am.link.forgeLinkInvalid'),
        detail: t('am.link.forgeLinkInvalidBody'),
        moved: false,
      };
  }
}

/** A concise, localized explanation for recoverable Forge link and template problems. */
export function ForgeStatblockIssueNotice({ issue, compact = false }: ForgeStatblockIssueNoticeProps): React.JSX.Element {
  const message = content(issue);
  const Icon = message.moved ? Info : AlertTriangle;
  return (
    <div
      className={[
        'atlas-statblock-link__issue',
        compact && 'atlas-statblock-link__issue--compact',
        message.moved ? 'is-info' : 'is-warning',
      ].filter(Boolean).join(' ')}
      role={message.moved ? 'status' : 'alert'}
      data-forge-issue={issue.kind}
    >
      <Icon aria-hidden />
      <span className="atlas-statblock-link__issue-copy">
        <strong>{message.title}</strong>
        {!compact && <span>{message.detail}</span>}
        {!compact && !message.moved && <span>{t('am.link.forgeIssueUnlinkable')}</span>}
      </span>
    </div>
  );
}

export function forgeStatblockIssueLabel(issue: ForgeStatblockEntryIssue): string {
  switch (issue.kind) {
    case 'template-moved': return t('am.link.forgeTemplateMoved');
    case 'template-missing': return t('am.link.forgeTemplateMissing');
    case 'template-ambiguous': return t('am.link.forgeTemplateAmbiguous');
    case 'template-invalid': return t('am.link.forgeTemplateInvalid');
    case 'note-values-invalid': return t('am.link.forgeNoteValuesInvalid');
    case 'resolved-statblock-invalid': return t('am.link.forgeResolvedStatblockInvalid');
    case 'invalid-link': return t('am.link.forgeLinkInvalid');
  }
}
