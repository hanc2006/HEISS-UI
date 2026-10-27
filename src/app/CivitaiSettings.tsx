import React from 'react';
import { loadCivitaiStatus, saveCivitaiSettings, type CivitaiStatus } from './civitai';
import { Group, Row, Switch } from './SettingsControls';
import type { ShowToast } from './toast';

/**
 * Civitai, under the Hugging Face token: an API key for downloads that need
 * one, and whether mature models show. Since April 2026 those live on their
 * own site (civitai.red), so the switch also moves searches and downloads there.
 */
export function CivitaiSettings({ showToast }: { showToast: ShowToast }) {
  const [status, setStatus] = React.useState<CivitaiStatus | null>(null);
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState('');
  React.useEffect(() => {
    loadCivitaiStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const save = async (body: { token?: string; mature?: boolean }, done: string) => {
    setBusy(true);
    setNote('');
    try {
      const next = await saveCivitaiSettings(body);
      setStatus(next);
      if ('token' in body) setValue('');
      if (body.token === '' && next.source === 'environment') showToast(`Removed from Settings. ${next.key} in your environment still applies.`, 'warning');
      else showToast(done, body.token === '' ? 'removed' : 'success');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Couldn’t save that.');
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const description = note || (status.source === 'environment'
    ? `Set by ${status.key} in your environment (${status.hint}). Only sent to civitai.com and civitai.red.`
    : status.set
      ? `Saved on this computer (${status.hint}). Only sent to civitai.com and civitai.red.`
      : 'For Civitai downloads that need a sign-in. Create a key on Civitai under Account settings › API Keys.');
  return (
    <Group>
      <Row label="Civitai API key" description={description}>
        {status.editable ? (
          <form className="set-address" onSubmit={(event) => { event.preventDefault(); if (value.trim()) save({ token: value.trim() }, 'Civitai key saved'); }}>
            <input
              className="set-path-input"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={status.set ? 'New key' : 'API key'}
              aria-label="Civitai API key"
              spellCheck={false}
              autoComplete="off"
            />
            {status.set && !value ? <button type="button" className="btn" disabled={busy} onClick={() => save({ token: '' }, 'Civitai key removed')}>Remove</button> : null}
            <button type="submit" className="btn is-primary" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save'}</button>
          </form>
        ) : null}
      </Row>
      <Row label="Show mature content" description={`Includes NSFW models in Civitai search and downloads them from civitai.red. Now using ${status.site}.`}>
        <Switch label="Show mature content" checked={status.mature} disabled={busy} onChange={(mature) => save({ mature }, mature ? 'Mature content shown, from civitai.red' : 'Mature content hidden')} />
      </Row>
    </Group>
  );
}
