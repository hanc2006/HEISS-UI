import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Download, ExternalLink, Heart, Layers, Loader2, Plus, RotateCw, Search, X } from 'lucide-react';
import { Modal } from './Modal';
import { Segmented } from './SettingsControls';
import { cn } from './format';
import { useThisComputer } from './device';
import { rankedLoras, type FitOf } from './loras';
import { findLoraOnCivitai, loadCivitaiStatus, loadLoraScan, startLoraScan, type CivitaiLora, type CivitaiLoraDetails, type CivitaiRef, type LoraScanState } from './civitai';
import { LoraDetail, sizeLabel, useCivitaiLoras } from './CivitaiLoras';
import { SplitButton, type SplitMenuItem } from './SplitButton';
import { LoraThumb, loraPreviewUrl } from './LoraThumb';
import { downloadFor, useModelDownloads } from './useModelDownloads';
import { scrollSideways, useWheelRef } from './wheel';
import { refreshLoraInfo, type LoraInfo } from './useLoraInfo';
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
 * model), the selected one's details on the right as a picture card with a
 * split button: Download, Use Model or In use, with Remove and Visit Civitai
 * behind its chevron.
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
  const filtersWheelRef = useWheelRef<HTMLDivElement>(scrollSideways);
  const canDownload = useThisComputer();
  const family = profile?.familyName || familyLabel || profile?.family || '';
  const full = current.length >= cap;

  useEffect(() => {
    let live = true;
    loadCivitaiStatus().then((status) => { if (live) setMature(status.mature); }).catch(() => {});
    return () => { live = false; };
  }, []);

  /* ---------------------------------------------------------- This computer */
  const available = useMemo(() => new Set(options), [options]);
  const counts = {
    all: options.length,
    stack: current.filter((name) => available.has(name)).length
  };
  const localItems = useMemo(() => {
    const ranked = rankedLoras(options, profile, query, fitOf);
    if (filter === 'stack') return ranked.filter((name) => current.includes(name));
    if (filter === 'favorites') return ranked.filter((name) => favorites.includes(name));
    if (filter === 'recent') return recents.filter((name) => available.has(name) && ranked.includes(name));
    return ranked;
  }, [available, current, favorites, filter, fitOf, options, profile, query, recents]);
  const localSelected = localItems.includes(selected) ? selected : localItems[0] || '';

  // Every LoRA here without a .civitai.json is matched with Civitai in the background
  // (server/lora-previews.js); cards pick up their Civitai names as it goes.
  const [scan, setScan] = useState<LoraScanState | null>(null);
  useEffect(() => {
    if (!open || !canDownload || !options.length) return;
    let live = true;
    let timer = 0;
    let seen = -1;
    const poll = (state: LoraScanState) => {
      if (!live) return;
      setScan(state);
      if (state.matched !== seen) { if (seen >= 0) refreshLoraInfo(); seen = state.matched; }
      if (state.running) timer = window.setTimeout(() => { loadLoraScan().then(poll).catch(() => {}); }, 1500);
    };
    startLoraScan().then(poll).catch(() => {});
    return () => { live = false; window.clearTimeout(timer); };
  }, [open, canDownload, options.length]);

  /* --------------------------------------------------------------- Civitai */
  const civitai = useCivitaiLoras({ enabled: open && source === 'civitai', query: civitaiQuery, profile });
  const installed = useMemo(() => {
    const byFile = new Map<string, string>();
    for (const name of options) byFile.set(baseName(name).toLowerCase(), name);
    return byFile;
  }, [options]);
  const downloads = useModelDownloads({ onDone: (item) => { if (item.id.startsWith('civitai:')) { onLibraryChanged(); window.setTimeout(refreshLoraInfo, 1500); } } });
  const civitaiRow = civitai.rows.find((row) => row.id === civitaiSelected) || civitai.rows[0] || null;
  useEffect(() => { if (source === 'civitai' && civitaiRow) civitai.ensureDetails(civitaiRow.versionId); }, [source, civitaiRow?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A LoRA on this computer: which Civitai LoRA it is and what Civitai says, from its .civitai.json
  // (or found by its SHA-256 and kept there by the server).
  type Lookup = { state: 'loading' } | { state: 'none' } | { state: 'error'; error: string } | { state: 'found'; ref: CivitaiRef; details: CivitaiLoraDetails | null };
  const [lookups, setLookups] = useState<Record<string, Lookup>>({});
  useEffect(() => {
    if (!open || source !== 'local' || !localSelected || lookups[localSelected] || !/\.safetensors$/i.test(localSelected)) return;
    const name = localSelected;
    setLookups((value) => ({ ...value, [name]: { state: 'loading' } }));
    findLoraOnCivitai(name)
      .then((answer) => setLookups((value) => ({ ...value, [name]: answer.found && answer.ref ? { state: 'found', ref: answer.ref, details: answer.details || null } : { state: 'none' } })))
      .catch((error) => setLookups((value) => ({ ...value, [name]: { state: 'error', error: error instanceof Error ? error.message : 'Civitai couldn’t be asked.' } })));
  }, [open, source, localSelected, lookups]);
  const retryLookup = (name: string) => setLookups(({ [name]: _, ...rest }) => rest);

  const download = async (row: CivitaiLora) => {
    setFailed(({ [row.id]: _, ...rest }) => rest);
    try {
      await downloads.start(row.id);
    } catch (error) {
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
    return progress.status === 'done' ? 'Finishing' : null;
  };
  const errorOf = (row: CivitaiLora) => failed[row.id] || (downloadFor(downloads.state, row.file)?.status === 'error' ? downloadFor(downloads.state, row.file)?.error || '' : '');

  /* ---------------------------------------------------------------- Actions */
  const fullNote = <p className="lb-note">This workflow takes {cap}. Remove one from the stack first.</p>;

  /**
   * The split button: its main half does the next thing (Download, Use Model,
   * or says In use); Remove (from the stack) and Visit Civitai sit behind the chevron.
   */
  const actionFor = ({ local, row, page }: { local: string; row?: CivitaiLora; page: string }) => {
    const inStack = Boolean(local && current.includes(local));
    const items: SplitMenuItem[] = [
      { label: 'Remove', icon: <X size={14} />, disabled: !inStack, danger: true, onSelect: () => onRemove(local) },
      { label: 'Visit Civitai', icon: <ExternalLink size={14} />, href: page, disabled: !page }
    ];
    if (local) {
      return inStack
        ? <SplitButton label="In use" icon={<Check size={15} />} disabled items={items} />
        : <SplitButton label="Use Model" icon={<Plus size={15} />} disabled={full} title={full ? `This workflow takes ${cap}` : undefined} onClick={() => onAdd(local)} items={items} />;
    }
    const progress = row ? progressOf(row) : null;
    if (progress) return <SplitButton label={progress === 'Finishing' ? 'Finishing' : `Downloading ${progress}`} icon={<Loader2 size={14} className="spin" />} busy items={items} />;
    const error = row ? errorOf(row) : '';
    return (
      <SplitButton
        label={error ? 'Try again' : 'Download'}
        icon={error ? <RotateCw size={14} /> : <Download size={15} />}
        disabled={!canDownload || !row}
        title={!canDownload ? 'Downloads happen on the computer running HEISS UI, or a device it trusts with admin.' : row?.file}
        onClick={() => row && void download(row)}
        items={items}
      />
    );
  };

  /* ------------------------------------------------------------------ Parts */
  const select = (id: string) => { if (source === 'local') setSelected(id); else setCivitaiSelected(id); setMobileDetailsOpen(true); };
  const searchValue = source === 'local' ? query : civitaiQuery;
  const setSearch = source === 'local' ? setQuery : setCivitaiQuery;
  const inUse = current.length;

  /** The card's words: the LoRA's name, then the model it was made for as a badge, and its size. */
  const cardCopy = (name: string, model: string, bytes: number | undefined, other: boolean, favorite: boolean, title: string) => (
    <span className="wf-card-copy lb-card-copy">
      <strong title={title}>{favorite ? <Heart size={11} fill="currentColor" className="lb-fav" aria-label="Favorite" /> : null}{name}</strong>
      <span>
        {model ? <em className={cn('lb-model', other && 'is-other')} title={other ? `Made for ${model}, not ${family || 'this model'}` : undefined}>{model}</em> : null}
        {bytes ? <span>{sizeLabel(bytes)}</span> : null}
      </span>
    </span>
  );

  const localCard = (name: string) => {
    const info = infos[name];
    const lookup = lookups[name];
    const model = info?.base || info?.civitaiBase || '';
    return (
      <button
        key={name}
        type="button"
        aria-pressed={name === localSelected}
        className={cn('wf-card lb-card', name === localSelected && 'active')}
        onClick={() => select(name)}
        onDoubleClick={() => { if (!current.includes(name) && !full) onAdd(name); }}
      >
        <span className="wf-thumb"><LoraThumb src={loraPreviewUrl(name, info)} label={model || 'LoRA'} plain /></span>
        {current.includes(name) ? <span className="wf-current">In use</span> : null}
        {cardCopy(info?.title || (lookup?.state === 'found' ? lookup.ref.name : '') || loraFileName(name), model, info?.bytes, fitOf(name) === 'other' && Boolean(info?.base), favorites.includes(name), name)}
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
        <span className="wf-thumb"><LoraThumb src={row.preview} label={row.baseModel} plain /></span>
        {local && current.includes(local) ? <span className="wf-current">In use</span> : local ? <span className="wf-current is-quiet">Downloaded</span> : progress ? <span className="wf-current is-quiet"><Loader2 size={10} className="spin" /> {progress}</span> : null}
        {cardCopy(row.name, row.baseModel, row.bytes, false, Boolean(local && favorites.includes(local)), row.name)}
      </button>
    );
  };

  const localDetail = (name: string) => {
    const info = infos[name];
    const lookup = lookups[name];
    const found = lookup?.state === 'found' ? lookup : null;
    const model = info?.base || found?.ref.baseModel || info?.civitaiBase || '';
    const other = fitOf(name) === 'other' && Boolean(info?.base);
    const page = found?.details?.page || (found?.ref.modelId ? `https://civitai.com/models/${found.ref.modelId}?modelVersionId=${found.ref.versionId}` : '');
    return (
      <LoraDetail
        key={name}
        id={name}
        name={found?.ref.name || info?.title || loraFileName(name)}
        model={model}
        otherModel={other}
        size={info?.bytes}
        previews={[loraPreviewUrl(name, info)]}
        details={found?.details || null}
        loading={!lookup || lookup.state === 'loading'}
        error={lookup?.state === 'error' ? lookup.error : ''}
        onRetry={() => retryLookup(name)}
        triggers={info?.triggers || []}
        action={actionFor({ local: name, page })}
        favorite={{ on: favorites.includes(name), toggle: () => onToggleFavorite(name) }}
        note={<>
          {other ? <p className="wf-issue">Made for {info?.base}, so it may not work with {family || 'this model'}.</p> : null}
          {lookup?.state === 'none' ? <p className="lb-note">Civitai doesn’t know this file, so only what the file itself says is shown.</p> : null}
          {full && !current.includes(name) ? fullNote : null}
        </>}
      />
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

  const civitaiDetails = civitaiRow ? civitai.details[civitaiRow.versionId] : undefined;
  const civitaiLocal = civitaiRow ? installed.get(civitaiRow.file.toLowerCase()) || '' : '';
  const detail = source === 'local'
    ? (localSelected ? localDetail(localSelected) : empty(<Layers size={22} />, 'No LoRA selected', 'Choose one to see its details.'))
    : (civitaiRow ? (
      <LoraDetail
        key={civitaiRow.id}
        id={civitaiRow.id}
        name={civitaiRow.name}
        model={civitaiRow.baseModel}
        size={civitaiRow.bytes}
        previews={[civitaiRow.preview]}
        details={civitaiDetails && !civitaiDetails.loading && 'details' in civitaiDetails ? civitaiDetails.details : null}
        loading={!civitaiDetails || civitaiDetails.loading}
        error={civitaiDetails && !civitaiDetails.loading && 'error' in civitaiDetails ? civitaiDetails.error : ''}
        onRetry={() => civitai.retryDetails(civitaiRow.versionId)}
        action={actionFor({ local: civitaiLocal, row: civitaiRow, page: civitaiRow.page })}
        favorite={civitaiLocal ? { on: favorites.includes(civitaiLocal), toggle: () => onToggleFavorite(civitaiLocal) } : undefined}
        note={<>
          {errorOf(civitaiRow) && !civitaiLocal ? <p className="lb-note is-error">{errorOf(civitaiRow)}</p> : null}
          {full && civitaiLocal && !current.includes(civitaiLocal) ? fullNote : null}
        </>}
      />
    ) : empty(<Layers size={22} />, 'No LoRA selected', 'Choose one to see its details.'));

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
            {([['all', `All ${counts.all}`], ['stack', `In use ${counts.stack}`], ['favorites', 'Favorites'], ['recent', 'Recent']] as Array<[LocalFilter, string]>).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={filter === value} className={cn(filter === value && 'active')} onClick={() => setFilter(value)}>{label}</button>
            ))}
            {scan?.running && scan.total ? <span className="lb-scan" role="status"><Loader2 size={12} className="spin" /> Matching with Civitai · {scan.done} of {scan.total}</span> : null}
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
