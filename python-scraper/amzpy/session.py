"""
Amazon Session Manager Module
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

This module provides a robust session management system for Amazon scraping.
It handles:
- Browser impersonation with curl_cffi
- Request retries with intelligent backoff
- CAPTCHA/block detection and avoidance
- User-agent rotation with fake_useragent
- Proxy support
"""

import random
import time
from typing import Dict, Optional, Tuple, Any, Union

import curl_cffi.requests
from curl_cffi.requests.errors import RequestsError
from fake_useragent import UserAgent

# Default configuration (can be overridden by user)
DEFAULT_CONFIG = {
    'MAX_RETRIES': 3,
    # asyncio.wait_for in api.py is 45s safety net.
    # 3 inner attempts × 12s = 36s < 45s — asyncio never fires, no spurious 503s.
    'REQUEST_TIMEOUT': 12,
    'DELAY_BETWEEN_REQUESTS': (0, 0.0),   # rotating ISP proxy = fresh IP per request, zero delay
    'DEFAULT_IMPERSONATE': 'chrome120'  # part of curl_cffi's impersonation
}

# Default header template
DEFAULT_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',  # ensures compressed responses (~80KB vs ~400KB)
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
}


class AmzSession:
    """
    Enhanced session manager using curl_cffi for Amazon requests.

    This class implements sophisticated request handling including:
    - Browser fingerprint spoofing (via curl_cffi impersonation)
    - Randomized user agents (via fake_useragent)
    - CAPTCHA/anti-bot detection and avoidance
    - Intelligent retry logic with exponential backoff
    - Proxy rotation support for IP cycling

    Attributes:
        country_code (str): Amazon domain country code (e.g., "com", "in", "co.uk")
        base_url (str): Constructed base URL for the Amazon domain
        session (curl_cffi.requests.Session): The curl_cffi session instance
        config (dict): Configuration parameters for request behavior
        ua_generator (UserAgent): User agent generator for browser fingerprinting
        proxies_list (list): List of proxy dicts for rotation
        proxy_index (int): Current proxy index in the rotation
    """

    def __init__(self, country_code: str = "com",
                 impersonate: str = None,
                 proxies: Optional[Union[Dict, list]] = None,
                 config: Optional[Dict] = None):
        """
        Initialize the Amazon session manager.

        Args:
            country_code (str): Amazon domain country code (e.g. "com", "co.uk")
            impersonate (str, optional): Browser to impersonate (e.g. "chrome119")
            proxies: Single proxy dict OR list of proxy dicts for rotation
            config (Dict, optional): Override default configuration parameters
        """
        # Initialize country and base URL
        self.country_code = country_code
        self.base_url = f"https://www.amazon.{self.country_code}/"

        # Set up configuration (with user overrides if provided)
        self.config = DEFAULT_CONFIG.copy()
        if config:
            self.config.update(config)

        # Initialize fake_useragent restricted to Chrome to match impersonation
        self.ua_generator = UserAgent(browsers=['Chrome'], os=['Windows', 'MacOS'])

        # Create curl_cffi session
        self.session = curl_cffi.requests.Session()

        # Set up headers with randomized user agent
        headers = DEFAULT_HEADERS.copy()
        headers['User-Agent'] = self.ua_generator.random
        self.session.headers = headers

        # Set browser impersonation if provided, otherwise use default
        self.session.impersonate = impersonate or self.config['DEFAULT_IMPERSONATE']

        # Build proxy rotation list
        if isinstance(proxies, list):
            self.proxies_list = proxies
        elif isinstance(proxies, dict):
            self.proxies_list = [proxies]
        else:
            self.proxies_list = []
        self.proxy_index = 0

        # Get cookies from Amazon homepage (headers arrive quickly; body can be huge).
        # stream=True lets us close the connection after headers without downloading the body.
        init_proxy = self.proxies_list[0] if self.proxies_list else None
        try:
            resp = self.session.get(
                self.base_url,
                headers=headers,
                proxies=init_proxy,
                timeout=5,
                stream=True,
            )
            try:
                resp.close()
            except Exception:
                pass
        except Exception as e:
            print(f"AmzSession init request failed (continuing without cookies): {e}")

        print(f"AmzSession initialized for amazon.{country_code}")
        print(f"Impersonating: {self.session.impersonate}")
        print(f"User-Agent: {headers['User-Agent'][:50]}...")
        print("Fetched cookies:", self.session.cookies.get_dict())
        if self.proxies_list:
            print(f"Proxy rotation enabled: {len(self.proxies_list)} proxies loaded")

    def _next_proxy(self) -> Optional[Dict]:
        """Return the next proxy in the rotation list, cycling round-robin."""
        if not self.proxies_list:
            return None
        proxy = self.proxies_list[self.proxy_index % len(self.proxies_list)]
        self.proxy_index += 1
        return proxy

    def get(self, url: str, headers: Optional[Dict] = None) -> Optional[curl_cffi.requests.Response]:
        """
        Perform a GET request using the curl_cffi session with smart retries and proxy rotation.

        Args:
            url (str): URL to fetch (absolute or relative to base_url)
            headers (Dict, optional): Additional headers to merge with defaults

        Returns:
            Optional[curl_cffi.requests.Response]: Response object or None if all retries failed
        """
        # Normalize URL (handle both absolute and relative URLs)
        if not url.startswith("http"):
            if url.startswith("/"):
                url = f"{self.base_url.rstrip('/')}{url}"
            else:
                url = f"{self.base_url}{url}"

        # Merge headers with fresh random user agent for each request
        merged_headers = self.session.headers.copy()
        merged_headers['User-Agent'] = self.ua_generator.random
        if headers:
            merged_headers.update(headers)

        # Extract configuration for use in the retry loop
        max_retries = self.config['MAX_RETRIES']
        timeout = self.config['REQUEST_TIMEOUT']
        delay_range = self.config['DELAY_BETWEEN_REQUESTS']

        # Retry loop with exponential backoff and proxy rotation
        for attempt in range(max_retries + 1):
            current_proxy = self._next_proxy()
            try:
                # Calculate delay with some randomization (increases with each attempt)
                delay_factor = 1 + (attempt * 0.5)
                min_delay, max_delay = delay_range
                delay = random.uniform(min_delay * delay_factor, max_delay * delay_factor)

                proxy_info = list(current_proxy.values())[0] if current_proxy else "none"
                print(f"Request attempt {attempt+1}/{max_retries+1}: GET {url} (delay: {delay:.2f}s, proxy: {proxy_info})")
                time.sleep(delay)

                # Make the actual request using curl_cffi
                response = self.session.get(
                    url,
                    headers=merged_headers,
                    timeout=timeout,
                    allow_redirects=True,
                    proxies=current_proxy
                )

                # Handle HTTP error codes
                if response.status_code == 404:
                    print(f"Product not found (404): {url}")
                    return None

                if response.status_code != 200:
                    print(f"Non-200 status code: {response.status_code}")
                    if 500 <= response.status_code < 600 and attempt < max_retries:
                        print(f"Server error {response.status_code}, retrying with next proxy...")
                        continue
                    print(f"Warning: Received HTTP {response.status_code} for {url}")

                # Check for CAPTCHA/blocking patterns in the content (200 responses only)
                _text_lower = response.text.lower()
                _block_signals = [
                    "captcha", "api-services-support@amazon.com",
                    "robot check", "sorry, we just need to make sure",
                    "enter the characters you see below",
                    "verify you are a human", "human verification",
                ]
                if any(s in _text_lower for s in _block_signals):
                    print("CAPTCHA or anti-bot measure detected in response")
                    if attempt < max_retries:
                        captcha_delay = delay * 3
                        print(f"Rotating proxy and waiting {captcha_delay:.2f}s before retry")
                        time.sleep(captcha_delay)
                        continue
                    print("Failed to bypass anti-bot measures after all retries")

                print(f"Request successful: {url} (Status: {response.status_code})")
                return response

            except RequestsError as e:
                print(f"Network error on attempt {attempt+1}: {e}")
                if attempt == max_retries:
                    print(f"Max retries reached. Network error: {e}")
                    return None
                time.sleep(delay * 2)

            except Exception as e:
                print(f"Unexpected error on attempt {attempt+1}: {e}")
                if attempt == max_retries:
                    print(f"Max retries reached. Error: {e}")
                    return None
                time.sleep(delay * 2)

        return None
        
    def set_delivery_postcode(self, postcode: str) -> bool:
        """
        Set the delivery postcode for location-specific pricing.

        Amazon UK shows different prices and availability depending on the delivery
        address. This calls the same internal API that the browser uses when you
        click "Deliver to" and type a postcode, updating the session cookies so all
        subsequent product requests reflect pricing for that location.

        Args:
            postcode: UK postcode, e.g. "M1 1AE" or "M11AE"

        Returns:
            True if the postcode was accepted, False on failure.
        """
        clean = postcode.replace(" ", "").upper()
        # The anti-CSRF token is set as a cookie during the homepage request in __init__
        csrf = self.session.cookies.get("anti-csrftoken-a2z", "")
        url = f"https://www.amazon.{self.country_code}/portal-migration/hz/glow/address-change"
        proxy = self.proxies_list[0] if self.proxies_list else None
        try:
            resp = self.session.post(
                url,
                data={
                    "actionSource": "glow",
                    "locationType": "LOCATION_INPUT",
                    "zipCode": clean,
                    "deviceType": "web",
                    "pageType": "Detail",
                    "storeContext": "NoStoreName",
                    "encryptedAddressToken": "",
                },
                headers={
                    "anti-csrftoken-a2z": csrf,
                    "x-requested-with": "XMLHttpRequest",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "text/html,*/*",
                    "Referer": self.base_url,
                },
                proxies=proxy,
                timeout=5,  # shorter than REQUEST_TIMEOUT; init must fit in asyncio window
            )
            if resp and resp.status_code == 200:
                print(f"Delivery postcode set to: {postcode}")
                return True
            print(f"Failed to set postcode — status {resp.status_code if resp else 'None'}")
            return False
        except Exception as e:
            print(f"Error setting delivery postcode: {e}")
            return False

    def update_config(self, **kwargs):
        """
        Update session configuration parameters.

        Args:
            **kwargs: Configuration key-value pairs to update
        """
        self.config.update(kwargs)
        print(f"Updated session configuration: {kwargs}") 