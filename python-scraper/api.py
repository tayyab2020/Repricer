"""
FastAPI wrapper around amzpy AmazonScraper.
Exposes POST /scrape, GET /health, and GET /logs for the Node.js repricer to call.
"""

import collections
import hashlib
import logging
import os
import asyncio
import time
import threading
from datetime import date as _date
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from amzpy import AmazonScraper

# ── In-memory log ring buffer (last 300 entries) ─────────────────────────────
_log_buffer: collections.deque = collections.deque(maxlen=300)

class _BufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            _log_buffer.append({
                "ts": record.created * 1000,  # milliseconds for JS Date
                "level": record.levelname.lower(),
                "message": self.format(record),
            })
        except Exception:
            pass

_buf_handler = _BufferHandler()
_buf_handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))

# Capture our own logger + amzpy's logger
for _log_name in ("python-scraper", "amzpy", "amzpy.scraper", "amzpy.amazon"):
    _l = logging.getLogger(_log_name)
    _l.addHandler(_buf_handler)
    _l.setLevel(logging.DEBUG)

logger = logging.getLogger("python-scraper")


def _parse_proxy(raw: str) -> dict:
    parts = raw.strip().split(":")
    if len(parts) != 4:
        raise ValueError(f"Invalid proxy format (expected ip:port:user:pass): {raw!r}")
    ip, port, user, pw = parts
    url = f"http://{user}:{pw}@{ip}:{port}"
    return {"http": url, "https": url}


_delay_min: float = 0.0
_delay_max: float = 0.3
_default_proxies_raw: str = ""

# Thread-local storage for per-thread scraper instances.
# Each ThreadPoolExecutor thread gets its own AmazonScraper with its own
# curl_cffi Session — eliminates the thread-safety issues from sharing one session.
_thread_local = threading.local()

# Cooldown: tracks (error_message, retry_after_epoch) for proxy configs that failed init
_scraper_failures: dict[str, tuple[str, float]] = {}
_PROXY_RETRY_COOLDOWN = 30   # seconds — short cooldown for transient DNS/connection errors
executor: ThreadPoolExecutor = None

# Per-proxy concurrency semaphores: (ip_count, Semaphore) keyed by proxy md5.
# Limits concurrent scrapes per proxy config to the account's IP pool size,
# preventing more simultaneous Amazon requests than there are IPs available.
_proxy_semaphores: dict[str, tuple[int, asyncio.Semaphore]] = {}

# Cancellation flag — set by POST /cancel; blocks new /scrape requests until expired.
# In-flight scrapes already running in threads complete naturally but new ones are rejected.
_cancel_until: float = 0.0


def _make_scraper(proxies_raw: str = "") -> AmazonScraper:
    proxies = [_parse_proxy(p) for p in proxies_raw.split(",") if p.strip()]
    s = AmazonScraper(
        country_code="uk",
        impersonate="chrome120",
        proxies=proxies or None,
        postcode=os.getenv("DELIVERY_POSTCODE", "M1 1AE"),
        vision_api_key=os.getenv("ANTHROPIC_API_KEY") or None,
        use_vision_fallback=bool(os.getenv("ANTHROPIC_API_KEY")),
    )
    s.config(DELAY_BETWEEN_REQUESTS=(_delay_min, _delay_max), MAX_RETRIES=2)
    return s


def _get_scraper(proxies_raw: Optional[str]) -> AmazonScraper:
    """Return a per-thread scraper for the given proxy config.

    Each ThreadPoolExecutor thread gets its own AmazonScraper instance stored in
    thread-local storage. This eliminates curl_cffi Session contention when many
    threads call session.get() concurrently on the same shared object.

    If a proxy config previously failed to initialise, raises immediately
    (without retrying) for _PROXY_RETRY_COOLDOWN seconds.
    """
    key = hashlib.md5((proxies_raw or "").encode()).hexdigest()

    # Fast-fail if this proxy config is in cooldown
    if key in _scraper_failures:
        err_msg, retry_after = _scraper_failures[key]
        remaining = retry_after - time.time()
        if remaining > 0:
            raise ConnectionError(
                f"Proxy config failed earlier ({err_msg}); "
                f"retrying in {int(remaining)}s"
            )
        else:
            del _scraper_failures[key]

    if not hasattr(_thread_local, "scrapers"):
        _thread_local.scrapers = {}

    if key not in _thread_local.scrapers:
        try:
            _thread_local.scrapers[key] = _make_scraper(proxies_raw or _default_proxies_raw)
        except Exception as e:
            _scraper_failures[key] = (str(e)[:120], time.time() + _PROXY_RETRY_COOLDOWN)
            logger.error(
                f"Scraper init failed for proxy config on thread {threading.get_ident()} "
                f"(will not retry for {_PROXY_RETRY_COOLDOWN}s): {e}"
            )
            raise

    return _thread_local.scrapers[key]


def _scrape_in_thread(asin: str, proxies_raw: Optional[str]) -> Optional[dict]:
    """Runs inside a ThreadPoolExecutor thread.
    _get_scraper uses thread-local storage so each thread gets its own
    AmazonScraper with its own curl_cffi Session — nothing shared across threads."""
    scraper = _get_scraper(proxies_raw)
    return scraper.get_product_by_asin(asin)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global executor, _delay_min, _delay_max, _default_proxies_raw

    workers = int(os.getenv("SCRAPER_WORKERS", "3"))
    executor = ThreadPoolExecutor(max_workers=workers)

    _delay_min = float(os.getenv("DELAY_MIN", "0"))
    _delay_max = float(os.getenv("DELAY_MAX", "0.3"))
    _default_proxies_raw = os.getenv("PROXIES", "")

    loop = asyncio.get_event_loop()

    # Pre-initialize one AmazonScraper per executor thread. Each init makes 2 HTTP
    # requests (base URL + postcode) which can total up to 40s if the proxy is slow.
    # Without pre-warming, the first scrape on each thread triggers init inside the
    # asyncio.wait_for(25s) window → timeout before the actual scrape runs.
    # Pre-warming runs all inits in parallel so startup takes max(init_time) not sum.
    if _default_proxies_raw:
        print(f"Pre-warming {workers} scraper threads (running init requests in parallel)…")
        init_futures = [
            loop.run_in_executor(executor, _get_scraper, _default_proxies_raw)
            for _ in range(workers)
        ]
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*init_futures, return_exceptions=True),
                timeout=60,
            )
            ok = sum(1 for r in results if not isinstance(r, Exception))
            print(f"Pre-warm done: {ok}/{workers} threads ready")
        except asyncio.TimeoutError:
            print("Pre-warm timed out after 60s — some threads will init on first use")

    print(f"Python scraper ready — {workers} worker(s), delay ({_delay_min}–{_delay_max}s)")

    yield

    executor.shutdown(wait=False)


app = FastAPI(lifespan=lifespan)


class ScrapeRequest(BaseModel):
    asin: str
    proxies: Optional[str] = None   # comma-separated ip:port:user:pass
    ip_count: Optional[int] = None  # max concurrent scrapes for this proxy config


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/cancel")
async def cancel_scraping():
    """Block new /scrape requests for 60 s. In-flight thread scrapes finish naturally."""
    global _cancel_until
    _cancel_until = time.time() + 60
    logger.info("Scraping cancelled — rejecting new requests for 60s")
    return {"ok": True}


class SetWorkersRequest(BaseModel):
    workers: int


_current_workers: int = 0


@app.post("/set-workers")
async def set_workers(req: SetWorkersRequest):
    """Resize the ThreadPoolExecutor. Called by repricerJob at startup after computing
    FAST_CONCURRENCY from Python-enabled accounts' IP counts. In-flight scrapes on
    the old executor finish naturally (shutdown wait=False).

    If the requested size matches the current size, the existing executor is reused
    so thread-local scrapers remain warm across back-to-back repricing jobs."""
    global executor, _current_workers
    if req.workers < 1:
        raise HTTPException(status_code=400, detail="workers must be >= 1")
    if req.workers == _current_workers:
        logger.info(f"ThreadPoolExecutor already at {req.workers} workers — reusing warm threads")
        return {"workers": req.workers}
    new_executor = ThreadPoolExecutor(max_workers=req.workers)
    old_executor, executor = executor, new_executor
    _current_workers = req.workers
    if old_executor:
        old_executor.shutdown(wait=False)
    logger.info(f"ThreadPoolExecutor resized to {req.workers} workers")
    return {"workers": req.workers}


class ResetRequest(BaseModel):
    proxies: Optional[str] = None


@app.post("/reset-scraper")
async def reset_scraper(req: ResetRequest):
    """Evict cached scraper + failure entry for a proxy config so the next request retries immediately."""
    key = hashlib.md5((req.proxies or "").encode()).hexdigest()
    evicted = []
    if key in _scraper_failures:
        del _scraper_failures[key]
        evicted.append("failure")
    # Per-thread scrapers live in threading.local() — we can't evict them directly,
    # but clearing the failure entry lets threads re-init on their next request.
    logger.info(f"reset-scraper: evicted {evicted or ['nothing']} for proxy config key={key[:8]}…")
    return {"evicted": evicted}


@app.get("/logs")
async def get_logs(since: float = 0):
    """Return buffered log entries newer than `since` (epoch ms)."""
    return [e for e in _log_buffer if e["ts"] > since]


@app.post("/scrape")
async def scrape(req: ScrapeRequest):
    if time.time() < _cancel_until:
        remaining = round(_cancel_until - time.time())
        logger.info(f"Scrape rejected — cancelled (clears in {remaining}s): {req.asin}")
        raise HTTPException(status_code=503, detail="Scraping cancelled by user")

    proxy_label = "proxies" if req.proxies else "no proxies"
    logger.info(f"Scrape requested — ASIN={req.asin} ({proxy_label})")

    # Enforce per-proxy concurrency limit when ip_count is provided.
    # Prevents more simultaneous requests than available IPs in the pool.
    sem = None
    if req.ip_count and req.ip_count > 0:
        proxy_key = hashlib.md5((req.proxies or "").encode()).hexdigest()
        entry = _proxy_semaphores.get(proxy_key)
        if entry is None or entry[0] != req.ip_count:
            _proxy_semaphores[proxy_key] = (req.ip_count, asyncio.Semaphore(req.ip_count))
        sem = _proxy_semaphores[proxy_key][1]

    _sem_acquired = False
    if sem:
        await sem.acquire()
        _sem_acquired = True

    try:
        logger.info(f"Calling get_product_by_asin({req.asin})…")
        start = time.time()
        loop = asyncio.get_event_loop()

        # Retry up to 3 times on anti-bot (None result).
        # We reuse the same scraper instance rather than reiniting — for Decodo rotating
        # proxies, each new request to the proxy endpoint gets a fresh IP automatically
        # without needing a new TCP connection at the scraper level. Reiniting was causing
        # cascading DNS failures that blocked the entire proxy config for minutes.
        result = None
        for attempt in range(1, 4):
            try:
                # asyncio.wait_for frees this coroutine's slot after 25s even if the
                # underlying thread is stuck on a hung proxy TCP connection. The thread
                # itself continues until curl_cffi's REQUEST_TIMEOUT fires (20s), but at
                # least new requests are no longer blocked behind it.
                result = await asyncio.wait_for(
                    loop.run_in_executor(executor, _scrape_in_thread, req.asin, req.proxies),
                    timeout=45,
                )
            except asyncio.TimeoutError:
                elapsed = round(time.time() - start, 1)
                logger.warning(f"Thread timeout for {req.asin} after {elapsed}s — proxy connection hung")
                raise HTTPException(status_code=503, detail="scrape timeout — proxy connection hung")
            except Exception as e:
                elapsed = round(time.time() - start, 1)
                logger.error(f"Scrape exception for {req.asin} after {elapsed}s: {e}")
                raise HTTPException(status_code=500, detail=str(e))

            if result is not None:
                break

            if attempt < 3:
                logger.warning(f"Anti-bot for {req.asin} (attempt {attempt}/3) — retrying")

    finally:
        if _sem_acquired:
            sem.release()

    elapsed = round(time.time() - start, 1)

    if result is None:
        logger.warning(f"No result for {req.asin} after {elapsed}s — all retries exhausted")
        return {
            "asin": req.asin,
            "price": None,
            "inStock": False,
            "error": "scrape failed — all methods exhausted",
        }

    price = result.get("price")
    out_of_stock_flag = result.get("out_of_stock", False)
    delivery_date = result.get("delivery_date")
    in_stock = not out_of_stock_flag

    # If no delivery date, check availability_text for same-day / AmazonFresh signals.
    # Covers two cases:
    #   1. out_of_stock=True (safety check fired despite same-day) → also set in_stock=True
    #   2. out_of_stock=False (safety check skipped) → just set the delivery date to today
    if price and not delivery_date:
        availability_text = (result.get("availability_text") or "").lower()
        if any(kw in availability_text for kw in ("same-day", "same day")):
            if not in_stock:
                in_stock = True
                logger.info(f"In-stock override for {req.asin} (same-day availability)")
            delivery_date = _date.today().strftime("%A, %-d %B")
            logger.info(f"Same-day delivery date set for {req.asin} — date={delivery_date}")

    if not price:
        availability = result.get("availability") or "?"
        logger.warning(
            f"No price for {req.asin} in {elapsed}s — "
            f"out_of_stock={out_of_stock_flag} availability={availability!r}"
        )
    else:
        logger.info(
            f"Success for {req.asin} in {elapsed}s — "
            f"price={price} in_stock={in_stock} "
            f"delivery={result.get('delivery_price')} date={delivery_date}"
        )

    return {
        "asin":           result.get("asin") or req.asin,
        "price":          price,
        "inStock":        in_stock,
        "currency":       result.get("currency", "£"),
        "title":          result.get("title"),
        "brand":          result.get("brand"),
        "delivery_date":  delivery_date,
        "delivery_price": result.get("delivery_price"),
    }
