# Öffentlicher Standalone-Demo-Container (z. B. Google Cloud Run).
# CAP läuft im Development-Profil = mocked auth (2 User: mitarbeiter/meister)
# + SQLite in-memory mit CSV-Seed. Kein HANA, kein XSUAA, kein App-Router.
# DEMO_PUBLIC schaltet: Copilot fix API (Sonnet) + IP-Rate-Limit + Rollen-Umschalter.
FROM node:22-slim
WORKDIR /app

# Nur Produktions-Deps (inkl. @cap-js/sqlite); Agent-SDK/zod/cds-dk bleiben draußen -> schlankes Image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App-Code (siehe .dockerignore: node_modules, .env, app/router, mta-Artefakte etc. bleiben draußen)
COPY . .

# Development-Profil -> mocked auth + SQLite; Demo-Schalter an.
ENV NODE_ENV=development
ENV CDS_ENV=development
ENV DEMO_PUBLIC=true
# ANTHROPIC_API_KEY wird NICHT hier gesetzt (Secret) -> beim Deploy als Env/Secret injizieren.
# Empfehlung zusätzlich: LLM_MODEL_API=claude-sonnet-5 (ist bereits Default).

# Härtung: App braucht kein root (Port 8080 unprivilegiert, DB in-memory, keine Schreibzugriffe)
USER node

# Cloud Run gibt PORT vor (Default 8080); CAP nutzt process.env.PORT automatisch.
EXPOSE 8080
CMD ["npm", "start"]
