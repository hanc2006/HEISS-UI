import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Download, Heart, Layers, Loader2, Plus, RotateCw, Search, X } from 'lucide-react';
import { Modal } from './Modal';
import { Segmented } from './SettingsControls';
import { cn } from './format';
import { copyText } from './api';
import { useCopyFeedback } from './CopyFeedback';
import { useThisComputer } from './device';
import { rankedLoras, type FitOf } from './loras';
import { loadCivitaiStatus, type CivitaiLora } from './civitai';
import { CivitaiDetail, FactRow, countLabel, sizeLabel, useCivitaiLoras } from './CivitaiLoras';
import { LoraThumb, loraPreviewUrl } from './LoraThumb';
import { downloadFor, useModelDownloads } from './useModelDownloads';
import { scrollSideways, useWheelRef } from './wheel';
import type { LoraInfo } from './useLoraInfo';
import type { Profile } from './types';

export type LoraSource = 'local' | 'civitai';
type LocalFilter = 'all' | 'stack' | 'favorites' | 'recent';

export function loraFileName(name: string) {
  const parts = name.split(/[\\/]/);
  return (parts[parts.length - 1] || name).replace(/\.(safetensors|ckpt|pt|bin)$/i, '');
}

export function loraFolder(name: string) {
  return name.split(/[\\/]/).filter(Boolean).slice(0, -1).join(' / ');
}

const baseName = (name: string) => name.split(/[\\/]/).pop() || name;

/**
 * The LoRA browser: the one place LoRAs are chosen, laid out like the workflow
 * gallery. Cards on the left (this computer's LoRAs, or Civitai's for this
 * model), the selected one's details on the right with one button that says
 * what it will do: Add to stack, Download and add, or In stack (with Remove).
 * It stays open after adding, so several go in one after another; the sidebar
 * then tunes them (on/off, strength, order).
 */
export function LoraBrowser({ open, onClose, startOn, focus, familyLabel = '', options, profile, infos, fitOf, current, cap, favorites, recents, onToggleFavorite, onAdd, onRemove, onLibraryChanged }: {
  open: boolean;
  onClose: () => void;
  startOn: LoraSource;
  /** A LoRA to select on opening (one clicked in the sidebar). */
  focus: string;
  /** The model's name as people know it. */
  familyLabel?: string;
  options: string[];
  profile: Profile | null;
  infos: Record<string, LoraInfo>;
  fitOf: FitOf;
  /** The LoRAs in the stack now. */
  current: string[];
  cap: number;
  favorites: string[];
  recents: string[];
  onToggleFavorite: (name: string) => void;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onLibraryChanged: () => void;
}) {
  const [source, setSource] = useState<LoraSource>(startOn);
  const [filter, setFilter] = useState<LocalFilter>('all');
  const [query, setQuery] = useState('');
  const [civitaiQuery, setCivitaiQuery] = useState('');
  const [selected, setSelected] = useState(focus);
  const [civitaiSelected, setCivitaiSelected] = useState('');
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(Boolean(focus));
  const [mature, setMature] = useState(false);
  const [failed, setFailed] = useState<Record<string, string>>({});
  // Civitai files to add to the stack as soon as their download lands.
  const [addWhenReady, setAddWhenReady] = useState<string[]>([]);
  const filtersWheelRef = useWheelRef<HTMLDivElement>(scrollSideways);
  const canDownload = useThisComputer();
  const family = profile?.familyName || familyLabel || profile?.family || '';
  const full = current.length >= cap;
  const { copied, copyWith } = useCopyFeedback();

  useEffect(() => {
    let live = true;
    loadCivitaiStatus().then((status) => { if (live) setMature(status.mature); }).catch(() => {});
    return () => { live = false; };
  }, []);

  /* ---------------------------------------------------------- This computer */
  const available = useMemo(() => new Set(options), [options]);
  const counts = {
    all: options.length,
    stack: current.filter((name) => available.has(name)).length,
    favorites: favorites.filter((name) => available.has(name)).length,
    recent: recents.filter((name) => available.has(name)).length
  };
  const localItems = useMemo(() => {
    const ranked = rankedLoras(options, profile, query, fitOf);
    if (filter === 'stack') return ranked.filter((name) => current.includes(name));
    if (filter === 'favorites') return ranked.filter((name) => favorites.includes(name));
    if (filter === 'recent') return recents.filter((name) => available.has(name) && ranked.includes(name));
    return ranked;
  }, [available, current, favorites, filter, fitOf, options, profile, query, recents]);
  const localSelected = localItems.includes(selected) ? selected : localItems[0] || '';

  /* --------------------------------------------------------------- Civitai */
  const civitai = useCivitaiLoras({ enabled: open && source === 'civitai', query: civitaiQuery, profile });
  const installed = useMemo(() => {
    const byFile = new Map<string, string>();
    for (const name of options) byFile.set(baseName(name).toLowerCase(), name);
    return byFile;
  }, [options]);
  const downloads = useModelDownloads({ onDone: (item) => { if (item.id.startsWith('civitai:')) onLibraryChanged(); } });
  const civitaiRow = civitai.rows.find((row) => row.id === civitaiSelected) || civitai.rows[0] || null;
  useEffect(() => { if (source === 'civitai' && civitaiRow) civitai.ensureDetails(civitaiRow); }, [source, civitaiRow?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A download asked to be added: add it once ComfyUI lists it, if the stack still has room.
  useEffect(() => {
    if (!addWhenReady.length) return;
    const landed = addWhenReady.filter((file) => installed.has(file.toLowerCase()));
    if (!landed.length) return;
    let room = cap - current.length;
    for (const file of landed) {
      const name = installed.get(file.toLowerCase())!;
      if (room > 0 && !current.includes(name)) { onAdd(name); room -= 1; }
    }
    setAddWhenReady((list) => list.filter((file) => !landed.includes(file)));
  }, [addWhenReady, cap, current, installed, onAdd]);

  const download = async (row: CivitaiLora, thenAdd: boolean) => {
    setFailed(({ [row.id]: _, ...rest }) => rest);
    if (thenAdd) setAddWhenReady((list) => (list.includes(row.file) ? list : [...list, row.file]));
    try {
      await downloads.start(row.id);
    } catch (error) {
      setAddWhenReady((list) => list.filter((file) => file !== row.file));
      setFailed((value) => ({ ...value, [row.id]: error instanceof Error ? error.message : 'The download didn’t start.' }));
    }
  };
  const progressOf = (row: CivitaiLora) => {
    const progress = downloadFor(downloads.state, row.file);
    if (!progress || installed.has(row.file.toLowerCase())) return null;
    if (progress.status === 'downloading' || progress.status === 'queued') {
      const percent = progress.totalBytes ? Math.min(99, Math.floor((progress.receivedBytes / progress.totalBytes) * 100)) : 0;
      return progress.verifying ? 'Checking' : progress.status === 'queued' ? 'Waiting' : `${percent}%`;
    }
    return progress.status === 'done' ? 'Adding' : null;
  };
  const errorOf = (row: CivitaiLora) => failed[row.id] || (downloadFor(downloads.state, row.file)?.status === 'error' ? downloadFor(downloads.state, row.file)?.error || '' : '');

  /* ---------------------------------------------------------------- Actions */
  const fullNote = <p className="lb-note">This workflow takes {cap}. Remove one from the stack first.</p>;

  /** The one button for a LoRA on this computer: Add, or In stack with Remove beside it. */
  const localAction = (name: string) => {
    if (current.includes(name)) {
      return (
        <div className="wf-detail-actions">
          <button type="button" className="btn is-primary" disabled><Check size={15} /> In stack</button>
          <button type="button" className="btn is-ghost" onClick={() => onRemove(name)}>Remove</button>
        </div>
      );
    }
    return (
      <>
        <div className="wf-detail-actions">
          <button type="button" className="btn is-primary" disabled={full} onClick={() => onAdd(name)}><Plus size={15} /> Add to stack</button>
        </div>
        {full ? fullNote : null}
      </>
    );
  };

  /** The one button for a Civitai LoRA: Download and add, its progress, or the local LoRA's own button once it is here. */
  const civitaiAction = (row: CivitaiLora) => {
    const local = installed.get(row.file.toLowerCase());
    if (local) return localAction(local);
    const progress = progressOf(row);
    const error = errorOf(row);
    if (progress) {
      return <div className="wf-detail-actions"><button type="button" className="btn is-primary" disabled><Loader2 size={14} className="spin" /> {progress === 'Adding' ? 'Adding' : `Downloading ${progress}`}</button></div>;
    }
    if (!canDownload) return <p className="lb-note">Downloads happen on the computer running HEISS UI, or a device it trusts with admin.</p>;
    return (
      <>
        <div className="wf-detail-actions">
          <button type="button" className="btn is-primary" title={row.file} onClick={() => void download(row, !full)}>
            {error ? <><RotateCw size={14} /> Try again</> : <><Download size={14} /> {full ? 'Download' : 'Download and add'}{row.bytes ? ` · ${sizeLabel(row.bytes)}` : ''}</>}
          </button>
        </div>
        {error ? <p className="lb-note is-error">{error}</p> : full ? fullNote : null}
      </>
    );
  };

  /* ------------------------------------------------------------------ Parts */
  const select = (id: string) => { if (source === 'local') setSelected(id); else setCivitaiSelected(id); setMobileDetailsOpen(true); };
  const searchValue = source === 'local' ? query : civitaiQuery;
  const setSearch = source === 'local' ? setQuery : setCivitaiQuery;
  const inUse = current.length;

  const localCard = (name: string) => {
    const info = infos[name];
    const base = info?.base || '';
    const other = fitOf(name) === 'other' && base;
    const meta = [base || loraFolder(name), sizeLabel(info?.bytes)].filter(Boolean).join(' · ');
    return (
      <button
        key={name}
        type="button"
        aria-pressed={name === localSelected}
        className={cn('wf-card lb-card', name === localSelected && 'active')}
        onClick={() => select(name)}
        onDoubleClick={() => { if (!current.includes(name) && !full) onAdd(name); }}
      >
        <span className="wf-thumb"><LoraThumb src={loraPreviewUrl(name, info)} label={base || 'LoRA'} small={!base} /></span>
        {favorites.includes(name) ? <span className="wf-fav" aria-label="Favorite"><Heart size={12} fill="currentColor" /></span> : null}
        {current.includes(name) ? <span className="wf-current">In stack</span> : null}
        <span className="wf-card-copy">
          <strong title={name}>{loraFileName(name)}</strong>
          <span>{meta || 'LoRA'}</span>
        </span>
        {other ? <span className="wf-status lb-other"><i aria-hidden="true" />Made for {base}</span> : null}
      </button>
    );
  };

  const civitaiCard = (row: CivitaiLora) => {
    const local = installed.get(row.file.toLowerCase());
    const progress = progressOf(row);
    return (
      <button
        key={row.id}
        type="button"
        aria-pressed={row.id === civitaiRow?.id}
        className={cn('wf-card lb-card', row.id === civitaiRow?.id && 'active')}
        onClick={() => select(row.id)}
      >
        <span className="wf-thumb"><LoraThumb src={row.preview} label={row.baseModel} /></span>
        {local && current.includes(local) ? <span className="wf-current">In stack</span> : local ? <span className="wf-current is-quiet">Downloaded</span> : progress ? <span className="wf-current is-quiet"><Loader2 size={10} className="spin" /> {progress}</span> : null}
        <span className="wf-card-copy">
          <strong title={row.name}>{row.name}</strong>
          <span>{[row.creator, row.downloads ? `${countLabel(row.downloads)} downloads` : ''].filter(Boolean).join(' · ') || row.baseModel}</span>
        </span>
      </button>
    );
  };

  const localDetail = (name: string) => {
    const info = infos[name];
    const favorite = favorites.includes(name);
    const meta = [info?.base, sizeLabel(info?.bytes), loraFolder(name)].filter(Boolean).join(' · ');
    const triggers = info?.triggers || [];
    return (
      <>
        <div className="wf-detail-thumb"><LoraThumb key={name} src={loraPreviewUrl(name, info)} label={info?.base || 'LoRA'} /></div>
        <div className="wf-detail-head">
          <h3>{loraFileName(name)}</h3>
          <button type="button" className={cn('wf-heart', favorite && 'active')} aria-pressed={favorite} aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => onToggleFavorite(name)}>
            <Heart size={16} fill={favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
        <p className="wf-detail-meta">{meta || 'LoRA on this computer'}</p>
        {fitOf(name) === 'other' && info?.base ? <p className="wf-issue">Made for {info.base}, so it may not work with {family || 'this model'}.</p> : null}
        {localAction(name)}
        {triggers.length ? (
          <dl className="civitai-card-facts">
            <FactRow label="Trigger words" values={triggers} tone="trigger" copied={copied} onCopy={(value, key) => copyWith(() => copyText(value), key)} />
          </dl>
        ) : null}
      </>
    );
  };

  const empty = (icon: React.ReactNode, title: string, text: string, action?: React.ReactNode) => (
    <div className="wf-empty">{icon}<h3>{title}</h3><p>{text}</p>{action}</div>
  );

  let grid: React.ReactNode;
  if (source === 'local') {
    grid = localItems.length ? <div className="wf-grid">{localItems.map(localCard)}</div>
      : query ? empty(<Search size={20} />, 'Nothing matches', 'Try another name or clear the search.', <button type="button" className="btn" onClick={() => setQuery('')}>Clear search</button>)
      : !options.length ? empty(<Layers size={20} />, 'No LoRAs on this computer yet', 'Find some made for this model on Civitai.', <button type="button" className="btn is-primary" onClick={() => setSource('civitai')}><Search size={14} /> Find on Civitai</button>)
      : filter === 'stack' ? empty(<Layers size={20} />, 'Nothing in the stack', 'Add a LoRA and it shows up here.', <button type="button" className="btn" onClick={() => setFilter('all')}>Show all</button>)
      : filter === 'favorites' ? empty(<Heart size={20} />, 'No favorites yet', 'Tap the heart on a LoRA to add it here.', <button type="button" className="btn" onClick={() => setFilter('all')}>Show all</button>)
      : empty(<Layers size={20} />, 'Nothing used yet', 'LoRAs you add show up here.', <button type="button" className="btn" onClick={() => setFilter('all')}>Show all</button>);
  } else if (civitai.state.unsupported) {
    grid = empty(<Layers size={20} />, 'Nothing sure to fit', 'Civitai has no LoRA category for this model.');
  } else if (civitai.state.error && !civitai.rows.length) {
    grid = empty(<AlertTriangle size={20} />, 'Civitai didn’t answer', civitai.state.error, <button type="button" className="btn" onClick={() => civitai.retry()}><RotateCw size={13} /> Try again</button>);
  } else {
    grid = (
      <>
        {civitai.rows.length ? (
          <div className="wf-grid">
            {civitai.rows.map(civitaiCard)}
            {/* Inside the grid, so they scroll with the cards. */}
            <div className="lb-grid-foot">
              {civitai.state.loading ? <div className="civitai-loading"><Loader2 size={14} className="spin" /> Asking Civitai…</div> : null}
              {civitai.cursor && !civitai.state.loading ? <button type="button" className="btn is-ghost lb-more" onClick={() => civitai.loadMore()}>Show more</button> : null}
            </div>
          </div>
        ) : civitai.state.loading ? <div className="civitai-loading"><Loader2 size={14} className="spin" /> Asking Civitai…</div>
          : empty(<Search size={20} />, 'Nothing matches', civitaiQuery.trim() ? `No LoRAs on Civitai match “${civitaiQuery.trim()}” for this model.` : 'Civitai has no LoRAs for this model yet.')}
      </>
    );
  }

  const detail = source === 'local'
    ? (localSelected ? localDetail(localSelected) : empty(<Layers size={22} />, 'No LoRA selected', 'Choose one to see its details.'))
    : (civitaiRow ? <CivitaiDetail key={civitaiRow.id} row={civitaiRow} state={civitai.details[civitaiRow.versionId]} action={civitaiAction(civitaiRow)} onRetry={() => civitai.retryDetails(civitaiRow)} /> : empty(<Layers size={22} />, 'No LoRA selected', 'Choose one to see its details.'));

  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      size="wide"
      className="workflow-gallery lora-browser"
      bodyClassName="wf-layout"
      initialFocus={searchRef}
      title="LoRAs"
      description={`${family ? `For ${family} · ` : ''}${inUse} of ${cap} in this workflow`}
    >
      <section className={cn('wf-browse', mobileDetailsOpen && 'is-hidden-mobile')}>
        <div className="wf-toolbar">
          <label className="wf-search">
            <Search size={14} />
            <input
              ref={searchRef}
              className="is-framed"
              aria-label={source === 'local' ? 'Search LoRAs on this computer' : 'Search Civitai LoRAs'}
              value={searchValue}
              placeholder={source === 'local' ? `Search ${options.length} LoRAs` : civitai.state.bases.length ? `Search Civitai for ${civitai.state.bases[0]} LoRAs` : 'Search Civitai'}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape' && searchValue) { event.preventDefault(); event.stopPropagation(); setSearch(''); } }}
            />
            {searchValue ? <button type="button" aria-label="Clear search" onClick={() => { setSearch(''); searchRef.current?.focus(); }}><X size={13} /></button> : null}
          </label>
          <div className={cn('lora-source', mature && 'is-mature')} title={mature ? 'Mature content is on: Civitai results come from civitai.red' : undefined}>
            <Segmented<LoraSource> label="Where to find LoRAs" value={source} onChange={(next) => { setSource(next); setMobileDetailsOpen(false); }} options={[{ value: 'local', label: 'Local' }, { value: 'civitai', label: 'Civitai' }]} />
          </div>
        </div>
        {source === 'local' ? (
          <div ref={filtersWheelRef} className="wf-filters" role="radiogroup" aria-label="Filter LoRAs">
            {([['all', `All ${counts.all}`], ['stack', `In stack ${counts.stack}`], ['favorites', 'Favorites'], ['recent', 'Recent']] as Array<[LocalFilter, string]>).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={filter === value} className={cn(filter === value && 'active')} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
        ) : (
          <p className="lb-scope"><span>{civitai.state.bases.length ? <>Made for <strong>{civitai.state.bases.join(', ')}</strong></> : 'Made for this model'}{civitai.state.site ? ` · ${civitai.state.site}` : ''}{civitaiQuery.trim() ? '' : ' · most downloaded first'}</span></p>
        )}
        {grid}
      </section>

      <aside className={cn('wf-detail', mobileDetailsOpen && 'is-open-mobile')}>
        <button type="button" className="btn is-ghost wf-back" onClick={() => setMobileDetailsOpen(false)}><ArrowLeft size={15} /> All LoRAs</button>
        {detail}
      </aside>
    </Modal>
  );
}
