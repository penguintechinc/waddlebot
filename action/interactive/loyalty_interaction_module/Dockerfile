FROM python:3.13-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Create non-root user
RUN useradd -m -u 1000 waddlebot && chown -R waddlebot:waddlebot /app
USER waddlebot

EXPOSE 8032

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8032/health')"

CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8032"]
