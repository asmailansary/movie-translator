FROM python:3.12-slim

# ffmpeg لتقطيع الصوت، و deno يحتاجه yt-dlp عشان يقرأ يوتيوب
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

RUN useradd -m app && mkdir -p /app/data && chown -R app /app
USER app

ENV PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "server.py"]
