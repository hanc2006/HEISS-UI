import { apiJson } from './api';

/** One LoRA on Civitai, as the server shapes it (server/civitai-api.js loraRows). */
export type CivitaiLora = {
  id: string;
  modelId: number;
  versionId: number;
  fileId: number;
  name: string;
  version: string;
  creator: string;
  baseModel: string;
  nsfw: boolean;
  file: string;
  bytes: number;
  trainedWords: string[];
  downloads: number;
  preview: string;
  page: string;
};

export type CivitaiSearch = {
  rows: CivitaiLora[];
  nextCursor: string;
  bases: string[];
  site?: string;
  unsupported?: boolean;
};

export type CivitaiStatus = {
  set: boolean;
  source: '' | 'settings' | 'environment';
  editable: boolean;
  key: string;
  hint?: string;
  mature: boolean;
  site: string;
};

export function searchCivitaiLoras(params: { query: string; family: string; model: string; cursor?: string }, signal?: AbortSignal) {
  const query = new URLSearchParams({ query: params.query, family: params.family, model: params.model, cursor: params.cursor || '' });
  return apiJson<CivitaiSearch>(`/api/civitai/loras?${query}`, { signal });
}

export function loadCivitaiStatus() {
  return apiJson<CivitaiStatus>('/api/settings/civitai');
}

export function saveCivitaiSettings(body: { token?: string; mature?: boolean }) {
  return apiJson<CivitaiStatus>('/api/settings/civitai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
