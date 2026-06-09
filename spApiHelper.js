/**
 * Amazon SP-API helper — Catalog Items v2022-04-01
 *
 * Modern auth (post-2022): only LWA credentials needed.
 * AWS IAM / SigV4 signing is NOT required for catalog & pricing endpoints.
 *
 * Flow:
 *  1. POST to LWA token endpoint with refresh_token → access_token
 *  2. Pass x-amz-access-token header — that's it.
 */

import fetch from 'node-fetch';

// ── Marketplace → { endpoint, region } map ───────────────────────────────────
export const MARKETPLACES = {
  // North America
  US: { id: 'ATVPDKIKX0DER',  name: 'Amazon US',      endpoint: 'sellingpartnerapi-na.amazon.com' },
  CA: { id: 'A2EUQ1WTGCTBG2', name: 'Amazon Canada',  endpoint: 'sellingpartnerapi-na.amazon.com' },
  MX: { id: 'A1AM78C64UM0Y8', name: 'Amazon Mexico',  endpoint: 'sellingpartnerapi-na.amazon.com' },
  // Europe
  UK: { id: 'A1F83G8C2ARO7P', name: 'Amazon UK',      endpoint: 'sellingpartnerapi-eu.amazon.com' },
  DE: { id: 'A1PA6795UKMFR9', name: 'Amazon Germany', endpoint: 'sellingpartnerapi-eu.amazon.com' },
  FR: { id: 'A13V1IB3VIYZZH', name: 'Amazon France',  endpoint: 'sellingpartnerapi-eu.amazon.com' },
  IT: { id: 'APJ6JRA9NG5V4',  name: 'Amazon Italy',   endpoint: 'sellingpartnerapi-eu.amazon.com' },
  ES: { id: 'A1RKKUPIHCS9HS', name: 'Amazon Spain',   endpoint: 'sellingpartnerapi-eu.amazon.com' },
  NL: { id: 'A1805IZSGTT6HS', name: 'Amazon NL',      endpoint: 'sellingpartnerapi-eu.amazon.com' },
  SE: { id: 'A2NODRKZP88ZB9', name: 'Amazon Sweden',  endpoint: 'sellingpartnerapi-eu.amazon.com' },
  // Far East
  JP: { id: 'A1VC38T7YXB528', name: 'Amazon Japan',   endpoint: 'sellingpartnerapi-fe.amazon.com' },
  AU: { id: 'A39IBJ37TRP1C6', name: 'Amazon AU',      endpoint: 'sellingpartnerapi-fe.amazon.com' },
};

// ── LWA: exchange refresh token for access token ─────────────────────────────
export async function getLwaAccessToken({ clientId, clientSecret, refreshToken }) {
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      const d = JSON.parse(text);
      msg = d.error_description ?? d.error ?? text;
    } catch {}
    throw new Error(`LWA token exchange failed (${r.status}): ${msg}`);
  }
  const { access_token } = JSON.parse(text);
  if (!access_token) throw new Error(`LWA response missing access_token: ${text}`);
  return access_token;
}

// ── Fetch one ASIN from the Catalog Items API ─────────────────────────────────
export async function fetchAsinCatalog(asin, accessToken, marketplace) {
  const { endpoint, id: marketplaceId } = marketplace;
  const includedData = 'summaries,images,identifiers,descriptions,productTypes,salesRanks';
  const url = `https://${endpoint}/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=${includedData}`;

  const r    = await fetch(url, { headers: { 'x-amz-access-token': accessToken } });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).errors?.[0]?.message ?? text; } catch {}
    throw new Error(`SP-API ${r.status} for ASIN ${asin}: ${msg}`);
  }
  return JSON.parse(text);
}

// ── Parse raw catalog response into a flat, friendly object ──────────────────
export function parseCatalogItem(raw, marketplaceId) {
  const summaries   = (raw.summaries    ?? []).find(s => s.marketplaceId === marketplaceId) ?? raw.summaries?.[0]   ?? {};
  const images      = (raw.images       ?? []).find(i => i.marketplaceId === marketplaceId) ?? raw.images?.[0]      ?? {};
  const descs       = (raw.descriptions ?? []).find(d => d.marketplaceId === marketplaceId) ?? raw.descriptions?.[0]?? {};
  const identifiers = (raw.identifiers  ?? []).find(i => i.marketplaceId === marketplaceId) ?? raw.identifiers?.[0] ?? {};
  const salesRanks  = (raw.salesRanks   ?? []).find(s => s.marketplaceId === marketplaceId) ?? raw.salesRanks?.[0]  ?? {};

  // Flatten identifier codes: { EAN: [...], UPC: [...], ... }
  const codes = {};
  for (const { identifierType, identifier } of identifiers.identifiers ?? []) {
    const t = identifierType?.toUpperCase();
    if (!codes[t]) codes[t] = [];
    codes[t].push(identifier);
  }

  const primaryImg = (images.images ?? []).find(i => i.variant === 'MAIN')?.link ?? (images.images ?? [])[0]?.link ?? null;
  const allImages  = (images.images ?? []).map(i => i.link).filter(Boolean);

  const topRank = [...(salesRanks.classificationRanks ?? []), ...(salesRanks.displayGroupRanks ?? [])]
    .sort((a, b) => a.rank - b.rank)[0] ?? null;

  return {
    asin:          raw.asin,
    title:         summaries.itemName ?? summaries.itemClassificationName ?? null,
    brand:         summaries.brand ?? null,
    manufacturer:  summaries.manufacturer ?? null,
    color:         summaries.color ?? null,
    size:          summaries.size  ?? null,
    itemClass:     summaries.itemClassification ?? null,
    website:       summaries.websiteDisplayGroup ?? null,
    description:   descs.description ?? null,
    bullet_points: (raw.attributes?.bullet_point ?? []).map(b => b.value ?? b).filter(Boolean),
    primaryImage:  primaryImg,
    images:        allImages,
    identifiers:   codes,
    ean:           (codes.EAN ?? codes.UPC ?? [])[0] ?? null,
    topRank:       topRank ? { rank: topRank.rank, category: topRank.title ?? topRank.classificationId } : null,
  };
}
