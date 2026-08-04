"""
Vision-based price extraction using Playwright + Claude Vision API.

Playwright renders the Amazon page with real Chrome (executes JavaScript, so
shell/dynamic pages load fully). A screenshot is sent to Claude Haiku which
reads the price from the two standard Amazon price locations:
  1. Next to the product title (main price area)
  2. Buy box on the right side of the page

This is used as a fallback when HTML parsing cannot find the price.
"""

import base64
import os
import re
from typing import Optional, Tuple


def _proxy_dict_to_playwright(proxy_dict: Optional[dict]) -> Optional[dict]:
    """Convert curl_cffi proxy dict to Playwright proxy config."""
    if not proxy_dict:
        return None
    proxy_url = proxy_dict.get("https") or proxy_dict.get("http") or ""
    # Format: http://username:password@ip:port
    m = re.match(r"https?://([^:]+):([^@]+)@(.+)", proxy_url)
    if m:
        return {
            "server": f"http://{m.group(3)}",
            "username": m.group(1),
            "password": m.group(2),
        }
    return {"server": proxy_url}


def _launch_playwright_page(url: str, proxy_dict: Optional[dict] = None,
                            postcode: Optional[str] = None,
                            session_cookies: Optional[dict] = None):
    """
    Shared helper: launch headless Chromium, navigate to url, wait for price
    area to settle, and return (page, browser, playwright_context) tuple.
    Caller must close the browser when done.
    Returns None on failure.

    session_cookies: dict of name→value cookies from the curl_cffi session.
      When provided they are injected into the browser context before the first
      navigation so Amazon sees the same session (including delivery postcode)
      as the curl_cffi request that fetched the static HTML. This replaces the
      in-page postcode-setting fetch which was unreliable for fresh browser
      instances without pre-existing Amazon cookies.
    """
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    except ImportError:
        print("[vision] playwright not installed — run: pip install playwright && playwright install chromium")
        return None

    pw_proxy = _proxy_dict_to_playwright(proxy_dict)
    # Derive the Amazon domain from the URL for cookie scoping
    _domain_m = re.search(r'amazon\.([a-z.]+)', url)
    _cookie_domain = f".amazon.{_domain_m.group(1)}" if _domain_m else ".amazon.co.uk"

    try:
        # sync_playwright uses asyncio internally and will refuse to start if it
        # detects a running event loop in the thread (FastAPI's uvicorn loop leaks
        # into ThreadPoolExecutor workers). Clearing the loop reference here lets
        # sync_playwright create its own without conflict.
        import asyncio as _asyncio
        try:
            _asyncio.set_event_loop(None)
        except Exception:
            pass

        p = sync_playwright().start()
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1440, "height": 900},
            locale="en-GB",
            proxy=pw_proxy,
        )

        # Inject curl_cffi session cookies so the browser starts with the same
        # authenticated, location-aware state that the static-HTML request had.
        # This avoids geolocation mismatches (e.g. Pakistan instead of M1 1AE)
        # that prevent the buy box from rendering correctly.
        if session_cookies:
            _pw_cookies = [
                {"name": str(k), "value": str(v),
                 "domain": _cookie_domain, "path": "/"}
                for k, v in session_cookies.items() if k and v
            ]
            if _pw_cookies:
                context.add_cookies(_pw_cookies)

        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=30_000)

        # Set delivery postcode only when session cookies are NOT provided.
        # When cookies are shared the postcode is already embedded in the session
        # (set by AmzSession.set_delivery_postcode earlier), so repeating it here
        # would cause an unnecessary page reload.
        if postcode and not session_cookies:
            clean_pc = postcode.replace(" ", "").upper()
            try:
                page.evaluate(f"""async () => {{
                    const csrf = document.cookie.split(';')
                        .find(c => c.trim().startsWith('anti-csrftoken-a2z='))
                        ?.split('=')[1] || '';
                    await fetch('/portal-migration/hz/glow/address-change', {{
                        method: 'POST',
                        headers: {{
                            'anti-csrftoken-a2z': csrf,
                            'x-requested-with': 'XMLHttpRequest',
                            'Content-Type': 'application/x-www-form-urlencoded',
                        }},
                        body: new URLSearchParams({{
                            actionSource: 'glow',
                            locationType: 'LOCATION_INPUT',
                            zipCode: '{clean_pc}',
                            deviceType: 'web',
                            pageType: 'Detail',
                            storeContext: 'NoStoreName',
                            encryptedAddressToken: '',
                        }}).toString(),
                    }});
                }}""")
                page.wait_for_timeout(400)
                page.reload(wait_until="domcontentloaded", timeout=20_000)
                print(f"  [playwright] Delivery postcode set to: {postcode}")
            except Exception as _e:
                print(f"  [playwright] Postcode set error: {_e}")
        elif session_cookies:
            print(f"  [playwright] Using session cookies (location already set)")

        # Wait for buy box or price area to settle
        try:
            page.wait_for_selector(
                "#corePriceDisplay_desktop_feature_div, "
                "[id^='buybox-see-all-buying-choices'], "
                "#add-to-cart-button, #price, #priceblock_ourprice",
                timeout=8_000,
            )
        except Exception:
            pass

        # For products with Subscribe & Save, Amazon initialises with S&S active.
        try:
            otp_locator = page.get_by_text("One-time purchase", exact=False).first
            if otp_locator.count():
                otp_locator.click(timeout=3000)
                page.wait_for_timeout(1200)
        except Exception:
            try:
                radio = page.query_selector('#desktop_buybox input[type="radio"]')
                if radio:
                    radio.click()
                    page.wait_for_timeout(1200)
            except Exception:
                pass

        # For products with Prime accordion pricing: activate Non-Deal Price.
        try:
            non_deal = page.get_by_text("Non-Deal Price", exact=False).first
            if non_deal.count():
                non_deal.click(timeout=3000)
                page.wait_for_timeout(2000)
                print("  [playwright] Clicked 'Non-Deal Price' to get standard retail price")
        except Exception:
            pass

        # For "See All Buying Options" products: navigate to the offer-listing page.
        # Amazon's offer-listing URL automatically opens the buying options sidebar
        # showing all available sellers with prices and delivery dates. This is more
        # reliable than ?aod=1 which requires Amazon JS to auto-open the panel.
        try:
            _has_sab = page.query_selector(
                '[id^="buybox-see-all-buying-choices"], a[title="See All Buying Options"]'
            )
            if _has_sab:
                _asin_m = re.search(r'/dp/([A-Z0-9]{10})', url)
                _dom_m = re.search(r'amazon\.([\w.]+)', url)
                if _asin_m and _dom_m:
                    _offer_url = (
                        f"https://www.amazon.{_dom_m.group(1)}"
                        f"/gp/offer-listing/{_asin_m.group(1)}"
                        f"/ref=dp_olp_unknown_mbc"
                    )
                    print(f"  [playwright] 'See All Buying Options' — navigating to offer-listing page")
                    page.goto(_offer_url, wait_until="domcontentloaded", timeout=20_000)
                    page.wait_for_timeout(3000)
                    try:
                        page.wait_for_selector(
                            '#aod-price-1, [id^="aod-offer-price"], [id^="aod-price"], '
                            '#aod-offer-list, #olpOfferList',
                            timeout=10_000,
                        )
                        print("  [playwright] Offer listing loaded")
                    except Exception:
                        print("  [playwright] Offer listing panel not detected")
                else:
                    # Fallback: ?aod=1 if ASIN can't be extracted from URL
                    _aod_url = f"{url.split('?')[0].rstrip('/')}?aod=1"
                    print(f"  [playwright] 'See All Buying Options' — navigating to ?aod=1 (fallback)")
                    page.goto(_aod_url, wait_until="domcontentloaded", timeout=20_000)
                    page.wait_for_timeout(3000)
                    try:
                        page.wait_for_selector(
                            '#aod-price-1, [id^="aod-price"], #aod-offer-list',
                            timeout=10_000,
                        )
                        print("  [playwright] AOD panel loaded")
                    except Exception:
                        print("  [playwright] AOD panel not detected after ?aod=1")
        except Exception as _e:
            print(f"  [playwright] AOD navigation error: {_e}")

        # For "Used" buybox products: navigate to the offer listing page.
        # When the primary buybox shows a used item ("Buy used £X.XX"), the JS evaluator
        # would read the used price. Navigating to the offer listing page shows all
        # sellers including new offers, and the AOD panel selectors pick up the first price.
        try:
            if '/gp/offer-listing/' not in page.url:
                _buybox_el = page.query_selector('#desktop_buybox, #rightCol')
                if _buybox_el and 'buy used' in _buybox_el.inner_text().lower():
                    _asin_m2 = re.search(r'/dp/([A-Z0-9]{10})', url)
                    _dom_m2 = re.search(r'amazon\.([\w.]+)', url)
                    if _asin_m2 and _dom_m2:
                        _offer_listing_url = (
                            f"https://www.amazon.{_dom_m2.group(1)}"
                            f"/gp/offer-listing/{_asin_m2.group(1)}"
                        )
                        print(f"  [playwright] Used buybox — navigating to offer listing page")
                        page.goto(_offer_listing_url, wait_until="domcontentloaded", timeout=20_000)
                        page.wait_for_timeout(3000)
                        try:
                            page.wait_for_selector(
                                '#aod-price-1, [id^="aod-offer-price"], [id^="aod-price"], '
                                '#aod-offer-list, #olpOfferList',
                                timeout=10_000,
                            )
                            print("  [playwright] Offer listing page loaded")
                        except Exception:
                            print("  [playwright] Offer listing panel not detected")
        except Exception as _e:
            print(f"  [playwright] Used buybox navigation error: {_e}")

        return page, browser, p
    except Exception as e:
        print(f"[playwright] Error launching browser: {e}")
        return None


def render_and_get_html(url: str, proxy_dict: Optional[dict] = None,
                        postcode: Optional[str] = None,
                        session_cookies: Optional[dict] = None) -> Optional[str]:
    """
    Render the Amazon product page with headless Chromium and return the fully
    rendered HTML (after JavaScript execution). Free — no API call needed.

    Use this as the primary fallback when curl_cffi returns a shell page or
    cannot find the price in the static HTML.
    """
    print(f"  [playwright] Rendering page: {url}")
    result = _launch_playwright_page(url, proxy_dict, postcode=postcode,
                                     session_cookies=session_cookies)
    if not result:
        return None
    page, browser, p = result
    try:
        html = page.content()
        return html
    except Exception as e:
        print(f"  [playwright] Error getting page content: {e}")
        return None
    finally:
        browser.close()
        p.stop()


def extract_price_from_dom(url: str, proxy_dict: Optional[dict] = None,
                           postcode: Optional[str] = None,
                           session_cookies: Optional[dict] = None) -> Tuple[Optional[float], Optional[str], Optional[str]]:
    """
    Render the page with Playwright, activate the appropriate buying option, then
    read price and delivery date directly from the live DOM.

    Returns (price_float, currency_symbol, delivery_date) or (None, None, None).
    """
    print(f"  [playwright] Extracting price from live DOM: {url}")
    result = _launch_playwright_page(url, proxy_dict, postcode=postcode,
                                     session_cookies=session_cookies)
    if not result:
        return None, None, None
    page, browser, p = result
    try:
        import json as _json
        raw_result = page.evaluate("""() => {
            // Skip prices inside the Prime-exclusive accordion row.
            function inPrimeSection(el) {
                let p = el.parentElement;
                while (p) {
                    if (p.id && p.id.toLowerCase() === 'primesavingsupsellaccordionrow') return true;
                    p = p.parentElement;
                }
                return false;
            }

            // Helper: build price string from whole+fraction within same container.
            // Falls back to span.a-offscreen when .a-price-whole is empty (Amazon
            // sometimes renders it as an invisible glyph while the offscreen span
            // holds the full price text e.g. "£14.99").
            function priceFromContainer(scope) {
                const containers = scope.querySelectorAll('.a-price');
                for (const c of containers) {
                    if (inPrimeSection(c)) continue;
                    const w = c.querySelector('.a-price-whole');
                    const f = c.querySelector('.a-price-fraction');
                    const sym = c.querySelector('.a-price-symbol');
                    if (w && w.textContent.trim()) {
                        const whole = w.textContent.replace(/[^\\d,]/g, '');
                        const frac  = f ? f.textContent.trim() : '';
                        const symbol = sym ? sym.textContent.trim() : '£';
                        return symbol + whole + (frac ? '.' + frac : '');
                    }
                    // .a-price-whole is empty — use the offscreen span instead
                    const offscreen = c.querySelector('span.a-offscreen');
                    if (offscreen && offscreen.textContent.trim()) {
                        return offscreen.textContent.trim();
                    }
                }
                return null;
            }

            let priceText = null;

            // Detect "See All Buying Options" state: the product page button OR
            // the offer-listing URL (which we navigate to for such products).
            const isSeeAllPage = !!(
                document.querySelector('[id^="buybox-see-all-buying-choices"]') ||
                document.querySelector('a[title="See All Buying Options"]') ||
                window.location.pathname.includes('/gp/offer-listing/')
            );

            // 0. AOD / offer-listing panel — price from the first available seller.
            // Covers #aod-price-1 (from ?aod=1), #aod-offer-price-1 (offer-listing),
            // and any [id^="aod-price"] / [id^="aod-offer-price"] variant.
            const aodEl = (
                document.querySelector('#aod-price-1') ||
                document.querySelector('#aod-offer-price-1') ||
                document.querySelector('[id^="aod-offer-price"]') ||
                document.querySelector('[id^="aod-price"]')
            );
            if (aodEl) {
                const label = aodEl.querySelector('.aok-offscreen.apex-pricetopay-accessibility-label, span.aok-offscreen');
                if (label && /[\\d]/.test(label.textContent)) {
                    priceText = label.textContent.trim();
                }
                if (!priceText) priceText = priceFromContainer(aodEl);
            }
            // Broader fallback for offer-listing page: search the whole offer list.
            if (!priceText && isSeeAllPage) {
                const offerList = document.querySelector('#aod-offer-list, #olpOfferList');
                if (offerList) {
                    const firstPrice = offerList.querySelector('.a-price');
                    if (firstPrice) {
                        const os = firstPrice.querySelector('span.a-offscreen');
                        if (os && /[\\d]/.test(os.textContent)) priceText = os.textContent.trim();
                        if (!priceText) priceText = priceFromContainer(firstPrice.parentElement || firstPrice);
                    }
                }
            }

            // If this is a "See All Buying Options" / offer-listing page but no panel
            // price was found, bail out rather than reading a carousel price.
            if (!priceText && isSeeAllPage) {
                return JSON.stringify({price: null, delivery: null});
            }

            // 1. Non-Deal accordion row (Prime accordion pages).
            if (!priceText) {
                const nonDealRow = document.querySelector('[data-a-accordion-row-name="newAccordionRow"]');
                if (nonDealRow) {
                    const content = nonDealRow.querySelector('[id^="accordion-auto"]');
                    if (content) priceText = priceFromContainer(content);
                    if (!priceText) priceText = priceFromContainer(nonDealRow);
                }
            }

            // 2. Core one-time price section (normal pages).
            if (!priceText) {
                const coreDiv = document.querySelector('#corePriceDisplay_desktop_feature_div')
                             || document.querySelector('#corePrice_feature_div');
                if (coreDiv) priceText = priceFromContainer(coreDiv);
            }

            // 3. .priceToPay area
            if (!priceText) {
                const ptpDiv = document.querySelector('.priceToPay');
                if (ptpDiv) priceText = priceFromContainer(ptpDiv.closest('div') || ptpDiv);
            }

            // 4. Text-only fallbacks
            if (!priceText) {
                for (const sel of ['#price_inside_buybox', '#priceblock_ourprice', '#priceblock_dealprice']) {
                    const el = document.querySelector(sel);
                    if (el && /[\\d]/.test(el.textContent)) { priceText = el.textContent.trim(); break; }
                }
            }

            // Delivery date: check AOD/offer-listing panel first, then main-page
            // delivery blocks. The global [data-csa-c-delivery-time] fallback
            // covers the offer-listing sidebar where delivery is inside the panel.
            let deliveryDate = null;
            const deliveryEl = document.querySelector(
                '#aod-offer-list [data-csa-c-delivery-time], ' +
                '#unified-delivery-message-0 [data-csa-c-delivery-time], ' +
                '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE [data-csa-c-delivery-time], ' +
                '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_MEDIUM [data-csa-c-delivery-time], ' +
                '[data-csa-c-delivery-time]'
            );
            if (deliveryEl) deliveryDate = deliveryEl.getAttribute('data-csa-c-delivery-time');
            // Text fallback: bold date in the first offer's delivery message.
            if (!deliveryDate) {
                const boldEl = document.querySelector(
                    '#aod-offer-list .a-text-bold, [id^="aod-offer-"] .a-text-bold'
                );
                if (boldEl && /\\d/.test(boldEl.textContent)) {
                    deliveryDate = boldEl.textContent.trim();
                }
            }

            return JSON.stringify({price: priceText, delivery: deliveryDate});
        }""")

        result_obj = _json.loads(raw_result) if raw_result else {}
        price_text = result_obj.get('price')
        delivery_date = result_obj.get('delivery') or None

        if not price_text:
            print("  [playwright] No price found in DOM")
            return None, None, None

        print(f"  [playwright] DOM price text: {repr(price_text)}, delivery: {repr(delivery_date)}")
        m = re.search(r'([\d,]+\.?\d*)', price_text.replace(',', ''))
        sym_m = re.search(r'([£$€¥₹])', price_text)
        if m:
            try:
                return float(m.group(1)), (sym_m.group(1) if sym_m else None), delivery_date
            except ValueError:
                pass
        return None, None, None

    except Exception as e:
        print(f"  [playwright] DOM extraction error: {e}")
        return None, None, None
    finally:
        browser.close()
        p.stop()


def screenshot_product_page(url: str, proxy_dict: Optional[dict] = None) -> Optional[bytes]:
    """
    Render the Amazon product page with headless Chromium and return a PNG screenshot.
    Used by extract_price_via_vision for Claude Vision API calls.
    """
    result = _launch_playwright_page(url, proxy_dict)
    if not result:
        return None
    page, browser, p = result
    try:
        screenshot = page.screenshot(full_page=False)
        return screenshot
    except Exception as e:
        print(f"  [playwright] Screenshot error: {e}")
        return None
    finally:
        browser.close()
        p.stop()


def extract_price_via_vision(
    url: str,
    proxy_dict: Optional[dict] = None,
    api_key: Optional[str] = None,
) -> Tuple[Optional[float], Optional[str]]:
    """
    Render the product page, screenshot it, and ask Claude Vision to read the price.

    Returns (price_float, currency_symbol) or (None, None) if extraction fails.

    Args:
        url: Amazon product page URL
        proxy_dict: curl_cffi-format proxy dict, e.g. {"https": "http://user:pass@ip:port"}
        api_key: Anthropic API key (falls back to ANTHROPIC_API_KEY env var)
    """
    try:
        import anthropic
    except ImportError:
        print("[vision] anthropic not installed — run: pip install anthropic")
        return None, None

    _api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not _api_key:
        print("[vision] Set ANTHROPIC_API_KEY environment variable to enable vision extraction")
        return None, None

    print(f"  [vision] Rendering page with Playwright: {url}")
    screenshot = screenshot_product_page(url, proxy_dict)
    if not screenshot:
        return None, None

    print("  [vision] Asking Claude Vision to identify the price...")
    client = anthropic.Anthropic(api_key=_api_key)
    image_b64 = base64.standard_b64encode(screenshot).decode()

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=60,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": image_b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "This is an Amazon product page. "
                            "Find the MAIN product selling price — it appears either "
                            "(a) next to the product title in the centre of the page, or "
                            "(b) in the buy box on the right side. "
                            "Ignore prices in 'Customers also bought', 'Consider these alternatives', "
                            "sponsored widgets, or any other recommendation carousels. "
                            "Reply with ONLY the currency symbol and number, e.g. '£6.11' or '$9.99'. "
                            "If the page shows 'See All Buying Options' with no single price, or if "
                            "the product page did not load properly, reply 'null'."
                        ),
                    },
                ],
            }
        ],
    )

    raw = response.content[0].text.strip()
    print(f"  [vision] Claude response: {raw!r}")

    if raw.lower() == "null":
        return None, None

    # Parse responses like "£6.11", "$ 9.99", "GBP 6.11"
    _SYMBOL_MAP = {"GBP": "£", "USD": "$", "EUR": "€", "JPY": "¥", "INR": "₹"}
    m = re.match(r"^([£$€¥₹]|[A-Z]{3})?\s*([\d,]+\.?\d*)$", raw.replace(",", ""))
    if m:
        sym = m.group(1) or None
        currency = _SYMBOL_MAP.get(sym, sym) if sym else None
        try:
            price = float(m.group(2))
            return price, currency
        except ValueError:
            pass

    # Looser fallback: grab any number from the response
    m2 = re.search(r"([\d]+\.?\d*)", raw)
    sym_m = re.search(r"([£$€¥₹])", raw)
    if m2:
        try:
            return float(m2.group(1)), (sym_m.group(1) if sym_m else None)
        except ValueError:
            pass

    print(f"  [vision] Could not parse price from response: {raw!r}")
    return None, None
