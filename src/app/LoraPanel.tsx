import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { AlertTriangle, Check, ChevronDown, GripVertical, Layers, RotateCcw, Search, X } from 'lucide-react';
import { cn } from './format';
import { defaultLoraStrength, maxLoras, type FitOf } from './loras';
import { NumberPicker, Tip } from './components';
import { Switch } from './SettingsControls';
import { copyText } from './api';
import { LoraBrowser, loraFileName, loraFolder, type LoraSource } from './LoraBrowser';
import { LoraThumb, loraPreviewUrl } from './LoraThumb';
import { loraFit, useLoraInfo, type LoraInfo } from './useLoraInfo';
import type { LoraSnapshot } from './lora-storage';
import type { LoraSelection, Profile } from './types';

export type LoraLibraryApi = {
  familyLabel: string;
  stacks: LoraSnapshot[];
  favorites: string[];
  recents: string[];
  loadStack: (stack: LoraSnapshot) => void;
  saveStack: (name: string) => LoraSnapshot;
  updateStack: (id: string) => void;
  renameStack: (id: string, name: string) => void;
  deleteStack: (stack: LoraSnapshot) => Promise<boolean>;
  toggleFavorite: (name: string) => void;
  recordRecents: (names: string[]) => void;
};

function sameStack(a: LoraSelection[], b: LoraSelection[]) {
  return a.length === b.length && a.every((item, index) => item.name === b[index].name && item.enabled === b[index].enabled && Math.abs(item.strength - b[index].strength) < 0.001);
}

/* ------------------------------------------------------------------ Row */

/** The words a LoRA was trained to answer to; a click copies one for the prompt. */
function TriggerWords({ words }: { words: string[] }) {
  const [copied, setCopied] = useState('');
  if (!words.length) return null;
  const copy = async (word: string) => {
    if (!await copyText(word)) return;
    setCopied(word);
    window.setTimeout(() => setCopied((current) => (current === word ? '' : current)), 1400);
  };
  return (
    <p className="lora-triggers">
      <span>Trigger</span>
      {words.map((word) => (
        <Tip key={word} content={copied === word ? 'Copied' : 'Copy for the prompt'}>
          <button type="button" className={cn('lora-trigger', copied === word && 'is-copied')} onClick={() => copy(word)}>{word}</button>
        </Tip>
      ))}
    </p>
  );
}

/**
 * One LoRA in the stack: what can be tuned here and nothing else. Its picture
 * and name open it in the browser; the switch turns it off; the stepper sets
 * its strength; the grip and × show on hover or focus.
 */
function LoraRow({ item, index, count, missing, overLimit, info, otherModel, onChange, onRemove, onOpen, onMove }: {
  item: LoraSelection;
  index: number;
  count: number;
  missing: boolean;
  overLimit: boolean;
  info?: LoraInfo;
  /** Made for another model than this one: its name for it, else empty. */
  otherModel: string;
  onChange: (patch: Partial<LoraSelection>) => void;
  onRemove: () => void;
  onOpen: () => void;
  onMove: (to: number) => void;
}) {
  const controls = useDragControls();
  const folder = loraFolder(item.name);
  const label = loraFileName(item.name);
  return (
    <Reorder.Item as="div" value={item} dragListener={false} dragControls={controls} style={{ position: 'relative' }} whileDrag={{ scale: 1.02, zIndex: 5, boxShadow: '0 12px 32px rgb(0 0 0 / 0.45), inset 0 0 0 1px rgb(255 255 255 / 0.14)' }} className={cn('lora-card', !item.enabled && 'is-off', (missing || overLimit) && 'has-warning')}>
      {count > 1 ? (
        <button
          type="button"
          className="lora-grip"
          aria-label={`Reorder ${label}. Use the arrow keys to move it.`}
          onPointerDown={(event) => controls.start(event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); onMove(index - 1); }
            if (event.key === 'ArrowDown' && index < count - 1) { event.preventDefault(); onMove(index + 1); }
          }}
        >
          <GripVertical size={13} />
        </button>
      ) : null}
      <div className="lora-card-top">
        <Tip content={folder ? `${folder} · details` : 'Details'}>
          <button type="button" className="lora-open" onClick={onOpen} aria-label={`${label}, show details`}>
            <span className="lora-row-thumb wf-thumb"><LoraThumb src={loraPreviewUrl(item.name, info)} label={info?.base || ''} small /></span>
            <span className="lora-name">{label}</span>
          </button>
        </Tip>
        <Tip content="Remove"><button type="button" className="lora-remove" aria-label={`Remove ${label}`} onClick={onRemove}><X size={13} /></button></Tip>
        <Switch size="sm" label={item.enabled ? `Turn off ${label}` : `Turn on ${label}`} checked={item.enabled} onChange={(enabled) => onChange({ enabled })} />
      </div>
      <div className={cn('lora-strength', !item.enabled && 'is-disabled')}>
        <NumberPicker label="Strength" value={item.strength} onChange={(strength) => onChange({ strength })} min={-4} max={4} step={0.05} precision={2} size="sm" fill />
        <div className="sidebar-scale-hint" aria-hidden="true"><span>Weaker</span><span>Stronger</span></div>
      </div>
      {!missing && item.enabled && info?.triggers?.length ? <TriggerWords words={info.triggers} /> : null}
      {missing ? <p className="lora-warning"><AlertTriangle size={12} /> Not in ComfyUI’s LoRA folder</p> : null}
      {!missing && overLimit ? <p className="lora-warning"><AlertTriangle size={12} /> Over this workflow’s limit, so it isn’t used</p> : null}
      {!missing && !overLimit && otherModel ? <p className="lora-warning is-soft"><AlertTriangle size={12} /> Made for {otherModel}, so it may not work here</p> : null}
    </Reorder.Item>
  );
}

/* --------------------------------------------------------------- Stacks */

/** A short default name from the LoRAs themselves: "Anime Watercolor +1". */
function suggestStackName(loras: LoraSelection[], taken: string[]) {
  const pretty = (item: LoraSelection) => loraFileName(item.name)
    .replace(/[-_.]+/g, ' ')
    .replace(/\b(v\d+(\.\d+)*|lora|loha|lycoris|epoch\s*\d+|e\d+|\d{3,})\b/gi, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  const enabled = loras.filter((item) => item.enabled);
  const lead = [...(enabled.length ? enabled : loras)].sort((x, y) => y.strength - x.strength)[0];
  let name = lead ? pretty(lead) : '';
  if (!name) name = 'My stack';
  if (name.length > 22) name = `${name.slice(0, 21).trim()}…`;
  if (loras.length > 1) name += ` +${loras.length - 1}`;
  let unique = name;
  for (let n = 2; taken.includes(unique); n++) unique = `${name} (${n})`;
  return unique;
}

function NameField({ initial, action, onSave, onCancel }: { initial: string; action: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const save = () => { const name = value.trim(); if (name) onSave(name); else onCancel(); };
  return (
    <form className="lora-name-field" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <input
        autoFocus
        className="is-framed"
        aria-label="Stack name"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}
      />
      <button type="submit" className="lora-chip-action is-primary" disabled={!value.trim()}>{action}</button>
      <button type="button" className="lora-chip-action" aria-label="Cancel" onClick={onCancel}><X size={13} /></button>
    </form>
  );
}

/**
 * Saved stacks and the whole-stack actions in one menu under the header:
 * load one, save or update, rename or delete the one in use, turn all off, clear.
 */
function StackMenu({ library, loras, active, modified, onLoad, onClose, onAllToggle, allOff, onClear, onActive }: {
  library: LoraLibraryApi;
  loras: LoraSelection[];
  active: LoraSnapshot | null;
  modified: boolean;
  onLoad: (stack: LoraSnapshot) => void;
  onClose: () => void;
  onAllToggle: () => void;
  allOff: boolean;
  onClear: () => void;
  onActive: (id: string) => void;
}) {
  const [naming, setNaming] = useState<null | 'new' | 'rename'>(null);
  const ref = useRef<HTMLDivElement>(null);
  const matchesSaved = library.stacks.some((stack) => sameStack(stack.loras, loras));
  const family = library.familyLabel || 'this model';
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('.lora-stack-button')) onClose();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [onClose]);
  const item = (label: React.ReactNode, onClick: () => void, opts: { danger?: boolean; disabled?: boolean } = {}) => (
    <button type="button" role="menuitem" className={cn('lora-menu-item', opts.danger && 'is-danger')} disabled={opts.disabled} onClick={onClick}>{label}</button>
  );
  return (
    <div className="lora-menu" role="menu" aria-label="Stacks" ref={ref} onKeyDown={(event) => { if (event.key === 'Escape' && !naming) { event.stopPropagation(); onClose(); } }}>
      {library.stacks.length ? (
        <div className="lora-menu-group">
          <span className="lora-menu-heading">Saved for {family}</span>
          {library.stacks.map((stack) => (
            <button key={stack.id} type="button" role="menuitemradio" aria-checked={stack.id === active?.id} className={cn('lora-menu-item', stack.id === active?.id && 'is-active')} onClick={() => { onLoad(stack); onActive(stack.id); onClose(); }}>
              <span className="lora-menu-check" aria-hidden="true">{stack.id === active?.id ? <Check size={12} /> : null}</span>
              <span className="lora-menu-label">{stack.name}</span>
              <em>{stack.loras.length}</em>
            </button>
          ))}
        </div>
      ) : <p className="lora-menu-hint">Save these LoRAs as a stack to use them again with every {family} workflow.</p>}

      {naming ? (
        <NameField
          initial={naming === 'rename' && active ? active.name : suggestStackName(loras, library.stacks.map((stack) => stack.name))}
          action={naming === 'rename' ? 'Rename' : 'Save'}
          onSave={(name) => {
            if (naming === 'rename' && active) library.renameStack(active.id, name);
            else onActive(library.saveStack(name).id);
            setNaming(null);
            onClose();
          }}
          onCancel={() => setNaming(null)}
        />
      ) : (
        <div className="lora-menu-group">
          {active && modified ? item(<>Save changes to <strong>{active.name}</strong></>, () => { library.updateStack(active.id); onClose(); }) : null}
          {loras.length && !matchesSaved ? item('Save as new stack…', () => setNaming('new')) : null}
          {active ? item('Rename…', () => setNaming('rename')) : null}
          {active ? item(`Delete ${active.name}`, async () => { if (await library.deleteStack(active)) onActive(''); onClose(); }, { danger: true }) : null}
        </div>
      )}

      {loras.length && !naming ? (
        <div className="lora-menu-group">
          {item(allOff ? 'Turn all on' : 'Turn all off', () => { onAllToggle(); onClose(); })}
          {item('Clear the stack', () => { onClear(); onClose(); })}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- Panel */

type Undo = { label: string; restore: LoraSelection[] };

/**
 * The LoRAs on this generation, to tune: on or off, strength, order. Choosing
 * them happens in the LoRA browser (Browse LoRAs, or a row's name); saved
 * stacks and whole-stack actions live in the Stack menu.
 */
export function LoraPanel({ loras, setLoras, options, profile, limit, library, rememberedStrength, unavailableReason, onLibraryChanged = () => {} }: {
  /** Ask ComfyUI for its LoRAs again, after one is downloaded from Civitai. */
  onLibraryChanged?: () => void;
  loras: LoraSelection[];
  setLoras: (update: LoraSelection[] | ((current: LoraSelection[]) => LoraSelection[])) => void;
  options: string[];
  profile: Profile | null;
  limit: number;
  library: LoraLibraryApi;
  rememberedStrength: (name: string, fallback: number) => number;
  unavailableReason: string;
}) {
  const [browser, setBrowser] = useState<{ focus: string; source: LoraSource } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeStackId, setActiveStackId] = useState('');
  const [undo, setUndo] = useState<Undo | null>(null);
  const undoTimer = useRef<number | null>(null);
  useEffect(() => () => { if (undoTimer.current) window.clearTimeout(undoTimer.current); }, []);
  useEffect(() => { setActiveStackId(''); }, [library.familyLabel]);

  const available = useMemo(() => new Set(options), [options]);
  // What each LoRA file says it was made for, so ones that fit list first and the rest say so.
  const infos = useLoraInfo(options);
  const fitOf = useMemo<FitOf>(() => (name) => loraFit(infos[name], profile), [infos, profile]);
  const baseOf = (name: string) => infos[name]?.base || '';
  const cap = Math.min(maxLoras, limit);
  const activeCount = loras.filter((item) => item.enabled).length;

  if (unavailableReason) {
    return (
      <div className="lora-panel">
        <div className="lora-empty is-unavailable"><Layers size={18} /><p>{unavailableReason}</p></div>
      </div>
    );
  }

  // The stack you're working from: the one you loaded, an exact match, or one with
  // the same LoRAs (so nudging a strength reads as "changed", not "unsaved").
  const sameSet = (stack: LoraSnapshot) => stack.loras.length === loras.length && stack.loras.every((item) => loras.some((current) => current.name === item.name));
  const active = library.stacks.find((stack) => stack.id === activeStackId)
    || library.stacks.find((stack) => sameStack(stack.loras, loras))
    || (loras.length ? library.stacks.find(sameSet) : null)
    || null;
  const modified = Boolean(active && loras.length && !sameStack(active.loras, loras));

  /** Every change that drops LoRAs can be taken back for a few seconds. */
  const withUndo = (label: string, next: LoraSelection[]) => {
    const before = loras;
    setLoras(next);
    setUndo({ label, restore: before });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 6000);
  };
  const update = (index: number, patch: Partial<LoraSelection>) => setLoras((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  const removeName = (name: string) => withUndo(`Removed ${loraFileName(name)}`, loras.filter((item) => item.name !== name));
  const clearAll = () => { withUndo(`Cleared ${loras.length} LoRA${loras.length === 1 ? '' : 's'}`, []); setActiveStackId(''); };
  const loadStack = (stack: LoraSnapshot) => {
    const unsaved = loras.length > 0 && !library.stacks.some((item) => sameStack(item.loras, loras));
    if (unsaved) withUndo(`Loaded ${stack.name}`, stack.loras);
    else library.loadStack(stack);
  };
  const allOff = loras.length > 0 && loras.every((item) => !item.enabled);
  const move = (from: number, to: number) => setLoras((current) => { const next = [...current]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next; });
  const add = (name: string) => {
    setLoras((current) => current.some((item) => item.name === name) || current.length >= cap ? current : [...current, { name, enabled: true, strength: rememberedStrength(name, defaultLoraStrength) }]);
    library.recordRecents([name]);
  };
  const openBrowser = (focus = '', source: LoraSource = options.length ? 'local' : 'civitai') => { setMenuOpen(false); setBrowser({ focus, source }); };

  return (
    <div className="lora-panel">
      <header className="lora-head">
        <span className="lora-count">{loras.length ? <>{activeCount} active <em>· {loras.length}/{cap}</em></> : `Up to ${cap} LoRAs`}</span>
        {loras.length || library.stacks.length ? (
          <button type="button" className={cn('lora-stack-button', menuOpen && 'is-open', modified && 'is-modified')} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((value) => !value)}>
            {modified ? <i aria-hidden="true" /> : null}
            <span>{active ? active.name : 'Stacks'}</span>
            <ChevronDown size={12} />
          </button>
        ) : null}
      </header>

      {menuOpen ? (
        <StackMenu
          library={library}
          loras={loras}
          active={active}
          modified={modified}
          onLoad={loadStack}
          onClose={() => setMenuOpen(false)}
          onActive={setActiveStackId}
          allOff={allOff}
          onAllToggle={() => setLoras((current) => current.map((item) => ({ ...item, enabled: allOff })))}
          onClear={clearAll}
        />
      ) : null}

      {loras.length ? (
        <Reorder.Group as="div" axis="y" values={loras} onReorder={(next) => setLoras(next)} className="lora-list">
          {loras.map((item, index) => (
            <LoraRow
              key={item.name}
              item={item}
              index={index}
              count={loras.length}
              missing={!available.has(item.name)}
              overLimit={index >= cap}
              info={infos[item.name]}
              otherModel={fitOf(item.name) === 'other' ? baseOf(item.name) : ''}
              onChange={(patch) => update(index, patch)}
              onRemove={() => removeName(item.name)}
              onOpen={() => openBrowser(item.name, 'local')}
              onMove={(to) => move(index, to)}
            />
          ))}
        </Reorder.Group>
      ) : (
        <div className="lora-empty">
          <p>LoRAs steer style, characters or detail on top of the model.{options.length ? '' : ' There are none on this computer yet.'}</p>
        </div>
      )}

      {undo ? (
        <div className="lora-undo" role="status">
          <span>{undo.label}</span>
          <button type="button" onClick={() => { setLoras(undo.restore); setUndo(null); }}><RotateCcw size={12} /> Undo</button>
        </div>
      ) : null}

      <button type="button" className={cn('btn lora-add', !loras.length && 'is-primary')} onClick={() => openBrowser()}>
        <Search size={14} /> {options.length ? 'Browse LoRAs' : 'Find LoRAs on Civitai'}
      </button>

      {browser ? (
        <LoraBrowser
          open
          onClose={() => setBrowser(null)}
          startOn={browser.source}
          focus={browser.focus}
          familyLabel={library.familyLabel}
          options={options}
          profile={profile}
          infos={infos}
          fitOf={fitOf}
          current={loras.map((item) => item.name)}
          cap={cap}
          favorites={library.favorites}
          recents={library.recents}
          onToggleFavorite={library.toggleFavorite}
          onAdd={add}
          onRemove={removeName}
          onLibraryChanged={onLibraryChanged}
        />
      ) : null}
    </div>
  );
}
