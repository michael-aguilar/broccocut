import { memo, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as Dialog from './Dialog';
import { DialogButton } from './Button';
import Select from './Select';
import TextInput from './TextInput';
import useUserSettings from '../hooks/useUserSettings';
import { formatDuration } from '../util/duration';
import type { DiscordEncodeParams, DiscordRange } from '../discordExport';
import { bytesPerMb, discordQualities, discordResolutions, estimateDiscordBytesPerSecond, getRangesDuration } from '../discordExport';
import type { DiscordExportSettings } from '../../../common/types';
import styles from './DiscordExportDialog.module.css';

const { basename } = window.require('node:path');


const formatSize = (bytes: number) => `${(bytes / bytesPerMb).toFixed(bytes < 10 * bytesPerMb ? 1 : 0)} MB`;

function SizeMeter({ bytes, limitBytes }: { bytes: number, limitBytes: number }) {
  const ratio = bytes / limitBytes;
  let level = 'ok';
  if (ratio > 1) level = 'over';
  else if (ratio > 0.9) level = 'close';
  return (
    <div className={styles['meter']} data-level={level}>
      <div className={styles['meterFill']} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
    </div>
  );
}

function DiscordExportDialog({ open, onOpenChange, outputs, encodeParams, onExport }: {
  open: boolean,
  onOpenChange: (isOpen: boolean) => void,
  /** One entry per output file, each being the ranges that get joined into it */
  outputs: DiscordRange[][],
  encodeParams: Omit<DiscordEncodeParams, 'settings'> | undefined,
  onExport: () => void,
}) {
  const { t } = useTranslation();
  const { discordExport, setDiscordExport } = useUserSettings();
  const { quality, resolution, sizeLimitMb } = discordExport;

  const updateSettings = (patch: Partial<DiscordExportSettings>) => setDiscordExport((prev) => ({ ...prev, ...patch }));

  const [sizeLimitInput, setSizeLimitInput] = useState(String(sizeLimitMb));
  const id = useId();

  const allRanges = useMemo(() => outputs.flat(), [outputs]);
  const estimateKey = useMemo(() => JSON.stringify({ allRanges, encodeParams, quality, resolution }), [allRanges, encodeParams, quality, resolution]);
  const [estimate, setEstimate] = useState<{ key: string, bytesPerSecond?: number, failed?: boolean }>();
  const currentEstimate = estimate?.key === estimateKey ? estimate : undefined;

  useEffect(() => {
    if (!open || encodeParams == null || allRanges.length === 0) return undefined;

    const abortController = new AbortController();
    // debounce, so that flipping through the options doesn't start lots of encodes
    const timeout = setTimeout(async () => {
      try {
        const bytesPerSecond = await estimateDiscordBytesPerSecond({ ...encodeParams, settings: { quality, resolution }, ranges: allRanges, signal: abortController.signal });
        if (!abortController.signal.aborted) setEstimate({ key: estimateKey, bytesPerSecond });
      } catch (err) {
        if (abortController.signal.aborted) return;
        console.error('Failed to estimate Discord export size', err);
        setEstimate({ key: estimateKey, failed: true });
      }
    }, 300);

    return () => {
      clearTimeout(timeout);
      abortController.abort();
    };
  }, [allRanges, encodeParams, estimateKey, open, quality, resolution]);

  const limitBytes = sizeLimitMb * bytesPerMb;
  const bytesPerSecond = currentEstimate?.bytesPerSecond;
  const outputSizes = bytesPerSecond != null ? outputs.map((ranges) => getRangesDuration(ranges) * bytesPerSecond) : undefined;

  function renderEstimate() {
    if (encodeParams == null || allRanges.length === 0) return <div className={styles['muted']}>{t('Nothing to export')}</div>;
    if (currentEstimate?.failed) return <div className={styles['muted']}>{t('Could not estimate the size. The export may still work.')}</div>;
    if (outputSizes == null || bytesPerSecond == null) return <div className={styles['muted']}>{t('Estimating size…')}</div>;

    const fitsDuration = limitBytes / bytesPerSecond;

    return (
      <>
        {outputSizes.map((bytes, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className={styles['estimateRow']}>
            <div className={styles['estimateLabel']}>
              <span>
                {outputs.length > 1 ? t('Clip {{num}}', { num: i + 1 }) : t('Estimated size')}
                <span className={styles['muted']}> · {formatDuration({ seconds: getRangesDuration(outputs[i]!), shorten: true, showFraction: false })}</span>
              </span>
              <span className={styles['estimateValue']} data-over={bytes > limitBytes}>~{formatSize(bytes)}</span>
            </div>
            <SizeMeter bytes={bytes} limitBytes={limitBytes} />
          </div>
        ))}
        <div className={styles['muted']}>
          {t('At this quality, about {{duration}} fits in {{limit}} MB.', { duration: formatDuration({ seconds: fitsDuration, shorten: true, showFraction: false }), limit: sizeLimitMb })}
        </div>
      </>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content aria-describedby={undefined} style={{ width: '30em' }}>
          <Dialog.Title>{t('Export for Discord')}</Dialog.Title>

          <div className={styles['fields']}>
            <div className={styles['field']}>
              <label htmlFor={`${id}-resolution`}>{t('Resolution')}</label>
              <Select id={`${id}-resolution`} value={resolution} onChange={(e) => updateSettings({ resolution: e.target.value as DiscordExportSettings['resolution'] })}>
                {Object.entries(discordResolutions).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
              </Select>
            </div>

            <div className={styles['field']}>
              <label htmlFor={`${id}-quality`}>{t('Quality')}</label>
              <Select id={`${id}-quality`} value={quality} onChange={(e) => updateSettings({ quality: e.target.value as DiscordExportSettings['quality'] })}>
                {Object.entries(discordQualities).map(([key, { label, crf }]) => <option key={key} value={key}>{label} (CRF {crf})</option>)}
              </Select>
            </div>

            <div className={styles['field']}>
              <label htmlFor={`${id}-limit`}>{t('Size limit')}</label>
              <span>
                <TextInput
                  id={`${id}-limit`}
                  type="number"
                  min={1}
                  value={sizeLimitInput}
                  onChange={(e) => {
                    setSizeLimitInput(e.target.value);
                    const value = Number(e.target.value);
                    if (Number.isFinite(value) && value > 0) updateSettings({ sizeLimitMb: value });
                  }}
                  style={{ width: '5em', padding: '.3em .4em' }}
                />
                {' MB'}
              </span>
            </div>
          </div>

          <div className={styles['estimate']}>
            {renderEstimate()}
          </div>

          <Dialog.ButtonRow>
            <Dialog.Close asChild>
              <DialogButton>{t('Cancel')}</DialogButton>
            </Dialog.Close>
            <DialogButton primary disabled={encodeParams == null || allRanges.length === 0} onClick={onExport}>{t('Export')}</DialogButton>
          </Dialog.ButtonRow>

          <Dialog.CloseButton />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DiscordExportResult({ files, skippedPaths, sizeLimitMb }: {
  files: { path: string, size: number }[],
  skippedPaths: string[],
  sizeLimitMb: number,
}) {
  const { t } = useTranslation();
  const limitBytes = sizeLimitMb * bytesPerMb;

  return (
    <div className={styles['estimate']}>
      {files.map(({ path, size }) => (
        <div key={path} className={styles['estimateRow']}>
          <div className={styles['estimateLabel']}>
            <span>{basename(path)}</span>
            <span className={styles['estimateValue']} data-over={size > limitBytes}>{formatSize(size)}</span>
          </div>
          <SizeMeter bytes={size} limitBytes={limitBytes} />
        </div>
      ))}
      {files.some(({ size }) => size > limitBytes) && (
        <div className={styles['muted']}>{t('Over the {{limit}} MB limit. Try a lower quality or resolution.', { limit: sizeLimitMb })}</div>
      )}
      {skippedPaths.map((path) => (
        <div key={path} className={styles['muted']}>{t('Skipped {{name}} because it already exists and overwriting is disabled.', { name: basename(path) })}</div>
      ))}
    </div>
  );
}

export default memo(DiscordExportDialog);
