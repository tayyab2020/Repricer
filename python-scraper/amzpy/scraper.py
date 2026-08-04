"""
Amazon Product Scraper Module
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

This is the main module for the Amazon Product API using curl_cffi.
It orchestrates the scraping workflow including:
- Managing sessions through AmzSession
- Fetching product details
- Searching for products
- Handling configuration

The AmazonScraper class provides a simple interface for users
while handling the complexity of Amazon's anti-bot measures underneath.
"""

from typing import Dict, Optional, List, Union, Any
import re

from amzpy.session import AmzSession, DEFAULT_CONFIG
from amzpy.parser import parse_product_page, parse_search_page, parse_pagination_url, parse_aod_html
from amzpy.utils import parse_amazon_url

# Short-form country code aliases → actual Amazon TLD suffixes
COUNTRY_CODE_MAP = {
    "uk": "co.uk",
    "gb": "co.uk",
    "jp": "co.jp",
    "au": "com.au",
    "br": "com.br",
    "mx": "com.mx",
    "sg": "com.sg",
    "tr": "com.tr",
}


class AmazonScraper:
    """
    Main scraper class for Amazon product data using curl_cffi.

    This class provides a high-level interface to:
    - Fetch detailed information for individual products
    - Search products by ASIN list
    - Search for products and extract listings
    - Configure scraping behavior

    Attributes:
        country_code (str): Amazon domain TLD (e.g. "com", "co.uk")
        session (AmzSession): Session manager for handling requests
        user_config (dict): User configuration parameters
    """

    def __init__(self, country_code: str = "com", impersonate: str = None,
                 proxies: Optional[Union[Dict, list]] = None,
                 debug_html_dir: Optional[str] = None,
                 vision_api_key: Optional[str] = None,
                 use_vision_fallback: bool = True,
                 postcode: Optional[str] = None):
        """
        Initialize the Amazon scraper with the specified configuration.

        Args:
            country_code (str): Amazon domain country code (e.g. "com", "in", "uk")
            impersonate (str, optional): Browser to impersonate
            proxies: Single proxy dict OR list of proxy dicts for round-robin rotation
            debug_html_dir (str, optional): Directory to save raw HTML for ASINs
                                            where price could not be parsed
            vision_api_key (str, optional): Anthropic API key for vision fallback.
                                            Falls back to ANTHROPIC_API_KEY env var.
            use_vision_fallback (bool): When True, use Playwright + Claude Vision to
                                        extract price for products where HTML parsing fails.
            postcode (str, optional): Delivery postcode for location-specific pricing,
                                      e.g. "M1 1AE". Amazon shows different prices per
                                      delivery location. Set this to match your target area.
        """
        import os as _os
        self.country_code = COUNTRY_CODE_MAP.get(country_code.lower(), country_code)
        self.user_config = DEFAULT_CONFIG.copy()
        self.debug_html_dir = debug_html_dir
        self.vision_api_key = vision_api_key or _os.environ.get("ANTHROPIC_API_KEY")
        self.use_vision_fallback = use_vision_fallback and bool(self.vision_api_key)
        if debug_html_dir:
            _os.makedirs(debug_html_dir, exist_ok=True)
        self.session = AmzSession(
            country_code=self.country_code,
            impersonate=impersonate,
            proxies=proxies
        )
        if self.use_vision_fallback:
            print("Vision fallback enabled (Playwright + Claude Vision)")
        else:
            print("Vision fallback disabled (set ANTHROPIC_API_KEY to enable)")

        self.postcode = postcode
        if postcode:
            self.session.set_delivery_postcode(postcode)

        print(f"AmazonScraper initialized for amazon.{self.country_code}")
        
    def config(self, config_str: str = None, **kwargs) -> Dict:
        """
        Configure scraper parameters using either a string or keyword arguments.
        
        Examples:
            # Using string configuration
            scraper.config('MAX_RETRIES = 5, REQUEST_TIMEOUT = 30')
            
            # Using keyword arguments
            scraper.config(MAX_RETRIES=5, REQUEST_TIMEOUT=30)
        
        Args:
            config_str (str, optional): Configuration string in format 'PARAM1 = value1, PARAM2 = value2'
            **kwargs: Configuration parameters as keyword arguments
            
        Returns:
            Dict: Current configuration after updates
        """
        # Process string configuration if provided
        if config_str:
            # Parse the configuration string
            try:
                parts = config_str.split(',')
                for part in parts:
                    key, value = part.split('=', 1)
                    key = key.strip()
                    value = eval(value.strip())  # Safely evaluate the value
                    self.user_config[key] = value
            except Exception as e:
                print(f"Error parsing configuration string: {e}")
                print("Format should be: 'PARAM1 = value1, PARAM2 = value2'")
        
        # Process keyword arguments if provided
        if kwargs:
            self.user_config.update(kwargs)
        
        # Update the session configuration
        self.session.update_config(**self.user_config)
        
        return self.user_config

    def get_product_by_asin(self, asin: str) -> Optional[Dict]:
        """
        Fetch product details directly from an ASIN without needing a full URL.

        Args:
            asin (str): Amazon Standard Identification Number (10-char alphanumeric)

        Returns:
            Dict: Extracted product details, or None on failure
        """
        url = f"https://www.amazon.{self.country_code}/dp/{asin}"
        return self.get_product_details(url)

    def search_by_asins(self, asins: List[str], parse_retries: int = 2) -> List[Dict]:
        """
        Fetch product details for a list of ASINs.

        Args:
            asins (List[str]): List of ASIN strings
            parse_retries (int): How many times to retry an ASIN when parsing fails

        Returns:
            List[Dict]: Product data for successfully scraped ASINs (nulls excluded)
        """
        results = []
        failed = []
        total = len(asins)
        for i, asin in enumerate(asins, 1):
            print(f"\n[{i}/{total}] Fetching ASIN: {asin}")
            data = None
            for attempt in range(1, parse_retries + 1):
                data = self.get_product_by_asin(asin)
                if data:
                    break
                if attempt < parse_retries:
                    print(f"  Parse failed — retrying with next proxy (attempt {attempt + 1}/{parse_retries})")

            if data:
                results.append(data)
            else:
                failed.append(asin)
                print(f"  Permanently failed: {asin}")

        print(f"\nCompleted ASIN batch: {len(results)}/{total} successful")
        if failed:
            print(f"Failed ASINs ({len(failed)}): {', '.join(failed)}")
        return results

    def _fetch_aod_price(self, asin: str, product_url: str):
        """
        Fetch the first available offer price from Amazon's AOD (All Offers Display)
        Ajax endpoint. Used for products whose buy box shows 'See All Buying Options'
        instead of a direct Add-to-Cart price.

        This avoids Playwright entirely — curl_cffi already has the session cookies
        from the product page fetch, which is more reliable than headless Chrome.

        Returns (price_float, currency_symbol, delivery_date) or (None, None, None).
        """
        import time as _time
        import random as _random

        aod_url = (
            f"https://www.amazon.{self.country_code}/gp/aod/ajax"
            f"?asin={asin}&pc=dp"
            f"&isonlyrenderofferlist=false&new=1&used=0"
            f"&collectible=0&refurbished=0&sort=FEATURED"
        )
        print(f"  [aod] Fetching AOD endpoint for ASIN: {asin}")
        try:
            _time.sleep(_random.uniform(1.5, 3.0))
            proxy = self.session._next_proxy()
            resp = self.session.session.get(
                aod_url,
                headers={
                    "Referer": product_url,
                    "X-Requested-With": "XMLHttpRequest",
                    "Accept": "text/html, */*; q=0.01",
                },
                proxies=proxy,
                timeout=15,
            )
            if not resp or resp.status_code != 200:
                print(f"  [aod] Failed: HTTP {getattr(resp, 'status_code', 'None')}")
                return None, None, None
            return parse_aod_html(resp.text)
        except Exception as e:
            print(f"  [aod] Error: {e}")
            return None, None, None

    def get_product_details(self, url: str) -> Optional[Dict]:
        """
        Fetch and parse details for a product using its Amazon URL.
        
        This method:
        1. Parses the product URL to extract the ASIN
        2. Constructs a canonical product URL
        3. Fetches the product page HTML
        4. Parses the HTML to extract structured data
        
        Args:
            url (str): Amazon product URL (any format with a valid ASIN)
            
        Returns:
            Dict: Extracted product details (title, price, etc.)
            None: If URL is invalid or scraping fails
        """
        # Parse the URL to extract base_url and product_id (ASIN)
        parsed_info = parse_amazon_url(url)
        if not parsed_info:
            print(f"Invalid Amazon product URL: {url}")
            return None

        base_url, product_id = parsed_info
        product_url = f"{base_url}dp/{product_id}"  # Construct canonical URL
        print(f"Fetching product data for ASIN: {product_id}")

        # Fetch the product page using the session
        response = self.session.get(product_url)
        if not response or not response.text:
            print(f"Failed to fetch product page for: {product_url}")
            return None
        
        # Parse the product page HTML, passing country code for URL formatting
        product_data = parse_product_page(
            html_content=response.text,
            url=product_url,
            country_code=self.country_code
        )

        # Always save debug HTML when debug_html_dir is set so we can inspect
        # the raw page structure (useful for diagnosing wrong prices too).
        if self.debug_html_dir and product_data:
            import os as _os
            debug_path = _os.path.join(self.debug_html_dir, f"{product_id}.html")
            with open(debug_path, "w", encoding="utf-8") as _f:
                _f.write(response.text)
            price_note = f"price={product_data.get('price')}" if product_data.get('price') is not None else "price=None"
            print(f"  [debug] HTML saved to {debug_path} ({price_note})")

        if not product_data:
            print(f"Failed to extract product data from: {product_url}")
            return None

        # If all key fields are null the page parsed but wasn't a real product page
        if not product_data.get('title') and not product_data.get('price'):
            print(f"Silent parse failure (all fields null) for: {product_url}")
            return None

        # ── AOD direct fetch (for "See All Buying Options" products) ─────────
        # When the buy box has no direct offer, fetch Amazon's AOD Ajax endpoint
        # directly with curl_cffi (which already holds the session cookies from the
        # product page request). This is faster and more reliable than Playwright.
        if product_data.get("price") is None and product_data.get("_see_all_buying"):
            asin_for_aod = product_data.get("asin") or product_id
            aod_price, aod_currency, aod_delivery = self._fetch_aod_price(
                asin_for_aod, product_url)
            if aod_price is not None:
                product_data["price"] = aod_price
                if aod_currency and not product_data.get("currency"):
                    product_data["currency"] = aod_currency
                if aod_delivery and not product_data.get("delivery_date"):
                    product_data["delivery_date"] = aod_delivery
                print(f"  [aod] Price from AOD: "
                      f"{product_data.get('currency','')}{product_data['price']}")

        # ── Used buybox: primary offer is used — navigate offer listing page via Playwright ──
        # Clear price and delivery so Playwright runs and extracts both from the same
        # source (the offer listing page), ensuring price and delivery are consistent.
        if product_data.get("_used_buybox") and not product_data.get("out_of_stock"):
            print(f"  [scraper] Used buybox — clearing for Playwright offer listing (price+delivery from same source)")
            product_data["price"] = None
            product_data["delivery_date"] = None

        # ── Playwright fallback (free) ─────────────────────────────────────────
        # If the static HTML had no price, render the page with headless Chrome
        # so JavaScript executes. Share the curl_cffi session cookies so the
        # browser starts with the same authenticated, location-aware state —
        # this prevents Amazon from showing "cannot be dispatched" for the wrong
        # country instead of the correct buy box for the postcode we set earlier.
        # Skip for confirmed out-of-stock products — Playwright would find the same
        # "Currently unavailable" buy box and potentially hit carousel prices.
        if product_data.get("price") is None and not product_data.get("out_of_stock"):
            from amzpy.vision import extract_price_from_dom, render_and_get_html
            proxy = self.session._next_proxy()
            _session_cookies = dict(self.session.session.cookies)
            dom_price, dom_currency, dom_delivery = extract_price_from_dom(
                product_url, proxy_dict=proxy, postcode=self.postcode,
                session_cookies=_session_cookies)
            if dom_price is not None:
                product_data["price"] = dom_price
                if dom_currency and not product_data.get("currency"):
                    product_data["currency"] = dom_currency
                if dom_delivery and not product_data.get("delivery_date"):
                    product_data["delivery_date"] = dom_delivery
                print(f"  [playwright] Price from live DOM: "
                      f"{product_data.get('currency','')}{product_data['price']}")
            else:
                # DOM extraction got nothing — fall back to full HTML re-parse
                rendered_html = render_and_get_html(
                    product_url, proxy_dict=proxy, postcode=self.postcode,
                    session_cookies=_session_cookies)
                if rendered_html:
                    rendered_data = parse_product_page(
                        html_content=rendered_html,
                        url=product_url,
                        country_code=self.country_code,
                    )
                    if rendered_data and rendered_data.get("price") is not None:
                        product_data["price"] = rendered_data["price"]
                        if rendered_data.get("currency") and not product_data.get("currency"):
                            product_data["currency"] = rendered_data["currency"]
                        if rendered_data.get("img_url") and not product_data.get("img_url"):
                            product_data["img_url"] = rendered_data["img_url"]
                        if rendered_data.get("brand") and not product_data.get("brand"):
                            product_data["brand"] = rendered_data["brand"]
                        if rendered_data.get("rating") and not product_data.get("rating"):
                            product_data["rating"] = rendered_data["rating"]
                        if rendered_data.get("delivery_date") and not product_data.get("delivery_date"):
                            product_data["delivery_date"] = rendered_data["delivery_date"]
                        print(f"  [playwright] Price found in rendered HTML: "
                              f"{product_data.get('currency','')}{product_data['price']}")

        # ── Safety check: price found but no delivery date → out of stock ────────
        # A genuinely in-stock Amazon product with an Add-to-Cart buy box always has
        # an estimated delivery date. If we extracted a price but got no delivery date
        # (e.g. from a carousel item or a half-rendered page), treat it as out of stock.
        if (product_data.get("price") is not None and
                not product_data.get("delivery_date") and
                not product_data.get("out_of_stock")):
            avail_text = (product_data.get("availability_text") or "").lower()
            if "in stock" in avail_text or "same-day" in avail_text or "same day" in avail_text:
                print(f"  [scraper] Price found, no delivery date but availability={avail_text!r} — keeping price (AmazonFresh/same-day)")
            else:
                print("  [scraper] Price found but no delivery date — marking as out of stock")
                product_data["price"] = None
                product_data["out_of_stock"] = True

        # ── Claude Vision fallback (paid, requires ANTHROPIC_API_KEY) ──────────
        # Only runs if Playwright HTML re-parsing also found no price.
        if product_data.get("price") is None and self.use_vision_fallback and not product_data.get("out_of_stock"):
            from amzpy.vision import extract_price_via_vision
            proxy = self.session._next_proxy()
            v_price, v_currency = extract_price_via_vision(
                url=product_url,
                proxy_dict=proxy,
                api_key=self.vision_api_key,
            )
            if v_price is not None:
                product_data["price"] = v_price
                if v_currency and not product_data.get("currency"):
                    product_data["currency"] = v_currency
                print(f"  [vision] Price found via Claude Vision: {v_currency or ''}{v_price}")

        # Remove internal flags before returning to callers
        product_data.pop("_see_all_buying", None)
        product_data.pop("_used_buybox", None)

        print(f"Successfully extracted data for: {(product_data.get('title') or 'Unknown Product')[:50]}...")
        return product_data

    def search_products(self, query: str = None, search_url: str = None, max_pages: int = 1) -> List[Dict]:
        """
        Search for products on Amazon and extract product listings.
        
        This method supports two search approaches:
        1. Using a search query (e.g., "wireless headphones")
        2. Using a pre-constructed search URL (e.g., category pages, filtered searches)
        
        It will automatically paginate through results up to max_pages.
        
        Args:
            query (str, optional): Search query text (ignored if search_url is provided)
            search_url (str, optional): Pre-constructed search URL (takes precedence over query)
            max_pages (int): Maximum number of pages to scrape (default: 1)
            
        Returns:
            List[Dict]: List of product data dictionaries from search results
            Empty list: If search fails or no products are found
        """
        # Validate that we have either a query or a search URL
        if not query and not search_url:
            print("Error: Either a search query or search URL must be provided")
            return []
            
        # Construct search URL if only query was provided
        if not search_url and query:
            search_url = f"https://www.amazon.{self.country_code}/s?k={query.replace(' ', '+')}"
            
        print(f"Starting product search: {search_url}")
        
        all_products = []  # Collect products from all pages
        current_url = search_url
        current_page = 1
        
        # Paginate through search results
        while current_url and current_page <= max_pages:
            print(f"\nScraping search page {current_page}/{max_pages}: {current_url}")
            
            # Fetch the search page
            response = self.session.get(current_url)
            if not response or not response.text:
                print(f"Failed to fetch search page: {current_url}")
                break
                
            # Parse products from the current page, passing country code for URL formatting
            base_url = f"https://www.amazon.{self.country_code}"
            products = parse_search_page(
                response.text, 
                base_url,
                country_code=self.country_code
            )
            
            # Check if we got valid results
            if not products:
                print(f"No products found on page {current_page} (or page was blocked)")
                break
                
            print(f"Found {len(products)} products on page {current_page}")
            all_products.extend(products)
            
            # Stop if we've reached the requested number of pages
            if current_page >= max_pages:
                break
                
            # Get URL for the next page
            next_url = parse_pagination_url(response.text, base_url)
            if not next_url:
                print("No next page found. End of results.")
                break
                
            current_url = next_url
            current_page += 1
            
        print(f"\nSearch completed. Total products found: {len(all_products)}")
        return all_products
