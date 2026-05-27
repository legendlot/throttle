import { csopsGet } from './csopsFetch.js';

/**
 * Fetch the issue catalog from csops worker.
 * csopsGet already unwraps data.data, so the response here is { categories: [...] }.
 */
export async function fetchIssueCatalog(session) {
  const r = await csopsGet('getIssueCatalog', {}, session);
  return r?.categories || [];
}
