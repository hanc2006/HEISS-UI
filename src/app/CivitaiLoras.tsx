import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { loadLoraDetails, searchCivitaiLoras, type CivitaiLora, type CivitaiLoraDetails } from './civitai';
import { copyText } from './api';
import { CopyIcon, useCopyFeedback } from './CopyFeedback';
import { cn } from './format';
import { SafeImg } from './SafeImg';
import type { Profile } from './types';

export function sizeLabel(bytes = 0) {
  if (!bytes) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 1234 → "1.2K", like Civitai. */
export function countLabel(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(count);
}

export type DetailsState = { loading: true } | { loading: false; error: string } | { loading: false; details: CivitaiLoraDetails };

export type CivitaiSearchState = { loading: boolean; error: string; unsupported: boolean; bases: string[]; site: string };

/**
 * Civitai's LoRAs for the model in use: only LoRAs made for the model's base
 * (the server asks Civitai for those). Typing searches after a short pause;
 * an empty box shows the most downloaded. Nothing is asked until `enabled`.
 */
export function useCivitaiLoras({ enabled, query, profile }: { enabled: boolean; query: string; profile: Profile | null }) {
  const [rows, setRows] = useState<CivitaiLora[]>([]);
  const [cursor, setCursor] = useState('');
  const [state, setState] = useState<CivitaiSearchState>({ loading: true, error: '', unsupported: false, bases: [], site: '' });
  const [details, setDetails] = useState<Record<number, DetailsState>>({});
  const request = useRef<AbortController | null>(null);
  const family = profile?.family || '';
  const model = profile?.model || '';

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

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => { void load(query.trim()); }, query ? 350 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, query, family, model]);
  useEffect(() => () => request.current?.abort(), []);

  const fetchDetails = async (row: CivitaiLora) => {
    setDetails((value) => ({ ...value, [row.versionId]: { loading: true } }));
    try {
      const result = await loadLoraDetails(row.versionId);
      setDetails((value) => ({ ...value, [row.versionId]: { loading: false, details: result } }));
    } catch (error) {
      setDetails((value) => ({ ...value, [row.versionId]: { loading: false, error: error instanceof Error ? error.message : 'Civitai couldn’t be reached.' } }));
    }
  };
  /** Details for a row, asked once (again after a failure). */
  const ensureDetails = (row: CivitaiLora) => {
    const known = details[row.versionId];
    if (!known || (!known.loading && 'error' in known)) void fetchDetails(row);
  };

  return {
    rows, cursor, state, details, ensureDetails,
    retryDetails: (row: CivitaiLora) => fetchDetails(row),
    retry: () => load(query.trim()),
    loadMore: () => load(query.trim(), cursor)
  };
}

/**
 * One Civitai LoRA in the browser's detail panel: its pictures and how they
 * were made, the maker's trigger words and usage tips, and `action` (Download,
 * Add, In stack) under the name.
 */
export function CivitaiDetail({ row, state, action, onRetry }: {
  row: CivitaiLora;
  state: DetailsState | undefined;
  action: React.ReactNode;
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
  const subtitle = [row.creator, row.baseModel, row.version, sizeLabel(row.bytes), row.downloads ? `${countLabel(row.downloads)} downloads` : ''].filter(Boolean).join(' · ');

  return (
    <section className="civitai-card is-detail" aria-label={`${row.name} on Civitai`}>
      <div className="civitai-card-media">
        {image ? <SafeImg key={image.url} src={image.url} referrerPolicy="no-referrer" alt={made?.prompt ? `Made with this LoRA: ${made.prompt.slice(0, 120)}` : `A picture made with ${row.name}`} /> : null}
        {images.length > 1 ? (
          <>
            <button type="button" className="civitai-card-step is-prev" aria-label="Previous picture" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
            <button type="button" className="civitai-card-step is-next" aria-label="Next picture" onClick={() => step(1)}><ChevronRight size={16} /></button>
            <span className="civitai-card-count">{index + 1} / {images.length}</span>
          </>
        ) : null}
      </div>

      <div className="wf-detail-head"><h3>{row.name}</h3></div>
      {subtitle ? <p className="wf-detail-meta">{subtitle}</p> : null}
      {action}

      {triggers.length || configuration.length ? (
        <dl className="civitai-card-facts">
          {triggers.length ? <FactRow label="Trigger words" values={triggers} tone="trigger" copied={copied} onCopy={copy} /> : null}
          {configuration.map((item) => <FactRow key={item.label} label={item.label} values={item.values} tone={item.tone} copied={copied} onCopy={copy} />)}
        </dl>
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

/** Label on the left, its values as badges on the right; each badge copies its own value. */
export function FactRow({ label, values, tone = '', copied, onCopy }: { label: string; values: string[]; tone?: string; copied: string | null; onCopy: (value: string, key: string) => void }) {
  return (
    <div className="civitai-fact">
      <dt>{label}</dt>
      <dd>
        {values.map((value) => (
          <button key={value} type="button" className={cn('civitai-badge', tone && `is-${tone}`)} title={`Copy ${value}`} aria-label={`Copy ${label.toLowerCase()}: ${value}`} onClick={() => onCopy(value, `${label}:${value}`)}>
            <span className="civitai-badge-text">{value}</span>
            <CopyIcon copied={copied === `${label}:${value}`} size={11} />
          </button>
        ))}
      </dd>
    </div>
  );
}
