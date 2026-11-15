#!/bin/sh
set -e
# Runs as root: make the bind-mounted volumes writable by the unprivileged app
# user, then exec supervisord (which runs redis and uvicorn as appuser, so an
# app compromise lands as a non-root user rather than root).
chown -R appuser:appuser /app/data /app/app/static/uploads 2>/dev/null || true
# Redis keeps sessions (and the service tokens in them) here: only appuser
# may read it. Created on first start, tightened on every start.
mkdir -p /app/data/redis
chown appuser:appuser /app/data/redis
chmod 700 /app/data/redis
exec "$@"
