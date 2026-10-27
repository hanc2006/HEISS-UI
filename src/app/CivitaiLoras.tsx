import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, Plus, RotateCw, Search, X } from 'lucide-react';
import { loadLoraDetails, searchCivitaiLoras, type CivitaiLora, type CivitaiLoraDetails } from './civitai';
import { copyText } from './api';
import { CopyIcon, useCopyFeedback } from './CopyFeedback';
import { useThisComputer } from './device';
import { cn } from './format';
import { SafeImg } from './SafeImg';
import { downloadFor, useModelDownloads } from './useModelDownloads';
import type { Profile } from './types';

function sizeLabel(bytes: number) {
  if (!bytes) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const baseName = (name: string) => name.split(/[\\/]/).pop() || name;

/** 1234 → "1.2K", like Civitai. */
function countLabel(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(count);
}


type DetailsState = { loading: true } | { loading: false; error: string } | { loading: false; details: CivitaiLoraDetails };

/**
 * One LoRA, opened from the list: its pictures and how they were made, the
 * maker's trigger words and usage tips, and the same Download / Add button.
 */
function LoraCard({ row, state, action, onClose, onRetry }: {
  row: CivitaiLora;
  state: DetailsState | undefined;
  action: React.ReactNode;
  onClose: () => void;
  onRetry: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const { copied, copyWith } = useCopyFeedback();
  useEffect(() => { setIndex(0); setExpanded(false); }, [row.id]);
  const details = state && !state.loading && 'details' in state ? state.details : null;
  const images = details?.images.length ? details.images : row.preview ? [{ url: row.preview, width: null, height: null, made: null }] : [];
  const image = images[Math.min(index, images.length - 1)];
  const made = image?.made;
  const step = (by: number) => { setIndex((value) => (value + by + images.length) % images.length); setExpanded(false); };
  const copy = (value: string, key: string) => copyWith(() => copyText(value), key);
  const strength = details?.strength;
  const triggers = details?.trainedWords || [];
  // The maker's usage tips, then how the picture on show was made (when its maker shared it).
  const configuration: Array<{ label: string; values: string[]; tone?: 'strength' }> = [
    strength ? { label: 'Strength', values: [String(strength.value), ...(strength.min !== null && strength.max !== null ? [`${strength.min}–${strength.max}`] : [])], tone: 'strength' as const } : null,
    made?.sampler ? { label: 'Sampler', values: [made.sampler] } : null,
    made && made.steps !== null ? { label: 'Steps', values: [String(made.steps)] } : null,
    made && made.cfgScale !== null ? { label: 'CFG scale', values: [String(made.cfgScale)] } : null,
    made && made.seed !== null ? { label: 'Seed', values: [String(made.seed)] } : null,
    made && made.clipSkip !== null ? { label: 'Clip skip', values: [String(made.clipSkip)] } : null
  ].filter((item): item is { label: string; values: string[]; tone?: 'strength' } => Boolean(item));
  const subtitle = [row.creator, row.baseModel, row.version, row.downloads ? `${countLabel(row.downloads)} downloads` : ''].filter(Boolean).join(' · ');

  /** Label on the left, its values as badges on the right, one copy at the end for all of them. */
  const factRow = (label: string, values: string[], tone = '') => (
    <div key={label} className="civitai-fact">
      <dt>{label}</dt>
      <dd>
        <span className="civitai-fact-values">{values.map((value) => <span key={value} className={cn('civitai-badge', tone && `is-${tone}`)} title={value}>{value}</span>)}</span>
        <button type="button" className="civitai-card-icon" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copy(values.join(', '), `fact:${label}`)}><CopyIcon copied={copied === `fact:${label}`} size={12} /></button>
      </dd>
    </div>
  );

  return (
    <section className="civitai-card" aria-label={`${row.name} on Civitai`}>
      <div className="civitai-card-media">
        {image ? <SafeImg key={image.url} src={image.url} alt={made?.prompt ? `Made with this LoRA: ${made.prompt.slice(0, 120)}` : `A picture made with ${row.name}`} /> : null}
        {images.length > 1 ? (
          <>
            <button type="button" className="civitai-card-step is-prev" aria-label="Previous picture" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
            <button type="button" className="civitai-card-step is-next" aria-label="Next picture" onClick={() => step(1)}><ChevronRight size={16} /></button>
            <span className="civitai-card-count">{index + 1} / {images.length}</span>
          </>
        ) : null}
        <button type="button" className="civitai-card-close" aria-label="Close details" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="civitai-card-head">
        <div className="civitai-card-name">
          <strong className="civitai-card-title" title={row.name}>{row.name}</strong>
          {subtitle ? <span title={subtitle}>{subtitle}</span> : null}
        </div>
        {action}
      </div>

      {/* Like Civitai's details: what it is on the left, its values on the right. */}
      {triggers.length ? (
        <section className="civitai-card-group" aria-label="Triggers">
          <h4>Triggers</h4>
          <dl>{factRow('Trigger words', triggers, 'trigger')}</dl>
        </section>
      ) : null}
      {configuration.length ? (
        <section className="civitai-card-group" aria-label="Configuration">
          <h4>Configuration</h4>
          <dl>{configuration.map((item) => factRow(item.label, item.values, item.tone))}</dl>
        </section>
      ) : null}

      {state?.loading ? <div className="civitai-loading"><Loader2 size={14} className="spin" /> Reading from Civitai…</div> : null}
      {state && !state.loading && 'error' in state ? (
        <p className="civitai-card-note">{state.error} <button type="button" className="civitai-card-link" onClick={onRetry}>Try again</button></p>
      ) : null}

      {details && made?.prompt ? (
        <div className="civitai-card-prompt">
          <div className="civitai-card-prompt-head">
            <span>Prompt</span>
            <button type="button" className="civitai-card-icon" aria-label="Copy prompt" onClick={() => copy(made.prompt, 'prompt')}><CopyIcon copied={copied === 'prompt'} size={13} /></button>
          </div>
          <p className={cn(!expanded && 'is-clamped')}>{made.prompt}</p>
          {made.prompt.length > 180 ? <button type="button" className="civitai-card-link" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show less' : 'Show more'}</button> : null}
          {made.negativePrompt && expanded ? <p className="civitai-card-negative"><em>Negative</em> {made.negativePrompt}</p> : null}
        </div>
      ) : details && image ? <p className="civitai-card-note">No prompt shared for this picture.</p> : null}

      <a className="civitai-card-open" href={details?.page || row.page} target="_blank" rel="noreferrer noopener">Open on Civitai <ExternalLink size={12} /></a>
    </section>
  );
}

/**
 * Civitai's LoRAs for the model in use, inside the Add LoRAs picker. Only
 * LoRAs made for the model's base show (the server asks Civitai for those);
 * a row opens its card above the list. Download puts one in ComfyUI's loras
 * folder through the same queue as every other model file, checked against
 * Civitai's SHA-256, and Add then adds it.
 */
export function CivitaiLoras({ profile, options, current, remaining, onAdd, onLibraryChanged, onCardChange }: {
  profile: Profile | null;
  /** LoRAs on this computer, as ComfyUI lists them. */
  options: string[];
  current: string[];
  remaining: number;
  onAdd: (names: string[]) => void;
  /** Ask ComfyUI for its LoRAs again (after a download lands). */
  onLibraryChanged: () => void;
  /** Whether a card is open, so the picker can give it room. */
  onCardChange?: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<CivitaiLora[]>([]);
  const [cursor, setCursor] = useState('');
  const [state, setState] = useState<{ loading: boolean; error: string; unsupported: boolean; bases: string[]; site: string }>({ loading: true, error: '', unsupported: false, bases: [], site: '' });
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState('');
  const [details, setDetails] = useState<Record<number, DetailsState>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const canDownload = useThisComputer();
  const family = profile?.family || '';
  const model = profile?.model || '';

  const downloads = useModelDownloads({ onDone: (item) => { if (item.id.startsWith('civitai:')) onLibraryChanged(); } });
  const installed = useMemo(() => {
    const byFile = new Map<string, string>();
    for (const name of options) byFile.set(baseName(name).toLowerCase(), name);
    return byFile;
  }, [options]);
  const openRow = rows.find((row) => row.id === openId) || null;
  useEffect(() => { onCardChange?.(Boolean(openRow)); }, [onCardChange, openRow]);

  const load = async (text: string, after = '') => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((value) => ({ ...value, loading: true, error: '' }));
    try {
      const result = await searchCivitaiLoras({ query: text, family, model, cursor: after }, controller.signal);
      if (controller.signal.aborted) return;
      setRows((list) => (after ? [...list, ...result.rows.filter((row) => !list.some((item) => item.id === row.id))] : result.rows));
      setCursor(result.nextCursor || '');
      setState({ loading: false, error: '', unsupported: Boolean(result.unsupported), bases: result.bases || [], site: result.site || '' });
    } catch (error) {
      if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
      setState((value) => ({ ...value, loading: false, error: error instanceof Error ? error.message : 'Civitai couldn’t be reached.' }));
    }
  };

  // Typing searches after a short pause; an empty box shows the most downloaded for this model.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(query.trim()); }, query ? 350 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, family, model]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const fetchDetails = async (row: CivitaiLora) => {
    setDetails((value) => ({ ...value, [row.versionId]: { loading: true } }));
    try {
      const result = await loadLoraDetails(row.versionId);
      setDetails((value) => ({ ...value, [row.versionId]: { loading: false, details: result } }));
    } catch (error) {
      setDetails((value) => ({ ...value, [row.versionId]: { loading: false, error: error instanceof Error ? error.message : 'Civitai couldn’t be reached.' } }));
    }
  };
  // The card takes the list's place; closing it brings the list back where it was.
  const listScroll = useRef(0);
  const open = (row: CivitaiLora) => {
    listScroll.current = listRef.current?.scrollTop || 0;
    setOpenId(row.id);
    const known = details[row.versionId];
    if (!known || (!known.loading && 'error' in known)) void fetchDetails(row);
  };
  const close = () => setOpenId('');
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = openId ? 0 : listScroll.current;
  }, [openId]);

  const download = async (row: CivitaiLora) => {
    setFailed(({ [row.id]: _, ...rest }) => rest);
    try {
      await downloads.start(row.id);
    } catch (error) {
      setFailed((value) => ({ ...value, [row.id]: error instanceof Error ? error.message : 'The download didn’t start.' }));
    }
  };

  const action = (row: CivitaiLora) => {
    const local = installed.get(row.file.toLowerCase());
    if (local) {
      if (current.includes(local)) return <em>Added</em>;
      return <button type="button" className="btn civitai-action" disabled={remaining <= 0} onClick={(event) => { event.stopPropagation(); onAdd([local]); }}><Plus size={13} /> Add</button>;
    }
    const progress = downloadFor(downloads.state, row.file);
    if (progress && (progress.status === 'downloading' || progress.status === 'queued')) {
      const percent = progress.totalBytes ? Math.min(99, Math.floor((progress.receivedBytes / progress.totalBytes) * 100)) : 0;
      return <em className="civitai-progress"><Loader2 size={12} className="spin" /> {progress.verifying ? 'Checking' : progress.status === 'queued' ? 'Waiting' : `${percent}%`}</em>;
    }
    if (progress?.status === 'done') return <em className="civitai-progress"><Loader2 size={12} className="spin" /> Adding</em>;
    if (!canDownload) return <em title="Downloads happen on the computer running HEISS UI, or a device it trusts with admin.">Owner only</em>;
    if (progress?.status === 'error' || failed[row.id]) {
      return <button type="button" className="btn civitai-action" onClick={(event) => { event.stopPropagation(); void download(row); }}><RotateCw size={13} /> Retry</button>;
    }
    return <button type="button" className="btn civitai-action" onClick={(event) => { event.stopPropagation(); void download(row); }} title={row.file}><Download size={13} /> {sizeLabel(row.bytes) || 'Get'}</button>;
  };

  const errorOf = (row: CivitaiLora) => failed[row.id] || (downloadFor(downloads.state, row.file)?.status === 'error' ? downloadFor(downloads.state, row.file)?.error : '');

  return (
    <>
      <label className="lora-picker-search">
        <Search size={14} />
        <input
          ref={inputRef}
          className="is-framed"
          value={query}
          placeholder={state.bases.length ? `Search Civitai for ${state.bases[0]} LoRAs` : 'Search Civitai'}
          aria-label="Search Civitai LoRAs"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            if (openId) { event.preventDefault(); event.stopPropagation(); close(); return; }
            if (query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
          }}
        />
        {query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus(); }}><X size={13} /></button> : null}
      </label>
      <div className="lora-picker-list civitai-list" ref={listRef} role="list" aria-busy={state.loading}>
        {openRow ? <LoraCard row={openRow} state={details[openRow.versionId]} action={action(openRow)} onClose={close} onRetry={() => fetchDetails(openRow)} /> : null}
        {openRow ? null : state.unsupported ? (
          <div className="lora-empty"><p>Civitai has no LoRA category for this model, so nothing here would be sure to fit.</p></div>
        ) : null}
        {!openRow && state.error ? (
          <div className="lora-empty is-unavailable"><AlertTriangle size={16} /><p>{state.error}</p><button type="button" className="btn" onClick={() => load(query.trim())}><RotateCw size={13} /> Try again</button></div>
        ) : null}
        {!openRow && !state.unsupported && !state.error ? (
          <div className="lora-picker-section">
            {rows.map((row) => {
              const error = errorOf(row);
              return (
                <div
                  key={row.id}
                  className="lora-option civitai-row"
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${row.name}, show details`}
                  onClick={() => open(row)}
                  onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(row); } }}
                >
                  <span className="civitai-thumb" aria-hidden="true"><SafeImg src={row.preview} alt="" loading="lazy" referrerPolicy="no-referrer" /></span>
                  <span className="lora-option-copy">
                    <strong title={row.name}>{row.name}</strong>
                    <span>{row.creator || row.version}</span>
                    {error ? <span className="civitai-error">{error}</span> : null}
                  </span>
                  {action(row)}
                </div>
              );
            })}
            {!rows.length && !state.loading ? <div className="lora-empty"><p>{query.trim() ? `No LoRAs on Civitai match “${query.trim()}” for this model.` : 'Civitai has no LoRAs for this model yet.'}</p></div> : null}
            {state.loading ? <div className="civitai-loading"><Loader2 size={14} className="spin" /> Asking Civitai…</div> : null}
            {cursor && !state.loading ? <button type="button" className="btn is-ghost civitai-more" onClick={() => load(query.trim(), cursor)}>Show more</button> : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
