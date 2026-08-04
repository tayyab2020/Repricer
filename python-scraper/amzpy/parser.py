"""
Amazon HTML Parsing Module
~~~~~~~~~~~~~~~~~~~~~~~~~

This module contains parsing functions for Amazon pages:
- Product detail pages (individual products)
- Search results pages (listings of products)

It uses BeautifulSoup to extract structured data from Amazon's HTML.
"""


import re
import json
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup
from typing import Dict, Optional, TYPE_CHECKING, Any, List, Tuple

# Using string annotation to avoid circular imports
if TYPE_CHECKING:
    from amzpy.session import AmzSession

from amzpy.utils import extract_brand_name, format_canonical_url, parse_amazon_url, extract_asin


def parse_product_page(html_content: str, url: str = None, country_code: str = None) -> Optional[Dict]:
    """
    Parse Amazon product page HTML and extract structured product data.
    
    This function extracts key product information including:
    - Product title
    - Price and currency
    - Brand name
    - Product image URL
    
    Args:
        html_content (str): Raw HTML content of the product page
        url (str, optional): Product URL for reference
        country_code (str, optional): Country code for URL formatting
        
    Returns:
        Dict: Extracted product information 
        None: If parsing fails or HTML indicates a CAPTCHA/block
    """
    if not html_content:
        print("Error: Received empty HTML content")
        return None
        
    # Use lxml parser for better performance
    soup = BeautifulSoup(html_content, 'lxml')
    
    # Check for CAPTCHA / Block Page before detailed parsing
    if "captcha" in html_content.lower() or "api-services-support@amazon.com" in html_content:
        print("Possible CAPTCHA or block page detected in HTML content")
        return None
    
    # Soft-block detection: robot-check pages return 200 but have a distinct <title>
    page_title_elem = soup.select_one('title')
    if page_title_elem:
        page_title_text = page_title_elem.text.lower()
        soft_block_signals = [
            'robot check', 'sorry, we just need', 'enter the characters',
            'type the characters', 'verify you are a human', 'human verification',
        ]
        if any(s in page_title_text for s in soft_block_signals):
            print("Soft-block / robot-check page detected")
            return None

    # Detect anti-bot shell pages: Amazon serves a 200 with full nav/footer but
    # the #dp-container (the product body) has no <div> elements at all — only
    # HTML comments and a single lazy-load <script>. Real product pages always
    # have many nested divs. Return None so the caller retries with a fresh proxy.
    dp_container = soup.select_one('#dp-container')
    if dp_container and not dp_container.find('div'):
        print("Anti-bot shell page detected (empty #dp-container) — retrying with next proxy")
        return None

    try:
        title = price = currency = img_url = brand_name = rating = asin = delivery_date = None

        # Detect price-section variants BEFORE Layer 1 so JSON-LD extraction can
        # be gated accordingly. Amazon's JSON-LD offers.price reflects whatever
        # option is currently "active" — for Prime accordion pages that is the
        # Prime-exclusive price, NOT the standard retail price we want.
        #
        # Use a DOM select rather than a raw-string search: the string
        # "primeSavingsUpsellAccordionRow" appears in script/data-attribute code
        # on many pages that do NOT actually have the Prime accordion buy box.
        # A DOM query only fires when the element is truly server-rendered.
        _has_prime_accordion = bool(soup.select_one('#primeSavingsUpsellAccordionRow'))
        _has_sns = bool(
            soup.select_one('#snsAccordionRowMiddle') or
            soup.select_one('#subscribeAndSaveWidget_feature_div') or
            soup.select_one('#sns-base-price')
        )
        if _has_prime_accordion:
            print("  [parser] Prime accordion detected — JSON-LD/regex price layers skipped")

        # Detect "See All Buying Options" BEFORE any price layers run.
        # When active the buy box has no direct price and all price selectors
        # would otherwise match prices from the "Consider these alternative items"
        # carousel or hidden inputs that hold irrelevant variant prices.
        _buybox = (soup.select_one('#desktop_buybox') or
                   soup.select_one('#buybox') or
                   soup.select_one('#rightCol'))
        # [id^="buybox-see-all-buying-choices"] matches both ID variants Amazon uses:
        #   buybox-see-all-buying-choices          (most pages)
        #   buybox-see-all-buying-choices-announce (some pages)
        # The title="See All Buying Options" anchor is more specific than href alone
        # because offer-listing links also appear on "New & Used" sections that exist
        # alongside a regular Add-to-Cart button.
        _see_all_buying = bool(
            soup.select_one('[id^="buybox-see-all-buying-choices"]') or
            soup.select_one('a[title="See All Buying Options"]') or
            (_buybox and 'see all buying options' in _buybox.get_text().lower())
        )
        if _see_all_buying:
            print("  [parser] 'See All Buying Options' detected — all standard price layers skipped")

        # Detect "Used" primary buybox — Amazon shows "Buy used £X.XX" when the
        # featured offer is a used/renewed item rather than a new one. We need to
        # skip this price and fetch the first NEW offer via the AOD endpoint instead.
        _used_buybox = False
        if not _see_all_buying:
            _bb_text = _buybox.get_text(' ', strip=True).lower() if _buybox else ''
            if 'buy used' in _bb_text or bool(soup.select_one('#usedBuyBox_feature_div')):
                _used_buybox = True
                print("  [parser] Used buybox detected — primary offer is used item, will fetch new offer price")

        # Detect "Currently unavailable" BEFORE any price extraction.
        # When a product has no active offer at all, Amazon renders
        # #outOfStockBuyBox_feature_div / #outOfStock with the text
        # "Currently unavailable." or sets data-displayreason="OUT_OF_STOCK"
        # on the buy-box widget. Catching this early prevents the generic
        # price fallback layers from hitting £ values in the "Consider these
        # available items" carousel that appears on the same page.
        _out_of_stock = False
        _availability_text = ""
        _oos_elem = (
            soup.select_one('#outOfStockBuyBox_feature_div') or
            soup.select_one('#outOfStock')
        )
        if _oos_elem:
            _oos_text = _oos_elem.get_text(' ', strip=True).lower()
            if 'currently unavailable' in _oos_text or 'out of stock' in _oos_text:
                _out_of_stock = True
                print("  [parser] Product is currently unavailable (out of stock)")
        if not _out_of_stock and soup.select_one('[data-displayreason="OUT_OF_STOCK"]'):
            _out_of_stock = True
            print("  [parser] Out of stock: data-displayreason=OUT_OF_STOCK detected")
        if not _out_of_stock:
            _avail = soup.select_one('#availability')
            if _avail:
                _at = _avail.get_text(' ', strip=True).lower()
                _availability_text = _at
                if 'currently unavailable' in _at or 'out of stock' in _at:
                    _out_of_stock = True
                    print("  [parser] Out of stock: #availability indicates unavailable")

        # AmazonFresh / same-day: delivery info lives in #alm-delivery-message, not #availability
        if not _availability_text:
            _alm = soup.select_one('#alm-delivery-message') or soup.select_one('[id^="alm-delivery"]')
            if _alm:
                _alm_text = _alm.get_text(' ', strip=True).lower()
                _availability_text = _alm_text
                print(f"  [parser] AmazonFresh delivery text: {_alm_text[:80]!r}")

        # ── Layer 1: JSON-LD structured data (most reliable, present in <head>) ──
        for script in soup.find_all('script', type='application/ld+json'):
            try:
                data = json.loads(script.string or '')
                items = data if isinstance(data, list) else [data]
                for item in items:
                    if item.get('@type') in ('Product', 'http://schema.org/Product'):
                        if not title:
                            title = (item.get('name') or '').strip() or None
                        if not img_url:
                            img = item.get('image')
                            img_url = (img[0] if isinstance(img, list) else img) or None
                        if not brand_name:
                            brand = item.get('brand', {})
                            if isinstance(brand, dict):
                                brand_name = brand.get('name', '').strip() or None
                            elif isinstance(brand, str):
                                brand_name = brand.strip() or None
                        if rating is None:
                            agg = item.get('aggregateRating', {})
                            if agg and 'ratingValue' in agg:
                                try:
                                    rating = float(agg['ratingValue'])
                                except (ValueError, TypeError):
                                    pass
                        offers = item.get('offers', {})
                        if isinstance(offers, list):
                            offers = offers[0] if offers else {}
                        # Skip JSON-LD price for Prime accordion pages (Prime-exclusive)
                        # and "See All Buying Options" pages (no single direct offer).
                        if offers and price is None and not _has_prime_accordion and not _see_all_buying and not _used_buybox and not _out_of_stock:
                            try:
                                price = float(str(offers.get('price', '') or '').replace(',', ''))
                            except (ValueError, TypeError):
                                pass
                        if not currency and offers:
                            currency = offers.get('priceCurrency', '').strip() or None
                        if title:
                            break
            except (json.JSONDecodeError, AttributeError, TypeError):
                continue

        # ── Layer 2: Open Graph / Twitter meta tags ───────────────────────
        if not title:
            for sel in ('meta[property="og:title"]', 'meta[name="title"]',
                        'meta[property="twitter:title"]'):
                elem = soup.select_one(sel)
                if elem and (elem.get('content') or '').strip():
                    title = elem['content'].strip()
                    break

        if not img_url:
            og_img = soup.select_one('meta[property="og:image"]')
            if og_img and og_img.get('content'):
                img_url = og_img['content'].strip()

        # ── Layer 2b: Hidden input fields (Amazon UK stores price here) ────
        # Skip when S&S, Prime accordion, or "See All Buying Options" is active.
        if price is None and not _see_all_buying and not _used_buybox and not _out_of_stock:
            _hidden_inputs = (
                [] if (_has_sns or _has_prime_accordion) else ['twister-plus-price-data-price']
            ) + ['price', 'newPrice']
            for input_id in _hidden_inputs:
                elem = soup.select_one(f'input#{input_id}[value]')
                if elem:
                    val = elem.get('value', '').replace(',', '').strip()
                    try:
                        price = float(val)
                        break
                    except (ValueError, TypeError):
                        pass

        if not currency:
            cu_elem = soup.select_one('input#twister-plus-price-data-price-unit[value]')
            if cu_elem:
                currency = cu_elem.get('value', '').strip() or None

        # ── Layer 3: CSS selectors (layout-dependent, multiple variants) ──
        if not title:
            for sel in ('#productTitle', '#title span', 'h1 span.a-size-large',
                        'h1.a-size-large', '.product-title-word-break'):
                elem = soup.select_one(sel)
                if elem and elem.text.strip():
                    title = elem.text.strip()
                    break

        # Identify the Subscribe & Save section so generic selectors can avoid it.
        # Products with S&S have two prices (one-time and subscription). We always
        # want the one-time purchase price, which is in #corePriceDisplay_desktop_feature_div.
        _core_price_div = (
            soup.select_one('#corePriceDisplay_desktop_feature_div') or
            soup.select_one('#corePrice_feature_div') or
            soup.select_one('#apex_offerDisplay_desktop')
        )

        # "See All Buying Options" pages: try the AOD panel (span#aod-price-1) first.
        # This element is only present in the Playwright-rendered HTML (after the button
        # was clicked), not in the static HTML — so on a fresh static fetch this block
        # is a no-op and price stays None, triggering the Playwright fallback.
        if price is None and _see_all_buying and not _out_of_stock:
            _aod = soup.select_one('#aod-price-1')
            if _aod:
                # Accessibility label holds the full price string e.g. "£298.00"
                _label = _aod.select_one('.aok-offscreen.apex-pricetopay-accessibility-label, span.aok-offscreen')
                if _label and _label.text.strip():
                    _m = re.search(r'[\d,]+\.?\d*', _label.text.strip())
                    if _m:
                        try:
                            price = float(_m.group().replace(',', ''))
                            print(f"  [parser] AOD price {price} from accessibility label")
                        except ValueError:
                            pass
                if price is None:
                    for _pc in _aod.select('.a-price'):
                        _pw = _pc.select_one('.a-price-whole')
                        _pf = _pc.select_one('.a-price-fraction')
                        if _pw and _pw.text.strip('.').replace(',', ''):
                            try:
                                pt = _pw.text.strip('.').replace(',', '')
                                price = float(f"{pt}.{_pf.text.strip()}" if _pf and _pf.text.strip() else pt)
                                if 0.01 <= price <= 99999:
                                    print(f"  [parser] AOD price {price} from #aod-price-1")
                                    break
                                price = None
                            except ValueError:
                                continue

        # For "Used" buybox: if the Playwright-rendered offer listing HTML contains
        # the AOD new offers panel (#aod-price-1), extract the new offer price from it.
        if price is None and _used_buybox and not _out_of_stock:
            _aod = soup.select_one('#aod-price-1')
            if _aod:
                _label = _aod.select_one('.aok-offscreen.apex-pricetopay-accessibility-label, span.aok-offscreen')
                if _label and _label.text.strip():
                    _m = re.search(r'[\d,]+\.?\d*', _label.text.strip())
                    if _m:
                        try:
                            price = float(_m.group().replace(',', ''))
                            print(f"  [parser] Used buybox new offer price {price} from AOD panel")
                        except ValueError:
                            pass
                if price is None:
                    for _pc in _aod.select('.a-price'):
                        _pw = _pc.select_one('.a-price-whole')
                        _pf = _pc.select_one('.a-price-fraction')
                        if _pw and _pw.text.strip('.').replace(',', ''):
                            try:
                                pt = _pw.text.strip('.').replace(',', '')
                                price = float(f"{pt}.{_pf.text.strip()}" if _pf and _pf.text.strip() else pt)
                                if 0.01 <= price <= 99999:
                                    print(f"  [parser] Used buybox new offer price {price} from #aod-price-1")
                                    break
                                price = None
                            except ValueError:
                                continue

        # For Prime accordion pages ALL standard selectors point at the centre-of-page
        # deal display (#corePriceDisplay_desktop_feature_div / .apex-pricetopay-value)
        # which shows the Prime-exclusive price. Skip them entirely and use the
        # dedicated non-prime-row extraction block below instead.
        if price is None and not _has_prime_accordion and not _see_all_buying and not _used_buybox and not _out_of_stock:
            # Try the most specific selectors first, scoped to the one-time price section.
            # #newAccordionRow_0 is the "One-time purchase" accordion — use it first when
            # Subscribe & Save is present so we don't pick up the S&S price instead.
            _specific_selectors = (
                # Most specific: apex-pricetopay-value is Amazon's class for the
                # main buy-box price (visible in DevTools as the XL price display).
                # It avoids earlier .priceToPay siblings that may hold coupon/grocery
                # subscription prices instead of the featured one-time price.
                '#corePriceDisplay_desktop_feature_div .apex-pricetopay-value .a-price-whole',
                '.apex-pricetopay-value .a-price-whole',
                # span.a-offscreen: Amazon often renders .a-price-whole as an empty/invisible
                # character (⊡ in DevTools) while the offscreen span holds the full price
                # string e.g. "£14.99". Target it directly before falling to generic loops.
                '#corePrice_feature_div .apex-pricetopay-value span.a-offscreen',
                '#corePrice_feature_div span.a-offscreen',
                '.apex-pricetopay-value span.a-offscreen',
                # Accessibility label holds the full price as plain text e.g.
                # "£17.49 with 5 percent savings" — reliable even when offscreen spans empty.
                '#apex-pricetopay-accessibility-label',
                '#corePriceDisplay_desktop_feature_div .priceToPay .a-price-whole',
                '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
                '#corePriceDisplay_desktop_feature_div span.a-offscreen',
                '.priceToPay .a-price-whole',
                '.apexPriceToPay .a-price-whole',
                '#tp_price_block_total_price_ww .a-price .a-offscreen',
                '#price_inside_buybox',
                '#priceblock_ourprice',
                '#priceblock_dealprice',
                '#priceblock_saleprice',
            )
            # IDs that identify sections whose prices must be skipped.
            # This block only runs when not _has_prime_accordion, so in practice
            # only the S&S IDs are exercised here. primesavingsupsellaccordionrow
            # is kept as a belt-and-suspenders guard in case the element appears
            # in an unexpected layout alongside one-time purchase prices.
            _SNS_PARENT_IDS = frozenset({
                'snsdetailpageprice', 'subscriptionprice', 'sns-base-price',
                'sns-tiered-price', 'snsaccordionrowmiddle',
                'subscribeandSaveWidget_feature_div',
                'primesavingsupsellaccordionrow',
            })

            for sel in _specific_selectors:
                # Use select() (all matches) not select_one() so that when the first
                # match is inside a filtered section (S&S or Prime accordion), we
                # fall through to the next match of the same selector instead of
                # giving up on the selector entirely.
                for elem in soup.select(sel):
                    if _has_sns or _has_prime_accordion:
                        if any(
                            p.get('id', '').lower() in _SNS_PARENT_IDS
                            for p in elem.parents if p.name
                        ):
                            continue

                    # .a-price-whole only contains the integer part (e.g. "5.").
                    # Combine with .a-price-fraction from the same .a-price parent so
                    # we get "5.95" not "5" (which would wrongly become 5.0).
                    if '.a-price-whole' in sel:
                        _pc = elem.find_parent(class_='a-price')
                        if _pc:
                            _pf = _pc.select_one('.a-price-fraction')
                            _whole = elem.text.strip('.').replace(',', '')
                            _frac = _pf.text.strip() if _pf else ''
                            raw = f"{_whole}.{_frac}" if _frac else _whole
                        else:
                            raw = elem.text.strip().replace(',', '').strip('.')
                    else:
                        raw = elem.text.strip().replace(',', '').strip('.')
                    num = re.search(r'[\d]+\.?\d*', raw)
                    if num:
                        try:
                            price = float(num.group())
                            print(f"  [parser] Price {price} from selector: {sel!r}")
                            break
                        except ValueError:
                            pass
                if price is not None:
                    break

        # ── Prime accordion: extract Non-Deal Price directly ─────────────────
        # The page centre also renders the deal price (e.g. "-50% £49.99") as
        # .a-price elements outside the accordion, so ancestor-ID filtering cannot
        # reliably exclude them. Instead, scope the search exclusively to the
        # non-Prime accordion row whose header always contains the retail price.
        if price is None and _has_prime_accordion and not _out_of_stock:
            _ndr = (
                soup.select_one('[data-a-accordion-row-name="newAccordionRow"]') or
                soup.select_one('[id^="newAccordionRow"]')
            )
            if _ndr:
                for _el in _ndr.select('span.a-offscreen'):
                    m = re.search(r'[\d,]+\.?\d*', _el.text.strip())
                    if m:
                        try:
                            price = float(m.group().replace(',', ''))
                            print(f"  [parser] Non-deal price {price} from non-prime row (offscreen)")
                            break
                        except ValueError:
                            pass
                if price is None:
                    for _pc in _ndr.select('.a-price'):
                        _pw = _pc.select_one('.a-price-whole')
                        _pf = _pc.select_one('.a-price-fraction')
                        if _pw and _pw.text.strip('.').replace(',', ''):
                            try:
                                pt = _pw.text.strip('.').replace(',', '')
                                _p = float(f"{pt}.{_pf.text.strip()}" if _pf and _pf.text.strip() else pt)
                                if 0.01 <= _p <= 99999:
                                    price = _p
                                    print(f"  [parser] Non-deal price {price} from non-prime row")
                                    break
                            except ValueError:
                                continue

        # Generic .a-price-whole: always find whole+fraction within the SAME
        # .a-price container to prevent mixing values from different elements
        # (e.g. "5" from S&S and "0" from an unrelated button giving £5.0).
        # Skipped for Prime accordion pages — handled by the block above.
        # Scoped to buy box / core price div (not full soup) so the "Consider
        # these available items" carousel can never contribute a false price.
        if price is None and not _see_all_buying and not _used_buybox and not _has_prime_accordion and not _out_of_stock:
            _pw_scope = _core_price_div or _buybox or soup
            for _price_container in _pw_scope.select('.a-price'):
                if _has_sns and any(
                    p.get('id', '').lower() in _SNS_PARENT_IDS
                    for p in _price_container.parents if p.name
                ):
                    continue
                pw = _price_container.select_one('.a-price-whole')
                pf = _price_container.select_one('.a-price-fraction')
                if pw and pw.text.strip('.').replace(',', ''):
                    try:
                        pt = pw.text.strip('.').replace(',', '')
                        _p = float(f"{pt}.{pf.text.strip()}" if pf and pf.text.strip() else pt)
                        if 0.01 <= _p <= 99999:
                            price = _p
                            break
                    except ValueError:
                        continue

        # Generic span.a-offscreen: same scoping strategy.
        # Skipped for Prime accordion pages — handled by the block above.
        if price is None and not _see_all_buying and not _used_buybox and not _has_prime_accordion and not _out_of_stock:
            _os_scope = _core_price_div or _buybox or soup
            for el in _os_scope.select('span.a-offscreen'):
                if _has_sns and any(
                    p.get('id', '').lower() in _SNS_PARENT_IDS
                    for p in el.parents if p.name
                ):
                    continue
                m = re.search(r'[\d,]+\.?\d*', el.text.strip())
                if m:
                    try:
                        price = float(m.group().replace(',', ''))
                        break
                    except ValueError:
                        pass

        # ── Layer 4: Regex scan of raw HTML for embedded JS/JSON price data ──
        # Skip for Prime accordion pages — embedded JSON contains the Prime price.
        if price is None and not _see_all_buying and not _used_buybox and not _has_prime_accordion and not _out_of_stock:
            _raw_price_patterns = [
                # One-time purchase price patterns — highest priority
                r'"oneTimePurchasePrice"\s*:\s*"[^\d]*([\d,]+\.?\d*)"',
                r'"buyNowPrice"\s*:\s*"[^\d]*([\d,]+\.?\d*)"',
                r'"priceAmount"\s*:\s*"([\d,]+\.?\d*)"',
                r'"buyingPrice"\s*:\s*([\d,]+\.?\d*)',
                r'"unitPrice"\s*:\s*"([\d,]+\.?\d*)"',
                r'"amount"\s*:\s*"([\d,]+\.?\d*)"\s*,\s*"currencyCode"\s*:\s*"GBP"',
                r'name="displayedPrice"\s+value="([\d,]+\.?\d*)"',
                r'data-asin-price="([\d,]+\.?\d*)"',
                r'"displayPrice"\s*:\s*"[^\d]*([\d,]+\.?\d*)"',
                r'"price"\s*:\s*\{"amount"\s*:\s*"([\d,]+\.?\d*)"',
                r'"currentPrice"\s*:\s*"?([\d,]+\.?\d*)"?',
                r'"value"\s*:\s*"?([\d,]+\.?\d*)"?\s*,\s*"[^"]*"\s*:\s*"[£$€]"',
                r'id=["\']price["\'][^>]*>\s*[£$€]?\s*([\d,]+\.?\d*)',
            ]
            for _pat in _raw_price_patterns:
                _m = re.search(_pat, html_content)
                if _m:
                    try:
                        _p = float(_m.group(1).replace(',', ''))
                        if 0.01 <= _p <= 99999:
                            price = _p
                            break
                    except (ValueError, TypeError):
                        pass

        # ── Layer 4b: Parse Amazon a-state script tags ────────────────────
        if price is None and not _see_all_buying and not _used_buybox and not _has_prime_accordion and not _out_of_stock:
            for script in soup.find_all('script', {'type': 'a-state'}):
                try:
                    data = json.loads(script.string or '')
                    # Walk the JSON looking for a numeric price value
                    def _find_price(obj, depth=0):
                        if depth > 6:
                            return None
                        if isinstance(obj, dict):
                            for k, v in obj.items():
                                if k in ('priceAmount', 'amount', 'price', 'buyingPrice',
                                         'unitPrice', 'currentPrice'):
                                    try:
                                        p = float(str(v).replace(',', ''))
                                        if 0.01 <= p <= 99999:
                                            return p
                                    except (ValueError, TypeError):
                                        pass
                                result = _find_price(v, depth + 1)
                                if result:
                                    return result
                        elif isinstance(obj, list):
                            for item in obj:
                                result = _find_price(item, depth + 1)
                                if result:
                                    return result
                        return None
                    found = _find_price(data)
                    if found:
                        price = found
                        break
                except (json.JSONDecodeError, AttributeError):
                    continue

        # Currency
        _CURRENCY_MAP = {'GBP': '£', 'USD': '$', 'EUR': '€', 'INR': '₹',
                         'JPY': '¥', 'AUD': 'A$', 'CAD': 'C$'}
        if not currency:
            cel = soup.select_one('.a-price-symbol')
            if cel:
                currency = cel.text.strip() or None
        if not currency and price is not None:
            el = soup.select_one('span.a-offscreen')
            if el:
                m = re.search(r'^[^\d]+', el.text.strip())
                if m:
                    currency = m.group().strip() or None
        # Try currency from raw HTML patterns
        if not currency:
            _cu_pats = [
                r'"currencyCode"\s*:\s*"([A-Z]{3})"',
                r'"currencySymbol"\s*:\s*"([^"]+)"',
                r'"priceCurrency"\s*:\s*"([^"]+)"',
                r'id="twister-plus-price-data-price-unit"\s+value="([^"]+)"',
            ]
            for _cp in _cu_pats:
                _cm = re.search(_cp, html_content)
                if _cm:
                    _cv = _cm.group(1).strip()
                    currency = _CURRENCY_MAP.get(_cv, _cv)
                    break

        # Brand
        if not brand_name:
            brand_elem = soup.select_one('#bylineInfo')
            if brand_elem:
                brand_name = extract_brand_name(brand_elem.text.strip())
        if not brand_name:
            for bullet in soup.select('#detailBullets_feature_div li'):
                if 'brand' in bullet.text.lower():
                    b = bullet.select_one('.a-text-bold + span')
                    if b:
                        brand_name = b.text.strip()
                    break

        # Image
        if not img_url:
            img_elem = (soup.select_one('#landingImage') or
                        soup.select_one('#imgBlkFront'))
            if img_elem:
                img_url = img_elem.get('src')
                if not img_url:
                    doh = img_elem.get('data-old-hires')
                    dadyn = img_elem.get('data-a-dynamic-image')
                    if doh:
                        img_url = doh
                    elif dadyn:
                        try:
                            img_url = list(json.loads(dadyn).keys())[0]
                        except Exception:
                            pass

        # Rating
        if rating is None:
            rel = soup.select_one('#acrPopover') or soup.select_one('span.a-icon-alt')
            if rel:
                rt = rel.get('title', '') or rel.text
                rm = re.search(r'([\d\.]+)\s+out\s+of\s+5', rt)
                if rm:
                    rating = float(rm.group(1))

        # Delivery date
        # data-csa-c-delivery-time is Amazon's machine-readable date attribute on the
        # primary delivery span (e.g. "Friday, 24 July"). For "See All Buying Options"
        # pages, the delivery info lives inside the AOD panel (#unified-delivery-message-0)
        # which only appears in Playwright-rendered HTML after the button is clicked.
        _primary_delivery = (
            soup.select_one('#unified-delivery-message-0 #mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE') or
            soup.select_one('#unified-delivery-message-0 #mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_MEDIUM') or
            soup.select_one('#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE') or
            soup.select_one('#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_MEDIUM')
        )
        if _primary_delivery:
            _ds = _primary_delivery.select_one('[data-csa-c-delivery-time]')
            if _ds:
                delivery_date = _ds.get('data-csa-c-delivery-time', '').strip() or None
            if not delivery_date:
                _bold = _primary_delivery.select_one('span.a-text-bold')
                if _bold and _bold.text.strip():
                    delivery_date = _bold.text.strip()
        if not delivery_date:
            _ds = soup.select_one('[data-csa-c-delivery-time]')
            if _ds:
                delivery_date = _ds.get('data-csa-c-delivery-time', '').strip() or None

        # ASIN & canonical URL
        asin = extract_asin(url) if url else None
        canonical_url = format_canonical_url(url, asin, country_code) if asin else url

        return {
            "title": title,
            "price": price,
            "img_url": img_url,
            "currency": currency,
            "brand": brand_name,
            "url": canonical_url,
            "asin": asin,
            "rating": rating,
            "delivery_date": delivery_date,
            "_see_all_buying": _see_all_buying,
            "_used_buybox": _used_buybox,
            "out_of_stock": _out_of_stock,
            "availability_text": _availability_text,
        }

    except Exception as e:
        print(f"Error parsing product page: {e}")
        return None


def parse_aod_html(html_content: str) -> Tuple[Optional[float], Optional[str], Optional[str]]:
    """
    Parse price and delivery date from Amazon's AOD (All Offers Display) Ajax HTML.

    Amazon returns this HTML when the "See All Buying Options" Ajax request fires.
    The first offer's price lives in #aod-price-1; delivery date is in
    [data-csa-c-delivery-time] just like the main product page.

    Returns (price_float, currency_symbol, delivery_date) or (None, None, None).
    """
    if not html_content:
        return None, None, None

    soup = BeautifulSoup(html_content, 'lxml')
    price = None
    currency = None
    delivery_date = None

    aod = soup.select_one('#aod-price-1')
    if not aod:
        print("  [aod] #aod-price-1 not found in AOD response")
        return None, None, None

    # Try span.a-offscreen first — normally holds the full price string e.g. "£298.00"
    for offscreen in aod.select('span.a-offscreen'):
        txt = offscreen.text.strip()
        m = re.search(r'[\d,]+\.?\d*', txt)
        if m:
            try:
                candidate = float(m.group().replace(',', ''))
                if 0.01 <= candidate <= 99999:
                    price = candidate
                    sym = re.search(r'[£$€¥₹]', txt)
                    currency = sym.group() if sym else None
                    print(f"  [aod] Price {price} from span.a-offscreen")
                    break
            except ValueError:
                continue

    # Fallback: Amazon's WCAG accessibility label — used when span.a-offscreen is empty
    if price is None:
        for apex in aod.select('span.aok-offscreen.apex-pricetopay-accessibility-label, span.aok-offscreen'):
            txt = apex.text.strip()
            m = re.search(r'[\d,]+\.?\d*', txt)
            if m:
                try:
                    candidate = float(m.group().replace(',', ''))
                    if 0.01 <= candidate <= 99999:
                        price = candidate
                        sym = re.search(r'[£$€¥₹]', txt)
                        currency = sym.group() if sym else None
                        print(f"  [aod] Price {price} from aok-offscreen apex label")
                        break
                except ValueError:
                    continue

    # Fall back to whole+fraction construction
    if price is None:
        for pc in aod.select('.a-price'):
            pw = pc.select_one('.a-price-whole')
            pf = pc.select_one('.a-price-fraction')
            sym = pc.select_one('.a-price-symbol')
            if pw and pw.text.strip('.').replace(',', ''):
                try:
                    pt = pw.text.strip('.').replace(',', '')
                    candidate = float(
                        f"{pt}.{pf.text.strip()}" if pf and pf.text.strip() else pt
                    )
                    if 0.01 <= candidate <= 99999:
                        price = candidate
                        currency = sym.text.strip() if sym else None
                        print(f"  [aod] Price {price} from .a-price-whole")
                        break
                except ValueError:
                    continue

    if price is None:
        print("  [aod] Could not extract price from AOD response")
        return None, None, None

    # Delivery date
    ds = soup.select_one('[data-csa-c-delivery-time]')
    if ds:
        delivery_date = ds.get('data-csa-c-delivery-time', '').strip() or None
    if not delivery_date:
        db = (
            soup.select_one('#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE') or
            soup.select_one('#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_MEDIUM')
        )
        if db:
            bold = db.select_one('span.a-text-bold')
            if bold and bold.text.strip():
                delivery_date = bold.text.strip()

    return price, currency, delivery_date


def parse_search_page(html_content: str, base_url: str = None, country_code: str = None) -> List[Dict]:
    """
    Parse Amazon search results page HTML and extract product listings.
    
    This function extracts a list of products from search or category pages:
    - Product title, URL, and ASIN
    - Price and currency
    - Thumbnail image
    - Ratings and review count when available
    - Prime eligibility
    - Color variants
    - Discounts
    
    Args:
        html_content (str): Raw HTML content of the search results page
        base_url (str, optional): Base URL for resolving relative URLs
        country_code (str, optional): Country code for URL formatting
        
    Returns:
        List[Dict]: List of extracted product data dictionaries
        Empty list: If parsing fails or HTML indicates a CAPTCHA/block
    """
    if not html_content:
        print("Error: Received empty HTML content for search page")
        return []
    
    # Use lxml parser for better performance on large search pages
    soup = BeautifulSoup(html_content, 'lxml')
    
    # Check for CAPTCHA / Block Page before detailed parsing
    if "captcha" in html_content.lower() or "api-services-support@amazon.com" in html_content:
        print("CAPTCHA or block page detected in search results")
        return []
    
    # Prepare results list
    results = []

    try:
        # Try to locate search result containers - Amazon has multiple formats
        # Try the most common selectors first
        product_containers = soup.select('div[data-component-type="s-search-result"]')
        
        # Alternative selectors for different Amazon layouts
        if not product_containers:
            product_containers = soup.select('.s-result-item[data-asin]')
        
        if not product_containers:
            # Try more generic selectors as fallback
            product_containers = soup.select('.s-result-item')
        
        print(f"Found {len(product_containers)} potential product containers")
        
        # Process each product container
        for container in product_containers:
            
            try:
                # Skip sponsored listings if they don't have complete data
                if 'AdHolder' in container.get('class', []):
                    continue
                
                # Skip non-product containers (sometimes Amazon includes dividers, etc.)
                # Extract ASIN (Amazon Standard Identification Number)
                asin = container.get('data-asin') or container.get('asin')
                if not asin or asin == "":
                    continue
                
                # Initialize product data dictionary
                product_data = {"asin": asin}
                
                # Extract product URL and title (multiple possible selectors)
                title_link = None
                
                # Try various title selectors that appear across different Amazon layouts
                title_selectors = [
                    'h2 a.a-link-normal',             # Common layout
                    '.a-text-normal[href]',           # Alternative layout
                    'h2.a-size-base-plus a',          # Layout from example
                    'a.s-line-clamp-2',               # Another layout from example
                    '.a-text-normal[data-hover]',     # Alternative layout
                    '.a-size-base-plus[aria-label]'   # Layout with aria-label
                ]
                
                for selector in title_selectors:
                    title_link = container.select_one(selector)
                    if title_link:
                        break
                
                if title_link:
                    # Extract title - check multiple attributes
                    if title_link.get('aria-label'):
                        product_data['title'] = title_link.get('aria-label')
                    elif title_link.select_one('span'):
                        product_data['title'] = title_link.select_one('span').text.strip()
                    else:
                        product_data['title'] = title_link.text.strip()
                    
                    # Extract URL from href attribute
                    href = title_link.get('href')
                    if href:
                        # Handle relative URLs
                        if href.startswith('/'):
                            product_url = urljoin(base_url, href) if base_url else href
                        else:
                            product_url = href
                            
                        # Store the URL but also create a canonical version
                        product_data['url'] = format_canonical_url(product_url, asin, country_code)
                
                # Extract brand (multiple possible locations)
                brand_selectors = [
                    '.a-row .a-size-base-plus.a-color-base',  # Common location
                    '.a-size-base-plus:not([aria-label])',    # Alternative location
                    'h2 .a-size-base-plus',                   # Format from example
                    '.s-line-clamp-1 span'                    # Another common format
                ]
                
                for selector in brand_selectors:
                    brand_elem = container.select_one(selector)
                    if brand_elem and brand_elem.text.strip():
                        product_data['brand'] = brand_elem.text.strip()
                        break
                
                # Extract price information (multiple possible selectors)
                # First, look for the a-price structure (most common)
                price_element = container.select_one('.a-price .a-offscreen')
                if price_element:
                    price_text = price_element.text.strip()
                    # Parse price and currency
                    currency_match = re.search(r'^[^\d]+', price_text)
                    price_match = re.search(r'[\d,]+\.?\d*', price_text)
                    
                    if currency_match:
                        product_data['currency'] = currency_match.group().strip()
                    
                    if price_match:
                        price_str = price_match.group().replace(',', '')
                        # Only convert to float if it's a valid number (not just a decimal point)
                        if price_str and price_str != ".":
                            try:
                                product_data['price'] = float(price_str)
                            except ValueError:
                                # If conversion fails, just log and continue without price
                                print(f"Warning: Could not convert price string: '{price_str}'")
                        
                # If price not found, try alternative selectors
                if 'price' not in product_data:
                    price_whole = container.select_one('.a-price-whole')
                    price_fraction = container.select_one('.a-price-fraction')
                    if price_whole:
                        price_text = price_whole.text.strip().replace(',', '')
                        if price_text and price_text != ".":
                            try:
                                if price_fraction:
                                    fraction_text = price_fraction.text.strip()
                                    if fraction_text and fraction_text != ".":
                                        product_data['price'] = float(f"{price_text}.{fraction_text}")
                                else:
                                    product_data['price'] = float(price_text)
                            except ValueError:
                                print(f"Warning: Could not convert price parts: '{price_text}' and '{fraction_text if price_fraction else ''}'")
                            
                # Extract currency symbol if not already found
                if 'currency' not in product_data and container.select_one('.a-price-symbol'):
                    product_data['currency'] = container.select_one('.a-price-symbol').text.strip()
                
                # Extract original price and calculate discount (if available)
                original_price_elem = container.select_one('.a-price.a-text-price .a-offscreen')
                if original_price_elem:
                    original_price_text = original_price_elem.text.strip()
                    price_match = re.search(r'[\d,]+\.?\d*', original_price_text)
                    if price_match:
                        price_str = price_match.group().replace(',', '')
                        if price_str and price_str != ".":
                            try:
                                original_price = float(price_str)
                                product_data['original_price'] = original_price
                                
                                # Calculate discount percentage if both prices are available
                                if 'price' in product_data and product_data['price'] > 0:
                                    discount = round(100 - (product_data['price'] / original_price * 100))
                                    product_data['discount_percent'] = discount
                            except ValueError:
                                print(f"Warning: Could not convert original price string: '{price_str}'")
                
                # Extract discount percentage directly if available
                discount_text = container.select_one('span:-soup-contains("% off")')
                if discount_text and 'discount_percent' not in product_data:
                    discount_match = re.search(r'(\d+)%', discount_text.text)
                    if discount_match:
                        product_data['discount_percent'] = int(discount_match.group(1))
                
                # Extract product image (multiple possible selectors)
                img_selectors = [
                    'img.s-image',                     # Common layout
                    '.s-image img',                    # Alternative layout
                    '.a-section img[srcset]',          # Layout from example
                    '.s-product-image-container img'   # Another layout
                ]
                
                for selector in img_selectors:
                    img_element = container.select_one(selector)
                    if img_element:
                        # First try to get the highest resolution version using srcset
                        if img_element.get('srcset'):
                            srcset = img_element.get('srcset')
                            srcset_parts = srcset.split(',')
                            if srcset_parts:
                                # Get the last one (usually highest resolution)
                                highest_res = srcset_parts[-1].strip().split(' ')[0]
                                product_data['img_url'] = highest_res
                        # Fallback to src attribute
                        if 'img_url' not in product_data and img_element.get('src'):
                            product_data['img_url'] = img_element.get('src')
                        break
                
                # Extract ratings (multiple possible formats)
                rating_selectors = [
                    'i.a-icon-star-small',            # Common layout
                    '.a-icon-star',                   # Alternative layout
                    'span.a-icon-alt',                # Text inside span
                    'i.a-star-mini-4',                # Format from example
                    '[aria-label*="out of 5 stars"]'  # Aria-label format
                ]
                
                for selector in rating_selectors:
                    rating_element = container.select_one(selector)
                    if rating_element:
                        # Try to extract from aria-label first
                        if rating_element.get('aria-label') and 'out of 5' in rating_element.get('aria-label'):
                            rating_text = rating_element.get('aria-label')
                        # Try alt text next
                        elif rating_element.get('alt') and 'out of 5' in rating_element.get('alt'):
                            rating_text = rating_element.get('alt')
                        # Try inner text or parent text
                        else:
                            rating_text = rating_element.text.strip()
                            # If no text, try parent
                            if not rating_text and rating_element.parent:
                                rating_text = rating_element.parent.text.strip()
                            
                        # Extract the numeric rating
                        rating_match = re.search(r'([\d\.]+)(?:\s+out\s+of\s+5)?', rating_text)
                        if rating_match:
                            rating_str = rating_match.group(1)
                            if rating_str and rating_str != ".":
                                try:
                                    product_data['rating'] = float(rating_str)
                                except ValueError:
                                    print(f"Warning: Could not convert rating string: '{rating_str}'")
                            break
                
                # Extract reviews count (multiple possible formats)
                reviews_selectors = [
                    'span[aria-label*="reviews"]',                 # Common layout
                    '.a-size-base.s-underline-text',               # Format from example
                    'a:-soup-contains("ratings")',                 # Alternative text-based
                    'a:-soup-contains("reviews")',                 # Another alternative
                    '.a-link-normal .a-size-base'                  # Generic link to reviews
                ]
                
                for selector in reviews_selectors:
                    reviews_element = container.select_one(selector)
                    if reviews_element:
                        reviews_text = ""
                        # Try aria-label first
                        if reviews_element.get('aria-label'):
                            reviews_text = reviews_element.get('aria-label')
                        # Otherwise use text content
                        else:
                            reviews_text = reviews_element.text.strip()
                        
                        # Extract digits with K/M suffix handling
                        reviews_match = re.search(r'([\d,\.]+)(?:K|k|M)?', reviews_text)
                        if reviews_match:
                            count_text = reviews_match.group(1).replace(',', '')
                            if count_text and count_text != ".":
                                try:
                                    count = float(count_text)
                                    
                                    # Handle K/M suffixes
                                    if 'K' in reviews_text or 'k' in reviews_text:
                                        count *= 1000
                                    elif 'M' in reviews_text:
                                        count *= 1000000
                                        
                                    product_data['reviews_count'] = int(count)
                                except ValueError:
                                    print(f"Warning: Could not convert reviews count: '{count_text}'")
                            break
                
                # Check for Prime eligibility
                prime_selectors = [
                    'i.a-icon-prime',                     # Common layout
                    '.a-icon-prime',                      # Alternative layout
                    'span:-soup-contains("Prime")',       # Text-based detection
                    '.aok-relative.s-icon-text-medium',   # Format from example
                    '[aria-label="Prime"]'                # Aria-label based
                ]
                
                product_data['prime'] = any(container.select_one(selector) for selector in prime_selectors)
                
                # Extract color variants if available
                color_variants = []
                color_swatches = container.select('.s-color-swatch-outer-circle')
                
                if color_swatches:
                    for swatch in color_swatches:
                        color_link = swatch.select_one('a')
                        if color_link:
                            color_name = color_link.get('aria-label', '')
                            color_url = color_link.get('href', '')
                            color_asin = None
                            
                            # Try to extract ASIN from URL
                            if color_url:
                                color_asin = extract_asin(color_url)
                                
                            if color_name:
                                if color_url.startswith('/'):
                                    color_url = urljoin(base_url, color_url) if base_url else color_url
                                
                                # Format the canonical URL for color variant
                                canonical_color_url = format_canonical_url(color_url, color_asin, country_code) if color_asin else color_url
                                
                                color_variants.append({
                                    'name': color_name,
                                    'url': canonical_color_url,
                                    'asin': color_asin
                                })
                
                if color_variants:
                    product_data['color_variants'] = color_variants
                
                # Extract "Amazon's Choice" or "Best Seller" badges
                badge_text = None
                badge_element = container.select_one('.a-badge-text') or container.select_one('[aria-label*="Choice"]')
                if badge_element:
                    badge_text = badge_element.text.strip()
                    if not badge_text and badge_element.get('aria-label'):
                        badge_text = badge_element.get('aria-label')
                    
                    if badge_text:
                        product_data['badge'] = badge_text
                
                # Extract delivery information
                delivery_element = container.select_one('.a-row:-soup-contains("delivery")') or container.select_one('[aria-label*="delivery"]')
                if delivery_element:
                    delivery_text = delivery_element.text.strip()
                    product_data['delivery_info'] = delivery_text
                
                # Extract "Deal" information
                deal_element = container.select_one('span:-soup-contains("Deal")') or container.select_one('.a-badge:-soup-contains("Deal")')
                if deal_element:
                    product_data['deal'] = True
                
                # Add the product to our results list if we have the key information
                if product_data.get('title') and product_data.get('asin'):
                    results.append(product_data)
                
            except Exception as e:
                print(f"Error parsing individual search result: {e}")
                continue  # Skip this item and continue with the next
        
        return results
        
    except Exception as e:
        print(f"Error parsing search page: {e}")
        return []


def parse_pagination_url(html_content: str, base_url: str = None) -> Optional[str]:
    """
    Extract the URL for the next page from search results pagination.
    
    Args:
        html_content (str): Raw HTML content of the search results page
        base_url (str, optional): Base URL for resolving relative URLs
        
    Returns:
        Optional[str]: URL of the next page, or None if there isn't one
    """
    if not html_content:
        return None
    
    soup = BeautifulSoup(html_content, 'lxml')
    
    # Try multiple selectors for pagination "Next" button
    next_link = (
        soup.select_one('a.s-pagination-next:not(.s-pagination-disabled)') or
        soup.select_one('li.a-last:not(.a-disabled) a') or
        soup.select_one('a:has(span:contains("Next"))') or
        soup.select_one('a[aria-label="Go to next page"]')
    )
    
    if next_link and next_link.get('href'):
        next_url = next_link['href']
        # Handle relative URLs
        if next_url.startswith('/'):
            return urljoin(base_url, next_url) if base_url else next_url
        return next_url
    
    return None
