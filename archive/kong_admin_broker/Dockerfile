FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /var/log/waddlebotlog
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8100", "--workers", "4"]
