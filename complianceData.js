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

  // §1.1  Illegal wildlife trade parts
  { pattern: /\b(pangolin scale|pangolin part|marine turtle|sea turtle shell|tiger bone|tiger claw|bear bile|bear paw|rhino horn|elephant tusk|elephant ivory|elk ivory|whale bone|whale ivory|tortoiseshell product|bushmeat)\b/i,
    reason: 'Illegal wildlife trade part (§1.1)' },

  // §1.2  Animal snares / traps harming during catching
  { pattern: /\b(animal snare|hunting snare|leg[- ]hold trap|leghold trap|body[- ]grip trap|conibear trap|jaw trap|gin trap|poaching snare|spring trap animal)\b/i,
    reason: 'Animal snare or harmful catching trap (§1.2)' },

  // §1.3  Dog prong / pinch / inward-spike collars
  { pattern: /\b(prong collar|pinch collar|spike collar|inward[- ]?facing spike collar|metal spike dog collar)\b/i,
    reason: 'Harmful dog collar with inward spikes (§1.3)' },

  // §1.4  Electrostatic shock collars (training and containment)
  { pattern: /\b(shock collar|electrostatic collar|electric training collar|e-collar shock|anti-bark shock collar)\b/i,
    reason: 'Electrostatic shock collar (§1.4)' },

  // §1.5  Glue traps for rodents / vertebrates
  { pattern: /\b(glue trap|glue board|sticky board rat|sticky board mouse|glue rodent trap|sticky trap rodent)\b/i,
    reason: 'Glue trap for rodents/vertebrates (§1.5)' },

  // §1.6  Human remains / body parts (hair wigs are allowed)
  { pattern: /\b(human skull|human bone|human remains|human body part|human organ for sale|human teeth sale|placenta for sale|human tissue)\b/i,
    reason: 'Human remains or body parts (§1.6)' },

  // §1.7  Ivory products (including teeth from any animal)
  { pattern: /\b(ivory trinket|ivory carving|ivory figurine|ivory tusk|ivory jewellery|ivory jewelry|real ivory|made from ivory|antique ivory|animal tooth ivory)\b/i,
    reason: 'Ivory or ivory-derived product (§1.7)' },

  // §1.8  Live animals / pets / reptiles (live bait worms are allowed)
  { pattern: /\b(live snake for sale|live reptile for sale|live parrot for sale|live bird for sale|live turtle for sale|live monkey|live exotic animal|live scorpion|live tarantula for sale|live frog for sale|live chameleon)\b/i,
    reason: 'Live animal / pet / reptile listing (§1.8)' },

  // §1.9  Mounted trophy heads from hunting
  { pattern: /\b(trophy mount|mounted animal head|mounted deer head|mounted bear head|mounted lion head|hunting trophy|taxidermy trophy head|wall mounted animal skull)\b/i,
    reason: 'Mounted trophy animal head (§1.9)' },

  // §1.10  Products promoting animal abuse
  { pattern: /\b(animal fighting|dogfighting|dog fight|cockfighting|cock fight|animal abuse video|animal cruelty media|dog baiting)\b/i,
    reason: 'Products promoting animal abuse (§1.10)' },

  // §1.11  Taxidermy without approved seller licence
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

  // §3.6  Vehicle seatbelts / seatbelt pretensioners (regulated components)
  { pattern: /\b(seatbelt pretensioner|seat belt pretensioner|used seatbelt component|second[- ]hand seatbelt|salvage seatbelt|breaker seatbelt)\b/i,
    reason: 'Vehicle seatbelt component or pretensioner (§3.6)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §4  CLOTHING, ACCESSORIES AND COSMETICS
  // ══════════════════════════════════════════════════════════════════════════

  // §4.3  Real fur from farmed animals (mink, fox, raccoon dog, rabbit, chinchilla)
  { pattern: /\b(real mink fur|mink fur coat|real fox fur|fox fur coat|raccoon dog fur|chinchilla fur coat|real rabbit fur coat|farmed fur coat|genuine mink|genuine fox fur)\b/i,
    reason: 'Real fur from farmed animals (§4.3)' },

  // §4.5  Used underwear / socks
  { pattern: /\b(used underwear|used knickers|worn knickers|used panties|used briefs|used boxer shorts|worn boxer shorts|used pants underwear|used socks worn)\b/i,
    reason: 'Used underwear or socks (§4.5)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §5  DIGITAL MEDIA
  // ══════════════════════════════════════════════════════════════════════════

  // §5.2  Bootleg recordings from live shows / concerts
  { pattern: /\b(bootleg concert|bootleg recording|live bootleg|bootleg dvd concert|concert bootleg|unofficial recording live show)\b/i,
    reason: 'Bootleg recording from live show or concert (§5.2)' },

  // §5.3 / §5.4  Copied / OEM / recovery software sold standalone
  { pattern: /\b(soft-lifted software|oem software standalone|windows recovery disc standalone|office oem disc|system recovery disc oem|duplicated software)\b/i,
    reason: 'Copied, OEM or recovery software sold without hardware (§5.3/§5.4)' },

  // §5.6  Software keys / MSDN keys / licence keys delivered digitally
  { pattern: /\b(msdn key|software licence key|software license key|windows key digital|office key digital|adobe key digital|activation code email|oem key email|product key emailed|product key instant)\b/i,
    reason: 'Software key or MSDN key delivered by email/download (§5.6)' },

  // §5.9 / §5.10  Unauthorised digital copies — movies, music, ebooks, games
  { pattern: /\b(pirated movie|pirated dvd|pirated game|pirated music|cracked software|warez|pirated ebook|pirated pdf book|download link pirated|full movie download link|unofficial download link)\b/i,
    reason: 'Unauthorised digital copy of media/software (§5.9/§5.10)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §6  DRUGS, DRUG PARAPHERNALIA AND DIETARY SUPPLEMENTS
  // ══════════════════════════════════════════════════════════════════════════

  // §6.1  Full-spectrum cannabinoid extracts (hemp stalks/leaves/flowers)
  { pattern: /\b(hemp flower|hemp bud|hemp leaf extract|full[- ]spectrum hemp extract|hemp plant extract|hemp stalk extract|raw hemp extract)\b/i,
    reason: 'Full-spectrum cannabinoid / hemp plant extract (§6.1)' },

  // §6.3  Narcotics / controlled substances / steroids
  { pattern: /\b(cocaine|crack cocaine|heroin|mdma|ecstasy tablet|methamphetamine|crystal meth|fentanyl drug|lsd tab|ketamine drug|ghb drug|mephedrone|anabolic steroid for sale|spice drug|bath salt drug)\b/i,
    reason: 'Narcotic / controlled substance / anabolic steroid (§6.3)' },

  // §6.4 / §6.2  Prescription-only / pharmacy medication
  { pattern: /\b(prescription medication buy online|buy tramadol online|buy diazepam online|buy codeine online|buy zopiclone online|buy modafinil online|buy oxycodone online|prescription only medicine|pom drug|unlicensed pharmacy)\b/i,
    reason: 'Prescription-only medicine — pharmacy sale required (§6.4)' },

  // §6.5  CBD / cannabinoid products not approved by FSA, or THC excess
  { pattern: /\b(thc gummy|thc edible|thc oil|thc-v supplement|unapproved cbd supplement|cbd food supplement unapproved|cbd gummy bear unapproved)\b/i,
    reason: 'CBD/THC product not approved by FSA (§6.5)' },

  // §6.7  Products claiming to provide a legal high
  { pattern: /\b(legal high|novel psychoactive substance|research chemical|get high legally|herbal high|party pill)\b/i,
    reason: 'Product claiming to provide a legal high (§6.7)' },

  // §6.8  Smoking apparatus / drug paraphernalia
  { pattern: /\b(bong for weed|crack pipe|meth pipe|drug pipe|cocaine straw|drug snorting kit|drug rolling tray|pill press mould|smoking bong|chillum pipe drug|drug paraphernalia)\b/i,
    reason: 'Smoking apparatus / drug paraphernalia (§6.8)' },

  // §6.9  Veterinary medication without VMD authorisation / prescription
  { pattern: /\b(unlicensed vet medication|veterinary medicine without prescription|vmd unauthorised|unregistered veterinary drug|prescription vet medicine online)\b/i,
    reason: 'Unauthorised veterinary medication (§6.9)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §7  FOOD AND BEVERAGES
  // ══════════════════════════════════════════════════════════════════════════

  // §7.3  Food containing endangered / threatened species
  { pattern: /\b(shark fin soup|shark fin product|whale meat|bluefin tuna endangered|sturgeon caviar black market|bushmeat food)\b/i,
    reason: 'Food containing endangered or threatened species (§7.3)' },

  // §7.4  Food containing shark or whale meat
  { pattern: /\b(shark meat food|whale meat food|whale blubber food|shark flesh)\b/i,
    reason: 'Food containing shark or whale meat (§7.4)' },

  // §7.5  Food with unapproved CBD (e.g. CBD gummy bears)
  { pattern: /\b(cbd gummy bear|cbd chocolate bar|cbd brownie|cbd cookie|cbd drink food|cannabis gummy|weed gummy|space cake food|cannabis edible|thc edible food)\b/i,
    reason: 'Food containing CBD/cannabinoids not approved by FSA (§7.5)' },

  // §7.17 / §7.18  Food containing illegal drugs / drug-resembling sweets
  { pattern: /\b(weed brownie|cannabis brownie|drug infused food|candy cigarette|sweet cigarette|lollipop cigarette|sweet resembling drugs|drug candy)\b/i,
    reason: 'Food containing illegal drug or resembling drug/tobacco products (§7.17/§7.18)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §8  GUNS AND AMMUNITION
  // ══════════════════════════════════════════════════════════════════════════

  // §8.1  Ammunition / firearm parts (silencers, magazines)
  { pattern: /\b(ammunition for sale|live ammo|bullet cartridge for sale|gun magazine for sale|firearm silencer|gun suppressor|firearm magazine|gun parts kit)\b/i,
    reason: 'Ammunition or firearm parts including silencers/magazines (§8.1)' },

  // §8.2  Firearms
  { pattern: /\b(firearm for sale|handgun for sale|pistol for sale|revolver for sale|rifle for sale|shotgun for sale|semi-automatic gun|automatic rifle)\b/i,
    reason: 'Firearm listing (§8.2)' },

  // §8.3  Military weaponry / explosives
  { pattern: /\b(grenade for sale|military explosive|claymore mine|rpg weapon|mortar weapon|military bomb|explosive device for sale)\b/i,
    reason: 'Military weaponry or explosive (§8.3)' },

  // §8.4  Stun guns and tasers
  { pattern: /\b(stun gun|taser device|electric shock baton|stun baton|stun weapon)\b/i,
    reason: 'Stun gun or taser (§8.4)' },

  // §8.5  Tear gas / pepper spray / mace
  { pattern: /\b(tear gas canister|cs gas spray|cn gas spray|pepper spray self defence|mace spray weapon|irritant spray weapon)\b/i,
    reason: 'Tear gas, pepper spray or mace (§8.5)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §9  HAZARDOUS AND DANGEROUS ITEMS
  // ══════════════════════════════════════════════════════════════════════════

  // §9.1  Strong acids
  { pattern: /\b(sulphuric acid|sulfuric acid|hydrochloric acid|nitric acid|hydrofluoric acid|concentrated acid for sale|muriatic acid)\b/i,
    reason: 'Prohibited strong acid (§9.1)' },

  // §9.2  Harmful biocides / pesticides
  { pattern: /\b(unlicensed pesticide|banned pesticide|illegal biocide|carbofuran pesticide|endosulfan|methyl bromide fumigant|ddt pesticide)\b/i,
    reason: 'Harmful biocide or banned pesticide (§9.2)' },

  // §9.3  Combustible materials (black powder, flash paper, thermite, flares, red phosphorous)
  { pattern: /\b(black powder for sale|explosive fuse|det cord|detonator|thermite powder|flash powder|flash paper|red phosphorous|explosive target|gun powder for sale|tannerite|cap for toy gun bulk)\b/i,
    reason: 'Combustible or explosive material (§9.3)' },

  // §9.4  Explosive precursors (sodium nitrate, sulphuric acid as precursor)
  { pattern: /\b(explosive precursor|sodium nitrate explosive|ammonium nitrate explosive|anfo explosive|petn explosive|rdx explosive|tatp|hmtd explosive)\b/i,
    reason: 'Explosive precursor chemical (§9.4)' },

  // §9.5  Fire extinguishers with carbon tetrachloride or pyrene
  { pattern: /\b(carbon tetrachloride fire extinguisher|pyrene fire extinguisher|halon 1211 extinguisher|cct extinguisher|carbon tet extinguisher)\b/i,
    reason: 'Fire extinguisher containing carbon tetrachloride or pyrene (§9.5)' },

  // §9.6  Fireworks F2, F3, F4 (aerial bombs, shells, bangers, skyrockets)
  { pattern: /\b(category f2 firework|category f3 firework|category f4 firework|aerial bomb firework|shell firework professional|display shell firework|sky rocket professional|1\.3g firework|professional banger)\b/i,
    reason: 'Prohibited category F2/F3/F4 firework (§9.6)' },

  // §9.8  Hazardous gases
  { pattern: /\b(chlorine gas cylinder|phosgene gas|acutely toxic gas|corrosive gas cylinder|pyrophoric gas|silane gas|phosphine gas)\b/i,
    reason: 'Hazardous gas cylinder (§9.8)' },

  // §9.9  Radioactive materials
  { pattern: /\b(radioactive material|uranium for sale|thorium for sale|radium for sale|radioactive ore|radioactive isotope|nuclear material for sale)\b/i,
    reason: 'Radioactive / nuclear material (§9.9)' },

  // §9.10  Toxic / carcinogenic substances
  { pattern: /\b(toxic substance for sale|carcinogenic chemical|asbestos tile|asbestos sheet|asbestos insulation|asbestos rope|asbestos cement|contains asbestos|asbestos gasket)\b/i,
    reason: 'Toxic, carcinogenic or asbestos-containing substance (§9.10)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §10  INTELLECTUAL PROPERTY
  // ══════════════════════════════════════════════════════════════════════════

  // §10.1  Counterfeit / replica / fake branded products
  { pattern: /\b(counterfeit|replica watch|fake designer|fake branded|knockoff branded|knock-off designer|imitation branded|fake rolex|fake gucci|fake louis vuitton)\b/i,
    reason: 'Counterfeit or replica branded product (§10.1)' },

  // §10.2  OEM / bundled / backup / recovery software sold standalone
  { pattern: /\b(oem software standalone|oem windows disc|bundled software only|recovery software standalone|backup software oem|restore disc oem standalone)\b/i,
    reason: 'OEM/bundled/recovery software sold without original hardware (§10.2)' },

  // §10.4 / §10.5  Unauthorised copies of media / ebooks
  { pattern: /\b(pirated dvd|pirated blu-ray|pirated game disc|pirated music cd|pirated ebook download|bootleg dvd|bootleg game|unofficial copy dvd|unauthorised copy game)\b/i,
    reason: 'Unauthorised copy of book, movie, music or game (§10.4/§10.5)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §11  KNIVES AND OFFENSIVE WEAPONS
  // ══════════════════════════════════════════════════════════════════════════

  // §11.1  Batons / truncheons
  { pattern: /\b(baton weapon|side[- ]handle baton|friction[- ]lock truncheon|pr-24 baton|police baton weapon|side handled baton)\b/i,
    reason: 'Prohibited baton or truncheon (§11.1)' },

  // §11.2  Blowpipes / blowguns
  { pattern: /\b(blowpipe weapon|blowgun weapon|blow gun dart|blow pipe dart weapon|peashooter weapon)\b/i,
    reason: 'Blowpipe or blowgun weapon (§11.2)' },

  // §11.3  Butterfly knives / Balisongs
  { pattern: /\b(butterfly knife|balisong knife|balisong flipper)\b/i,
    reason: 'Butterfly knife / Balisong (§11.3)' },

  // §11.4  Disguised knives (buckle, phone, brush, lipstick concealed blade)
  { pattern: /\b(disguised knife|belt buckle knife|lipstick knife|phone knife|credit card knife|brush knife|comb knife|pen knife weapon|hidden blade everyday object)\b/i,
    reason: 'Knife disguised as everyday object (§11.4)' },

  // §11.5  Flick knives / Switchblades / Automatic knives
  { pattern: /\b(flick knife|flick blade|switchblade|automatic knife button|spring-loaded knife)\b/i,
    reason: 'Flick knife / switchblade / automatic knife (§11.5)' },

  // §11.6  Gravity knives
  { pattern: /\b(gravity knife|gravity-release knife|paratrooper gravity knife)\b/i,
    reason: 'Gravity knife (§11.6)' },

  // §11.7  Handclaws / Footclaws
  { pattern: /\b(handclaw weapon|hand claw weapon|foot claw weapon|metal spike knuckle claw|ninja claw weapon)\b/i,
    reason: 'Handclaw or footclaw weapon (§11.7)' },

  // §11.8  Hollow kubotans with spikes
  { pattern: /\b(hollow kubotan|kubotan spike|spiked kubotan|keychain spike weapon)\b/i,
    reason: 'Hollow kubotan with spikes (§11.8)' },

  // §11.9  Knuckledusters / Brass knuckles
  { pattern: /\b(knuckleduster|brass knuckle|metal knuckle|knuckle duster weapon)\b/i,
    reason: 'Knuckleduster / brass knuckles (§11.9)' },

  // §11.10 / §11.11 / §11.12  Kusari / Kusari-gama / Kyoketsu-shoge
  { pattern: /\b(kusari weapon|kusari-gama|kusarigama|kyoketsu[- ]shoge|manrikigusari|weighted chain weapon)\b/i,
    reason: 'Kusari / chain weapon (§11.10–§11.12)' },

  // §11.13  Push daggers
  { pattern: /\b(push dagger|t-handle dagger|push knife weapon)\b/i,
    reason: 'Push dagger / push knife (§11.13)' },

  // §11.14  Shurikens / throwing stars
  { pattern: /\b(shuriken|throwing star|death star weapon|ninja throwing star|shaken weapon)\b/i,
    reason: 'Shuriken / throwing star (§11.14)' },

  // §11.16  Stealth knives (non-metal blade, not kitchen/toy)
  { pattern: /\b(stealth knife|ceramic knife weapon|non[- ]metal knife blade weapon|plastic knife weapon|non[- ]detectable knife)\b/i,
    reason: 'Stealth knife — non-metal blade (§11.16)' },

  // §11.17  Sword-sticks / swordstick / cane sword
  { pattern: /\b(sword stick|swordstick|cane sword|walking stick sword|sword cane|blade in cane)\b/i,
    reason: 'Sword-stick / cane sword (§11.17)' },

  // §11.18  Swords and samurai swords with curved blade over 50cm
  { pattern: /\b(samurai sword|katana sword|ninja sword|curved blade over 50|iaito sword|wakizashi sword|ninjato sword)\b/i,
    reason: 'Samurai / curved sword over 50cm (§11.18)' },

  // §11.19  Telescopic / extending truncheons
  { pattern: /\b(telescopic baton|extendable baton|telescopic truncheon|asp baton|collapsible baton|expandable baton weapon)\b/i,
    reason: 'Telescopic truncheon / extending baton (§11.19)' },

  // §11.20  Zombie knives
  { pattern: /\b(zombie knife|zombie killer knife|zombie slayer knife|zombie machete serrated)\b/i,
    reason: 'Zombie knife (§11.20)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §12  MEDICAL DEVICES
  // ══════════════════════════════════════════════════════════════════════════

  // §12.1  Contact lenses by non-registered optometrist / medical practitioner
  { pattern: /\b(coloured contact lens no prescription|cosmetic contact lens no prescription|zero power contact lens no prescription|plano contact lens no prescription|contacts without prescription)\b/i,
    reason: 'Contact lenses sold without prescription (§12.1)' },

  // §12.3  Medical devices without CE or UKCA marking
  { pattern: /\bnon[- ]?ce medical device\b|\bno ce mark medical\b|\bno ukca medical\b|\bno ukca marking\b|\bwithout ce mark medical\b/i,
    reason: 'Medical device without required CE/UKCA mark (§12.3)' },

  // §12.4 / §12.5  Prescription / unregistered medical devices
  { pattern: /\b(prescription medical device buy online|unregistered medical device|unlicensed medical device|mhra unregistered device|sibutramine|dnp weight loss|dinitrophenol slimming|banned diet pill)\b/i,
    reason: 'Prescription or unregistered medical device (§12.4/§12.5)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §13  OFFENSIVE AND CONTROVERSIAL MATERIALS
  // ══════════════════════════════════════════════════════════════════════════

  // §13.2 / §13.3  Anti-Semitic / swastika / Holocaust / Nazi items
  { pattern: /\b(nazi memorabilia|ss insignia|nazi uniform|third reich|holocaust memorabilia|nazi related|swastika product|anti-semitic item|neo-nazi merchandise|kkk merchandise|kkk robe|white supremacy merch)\b/i,
    reason: 'Anti-Semitic, Holocaust-related or Nazi item (§13.2/§13.3)' },

  // §13.5  Terrorist organisation related products
  { pattern: /\b(isis flag|islamic state flag|al qaeda|terrorist flag|terror group merchandise|jihadist material|extremist propaganda)\b/i,
    reason: 'Terrorist organisation merchandise (§13.5)' },

  // §13.8  Child abuse / exploitation products
  { pattern: /\b(child exploitation|csam|child abuse material|juvenile pornography|child sexual|child abuse image)\b/i,
    reason: 'Product depicting child abuse or exploitation (§13.8)' },

  // §13.9  Products glorifying suicide
  { pattern: /\b(glorify suicide|suicide method guide|how to commit suicide product|suicide instruction|pro-suicide material)\b/i,
    reason: 'Product glorifying or promoting suicide (§13.9)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §14  PLANTS AND SEEDS
  // ══════════════════════════════════════════════════════════════════════════

  // §14.1  CITES-listed endangered plants
  { pattern: /\b(cites plant for sale|endangered orchid wild|cycad wild caught|endangered cactus wild|saguaro cactus wild|wild venus flytrap wild caught)\b/i,
    reason: 'CITES-listed endangered plant (§14.1)' },

  // §14.2  Hallucinogenic mushrooms
  { pattern: /\b(magic mushroom|psilocybin mushroom|amanita muscaria mushroom|fly agaric mushroom|amanita pantherina|psilocybe mushroom|magic mushroom spore|shroom spore)\b/i,
    reason: 'Hallucinogenic mushroom or spore (§14.2)' },

  // §14.3  Invasive non-native aquatic plants
  { pattern: /\b(azolla filiculoides|myriophyllum aquaticum|parrot's feather plant|water fern invasive|ludwigia grandiflora|water primrose invasive|hydrocotyle ranunculoides|floating pennywort|crassula helmsii|new zealand pygmy weed)\b/i,
    reason: 'Invasive non-native aquatic plant (§14.3)' },

  // §14.4  Plants sourcing hallucinogenic substances (DMT, LSA, opiates)
  { pattern: /\b(ayahuasca plant|dmt plant|mimosa hostilis|psychotria viridis|san pedro cactus drug|peyote cactus drug|morning glory seed lsa|hawaiian baby woodrose lsa|lsa plant drug|opium poppy drug)\b/i,
    reason: 'Plant sourcing hallucinogenic substance — DMT/LSA/opiates (§14.4)' },

  // §14.5  Cannabis / khat / coca / government-prohibited plants and seeds
  { pattern: /\b(cannabis seed|marijuana seed|cannabis plant for sale|khat plant|coca plant|coca seed|cathinone plant)\b/i,
    reason: 'Government-prohibited plant or seed (§14.5)' },

  // §14.6  Toxic / poisonous plants
  { pattern: /\b(deadly nightshade plant|atropa belladonna|castor bean plant|ricinus communis|hemlock plant|water hemlock|cicuta plant|oleander plant|nerium oleander|rosary pea|abrus precatorius|white snakeroot|ageratina altissima|nicotiana tabacum for smoking|tobacco plant for smoking)\b/i,
    reason: 'Toxic or poisonous plant (§14.6)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §15  PRODUCT SAFETY
  // ══════════════════════════════════════════════════════════════════════════

  // §15.1  Safety-recalled products
  { pattern: /\b(recalled product|product recall item|safety recall uk|government recall product|manufacturer recall)\b/i,
    reason: 'Product subject to a safety recall (§15.1)' },

  // §15.2  Non-compliant child car seats
  { pattern: /\b(non[- ]?compliant child car seat|uncertified baby car seat|no ece r44|no ece r129|no i-size certification car seat|car seat without ece)\b/i,
    reason: 'Non-compliant child car seat (§15.2)' },

  // §15.3  Class 3B / Class 4 lasers (>5mW)
  { pattern: /\b(class 3b laser|class 4 laser|class iv laser|class iiib laser|1000mw laser pointer|2000mw laser|5000mw laser|burning laser pointer|high[- ]power laser pointer)\b/i,
    reason: 'Prohibited high-power laser Class 3B/4 (§15.3)' },

  // §15.4  Giant / child-appealing / disguised lighters
  { pattern: /\b(novelty lighter gun|gun shaped lighter|toy gun lighter|cartoon lighter for kids|toy shaped lighter|child appeal lighter|giant lighter|oversized lighter|lighter disguised)\b/i,
    reason: 'Giant, child-appealing or disguised lighter (§15.4)' },

  // §15.6  Products legally requiring CE mark but lacking one
  { pattern: /\bnon[- ]?ce\b|\bno ce mark\b|\bwithout ce mark\b|\bno ukca mark\b|\blacks ce certification\b/i,
    reason: 'Product legally requiring CE/UKCA mark but lacking one (§15.6)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §16  RADIO ELECTRONICS
  // ══════════════════════════════════════════════════════════════════════════

  // §16.2  Wiretapping / phone bugging / surveillance devices
  { pattern: /\b(wiretapping device|phone tapping device|bug listening device|gsm bug device|phone bugging device|spy bug room|hidden microphone spy|voice recorder hidden illegal|spy ear device)\b/i,
    reason: 'Wiretapping or phone bugging device (§16.2)' },

  // §16.3  Modchips for playing pirated games
  { pattern: /\b(modchip|mod chip|game modchip|ps4 modchip|ps5 modchip|xbox modchip|switch modchip|piracy chip console|game hack chip)\b/i,
    reason: 'Modchip designed to play pirated games (§16.3)' },

  // §16.5  Signal jamming devices
  { pattern: /\b(signal jammer|gps jammer|phone jammer|mobile jammer|wifi jammer|frequency jammer|radio jammer|drone jammer|cell jammer)\b/i,
    reason: 'Signal jamming device (§16.5)' },

  // §16.6  TV / satellite descramblers
  { pattern: /\b(tv descrambler|satellite descrambler|sky card hack|iptv illegal box|illegal iptv subscription|satellite hack box|free to air illegal descrambler)\b/i,
    reason: 'TV or satellite descrambler device (§16.6)' },

  // §16.7  Traffic light remote controllers
  { pattern: /\b(traffic light controller remote|traffic light changer|preemption device traffic|emergency vehicle preemption device civilian)\b/i,
    reason: 'Traffic light remote control device (§16.7)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §17  SEX AND ADULT MATERIAL
  // ══════════════════════════════════════════════════════════════════════════

  // §17.1 / §17.2  Hard pornographic / obscene material (X/XXX/R18 rated)
  { pattern: /\b(xxx dvd|x rated dvd|r18 dvd|r18 film|hard pornography|hardcore porn dvd|adult xxx film|obscene publication|sexually explicit dvd)\b/i,
    reason: 'Hard pornographic or obscene material (§17.1/§17.2)' },

  // §17.3  Child or juvenile pornography
  { pattern: /\b(child pornography|juvenile pornography|child sexual abuse material|csam|underage sexual|child exploitation material)\b/i,
    reason: 'Child or juvenile pornographic material (§17.3)' },

  // §17.4  Used soiled undergarments
  { pattern: /\b(used soiled underwear|worn soiled knickers|used soiled panties|worn panties for sale|used soiled briefs|soiled underwear for sale)\b/i,
    reason: 'Used soiled undergarments (§17.4)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §18  TOBACCO, E-CIGARETTES AND PARAPHERNALIA
  // ══════════════════════════════════════════════════════════════════════════

  // §18.1  E-liquids with THC or appealing to minors
  { pattern: /\b(thc e-liquid|thc vape juice|cannabis vape liquid|e-liquid for kids|vape juice cartoon|kids vape|child appeal vape|minor appeal e-cig)\b/i,
    reason: 'E-liquid containing THC or appealing to minors (§18.1)' },

  // §18.2  Herbal cigarettes / herbal tobacco / nicotine-free cigarettes
  { pattern: /\b(herbal cigarette|herbal tobacco cigarette|nicotine[- ]free cigarette|tobacco[- ]free cigarette|herbal shisha tobacco|herbal smoking product)\b/i,
    reason: 'Herbal cigarette or herbal tobacco product (§18.2)' },

  // §18.4  Tobacco products (cigarettes, cigars, snus, chewing tobacco, blunt wraps)
  { pattern: /\b(cigarettes for sale|cigars for sale|blunt wrap|dipping tobacco|chewing tobacco|snus tobacco|smokeless tobacco|loose tobacco for sale|pipe tobacco for sale|shisha tobacco for sale)\b/i,
    reason: 'Tobacco product (§18.4)' },

  // ══════════════════════════════════════════════════════════════════════════
  // §19  OTHER
  // ══════════════════════════════════════════════════════════════════════════

  // §19.1  Coupons / vouchers / voucher codes for sale
  { pattern: /\b(coupon for sale|discount voucher code for sale|gift voucher code for sale|promo code for sale|voucher code resell)\b/i,
    reason: 'Coupon, voucher or voucher code listing (§19.1)' },

  // §19.2  Grab bags / mystery items
  { pattern: /\b(grab bag listing|mystery box for sale|lucky dip listing|surprise bag listing|mystery item sale|random item box)\b/i,
    reason: 'Grab bag or mystery item listing (§19.2)' },

  // §19.3  Train / bus / concert / lottery tickets
  { pattern: /\b(train ticket for sale|bus ticket for sale|concert ticket resell|lottery ticket for sale|event ticket resell|theatre ticket resell)\b/i,
    reason: 'Train, bus, concert or lottery ticket listing (§19.3)' },
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
