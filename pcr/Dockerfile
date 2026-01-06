FROM docker.io/cloudflare/sandbox:0.6.7

# Pre-install playwright-core to speed up first execution
WORKDIR /workspace
RUN npm init -y && npm install playwright-core

# Expose port for local development with wrangler dev
EXPOSE 8080
