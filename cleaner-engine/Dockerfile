FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml /app/
COPY app.py /app/
COPY config.py /app/
COPY ai /app/ai
COPY providers /app/providers
COPY cleanup /app/cleanup
COPY backup /app/backup

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
