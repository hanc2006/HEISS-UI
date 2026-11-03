import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Heart } from 'lucide-react';
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
 * out the same either way. A picture card: its pictures with the LoRA's name
 * over them and the heart in the corner, and under them the model it was
 * made for, its size and the split button (`action`). Then only what helps
 * using it: trigger words, usage tips, how the picture on show was made, and
 * its prompt. While Civitai's answer is on its way, a skeleton holds its place.
 */
export function LoraDetail({ id, name, model = '', otherModel = false, size = 0, previews = [], details = null, loading = false, error = '', onRetry, triggers: ownTriggers = [], action, favorite, note }: {
  /** Which LoRA: the pictures start over when it changes. */
  id: string;
  name: string;
  model?: string;
  /** Made for another model than the one in use: its badge says so. */
  otherModel?: boolean;
  size?: number;
  /** Pictures to show until (or unless) Civitai's arrive. */
  previews?: string[];
  details?: CivitaiLoraDetails | null;
  /** Civitai's answer is on its way. */
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  /** Trigger words the file itself names; Civitai's are added to them. */
  triggers?: string[];
  /** The split button. */
  action: React.ReactNode;
  favorite?: { on: boolean; toggle: () => void };
  note?: React.ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const { copied, copyWith } = useCopyFeedback();
  useEffect(() => { setIndex(0); setExpanded(false); }, [id]);
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

  return (
    <section className="lb-detail" aria-label={name}>
      <div className="lb-hero">
        <div className="lb-hero-media">
          {image ? <Media key={image.url} still={image.url} video={'video' in image ? image.video : undefined} alt={made?.prompt ? `Made with this LoRA: ${made.prompt.slice(0, 120)}` : `A picture made with ${name}`} />
            : loading ? <span className="lb-skeleton is-media" aria-hidden="true" /> : <LoraThumb label="" plain />}
          <h3 className="lb-hero-name">{name}</h3>
          {favorite ? (
            <button type="button" className={cn('lb-hero-heart', favorite.on && 'active')} aria-pressed={favorite.on} aria-label={favorite.on ? 'Remove from favorites' : 'Add to favorites'} onClick={favorite.toggle}>
              <Heart size={16} fill={favorite.on ? 'currentColor' : 'none'} />
            </button>
          ) : null}
          {images.length > 1 ? (
            <>
              <button type="button" className="civitai-card-step is-prev" aria-label="Previous picture" onClick={() => show(index - 1)}><ChevronLeft size={16} /></button>
              <button type="button" className="civitai-card-step is-next" aria-label="Next picture" onClick={() => show(index + 1)}><ChevronRight size={16} /></button>
              <span className="civitai-card-count">{index + 1} / {images.length}</span>
            </>
          ) : null}
        </div>
        <div className="lb-hero-foot">
          <div className="lb-hero-facts">
            <strong className={cn(otherModel && 'is-other')} title={otherModel ? `Made for ${model}` : undefined}>{model || 'LoRA'}</strong>
            <span>{bytes ? sizeLabel(bytes) : loading ? <i className="lb-skeleton is-text" aria-hidden="true" /> : 'Size unknown'}</span>
          </div>
          {action}
        </div>
      </div>

      {note}

      {loading && !details ? (
        <div className="lb-skeleton-facts" aria-label="Reading from Civitai" role="status">
          {[0, 1, 2, 3].map((n) => <div key={n}><i className="lb-skeleton is-label" /><i className="lb-skeleton is-value" style={{ width: `${[38, 24, 30, 18][n]}%` }} /></div>)}
          <i className="lb-skeleton is-block" />
        </div>
      ) : null}

      {(triggers.length || configuration.length) && !(loading && !details) ? (
        <dl className="civitai-card-facts">
          {triggers.length ? <FactRow label="Trigger words" values={triggers} tone="trigger" copied={copied} onCopy={copy} /> : null}
          {configuration.map((item) => <FactRow key={item.label} label={item.label} values={item.values} tone={item.tone} copied={copied} onCopy={copy} />)}
        </dl>
      ) : null}

      {error ? <p className="civitai-card-note">{error} {onRetry ? <button type="button" className="civitai-card-link" onClick={onRetry}>Try again</button> : null}</p> : null}

      {made?.prompt ? (
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
    </section>
  );
}


/**
 * One of a LoRA's pictures: a video plays (muted, looping) over its first
 * frame; if the clip won't load, the frame stays.
 */
function Media({ still, video, alt }: { still: string; video?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!video || failed) return <SafeImg src={still} referrerPolicy="no-referrer" alt={alt} />;
  return <video src={video} poster={still} aria-label={alt} autoPlay muted loop playsInline preload="metadata" onError={() => setFailed(true)} />;
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
