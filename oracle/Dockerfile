# syntax=docker/dockerfile:1.7
# ------------------------------------------------------------------
# Tabula Oracle — TabFM inference service.
#
# Build:
#   docker build -f oracle/Dockerfile -t tabula-oracle:latest .
#
# Run (mock backend, fast for CI):
#   docker run --rm -p 8787:8787 -e TABULA_ORACLE_MOCK=1 tabula-oracle:latest
#
# Run (real TabFM, CPU):
#   docker run --rm -p 8787:8787 tabula-oracle:latest
#
# Run (real TabFM, GPU):
#   docker run --rm --gpus=all -p 8787:8787 \
#     -e TABFM_DEVICE=cuda -v $HOME/.cache/huggingface:/root/.cache/huggingface \
#     tabula-oracle:latest
# ------------------------------------------------------------------
FROM python:3.11-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency metadata first for better layer caching.
COPY oracle/pyproject.toml /app/pyproject.toml
COPY oracle/README.md      /app/README.md
COPY oracle/tabula_oracle   /app/tabula_oracle

# Runtime deps only in the default image. Install TabFM as a build arg so
# CI can produce both slim (mock) and full (real) variants.
ARG INSTALL_TABFM=false
RUN pip install --upgrade pip setuptools wheel && \
    if [ "$INSTALL_TABFM" = "true" ]; then \
      pip install ".[tabfm]" ; \
    else \
      pip install . ; \
    fi

# Non-root user
RUN useradd -m -u 10001 tabula && chown -R tabula:tabula /app
USER tabula

EXPOSE 8787
ENV HOST=0.0.0.0 PORT=8787

HEALTHCHECK --interval=15s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request, sys; \
u=urllib.request.urlopen('http://127.0.0.1:8787/healthz', timeout=3); \
sys.exit(0 if u.status == 200 else 1)"

CMD ["tabula-oracle"]
