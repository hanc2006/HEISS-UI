import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const facts = made ? [
    made.seed !== null ? `Seed ${made.seed}` : '', made.steps !== null ? `${made.steps} steps` : '',
    made.cfgScale !== null ? `CFG ${made.cfgScale}` : '', made.sampler, made.clipSkip !== null ? `Clip skip ${made.clipSkip}` : ''
  ].filter(Boolean) : [];

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
        <div className="civitai-card-title">
          <strong title={row.name}>{row.name}</strong>
          <span>{[row.creator, row.baseModel, row.version].filter(Boolean).join(' · ')}</span>
        </div>
        {action}
      </div>

      {state?.loading ? <div className="civitai-loading"><Loader2 size={14} className="spin" /> Reading from Civitai…</div> : null}
      {state && !state.loading && 'error' in state ? (
        <p className="civitai-card-note">{state.error} <button type="button" className="civitai-card-link" onClick={onRetry}>Try again</button></p>
      ) : null}

      {details ? (
        <dl className="civitai-card-facts">
          {strength ? (
            <div><dt>Usage tips</dt><dd><span className="civitai-chip">Strength {strength.value}{strength.min !== null && strength.max !== null ? ` · ${strength.min}–${strength.max}` : ''}</span></dd></div>
          ) : null}
          {details.trainedWords.length ? (
            <div>
              <dt>Trigger words</dt>
              <dd>
                {details.trainedWords.map((word) => (
                  <button key={word} type="button" className="civitai-chip is-trigger" title="Copy" onClick={() => copy(word, `word:${word}`)}>
                    <span>{word}</span><CopyIcon copied={copied === `word:${word}`} size={12} />
                  </button>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
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
          {facts.length ? <div className="civitai-card-meta">{facts.map((fact) => <span key={fact} className="civitai-chip">{fact}</span>)}</div> : null}
        </div>
      ) : details && image ? <p className="civitai-card-note">No prompt shared for this picture.</p> : null}

      <a className="civitai-card-open" href={details?.page || row.page} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} /> Open on Civitai</a>
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
  const open = (row: CivitaiLora) => {
    if (openId === row.id) { setOpenId(''); return; }
    setOpenId(row.id);
    const known = details[row.versionId];
    if (!known || (!known.loading && 'error' in known)) void fetchDetails(row);
    listRef.current?.scrollTo({ top: 0 });
  };

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
            if (openId) { event.preventDefault(); event.stopPropagation(); setOpenId(''); return; }
            if (query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
          }}
        />
        {query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus(); }}><X size={13} /></button> : null}
      </label>
      <div className="lora-picker-list civitai-list" ref={listRef} role="list" aria-busy={state.loading}>
        {openRow ? <LoraCard row={openRow} state={details[openRow.versionId]} action={action(openRow)} onClose={() => setOpenId('')} onRetry={() => fetchDetails(openRow)} /> : null}
        {state.unsupported ? (
          <div className="lora-empty"><p>Civitai has no LoRA category for this model, so nothing here would be sure to fit.</p></div>
        ) : null}
        {state.error ? (
          <div className="lora-empty is-unavailable"><AlertTriangle size={16} /><p>{state.error}</p><button type="button" className="btn" onClick={() => load(query.trim())}><RotateCw size={13} /> Try again</button></div>
        ) : null}
        {!state.unsupported && !state.error ? (
          <div className="lora-picker-section">
            <div className="lora-picker-heading is-static">
              <span>{query.trim() ? 'Results' : 'Most downloaded'}{state.bases.length ? ` · ${state.bases.slice(0, 3).join(', ')}${state.bases.length > 3 ? '…' : ''}` : ''}</span>
              {state.site ? <em>{state.site}</em> : null}
            </div>
            {rows.map((row) => {
              const error = errorOf(row);
              return (
                <div
                  key={row.id}
                  className={cn('lora-option civitai-row', row.id === openId && 'is-open')}
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${row.name}, show details`}
                  onClick={() => open(row)}
                  onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(row); } }}
                >
                  <span className="civitai-thumb" aria-hidden="true"><SafeImg src={row.preview} alt="" loading="lazy" referrerPolicy="no-referrer" /></span>
                  <span className="lora-option-copy">
                    <strong title={row.name}>{row.name}</strong>
                    <span>{[row.creator, row.baseModel, row.version].filter(Boolean).join(' · ')}</span>
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
