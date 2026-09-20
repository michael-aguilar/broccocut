import { Fragment, memo, useMemo, useState } from 'react';
import type { MotionStyle } from 'motion/react';
import { motion } from 'motion/react';
import { FaMouse } from 'react-icons/fa';
import { useTranslation, Trans } from 'react-i18next';

import SetCutpointButton from './components/SetCutpointButton';
import SimpleModeButton from './components/SimpleModeButton';
import useUserSettings from './hooks/useUserSettings';
import type { StateSegment } from './types';
import type { KeyBinding } from '../../common/types';
import { splitKeyboardKeys } from './util';
import { getModifier } from './hooks/useTimelineScroll';
import Kbd from './components/Kbd';
import { DialogButton } from './components/Button';
import styles from './NoFileLoaded.module.css';
import brandIcon from './assets/broccocolon3.png';


function Keys({ keys }: { keys: string | undefined }) {
  if (keys == null || keys === '') {
    return <kbd>UNBOUND</kbd>;
  }
  const split = splitKeyboardKeys(keys);
  return split.map((key, i) => (
    <Fragment key={key}><Kbd code={key} />{i < split.length - 1 && <span style={{ fontSize: '.7em', marginLeft: '-.2em', marginRight: '-.2em' }}>{' + '}</span>}</Fragment>
  ));
}

const dropzoneStyle: MotionStyle = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  color: 'var(--gray-12)',
  margin: 'clamp(12px, 3vw, 40px)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  borderWidth: '1px',
  borderStyle: 'dashed',
  borderColor: 'var(--border)',
};

function NoFileLoaded({ currentCutSeg, onClick, keyBindingByAction }: {
  currentCutSeg: StateSegment | undefined,
  onClick: () => void,
  keyBindingByAction: Record<string, KeyBinding>,
}) {
  const { t } = useTranslation();
  const { simpleMode, segmentMouseModifierKey } = useUserSettings();
  const [dragging, setDragging] = useState(false);

  const currentCutSegOrDefault = useMemo(() => currentCutSeg ?? { segColorIndex: 0 }, [currentCutSeg]);

  return (
    <motion.div
      className={`no-user-select ${styles['dropzone']}`}
      style={dropzoneStyle}
      animate={{ borderColor: dragging ? 'var(--accent)' : 'var(--border)' }}
      onDragOver={() => setDragging(true)}
      onDragLeave={() => setDragging(false)}
    >
      <img src={brandIcon} alt="" className={styles['mark']} />
      <div className={styles['title']}>{t('Drop files')}</div>

      <DialogButton primary onClick={onClick} className={styles['openButton']}>{t('Open file')}</DialogButton>

      <div className={styles['hints']}>
        <div>
          <Trans>See <b>Help</b> menu for help</Trans>
        </div>

        <div>
          <Trans><SetCutpointButton currentCutSeg={currentCutSegOrDefault} side="start" style={{ verticalAlign: 'middle' }} /> <SetCutpointButton currentCutSeg={currentCutSegOrDefault} side="end" style={{ verticalAlign: 'middle' }} />, <Keys keys={keyBindingByAction['setCutStart']?.keys} /> <Keys keys={keyBindingByAction['setCutEnd']?.keys} /> or <span><kbd style={{ marginRight: '.1em' }}>{getModifier(segmentMouseModifierKey)}</kbd></span>+<FaMouse style={{ marginRight: '.1em', verticalAlign: 'middle' }} /> to set cutpoints</Trans>
        </div>

        <div>
          {simpleMode ? (
            <Trans><SimpleModeButton style={{ verticalAlign: 'middle' }} /> to show advanced view</Trans>
          ) : (
            <Trans><SimpleModeButton style={{ verticalAlign: 'middle' }} /> to show simple view</Trans>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export default memo(NoFileLoaded);
