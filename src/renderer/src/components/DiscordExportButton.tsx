import type { MouseEventHandler } from 'react';
import { FaDiscord } from 'react-icons/fa';
import { useTranslation } from 'react-i18next';

import styles from './ExportButton.module.css';


export default function DiscordExportButton({ onClick }: { onClick: MouseEventHandler<HTMLButtonElement> }) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={styles['discordButton']}
      onClick={onClick}
      title={t('Re-encode a small MP4 for Discord')}
    >
      <FaDiscord style={{ verticalAlign: 'middle', marginRight: '.3em' }} />
      {t('Discord')}
    </button>
  );
}
