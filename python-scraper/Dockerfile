FROM --platform=linux/amd64 python:3.11-slim

# System deps for curl_cffi, lxml, and Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        gcc \
        libxml2-dev \
        libxslt-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright's Chromium and its OS dependencies
RUN playwright install chromium && playwright install-deps chromium

COPY . .

EXPOSE 8000

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
