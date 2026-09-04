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

  // ── §1 Animals and Wildlife ──────────────────────────────────────────────

  // §1.1 Illegal wildlife trade parts
  { pattern: /\b(pangolin|marine turtle|tiger bone|bear bile|rhino horn|elephant tusk|elephant ivory|elk ivory|whale bone|sea turtle|tortoiseshell)\b/i,
    reason: 'Illegal wildlife trade part (§1.1)' },

  // §1.2 Animal snares / catching traps
  { pattern: /\b(animal snare|hunting snare|leg hold trap|leghold trap|body grip trap|conibear trap|live catch trap for wildlife|animal catching trap|poaching trap)\b/i,
    reason: 'Animal snare or harmful catching device (§1.2)' },

  // §1.3 / §1.4 Harmful animal collars
  { pattern: /\b(prong collar|pinch collar|spike collar|inward[- ]?facing spike|shock collar|electrostatic collar|electric training collar|e-collar dog shock)\b/i,
    reason: 'Harmful/prohibited animal collar (§1.3–1.4)' },

  // §1.5 Glue traps
  { pattern: /\b(glue trap|glue board|sticky board rat|sticky board mouse|glue rodent trap|sticky rodent)\b/i,
    reason: 'Glue trap for rodents/vertebrates (§1.5)' },

  // §1.6 Human remains / body parts
  { pattern: /\b(human skull|human bone|human remains|human body part|human teeth for sale|human hair scalp|human organ)\b/i,
    reason: 'Human remains or body parts (§1.6)' },

  // §1.7 Ivory products
  { pattern: /\b(ivory trinket|ivory carving|ivory figurine|ivory tusk|ivory jewellery|ivory jewelry|made of ivory|real ivory)\b/i,
    reason: 'Ivory product (§1.7)' },

  // §1.8 Live animals / pets / reptiles
  { pattern: /\b(live snake|live reptile|live parrot|live bird for sale|live turtle|live monkey|live exotic animal|live pet for sale|live fish exotic)\b/i,
    reason: 'Live animal/pet/reptile listing (§1.8)' },

  // §1.9 Trophy hunting mounts
  { pattern: /\b(trophy mount|mounted animal head|mounted deer head|mounted bear head|mounted lion|taxidermy trophy|hunting trophy head|wall mount animal head)\b/i,
    reason: 'Mounted trophy animal head (§1.9)' },

  // §1.10 Animal abuse products / media
  { pattern: /\b(animal fighting|dogfighting|cockfighting|animal abuse video|animal cruelty video|dog baiting)\b/i,
    reason: 'Products promoting animal abuse (§1.10)' },

  // §1.11 Taxidermy (without licence — flagged for review)
  { pattern: /\b(taxidermy for sale|stuffed animal real|preserved animal body|mounted real animal|real stuffed bird|real stuffed fox|real stuffed wolf)\b/i,
    reason: 'Taxidermy — requires valid seller licence (§1.11)' },

  // §1.12 Wildlife items
  { pattern: /\b(wild bird egg|bird egg collection|eagle feather|osprey feather|falcon feather|protected bird feather)\b/i,
    reason: 'Wildlife items (§1.12)' },

  // ── §2 Artefacts and Antiquities ─────────────────────────────────────────

  // §2.1 Antiquities / archaeological items
  { pattern: /\b(antiquity|antiquities|archaeological artefact|archaeological artifact|ancient roman|ancient greek coin|ancient egyptian|roman era|roman antiquity|medieval relic|pre-columbian)\b/i,
    reason: 'Antiquity or archaeological object (§2.1)' },

  // §2.2 Native American arts (uncertified)
  { pattern: /\b(navajo jewellery|navajo jewelry|indian jewellery fake|native american arts reproduction|imitation navajo|fake native american)\b/i,
    reason: 'Uncertified Native American arts/crafts (§2.2)' },

  // ── §3 Car & Motorbike Parts ──────────────────────────────────────────────

  // §3.3 Seat belt alarm stoppers / clips
  { pattern: /\b(seat belt alarm stopper|seatbelt alarm clip|seat belt buckle silencer|seat belt clip stopper|seat belt cheat clip|seatbelt override clip)\b/i,
    reason: 'Seat belt alarm stopper (§3.3)' },

  // §3.5 Second-hand / breakup airbags
  { pattern: /\b(used airbag|second hand airbag|secondhand airbag|salvage airbag|pulled airbag|breaker airbag|junkyard airbag)\b/i,
    reason: 'Second-hand vehicle airbag — UN Hazard Class 1 (§3.5)' },

  // ── §8 Weapons ────────────────────────────────────────────────────────────

  // §8 Bladed / offensive weapons
  { pattern: /\b(flick knife|switchblade|zombie knife|butterfly knife|balisong|push dagger|shuriken|throwing star|kusari|kyoketsu|knuckleduster|brass knuckle|swordstick|sword cane|disguised blade)\b/i,
    reason: 'Prohibited bladed/offensive weapon (§8)' },

  // §8 Stun devices
  { pattern: /\b(stun gun|taser|electric shock weapon|cattle prod weapon)\b/i,
    reason: 'Prohibited stun weapon (§8)' },

  // §8 Tear gas / irritant sprays
  { pattern: /\b(tear gas|cs gas|cn gas|pepper spray|mace spray|irritant spray)\b/i,
    reason: 'Prohibited irritant spray/tear gas (§8)' },

  // §8 Firearms / ammunition / suppressors
  { pattern: /\b(firearm|handgun|pistol|revolver|rifle|shotgun|machine gun|submachine gun|gun silencer|suppressor|ammunition|live ammo|bullet cartridge|grenade|explosive device)\b/i,
    reason: 'Firearms, ammunition or explosive (§8)' },

  // ── §6 Drugs / Controlled Substances ─────────────────────────────────────

  { pattern: /\b(cocaine|heroin|mdma|methamphetamine|meth crystal|fentanyl|legal high|research chemical|novel psychoactive|psychedelic|lsd|ketamine powder|ghb drug|thc oil|cannabis oil|cannabidiol edible|cbd edible|weed drug)\b/i,
    reason: 'Drug or controlled substance (§6)' },

  // ── §5 Intellectual Property / Software ──────────────────────────────────

  { pattern: /\b(oem key|msdn key|licence key|license key|product key|windows key|office key|adobe key|activation code)\b.*\b(email|download|delivered|digital|instant)\b/i,
    reason: 'Unauthorised software licence key (§5.6)' },

  // ── §10 Counterfeit / Replica ─────────────────────────────────────────────

  { pattern: /\b(counterfeit|replica watch|fake designer|knockoff|knock-off|imitation branded|bootleg)\b/i,
    reason: 'Counterfeit/replica product (§10)' },

  // ── §16 Radio / Signal Devices ───────────────────────────────────────────

  { pattern: /\b(signal jammer|gps jammer|phone jammer|mobile jammer|wifi jammer|frequency jammer|radio jammer)\b/i,
    reason: 'Signal jamming device (§16)' },

  // ── §15 Safety / Certification ───────────────────────────────────────────

  { pattern: /\bnon[- ]?ce\b|\bno ce mark\b|\bno ece cert|\bno capa cert|\blacks certification\b/i,
    reason: 'Missing required safety certification (§15)' },
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
