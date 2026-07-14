# Cloud Run image for the Data Wizard whiteboard (sketch → table / dashboard).
# Bundles Node (the server + the viz-builder/databricks modules it imports) with Python +
# tableauserverclient (the Tableau publish step shells out to it) and zip (packages the .twbx).
FROM node:22-slim

# System deps for the Tableau publish pipeline.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv zip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python venv with tableauserverclient — TSC_PYTHON points the publisher at it.
COPY viz-builder/requirements.txt viz-builder/requirements.txt
RUN python3 -m venv /app/.venv && /app/.venv/bin/pip install --no-cache-dir -r viz-builder/requirements.txt

# Only the folders the whiteboard actually imports (see .dockerignore for exclusions).
COPY whiteboard       whiteboard
COPY viz-builder      viz-builder
COPY slack-data-agent slack-data-agent
COPY csv-to-db        csv-to-db
COPY pdf-extract      pdf-extract
COPY datagen          datagen

# Node deps for the server (express + @slack/web-api); the other modules are dependency-free.
RUN cd whiteboard && npm install --omit=dev --no-audit --no-fund

ENV TSC_PYTHON=/app/.venv/bin/python \
    WHITEBOARD_PUBLIC=1 \
    NODE_ENV=production

# Cloud Run injects PORT; server.js binds 0.0.0.0 when PORT/WHITEBOARD_PUBLIC is set.
CMD ["node", "whiteboard/server.js"]
