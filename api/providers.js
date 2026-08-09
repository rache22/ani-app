/**
 * ANI — /api/providers
 * Vercel Serverless Function (Node 18+, ESM — package.json has "type": "module").
 *
 * Contract: this endpoint ALWAYS answers 200 with the same JSON shape, so the SPA
 * never has to branch on transport errors.
 *
 *   { status: "online",
 *     source: "google_places" | "fallback_live",
 *     reason?: string,                       // only present on fallback
 *     generated_at: ISO8601,
 *     query: { lat, lng, radius, lang },
 *     count: number,
 *     providers: [ … ] }
 *
 * The Google key lives ONLY in process.env.GOOGLE_PLACES_API_KEY. It is never
 * echoed into a response, a log line, or an error message.
 *
 * Query params:  ?lat= &lng= &radius= &lang=he|en
 */

const DEFAULT_LAT = 32.0785;      // Tel Aviv seafront
const DEFAULT_LNG = 34.7680;
const DEFAULT_RADIUS = 2500;      // metres
const UPSTREAM_TIMEOUT_MS = 5000;   // per upstream attempt
const TOTAL_BUDGET_MS = 11000;      // whole handler, well inside vercel.json maxDuration

/* Google place types -> ANI categories */
const TYPE_TO_CATEGORY = {
  hair_salon: 'hair',
  hair_care: 'hair',
  barber_shop: 'barber',
  beauty_salon: 'makeup',
  nail_salon: 'nails',
  spa: 'massage',
  massage: 'massage',
  wellness_center: 'massage',
  skin_care_clinic: 'makeup',
};

/* ------------------------------------------------------------------ utils */

function num(value, fallback, min, max) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function categoriesFrom(types) {
  const out = [];
  for (const type of types || []) {
    const cat = TYPE_TO_CATEGORY[type];
    if (cat && !out.includes(cat)) out.push(cat);
  }
  return out.length ? out : ['hair'];
}

/**
 * fetch with a hard timeout so a slow upstream can never hang the function.
 * `budgetMs` is the remaining whole-handler budget: two sequential 5s attempts
 * must never add up past maxDuration, or Vercel kills us before the fallback.
 */
async function fetchWithTimeout(url, options, budgetMs) {
  const ms = Math.max(600, Math.min(UPSTREAM_TIMEOUT_MS, budgetMs == null ? UPSTREAM_TIMEOUT_MS : budgetMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------- fallback dataset */
/**
 * Deterministic demo supply, positioned relative to the caller so the map and
 * the distance calculations still look right without any upstream data.
 * Flagged claimed:false — the SPA renders these as claimable shadow profiles.
 */
function fallbackProviders(lat, lng) {
  const seed = [
    { dLat:  0.0031, dLng: -0.0042, he: 'סטודיו ליאור',        en: 'Studio Lior',          cat: 'hair',    rating: 4.7,  reviews: 1204, addr: { he: 'דיזנגוף 189, תל אביב', en: 'Dizengoff 189, Tel Aviv' },    open: true,  price: 180 },
    { dLat: -0.0055, dLng:  0.0018, he: 'NailBar רוטשילד',      en: 'NailBar Rothschild',   cat: 'nails',   rating: 4.6,  reviews:  892, addr: { he: 'רוטשילד 22, תל אביב',  en: 'Rothschild 22, Tel Aviv' },    open: true,  price: 160 },
    { dLat:  0.0074, dLng:  0.0026, he: 'Glow Spa נווה צדק',    en: 'Glow Spa Neve Tzedek', cat: 'massage', rating: 4.75, reviews:  640, addr: { he: 'שבזי 44, תל אביב',     en: 'Shabazi 44, Tel Aviv' },       open: false, price: 320 },
    { dLat: -0.0092, dLng: -0.0011, he: 'The Barber Room TLV',  en: 'The Barber Room TLV',  cat: 'barber',  rating: 4.9,  reviews: 2013, addr: { he: 'פלורנטין 8, תל אביב',  en: 'Florentin 8, Tel Aviv' },      open: true,  price:  90 },
    { dLat:  0.0043, dLng:  0.0061, he: 'מספרת כרמל',           en: 'Carmel Hair',          cat: 'hair',    rating: 4.5,  reviews:  318, addr: { he: 'הכרמל 12, תל אביב',    en: 'HaCarmel 12, Tel Aviv' },      open: true,  price: 150 },
    { dLat: -0.0027, dLng:  0.0058, he: 'Lash Lab',             en: 'Lash Lab',             cat: 'lashes',  rating: 4.8,  reviews:  221, addr: { he: 'בן יהודה 90, תל אביב', en: 'Ben Yehuda 90, Tel Aviv' },    open: true,  price: 190 },
    { dLat:  0.0088, dLng: -0.0035, he: 'Beauty Point הנמל',    en: 'Beauty Point Port',    cat: 'makeup',  rating: 4.55, reviews:  410, addr: { he: 'נמל תל אביב',          en: 'Tel Aviv Port' },              open: false, price: 260 },
    { dLat: -0.0064, dLng: -0.0072, he: 'ספא לב יפו',           en: 'Jaffa Heart Spa',      cat: 'massage', rating: 4.65, reviews:  537, addr: { he: 'יפת 30, יפו',          en: 'Yefet 30, Jaffa' },            open: true,  price: 300 },
  ];

  return seed.map((s, i) => ({
    id: 'fb_' + (i + 1),
    place_id: null,
    name: s.he,
    name_he: s.he,
    name_en: s.en,
    category: s.cat,
    categories: [s.cat],
    rating: s.rating,
    reviews: s.reviews,
    lat: +(lat + s.dLat).toFixed(6),
    lng: +(lng + s.dLng).toFixed(6),
    address: s.addr.he,
    address_he: s.addr.he,
    address_en: s.addr.en,
    open_now: s.open,
    price_from_ils: s.price,
    claimed: false,
    source: 'fallback_live',
  }));
}

function sendFallback(res, lat, lng, radius, lang, reason) {
  const providers = fallbackProviders(lat, lng);
  // Short cache: a fallback response should recover quickly once the key works.
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  res.setHeader('X-ANI-Source', 'fallback_live');
  return res.status(200).json({
    status: 'online',
    source: 'fallback_live',
    reason,
    generated_at: new Date().toISOString(),
    query: { lat, lng, radius, lang },
    count: providers.length,
    providers,
  });
}

/* --------------------------------------------- Google Places (New API) */

async function searchPlacesNew(key, lat, lng, radius, lang, budgetMs) {
  const response = await fetchWithTimeout(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.rating',
          'places.userRatingCount',
          'places.types',
          'places.primaryType',
          'places.currentOpeningHours.openNow',
        ].join(','),
      },
      body: JSON.stringify({
        includedTypes: ['beauty_salon', 'hair_salon', 'nail_salon', 'spa', 'barber_shop'],
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        languageCode: lang,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius },
        },
      }),
    },
    budgetMs
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('places_new_http_' + response.status + ' ' + body.slice(0, 160));
  }

  const data = await response.json();
  return (data.places || [])
    .filter((p) => p.location)
    .map((p) => {
      const name = (p.displayName && p.displayName.text) || 'Salon';
      const types = (p.types || []).concat(p.primaryType ? [p.primaryType] : []);
      const cats = categoriesFrom(types);
      return {
        id: p.id || null,
        place_id: p.id || null,
        name,
        name_he: name,
        name_en: name,
        category: cats[0],
        categories: cats,
        rating: p.rating || 0,
        reviews: p.userRatingCount || 0,
        lat: p.location.latitude,
        lng: p.location.longitude,
        address: p.formattedAddress || '',
        address_he: p.formattedAddress || '',
        address_en: p.formattedAddress || '',
        open_now: !!(p.currentOpeningHours && p.currentOpeningHours.openNow),
        price_from_ils: null,
        claimed: false,
        source: 'google_places',
      };
    });
}

/* ------------------------------------------ Google Places (legacy API) */
/* Many existing keys only have the legacy Places API enabled. Try it before
   giving up, so a working key is never wasted. */

async function searchPlacesLegacy(key, lat, lng, radius, lang, budgetMs) {
  const url =
    'https://maps.googleapis.com/maps/api/place/nearbysearch/json' +
    `?location=${lat},${lng}&radius=${radius}&type=beauty_salon&language=${lang}&key=${encodeURIComponent(key)}`;

  const response = await fetchWithTimeout(url, { method: 'GET' }, budgetMs);
  if (!response.ok) throw new Error('places_legacy_http_' + response.status);

  const data = await response.json();
  if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error('places_legacy_' + data.status);
  }

  return (data.results || [])
    .filter((p) => p.geometry && p.geometry.location)
    .map((p) => {
      const cats = categoriesFrom(p.types);
      return {
        id: p.place_id || null,
        place_id: p.place_id || null,
        name: p.name,
        name_he: p.name,
        name_en: p.name,
        category: cats[0],
        categories: cats,
        rating: p.rating || 0,
        reviews: p.user_ratings_total || 0,
        lat: p.geometry.location.lat,
        lng: p.geometry.location.lng,
        address: p.vicinity || p.formatted_address || '',
        address_he: p.vicinity || '',
        address_en: p.vicinity || '',
        open_now: !!(p.opening_hours && p.opening_hours.open_now),
        price_from_ils: null,
        claimed: false,
        source: 'google_places',
      };
    });
}

/* ---------------------------------------------------------- handler */

export default async function handler(req, res) {
  /* CORS — set before anything can throw, so even a failure path is reachable
     from another origin. */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ status: 'error', error: 'method_not_allowed' });
  }

  const q = req.query || {};
  const lat = num(q.lat, DEFAULT_LAT, -90, 90);
  const lng = num(q.lng, DEFAULT_LNG, -180, 180);
  const radius = Math.round(num(q.radius, DEFAULT_RADIUS, 100, 50000));
  const lang = q.lang === 'en' ? 'en' : 'he';

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key || !String(key).trim()) {
    return sendFallback(res, lat, lng, radius, lang, 'missing_api_key');
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError = '';

  try {
    const providers = await searchPlacesNew(String(key).trim(), lat, lng, radius, lang, deadline - Date.now());
    if (providers.length) {
      // Cache at the edge: protects the Places budget and keeps p95 low.
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
      res.setHeader('X-ANI-Source', 'google_places');
      return res.status(200).json({
        status: 'online',
        source: 'google_places',
        generated_at: new Date().toISOString(),
        query: { lat, lng, radius, lang },
        count: providers.length,
        providers,
      });
    }
    lastError = 'places_new_empty';
  } catch (err) {
    lastError = String(err && err.message ? err.message : err).slice(0, 200);
    console.error('[api/providers] places (new) failed:', lastError);
  }

  try {
    if (Date.now() >= deadline) throw new Error('budget_exhausted');
    const providers = await searchPlacesLegacy(String(key).trim(), lat, lng, radius, lang, deadline - Date.now());
    if (providers.length) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
      res.setHeader('X-ANI-Source', 'google_places');
      return res.status(200).json({
        status: 'online',
        source: 'google_places',
        generated_at: new Date().toISOString(),
        query: { lat, lng, radius, lang },
        count: providers.length,
        providers,
      });
    }
    lastError = lastError || 'places_legacy_empty';
  } catch (err) {
    lastError = String(err && err.message ? err.message : err).slice(0, 200);
    console.error('[api/providers] places (legacy) failed:', lastError);
  }

  /* Upstream unavailable, misconfigured or empty — still a 200, still usable. */
  return sendFallback(res, lat, lng, radius, lang, lastError || 'upstream_unavailable');
}
