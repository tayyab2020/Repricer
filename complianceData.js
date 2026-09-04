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

  // ══════════════════════════════════════════════════════════════════════════
  // §1  ANIMALS AND WILDLIFE
  // ══════════════════════════════════════════════════════════════════════════

  // §1.1  Illegal wildlife trade parts (pangolin, sea turtle, tiger, bear, rhino…)
  { pattern: /\b(pangolin scale|pangolin part|marine turtle|sea turtle shell|tiger bone|tiger claw|bear bile|bear paw|rhino horn|elephant tusk|elephant ivory|elk ivory|whale bone|whale ivory|tortoiseshell product|bushmeat)\b/i,
    reason: 'Illegal wildlife trade part (§1.1)' },

  // §1.2  Animal snares / traps that harm during catching
  { pattern: /\b(animal snare|hunting snare|leg[- ]hold trap|leghold trap|body[- ]grip trap|conibear trap|spring trap for animals|jaw trap|gin trap|poaching snare)\b/i,
    reason: 'Animal snare or harmful catching trap (§1.2)' },

  // §1.3  Dog prong / pinch / inward-spike collars
  { pattern: /\b(prong collar|pinch collar|spike collar|inward[- ]?facing spike collar|metal spike dog collar)\b/i,
    reason: 'Harmful dog collar with inward spikes (§1.3)' },

  // §1.4  Electrostatic shock collars
  { pattern: /\b(shock collar|electrostatic collar|electric training collar|e-collar shock|anti-bark shock collar)\b/i,
    reason: 'Electrostatic shock collar (§1.4)' },

  // §1.5  Glue traps for rodents / vertebrates
  { pattern: /\b(glue trap|glue board|sticky board rat|sticky board mouse|glue rodent trap|sticky trap rodent)\b/i,
    reason: 'Glue trap for rodents/vertebrates (§1.5)' },

  // §1.6  Human remains / body parts (hair wigs are allowed)
  { pattern: /\b(human skull|human bone|human remains|human body part|human organ for sale|human teeth sale|placenta for sale|human tissue)\b/i,
    reason: 'Human remains or body parts (§1.6)' },

  // §1.7  Ivory products
  { pattern: /\b(ivory trinket|ivory carving|ivory figurine|ivory tusk|ivory jewellery|ivory jewelry|real ivory|made from ivory|antique ivory)\b/i,
    reason: 'Ivory or ivory-derived product (§1.7)' },

  // §1.8  Live animals / pets / reptiles (live bait worms are allowed)
  { pattern: /\b(live snake for sale|live reptile for sale|live parrot for sale|live bird for sale|live turtle for sale|live monkey|live exotic animal|live scorpion|live tarantula for sale|live frog for sale)\b/i,
    reason: 'Live animal / pet / reptile listing (§1.8)' },

  // §1.9  Mounted trophy heads from hunting
  { pattern: /\b(trophy mount|mounted animal head|mounted deer head|mounted bear head|mounted lion head|hunting trophy|taxidermy trophy head)\b/i,
    reason: 'Mounted trophy animal head (§1.9)' },

  // §1.10  Products promoting animal abuse
  { pattern: /\b(animal fighting|dogfighting|dog fight|cockfighting|cock fight|animal abuse video|animal cruelty media|dog baiting)\b/i,
    reason: 'Products promoting animal abuse (§1.10)' },

  // §1.11  Taxidermy (requires approved seller licence — flagged for review)
  { pattern: /\b(real taxidermy|taxidermy for sale|stuffed real animal|preserved real animal|mounted real fox|mounted real wolf|mounted real badger|real stuffed bird)\b/i,
    reason: 'Taxidermy — requires valid licence to sell (§1.11)' },

  // §1.12  Wildlife items (wild bird eggs, protected feathers)
  { pattern: /\b(wild bird egg|protected bird egg|eagle feather sale|osprey feather|peregrine feather|protected raptor feather|kite feather)\b/i,
    reason: 'Wildlife items including wild bird eggs (§1.12)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §2  ARTEFACTS AND ANTIQUITIES
  // ══════════════════════════════════════════════════════════════════════════

  // §2.1  Antiquities / archaeological objects
  { pattern: /\b(antiquity for sale|antiquities for sale|archaeological artefact|archaeological artifact|roman artefact|ancient greek coin|ancient egyptian artefact|roman coin found|medieval relic|pre-columbian artifact|anglo-saxon find)\b/i,
    reason: 'Antiquity or archaeological object (§2.1)' },

  // §2.2  Uncertified Native American arts / crafts
  { pattern: /\b(fake navajo|imitation navajo|reproduction navajo|fake native american jewellery|fake native american jewelry|uncertified indian jewellery)\b/i,
    reason: 'Uncertified Native American arts/crafts (§2.2)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §3  CAR & MOTORBIKE PARTS
  // ══════════════════════════════════════════════════════════════════════════

  // §3.3  Seat belt alarm stoppers / override clips
  { pattern: /\b(seat belt alarm stopper|seatbelt alarm clip|seat belt buckle silencer|seat belt cheat clip|seatbelt override|seat belt bypass)\b/i,
    reason: 'Seat belt alarm stopper / bypass clip (§3.3)' },

  // §3.5  Second-hand / salvage airbags (UN Hazard Class 1)
  { pattern: /\b(used airbag|second[- ]hand airbag|secondhand airbag|salvage airbag|pulled airbag|breaker airbag|junkyard airbag|scrap airbag)\b/i,
    reason: 'Second-hand vehicle airbag — UN Hazard Class 1 (§3.5)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §4  CHEMICALS, ACIDS AND EXPLOSIVE MATERIALS
  // ══════════════════════════════════════════════════════════════════════════

  // §4  Strong acids
  { pattern: /\b(sulphuric acid|sulfuric acid|hydrochloric acid|nitric acid|hydrofluoric acid|concentrated acid for sale|drain acid)\b/i,
    reason: 'Prohibited strong acid (§4)' },

  // §4  Explosive / combustible materials and precursors
  { pattern: /\b(black powder for sale|explosive fuse|det cord|detonator|thermite|flash powder|ammonium nitrate explosive|explosive precursor|anfo explosive|gun powder for sale)\b/i,
    reason: 'Explosive or combustible material (§4)' },

  // §4  Biocides / pesticides (non-approved)
  { pattern: /\b(unlicensed pesticide|banned pesticide|illegal biocide|prohibited herbicide|methyl bromide fumigant|carbofuran pesticide|endosulfan)\b/i,
    reason: 'Prohibited pesticide or biocide (§4)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §5  DRUGS AND DRUG PARAPHERNALIA
  // ══════════════════════════════════════════════════════════════════════════

  // §5  Controlled drugs / narcotics
  { pattern: /\b(cocaine|crack cocaine|heroin|mdma|ecstasy tablet|methamphetamine|crystal meth|fentanyl drug|lsd tab|ketamine drug|ghb drug|mephedrone|spice drug|bath salt drug|novel psychoactive|legal high drug|research chemical drug)\b/i,
    reason: 'Controlled drug / narcotic (§5)' },

  // §5  Drug paraphernalia
  { pattern: /\b(bong for weed|crack pipe|meth pipe|drug pipe|cocaine straw|drug snorting kit|drug rolling kit|pill press mould|drugs paraphernalia|drug testing kit concealment)\b/i,
    reason: 'Drug paraphernalia (§5)' },

  // §5  Food / sweets designed to resemble drugs or tobacco (for children)
  { pattern: /\b(candy cigarette|sweet cigarette|lollipop cigarette|candy shaped like drugs|sweet resembling drugs)\b/i,
    reason: 'Sweets/food designed to resemble drugs or tobacco (§5)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §6  ELECTRICAL AND ELECTRONIC EQUIPMENT
  // ══════════════════════════════════════════════════════════════════════════

  // §6  Prohibited laser classes (Class 3B / Class 4 handheld lasers)
  { pattern: /\b(class 3b laser|class 4 laser|class iv laser|class iiib laser|high power laser pointer|1000mw laser|2000mw laser|5000mw laser|burning laser pointer)\b/i,
    reason: 'Prohibited high-power laser (§6)' },

  // §6  Child-appealing / novelty lighters designed to look like toys
  { pattern: /\b(novelty lighter gun|gun shaped lighter|toy gun lighter|cartoon lighter for kids|toy shaped lighter|child appeal lighter)\b/i,
    reason: 'Novelty lighter appealing to children (§6)' },

  // §6  Signal jamming / radio interference devices
  { pattern: /\b(signal jammer|gps jammer|phone jammer|mobile jammer|wifi jammer|frequency jammer|radio jammer|drone jammer)\b/i,
    reason: 'Signal jamming device (§6)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §7  FINANCIAL PRODUCTS
  // ══════════════════════════════════════════════════════════════════════════

  // §7  Counterfeit currency / stamps / documents
  { pattern: /\b(counterfeit money|fake banknote|fake pound note|fake currency|replica currency|counterfeit stamp|forged document|fake passport|fake id card|fake driving licence|counterfeit voucher)\b/i,
    reason: 'Counterfeit currency, stamps or documents (§7)' },

  // §7  Pyramid scheme / get-rich-quick material
  { pattern: /\b(pyramid scheme kit|ponzi scheme|multi-level marketing fraud|mlm get rich|work from home scam kit)\b/i,
    reason: 'Financial fraud / pyramid scheme materials (§7)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §8  FOOD AND DRINK
  // ══════════════════════════════════════════════════════════════════════════

  // §8  Food / drink containing illegal drugs
  { pattern: /\b(cannabis edible|weed brownie|thc edible|thc gummy|cannabis cookie|space cake|marijuana food|cbd gummy high|drug infused food)\b/i,
    reason: 'Food or drink containing illegal drug substance (§8)' },

  // §8  Unsafe alcohol (non-duty paid / counterfeit spirits)
  { pattern: /\b(counterfeit spirits|fake vodka|fake whisky|bootleg alcohol|illicit alcohol|homemade spirits for sale|poteen for sale|moonshine for sale)\b/i,
    reason: 'Counterfeit or unsafe alcohol (§8)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §9  GAMBLING
  // ══════════════════════════════════════════════════════════════════════════

  // §9  Unlicensed gambling equipment / marked cards / cheating devices
  { pattern: /\b(marked playing cards|casino cheating device|card marking kit|roulette cheating|slot machine cheat|gambling cheat device|rigged dice)\b/i,
    reason: 'Gambling cheating / unlicensed device (§9)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §10  HAZARDOUS MATERIALS
  // ══════════════════════════════════════════════════════════════════════════

  // §10  Asbestos-containing products
  { pattern: /\b(asbestos tile|asbestos sheet|asbestos insulation|asbestos rope|asbestos cement|asbestos gasket|contains asbestos)\b/i,
    reason: 'Asbestos-containing product (§10)' },

  // §10  Radioactive / nuclear materials
  { pattern: /\b(radioactive material|uranium for sale|thorium for sale|radium for sale|radioactive ore|nuclear material|radioactive isotope)\b/i,
    reason: 'Radioactive / nuclear material (§10)' },

  // §10  Prohibited fireworks (professional-grade sold to public)
  { pattern: /\b(category f4 firework|professional firework for public|display firework unlicensed|1.3g firework|1.4g firework category f3 adult)\b/i,
    reason: 'Prohibited category firework (§10)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §11  INTELLECTUAL PROPERTY
  // ══════════════════════════════════════════════════════════════════════════

  // §11  Counterfeit / replica branded goods
  { pattern: /\b(counterfeit|replica watch|fake designer|fake branded|knockoff branded|knock-off designer|imitation branded|bootleg dvd|pirated dvd|pirated game)\b/i,
    reason: 'Counterfeit or replica branded product (§11)' },

  // §11  Unauthorised software licence keys
  { pattern: /\b(oem key|msdn key|licence key|license key|product key|windows activation key|office activation key|adobe activation key|software key email)\b.*\b(email|download|delivered digitally|instant delivery)\b/i,
    reason: 'Unauthorised software licence key (§11)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §12  MEDICAL DEVICES AND MEDICINES
  // ══════════════════════════════════════════════════════════════════════════

  // §12  Prescription-only medicines sold without prescription
  { pattern: /\b(prescription medication without prescription|rx drug online|controlled medication buy|buy tramadol online|buy diazepam online|buy codeine online|buy zopiclone online|buy modafinil online|prescription only medicine|pom drug)\b/i,
    reason: 'Prescription-only medicine sold without prescription (§12)' },

  // §12  Unlicensed medical devices / unproven health claims
  { pattern: /\b(unlicensed medical device|unregistered medical device|cures cancer|cure diabetes|cure covid|miracle cure|guaranteed weight loss pill|banned diet pill|sibutramine|dnp weight loss|dinitrophenol)\b/i,
    reason: 'Unlicensed medical device or unproven cure (§12)' },

  // §12  Recalled / banned products
  { pattern: /\b(recalled product|product recall|safety recall item|banned product uk)\b/i,
    reason: 'Product subject to safety recall (§12)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §13  OFFENSIVE MATERIAL
  // ══════════════════════════════════════════════════════════════════════════

  // §13  Hate speech / discriminatory / Nazi memorabilia
  { pattern: /\b(nazi memorabilia|ss insignia|nazi uniform|third reich|kkk merchandise|kkk robe|white supremacy merch|hate speech material|neo-nazi|antisemitic)\b/i,
    reason: 'Offensive / hate material (§13)' },

  // §13  Child sexual abuse / CSAM references
  { pattern: /\b(child exploitation|csam|child abuse material|lolita hentai explicit|child sexual)\b/i,
    reason: 'Prohibited offensive material — CSAM reference (§13)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §14  PLANTS AND SEEDS
  // ══════════════════════════════════════════════════════════════════════════

  // §14  Prohibited / toxic plant species
  { pattern: /\b(cannabis seed|marijuana seed|magic mushroom spore|psilocybin mushroom|opium poppy seed for drug|coca plant|khat plant|salvia divinorum plant)\b/i,
    reason: 'Prohibited plant or drug-producing seed (§14)' },

  // §14  Invasive / governmentally prohibited species
  { pattern: /\b(japanese knotweed for sale|giant hogweed for sale|himalayan balsam for sale|prohibited invasive species plant)\b/i,
    reason: 'Invasive / prohibited plant species (§14)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §15  SAFETY AND CONSUMER PRODUCTS
  // ══════════════════════════════════════════════════════════════════════════

  // §15  Non-compliant child car seats
  { pattern: /\b(non[- ]?compliant child car seat|uncertified baby car seat|no ece r44|no ece r129|no i-size certification car seat)\b/i,
    reason: 'Non-compliant child car seat (§15)' },

  // §15  Missing CE / safety certification claims
  { pattern: /\bnon[- ]?ce\b|\bno ce mark\b|\bno ece cert\b|\bno capa cert\b|\blacks ce certification\b/i,
    reason: 'Missing required CE safety certification (§15)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §16  STOLEN AND ILLEGAL GOODS
  // ══════════════════════════════════════════════════════════════════════════

  // §16  Stolen goods / vehicle theft tools
  { pattern: /\b(stolen goods|stolen property|nicked item|vehicle theft device|car theft tool|relay attack device|signal relay box car theft|catalytic converter theft tool|lock pick gun illegal)\b/i,
    reason: 'Stolen goods or vehicle theft tool (§16)' },

  // §16  IMEI / serial number altering tools
  { pattern: /\b(imei changer|imei unlock tool|imei cloner|serial number changer|vin cloner|vin plate cloning)\b/i,
    reason: 'Device identity altering tool (§16)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §17  TOBACCO AND E-CIGARETTES
  // ══════════════════════════════════════════════════════════════════════════

  // §17  Non-compliant vaping / e-cigarettes (over TPD tank/nicotine limits)
  { pattern: /\b(e-liquid over 20mg nicotine|nicotine shot over 20mg|vape tank over 2ml tpd|non[- ]?tpd compliant|tpd non[- ]?compliant vape|unlicensed e-cigarette)\b/i,
    reason: 'Non-TPD-compliant e-cigarette/e-liquid (§17)' },

  // §17  Counterfeit tobacco
  { pattern: /\b(counterfeit cigarette|fake cigarette|counterfeit tobacco|duty[- ]?free illicit cigarette|illicit tobacco)\b/i,
    reason: 'Counterfeit or illicit tobacco (§17)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §18  WEAPONS
  // ══════════════════════════════════════════════════════════════════════════

  // §18  Prohibited bladed / offensive weapons
  { pattern: /\b(flick knife|flick blade|switchblade|zombie knife|zombie killer knife|butterfly knife|balisong|push dagger|shuriken|throwing star|kusari|kyoketsu|knuckleduster|brass knuckle|swordstick|sword cane|belt buckle knife|disguised blade|credit card knife)\b/i,
    reason: 'Prohibited bladed / offensive weapon (§18)' },

  // §18  Stun weapons
  { pattern: /\b(stun gun|taser device|electric shock baton|stun baton|cattle prod weapon)\b/i,
    reason: 'Prohibited stun weapon (§18)' },

  // §18  Tear gas / irritant sprays
  { pattern: /\b(tear gas canister|cs gas|cn gas|pepper spray self defence|mace spray|irritant spray weapon)\b/i,
    reason: 'Prohibited irritant spray / tear gas (§18)' },

  // §18  Firearms / ammunition / suppressors
  { pattern: /\b(firearm for sale|handgun for sale|pistol for sale|revolver for sale|rifle for sale|shotgun for sale|machine gun|submachine gun|gun silencer|suppressor for gun|ammunition for sale|live ammo|bullet cartridge for sale|grenade|explosive device|crossbow for sale)\b/i,
    reason: 'Firearm, ammunition or explosive (§18)' },

  // §18  Air weapons above legal limit (over 12ft/lb rifle, 6ft/lb pistol)
  { pattern: /\b(air rifle over 12 ft[- ]?lb|air pistol over 6 ft[- ]?lb|over limit air gun|high power air rifle unlicensed)\b/i,
    reason: 'Air weapon exceeding legal power limit (§18)' },
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
