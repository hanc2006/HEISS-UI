import React, { useState } from 'react';
import { Layers } from 'lucide-react';
import { cn } from './format';
import type { LoraInfo } from './useLoraInfo';

/** A tint from a name: the same base model always gets the same color. */
export function hueOf(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return Math.round((24 + (hash % 360) * 137.508) % 360);
}

/** The address of a LoRA's picture on this computer, or '' without one. */
export function loraPreviewUrl(name: string, info?: LoraInfo) {
  return info?.preview ? `/api/loras/preview?name=${encodeURIComponent(name)}&v=${info.preview}` : '';
}

/**
 * A LoRA's picture over its tile, the workflow gallery's way: the tile (its
 * base model on that model's tint) is always there, and the picture fades in
 * once it has loaded, so a slow or broken one never leaves an empty box.
 */
export function LoraThumb({ src, label, small = false, plain = false }: { src?: string; label: string; small?: boolean; /** The tile without the model's name on it (a card says it below). */ plain?: boolean }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  React.useEffect(() => { setState('loading'); }, [src]);
  return (
    <>
      {state !== 'loaded' ? (
        <span className="wf-thumb-empty is-named" aria-hidden="true" style={{ '--wf-hue': hueOf(label || 'LoRA') } as React.CSSProperties}>
          {label && !small && !plain ? <span>{label}</span> : <Layers size={small ? 14 : 20} strokeWidth={1.75} />}
        </span>
      ) : null}
      {src && state !== 'failed' ? (
        <img className={cn(state === 'loaded' && 'is-loaded')} src={src} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onLoad={() => setState('loaded')} onError={() => setState('failed')} />
      ) : null}
    </>
  );
}
