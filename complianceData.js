/**
 * complianceData.js
 * ─────────────────────────────────────────────────────────────
 * Static reference data for OnBuy compliance patrol.
 * Sources: OnCommerce Protected Brands Policy + OnBuy Prohibited Products Policy.
 */

// ── Protected Brands ───────────────────────────────────────────────────────
// Sellers must have Proof of Authorisation before listing any of these.
// Stored lowercase for case-insensitive matching.
export const PROTECTED_BRANDS = new Set([
  'adidas','air up','akai','amazon','apple','armani','asics','asmodee',
  'audio-technica','australian gold','avlash',
  'babybjorn','babyliss','bandai','barbits','bausch & lomb','bausch and lomb',
  'beats by dr. dre','beats by dre','beats','beko','belkin','bio-oil','birkenstock',
  'black & decker','black and decker','black diamond','blackstrap','blue microphones',
  'body shop','the body shop','bose','braun','breville','burberry',
  'calvin klein','canon','cards against humanity','carhartt','carolina herrera',
  'casio','catan studios','caudalie','cerave','chanel','chloe','clarins','clinique',
  'coach','cobalaplex','color wow','columbia','computek','converse','creed','crocs',
  'cystopro',
  'davidoff','days of wonder','dell','de\'longhi','delonghi','dermalease','dewalt',
  'diesel','dior','disney','disney frozen','dji','dkny','dolce & gabbana',
  'dolce and gabbana','doterra','double dragon','dove','dr martens','drunk elephant',
  'dyson',
  'elemis','elizabeth arden','energizer','enterogenic','ergobaby','estee lauder',
  'fiskars','fitbit','fluke','fossil','frontline','fujifilm','funko',
  'gallup','garnier','gerber','ghostbond','gillette','gloveglu','google','graco',
  'gucci','guess','gund',
  'hasbro','hbo','helen of troy','hisense','hoka','homcom','homme concept','hoover',
  'huawei','hugo boss','hyundai power products',
  'ikea','ion audio','iphone',
  'jabra','jansport','jbl','jelly cat','jellycat','jennifer lopez','jo malone',
  'jo malone london','john frieda','juicy couture',
  'kate spade','kenneth cole','keter','kiehl\'s','kiehls','kirkland signature',
  'kitchen aid','kitchenaid','klean kanteen','koolatron','kylie cosmetics',
  'l.o.l. surprise','lol surprise','labubu','lahrn','lamaze','lancome','larhn',
  'lego','levi\'s','levis','living and home','l\'occitane','loccitane',
  'logitech','l\'oreal','loreal','louis vuitton',
  'mac','magformers','makita','marc jacobs','mattel','maybelline','melissa & doug',
  'melissa and doug','michael kors','miele','molton brown','mypurecore',
  'nature made','needoh','nestle','new balance','nicorette','nike','nikon','ninja',
  'nintendo','noco','nutribullet','nutripaw',
  'obagi','olaplex','olympus','oneplus','oral-b','otterbox','outsunny',
  'paddington bear','panasonic','pandora','patagonia','perricone md','petarmor',
  'petbiotix','peter thomas roth','petsafe','philips','philips accessories',
  'philips avent','phillips','phyto','pioneer','playstation','pokemon','pokémon',
  'power rangers','prada','pro kolin','pro-balance','pro-fibre','protexin',
  'ralph lauren','rapidlash','razer','red castle','reebok','revlon','ring',
  'roberts','rubie\'s','rubies',
  'safeguard','samsung','sandisk','seagate','seastone','sennheiser','seresto',
  'shiseido','sketchers','skullcandy','smeg','snoopy','sol de janeiro','songmics',
  'sony','speck','speedo','spigen','squishmallows','stanley','star wars','starlock',
  'starlock max','starlock plus','stone island','strivectin','sudoo','supergoop',
  'the north face','north face','thermopro','timberland','time2','tom ford',
  'tommy hilfiger','tower','tp-link','tplink','transformers','true religion',
  'under armour',
  'valentino','versace','victoria secret','victoria\'s secret','vidaxl',
  'volkswagen','vonhaus','vonshef',
  'warner brothers','watermans','white fox',
  'xiaomi',
  'yogi tea','yumove','yves saint laurent','ysl',
  'z-edge','zeus sleep','zippo','zoom',
]);

// ── Prohibited Product Keyword Patterns ───────────────────────────────────
// Each entry: { pattern: RegExp, reason: string }
// Matched against lowercased listing title + product type.
export const PROHIBITED_PATTERNS = [
  // Counterfeit / replica language
  { pattern: /\b(counterfeit|replica|fake|knockoff|knock-off|imitation|bootleg)\b/i,
    reason: 'Counterfeit/replica language (IPR §10.1)' },

  // Weapons
  { pattern: /\b(stun gun|taser|knuckleduster|brass knuckle|flick knife|switchblade|zombie knife|butterfly knife|balisong|push dagger|shuriken|throwing star|death star|kusari|kyoketsu)\b/i,
    reason: 'Prohibited weapon (§11)' },

  // Firearms / ammunition
  { pattern: /\b(silencer|gun silencer|firearm|pistol|rifle|shotgun|ammunition|ammo|grenade|explosive)\b/i,
    reason: 'Firearms/ammunition (§8)' },

  // Drugs / narcotics
  { pattern: /\b(narcotics|cocaine|heroin|mdma|methamphetamine|meth|legal high|research chemical|cbd oil|thc|cannabis oil|cannabidiol)\b/i,
    reason: 'Drug/controlled substance (§6)' },

  // Ivory / wildlife
  { pattern: /\b(ivory|elephant tusk|tiger bone|bear bile|pangolin|rhino horn)\b/i,
    reason: 'Illegal wildlife trade (§1)' },

  // Shock collars
  { pattern: /\b(shock collar|prong collar|pinch collar|electrostatic collar)\b/i,
    reason: 'Prohibited animal device (§1.4)' },

  // Pirated / unauthorised software
  { pattern: /\b(oem key|msdn key|licence key|license key|product key|windows key|office key|adobe key|activation code)\b.*\b(email|download|delivered|digital)\b/i,
    reason: 'Unauthorised software key (§5.6)' },

  // Tear gas / mace
  { pattern: /\b(tear gas|pepper spray|mace spray)\b/i,
    reason: 'Prohibited weapon (§8.5)' },

  // Signal jammers
  { pattern: /\b(signal jammer|gps jammer|phone jammer|mobile jammer)\b/i,
    reason: 'Radio jamming device (§16.5)' },

  // Recalled / non-CE products phrasing (weak signal, flag only if combined)
  { pattern: /\bnon[- ]?ce\b|\bno ce mark\b|\buncertified\b/i,
    reason: 'Missing CE certification claimed (§15.6)' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalise a brand string: trim, lowercase, collapse whitespace.
 */
export function normaliseBrand(str) {
  return (str || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Check a listing against both rules.
 * @param {object} listing  OnBuy listing object
 * @returns {{ violation: boolean, reason: string|null, type: string|null }}
 */
export function checkListing(listing) {
  const brand = normaliseBrand(listing.brand || listing.manufacturer || '');
  const title = (listing.name || listing.title || listing.product_name || '').toLowerCase();
  const text  = `${title} ${brand}`;

  // 1. Protected brand check
  if (brand && PROTECTED_BRANDS.has(brand)) {
    return {
      violation: true,
      type: 'protected_brand',
      reason: `Brand "${listing.brand}" is on the OnCommerce Protected Brands list — requires Proof of Authorisation`,
    };
  }

  // Also check if protected brand name appears in the title when brand field is blank
  if (!brand) {
    for (const protectedBrand of PROTECTED_BRANDS) {
      const escaped = protectedBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(title)) {
        return {
          violation: true,
          type: 'protected_brand_in_title',
          reason: `Protected brand "${protectedBrand}" found in listing title — requires Proof of Authorisation`,
        };
      }
    }
  }

  // 2. Prohibited product keyword check
  for (const { pattern, reason } of PROHIBITED_PATTERNS) {
    if (pattern.test(text)) {
      return { violation: true, type: 'prohibited_product', reason };
    }
  }

  return { violation: false, type: null, reason: null };
}
