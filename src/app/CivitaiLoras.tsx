import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Heart, Loader2 } from 'lucide-react';
import { loadLoraDetails, searchCivitaiLoras, type CivitaiLora, type CivitaiLoraDetails } from './civitai';
import { copyText } from './api';
import { CopyIcon, useCopyFeedback } from './CopyFeedback';
import { cn } from './format';
import { SafeImg } from './SafeImg';
import { LoraThumb } from './LoraThumb';
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

  const fetchDetails = async (versionId: number) => {
    setDetails((value) => ({ ...value, [versionId]: { loading: true } }));
    try {
      const result = await loadLoraDetails(versionId);
      setDetails((value) => ({ ...value, [versionId]: { loading: false, details: result } }));
    } catch (error) {
      setDetails((value) => ({ ...value, [versionId]: { loading: false, error: error instanceof Error ? error.message : 'Civitai couldn’t be reached.' } }));
    }
  };
  /** A version's details (a Civitai row's, or a local LoRA Civitai knows), asked once (again after a failure). */
  const ensureDetails = (versionId: number) => {
    const known = details[versionId];
    if (!known || (!known.loading && 'error' in known)) void fetchDetails(versionId);
  };

  return {
    rows, cursor, state, details, ensureDetails,
    retryDetails: (versionId: number) => fetchDetails(versionId),
    retry: () => load(query.trim()),
    loadMore: () => load(query.trim(), cursor)
  };
}

/**
 * One LoRA in the browser's detail panel, from this computer or Civitai, laid
 * out the same either way: its pictures (a gallery), its name with the model
 * it was made for and its size as badges, `action` (Add, Download, In stack),
 * then Civitai's trigger words, usage tips, how the picture on show was made,
 * and the link to its page. A LoRA Civitai doesn't know shows what its file says.
 */
export function LoraDetail({ id, name, fileName = '', model = '', otherModel = false, size = 0, version = '', byline = '', previews = [], state, triggers: ownTriggers = [], action, favorite, note, page = '', onRetry }: {
  /** Which LoRA: the gallery starts over when it changes. */
  id: string;
  name: string;
  /** The file's own name, when it differs from the name shown. */
  fileName?: string;
  model?: string;
  /** Made for another model than the one in use: its badge says so. */
  otherModel?: boolean;
  size?: number;
  version?: string;
  /** Who made it, how often it was downloaded. */
  byline?: string;
  /** Pictures to show until (or unless) Civitai's arrive. */
  previews?: string[];
  state?: DetailsState;
  /** Trigger words the file itself names; Civitai's are added to them. */
  triggers?: string[];
  action: React.ReactNode;
  favorite?: { on: boolean; toggle: () => void };
  note?: React.ReactNode;
  page?: string;
  onRetry?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const { copied, copyWith } = useCopyFeedback();
  useEffect(() => { setIndex(0); setExpanded(false); }, [id]);
  const details = state && !state.loading && 'details' in state ? state.details : null;
  const images = details?.images.length ? details.images : previews.filter(Boolean).map((url) => ({ url, width: null, height: null, made: null }));
  const image = images[Math.min(index, images.length - 1)];
  const made = image?.made;
  const show = (next: number) => { setIndex((next + images.length) % images.length); setExpanded(false); };
  const copy = (value: string, key: string) => copyWith(() => copyText(value), key);
  const strength = details?.strength;
  const triggers = [...new Set([...ownTriggers, ...(details?.trainedWords || [])])];
  // The maker's usage tips, then how the picture on show was made (when its maker shared it).
  const configuration: Array<{ label: string; values: string[]; tone?: 'strength' }> = [
    strength ? { label: 'Strength', values: [String(strength.value), ...(strength.min !== null && strength.max !== null ? [`${strength.min}–${strength.max}`] : [])], tone: 'strength' as const } : null,
    made?.sampler ? { label: 'Sampler', values: [made.sampler] } : null,
    made && made.steps !== null ? { label: 'Steps', values: [String(made.steps)] } : null,
    made && made.cfgScale !== null ? { label: 'CFG scale', values: [String(made.cfgScale)] } : null,
    made && made.seed !== null ? { label: 'Seed', values: [String(made.seed)] } : null,
    made && made.clipSkip !== null ? { label: 'Clip skip', values: [String(made.clipSkip)] } : null
  ].filter((item): item is { label: string; values: string[]; tone?: 'strength' } => Boolean(item));
  const bytes = size || details?.bytes || 0;
  const link = details?.page || page;

  return (
    <section className="civitai-card is-detail" aria-label={name}>
      <div className="civitai-card-media">
        {image ? <SafeImg key={image.url} src={image.url} referrerPolicy="no-referrer" alt={made?.prompt ? `Made with this LoRA: ${made.prompt.slice(0, 120)}` : `A picture made with ${name}`} /> : <LoraThumb label={model || 'LoRA'} />}
        {images.length > 1 ? (
          <>
            <button type="button" className="civitai-card-step is-prev" aria-label="Previous picture" onClick={() => show(index - 1)}><ChevronLeft size={16} /></button>
            <button type="button" className="civitai-card-step is-next" aria-label="Next picture" onClick={() => show(index + 1)}><ChevronRight size={16} /></button>
            <span className="civitai-card-count">{index + 1} / {images.length}</span>
          </>
        ) : null}
      </div>
      {images.length > 1 ? (
        <div className="lb-gallery" role="tablist" aria-label="Pictures made with this LoRA">
          {images.map((item, n) => (
            <button key={item.url} type="button" role="tab" aria-selected={n === index} aria-label={`Picture ${n + 1}`} className={cn(n === index && 'active')} onClick={() => show(n)}>
              <SafeImg src={item.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
            </button>
          ))}
        </div>
      ) : null}

      <div className="wf-detail-head">
        <h3>{name}</h3>
        {favorite ? (
          <button type="button" className={cn('wf-heart', favorite.on && 'active')} aria-pressed={favorite.on} aria-label={favorite.on ? 'Remove from favorites' : 'Add to favorites'} onClick={favorite.toggle}>
            <Heart size={16} fill={favorite.on ? 'currentColor' : 'none'} />
          </button>
        ) : null}
      </div>
      <div className="lb-badges">
        {model ? <em className={cn('lb-model', otherModel && 'is-other')} title={otherModel ? `Made for ${model}` : undefined}>{model}</em> : null}
        {bytes ? <span>{sizeLabel(bytes)}</span> : null}
        {version ? <span>{version}</span> : null}
      </div>
      {byline || fileName ? <p className="wf-detail-meta lb-byline">{[byline, fileName].filter(Boolean).join(' · ')}</p> : null}
      {note}
      {action}

      {triggers.length || configuration.length ? (
        <dl className="civitai-card-facts">
          {triggers.length ? <FactRow label="Trigger words" values={triggers} tone="trigger" copied={copied} onCopy={copy} /> : null}
          {configuration.map((item) => <FactRow key={item.label} label={item.label} values={item.values} tone={item.tone} copied={copied} onCopy={copy} />)}
        </dl>
      ) : null}

      {state?.loading ? <div className="civitai-loading"><Loader2 size={14} className="spin" /> Reading from Civitai…</div> : null}
      {state && !state.loading && 'error' in state ? (
        <p className="civitai-card-note">{state.error} {onRetry ? <button type="button" className="civitai-card-link" onClick={onRetry}>Try again</button> : null}</p>
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

      {link ? <a className="civitai-card-open" href={link} target="_blank" rel="noreferrer noopener">Open on Civitai <ExternalLink size={12} /></a> : null}
    </section>
  );
}

/** A Civitai row's byline: who made it, how often it was downloaded. */
export function civitaiByline(row: CivitaiLora) {
  return [row.creator, row.downloads ? `${countLabel(row.downloads)} downloads` : ''].filter(Boolean).join(' · ');
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
