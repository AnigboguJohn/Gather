# Gather AI service: speech-to-text, translation, summaries (Python / FastAPI).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
ENV GATHER_SKIP_DOTENV=1
EXPOSE 8001
# Hosts like Render pass the port to listen on in $PORT; Docker Compose uses 8001.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8001}"]
