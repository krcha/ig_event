FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    INSTALOADER_STATE_DIR=/var/lib/eventzeka-instaloader \
    INSTALOADER_SESSION_FILE=/run/instaloader-session/session \
    INSTALOADER_PORT=8080

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 collector \
    && useradd --uid 10001 --gid collector --no-create-home collector \
    && mkdir -p /var/lib/eventzeka-instaloader /run/instaloader-session \
    && chown collector:collector /var/lib/eventzeka-instaloader
COPY collector.py ./
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).read()"
CMD ["python", "collector.py"]
