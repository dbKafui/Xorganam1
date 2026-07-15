#!/bin/bash
set -e

# Kill any existing local dev servers
echo "Stopping any local dev servers..."
pkill -f "npm run dev" || true
pkill -f "npm start" || true

# Build and start containers
echo "Building Docker images and starting containers..."
docker-compose up --build

