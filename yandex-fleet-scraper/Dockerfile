FROM node:22-bullseye

# Install Playwright dependencies (using bullseye image makes this easier)
# Alternatively, we could base it on mcr.microsoft.com/playwright:v1.48.1-focal
# Let's use the official Playwright image to guarantee browser dependencies are present.
FROM mcr.microsoft.com/playwright:v1.48.1-jammy

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source code
COPY . .

# Set environment to production
ENV NODE_ENV=production
ENV PLAYWRIGHT_HEADLESS=true

# Expose API port
EXPOSE 3003

# We will use docker-compose to run either the API or the WORKER using this same image
# Default command (can be overridden in docker-compose.yml)
CMD ["npm", "run", "start:api"]
